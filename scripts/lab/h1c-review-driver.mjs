import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,existsSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {openCoreStore,replayAudit} from '../../v2/core/src/index.ts';
import {DaemonCore} from '../../v2/daemon/src/loops.ts';
import {DeliveryFiles} from '../../v2/daemon/src/deliveryFile.ts';
import {MultilineFallback} from '../../v2/daemon/src/multilineFallback.ts';
import {HsrDriver} from '../../v2/driver-hsr/src/index.ts';
import {codexAdapter} from '../../v2/adapters/src/index.ts';
import {fixtureRuntimeIdentity,sleep,pidAlive} from '../../v2/driver-hsr/tests/helpers.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'));
const root=mkdtempSync(join(process.env.TMPDIR,'h1c-review-'));
const fake=new URL('./h1c-fake-codex.mjs',import.meta.url).pathname;
const maskFake=new URL('./h1c-child-umask.mjs',import.meta.url).pathname;
for(const mode of ['child-umask','steer-refused','deterministic-refusal','oversize-confirming','oversize-nonconfirming','multiline-intent','captured-settlement','unknown-pointer-same-generation','unknown-pointer-old-generation'].filter(mode=>process.argv.length===2||process.argv.slice(2).includes(mode))){
 const dir=join(root,mode);let clock=Date.now();const writes=dir+'.writes';
 const work=join(root,'work-'+mode);mkdirSync(work,{mode:0o700});
 const store=openCoreStore(dir+'.sqlite',{now:()=>clock});
 const adapter=codexAdapter({cwd:work});if(mode==='oversize-nonconfirming')adapter.confirmsDelivery=false;
 const driver=new HsrDriver({now:()=>clock,random:()=>0.5,sessionLogDir:dir,runnersDir:join(dir,'runners'),runtimeIdentity:fixtureRuntimeIdentity(dir),resolve:()=>({adapter,command:process.execPath,args:[mode==='child-umask'?maskFake:fake],cwd:work,env:{...process.env,H1C_WRITES:writes,...(mode==='child-umask'?{H1C_MASK_PROBE:root}:{}),...(mode==='steer-refused'?{H1C_REFUSE_STEER:'yes',H1C_TURN_MS:'1000'}:{}),...(mode==='deterministic-refusal'?{H1C_REFUSE_ALL:'yes'}:{}),...(mode.startsWith('unknown-pointer')?{H1C_ACK:'never'}:{})}})});
 const deliveryRoot=join(root,'delivery-'+mode);mkdirSync(deliveryRoot,{mode:0o700});
 const core=new DaemonCore({store,driver,now:()=>clock,random:()=>0.5,policy:{bootHangTimeoutSteps:500_000,commandsPerStep:8,i1DeadlineSteps:540_000},multilineFallback:{root:deliveryRoot,worktrees:()=>[work],files:new DeliveryFiles(undefined,root)},log:()=>{}});let pid;
 const tick=async()=>{clock+=100;core.step();await sleep(5);};
 const until=async fn=>{for(let i=0;i<2000&&!fn();i++)await tick();assert(fn(),mode+' timed out');};
 try{
  core.boot();store.createBee({id:'bee',name:'owned-review',agent:'codex',substrate:'hsr',cwd:work});store.enqueueCommand('spawn','bee');
  const mask=process.umask(0o002);try{core.step();}finally{process.umask(mask);}
  await until(()=>store.currentRuntime('bee')?.state==='idle'&&driver.deliveryLaneReady('bee',1)&&driver.procs.get('bee').sessionId);pid=driver.procs.get('bee').pid;
  if(mode==='child-umask'){
   const facts=JSON.parse(readFileSync(join(root,'child-mask.json'),'utf8'));assert.deepEqual(facts,{mask:0o002,file:0o664,directory:0o775});
   const socket=driver.procs.get('bee').socketPath;assert.equal(statSync(dirname(socket)).mode&0o777,0o700);assert.equal(statSync(socket).mode&0o777,0o600);
   console.log(JSON.stringify({case:mode,...facts,socketDirectory:448,socketMode:384}));continue;
  }
  if(mode==='steer-refused'){
   driver.deliver('bee',1,24679,'owned starter');
   for(let i=0;i<500&&!driver.procs.get('bee').turnId;i++){clock+=100;core.observe();await sleep(2);}assert(driver.procs.get('bee').turnId);
  }
  const message=store.send('bee',mode.startsWith('oversize')?'x'.repeat(16_777_216):'owned clean refusal').message;
  if(mode.startsWith('unknown-pointer')){
   for(let i=0;i<3;i++)store.recordMultilineDeliveryRefusal(message.id,1,'multiline_type_mode');
   const plan=driver.planDeliveryConfirmation.bind(driver);driver.planDeliveryConfirmation=()=>null;
   const oldFallback=new MultilineFallback(store,driver,{root:deliveryRoot,worktrees:()=>[work],files:new DeliveryFiles(undefined,root)});
   try{oldFallback.deliver(message,message.body,1,false,null,{kind:'human'});}finally{driver.planDeliveryConfirmation=plan;}
   assert.equal(store.getDeliveryConfirmationIntent(message.id),null);assert.equal(store.multilineDelivery(message.id).fallback.state,'in_flight');
   for(let i=0;i<500&&!existsSync(writes);i++)await sleep(5);assert(existsSync(writes));
   if(mode==='unknown-pointer-old-generation'){
    driver.disposeAll();for(let i=0;i<500&&pidAlive(pid);i++)await sleep(5);assert.equal(pidAlive(pid),false);
    store.updateRuntimeState('bee',1,'stopped',{exitCause:'crashed'});store.reviveBee('bee');store.enqueueCommand('spawn','bee');
    await until(()=>store.currentRuntime('bee')?.generation===2&&driver.deliveryLaneReady('bee',2));pid=driver.procs.get('bee').pid;
   }
   await until(()=>store.getMessage(message.id)?.deliveryConfirmation?.state==='held');for(let i=0;i<50;i++)await tick();
   assert.equal(store.getDeliveryConfirmationIntent(message.id).wireLine,null);assert.equal(store.getMessage(message.id).deliveredAt,null);assert.equal(readFileSync(writes,'utf8').trim().split('\n').length,1);
   console.log(JSON.stringify({case:mode,originalPointerWrites:1,newPointerWrites:0,heldReason:store.getMessage(message.id).deliveryConfirmation.reason,originalGeneration:1,currentGeneration:store.currentRuntime('bee').generation}));continue;
  }
  if(mode==='deterministic-refusal'){
   await until(()=>store.getMessage(message.id)?.deliveryConfirmation?.reason==='refused');
   for(let i=0;i<200;i++)await tick();
   assert.equal(readFileSync(writes,'utf8').trim().split('\n').length,2);assert.equal(store.getDeliveryConfirmationIntent(message.id).refusalRetries,1);assert.equal(store.view('bee').waitingForYou,true);
   console.log(JSON.stringify({case:mode,stdinWrites:2,automaticRetries:1,heldReason:'refused',visible:true}));continue;
  }
  if(mode==='multiline-intent'){
   for(let i=0;i<3;i++)store.recordMultilineDeliveryRefusal(message.id,1,'multiline_type_mode');
   const deliver=driver.deliver.bind(driver);driver.deliver=(...args)=>{assert(args[4]?.confirmation);assert(store.getDeliveryConfirmationIntent(message.id));throw Error('owned interruption before pointer write');};
   assert.throws(()=>core.step(),/owned interruption before pointer write/);driver.deliver=deliver;
   assert(store.getDeliveryConfirmationIntent(message.id).settlement.multilineFallbackId);assert.equal(existsSync(writes),false);
   await until(()=>store.getMessage(message.id)?.deliveredAt!==null);
   assert.equal(store.multilineDelivery(message.id).fallback.state,'delivered');assert.equal(store.getDeliveryConfirmationIntent(message.id),null);
   assert.equal(readFileSync(writes,'utf8').trim().split('\n').length,1);
   console.log(JSON.stringify({case:mode,intentCommittedBeforePointerWrite:true,stdinWrites:1,fallbackSettled:true}));continue;
  }
  if(mode==='captured-settlement'){
   core.step();const intent=store.getDeliveryConfirmationIntent(message.id);assert.deepEqual(intent.settlement,{reorderMessageIds:[],placementMoveId:null,handoffId:null});
   const reorder=store.multilineReorderNotice.bind(store),placement=store.placementInstructionMove.bind(store);
   for(let i=0;i<1000&&store.getMessage(message.id).deliveredAt===null;i++){
    clock+=100;core.observe();store.multilineReorderNotice=store.placementInstructionMove=()=>{throw Error('ACK recomputed later effects');};
    try{core.reconcileDeliveryConfirmations();}finally{store.multilineReorderNotice=reorder;store.placementInstructionMove=placement;}await sleep(5);
   }
   assert.notEqual(store.getMessage(message.id).deliveredAt,null);console.log(JSON.stringify({case:mode,settled:true,ackRecomputedEffects:false}));continue;
  }
  if(mode.startsWith('oversize')){
   await until(()=>store.getMessage(message.id)?.deliveryConfirmation?.reason==='message_too_large');
   assert.equal(store.getMessage(message.id).deliveredAt,null);assert.equal(store.view('bee').waitingForYou,true);assert.equal(existsSync(writes),false);
   console.log(JSON.stringify({case:mode,heldReason:'message_too_large',stdinWrites:0,delivered:false,visible:true}));
  }else{
   await until(()=>store.getMessage(message.id)?.deliveredAt!==null);
   const rows=readFileSync(writes,'utf8').trim().split('\n').map(JSON.parse).filter(row=>row.id===1000+message.id);
   assert.deepEqual(rows.map(row=>[row.method,!!row.refused]),[['turn/steer',true],['turn/start',false]]);
   assert.equal(store.getDeliveryConfirmationIntent(message.id),null);
   console.log(JSON.stringify({case:mode,refusedSteerWrites:1,acceptedStartWrites:1,held:false,delivered:true}));
  }
  assert.deepEqual(replayAudit(store.auditRows()),store.dumpState());
 }finally{driver.disposeAll();for(let i=0;i<500&&pid&&pidAlive(pid);i++)await sleep(10);store.close();if(pid)assert.equal(pidAlive(pid),false);}
}
