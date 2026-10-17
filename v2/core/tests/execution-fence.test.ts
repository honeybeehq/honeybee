import type { JsonValue } from "../../../src/comb/canonical.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";
import { executionRequestDigest, ExecutionFenceError, type ExecutionClaim, type ExecutionRequest } from "../src/executionFence.ts";

const code = (code: string) => (error: unknown) => error instanceof ExecutionFenceError && error.code === code;
function setup(verb: "send" | "archive" = "archive") {
  const h = harness(), store = h.open(), { bee } = makeBee(store), resource = { beeId: bee.id }, args: Record<string, JsonValue> = verb === "send" ? { beeId: bee.id, body: "once" } : { beeId: bee.id };
  const coverage = store.effectCoverage(), claim: ExecutionClaim = { version: 1, issuerId: "apiary-home", continuationId: "landing-round", generation: 1, claimId: "claim-1", grantDigest: "sha256:" + "a".repeat(64), ...coverage, digestVersion: 1, verb, resource, idempotencyKey: `effect-v1:${coverage.coverageId}:salted-intent`, requestDigest: executionRequestDigest(verb, resource, args) };
  store.registerExecutionCoordinator(claim.issuerId, 1000);
  const transition = { transitionId: "advance-1", expectedClaim: null, claim };
  store.compareAndSetExecutionClaim(transition, 1000);
  const { verb: v, resource: r, idempotencyKey, requestDigest, digestVersion, ...executionFence } = claim;
  const request: ExecutionRequest = { digestVersion, verb: v, resource: r, idempotencyKey, requestDigest, executionFence, args };
  const execute = (input = request) => store.executeWithFence(input, 1000, request => {
    if (request.verb === "send") { const sent = store.send(bee.id, String(request.args.body)); return { commandId: sent.wakeCommand?.id ?? null, result: { messageId: sent.message.id } }; }
    const command = store.enqueueCommand("archive", bee.id, {}, { idempotencyKey: request.idempotencyKey });
    return { commandId: command.id, result: { commandId: command.id } };
  });
  const advance = () => { const next = { ...claim, generation: 2, claimId: "claim-2" }; store.compareAndSetExecutionClaim({ transitionId: "advance-2", expectedClaim: claim, claim: next }, 1000); return next; };
  return { h, store, bee, claim, request, execute, advance, transition, cleanup() { store.close(); h.cleanup(); } };
}

test("execution claim CAS is authenticated, exact-replayable and bound to coverage", () => {
  const f = setup();
  try {
    assert.deepEqual(f.store.compareAndSetExecutionClaim(f.transition, 1000), f.claim);
    assert.throws(() => f.store.registerExecutionCoordinator(f.claim.issuerId, 1001), code("caller_not_trusted"));
    assert.throws(() => f.store.compareAndSetExecutionClaim(f.transition, 1001), code("caller_not_trusted"));
    assert.throws(() => f.store.compareAndSetExecutionClaim({ ...f.transition, claim: { ...f.claim, claimId: "conflict" } }, 1000), code("idempotency_conflict"));
    assert.throws(() => f.store.compareAndSetExecutionClaim({ ...f.transition, transitionId: "wrong", expectedClaim: f.claim }, 1000), code("rpc_execution_stale"));
    assert.throws(() => f.store.compareAndSetExecutionClaim({ ...f.transition, transitionId: "old", claim: { ...f.claim, coverageId: "old" } }, 1000), code("rpc_execution_history_unknown"));
  } finally { f.cleanup(); }
});

test("send execution binds exact immutable request and key, commits mailbox once, and cannot revoke delivery", () => {
  const f = setup("send");
  try {
    const sent = f.execute();
    assert.equal(sent.status, "completed");
    assert.deepEqual(f.execute(), sent);
    assert.equal(f.store.listMessages(f.bee.id).length, 1);
    assert.throws(() => f.execute({ ...f.request, args: { ...f.request.args, body: "changed" } }), code("invalid_request"));
    f.advance();
    assert.deepEqual(f.execute(), sent);
    assert.throws(() => f.execute({ ...f.request, executionFence: { ...f.request.executionFence, generation: 2, claimId: "claim-2" } }), code("rpc_execution_stale"));
  } finally { f.cleanup(); }
});

test("claim advancement refuses stale queued archive as a side receipt and settled no-op", () => {
  const f = setup();
  try {
    const receipt = f.execute();
    f.advance();
    assert.equal(f.store.getCommand(receipt.commandId!)?.status, "done");
    const resolved = f.store.resolveExecution(f.request, 1000);
    assert.ok("executionReceipt" in resolved);
    assert.equal(resolved.executionReceipt.status, "refused_stale");
    assert.equal(f.store.getBee(f.bee.id)?.lifecycle, "active");
    assert.equal(f.store.auditTail(0, 1000).some(row => row.kind === "rpc.execution.refused_stale"), true);
  } finally { f.cleanup(); }
});

test("claimed archive blocks advancement until its lifecycle transaction completes", () => {
  const f = setup();
  try {
    const receipt = f.execute();
    let command;
    while ((command = f.store.claimNextCommand()) && command.id !== receipt.commandId) f.store.completeCommand(command.id);
    assert.equal(command?.id, receipt.commandId);
    assert.throws(f.advance, code("rpc_execution_busy"));
    assert.equal(f.store.executeArchiveCommand(command!.id), true);
    f.store.completeCommand(command!.id);
    assert.equal(f.store.getBee(f.bee.id)?.lifecycle, "archived");
    const resolved = f.store.resolveExecution(f.request, 1000);
    assert.ok("executionReceipt" in resolved); assert.equal(resolved.executionReceipt.status, "completed");
    f.advance();
  } finally { f.cleanup(); }
});

