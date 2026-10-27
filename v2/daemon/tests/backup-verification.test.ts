import { evictThroughOwner, type EvictionOwner } from "../src/evictionService.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createServer } from "node:net";
import { zstdCompressSync } from "node:zlib";
import { openCoreStore, replayAudit } from "../../core/src/index.ts";
import { backupDigest, backupVerifierKeyId, canonicalBackupJson, verifyBackupReceipt, type TranscriptArchiveIdentity, type TranscriptArchiveSummary, type VerifiedTranscriptObject } from "../../core/src/backupReceipt.ts";
import { captureAndSnapshot, type BackupRecord, type BackupRequest } from "../src/backupCapture.ts";
import { BackupVerificationError, validateBackupIndexListing, decodeTranscriptArchive, discoverRecoveryCatalogue, handoffTranscriptStage, materializeVerifiedCapture, readBackCapture, restoreFromCatalogue, signVerifiedCapture, type BackupRepositoryAccess, type BackupVerificationOwner } from "../src/backupVerification.ts";
import { TelemetryStore } from "../src/telemetry.ts";
const evidence=resolve(process.env.HIVE_TEST_BACKUP_EVIDENCE??".audit/backup-b3"),fixtures=join(evidence,"fixtures");
const identity:TranscriptArchiveIdentity={nodeId:"fixture-source",beeId:"archive-bee",epoch:"archive-epoch",compat:1};
function archive(){
  const header=JSON.stringify({type:"header",version:1,...identity})+"\n";
  const feed=JSON.stringify({type:"feed",row:{id:"feed-1",bee_id:identity.beeId,line_no:1,raw:"",events:JSON.stringify([{kind:"message",role:"assistant",text:"restored fixture"}]),harness:"stub",observed_at:1}})+"\n";
  const segment=JSON.stringify({type:"segment",row:{id:"segment-1",bee_id:identity.beeId,seq:4}})+"\n";
  const body=header+feed+segment;
  const summary:TranscriptArchiveSummary={feedRows:1,segmentRows:1,expandedBytes:Buffer.byteLength(body),digest:backupDigest(body),lastLine:1,segmentSeq:4,segmentDigest:backupDigest(segment)};
  const raw=body+JSON.stringify({type:"trailer",...summary,lastAssistant:"restored fixture"})+"\n";
  return{raw,summary,compressed:zstdCompressSync(raw)};
}
test("transcript v1 validates compressed decode, identity, digest, ordering and bounded expansion",async()=>{
  mkdirSync(fixtures,{recursive:true});const root=mkdtempSync(join(fixtures,"decode-"));const a=archive(),input=join(root,"archive.zst");writeFileSync(input,a.compressed);
  try{
    assert.deepEqual(await decodeTranscriptArchive(input,join(root,"good.jsonl"),identity,a.summary,a.summary.expandedBytes),a.summary);
    for(const [name,bytes,ident,summary,limit]of [
      ["wrong-identity",a.compressed,{...identity,beeId:"other"},a.summary,a.summary.expandedBytes],
      ["wrong-digest",a.compressed,identity,{...a.summary,digest:"0".repeat(64)},a.summary.expandedBytes],
      ["truncated",a.compressed.subarray(0,a.compressed.length-3),identity,a.summary,a.summary.expandedBytes],
      ["bomb",a.compressed,identity,a.summary,10],
      ["bad-trailer",zstdCompressSync(a.raw.replace('"feedRows":1','"feedRows":2')),identity,a.summary,a.summary.expandedBytes],
    ] as const){writeFileSync(input,bytes);await assert.rejects(decodeTranscriptArchive(input,join(root,name+".jsonl"),ident,summary,limit));assert.ok(!existsSync(join(root,name+".jsonl")));}
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("captured index names refuse traversal and case-folded Git control paths",()=>{
  const row=(name:string)=>"100644 "+"a".repeat(40)+" 0\t"+name+"\0";
  validateBackupIndexListing(row("src/file.ts"));
  for(const name of ["../x","/tmp/x",".GIT/config","dir/.git/config","a/../b"])
    assert.throws(()=>validateBackupIndexListing(row(name)),error=>error instanceof BackupVerificationError&&error.code==="git_invalid");
});
const restic=process.env.HIVE_TEST_RESTIC,restServer=process.env.HIVE_TEST_REST_SERVER;
test("independent verifier signs full remote readback, restores with source absent, and hands a validated transcript to its owner",{skip:!restic||!restServer,timeout:600_000},async t=>{
  mkdirSync(fixtures,{recursive:true});const root=mkdtempSync(join(fixtures,"recovery-")),source=join(root,"source"),state=join(root,"uploader-state"),repo=join(source,"cells","wrapper","repo-space-c1");
  mkdirSync(repo,{recursive:true});mkdirSync(join(dirname(repo),"box"));mkdirSync(state);writeFileSync(join(dirname(repo),"box","cell.json"),'{"version":1,"fixture":true}');
  const git=(args:string[],cwd=repo)=>execFileSync("git",["-c","core.hooksPath=/dev/null",...args],{cwd,encoding:"utf8",env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:"1"},stdio:["ignore","pipe","pipe"]}).trim();
  git(["init","-b","main"]);git(["config","user.name","Fixture"]);git(["config","user.email","fixture@example.invalid"]);
  writeFileSync(join(repo,"tracked"),"base\n");writeFileSync(join(repo,".gitignore"),process.env.HIVE_TEST_EVICTION?"":".audit/\n");git(["add","."]);git(["commit","-m","fixture"]);const base=git(["rev-parse","HEAD"]);
  writeFileSync(join(repo,"tracked"),"staged\n");git(["add","tracked"]);writeFileSync(join(repo,"tracked"),"dirty\n");writeFileSync(join(repo,"untracked"),"unique\n");writeFileSync(join(repo,"executable"),"#!/bin/sh\nexit 0\n");chmodSync(join(repo,"executable"),0o751);symlinkSync("tracked",join(repo,"link"));mkdirSync(join(repo,"empty"));mkdirSync(join(repo,".audit"));
  const a=archive(),archivePath=join(repo,".audit","archive.zst");writeFileSync(archivePath,a.compressed);const object:VerifiedTranscriptObject={sourcePath:archivePath,ref:backupDigest(a.compressed),bytes:a.compressed.length,identity,summary:a.summary};const originalStatus=git(["status","--porcelain=v1"]);
  const core=openCoreStore(join(state,"core.sqlite3")),telemetry=new TelemetryStore(join(state,"telemetry.sqlite3"));const bee=core.createBee({name:"fixture",agent:"stub",cwd:repo,substrate:"cell"}).bee;
  const realOrigin=join(source,"restore-origin");if(process.env.HIVE_TEST_EVICTION)git(["clone",repo,realOrigin]);
  const active=core.putCell({sourceBeeId:bee.id,originRepo:process.env.HIVE_TEST_EVICTION?realOrigin:repo,sha:base,wrapper:"wrapper",spaceName:"repo-space-c1",spaceDir:repo,gitCommonDirRealpath:join(repo,".git"),objectFormat:"sha1"});if(!process.env.HIVE_TEST_EVICTION)core.retainCell(active.id);const cell=core.getCell(active.id)!;
  telemetry.recordI1({messageId:1,beeId:bee.id,detectedAt:100,enqueuedAt:1,deadline:2,detail:"committed fixture WAL"});
  const password=randomBytes(32).toString("hex"),httpPassword=randomBytes(32).toString("hex"),username="fixture";const keys=generateKeyPairSync("ed25519"),publicKey=keys.publicKey.export({type:"spki",format:"der"}).toString("base64"),privateKey=keys.privateKey.export({type:"pkcs8",format:"der"}).toString("base64");
  const serverRoot=join(root,"server");mkdirSync(serverRoot);writeFileSync(join(root,"htpasswd"),username+":{SHA}"+createHash("sha1").update(httpPassword).digest("base64")+"\n",{mode:0o600});
  const listener=createServer();await new Promise<void>(r=>listener.listen(0,"127.0.0.1",r));const port=(listener.address()as{port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
  const server=spawn(restServer!,["--listen",`127.0.0.1:${port}`,"--path",serverRoot,"--htpasswd-file",join(root,"htpasswd"),"--append-only"],{stdio:["ignore","pipe","pipe"]});let serverOutput="";server.stdout.on("data",b=>serverOutput+=b);server.stderr.on("data",b=>serverOutput+=b);
  t.after(()=>{server.kill();core.close();telemetry.close();if(!process.env.HIVE_TEST_KEEP_BACKUP_FIXTURE)rmSync(root,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{await fetch(`http://127.0.0.1:${port}/`);break;}catch{await new Promise(r=>setTimeout(r,20));}}
  const repository=`rest:http://127.0.0.1:${port}/fixture/`,request:BackupRequest={cellId:cell.id,idempotencyKey:"capture",repository,passwordRef:"global/fleet-backup-fixture-repo-key",writerRef:"global/fleet-backup-fixture-writer",maxScratchBytes:64*1024*1024};
  const rest=(args:string[],input?:string)=>execFileSync(restic!,["--repo",repository,"--no-cache",...args],{encoding:"utf8",env:{PATH:process.env.PATH,HOME:root,RESTIC_PASSWORD:password,RESTIC_REST_USERNAME:username,RESTIC_REST_PASSWORD:httpPassword},stdio:[input===undefined?"ignore":"pipe","pipe","pipe"],input});rest(["init"]);
  const op=core.putCellOp({cellId:cell.id,kind:"backup",idempotencyKey:"capture",requestHash:"fixture"});core.updateCellOp(op.id,{status:"running",pid:process.pid});
  let uploaderSigningRequests=0;
  const record=await captureAndSnapshot(request,{cell,runtimeGeneration:process.env.HIVE_TEST_EVICTION?core.currentRuntime(bee.id)?.generation??null:null,machine:"fixture-source",operationId:op.id,scratch:join(state,"capture"),keepRoot:join(source,"cell-keep"),tools:{git:"git",restic:restic!,hem:"unused"},
    child:()=>undefined,save:value=>{core.updateCellOp(op.id,{stdout:JSON.stringify(value)});},
    snapshotDatabases:async(destination,budget,signal)=>{const first=await core.snapshot("fixture",join(destination,"core"),budget,signal);return[first,await telemetry.snapshot(join(destination,"telemetry"),budget-statSync(first.backupPath).size,signal)];},
    resolveSecret:async(ref,field)=>{if(ref.includes("verifier")){uploaderSigningRequests++;throw Error("denied");}return ref.endsWith("-repo-key")?password:field==="username"?username:httpPassword;}});
  core.updateCellOp(op.id,{status:"done",pid:null,stdout:JSON.stringify(record)});assert.equal(record.verification,"not_verified");
  const origin=join(source,"stash-origin.git");git(["clone","--bare",repo,origin]);
  const absent=join(source,"cells","stash-wrapper","stash-space-c2"),keepRoot=join(source,"cell-keep"),stash=join(keepRoot,"stash-space-c2");
  mkdirSync(join(stash,".audit"),{recursive:true});writeFileSync(join(stash,".audit","sole-copy"),"stash only bytes\n");writeFileSync(stash+".json",JSON.stringify({version:1,paths:[".audit"]}));
  const stashBee=core.createBee({name:"stash-fixture",agent:"stub",cwd:absent,substrate:"cell"}).bee;
  const stashActive=core.putCell({sourceBeeId:stashBee.id,originRepo:origin,sha:base,wrapper:"stash-wrapper",spaceName:"stash-space-c2",spaceDir:absent,gitCommonDirRealpath:origin,objectFormat:"sha1"});
  const stashCell=core.evictCell(stashActive.id,{head:base,bytes:0,reason:"disposable_fixture",keptPaths:[".audit"]});
  const stashOp=core.putCellOp({cellId:stashCell.id,kind:"backup",idempotencyKey:"stash",requestHash:"stash"});
  const stashRecord=await captureAndSnapshot({...request,cellId:stashCell.id,idempotencyKey:"stash"},{cell:stashCell,machine:"fixture-source",operationId:stashOp.id,scratch:join(state,"stash-capture"),keepRoot,tools:{git:"git",restic:restic!,hem:"unused"},child:()=>undefined,save:()=>undefined,snapshotDatabases:async()=>[],resolveSecret:async(ref,field)=>ref.endsWith("-repo-key")?password:field==="username"?username:httpPassword});
  const initialData=join(serverRoot,"fixture","data");const initialPacks=readdirSync(initialData).flatMap(name=>readdirSync(join(initialData,name)).map(file=>join(initialData,name,file)));
  if(!process.env.HIVE_TEST_EVICTION){rmSync(source,{recursive:true,force:true});assert.ok(!existsSync(repo),"source unavailable before verifier readback");}
  const access:BackupRepositoryAccess={machine:"fixture-source",repository,passwordRef:request.passwordRef,credentialRef:"global/fleet-backup-fixture-reader"};
  const owner:BackupVerificationOwner={tools:{git:"git",restic:restic!,hem:"unused"},stageRoot:join(root,"verifier-stage"),maxRestoreBytes:64*1024*1024,trustedPublicKey:publicKey,
    resolveSecret:async(ref,field)=>{if(ref.includes("verifier"))throw Error("recovery has no signing grant");return ref.endsWith("-repo-key")?password:field==="username"?username:httpPassword;}};
  writeFileSync(join(evidence,"listing.jsonl"),rest(["ls",record.snapshotId!,"--json"]));
  writeFileSync(join(evidence,"manifest.json"),readFileSync(record.manifestPath));
  const initialReadback=await readBackCapture(record,access,owner,[object]);
  assert.equal(initialReadback.manifest.generation,record.generation);
  await assert.rejects(readBackCapture(record,{...access,credentialRef:request.writerRef},owner),error=>error instanceof BackupVerificationError&&error.code==="authority_denied");
  const badManifest=async(name:string,mutate:(value:typeof initialReadback.manifest)=>void)=>{
    const manifest=structuredClone(initialReadback.manifest);mutate(manifest);manifest.files=manifest.entries.filter(entry=>entry.kind!=="directory").length;manifest.bytes=manifest.entries.reduce((n,entry)=>n+entry.bytes,0);
    const body=JSON.stringify(manifest)+"\n",output=rest(["backup","--json","--stdin","--stdin-filename",record.manifestPath],body);
    const snapshot=output.trim().split("\n").map(line=>JSON.parse(line)).find(row=>row.message_type==="summary").snapshot_id;
    await assert.rejects(readBackCapture({...record,snapshotId:snapshot,manifestHash:backupDigest(body)},access,owner),error=>error instanceof BackupVerificationError&&error.code==="manifest_mismatch",name);
  };
  await badManifest("escaping Cell path",manifest=>{manifest.cell.spaceDir="/../../../tmp/host-write";});
  await badManifest("Git directory symlink",manifest=>{manifest.entries=manifest.entries.filter(entry=>entry.path!==manifest.git.index);manifest.git.index=null;const target=join(root,"outside-stage");manifest.entries.push({path:join(repo,".git"),kind:"symlink",mode:0o777,bytes:Buffer.byteLength(target),sha256:backupDigest(target),target});});
  await badManifest("Cell root symlink",manifest=>{const entry=manifest.entries.find(entry=>entry.path===repo)!;const target=join(root,"outside-stage");Object.assign(entry,{kind:"symlink",target,bytes:Buffer.byteLength(target),sha256:backupDigest(target)});});
  await badManifest("hostile Git config",manifest=>{manifest.entries.push({path:join(repo,".git","config"),kind:"file",mode:0o600,bytes:1,sha256:backupDigest("x")});});
  assert.ok(!existsSync(join(root,"outside-stage")),"hostile metadata never writes outside the private stage");
  // A forged uploader catalogue must not prevent an independent authority publishing its own.
  rest(["backup","--json","--stdin","--stdin-filename","/honeybee-recovery-catalogue-v1.json","--tag","honeybee-recovery-catalogue-v1","--tag","honeybee-recovery-catalogue-v1:"+record.generation],"junk catalogue\n");

  // The verifier is a separate process with its own Hem grant. No private key is written to disk.
  const bin=join(root,"bin");mkdirSync(bin);symlinkSync(restic!,join(bin,"restic"));writeFileSync(join(bin,"hem"),`#!/usr/bin/env node\nconst data=JSON.parse(process.env.VALHALL_HEM_TOKEN);const ref=process.argv[3],field=process.argv[4];const value=ref.includes('wrong')?'wrong-password':ref.includes('verifier')?data.signing:ref.endsWith('-repo-key')?data.repository:field==='username'?data.username:data.http;if(!value)process.exit(2);process.stdout.write(value);\n`,{mode:0o700});
  const config={role:"independent-verifier",access,catalogueAccess:{...access,credentialRef:"global/fleet-backup-fixture-catalogue-writer"},owner:{stageRoot:join(root,"independent-service-stage"),maxRestoreBytes:64*1024*1024,trustedPublicKey:publicKey},authority:{id:"independent-verifier-fixture",signingKeyRef:"global/fleet-backup-verifier-fixture"}};
  const configPath=join(root,"verifier.json"),recordPath=join(root,"record.json"),objectsPath=join(root,"objects.json"),receiptPath=join(root,"receipt.json");writeFileSync(configPath,JSON.stringify(config));writeFileSync(recordPath,JSON.stringify(record));writeFileSync(objectsPath,JSON.stringify([object]));
  const cli=resolve(process.env.HIVE_TEST_BACKUP_VERIFIER??"v2/daemon/src/backupVerifierMain.ts");
  const invoke=(output:string)=>new Promise<string>((accept,reject)=>execFile(process.execPath,[cli,"verify","--config",configPath,"--record",recordPath,"--transcripts",objectsPath,"--output",output],{encoding:"utf8",env:{PATH:bin+":"+process.env.PATH,HOME:root,VALHALL_HEM_TOKEN:JSON.stringify({repository:password,http:httpPassword,username,signing:privateKey})}},(error,stdout,stderr)=>error?reject(Error("independent verifier process failed: "+stderr)):accept(stdout)));
  const processOutput=await Promise.all([invoke(receiptPath),invoke(join(root,"receipt-concurrent.json"))]);

  writeFileSync(recordPath,JSON.stringify(stashRecord));writeFileSync(objectsPath,"[]");const stashReceiptPath=join(root,"stash-receipt.json");await invoke(stashReceiptPath);rmSync(stashReceiptPath);
  const recoveredStash=await restoreFromCatalogue(stashRecord.generation,access,owner),stashTree=await materializeVerifiedCapture(recoveredStash,owner);
  assert.equal(readFileSync(join(stashTree,".audit","sole-copy"),"utf8"),"stash only bytes\n");assert.equal(git(["rev-parse","HEAD"],stashTree),base);git(["fsck","--full"],stashTree);
  const verified=JSON.parse(readFileSync(receiptPath,"utf8")) as {receipt:ReturnType<typeof verifyBackupReceipt>;catalogueSnapshot:string};verifyBackupReceipt(verified.receipt,publicKey);assert.equal(uploaderSigningRequests,0);
  const sequence=core.auditRows().length;core.acceptBackupReceipt(verified.receipt,publicKey);assert.equal(JSON.parse(core.getCellOp(op.id)!.stdout).verification,"verified");const acceptedSequence=core.auditRows().length;assert.ok(acceptedSequence>sequence);core.acceptBackupReceipt(verified.receipt,publicKey);assert.equal(core.auditRows().length,acceptedSequence,"receipt duplicate is quiet");assert.deepEqual(replayAudit(core.auditRows()),core.dumpState());
  const otherKey=generateKeyPairSync("ed25519").publicKey.export({type:"spki",format:"der"}).toString("base64");assert.throws(()=>core.acceptBackupReceipt(verified.receipt,otherKey));assert.throws(()=>verifyBackupReceipt({...verified.receipt,payload:{...verified.receipt.payload,cellId:"changed"}},publicKey));
  if(process.env.HIVE_TEST_B8){
    const {startDaemon}=await import('./helpers.ts');const rpcState=join(root,'owner-restore');mkdirSync(rpcState);const snapshot=await core.snapshot('b8-fixture',join(root,'owner-snapshot'),64*1024*1024);copyFileSync(snapshot.backupPath,join(rpcState,'core.sqlite3'));
    const restoreConfig={access,repositoryId:verified.receipt.payload.repositoryId,maxRestoreBytes:64*1024*1024};writeFileSync(join(rpcState,'backup-restore.json'),JSON.stringify(restoreConfig));writeFileSync(join(rpcState,'backup-trust.json'),JSON.stringify({publicKeys:{[backupVerifierKeyId(publicKey)]:publicKey}}));writeFileSync(join(rpcState,'config.json'),JSON.stringify({cellRetention:{enabled:false}}));
    const alias=join('/tmp','hive-b8-'+randomBytes(10).toString('hex'));symlinkSync(rpcState,alias);t.after(()=>rmSync(alias));const localHome=join(alias,'home');mkdirSync(localHome);mkdirSync(join(alias,'tmp'));const interruptedKey=backupDigest(canonicalBackupJson('interrupted-fixture')),interruptedId='machine:restore:'+interruptedKey,interruptedRoot=join(rpcState,'backup-restores',interruptedKey);mkdirSync(interruptedRoot,{recursive:true,mode:0o700});writeFileSync(join(interruptedRoot,'partial'),'disposable');const seed=openCoreStore(join(rpcState,'core.sqlite3'));seed.putBackupState({format:'honeybee.backup-service.v1',id:interruptedId,role:'machine',kind:'restore',value:{id:interruptedId,requestHash:'fixture',cellId:cell.id,generation:record.generation,status:'running',reason:null,path:null,startedAt:0,finishedAt:null,receiptHash:'',guard:null,stageRoot:interruptedRoot}},0);seed.close();let daemon=await startDaemon(alias,{socketPath:join('/tmp','hive-b8-'+randomBytes(10).toString('hex')+'.sock'),env:{HOME:localHome,TMPDIR:join(alias,'tmp'),PATH:bin+':'+process.env.PATH,VALHALL_HEM_TOKEN:JSON.stringify({repository:password,http:httpPassword,username})}});let client=await daemon.client();
    const request={cellId:cell.id,generation:record.generation,idempotencyKey:'b8-restore'};
    const {BackupRestoreService}=await import('../src/backupRestoreService.ts');const noDisk=new BackupRestoreService({store:core,dataDir:rpcState,tools:owner.tools,now:Date.now,busy:()=>false,freeBytes:async()=>0});assert.equal((await noDisk.restore({...request,idempotencyKey:'no-disk'})).reason,'disk_insufficient');
    try{
      assert.ok(client.capabilities.includes('cell.backup.restore.v1'));const bootStatus=await client.request<{states:{id:string;value:{status:string}}[]}>('backup.service.status',{});assert.equal(bootStatus.states.find(row=>row.id===interruptedId)?.value.status,'outcome_unknown');const pendingRestore=client.request<{status:string;path:string}>('cell.backup.restore',request,120000);let guardObserved=false;for(let attempt=0;attempt<100&&!guardObserved;attempt++){const status=await client.request<{states:{kind:string;value:{guard?:unknown}}[]}>('backup.service.status',{});guardObserved=status.states.some(row=>row.kind==='restore'&&!!row.value.guard);if(!guardObserved)await new Promise(r=>setTimeout(r,10));}assert.ok(guardObserved,'actual readback guard identity reaches durable owner state');const restored=await pendingRestore;assert.equal(restored.status,'restored');assert.ok(!existsSync(interruptedRoot),'background boot cleanup completed before restore');assert.equal(readFileSync(join(restored.path,'tracked'),'utf8'),'dirty\n');assert.equal(git(['status','--porcelain=v1'],restored.path),originalStatus);git(['fsck','--full'],restored.path);assert.ok(!existsSync(repo),'owner restore never recreates or overwrites source');
      assert.deepEqual(await client.request('cell.backup.restore',request),restored);assert.equal((await client.request<{reason:string}>('cell.backup.restore',{...request,generation:'other'})).reason,'idempotency_conflict');
      const payload={format:'honeybee.restore-drill.v1',id:'b8-loopback',machine:record.machine,cellId:cell.id,generation:record.generation,repositoryId:verified.receipt.payload.repositoryId,snapshotId:record.snapshotId!,manifestHash:record.manifestHash,catalogueSnapshotId:verified.catalogueSnapshot,receiptHash:backupDigest(canonicalBackupJson(verified.receipt)),checkedAt:new Date().toISOString(),result:'passed',sourceUnavailable:true,checks:{files:verified.receipt.payload.files,bytes:verified.receipt.payload.bytes,gitFsck:'ok',databases:'ok',manifest:'ok'},evidenceHash:backupDigest(JSON.stringify({gitFsck:true,originalStatus})),verifier:{id:'independent-verifier-fixture',keyId:backupVerifierKeyId(publicKey)}};
      const drill={payload,signature:sign(null,Buffer.from(canonicalBackupJson(payload)),keys.privateKey).toString('base64')};assert.equal((await client.request<{status:string}>('backup.restore.drill.report',{drill})).status,'recorded');assert.equal((await client.request<{status:string}>('backup.restore.drill.report',{drill:{...drill,payload:{...payload,result:'failed'}}})).status,'refused');
      const status=await client.request<{restoreDrills:unknown[]}>('backup.service.status',{});assert.equal(status.restoreDrills.length,1);
      client.close();await daemon.stop();daemon=await startDaemon(alias,{socketPath:join('/tmp','hive-b8-'+randomBytes(10).toString('hex')+'.sock'),env:{HOME:localHome,TMPDIR:join(alias,'tmp'),PATH:bin+':'+process.env.PATH,VALHALL_HEM_TOKEN:JSON.stringify({repository:password,http:httpPassword,username})}});client=await daemon.client();assert.deepEqual(await client.request('cell.backup.restore',request),restored);assert.equal((await client.request<{restoreDrills:unknown[]}>('backup.service.status',{})).restoreDrills.length,1);
      assert.equal((await client.request<{status:string}>('cell.backup.restore',{...request,generation:'missing',idempotencyKey:'missing-capture'},120000)).status,'failed');
      writeFileSync(join(rpcState,'backup-restore.json'),JSON.stringify({...restoreConfig,access:{...access,passwordRef:'global/fleet-backup-wrong-repo-key'}}));assert.equal((await client.request<{status:string}>('cell.backup.restore',{...request,idempotencyKey:'wrong-password'},120000)).status,'failed');writeFileSync(join(rpcState,'backup-restore.json'),JSON.stringify(restoreConfig));
      for(let i=0;i<3;i++)mkdirSync(join(rpcState,'backup-restores','limit-'+i));assert.equal((await client.request<{reason:string}>('cell.backup.restore',{...request,idempotencyKey:'stage-limit'},120000)).reason,'stage_limit');for(let i=0;i<3;i++)rmSync(join(rpcState,'backup-restores','limit-'+i),{recursive:true});assert.equal((await client.request<{status:string}>('cell.backup.restore.dispose',{idempotencyKey:request.idempotencyKey})).status,'disposed');assert.ok(!existsSync(restored.path));assert.equal((await client.request<{reason:string}>('cell.backup.restore',request)).reason,'stage_disposed');
      writeFileSync(join(evidence,'owner-rpc.json'),JSON.stringify({restored:true,stageOnly:true,sourceUnavailable:true,gitFsck:true,dirtyIndexAgrees:true,idempotentAcrossRestart:true,signedDrillDurable:true,tamperedDrillRefused:true,guardIdentityPersisted:true,diskInsufficientRefused:true,stageLimitRefused:true,explicitDisposal:true,wrongPasswordRpcFailsClosed:true,bootInterruptedCleanup:true}));
    }finally{client.close();await daemon.stop();}
  }
  if(process.env.HIVE_TEST_EVICTION){
    const policy={version:1,maxReceiptAgeMs:3600000,capacity:{repository,observedAt:Date.now(),maxAgeMs:3600000,repositoryUsedBytes:0,repositoryLimitBytes:1000000000,fleetUsedBytes:0,fleetLimitBytes:1000000000,stopFraction:0.9}};
    writeFileSync(join(state,"backup.json"),JSON.stringify({repository}));writeFileSync(join(state,"backup-trust.json"),JSON.stringify({publicKeys:{[backupVerifierKeyId(publicKey)]:publicKey}}));
    const policyPath=join(state,"backup-eviction.json");writeFileSync(policyPath,JSON.stringify(policy));
    const deletionOwner:EvictionOwner={store:core,dataDir:state,cellsRoot:join(source,"cells"),keepRoot:join(source,"cell-keep"),machine:"fixture-source",busy:(row,exceptKey)=>core.listPendingCellMutationOps().some(op=>op.cellId===row.id&&op.idempotencyKey!==exceptKey),git:"git",...(process.env.HIVE_TEST_EVICTION_WORKER?{workerUrl:new URL("file://"+resolve(process.env.HIVE_TEST_EVICTION_WORKER))}:{})};
    const goodRecord=JSON.parse(core.getCellOp(op.id)!.stdout) as BackupRecord;
    assert.equal(canonicalBackupJson(JSON.parse(readFileSync(goodRecord.manifestPath,"utf8")).cell),canonicalBackupJson(cell),"capture Cell identity remains current");
    const unchanged=()=>assert.equal(readFileSync(join(repo,"tracked"),"utf8"),"dirty\n");
    writeFileSync(policyPath,JSON.stringify({...policy,pinRequired:true}));
    const pinHeld=await evictThroughOwner(cell,"remove","pin-unavailable",{...deletionOwner,pinRecovery:async()=>{throw Error("fixture authority unavailable");}});assert.equal((pinHeld as {reason:string}).reason,"pin_unavailable");assert.ok(existsSync(repo));writeFileSync(policyPath,JSON.stringify(policy));
    for(const mode of ["evict","remove","trim"] as const){
      core.updateCellOp(op.id,{stdout:JSON.stringify({...goodRecord,verification:"not_verified",receipt:undefined})});assert.equal((await evictThroughOwner(cell,mode,undefined,deletionOwner) as {reason:string}).reason,"receipt_unverified");unchanged();
      core.updateCellOp(op.id,{stdout:JSON.stringify({...goodRecord,receipt:{...verified.receipt,signature:"A".repeat(88)}})});assert.equal((await evictThroughOwner(cell,mode,undefined,deletionOwner) as {reason:string}).reason,"receipt_corrupt");unchanged();
      const payload={...verified.receipt.payload,verifiedAt:new Date(Date.now()-7200000).toISOString()},signature=sign(null,Buffer.from(canonicalBackupJson(payload)),keys.privateKey).toString("base64");
      core.updateCellOp(op.id,{stdout:JSON.stringify({...goodRecord,receipt:{payload,signature}})});assert.equal((await evictThroughOwner(cell,mode,undefined,deletionOwner) as {reason:string}).reason,"receipt_stale");unchanged();
      core.updateCellOp(op.id,{stdout:JSON.stringify(goodRecord)});writeFileSync(policyPath,JSON.stringify({...policy,capacity:{...policy.capacity,fleetUsedBytes:900000000}}));assert.equal((await evictThroughOwner(cell,mode,undefined,deletionOwner) as {reason:string}).reason,"capacity_stop");unchanged();
      writeFileSync(policyPath,"{}");assert.equal((await evictThroughOwner(cell,mode,undefined,deletionOwner) as {reason:string}).reason,"unknown_policy");unchanged();writeFileSync(policyPath,JSON.stringify(policy));
      writeFileSync(join(repo,"changed-after-verification"),"new unique bytes");assert.equal((await evictThroughOwner(cell,mode,undefined,deletionOwner) as {reason:string}).reason,"content_changed");rmSync(join(repo,"changed-after-verification"));unchanged();
      const cancelled=new AbortController();cancelled.abort();assert.equal((await evictThroughOwner(cell,mode,undefined,{...deletionOwner,signal:cancelled.signal}) as {reason:string}).reason,"interrupted");unchanged();
    }
    const deletedSpace=join(source,"cells","deleted-wrapper","deleted-space-c3");mkdirSync(join(source,"cells","deleted-wrapper","box"),{recursive:true});git(["clone",realOrigin,deletedSpace]);writeFileSync(join(source,"cells","deleted-wrapper","box","cell.json"),"{}");writeFileSync(join(deletedSpace,"captured-note"),"survives bee deletion during capture\n");
    const deletedBee=core.createBee({name:"deleted-during-capture",agent:"stub",cwd:deletedSpace,substrate:"cell"}).bee;
    const deletedCell=core.putCell({sourceBeeId:deletedBee.id,originRepo:realOrigin,sha:base,wrapper:"deleted-wrapper",spaceName:"deleted-space-c3",spaceDir:deletedSpace,gitCommonDirRealpath:join(deletedSpace,".git"),objectFormat:"sha1"});
    const deletedOp=core.putCellOp({cellId:deletedCell.id,kind:"backup",idempotencyKey:"delete-during-capture",requestHash:"fixture"});core.updateCellOp(deletedOp.id,{status:"running",pid:process.pid});let deletedDuringCapture=false;
    const deletedRecord=await captureAndSnapshot({...request,cellId:deletedCell.id,idempotencyKey:"delete-during-capture"},{cell:deletedCell,runtimeGeneration:core.currentRuntime(deletedBee.id)?.generation??null,machine:"fixture-source",operationId:deletedOp.id,scratch:join(state,"delete-capture"),keepRoot:join(source,"cell-keep"),tools:{git:"git",restic:restic!,hem:"unused"},child:()=>undefined,snapshotDatabases:async()=>[],resolveSecret:async(ref,field)=>ref.endsWith("-repo-key")?password:field==="username"?username:httpPassword,
      save:value=>{core.updateCellOp(deletedOp.id,{stdout:JSON.stringify(value)});if(value.state==="captured"&&!deletedDuringCapture){core.deleteBee(deletedBee.id);deletedDuringCapture=true;assert.equal(core.getBee(deletedBee.id),null);assert.ok(existsSync(join(deletedSpace,"captured-note")));}}});
    core.updateCellOp(deletedOp.id,{status:"done",pid:null,stdout:JSON.stringify(deletedRecord)});assert.equal(deletedDuringCapture,true);assert.equal(core.getCell(deletedCell.id)!.state,"active");assert.equal((await evictThroughOwner(deletedCell,"remove","before-verify",deletionOwner) as {reason:string}).reason,"receipt_unverified");assert.ok(existsSync(deletedSpace));
    writeFileSync(recordPath,JSON.stringify(deletedRecord));writeFileSync(objectsPath,"[]");const deletedReceiptPath=join(root,"deleted-receipt.json");await invoke(deletedReceiptPath);const deletedReceipt=JSON.parse(readFileSync(deletedReceiptPath,"utf8")).receipt;core.acceptBackupReceipt(deletedReceipt,publicKey);rmSync(deletedReceiptPath);
    assert.equal((await evictThroughOwner(deletedCell,"remove","after-capture-reconciled",deletionOwner)).status,"deleted");assert.equal(core.getCell(deletedCell.id)!.state,"removed");assert.equal(core.getBee(deletedBee.id),null);
    const crashWorker=join(root,"crash-after-authorize.mjs");writeFileSync(crashWorker,`import{parentPort,workerData}from'node:worker_threads';import{performVerifiedEviction}from${JSON.stringify(new URL("../src/verifiedEviction.ts",import.meta.url).href)};parentPort.once('message',()=>performVerifiedEviction(workerData,{afterAuthorization:()=>process.exit(91)}));`);
    const crashed=await evictThroughOwner(cell,"evict","valid-eviction",{...deletionOwner,workerUrl:new URL("file://"+crashWorker)});assert.equal(crashed.status,"refused");assert.equal((crashed as {reason:string}).reason,"outcome_unknown");assert.equal(core.getCell(cell.id)!.state,"active");
    assert.equal((await evictThroughOwner(cell,"evict","new-key-during-uncertainty",deletionOwner) as {reason:string}).reason,"gate_busy");
    core.deleteBee(bee.id);assert.equal(core.getBee(bee.id),null,"bee deletion is immediate during an interrupted owner effect");assert.equal(core.getCell(cell.id)!.state,"active","CellRow remains stable until reconciliation");
    const intent=JSON.parse(core.getCellOp((crashed as {operationId:string}).operationId)!.stdout);assert.ok(existsSync(JSON.parse(readFileSync(intent.input.completionPath,"utf8")).parkedDir),"parked Cell bytes remain intact before reconciliation");
    const deleted=await evictThroughOwner(cell,"evict","valid-eviction",deletionOwner);assert.equal(deleted.status,"deleted");assert.ok(!existsSync(repo));assert.equal(core.getCell(cell.id)!.state,"removed");
    assert.deepEqual(await evictThroughOwner(cell,"evict","valid-eviction",deletionOwner),deleted,"duplicate converges on original effect");
    rmSync(source,{recursive:true,force:true});
  }
  core.close();telemetry.close();rmSync(state,{recursive:true,force:true});rmSync(recordPath);rmSync(objectsPath);rmSync(receiptPath);rmSync(join(root,"receipt-concurrent.json"));rmSync(configPath);assert.ok(!existsSync(state),"uploader DB, local draft and local manifest removed before recovery");
  const catalogue=await discoverRecoveryCatalogue(record.generation,access,owner);assert.equal(catalogue.receipt.payload.repositoryId,verified.receipt.payload.repositoryId);
  const recovered=await restoreFromCatalogue(record.generation,access,owner),worktree=await materializeVerifiedCapture(recovered,owner);
  assert.equal(readFileSync(join(worktree,"tracked"),"utf8"),"dirty\n");assert.equal(readFileSync(join(worktree,"untracked"),"utf8"),"unique\n");assert.equal(statSync(join(worktree,"executable")).mode&0o7777,0o751);assert.equal(readlinkSync(join(worktree,"link")),"tracked");assert.ok(existsSync(join(worktree,"empty")));assert.equal(git(["status","--porcelain=v1"],worktree),originalStatus);git(["fsck","--full"],worktree);
  await assert.rejects(handoffTranscriptStage(recovered,catalogue.receipt,object.ref,owner),error=>error instanceof BackupVerificationError&&error.code==="owner_unavailable");
  const acknowledgement=await handoffTranscriptStage(recovered,catalogue.receipt,object.ref,owner,async stage=>{assert.equal(readFileSync(stage.decodedPath,"utf8"),a.raw);assert.equal(backupDigest(readFileSync(stage.compressedPath)),object.ref);return{accepted:true,ownerNodeId:identity.nodeId,objectRef:object.ref,receiptId:"fixture-owner-accepted"};});assert.equal(acknowledgement.receiptId,"fixture-owner-accepted");
  const badOwner={...owner,resolveSecret:async(ref:string,field:string)=>ref.endsWith("-repo-key")?"wrong-password":field==="username"?username:httpPassword};await assert.rejects(discoverRecoveryCatalogue(record.generation,access,badOwner));
  await assert.rejects(readBackCapture({...record,snapshotId:"f".repeat(64)},access,owner));await assert.rejects(readBackCapture({...record,manifestHash:"0".repeat(64)},access,owner));
  let signingRequested=false;await assert.rejects(signVerifiedCapture({...recovered,record:{...recovered.record,manifestHash:"0".repeat(64)}},config.authority,{...owner,resolveSecret:async()=>{signingRequested=true;return privateKey;}}));assert.equal(signingRequested,false,"unproven stage cannot request signing authority");
  // Corrupt disposable server ciphertext directly, then require decrypt/readback to fail closed.
  const packBytes=initialPacks.map(path=>({path,bytes:readFileSync(path)}));for(const item of packBytes){const damaged=Buffer.from(item.bytes);damaged[Math.floor(damaged.length/2)]!^=1;writeFileSync(item.path,damaged);}await assert.rejects(restoreFromCatalogue(record.generation,access,owner));for(const item of packBytes)writeFileSync(item.path,item.bytes);
  const diagnostics=JSON.stringify({processOutput,serverOutput,record,catalogue,acknowledgement});for(const value of[password,httpPassword,privateKey])assert.equal(diagnostics.includes(value),false,"fixture credentials/signing material absent from diagnostics and catalogue plaintext");
  const proof={result:"PASS",verifiedEvictionBeforeRecovery:!!process.env.HIVE_TEST_EVICTION,immediateBeeDeletionDuringCaptureAndInterruptedEviction:!!process.env.HIVE_TEST_EVICTION,sourceUnavailableBeforeVerification:!process.env.HIVE_TEST_EVICTION,sourceDatabaseAndDraftUnavailableBeforeRecovery:true,independentVerifierProcess:true,uploaderSigningRequests,repositoryOnlyRecovery:true,stashOnlyRecoveryWithoutOrigin:true, hostileGitAndEscapingPathsRejected:true, concurrentVerifiersConverge:true, forgedCatalogueDoesNotBlock:true, writerGrantRefused:true,fullRemoteFileReadback:true,sqliteIntegrity:true,gitFsck:true,indexAndDirtyBytesAgree:true,signedReceiptVerified:true,receiptReplayQuiet:true,compressedAndDecodedTranscriptValidated:true,ownerHandoffAccepted:true,missingOwnerFailsClosed:true,wrongPasswordMissingSnapshotCorruptionFailClosed:true,signingKeyAbsentFromDiagnostics:true,catalogueSnapshot:verified.catalogueSnapshot,generation:record.generation,verifierKeyId:backupVerifierKeyId(publicKey)};
  writeFileSync(join(evidence,"end-to-end.json"),JSON.stringify(proof,null,2)+"\n");console.log("PASS: source unavailable; repository+encrypted catalogue recovery; independent signed receipt; Git/SQLite and transcript validation; negative cases fail closed; fixture credentials absent from diagnostics");
});
