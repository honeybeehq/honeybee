import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore, replayAudit } from "../../core/src/index.ts";
import { startDaemon } from "./helpers.ts";
import type { BackupResult } from "../src/backupCapture.ts";
import { CELL_OPS_TABLE_SQL } from "../../core/src/schema.ts";
import { TelemetryStore } from "../src/telemetry.ts";
import { BackupError, captureAndSnapshot, remainingBackupScratch, retireBackupCheckpoint, validateBackupRequest, type BackupManifest, type BackupOwner, type BackupRecord } from "../src/backupCapture.ts";

const fixtureRoot = resolve(".audit/backup-b2/fixtures");
const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const request = { cellId: "cell", idempotencyKey: "once", repository: "rest:http://127.0.0.1:8000/fixture/", passwordRef: "global/fleet-backup-fixture-repo-key", writerRef: "global/fleet-backup-fixture-writer", maxScratchBytes: 32 * 1024 * 1024 };
test("backup configuration rejects secret URLs, remote HTTP, invalid refs and unbounded scratch", () => {
  assert.deepEqual(validateBackupRequest(request), request);
  for (const patch of [ { repository: "rest:http://100.1.1.1/repo/" }, { repository: "rest:https://user:password@example.com/repo/" },
    { repository: "rest:https://example.com/repo/?token=secret" }, { passwordRef: "global/other" }, { writerRef: "global/fleet-backup-fixture-repo-key" },
    { maxScratchBytes: -1 }, { maxScratchBytes: 100 * 1024 ** 3 } ]) {
    assert.throws(() => validateBackupRequest({ ...request, ...patch }), error => error instanceof BackupError && error.code === "invalid_request");
  }
});
test("backup kind, draft receipt and gate intent survive store reopen and audit replay", () => {
  mkdirSync(fixtureRoot, { recursive: true }); const root = mkdtempSync(join(fixtureRoot, "record-"));
  const path = join(root, "core.sqlite3");
  let store = openCoreStore(path);
  try {
    const bee = store.createBee({ name: "fixture", agent: "stub", cwd: join(root,"space"), substrate: "cell" }).bee;
    const cell = store.putCell({ sourceBeeId: bee.id, originRepo: root, sha: "abc", wrapper: "w", spaceName: "repo-space-c1", spaceDir: bee.cwd, gitCommonDirRealpath: join(root,".git"), objectFormat: "sha1" });
    const op = store.putCellOp({ cellId: cell.id, kind: "backup", idempotencyKey: "once", requestHash: "hash" });
    store.updateCellOp(op.id, { status: "running", pid: process.pid, stdout: '{"verification":"not_verified"}' });
    assert.equal(store.putCellOp({ cellId: cell.id, kind: "backup", idempotencyKey: "once", requestHash: "hash" }).id, op.id);
    assert.throws(() => store.putCellOp({ cellId: cell.id, kind: "backup", idempotencyKey: "once", requestHash: "different" }));
    const expected = store.getCellOp(op.id);
    assert.deepEqual(replayAudit(store.auditRows()).cellOps, [expected]);
    store.close(); store = openCoreStore(path);
    assert.deepEqual(store.getCellOp(op.id), expected);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("v51 migration preserves queued operations while admitting backup kind", () => {
  mkdirSync(fixtureRoot, { recursive: true }); const root = mkdtempSync(join(fixtureRoot, "migration-"));
  const path = join(root,"core.sqlite3"); let store = openCoreStore(path);
  try {
    const bee=store.createBee({name:"migration",agent:"stub",cwd:root,substrate:"cell"}).bee;
    const cell=store.putCell({sourceBeeId:bee.id,originRepo:root,sha:"abc",wrapper:"w",spaceName:"repo-space-c1",spaceDir:root,gitCommonDirRealpath:join(root,".git"),objectFormat:"sha1"});
    const old=store.putCellOp({cellId:cell.id,kind:"exec",idempotencyKey:"old",requestHash:"old"});
    store.close();
    const legacy=new DatabaseSync(path);
    legacy.exec("ALTER TABLE cell_ops RENAME TO saved_ops");
    legacy.exec(CELL_OPS_TABLE_SQL.replace(",'backup'", ""));
    legacy.exec("INSERT INTO cell_ops SELECT * FROM saved_ops; DROP TABLE saved_ops; UPDATE meta SET value='51' WHERE key='schema_version'");
    legacy.close();
    store=openCoreStore(path);
    assert.deepEqual(store.getCellOp(old.id),old);
    assert.equal(store.putCellOp({cellId:cell.id,kind:"backup",idempotencyKey:"new",requestHash:"new"}).kind,"backup");
    store.close(); store=openCoreStore(path);
    assert.equal(store.getCellOpByKey("new")?.kind,"backup");
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});

test("owner reclaims superseded failed bulk scratch and preserves durable manifests", async () => {
  mkdirSync(fixtureRoot,{recursive:true});const root=mkdtempSync(join(fixtureRoot,"budget-"));
  try {
    const failed="11111111-1111-1111-1111-111111111111";mkdirSync(join(root,failed));writeFileSync(join(root,failed,"objects.pack"),Buffer.alloc(2048));writeFileSync(join(root,failed,"manifest.json"),"{}");
    await assert.rejects(remainingBackupScratch(root,"new-generation",2048),error=>error instanceof BackupError && error.code==="scratch_limit");
    assert.equal(await remainingBackupScratch(root,"new-generation",4096),2048);
    assert.equal(statSync(join(root,failed,"objects.pack")).size,2048);
    await retireBackupCheckpoint(root,failed);
    assert.equal(await remainingBackupScratch(root,"new-generation",4096),4096);
    assert.ok(existsSync(join(root,failed,"manifest.json")));
  } finally {rmSync(root,{recursive:true,force:true});}
});

const restic = process.env.HIVE_TEST_RESTIC;
const restServer = process.env.HIVE_TEST_REST_SERVER;
test("real loopback backup: WAL exports, ignored evidence, interrupted retry, lost receipt, restore bytes and git fsck", { skip: !restic || !restServer, timeout: 120_000 }, async t => {
  mkdirSync(fixtureRoot, { recursive: true }); const root = mkdtempSync(join(fixtureRoot, "restore-"));
  const repo = join(root, "cells", "wrapper", "repo-space-c1"), scratch = join(root,"capture"), keepRoot = join(root,"cell-keep");
  mkdirSync(repo, { recursive: true }); mkdirSync(join(dirname(repo), "box")); mkdirSync(keepRoot);
  const git = (args: string[], cwd = repo) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore","pipe","pipe"], env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git(["init", "-b", "main"]); git(["config", "user.name", "Disposable fixture"]); git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo,".env.example"), "EXAMPLE=placeholder\n");
  writeFileSync(join(repo,"tracked.txt"), "base\n"); writeFileSync(join(repo,".gitignore"), ".audit/\nnode_modules/\ndist/\nunique-ignored.txt\n");
  git(["add", "."]); git(["commit", "-m", "fixture base"]); const base = git(["rev-parse","HEAD"]);
  writeFileSync(join(repo,"tracked.txt"), "dirty staged\n"); git(["add", "tracked.txt"]); writeFileSync(join(repo,"tracked.txt"), "dirty unstaged\n");
  writeFileSync(join(repo,"untracked.bin"), randomBytes(65536)); writeFileSync(join(repo,"unique-ignored.txt"), "keep ignored bytes\n");
  writeFileSync(join(repo,"executable"), "#!/bin/sh\nexit 0\n"); chmodSync(join(repo,"executable"), 0o751); symlinkSync("tracked.txt", join(repo,"link"));
  for (const folder of [".audit", "node_modules", "dist", "dist/.proof", "empty", "only-dependencies/node_modules"]) mkdirSync(join(repo,folder), { recursive:true });
  writeFileSync(join(repo,".audit","evidence.bin"), randomBytes(32768)); writeFileSync(join(repo,"dist/.proof","proof.bin"), "evidence inside build\n");
  writeFileSync(join(repo,"only-dependencies/node_modules","excluded"), "reinstall me too");
  writeFileSync(join(repo,"node_modules","excluded"), "reinstall me"); writeFileSync(join(repo,"dist","excluded"), "rebuild me");
  mkdirSync(join(keepRoot,"repo-space-c1", ".proof"), { recursive:true }); writeFileSync(join(keepRoot,"repo-space-c1", ".proof", "kept.bin"), "retained evidence\n");
  writeFileSync(join(keepRoot,"repo-space-c1.json"), '{"version":1,"paths":[".proof"]}');
  writeFileSync(join(dirname(repo),"box","cell.json"), '{"version":1,"fixture":true}');
  const originalStatus = git(["status", "--porcelain=v1", "--ignored"]);
  const core = openCoreStore(join(root,"core.sqlite3")); const telemetry = new TelemetryStore(join(root,"telemetry.sqlite3"));
  const bee = core.createBee({ name: "fixture", agent: "stub", cwd: repo, substrate: "cell" }).bee;
  const active = core.putCell({ sourceBeeId: bee.id, originRepo: repo, sha: base, wrapper:"wrapper", spaceName:"repo-space-c1", spaceDir:repo, gitCommonDirRealpath:join(repo,".git"), objectFormat:"sha1" });
  core.retainCell(active.id); const cell = core.getCell(active.id)!;
  telemetry.recordI1({ messageId: 42, beeId: bee.id, detectedAt: 100, enqueuedAt: 1, deadline: 2, detail: "fixture committed WAL row" });
  // Crash the capture owner while a guarded tool is alive. Both descendants must stop.
  const slowTool=join(root,"slow-restic.mjs"), started=join(root,"tool-started"), guardIdentity=join(root,"guard-pid");
  writeFileSync(slowTool,`#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},1000);\n`); chmodSync(slowTool,0o700);
  const engine=new URL("../src/backupCapture.ts",import.meta.url).href;
  const guardedScript=`import {captureAndSnapshot} from ${JSON.stringify(engine)};import {writeFileSync} from 'node:fs';
    await captureAndSnapshot(${JSON.stringify({...request,cellId:cell.id})},{cell:${JSON.stringify(cell)},machine:'crash-fixture',operationId:'crash-fixture',scratch:${JSON.stringify(join(root,"crash-capture"))},keepRoot:${JSON.stringify(keepRoot)},tools:{git:'git',restic:${JSON.stringify(slowTool)},hem:'unused'},snapshotDatabases:async()=>[],save:()=>{},child:pid=>{if(pid)writeFileSync(${JSON.stringify(guardIdentity)},String(pid));}});`;
  const captureOwner=spawn(process.execPath,["--input-type=module","-e",guardedScript],{stdio:["ignore","pipe","pipe"]});
  captureOwner.stdout.resume();captureOwner.stderr.resume();
  t.after(()=>captureOwner.kill());
  for(let i=0;i<250 && !existsSync(started);i++) await new Promise(r=>setTimeout(r,20));
  assert.ok(existsSync(started),"guarded tool started after capture owner admission");
  const guardPid=Number(readFileSync(guardIdentity,"utf8")),toolPid=Number(readFileSync(started,"utf8"));
  captureOwner.kill("SIGKILL"); await new Promise<void>(r=>captureOwner.once("close",()=>r()));
  const live=(pid:number)=>{try {return !execFileSync("ps",["-o","stat=","-p",String(pid)],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim().startsWith("Z");}catch{return false;}};
  for(let i=0;i<300 && (live(guardPid)||live(toolPid));i++) await new Promise(r=>setTimeout(r,20));
  assert.ok(!live(guardPid)&&!live(toolPid),"daemon disconnect stops guard and tool without leaving a source reader");
  const password = randomBytes(32).toString("hex"), writerPassword = randomBytes(32).toString("hex"), username = "fixture";
  const serverRoot = join(root,"server"); mkdirSync(serverRoot);
  // Only a one-way hash is written. Disposable plaintext passwords remain in memory/process env.
  writeFileSync(join(root,"htpasswd"), username + ":{SHA}" + createHash("sha1").update(writerPassword).digest("base64") + "\n", { mode:0o600 });
  const listener = createServer(); await new Promise<void>(r => listener.listen(0,"127.0.0.1",r)); const port = (listener.address() as {port:number}).port; await new Promise<void>(r=>listener.close(()=>r()));
  const server = spawn(restServer!, ["--listen", `127.0.0.1:${port}`, "--path",serverRoot,"--htpasswd-file",join(root,"htpasswd"),"--append-only","--private-repos"], { stdio:["ignore","pipe","pipe"] });
  let serverOutput = ""; server.stdout.on("data", b=>serverOutput+=b); server.stderr.on("data",b=>serverOutput+=b);
  t.after(() => { server.kill(); core.close(); telemetry.close(); if (!process.env.HIVE_TEST_KEEP_BACKUP_FIXTURE) rmSync(root,{recursive:true,force:true}); });
  let ready = false;
  for (let i=0;i<100;i++) { try { await fetch(`http://127.0.0.1:${port}/`, { redirect:"error" }); ready=true;break; } catch { await new Promise(r=>setTimeout(r,20)); } }
  assert.ok(ready,"loopback rest-server ready");
  const config = validateBackupRequest({ ...request, cellId:cell.id, repository:`rest:http://127.0.0.1:${port}/fixture/` });
  const resticEnv = { PATH:process.env.PATH, HOME:root, RESTIC_PASSWORD:password, RESTIC_REST_USERNAME:username, RESTIC_REST_PASSWORD:writerPassword };
  const rest = (args:string[]) => execFileSync(restic!, ["--repo",config.repository,"--no-cache",...args], { encoding:"utf8",env:resticEnv,stdio:["ignore","pipe","pipe"] });
  const outputs:string[] = [rest(["init"])];
  const op = core.putCellOp({ cellId:cell.id,kind:"backup",idempotencyKey:"real-drill",requestHash:digest(JSON.stringify(config)) });
  let saved:BackupRecord|undefined; const abort = new AbortController(); let interrupt = true;
  const owner:BackupOwner = { cell,machine:"disposable-fixture",operationId:op.id,scratch,keepRoot,
    tools:{git:"git",restic:restic!,hem:"unused-in-fixture"}, signal:abort.signal,
    snapshotDatabases: async (destination,budget,signal)=>{ const first=await core.snapshot("fixture",join(destination,"core"),budget,signal); return [first,await telemetry.snapshot(join(destination,"telemetry"),budget-statSync(first.backupPath).size,signal)]; },
    resolveSecret: async (ref,field)=>ref.endsWith("-repo-key") ? password : field==="username" ? username : writerPassword,
    save: record=>{ saved=record; core.updateCellOp(op.id,{stdout:JSON.stringify(record)}); },
    child: pid=>{ if (pid && saved?.state==="uploading" && interrupt) { interrupt=false; abort.abort(); } },
  };
  for(const name of ["lfs","rebase-merge"]){
    mkdirSync(join(repo,".git",name));
    await assert.rejects(captureAndSnapshot(config,owner),error=>error instanceof BackupError && error.code==="git_incomplete");
    rmSync(join(repo,".git",name),{recursive:true,force:true});
  }
  mkdirSync(join(repo,"nested-repository",".git"),{recursive:true});
  await assert.rejects(captureAndSnapshot(config,owner),error=>error instanceof BackupError && error.code==="git_incomplete");
  rmSync(join(repo,"nested-repository"),{recursive:true,force:true});
  writeFileSync(join(repo,".env"),"fixture marker; no credential");
  await assert.rejects(captureAndSnapshot(config,owner),error=>error instanceof BackupError && error.code==="sensitive_file");
  rmSync(join(repo,".env"));
  const liveFixture = new DatabaseSync(join(repo,"live.sqlite3")); liveFixture.exec("PRAGMA journal_mode=WAL; CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('WAL only')");
  await assert.rejects(captureAndSnapshot(config,owner),error=>error instanceof BackupError && error.code==="database_in_tree");
  liveFixture.close(); rmSync(join(repo,"live.sqlite3"));
  await assert.rejects(core.snapshot("fixture",join(root,"too-small"),1024), error=>error instanceof Error && error.message==="Snapshot exceeds scratch budget");
  await assert.rejects(captureAndSnapshot(config,owner),error=>error instanceof BackupError && error.code==="interrupted");
  assert.ok(saved?.manifestHash,"capture checkpoint persisted before interrupted upload");
  assert.equal(git(["status","--porcelain=v1","--ignored"]),originalStatus,"interruption preserves Cell");
  owner.signal=undefined;
  // Lose the final receipt after a real upload, then retry using repository reconciliation.
  let loseReceipt=true; owner.save=record=>{ if(record.state==="snapshot_created" && loseReceipt){loseReceipt=false;throw new Error("simulated owner receipt interruption");} saved=record;core.updateCellOp(op.id,{stdout:JSON.stringify(record)}); };
  await assert.rejects(captureAndSnapshot(config,owner,saved));
  assert.equal(saved?.state,"uploading");
  const result = await captureAndSnapshot(config,owner,saved);
  const duplicate = await captureAndSnapshot(config,owner,result);
  assert.equal(result.snapshotId,duplicate.snapshotId);
  assert.equal((JSON.parse(rest(["snapshots","--json"])) as unknown[]).length,1,"one snapshot despite interrupted upload and lost receipt");
  const target = join(root,"restored"); outputs.push(rest(["restore",result.snapshotId! + ":" + root,"--target",target]));
  const manifest = JSON.parse(readFileSync(result.manifestPath,"utf8")) as BackupManifest;
  assert.ok(!existsSync(manifest.git.bundle) && !existsSync(manifest.git.objects) && !existsSync(join(scratch,"databases")), "bulky scratch removed after durable receipt");
  const restored = (path:string)=>join(target,relative(root,path));
  for (const item of manifest.entries) {
    if(item.kind==="directory") {
      if(!existsSync(restored(item.path))){
        assert.ok(!manifest.entries.some(child=>child.kind!=="directory" && child.path.startsWith(item.path+"/")),"only manifest-empty directory needs reconstruction");
        mkdirSync(restored(item.path),{recursive:true});chmodSync(restored(item.path),item.mode);
      }
      assert.equal(statSync(restored(item.path)).mode & 0o7777,item.mode);continue;
    }
    assert.ok(existsSync(restored(item.path)),"manifest entry restored");
    if(item.kind==="symlink") assert.equal(digest(readlinkSync(restored(item.path))),item.sha256);
    else { assert.equal(digest(readFileSync(restored(item.path))),item.sha256); assert.equal(statSync(restored(item.path)).mode & 0o7777,item.mode); }
  }
  assert.equal(digest(readFileSync(restored(result.manifestPath))),result.manifestHash);
  for(const db of manifest.databases) {
    const recovered = new DatabaseSync(restored(db.backupPath),{readOnly:true});
    assert.equal(recovered.prepare("PRAGMA integrity_check").get()?.integrity_check,"ok");
    if(db.sourceBuild==="honeybee-telemetry") assert.equal(recovered.prepare("SELECT detail FROM i1_violations WHERE message_id=42").get()?.detail,"fixture committed WAL row");
    else assert.equal(recovered.prepare("SELECT name FROM bees WHERE id=?").get(bee.id)?.name,"fixture");
    recovered.close();
  }
  // Rebuild Git independently from the self-contained bundle; worktree remains its captured dirty bytes.
  const recoveredRepo=restored(repo); git(["init","-b","main"],recoveredRepo);
  git(["fetch","--update-head-ok",restored(manifest.git.bundle),"refs/heads/main:refs/heads/main"],recoveredRepo);
  git(["symbolic-ref","HEAD","refs/heads/main"],recoveredRepo);
  // Pack contains every accessible object, including staged and dangling objects, independent of alternates.
  execFileSync("git",["index-pack","--stdin"],{cwd:recoveredRepo,input:readFileSync(restored(manifest.git.objects)),stdio:["pipe","pipe","pipe"]});
  assert.equal(git(["rev-parse","HEAD"],recoveredRepo),manifest.git.head);
  outputs.push(git(["fsck","--full"],recoveredRepo));
  assert.equal(git(["status","--porcelain=v1"],recoveredRepo),git(["status","--porcelain=v1"]));
  assert.ok(!existsSync(restored(join(repo,"node_modules","excluded")))); assert.ok(!existsSync(restored(join(repo,"dist","excluded"))));
  assert.equal(git(["status","--porcelain=v1","--ignored"]),originalStatus,"successful backup preserves Cell");
  // A second capture models the common stash-only evicted state, with no checkout left.
  const origin = join(root,"evicted-origin.git"); git(["clone","--bare",repo,origin]);
  const absent = join(root,"cells","evicted-wrapper","evicted-space-c2");
  const stash = join(keepRoot,"evicted-space-c2"); mkdirSync(join(stash,".audit"),{recursive:true});
  const stashBytes = randomBytes(8192); writeFileSync(join(stash,".audit","sole-copy.bin"),stashBytes);
  symlinkSync(".audit/sole-copy.bin",join(stash,"artifact-link"));
  writeFileSync(stash+".json",JSON.stringify({version:1,paths:[".audit","artifact-link"]}));
  const evictedBee=core.createBee({name:"evicted-fixture",agent:"stub",cwd:absent,substrate:"cell"}).bee;
  const evictedActive=core.putCell({sourceBeeId:evictedBee.id,originRepo:origin,sha:base,wrapper:"evicted-wrapper",spaceName:"evicted-space-c2",spaceDir:absent,gitCommonDirRealpath:origin,objectFormat:"sha1"});
  const evicted=core.evictCell(evictedActive.id,{head:base,bytes:0,reason:"disposable_fixture",keptPaths:[".audit","artifact-link"]});
  const stashOp=core.putCellOp({cellId:evicted.id,kind:"backup",idempotencyKey:"stash-drill",requestHash:"stash"});
  let stashRecord:BackupRecord|undefined;
  const stashOwner:BackupOwner={...owner,cell:evicted,operationId:stashOp.id,scratch:join(root,"stash-capture"),child:()=>undefined,
    save:record=>{stashRecord=record;core.updateCellOp(stashOp.id,{stdout:JSON.stringify(record)});}};
  const stashResult=await captureAndSnapshot({...config,cellId:evicted.id,idempotencyKey:"stash-drill"},stashOwner);
  assert.equal(stashRecord?.verification,"not_verified");
  assert.ok(!existsSync(absent),"stash capture never recreates the source Cell");
  assert.equal(digest(readFileSync(join(stash,".audit","sole-copy.bin"))),digest(stashBytes),"stash source untouched");
  // Remove ONLY the disposable fixture origin. Recovery must use the snapshot alone.
  rmSync(origin,{recursive:true,force:true});
  const stashTarget=join(root,"stash-restored"); outputs.push(rest(["restore",stashResult.snapshotId!+":"+root,"--target",stashTarget]));
  const stashManifest=JSON.parse(readFileSync(stashResult.manifestPath,"utf8")) as BackupManifest;
  assert.equal(stashManifest.captureKind,"evicted_stash"); assert.deepEqual(stashManifest.git.dependencies,[]);
  const stashRestored=(path:string)=>join(stashTarget,relative(root,path));
  for(const item of stashManifest.entries){
    if(item.kind==="directory"){assert.ok(existsSync(stashRestored(item.path)));continue;}
    assert.equal(digest(item.kind==="symlink"?readlinkSync(stashRestored(item.path)):readFileSync(stashRestored(item.path))),item.sha256);
  }
  const usable=join(root,"usable-stash-tree"); git(["clone",stashRestored(stashManifest.git.bundle),usable]);
  assert.equal(git(["rev-parse","HEAD"],usable),base); outputs.push(git(["fsck","--full"],usable));
  // Owner restore overlays the kept paths onto the recovered clean tree.
  const {cpSync}=await import("node:fs");
  for(const name of readdirSync(stashRestored(stash))) cpSync(join(stashRestored(stash),name),join(usable,name),{recursive:true,dereference:false,verbatimSymlinks:true});
  assert.equal(readFileSync(join(usable,"tracked.txt"),"utf8"),"base\n");
  assert.equal(digest(readFileSync(join(usable,".audit","sole-copy.bin"))),digest(stashBytes));
  assert.equal(readlinkSync(join(usable,"artifact-link")),".audit/sole-copy.bin");
  assert.equal((JSON.parse(rest(["snapshots","--json"])) as unknown[]).length,2,"one snapshot per captured Cell");
  outputs.push(rest(["check","--read-data"]));
  const diagnostics = JSON.stringify({outputs,serverOutput,record:result,stashRecord,stashManifest,manifest,op:core.getCellOp(op.id)});
  for(const value of [password,writerPassword]) assert.equal(diagnostics.includes(value),false,"no secret in retained diagnostics or records");
  // Exercise the real daemon admission, Hem-reference boundary and durable done replay.
  const bin=join(root,"bin");mkdirSync(bin);
  const failAfterUpload=join(root,"fail-after-upload");
  writeFileSync(join(bin,"restic"),`#!/usr/bin/env node\nimport{spawn}from'node:child_process';import*as fs from'node:fs';const args=process.argv.slice(2);const child=spawn(${JSON.stringify(restic)},args,{env:process.env,stdio:'inherit'});child.on('error',()=>process.exit(2));child.on('close',code=>{if(code===0&&args.includes('backup')&&fs.existsSync(${JSON.stringify(failAfterUpload)})){fs.unlinkSync(${JSON.stringify(failAfterUpload)});process.exit(2);}process.exit(code??2);});\n`,{mode:0o700});
  writeFileSync(join(bin,"hem"),`#!/usr/bin/env node\nconst value=JSON.parse(process.env.VALHALL_HEM_TOKEN);const ref=process.argv[3],field=process.argv[4];if(ref.includes('deny-writer'))process.exit(2);process.stdout.write(ref.endsWith('-repo-key')?value.repo:field==='username'?value.username:value.writer);\n`,{mode:0o700});
  writeFileSync(join(root,"config.json"),JSON.stringify({tickMs:20,cells:{root:join(root,"cells")},cellRetention:{enabled:false}}));
  writeFileSync(join(root,"backup.json"),JSON.stringify({repository:config.repository,passwordRef:config.passwordRef,writerRef:config.writerRef,maxScratchBytes:request.maxScratchBytes}));
  const otherSpace=join(root,"cells","other-wrapper","other-space-c3");mkdirSync(dirname(otherSpace),{recursive:true});
  git(["clone","--no-hardlinks",repo,otherSpace]);mkdirSync(join(dirname(otherSpace),"box"));writeFileSync(join(dirname(otherSpace),"box","cell.json"),'{"version":1,"fixture":true}');
  const otherBee=core.createBee({name:"other-retained",agent:"stub",cwd:otherSpace,substrate:"cell"}).bee;
  const otherCell=core.putCell({sourceBeeId:otherBee.id,originRepo:repo,sha:base,wrapper:"other-wrapper",spaceName:"other-space-c3",spaceDir:otherSpace,gitCommonDirRealpath:join(otherSpace,".git"),objectFormat:"sha1"});core.retainCell(otherCell.id);
  core.close();telemetry.close();
  // A short path alias keeps Unix socket names valid; every fixture byte remains in this Cell.
  const alias=join("/tmp","hb-b2-"+randomBytes(6).toString("hex"));symlinkSync(root,alias);mkdirSync(join(root,"tmp"));
  t.after(()=>rmSync(alias,{force:true}));
  const daemonEnv={PATH:bin+":"+process.env.PATH,TMPDIR:join(alias,"tmp"),VALHALL_HEM_TOKEN:JSON.stringify({repo:password,writer:writerPassword,username})};
  let daemon=await startDaemon(alias,{env:daemonEnv});
  let client=await daemon.client();
  t.after(async()=>{client.close();await daemon.stop();});
  const rpc=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"rpc-drill"},60_000);
  assert.equal(rpc.status,"snapshot_created");
  const rpcReplay=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"rpc-drill"},60_000);
  assert.deepEqual(rpcReplay,rpc,"daemon done replay returns the same receipt");
  await assert.rejects(client.request("cell.backup",{cellId:evicted.id,idempotencyKey:"rpc-drill"},60_000));
  writeFileSync(failAfterUpload,"once");
  const lostRpc=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"lost-receipt-rpc"},60_000);
  assert.ok(lostRpc.status==="failed" && lostRpc.reason==="tool_failed","tool fails only after snapshot commit");
  if(lostRpc.status!=="failed" || !lostRpc.operationId)throw Error("missing interrupted upload fixture");
  const protectedScratch=join(root,"backup-captures",lostRpc.operationId);
  const interleaved=await client.request<BackupResult>("cell.backup",{cellId:otherCell.id,idempotencyKey:"interleaved-other-cell"},60_000);
  assert.equal(interleaved.status,"snapshot_created");
  assert.ok(existsSync(join(protectedScratch,"history.bundle")),"another Cell cannot retire an uploading lost-receipt checkpoint");
  const reconciledRpc=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"lost-receipt-rpc"},60_000);
  assert.equal(reconciledRpc.status,"snapshot_created","original key probes the committed snapshot after interleaved work");
  const denyConfig={repository:config.repository,passwordRef:config.passwordRef,writerRef:"global/fleet-backup-deny-writer",maxScratchBytes:request.maxScratchBytes};
  writeFileSync(join(root,"backup.json"),JSON.stringify(denyConfig));
  const failedRpc=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"failed-before-transfer"},60_000);
  assert.equal(failedRpc.status,"failed");
  assert.ok(failedRpc.status==="failed" && failedRpc.reason==="secret_unavailable");
  if(failedRpc.status!=="failed" || !failedRpc.operationId)throw Error("missing failed operation fixture");
  const failedScratch=join(root,"backup-captures",failedRpc.operationId);
  assert.ok(existsSync(join(failedScratch,"history.bundle")),"failure retains a retry checkpoint until superseded");
  writeFileSync(join(root,"backup.json"),JSON.stringify({...denyConfig,writerRef:config.writerRef}));
  const afterGc=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"after-failed-gc"},60_000);
  assert.equal(afterGc.status,"snapshot_created");
  assert.ok(!existsSync(join(failedScratch,"history.bundle")) && !existsSync(join(failedScratch,"databases")),"owner reclaims failed bulk scratch before a new operation");
  assert.ok(existsSync(join(failedScratch,"manifest.json")),"failed manifest remains for the audit/catalogue");
  const beforeShutdown=new Set(readdirSync(join(root,"backup-captures")));
  const duringShutdown=client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"shutdown-drill"},60_000);
  let snapshotStarted=false;
  for(let i=0;i<3000 && !snapshotStarted;i++){
    for(const name of readdirSync(join(root,"backup-captures"))){
      if(beforeShutdown.has(name))continue;
      const path=join(root,"backup-captures",name,"databases","core");
      if(existsSync(path) && readdirSync(path).some(name=>name.endsWith(".sqlite3")))snapshotStarted=true;
    }
    if(!snapshotStarted)await new Promise(r=>setTimeout(r,2));
  }
  assert.ok(snapshotStarted,"online snapshot started before shutdown");
  const stopping=daemon.stop();
  const interruptedRpc=await duringShutdown;
  await stopping;client.close();
  assert.equal(interruptedRpc.status,"failed");
  if(interruptedRpc.status==="failed")assert.equal(interruptedRpc.reason,"interrupted");
  daemon=await startDaemon(alias,{env:daemonEnv});
  client=await daemon.client();
  const resumedRpc=await client.request<BackupResult>("cell.backup",{cellId:cell.id,idempotencyKey:"shutdown-drill"},60_000);
  assert.equal(resumedRpc.status,"snapshot_created","interrupted online snapshot resumes after daemon restart");
  client.close();await daemon.stop();
  assert.equal(git(["status","--porcelain=v1","--ignored"]),originalStatus,"daemon capture and shutdown retry preserve the source tree");
  const allSnapshots=JSON.parse(rest(["snapshots","--json"])) as {id:string;tags:string[]}[];
  assert.equal(allSnapshots.length,7);
  const operationTags=allSnapshots.flatMap(snapshot=>snapshot.tags.filter(tag=>tag.startsWith("honeybee:")));
  assert.equal(new Set(operationTags).size,7,"exactly one snapshot for each operation tag");
  const daemonLog=readFileSync(join(root,"hived.log"),"utf8");
  for(const value of [password,writerPassword]) assert.equal(daemonLog.includes(value),false,"daemon logs exclude fixture credentials");
  const proof = { result:"PASS", sourceUntouched:true, ownerCrashStopsTools:true, daemonRpcAndReplay:true, symlinkedDataDir:true, shutdownDuringOnlineSnapshotResumes:true, failedScratchReclaimedByOwner:true, interleavedLostReceiptReconciles:true, interruptedRetry:true, lostReceiptReconciled:true, snapshots:7, snapshotsPerOperation:1, snapshotOperations:["retained-with-retries","evicted-stash","daemon-rpc","lost-receipt-rpc","interleaved-other-cell","after-failed-scratch-gc","daemon-shutdown-retry"], stashOnlyRestoreWithoutOrigin:true,
    byteAndModeAgreement:manifest.entries.length, gitFsck:"ok", databaseIntegrity:"ok", walRowRecovered:true, secretScan:"clean", secretScanMethod:"fixture repository/writer passwords absent from captured tool/server output, manifests, draft records, operation record and daemon log", sourceCheckMethod:"Git status and captured bytes/modes/symlinks checked before and after; stash bytes checked after capture", verification:"not_verified (B3 required)",
    record:result, restoredAt:target, toolVersions:{...result.tools,restServer:execFileSync(restServer!,["--version"],{encoding:"utf8"}).trim()} };
  writeFileSync(resolve(".audit/backup-b2/end-to-end.json"),JSON.stringify(proof,null,2)+"\n");
  console.log(`PASS: ${manifest.files} files, ${manifest.bytes} bytes, WAL row recovered, git fsck agrees, one snapshot per operation tag after interruption/retry, stash-only recovery without origin; fixture credentials absent from diagnostics/records`);
});
