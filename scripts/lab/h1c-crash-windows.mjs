import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {openCoreStore,replayAudit,DeliveryNotHeldError} from '../../v2/core/src/index.ts';
import {DaemonCore} from '../../v2/daemon/src/loops.ts';
import {HsrDriver} from '../../v2/driver-hsr/src/index.ts';
import {codexAdapter} from '../../v2/adapters/src/index.ts';
import {fixtureRuntimeIdentity,persistFixtureProcess,sleep,pidAlive} from '../../v2/driver-hsr/tests/helpers.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'),'set an owned TMPDIR');
const root=mkdtempSync(join(process.env.TMPDIR,'h1c-crash-'));
const fake=new URL('./h1c-fake-codex.mjs',import.meta.url).pathname;
const policy={bootHangTimeoutSteps:500_000,commandsPerStep:8,i1DeadlineSteps:540_000};
for(const window of ['before-intent-commit','after-intent-before-write','after-write-before-ack','after-ack-before-settlement','after-settlement','unknown-held','held-not-written-resume','steer-intent-before-write','degraded-not-written','lane-outage-before-intent','status-unreadable-at-connect']){
 const path=join(root,window+'.sqlite');const writes=join(root,window+'.writes');let clock=Date.now();let store=openCoreStore(path,{now:()=>clock});
 const config={sessionLogDir:join(root,window),runnersDir:join(root,window,'runners'),runtimeIdentity:fixtureRuntimeIdentity(root+window),resolve:()=>({adapter:codexAdapter({cwd:root}),command:process.execPath,args:[fake],cwd:root,env:{...process.env,H1C_WRITES:writes,H1C_ACK:window==='unknown-held'?'never':'yes',H1C_ACK_DELAY_MS:window==='after-write-before-ack'?'300':'0'}})};
 let driver=new HsrDriver(config);let core;let pid;
 const makeCore=()=>new DaemonCore({store,driver,now:()=>clock,random:()=>0.5,policy,log:()=>{}});
 const tick=async()=>{clock+=200;core.step();await sleep(5);};
 const until=async predicate=>{for(let i=0;i<2000&&!predicate();i++)await tick();assert(predicate(),window+' timed out');};
 const restart=()=>{
  const p=driver.procs.get('bee');const rt=store.currentRuntime('bee');
  persistFixtureProcess(root+window,'bee',1,driver.procOf('bee',1));driver.detachAll();store.close();
  store=openCoreStore(path,{now:()=>clock});driver=new HsrDriver(config);
  assert(driver.adopt('bee',1,p.pid,p.pidStartedAt,rt.state,store.runtimeObservationCursor('bee',1),store.getBee('bee').providerSessionId));
  core=makeCore();core.boot();
 };
 try{
  core=makeCore();core.boot();store.createBee({id:'bee',name:'owned-h1c',agent:'codex',substrate:'hsr',cwd:root});store.enqueueCommand('spawn','bee');
  await until(()=>store.currentRuntime('bee')?.state==='idle'&&driver.procs.get('bee')?.deliveryProtocol?.authenticated);pid=driver.procs.get('bee').pid;
  if(window==='steer-intent-before-write'){
   driver.deliver('bee',1,24679,'owned starter');
   for(let i=0;i<100&&!driver.procs.get('bee').turnId;i++){core.observe();await sleep(2);}
   assert.equal(driver.procs.get('bee').phase,'running');assert(driver.procs.get('bee').turnId);
  }
  const message=store.send('bee','owned crash-window fixture').message;
  if(window==='lane-outage-before-intent'){
   const p=driver.procs.get('bee');p.socketBroken=true;clock+=60_000;
   for(let i=0;i<10;i++)await tick();assert.equal(store.getDeliveryConfirmationIntent(message.id),null);assert.equal(existsSync(writes),false);
   p.socketBroken=false;
  }
  if(window==='status-unreadable-at-connect'){
   const p=driver.procs.get('bee');const status=readFileSync(p.statusPath,'utf8');writeFileSync(p.statusPath,'{');p.socket.destroy();
   for(let i=0;i<200&&!p.socket?.writable;i++){driver.observe();await sleep(5);}
   assert.equal(p.deliveryProtocol.supported,false);assert.equal(p.deliveryProtocol.legacy,false);
   for(let i=0;i<10;i++)await tick();assert.equal(store.getDeliveryConfirmationIntent(message.id),null);assert.equal(existsSync(writes),false);
   writeFileSync(p.statusPath,status);
  }
  if(window==='before-intent-commit'){
   const prepare=store.prepareDeliveryConfirmationIntent.bind(store);store.prepareDeliveryConfirmationIntent=input=>store.transact(()=>{prepare(input);throw Error('injected-before-commit');});
   assert.throws(()=>core.step(),/injected-before-commit/);assert.equal(store.getDeliveryConfirmationIntent(message.id),null);assert.equal(existsSync(writes),false);
   store.prepareDeliveryConfirmationIntent=prepare;
  }
  if(['after-intent-before-write','after-write-before-ack','held-not-written-resume','steer-intent-before-write','degraded-not-written'].includes(window)){
   const deliver=driver.deliver.bind(driver);driver.deliver=(...args)=>{if(window==='after-write-before-ack')deliver(...args);throw Error('injected-after-intent');};
   assert.throws(()=>core.step(),/injected-after-intent/);assert(store.getDeliveryConfirmationIntent(message.id));
   if(window==='held-not-written-resume')store.holdDeliveryConfirmation(message.id,'unknown');
   if(window==='steer-intent-before-write'){
    assert.equal(JSON.parse(store.getDeliveryConfirmationIntent(message.id).wireLine).method,'turn/steer');
    for(let i=0;i<100&&driver.procs.get('bee').phase!=='idle';i++){core.observe();await sleep(5);}
    assert.equal(driver.procs.get('bee').phase,'idle');
   }
   if(window==='degraded-not-written'){
    const p=driver.procs.get('bee');const status=JSON.parse(readFileSync(p.statusPath,'utf8'));status.observationError='owned injected journal failure';writeFileSync(p.statusPath,JSON.stringify(status));
   }
   restart();
   if(window==='degraded-not-written'){
    assert.equal(driver.isDegraded('bee',1),true);assert.equal(driver.procs.get('bee').hostStyle,true);assert.equal(driver.procs.get('bee').adapter,null);
   }
   if(window==='held-not-written-resume'){
    const deliver=driver.deliver.bind(driver);driver.deliver=(...args)=>{
     if(args[4]?.confirmation)assert.throws(()=>store.resolveDeliveryConfirmation({action:'resend_anyway',beeId:'bee',messageId:message.id,generation:1,idempotencyKey:'stale-held-ui'}),DeliveryNotHeldError);
     return deliver(...args);
    };
   }
  }
  if(window==='after-ack-before-settlement'){
   const mark=store.markDelivered.bind(store);store.markDelivered=(...args)=>store.transact(()=>{mark(...args);throw Error('injected-before-settlement-commit');});
   let crashed=false;for(let i=0;i<1000&&!crashed;i++){try{await tick();}catch(error){assert.match(error.message,/injected-before-settlement-commit/);crashed=true;}}
   assert(crashed);assert.equal(store.getMessage(message.id).deliveredAt,null);restart();
  }
  if(window==='unknown-held'){
   await until(()=>store.getMessage(message.id)?.deliveryConfirmation?.state==='held');
   assert.equal(store.getMessage(message.id).deliveredAt,null);assert.equal(store.view('bee').waitingForYou,true);
   restart();for(let i=0;i<200;i++)await tick();assert.equal(store.getMessage(message.id).deliveredAt,null);
   const receipt=store.resolveDeliveryConfirmation({action:'drop',beeId:'bee',messageId:message.id,generation:1,idempotencyKey:'lab-drop'});
   assert.equal(receipt.replacementMessageId,null);assert.equal(store.getMessage(message.id),null);
  }else{
   await until(()=>store.getMessage(message.id)?.deliveredAt!=null);
   if(window==='after-settlement'){restart();for(let i=0;i<30;i++)await tick();}
   assert.equal(store.getDeliveryConfirmationIntent(message.id),null);
  }
  const rows=readFileSync(writes,'utf8').trim().split('\n').map(JSON.parse);const target=rows.filter(row=>row.id===1000+message.id);assert.equal(target.length,1);
  if(window==='steer-intent-before-write')assert.equal(target[0].method,'turn/start');
  if(window==='degraded-not-written'){assert.equal(store.getMessage(message.id).deliveredGeneration,2);pid=driver.procs.get('bee').pid;}
  assert.deepEqual(replayAudit(store.auditRows()),store.dumpState());assert.equal(store.quickCheck().ok,true);
  console.log(JSON.stringify({case:window,stdinWrites:target.length,delivered:window!=='unknown-held',restart:!['before-intent-commit','lane-outage-before-intent','status-unreadable-at-connect'].includes(window),integrity:'ok',root}));
 }finally{driver.disposeAll();for(let i=0;i<500&&pid&&pidAlive(pid);i++)await sleep(10);store.close();if(pid)assert.equal(pidAlive(pid),false);}
}
