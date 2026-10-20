import assert from 'node:assert/strict';
import {makeDaemonDir,startDaemon} from '../../v2/daemon/tests/helpers.ts';
import {RpcClient} from '../../v2/cli/src/client.ts';
const fixture=makeDaemonDir();const daemon=await startDaemon(fixture.dir);const client=await daemon.client();
try {
 client.socket.cork();
 const requests=Promise.allSettled([client.request('doctor.integrity',{}),client.request('doctor.integrity',{})]);
 client.socket.uncork();
 const settled=await requests;
 const results=settled.filter(x=>x.status==='fulfilled').map(x=>x.value);
 assert(results.length>=1);for(const item of settled)if(item.status==='rejected')assert.equal(item.reason.code,'doctor_cooldown');
 assert(results.every(result=>result.ok));if(results.length===2)assert.deepEqual(results[0],results[1]);
 console.log(JSON.stringify({case:'live-owned-daemon-doctor-single-flight',results,pid:daemon.proc.pid}));
 await assert.rejects(client.request('doctor.integrity',{}),{code:'doctor_cooldown'});
 console.log(JSON.stringify({case:'doctor-cooldown',refused:true}));
 const remote=await RpcClient.connect(daemon.socketPath,3000,'remote');
 try {await assert.rejects(remote.request('doctor.integrity',{}),{code:'caller_not_trusted'});console.log(JSON.stringify({case:'doctor-remote-relay',refused:true}));}finally{remote.close();}
}finally{client.close();await daemon.stop();}
