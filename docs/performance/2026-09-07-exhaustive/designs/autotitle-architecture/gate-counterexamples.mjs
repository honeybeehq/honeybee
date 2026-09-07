import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openCoreStore} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/core/src/index.ts';
import {autoTitleDecision,autoTitleRetryBackoffMs,contextSignature,userTaskMessages} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/daemon/src/autoTitle.ts';
const dir=mkdtempSync(join(tmpdir(),'hb-title-gate-proof-')),s=openCoreStore(join(dir,'core.sqlite'),{now:()=>1000});
try {
 const {bee}=s.createBee({name:'gate proof',handle:'GP.proof',agent:'stub',substrate:'hsr',cwd:dir});s.updateRuntimeState(bee.id,1,'running');
 const task='Implement a durable queue with transactional delivery and retry fencing.';
 const bk={attempts:1,lastAt:0,userTurns:1,deferred:false,signature:contextSignature(bee,[task])};
 const real=autoTitleDecision(bee,[task],bk,1000);const sketchSkips=1000-bk.lastAt<autoTitleRetryBackoffMs(bk.attempts);assert.equal(real.action,'generate');assert.equal(sketchSkips,true);
 s.send(bee.id,'hi',{urgency:'idle'});
 const stamp=()=>{if(s.inTransaction)return null;const rows=s.listMessages(bee.id);return JSON.stringify([rows.length,rows.at(-1)?.id??0]);};
 const readThenMutate=()=>{const rows=s.listMessages(bee.id);s.send(bee.id,task,{urgency:'idle'});return rows;};
 const observed=readThenMutate(),signature=contextSignature(bee,userTaskMessages(observed)),recordedStamp=stamp();
 const bookkeeping={attempts:0,lastAt:0,userTurns:1,deferred:true,signature};
 const gateWouldSkip=recordedStamp===stamp()&&bookkeeping.signature===signature&&bookkeeping.deferred;
 const current=s.listMessages(bee.id),currentSignature=contextSignature(bee,userTaskMessages(current)),expected=autoTitleDecision(bee,userTaskMessages(current),bookkeeping.signature===currentSignature?bookkeeping:undefined,1000);
 assert.equal(gateWouldSkip,true);assert.equal(expected.action,'generate');assert.notEqual(signature,currentSignature);
 const before=stamp();let speculative;const rollback=new Error('rollback');assert.throws(()=>s.transact(()=>{s.send(bee.id,'speculative extra message',{urgency:'idle'});speculative=s.listMessages(bee.id);throw rollback;}),e=>e===rollback);const after=stamp();assert.equal(before,after);assert.notEqual(contextSignature(bee,userTaskMessages(speculative)),contextSignature(bee,userTaskMessages(s.listMessages(bee.id))));
 const report={completed:true,scope:'Counterexamples to design predicates and independently paired dependency reads; this is not a test of an implemented optimization.',lastAtZero:{realDecision:real,sketchSkips},readThenMutate:{observedBodyCount:observed.length,currentBodyCount:current.length,recordedStamp,gateWouldSkip,expected},speculativeReturnedSnapshot:{committedBefore:before,committedAfter:after,speculativeBodyCount:speculative.length,committedBodyCount:s.listMessages(bee.id).length}};
 writeFileSync('/tmp/honeybee-autotitle-architecture/gate-counterexamples.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{s.close();rmSync(dir,{recursive:true,force:true});}
