import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkEvictionPolicy, VerifiedEvictionError } from "../src/verifiedEviction.ts";
import { deleteCell, CellBackupRequiredError } from "../../driver-cell/src/remove.ts";
import { evictCellWrapper, parkTrimPaths, sweepEvicting, sweepEvictingSync } from "../../driver-cell/src/retention.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { openCoreStore } from "../../core/src/index.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import type { SpawnResult, ViewResult } from "../src/protocol.ts";
const fixtures=resolve(".audit/backup-b4/fixtures");mkdirSync(fixtures,{recursive:true});process.env.TMPDIR=fixtures;
test("capacity observations fail closed on unknown, stale and ninety percent",()=>{
  const c={repository:"repo",observedAt:100,maxAgeMs:10,repositoryUsedBytes:1,repositoryLimitBytes:100,fleetUsedBytes:1,fleetLimitBytes:100,stopFraction:0.9};
  const p={version:1 as const,maxReceiptAgeMs:10,capacity:c};checkEvictionPolicy(p,"repo",101);
  for(const [policy,now,reason] of [[{},101,"unknown_policy"],[p,111,"unknown_policy"],[{...p,capacity:{...c,fleetUsedBytes:90}},101,"capacity_stop"],[{...p,capacity:{...c,repositoryUsedBytes:90}},101,"capacity_stop"]]as const)
    assert.throws(()=>checkEvictionPolicy(policy as typeof p,"repo",now),error=>error instanceof VerifiedEvictionError&&error.reason===reason);
});
test("legacy delete, force, parking, trimming and orphan sweep cannot unlink bytes",async()=>{
  const root=mkdtempSync(join(fixtures,"legacy-")),wrapper=join(root,"wrapper"),park=join(root,"_evicting","orphan");mkdirSync(wrapper);mkdirSync(park,{recursive:true});writeFileSync(join(wrapper,"sole-copy"),"preserve");writeFileSync(join(park,"sole-copy"),"preserve");
  try{
    for(const force of[false,true])for(const effect of[()=>deleteCell(wrapper,{force}),()=>evictCellWrapper(root,wrapper,{force})])assert.throws(effect,CellBackupRequiredError);
    assert.throws(()=>parkTrimPaths(root,wrapper,["build"]),CellBackupRequiredError);
    const sweep=await sweepEvicting(root);assert.deepEqual(sweep.removed,[]);assert.equal(sweep.failed[0]?.error,"receipt_missing");assert.deepEqual(sweepEvictingSync(root),[]);
    assert.equal(readFileSync(join(wrapper,"sole-copy"),"utf8"),"preserve");assert.equal(readFileSync(join(park,"sole-copy"),"utf8"),"preserve");
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("real RPC remove, evict and retained-remove refuse unbacked fixture Cells even with force",{timeout:120000},async t=>{
  const root=mkdtempSync(join(fixtures,"rpc-")),origin=makeOrigin(root),cells=join(root,"cells");mkdirSync(cells);
  const rig=makeDaemonDir({cells:{root:cells},agents:{stub:{command:process.execPath,adapter:"stub",args:[fileURLToPath(new URL("../../driver-cell/test-agent/agent.mjs",import.meta.url))]}}});
  let daemon=await startDaemon(rig.dir),client=await daemon.client();t.after(async()=>{client.close();await daemon.stop();rig.cleanup();rmSync(root,{recursive:true,force:true});});
  const spawned=await client.request<SpawnResult>("spawn",{name:"unbacked",agent:"stub",substrate:"cell",cell:{originRepo:origin.repo}});
  const view=()=>client.request<ViewResult>("view",{beeId:spawned.beeId});const ready=await waitFor(async()=>{const v=await view();return v.view.runtimeState==="idle"&&v.cell?v:null;},"fixture ready",60000);
  await client.request("stop",{beeId:spawned.beeId});await waitFor(async()=>(await view()).view.runtimeState==="stopped","fixture stopped");writeFileSync(join(ready.cell!.spaceDir,"sole-copy"),"must survive");
  for(const verb of["cell.evict","cell.remove"]as const)for(const force of[false,true]){
    const result=await client.request<{status:string;reason:string}>(verb,{beeId:spawned.beeId,force,idempotencyKey:verb+force});assert.equal(result.status,"refused");assert.equal(result.reason,"receipt_missing");assert.ok(existsSync(join(ready.cell!.spaceDir,"sole-copy")));
  }
  client.close();await daemon.stop();const store=openCoreStore(join(rig.dir,"core.sqlite3"));store.retainCell(ready.cell!.id);store.close();daemon=await startDaemon(rig.dir);client=await daemon.client();
  for(const force of[false,true]){const result=await client.request<{status:string;reason:string}>("cell.retained.remove",{cellId:ready.cell!.id,force,idempotencyKey:"retained"+force});assert.equal(result.status,"refused");assert.equal(result.reason,"receipt_missing");assert.equal(readFileSync(join(ready.cell!.spaceDir,"sole-copy"),"utf8"),"must survive");}
  client.close();await daemon.stop();const pendingStore=openCoreStore(join(rig.dir,"core.sqlite3"));const pending=pendingStore.putCellOp({cellId:ready.cell!.id,kind:"backup",idempotencyKey:"capture-held",requestHash:"fixture"});pendingStore.updateCellOp(pending.id,{status:"running",pid:process.pid});pendingStore.close();daemon=await startDaemon(rig.dir);client=await daemon.client();
  const status=()=>client.request<import("../src/protocol.ts").CellStatusResult>("cell.status",{cellId:ready.cell!.id});assert.equal((await status()).mutation?.state,"cell_mutation_held");
  await client.request("delete",{beeId:spawned.beeId});await waitFor(async()=>{const list=await client.request<import("../src/protocol.ts").ListResult>("list");return !list.views.some(view=>view.view.beeId===spawned.beeId);},"bee delete remains immediate during capture hold");
  assert.equal((await status()).mutation?.state,"cell_mutation_held");assert.equal(readFileSync(join(ready.cell!.spaceDir,"sole-copy"),"utf8"),"must survive");
  client.close();await daemon.stop();const settledStore=openCoreStore(join(rig.dir,"core.sqlite3"));settledStore.updateCellOp(pending.id,{status:"done",pid:null});settledStore.close();daemon=await startDaemon(rig.dir);client=await daemon.client();assert.equal((await status()).mutation,null);assert.ok(existsSync(ready.cell!.spaceDir));

});

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, lstatSync, openSync, renameSync } from "node:fs";
import { backupDigest, backupVerifierKeyId, canonicalBackupJson } from "../../core/src/backupReceipt.ts";
import { performVerifiedEviction, type VerifiedEvictionInput } from "../src/verifiedEviction.ts";
function sealedFixture(state:"active"|"retained"="active"){
  const root=mkdtempSync(join(fixtures,"seal-")),cells=join(root,"cells"),wrapper=join(cells,"wrapper"),space=join(wrapper,"repo-space-c1"),box=join(wrapper,"box"),origin=join(root,"origin");mkdirSync(space,{recursive:true});mkdirSync(box);writeFileSync(join(box,"cell.json"),"{}");
  const git=(args:string[],cwd=space)=>execFileSync("git",args,{cwd,encoding:"utf8",stdio:["ignore","pipe","pipe"],env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}});
  git(["init","-b","main"]);git(["config","user.name","Fixture"]);git(["config","user.email","fixture@example.invalid"]);writeFileSync(join(space,"tracked"),"sole work\n");git(["add","."]);git(["commit","-m","fixture"]);git(["clone",space,origin],root);
  const head=git(["rev-parse","HEAD"]).trim(),cell={id:"fixture-cell",spaceDir:space,spaceName:"repo-space-c1",state,originRepo:origin};
  const entries=[space,join(space,"tracked"),join(space,".git","index"),join(box,"cell.json")].map(path=>{const st=lstatSync(path),directory=st.isDirectory();return{path,kind:directory?"directory":"file",mode:st.mode&0o7777,bytes:directory?0:st.size,sha256:backupDigest(directory?"":readFileSync(path))};});
  const manifest={format:"honeybee.capture.v1",machine:"fixture-machine",cell,generation:"fixture-generation",sourceRuntimeGeneration:null,captureKind:"retained_checkout",entries,policy:{version:1},git:{head,base:head,index:join(space,".git","index"),refs:git(["for-each-ref","--format=%(objectname) %(refname)"]),objectIdsHash:backupDigest(git(["cat-file","--batch-all-objects","--batch-check=%(objectname)"]))}};
  const manifestPath=join(root,"manifest.json"),bytes=JSON.stringify(manifest);writeFileSync(manifestPath,bytes);const keys=generateKeyPairSync("ed25519"),publicKey=keys.publicKey.export({format:"der",type:"spki"}).toString("base64");
  const payload={format:"honeybee.verified-backup.v1",verification:"verified",machine:"fixture-machine",cellId:cell.id,generation:manifest.generation,repository:"repository",repositoryId:"a".repeat(64),snapshotId:"b".repeat(64),manifestPath,manifestHash:backupDigest(bytes),files:3,bytes:entries.reduce((n,e)=>n+e.bytes,0),git:{head,base:head},databases:[],transcripts:[],verifier:{id:"independent",keyId:backupVerifierKeyId(publicKey)},verifiedAt:new Date().toISOString()};
  const record={operationId:manifest.generation,generation:manifest.generation,cellId:cell.id,machine:"fixture-machine",state:"snapshot_created",verification:"verified",repository:"repository",manifestPath,manifestHash:payload.manifestHash,snapshotId:payload.snapshotId,receipt:{payload,signature:sign(null,Buffer.from(canonicalBackupJson(payload)),keys.privateKey).toString("base64")}};
  const input={operationId:"delete-op",cellId:cell.id,machine:"fixture-machine",spaceDir:space,cellsRoot:cells,keepRoot:join(root,"cell-keep"),record,publicKey,policy:{version:1,maxReceiptAgeMs:3600000,capacity:{repository:"repository",observedAt:Date.now(),maxAgeMs:3600000,repositoryUsedBytes:0,repositoryLimitBytes:100000,fleetUsedBytes:0,fleetLimitBytes:100000,stopFraction:0.9}},repository:"repository",mode:"evict",now:Date.now(),git:"git",runtimeGeneration:null,cellIdentity:canonicalBackupJson(cell),completionPath:join(root,"completion.json"),abortFlag:new SharedArrayBuffer(4)} as unknown as VerifiedEvictionInput;
  return{root,space,wrapper,input};
}
test("parked content recheck rolls a racing write back without deleting it",()=>{
  const f=sealedFixture();try{
    assert.throws(()=>performVerifiedEviction(f.input,{afterPark:()=>writeFileSync(join(f.input.cellsRoot,"_evicting","wrapper.verified.delete-op","repo-space-c1","tracked"),"racing unique work")}),error=>error instanceof VerifiedEvictionError&&error.reason==="content_changed");
    assert.equal(readFileSync(join(f.space,"tracked"),"utf8"),"racing unique work");assert.equal(existsSync(f.input.completionPath),false);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("open descriptors and cancellation before authorization leave the fixture intact",()=>{
  const f=sealedFixture();try{
    const fd=openSync(join(f.space,"tracked"),"r");try{assert.throws(()=>performVerifiedEviction(f.input),error=>error instanceof VerifiedEvictionError&&error.reason==="content_changed");}finally{closeSync(fd);}
    assert.throws(()=>performVerifiedEviction(f.input,{afterPark:()=>Atomics.store(new Int32Array(f.input.abortFlag!),0,1)}),error=>error instanceof VerifiedEvictionError&&error.reason==="interrupted");assert.ok(existsSync(f.space));assert.equal(existsSync(f.input.completionPath),false);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("durable parked authorization completes after a crash and accepts no second effect",()=>{
  const f=sealedFixture();try{
    assert.throws(()=>performVerifiedEviction(f.input,{afterAuthorization:()=>{throw Error("simulated owner crash");}}),/simulated owner crash/);assert.equal(existsSync(f.space),false);assert.ok(existsSync(f.input.completionPath));
    const first=performVerifiedEviction(f.input);assert.equal(first.status,"deleted");assert.equal(existsSync(first.parkedDir),false);assert.deepEqual(performVerifiedEviction(f.input),first);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("an unauthorized park is restored when receipt or capacity policy expires",()=>{
  for(const kind of ["capacity","receipt"]){const f=sealedFixture();try{
    const park=join(f.input.cellsRoot,"_evicting","wrapper.verified.delete-op");mkdirSync(join(f.input.cellsRoot,"_evicting"));renameSync(f.wrapper,park);
    if(kind==="capacity")f.input.policy.capacity.observedAt=0;else f.input.policy.maxReceiptAgeMs=1;
    f.input.now=Date.now()+100;
    assert.throws(()=>performVerifiedEviction(f.input),error=>error instanceof VerifiedEvictionError&&["unknown_policy","receipt_stale"].includes(error.reason));assert.equal(readFileSync(join(f.space,"tracked"),"utf8"),"sole work\n");assert.equal(existsSync(park),false);
  }finally{rmSync(f.root,{recursive:true,force:true});}}
});
test("retained eviction and an unreferenced origin head refuse before any effect",()=>{
  const retained=sealedFixture("retained");try{assert.throws(()=>performVerifiedEviction(retained.input),error=>error instanceof VerifiedEvictionError&&error.reason==="receipt_stale");assert.ok(existsSync(retained.space));}finally{rmSync(retained.root,{recursive:true,force:true});}
  const f=sealedFixture();try{
    const origin=JSON.parse(f.input.cellIdentity).originRepo,head=f.input.record.receipt!.payload.git.head;
    for(const ref of execFileSync("git",["-C",origin,"for-each-ref","--format=%(refname)"],{encoding:"utf8"}).trim().split("\n"))execFileSync("git",["-C",origin,"update-ref","--no-deref","-d",ref]);
    execFileSync("git",["-C",origin,"cat-file","-e",head]);assert.throws(()=>performVerifiedEviction(f.input),error=>error instanceof VerifiedEvictionError&&error.reason==="unknown_policy");assert.ok(existsSync(f.space));
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("a capacity stop observed during verification rolls the park back before authorization",()=>{
 const f=sealedFixture();try{f.input.policyPath=join(f.root,"policy.json");writeFileSync(f.input.policyPath,JSON.stringify(f.input.policy));assert.throws(()=>performVerifiedEviction(f.input,{afterPark:()=>writeFileSync(f.input.policyPath!,JSON.stringify({...f.input.policy,capacity:{...f.input.policy.capacity,fleetUsedBytes:90000}}))}),error=>error instanceof VerifiedEvictionError&&error.reason==="capacity_stop");assert.ok(existsSync(f.space));assert.equal(existsSync(f.input.completionPath),false);}finally{rmSync(f.root,{recursive:true,force:true});}
});

import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION } from "../../core/src/schema.ts";
test("v52 upgrade preserves removal intent and stamps the v53 daemon compatibility fence",()=>{
 const f=sealedFixture();const path=join(f.root,"core.sqlite3");try{
  let store=openCoreStore(path);const bee=store.createBee({name:"migration",agent:"stub",cwd:f.space,substrate:"cell"}).bee;
  const cell=store.putCell({sourceBeeId:bee.id,originRepo:JSON.parse(f.input.cellIdentity).originRepo,sha:f.input.record.receipt!.payload.git.head,wrapper:"wrapper",spaceName:"repo-space-c1",spaceDir:f.space,gitCommonDirRealpath:join(f.space,".git"),objectFormat:"sha1"});
  const op=store.putCellOp({cellId:cell.id,kind:"remove",idempotencyKey:"migration",requestHash:"intent"}),intent=JSON.stringify({format:"honeybee.eviction-intent.v1",input:{...f.input,abortFlag:undefined}});store.updateCellOp(op.id,{status:"running",pid:process.pid,stdout:intent});store.close();
  let db=new DatabaseSync(path);db.exec("UPDATE meta SET value='52' WHERE key='schema_version';DROP INDEX cell_ops_mutation_pending;DROP INDEX cell_ops_backup_latest");db.close();
  store=openCoreStore(path);assert.equal(store.getCellOp(op.id)!.stdout,intent);assert.equal(store.getCellOp(op.id)!.status,"running");store.close();db=new DatabaseSync(path,{readOnly:true});assert.equal(SCHEMA_VERSION,53);assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value,"53");assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('cell_ops_mutation_pending','cell_ops_backup_latest')").get()!.n,2);db.close();
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
