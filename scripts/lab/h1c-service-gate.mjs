import assert from 'node:assert/strict';
import {makeDaemonDir,startDaemon} from '../../v2/daemon/tests/helpers.ts';
assert(process.env.TMPDIR?.startsWith('/var/tmp/'));
const fixture=makeDaemonDir({rpcLocalTrust:{requireObservationCaller:false}});
const daemon=await startDaemon(fixture.dir),client=await daemon.client();
try{
 for(const verb of ['mail.delivery.resend_anyway','mail.delivery.drop'])await assert.rejects(client.request(verb,{beeId:'missing',messageId:1,generation:1,idempotencyKey:'owned-trust-off'}),{code:'caller_not_trusted'});
 console.log(JSON.stringify({case:'delivery-resolution-trust-disabled',resendRefused:true,dropRefused:true,failClosed:true}));
}finally{client.close();await daemon.stop();}
