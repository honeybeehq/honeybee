import { spawnSync } from "node:child_process";
const env={...process.env};delete env.NODE_TEST_CONTEXT;
const r=spawnSync("npm",["test"],{env,encoding:"utf8",maxBuffer:64*1024*1024,timeout:600000});
process.stdout.write(r.stdout??"");process.stderr.write(r.stderr??"");
if(r.error)throw r.error;
if(r.status!==0)throw new Error("Root CI suite failed "+r.status);
if(!/^(?:# |ℹ )tests [1-9][0-9]*$/m.test(r.stdout??""))throw new Error("No root tests ran");
