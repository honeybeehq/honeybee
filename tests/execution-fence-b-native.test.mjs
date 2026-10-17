import { spawnSync } from "node:child_process";
const env={...process.env};delete env.NODE_TEST_CONTEXT;
const groups=[
 ["--test","v2/driver-hsr/tests/execution-handshake.test.ts","v2/driver-hsr/tests/runner-host.test.ts","v2/driver-cell/tests/fenced-provision.test.ts","v2/driver-cell/tests/driver.test.ts"],
 ["scripts/run-v2-daemon-tests.mjs","v2/daemon/tests/execution-fence.test.ts","v2/daemon/tests/loops.test.ts","v2/daemon/tests/idempotency.test.ts","v2/daemon/tests/mailbox-only.test.ts","v2/daemon/tests/local-rpc-security.test.ts"]
];
for(const args of groups){
 const r=spawnSync(process.execPath,args,{env,encoding:"utf8",maxBuffer:32*1024*1024,timeout:180000});process.stdout.write(r.stdout??"");process.stderr.write(r.stderr??"");
 if(r.error)throw r.error;if(r.status!==0)throw new Error("native spawn groups failed "+r.status);
 if(!/^(?:# |ℹ )tests [1-9][0-9]*$/m.test(r.stdout??""))throw new Error("No native target tests ran");
}
