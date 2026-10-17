import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { spawn,type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { exactProcessBirth } from "../../harness/src/processIdentity.ts";
import { canonicalDigest,type JsonValue } from "../../../src/comb/canonical.ts";
import type { ExecutionStart } from "../../core/src/executionStart.ts";
import { executionRequestDigest } from "../../core/src/executionFence.ts";
import { HsrDriver } from "../src/driver.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { openCoreStore } from "../../core/src/index.ts";

const wait = async (fn:()=>boolean,label:string) => { const end=Date.now()+10000;while(!fn()){if(Date.now()>end)throw new Error("timeout "+label);await new Promise(r=>setTimeout(r,10));}};
function context():ExecutionStart {
  const args={id:"fenced",name:"fenced",agent:"stub",substrate:"hsr",cwd:"/owned"}, resource={beeId:"fenced"};
  return {intentId:"attempt-one",beeId:"fenced",runtimeGeneration:1,claim:{version:1,issuerId:"project",continuationId:"step",claimId:"claim",generation:1,grantDigest:"sha256:"+"a".repeat(64),ownerStoreId:"owner",coverageId:"coverage",digestVersion:1,verb:"spawn",resource,idempotencyKey:"effect-v1:coverage:salt",requestDigest:executionRequestDigest("spawn",resource,args)}};
}
async function stop(child:ChildProcess):Promise<void> {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const closed=once(child,"close",{signal:AbortSignal.timeout(10000)});
  if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{}
  await closed;
}
test("runner host waits for exact inherited release, rejects wrong attempts, and forks only once",async t=>{
  const root=mkdtempSync(join(tmpdir(),"fenced-host-")),start=context(),counter=join(root,"forks"),config=join(root,"config.json");
  const ownerBirth=exactProcessBirth(process.pid);assert.ok(ownerBirth,"native exact birth required");
  writeFileSync(config,JSON.stringify({beeId:"fenced",generation:1,executionStart:start,executionOwner:{pid:process.pid,birth:ownerBirth},command:process.execPath,args:["-e","require('fs').appendFileSync(process.argv[1],'fork\\n');setInterval(()=>{},1000)",counter],cwd:root,env:{PATH:process.env.PATH ?? "",HOME:process.env.HOME ?? "",TMPDIR:process.env.TMPDIR ?? ""},sessionLogPath:join(root,"log"),observationLogPath:join(root,"obs"),sidecarPath:join(root,"err"),socketPath:join(root,"s"),statusPath:join(root,"status"),bootLines:[]}));
  const child=spawn(process.execPath,["--experimental-strip-types",resolve("v2/driver-hsr/src/runner-host-main.ts"),config],{detached:true,stdio:["ignore","pipe","pipe","ipc"],env:{PATH:process.env.PATH ?? "",HOME:process.env.HOME ?? "",TMPDIR:process.env.TMPDIR ?? ""}});
  t.after(async()=>{await stop(child);rmSync(root,{recursive:true,force:true});});
  const frames:Record<string,unknown>[]=[];child.on("message",frame=>frames.push(frame as Record<string,unknown>));
  await wait(()=>frames.some(x=>x.op==="execution_ready"),"ready");
  const ready=frames.find(x=>x.op==="execution_ready")!;assert.equal(existsSync(counter),false);
  child.send({op:"execution_release",intentId:"wrong-attempt",bindingDigest:ready.bindingDigest,host:ready.host});
  child.send({op:"execution_release",intentId:start.intentId,bindingDigest:ready.bindingDigest,host:{pid:child.pid,birth:"linux:0"}});
  assert.equal(existsSync(counter),false);
  const release={op:"execution_release",intentId:start.intentId,bindingDigest:canonicalDigest(start as unknown as JsonValue),host:ready.host};
  child.send(release);
  await wait(()=>frames.some(x=>x.op==="execution_started")&&existsSync(counter),"agent");
  child.send(release);
  assert.equal(readFileSync(counter,"utf8").trim().split("\n").length,1);
  const born=(ready.host as {birth:string}).birth;assert.equal(born,exactProcessBirth(child.pid!));
});
test("owner disconnect before release never forks an agent",async t=>{
  const root=mkdtempSync(join(tmpdir(),"fenced-disconnect-")),start=context(),counter=join(root,"forks"),config=join(root,"config");
  writeFileSync(config,JSON.stringify({beeId:start.beeId,generation:1,executionStart:start,executionOwner:{pid:process.pid,birth:exactProcessBirth(process.pid)},command:process.execPath,args:["-e","require('fs').writeFileSync(process.argv[1],'BAD')",counter],cwd:root,env:{PATH:process.env.PATH ?? ""},sessionLogPath:join(root,"log"),observationLogPath:join(root,"obs"),sidecarPath:join(root,"err"),socketPath:join(root,"s"),statusPath:join(root,"status"),bootLines:[]}));
  const child=spawn(process.execPath,["--experimental-strip-types",resolve("v2/driver-hsr/src/runner-host-main.ts"),config],{detached:true,stdio:["ignore","ignore","ignore","ipc"],env:{PATH:process.env.PATH ?? "",HOME:process.env.HOME ?? "",TMPDIR:process.env.TMPDIR ?? ""}});
  t.after(async()=>{await stop(child);rmSync(root,{recursive:true,force:true});});
  await once(child,"message",{signal:AbortSignal.timeout(10000)});const closed=once(child,"close",{signal:AbortSignal.timeout(10000)});child.disconnect();await closed;assert.equal(existsSync(counter),false);
});
test("HSR owner commits exact release before IPC and persists agent-start completion",async t=>{
  const root=mkdtempSync(join(tmpdir(),"fenced-owner-")),store=openCoreStore(join(root,"db"),{ephemeral:true}),args={id:"fenced",name:"fenced",agent:"stub",substrate:"hsr",cwd:root},resource={beeId:args.id};
  const claim={...context().claim,...store.effectCoverage(),resource,requestDigest:executionRequestDigest("spawn",resource,args),idempotencyKey:"effect-v1:"+store.effectCoverage().coverageId+":salt"};
  store.registerExecutionCoordinator("project",1000);store.compareAndSetExecutionClaim({transitionId:"one",expectedClaim:null,claim},1000);
  const {verb,resource:r,digestVersion,requestDigest,idempotencyKey,...executionFence}=claim,request={verb,resource:r,digestVersion,requestDigest,idempotencyKey,executionFence,args};
  store.beginFencedSpawn(request,1000);store.admitFencedSpawn(request,()=>{store.createBee({id:"fenced",name:"fenced",agent:"stub",substrate:"hsr",cwd:root});return{commandId:store.enqueueCommand("spawn","fenced",{},{idempotencyKey}).id};});
  const start=store.prepareExecutionStart("fenced",1)!,base=store.executionRuntimeHooks();let commits=0;
  const driver=new HsrDriver({sessionLogDir:join(root,"logs"),execution:{...base,bindAndRelease(s,host){base.bindAndRelease(s,host);commits++;assert.throws(()=>store.compareAndSetExecutionClaim({transitionId:"two",expectedClaim:claim,claim:{...claim,generation:2,claimId:"two"}},1000),e=>(e as {code?:string}).code==="rpc_execution_busy");}},resolve:()=>({command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:root,env:{PATH:process.env.PATH ?? "",HOME:process.env.HOME ?? "",TMPDIR:process.env.TMPDIR ?? ""},adapter:stubAdapter})});
  t.after(()=>{driver.disposeAll();store.close();rmSync(root,{recursive:true,force:true});});
  driver.start("fenced",1,start);
  await wait(()=>{driver.observe();const r=store.resolveExecution(request,1000);return "executionReceipt" in r&&r.executionReceipt.status==="completed";},"owner completion");
  assert.equal(commits,1);assert.ok(store.executionStartHost(start)?.birth);
});
