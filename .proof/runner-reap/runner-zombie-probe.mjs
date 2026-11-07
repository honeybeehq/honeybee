import assert from 'node:assert/strict';
import {startDaemon, waitFor, liveRunnerHostPids} from '../../v2/daemon/tests/helpers.ts';
import {makeRegisteredServiceDir, registerService} from '../../v2/daemon/tests/registered-service-fixture.ts';
import {inspectProcess} from '../../v2/harness/src/processIdentity.ts';
const rig=makeRegisteredServiceDir(); let daemon, client, paused=false;
try {
 daemon=await startDaemon(rig.dir); client=await daemon.client(); await registerService(client,rig.dir);
 const bee=await client.request('spawn',{name:'reap-proof',agent:'stub',substrate:'hsr',cwd:rig.dir});
 const view=await waitFor(async()=>{const v=await client.request('view',{beeId:bee.beeId});return v.runtime?.state==='idle' ? v:null},'own runner idle',20000);
 const pid=view.runtime.pid;const before=inspectProcess(pid);
 assert.equal(before.kind,'present');assert.equal(before.ppid,daemon.proc.pid);assert.equal(before.pgid,pid);
 // Model the scheduler delaying the owned daemon's child-exit handling.
 daemon.proc.kill('SIGSTOP'); paused=true;
 const current=inspectProcess(pid);assert.equal(current.birth,before.birth);
 process.kill(-pid,'SIGKILL');
 const zombie=await waitFor(()=>{const p=inspectProcess(pid);return p.kind==='present'&&p.state==='zombie'?p:null},'own runner zombie',5000);
 process.kill(pid,0);
 console.log(JSON.stringify({runner:zombie,oldHelperReportedLive:true,fixedHelperPids:liveRunnerHostPids(rig.dir)}));
 assert.deepEqual(liveRunnerHostPids(rig.dir),[]);
 console.log('PASS actual runner host exited; helper excludes it while its daemon has not processed SIGCHLD');
}finally{
 if(paused)daemon.proc.kill('SIGCONT'); client?.close();
 if(daemon)await daemon.stop();rig.cleanup();
}
