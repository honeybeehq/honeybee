import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {autoTitleDecision,autoTitleRetryBackoffMs,contextSignature,userTaskMessages} from '/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07/v2/daemon/src/autoTitle.ts';
// Proposed extraction, copied exactly from the existing predicate. There is
// no production implementation; this probe checks the quiet-only narrowing.
const inBackoff=(b,now)=>Boolean(b?.lastAt&&now-b.lastAt<autoTitleRetryBackoffMs(b.attempts)&&!b.deferred);
const bee={lifecycle:'active',title:null};
const bodies=[[],['hi'],['<hive-session>ignored</hive-session>'],['Implement a transactional queue with durable retry fencing.'],['hi','hello'],['hi','Implement a transactional queue.'],['x'.repeat(3000)],['<hive-session>ignored</hive-session>','hi']];
let cases=0,skips=0,reads=0;
for(const body of bodies){const users=userTaskMessages(body.map(body=>({body}))),sig=contextSignature(bee,users);
 for(const deferred of [false,true])for(const attempts of [-1,0,1,7,100])for(const lastAt of [0,1,1000,-5,Infinity,NaN])for(const now of [0,1000,15000,16000,601000])for(const sameSignature of [false,true]){
  const b={attempts,lastAt,userTurns:users.length,deferred,signature:sameSignature?sig:'stale'};
  const skip=sameSignature&&(b.deferred||inBackoff(b,now));
  const sourceQuiet=sameSignature&&b.deferred||autoTitleDecision(bee,users,sameSignature?b:undefined,now).action==='skip';
  assert.equal(skip,sourceQuiet);cases++;if(skip)skips++;else reads++;
 }
}
const report={completed:true,scope:'Design proof only. Compares exact unchanged-defer shortcut plus the existing truthy-lastAt backoff predicate against the real full-content policy. All other paths still require the existing full read. It does not prove mailbox identity, mutable callback pairing, or an implemented cache.',cases,skips,reads};writeFileSync('/tmp/honeybee-autotitle-architecture/quiet-policy-proof.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
