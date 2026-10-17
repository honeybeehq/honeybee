import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { makeRig } from "./helpers.ts";
import { CellDriver } from "../src/driver.ts";
import { reserveCell } from "../src/provision.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { openCoreStore } from "../../core/src/index.ts";
import { executionRequestDigest,type ExecutionClaim } from "../../core/src/executionFence.ts";

const wait=async(fn:()=>boolean,label:string)=>{const until=Date.now()+15000;while(!fn()){if(Date.now()>until)throw new Error("timeout "+label);await new Promise(r=>setTimeout(r,10));}};
test("fenced Cell worker carries the original binding through checkpoints and quiescence to final host release",async t=>{
  const rig=makeRig(),store=openCoreStore(join(rig.root,"db"),{ephemeral:true}),beeId="bee-fenced";
  const args={id:beeId,name:beeId,agent:"stub",substrate:"cell"},resource={beeId};
  const claim:ExecutionClaim={version:1,issuerId:"project",continuationId:"cell",claimId:"one",generation:1,grantDigest:"sha256:"+"a".repeat(64),...store.effectCoverage(),verb:"spawn",resource,digestVersion:1,requestDigest:executionRequestDigest("spawn",resource,args),idempotencyKey:"effect-v1:"+store.effectCoverage().coverageId+":cell-salt"};
  store.registerExecutionCoordinator("project",1000);store.compareAndSetExecutionClaim({transitionId:"one",expectedClaim:null,claim},1000);
  const {verb,resource:r,digestVersion,requestDigest,idempotencyKey,...executionFence}=claim,request={verb,resource:r,digestVersion,requestDigest,idempotencyKey,executionFence,args};
  store.beginFencedSpawn(request,1000);store.admitFencedSpawn(request,()=>{store.createBee({id:beeId,name:beeId,agent:"stub",substrate:"cell",cwd:rig.root});return{commandId:store.enqueueCommand("spawn",beeId,{},{idempotencyKey}).id};});
  const provision={beeId,originRepo:rig.origin.repo,sha:rig.origin.sha,wrapper:beeId,repoName:"fixture",cellId:"cfenced"};
  reserveCell(rig.cellsRoot,provision);
  const start=store.prepareExecutionStart(beeId,1)!,base=store.executionRuntimeHooks(),checks:string[]=[];
  const driver=new CellDriver({cellsRoot:rig.cellsRoot,nodeKind:"satellite",disableCow:true,backgroundProvisioning:true,resolveCell:()=>({provision,sandbox:false}),resolveHarness:()=>({adapter:stubAdapter,command:process.execPath,args:["-e","setInterval(()=>{},1000)"],env:{PATH:process.env.PATH ?? "",HOME:process.env.HOME ?? "",TMPDIR:process.env.TMPDIR ?? ""}}),hsr:{sessionLogDir:join(rig.root,"logs"),execution:{...base,check(s,op){assert.equal(s.intentId,start.intentId);checks.push(op);base.check(s,op);}}},onCellMaterialized(_bee,s){assert.equal(s?.intentId,start.intentId);}});
  t.after(()=>{driver.disposeAll();store.close();rig.cleanup();});
  driver.start(beeId,1,start);
  assert.throws(()=>store.compareAndSetExecutionClaim({transitionId:"two",expectedClaim:claim,claim:{...claim,generation:2,claimId:"two"}},1000),e=>(e as {code?:string}).code==="rpc_execution_busy");
  await wait(()=>{driver.observe();const r=store.resolveExecution(request,1000);return "executionReceipt" in r&&r.executionReceipt.status==="completed";},"fenced Cell start");
  assert.ok(checks.includes("cell_provision"));assert.ok(checks.includes("cell_final_start"));assert.ok(store.auditTail(0,1000).some(row=>row.kind==="rpc.execution.host_dispatch_intent"));
  assert.ok(driver.cellOf(beeId));assert.ok(store.executionStartHost(start)?.birth);
});
test("stale Cell context refuses before pool claim or filesystem provisioning",()=>{
  const rig=makeRig(),store=openCoreStore(join(rig.root,"db"),{ephemeral:true});
  try{
    const args={id:"bee-stale",name:"stale",agent:"stub",substrate:"cell"},resource={beeId:args.id};
    const claim:ExecutionClaim={version:1,issuerId:"project",continuationId:"stale",claimId:"one",generation:1,grantDigest:"sha256:"+"a".repeat(64),...store.effectCoverage(),verb:"spawn",resource,digestVersion:1,requestDigest:executionRequestDigest("spawn",resource,args),idempotencyKey:"effect-v1:"+store.effectCoverage().coverageId+":stale"};
    store.registerExecutionCoordinator("project",1000);store.compareAndSetExecutionClaim({transitionId:"one",expectedClaim:null,claim},1000);
    const {verb,resource:r,digestVersion,requestDigest,idempotencyKey,...executionFence}=claim,request={verb,resource:r,digestVersion,requestDigest,idempotencyKey,executionFence,args};
    store.beginFencedSpawn(request,1000);store.admitFencedSpawn(request,()=>{store.createBee({id:args.id,name:args.name,agent:"stub",substrate:"cell",cwd:rig.root});return{commandId:store.enqueueCommand("spawn",args.id,{},{idempotencyKey}).id};});
    const start=store.prepareExecutionStart(args.id,1)!;
    store.compareAndSetExecutionClaim({transitionId:"two",expectedClaim:claim,claim:{...claim,generation:2,claimId:"two"}},1000);
    let resolved=0;
    const driver=new CellDriver({cellsRoot:rig.cellsRoot,nodeKind:"satellite",resolveCell:()=>{resolved++;throw new Error("must not resolve stale Cell");},resolveHarness:()=>{throw new Error("must not start");},hsr:{sessionLogDir:join(rig.root,"logs"),execution:store.executionRuntimeHooks()},warmPool:{targetFree:1}});
    assert.throws(()=>driver.start(args.id,1,start),e=>(e as {code?:string}).code==="rpc_execution_stale");
    assert.equal(resolved,0);assert.equal(existsSync(join(rig.cellsRoot,args.id)),false);driver.disposeAll();
  }finally{store.close();rig.cleanup();}
});