test("registered key cannot execute through legacy send or archive; rollback drops all effects", () => {
  const f = setup();
  try {
    assert.throws(() => f.store.enqueueCommand("archive", f.bee.id, {}, { idempotencyKey: f.claim.idempotencyKey }), code("rpc_execution_fence_unsupported"));
    assert.throws(() => f.store.transact(() => { f.store.send(f.bee.id, "legacy"); f.store.recordRpcResult(f.claim.idempotencyKey, "send", null, {}); }), code("rpc_execution_fence_unsupported"));
    assert.equal(f.store.listMessages(f.bee.id).length, 0);
    assert.throws(() => f.store.executeWithFence(f.request, 1000, () => { f.store.send(f.bee.id, "rollback"); throw new Error("fault"); }), /fault/);
    assert.equal(f.store.listMessages(f.bee.id).length, 0);
    assert.equal(f.store.resolveEffect(f.claim.idempotencyKey, "archive").status, "never_seen_fenced");
    assert.throws(f.execute, (error: unknown) => (error as {code?: string}).code === "rpc_effect_fenced");
  } finally { f.cleanup(); }
});

test("every reopen retires queued execution; command claim refuses and positive receipts stay queryable", () => {
  const f = setup(), receipt = f.execute();
  f.store.close();
  const store = f.h.open();
  try {
    let cmd;
    while ((cmd = store.claimNextCommand())) store.completeCommand(cmd.id);
    assert.equal(store.getCommand(receipt.commandId!)?.status, "done");
    assert.equal(store.getBee(f.bee.id)?.lifecycle, "active");
    const resolved = store.resolveExecution(f.request, 1000); assert.ok("executionReceipt" in resolved); assert.equal(resolved.executionReceipt.status, "refused_stale");
  } finally { store.close(); f.h.cleanup(); }
});

test("archive lifecycle transaction rechecks the live grant after command claim", () => {
  const f = setup(), receipt = f.execute();
  const db = (f.store as unknown as { db: DatabaseSync }).db;
  try {
    let command;
    while ((command = f.store.claimNextCommand()) && command.id !== receipt.commandId) f.store.completeCommand(command.id);
    db.prepare("UPDATE rpc_execution_claims SET claim=?").run(JSON.stringify({ ...f.claim, generation: 2, claimId: "out-of-band" }));
    assert.equal(f.store.executeArchiveCommand(receipt.commandId!), false);
    assert.equal(f.store.getBee(f.bee.id)?.lifecycle, "active");
    const resolved = f.store.resolveExecution(f.request, 1000); assert.ok("executionReceipt" in resolved); assert.equal(resolved.executionReceipt.status, "refused_stale");
  } finally { f.cleanup(); }
});

test("paused old invocation refuses after owner ACK, records zero-effect receipt, and replacement keeps original key", () => {
  const f = setup();
  try {
    const next = f.advance();
    assert.throws(f.execute, error => code("rpc_execution_stale")(error) && (error as ExecutionFenceError).details?.executionReceipt !== undefined);
    assert.equal(f.store.getCommandByIdempotencyKey(f.claim.idempotencyKey), null);
    assert.equal(f.store.getBee(f.bee.id)?.lifecycle, "active");
    const observed = f.store.resolveExecution(f.request, 1000); assert.ok("executionReceipt" in observed); assert.equal(observed.executionReceipt.status, "refused_stale");
    const { digestVersion, verb, resource, requestDigest, idempotencyKey, ...executionFence } = next;
    const replacement = f.execute({ digestVersion, verb, resource, requestDigest, idempotencyKey, executionFence, args: f.request.args });
    assert.equal(replacement.idempotencyKey, f.claim.idempotencyKey);
    assert.equal(replacement.generation, 2);
    assert.equal(replacement.status, "queued");
  } finally { f.cleanup(); }
});

test("archive lifecycle commit before command settlement cannot rearchive after restart and manual unarchive", () => {
  const f = setup(), receipt = f.execute();
  let command;
  while ((command = f.store.claimNextCommand()) && command.id !== receipt.commandId) f.store.completeCommand(command.id);
  assert.equal(f.store.executeArchiveCommand(receipt.commandId!), true);
  f.store.unarchiveBee(f.bee.id);
  f.store.close();
  const store = f.h.open();
  try {
    while ((command = store.claimNextCommand())) store.completeCommand(command.id);
    assert.equal(store.getBee(f.bee.id)?.lifecycle, "active");
    assert.equal(store.getCommand(receipt.commandId!)?.status, "done");
    const observed = store.resolveExecution(f.request, 1000); assert.ok("executionReceipt" in observed); assert.equal(observed.executionReceipt.status, "completed");
  } finally { store.close(); f.h.cleanup(); }
});

test("a legacy command on an execution-reserved key with missing binding is held, never executed", () => {
  const f = setup();
  try {
    const cmd = f.store.enqueueCommand("archive", f.bee.id);
    const db = (f.store as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE commands SET idempotency_key=? WHERE id=?").run(f.claim.idempotencyKey, cmd.id);
    assert.throws(() => f.store.claimNextCommand(), code("rpc_execution_history_unknown"));
    assert.equal(f.store.getCommand(cmd.id)?.status, "queued");
    assert.equal(f.store.getBee(f.bee.id)?.lifecycle, "active");
  } finally { f.cleanup(); }
});
