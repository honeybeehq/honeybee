import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { makeRig } from "./helpers.ts";
import { CellDriver } from "../src/driver.ts";
import { openCoreStore } from "../../core/src/index.ts";
import { executionRequestDigest,type ExecutionClaim } from "../../core/src/executionFence.ts";

test("fenced Cell owner refuses before account, bee, reservation or provisioning mutation",()=>{
  const rig=makeRig(),store=openCoreStore(join(rig.root,"db"),{ephemeral:true});
  try{
    const args={id:"held-cell",name:"held-cell",agent:"stub",substrate:"cell"},resource={beeId:args.id};
    const claim:ExecutionClaim={version:1,issuerId:"project",continuationId:"cell",claimId:"one",generation:1,grantDigest:"sha256:"+"a".repeat(64),...store.effectCoverage(),verb:"spawn",resource,digestVersion:1,requestDigest:executionRequestDigest("spawn",resource,args),idempotencyKey:"effect-v1:"+store.effectCoverage().coverageId+":cell"};
    store.registerExecutionCoordinator("project",1000);store.compareAndSetExecutionClaim({transitionId:"one",expectedClaim:null,claim},1000);
    const {verb,resource:r,digestVersion,requestDigest,idempotencyKey,...executionFence}=claim;
    const before=store.dumpState(),audit=store.auditTail(0,1000),files=readdirSync(rig.cellsRoot);
    assert.throws(()=>store.beginFencedSpawn({verb,resource:r,digestVersion,requestDigest,idempotencyKey,executionFence,args},1000),e=>(e as {code?:string}).code==="rpc_execution_fence_unsupported");
    assert.deepEqual(store.dumpState(),before);assert.deepEqual(store.auditTail(0,1000),audit);
    assert.deepEqual(readdirSync(rig.cellsRoot),files);assert.equal(store.executionOrigin(args.id),null);
  }finally{store.close();rig.cleanup();}
});
test("fenced Cell driver refuses before resolution, worker, pool claim or host start",()=>{
  const rig=makeRig();let resolved=0;
  const driver=new CellDriver({cellsRoot:rig.cellsRoot,nodeKind:"satellite",resolveCell:()=>{resolved++;throw new Error("must not resolve");},resolveHarness:()=>{resolved++;throw new Error("must not start");},hsr:{sessionLogDir:join(rig.root,"logs")},warmPool:{targetFree:1}});
  try{
    const args={id:"held-cell",name:"held-cell",agent:"stub",substrate:"cell"},resource={beeId:args.id};
    const claim:ExecutionClaim={version:1,issuerId:"project",continuationId:"cell",claimId:"one",generation:1,grantDigest:"sha256:"+"a".repeat(64),ownerStoreId:"owner",coverageId:"coverage",verb:"spawn",resource,digestVersion:1,requestDigest:executionRequestDigest("spawn",resource,args),idempotencyKey:"effect-v1:coverage:cell"};
    const files=readdirSync(rig.cellsRoot);
    assert.throws(()=>driver.start(args.id,1,{intentId:"attempt",beeId:args.id,runtimeGeneration:1,claim}),e=>(e as {code?:string}).code==="rpc_execution_fence_unsupported");
    assert.equal(resolved,0);assert.equal(driver.hasProcess(args.id,1),false);
    assert.deepEqual(readdirSync(rig.cellsRoot),files);
  }finally{driver.disposeAll();rig.cleanup();}
});
