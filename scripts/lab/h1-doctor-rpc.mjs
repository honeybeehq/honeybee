import {makeDaemonDir,startDaemon} from '../../v2/daemon/tests/helpers.ts';
const fixture=makeDaemonDir();const daemon=await startDaemon(fixture.dir);const client=await daemon.client();
try{const result=await client.request('doctor.integrity',{}); console.log(JSON.stringify({case:'live-owned-daemon-doctor-rpc',result,pid:daemon.proc.pid}));if(!result.ok)throw Error('check failed');}finally{client.close();await daemon.stop();}
