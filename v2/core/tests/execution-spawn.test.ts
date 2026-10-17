import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { harness } from "./helpers.ts";
import { executionRequestDigest, type ExecutionClaim, type ExecutionRequest, ExecutionFenceError } from "../src/executionFence.ts";

const code = (code: string) => (error: unknown) => error instanceof ExecutionFenceError && error.code === code;
function fixture() {
  const h = harness(), store = h.open(), args = { id: "fenced-bee", name: "fenced", agent: "stub", substrate: "hsr", cwd: "/owned" }, resource = { beeId: args.id };
  const claim: ExecutionClaim = { version:1, issuerId:"project",continuationId:"spawn-step",claimId:"one",generation:1,grantDigest:"sha256:"+"a".repeat(64),...store.effectCoverage(),verb:"spawn",resource,digestVersion:1,requestDigest:executionRequestDigest("spawn",resource,args),idempotencyKey:"effect-v1:"+store.effectCoverage().coverageId+":original-salt" };
  store.registerExecutionCoordinator("project",1000);
  store.compareAndSetExecutionClaim({transitionId:"one",expectedClaim:null,claim},1000);
  const {verb,resource:r,digestVersion,requestDigest,idempotencyKey,...executionFence}=claim;
  const request: ExecutionRequest={verb,resource:r,digestVersion,requestDigest,idempotencyKey,executionFence,args};
  const begin=()=>store.beginFencedSpawn(request,1000);
  const admit=()=>store.admitFencedSpawn(request,()=>{
    store.createBee({id:args.id,name:args.name,agent:"stub",substrate:"hsr",cwd:args.cwd});
    const command=store.enqueueCommand("spawn",args.id,{}, {idempotencyKey});
    return {commandId:command.id,beeId:args.id};
  });
  const advance=()=>store.compareAndSetExecutionClaim({transitionId:"two",expectedClaim:claim,claim:{...claim,generation:2,claimId:"two"}},1000);
  return {h,store,claim,request,begin,admit,advance,close(){store.close();h.cleanup();}};
}

test("spawn preparation is durably busy before any mutation, exact retries only observe",()=>{
  const f=fixture();try{
    const begun=f.begin();assert.equal(begun.fresh,true);assert.equal(begun.receipt.status,"preparing");
    assert.throws(f.advance,code("rpc_execution_busy"));
    assert.equal(f.begin().fresh,false);assert.equal(f.store.listBees().length,0);
    const admitted=f.admit();assert.ok(admitted.commandId);
    assert.equal(f.begin().receipt.status,"queued");assert.equal(f.store.listBees().length,1);
  }finally{f.close();}
});
test("every preparation checkpoint validates the exact current claim and immutable request",()=>{
  const f=fixture();try{
    f.begin();
    assert.throws(()=>f.store.checkSpawnPreparation({...f.request,requestDigest:"sha256:"+"b".repeat(64)},"create_bee"),code("idempotency_conflict"));
    f.store.markSpawnUnknown(f.claim.idempotencyKey);
    assert.throws(()=>f.store.checkSpawnPreparation(f.request,"cell_reserve"),code("rpc_execution_history_unknown"));
    assert.throws(f.advance,code("rpc_execution_busy"));
  }finally{f.close();}
});
test("persisted leases prevent advancement and unknown descendants never become quiescent by timeout",()=>{
  const f=fixture();try{
    f.begin();f.admit();const start=f.store.prepareExecutionStart("fenced-bee",1)!;const hooks=f.store.executionRuntimeHooks();
    const lease=hooks.begin(start,"cell_provision");
    assert.throws(f.advance,code("rpc_execution_busy"));
    assert.throws(()=>hooks.begin(start,"replacement"),code("rpc_execution_busy"));
    hooks.finish(start,lease,false);
    assert.throws(()=>hooks.check(start,"pool_claim"),code("rpc_execution_history_unknown"));
    assert.throws(f.advance,code("rpc_execution_busy"));
  }finally{f.close();}
});
test("owner release is persisted and busy before transport; only exact host and agent receipts complete",()=>{
  const f=fixture();try{
    f.begin();const admitted=f.admit(),start=f.store.prepareExecutionStart("fenced-bee",1)!;const hooks=f.store.executionRuntimeHooks();
    hooks.dispatch(start);assert.throws(f.advance,code("rpc_execution_busy"));
    const host={pid:100,birth:"linux:123456789"},agent={pid:101,birth:"linux:123456790"};
    hooks.bindAndRelease(start,host);
    assert.throws(f.advance,code("rpc_execution_busy"));
    assert.throws(()=>hooks.started(start,{...host,birth:"linux:123456788"},agent),code("rpc_execution_history_unknown"));
    hooks.started(start,host,agent);hooks.started(start,host,agent);
    const result=f.store.resolveExecution(f.request,1000);assert.ok("executionReceipt" in result);assert.equal(result.executionReceipt.status,"completed");assert.equal(result.executionReceipt.boundary,"agent-start-handshake");
    f.advance();assert.throws(()=>f.store.prepareExecutionStart("fenced-bee",2),code("rpc_execution_stale"));
    assert.ok(admitted.commandId);
  }finally{f.close();}
});
test("unreleased prepared start can be revoked, stale worker and final dispatch add no effects",()=>{
  const f=fixture();try{
    f.begin();f.admit();const start=f.store.prepareExecutionStart("fenced-bee",1)!;const hooks=f.store.executionRuntimeHooks();
    f.advance();
    assert.throws(()=>hooks.check(start,"pool_claim"),code("rpc_execution_stale"));
    assert.throws(()=>hooks.dispatch(start),code("rpc_execution_stale"));
    const observed=f.store.resolveExecution(f.request,1000);assert.ok("executionReceipt" in observed);assert.equal(observed.executionReceipt.status,"refused_stale");
  }finally{f.close();}
});
test("crash after release commit remains busy across reopen and cannot fall back to a fresh intent",()=>{
  const f=fixture();f.begin();f.admit();const start=f.store.prepareExecutionStart("fenced-bee",1)!;const hooks=f.store.executionRuntimeHooks();
  hooks.dispatch(start);hooks.bindAndRelease(start,{pid:100,birth:"darwin:123:999999"});
  f.store.close();const store=f.h.open();try{
    assert.throws(()=>store.prepareExecutionStart("fenced-bee",1),code("rpc_execution_history_unknown"));
    assert.equal(store.existingExecutionStart("fenced-bee",1)?.intentId,start.intentId);
    assert.deepEqual(store.executionStartHost(start),{pid:100,birth:"darwin:123:999999"});
    assert.throws(()=>store.executionRuntimeHooks().bindAndRelease(start,{pid:100,birth:"darwin:123:999998"}),code("rpc_execution_history_unknown"));
    assert.throws(()=>store.prepareExecutionStart("fenced-bee",2),code("rpc_execution_history_unknown"));
  }finally{store.close();f.h.cleanup();}
});

