import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {openCoreStore,replayAudit} from '../../v2/core/src/index.ts';
import {DaemonCore} from '../../v2/daemon/src/loops.ts';
import {HsrDriver} from '../../v2/driver-hsr/src/index.ts';
import {codexAdapter} from '../../v2/adapters/src/index.ts';
import {fixtureRuntimeIdentity,persistFixtureProcess,sleep,pidAlive} from '../../v2/driver-hsr/tests/helpers.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'),'set an owned TMPDIR');
const root=mkdtempSync(join(process.env.TMPDIR,'h1c-crash-'));
const fake=new URL('./h1c-fake-codex.mjs',import.meta.url).pathname;
const policy={bootHangTimeoutSteps:500_000,commandsPerStep:8,i1DeadlineSteps:540_000};
for(const window of ['before-intent-commit','after-intent-before-write','after-write-before-ack','after-ack-before-settlement','after-settlement','unknown-held']){
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
  const message=store.send('bee','owned crash-window fixture').message;
  if(window==='before-intent-commit'){
   const prepare=store.prepareDeliveryConfirmationIntent.bind(store);store.prepareDeliveryConfirmationIntent=input=>store.transact(()=>{prepare(input);throw Error('injected-before-commit');});
   assert.throws(()=>core.step(),/injected-before-commit/);assert.equal(store.getDeliveryConfirmationIntent(message.id),null);assert.equal(existsSync(writes),false);
   store.prepareDeliveryConfirmationIntent=prepare;
  }
  if(window==='after-intent-before-write'||window==='after-write-before-ack'){
   const deliver=driver.deliver.bind(driver);driver.deliver=(...args)=>{if(window==='after-write-before-ack')deliver(...args);throw Error('injected-after-intent');};
   assert.throws(()=>core.step(),/injected-after-intent/);assert(store.getDeliveryConfirmationIntent(message.id));
   restart();
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
   await until(()=>store.getMessage(message.id)?.deliveredAt!==null);
   if(window==='after-settlement'){restart();for(let i=0;i<30;i++)await tick();}
   assert.equal(store.getDeliveryConfirmationIntent(message.id),null);
  }
  const rows=readFileSync(writes,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.length,1);
  assert.deepEqual(replayAudit(store.auditRows()),store.dumpState());assert.equal(store.quickCheck().ok,true);
  console.log(JSON.stringify({case:window,stdinWrites:rows.length,delivered:window!=='unknown-held',restart:!['before-intent-commit'].includes(window),integrity:'ok',root}));
 }finally{driver.disposeAll();for(let i=0;i<500&&pid&&pidAlive(pid);i++)await sleep(10);store.close();if(pid)assert.equal(pidAlive(pid),false);}
}
