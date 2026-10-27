import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {openCoreStore,replayAudit} from '../../core/src/index.ts';
import {backupCapacityBand,planBackupRetention} from '../../core/src/backupService.ts';
import {DEFAULT_BACKUP_RETENTION} from '../src/backupServiceConfig.ts';
test('approved retention is configurable and uses server arrivals and signed Cell identity, preserving sole copies',()=>{
 const repository='fixture',now=Date.UTC(2026,9,27),history=Array.from({length:100},(_,i)=>({repository,repositoryId:'r',snapshotId:String(i),catalogueSnapshotId:'cat'+i,cellId:'same-cell',generation:String(i),receiptHash:'h',verifiedAt:0,registeredAt:now-i*3600000})),arrivals=history.map((h,i)=>({repository,snapshotId:h.snapshotId,firstSeenAt:now-i*3600000,bytes:1,present:true}));
 const pins=[{id:'pin',repository,snapshotId:'99',kind:'cell' as const,reference:'evicted-cell',generation:'99',createdAt:0}];
 const plan=planBackupRetention(repository,{history,arrivals,pins},{...DEFAULT_BACKUP_RETENTION,quarantineMs:0,maxReceiptAgeMs:0},now);
 assert.ok(plan.keep.includes('99'));assert.ok(plan.forget.length>0);assert.ok(!plan.forget.includes('99'));assert.equal(DEFAULT_BACKUP_RETENTION.hourly,48);assert.equal(DEFAULT_BACKUP_RETENTION.daily,30);assert.equal(DEFAULT_BACKUP_RETENTION.weekly,12);assert.equal(DEFAULT_BACKUP_RETENTION.monthly,12);
 const unknown=planBackupRetention(repository,{history:[],arrivals:[arrivals[0]!],pins:[]},{...DEFAULT_BACKUP_RETENTION},now);assert.deepEqual(unknown.forget,[]);assert.deepEqual(unknown.unknown,['0']);
});
test('capacity uses exact approved 70/80/90 percent stop thresholds per machine and fleet',()=>{for(const [bytes,band]of[[16799999999999,'normal'],[16800000000000,'warn'],[19200000000000,'review'],[21600000000000,'stop']]as const)assert.equal(backupCapacityBand(bytes,24000000000000),band);assert.equal(backupCapacityBand(90,100),'stop');assert.equal(backupCapacityBand(-1,100),'unknown');});
test('service facts are CAS fenced, replayed and remain durable across reopen',()=>{
 const root=mkdtempSync(resolve('.audit/backup-b6/state-')),path=join(root,'core.sqlite3');let store=openCoreStore(path);try{
  const state={format:'honeybee.backup-service.v1' as const,id:'authority:lease',role:'authority' as const,kind:'lease' as const,value:{lease:null,counter:1}};
  store.putBackupState(state,0);assert.throws(()=>store.putBackupState({...state,value:{lease:null,counter:2}},0));const dump=store.dumpState();assert.deepEqual(replayAudit(store.auditRows()).backupService,dump.backupService);store.close();store=openCoreStore(path);assert.equal(store.backupState('authority:lease','lease','authority')?.value.counter,1);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('versioned owner action is classified mutate and bare capture cannot bypass configured service',async()=>{
 const {makeDaemonDir,startDaemon}=await import('./helpers.ts');const {writeFileSync}=await import('node:fs');const root=makeDaemonDir();const daemon=await startDaemon(root.dir);const client=await daemon.client();try{
  assert.deepEqual(await client.request('backup.service.run',{}),{status:'refused',reason:'invalid_config'});
  writeFileSync(join(root.dir,'backup-service.json'),'{}');assert.deepEqual(await client.request('cell.backup',{cellId:'fixture',idempotencyKey:'caller-key'}),{status:'refused',reason:'service_required'});
 }finally{client.close();await daemon.stop();root.cleanup();}
});
test('failed protected keys and done verified rows cannot starve a new scheduled period',async()=>{
 const {BackupMachineService}=await import('../src/backupMachineService.ts');const {BackupFacts,serviceHash}=await import('../src/backupServiceSupport.ts');const {generateKeyPairSync}=await import('node:crypto');const root=mkdtempSync(resolve('.audit/backup-b6/poison-')),store=openCoreStore(join(root,'core.sqlite3'));
 try{
  const bee=store.createBee({name:'fixture',agent:'stub',cwd:root,substrate:'cell'}).bee,cell=store.putCell({sourceBeeId:bee.id,originRepo:root,sha:'a'.repeat(40),wrapper:'fixture',spaceName:'fixture-space-c1',spaceDir:root,gitCommonDirRealpath:root,objectFormat:'sha1'}),repository='rest:http://127.0.0.1:1/fixture/';
  let clock=1000;const owner={store,dataDir:root,now:()=>clock,tools:{git:'unused',restic:'unused',hem:'unused'},resolveSecret:async()=> 'fixture-token',capture:async()=>{throw Error('must not capture without admission');}};const facts=new BackupFacts(owner,'machine');
  const op=store.putCellOp({cellId:cell.id,kind:'backup',idempotencyKey:'poison',requestHash:'fixture'});store.updateCellOp(op.id,{status:'done',stdout:JSON.stringify({repository,state:'snapshot_created',verification:'not_verified'})});
  facts.put('machine:job:failed','job',{id:'failed',repository,cellId:cell.id,period:-1,operationKey:'poison',state:'failed',attempt:8,startedAt:0,updatedAt:0,retryAt:0,reason:'job_failed',snapshotId:null,generation:null,leaseId:null,leaseCounter:null});
  const verified=store.putCellOp({cellId:cell.id,kind:'backup',idempotencyKey:'verified',requestHash:'fixture'});store.updateCellOp(verified.id,{status:'done',failure:'interrupted',stdout:JSON.stringify({repository,state:'snapshot_created',verification:'verified'})});
  const config={version:1 as const,role:'machine' as const,machine:'fixture',repository,authorityUrl:'http://127.0.0.1:1',authorityRef:'global/fleet-backup-fixture-service',grantPublicKey:generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64'),verifierUrl:'http://127.0.0.1:1',verifierRef:'global/fleet-backup-fixture-verify',targets:[{cellId:cell.id,periodMs:1000,jitterMs:0}],mail:{host:'127.0.0.1',port:1,secure:false,recipientRef:'global/fleet-backup-alert-fixture',credentialRef:'global/fleet-backup-mail-fixture'},maxReceiptAgeMs:1000,observationMaxAgeMs:1000,maxAttempts:1};
  const result=await new BackupMachineService(config,owner).run()as{status:string;jobId:string};assert.equal(result.status,'retry_wait');assert.notEqual(result.jobId,'failed');const scheduled=facts.get('machine:job:'+serviceHash({repository,cellId:cell.id,period:1}),'job');assert.equal(scheduled?.attempt,0);assert.equal(scheduled?.state,'retry_wait');assert.ok(scheduled?.operationKey.startsWith('backup-service:'));const machine=new BackupMachineService(config,owner);for(let i=0;i<10;i++){clock+=7200000;assert.equal((await machine.run()as{status:string}).status,'retry_wait');}const deferred=facts.get('machine:job:'+scheduled!.id,'job');assert.equal(deferred?.attempt,0);assert.ok((deferred?.deferrals??0)>8,'authority contention/outage does not exhaust effect attempts');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('a live Cell defers locally before taking the fleet slot and skips superseded busy periods',async()=>{
 const {createServer}=await import('node:http');const {writeFileSync}=await import('node:fs');const {BackupMachineService}=await import('../src/backupMachineService.ts');const {BackupFacts}=await import('../src/backupServiceSupport.ts');const root=mkdtempSync(resolve('.audit/backup-b6/preflight-')),store=openCoreStore(join(root,'core.sqlite3'));let now=3600000,uploads=0,band='normal';const repository='rest:http://127.0.0.1:1/fixture/';
 const server=createServer((req,res)=>{if(req.url==='/v1/upload')uploads++;req.resume();res.setHeader('content-type','application/json');res.end(JSON.stringify({observations:[{repository,repositoryId:null,observedAt:now,repositoryBytes:1,repositoryLimitBytes:100,fleetBytes:1,fleetLimitBytes:100,reserveBytes:1,reserveLimitBytes:100,band}]}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try{
  writeFileSync(join(root,'backup-eviction.json'),JSON.stringify({version:1,maxReceiptAgeMs:1000}));const owner={store,dataDir:root,now:()=>now,tools:{git:'unused',restic:'unused',hem:'unused'},resolveSecret:async()=> 'fixture-token',canCapture:()=>false,capture:async()=>{throw Error('live Cell must not capture');}};
  const machine=new BackupMachineService({version:1,role:'machine',machine:'fixture',repository,authorityUrl:'http://127.0.0.1:'+(server.address()as{port:number}).port,authorityRef:'global/fleet-backup-fixture-service',grantPublicKey:'unused',verifierUrl:'http://127.0.0.1:1',verifierRef:'global/fleet-backup-fixture-verify',targets:[{cellId:'live-cell',periodMs:3600000,jitterMs:0}],mail:{host:'127.0.0.1',port:1,secure:false,recipientRef:'global/fleet-backup-alert-fixture',credentialRef:'global/fleet-backup-mail-fixture'},maxReceiptAgeMs:1000,observationMaxAgeMs:1000},owner);
  assert.equal((await machine.run()as{status:string}).status,'retry_wait');now+=3600001;assert.equal((await machine.run()as{status:string}).status,'skipped_busy');assert.equal(uploads,0);assert.equal(new BackupFacts(owner,'machine').rows('machine:job:','job')[0]?.attempt,0);band='unknown';await machine.run();const {readFileSync}=await import('node:fs'),{checkEvictionPolicy,VerifiedEvictionError}=await import('../src/verifiedEviction.ts');assert.throws(()=>checkEvictionPolicy(JSON.parse(readFileSync(join(root,'backup-eviction.json'),'utf8')),repository,now),error=>error instanceof VerifiedEvictionError&&error.reason==='capacity_stop','fresh invalidated capacity must stop B4 too');
 }finally{await new Promise<void>(r=>server.close(()=>r()));store.close();rmSync(root,{recursive:true,force:true});}
});