test("stale spawn admission records a typed zero-effect receipt before preparation",()=>{
  const f=fixture();try{
    f.advance();
    assert.throws(f.begin,(error: unknown)=>{
      assert.ok(error instanceof ExecutionFenceError);
      assert.equal(error.code,"rpc_execution_stale");
      assert.equal((error.details as {executionReceipt:{status:string}}).executionReceipt.status,"refused_stale");
      return true;
    });
    assert.equal(f.store.listBees().length,0);
    const observed=f.store.resolveExecution(f.request,1000);
    assert.ok("executionReceipt" in observed);
    assert.equal(observed.executionReceipt.status,"refused_stale");
  }finally{f.close();}
});

test("additive start tables reopen without parsing malformed legacy audit payloads",()=>{
  const h=harness(),first=h.open();first.close();
  const db=new DatabaseSync(h.path);
  db.prepare("INSERT INTO audit(ts,kind,bee_id,payload) VALUES(?,?,?,?)").run(1,"legacy.spawn",null,"not-json");
  db.close();
  const store=h.open();try{
    assert.equal(store.executionOrigin("legacy"),null);
    assert.equal(store.prepareExecutionStart("legacy",1),null);
    assert.ok(store.effectCoverage().coverageId);
  }finally{store.close();h.cleanup();}
});

test("host death after release without agent-start evidence remains unknown, never a stale no-op",()=>{
  const f=fixture();try{
    f.begin();f.admit();const start=f.store.prepareExecutionStart("fenced-bee",1)!,hooks=f.store.executionRuntimeHooks(),host={pid:100,birth:"linux:123456789"};
    hooks.dispatch(start);hooks.bindAndRelease(start,host);hooks.hostExited(start,host);
    assert.throws(f.advance,code("rpc_execution_busy"));
    const observed=f.store.resolveExecution(f.request,1000);assert.ok("executionReceipt" in observed);
    assert.equal(observed.executionReceipt.status,"outcome_unknown");
    assert.throws(()=>hooks.bindAndRelease(start,host),code("rpc_execution_stale"));
  }finally{f.close();}
});
test("exact unreleased host death permits revocation but not a second start attempt",()=>{
  const f=fixture();try{
    f.begin();f.admit();const start=f.store.prepareExecutionStart("fenced-bee",1)!,hooks=f.store.executionRuntimeHooks();
    hooks.dispatch(start);hooks.hostExited(start,{pid:100,birth:"linux:123456789"});
    f.advance();
    assert.throws(()=>hooks.bindAndRelease(start,{pid:100,birth:"linux:123456789"}),code("rpc_execution_stale"));
  }finally{f.close();}
});
