import assert from 'node:assert/strict';
import {join} from 'node:path';
import {CellDriver} from '../../v2/driver-cell/src/driver.ts';
import {makeRig} from '../../v2/driver-cell/tests/helpers.ts';
import {codexAdapter} from '../../v2/adapters/src/index.ts';
import {fixtureRuntimeIdentity,sleep,pidAlive} from '../../v2/driver-hsr/tests/helpers.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'));
const rig=makeRig(),writes=join(rig.root,'writes');
const driver=new CellDriver({cellsRoot:rig.cellsRoot,nodeKind:'satellite',disableCow:true,backgroundProvisioning:false,
 resolveHarness:()=>({adapter:codexAdapter({cwd:rig.root}),command:process.execPath,args:[new URL('./h1c-fake-codex.mjs',import.meta.url).pathname],env:{...process.env,H1C_WRITES:writes}}),
 resolveCell:beeId=>({provision:{beeId,originRepo:rig.origin.repo,sha:rig.origin.sha,wrapper:beeId,repoName:'fixture',cellId:'0123456789ab'},sandbox:true}),
 hsr:{runtimeIdentity:fixtureRuntimeIdentity(rig.root),sessionLogDir:join(rig.root,'logs'),stopKillGraceMs:400},sandboxWritablePaths:[rig.root]});let pid;
try{
 driver.start('bee',1);
 for(let i=0;i<3000&&!driver.deliveryLaneReady('bee',1);i++){driver.observe();await sleep(5);}
 const p=driver.inner.procs.get('bee');pid=p?.pid;assert(p);assert(driver.deliveryLaneReady('bee',1));
 for(let i=0;i<1000&&!p.sessionId;i++){driver.observe();await sleep(5);}
 const plan=driver.planDeliveryConfirmation('bee',1,24680,'owned sandbox Cell auth');assert(plan&&plan!=='not_ready');assert.equal(plan.host.pid,p.pid);assert.notEqual(p.agentPid,p.pid);assert.equal(p.deliveryProtocol.authenticated,true);
 driver.deliver('bee',1,24680,'owned sandbox Cell auth',{confirmation:plan});let result;
 for(let i=0;i<1000&&result!=='accepted';i++){driver.observe();result=driver.reconcileDeliveryConfirmation('bee',1,24680,plan);await sleep(5);}
 assert.equal(result,'accepted');console.log(JSON.stringify({case:'sandboxed-Cell-host-authentication',hostPid:p.pid,agentPid:p.agentPid,peerMatchesHost:true,peerIsAgent:false,sandbox:true,receipt:'accepted',root:rig.root}));
}finally{driver.inner.disposeAll();for(let i=0;i<500&&pid&&pidAlive(pid);i++)await sleep(10);if(pid)assert.equal(pidAlive(pid),false);}
