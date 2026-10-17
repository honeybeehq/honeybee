import type { JsonValue } from "../../../src/comb/canonical.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { executionRequestDigest, type ExecutionClaim, type ExecutionReceipt } from "../../core/src/executionFence.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { RpcServer, type RpcDispatch } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";

const code = (code: string) => (error: unknown) => error instanceof RpcError && error.code === code;
async function fixture(t: TestContext, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "exec-rpc-")), keyFile = join(root, "private", "key"), store = openCoreStore(join(root, "core.sqlite3"), { ephemeral: true });
  const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
  Object.assign(owner, { cfg: { dataDir: root, logPath: join(root, "log"), agents: { stub: { adapter: "stub" } } }, store, stopping: false, opLog: [], deps: {}, refusedClaims: new Map(), requestTick() {} });
  const calls: string[] = [];
  const server = new RpcServer({ socketPath: join(root, "s"), dataDir: root, localTrust: { requireObservationCaller: enabled, registrationKeyFile: keyFile }, log() {}, dispatch: (verb, params, conn) => { calls.push(verb); return (owner.dispatch as RpcDispatch).call(owner, verb, params, conn); } });
  await server.listen();
  const client = await RpcClient.connect(join(root, "s")), clients = [client];
  t.after(async () => { clients.forEach(client => client.close()); await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const register = async () => {
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile), token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    return client.request("rpc.execution.coordinator.register", { issuerId: "project-home" });
  };
  const plan = async (verb: "send" | "archive", suffix = verb) => {
    const { bee } = store.createBee({ name: suffix, agent: "stub", substrate: "hsr", cwd: root }), resource = { beeId: bee.id };
    const args: Record<string, JsonValue> = verb === "send" ? { beeId: bee.id, body: "once" } : { beeId: bee.id };
    const claim: ExecutionClaim = { version: 1, issuerId: "project-home", continuationId: suffix, grantDigest: "sha256:" + "a".repeat(64), generation: 1, claimId: "claim-1", ...store.effectCoverage(), digestVersion: 1, verb, resource, requestDigest: executionRequestDigest(verb, resource, args), idempotencyKey: `effect-v1:${store.effectCoverage().coverageId}:${suffix}` };
    const { digestVersion, verb: v, resource: r, requestDigest, idempotencyKey, ...executionFence } = claim;
    const request = { digestVersion, verb: v, resource: r, requestDigest, idempotencyKey, executionFence, args };
    await client.request("rpc.execution.claim.compareAndSet", { transitionId: suffix, expectedClaim: null, claim });
    return { request, claim, bee };
  };
  return { client, clients, register, plan, store, calls, root };
}

test("execution capability is phase-scoped, disabled without trust, and rejects spawn without fallback", async t => {
  const off = await fixture(t, false);
  assert.equal(off.client.capabilities.includes("rpc-execution-fence.archive-send.v1"), false);
  assert.equal(off.client.capabilities.includes("rpc-execution-fence.v1"), false);
  await assert.rejects(off.client.request("rpc.execution.execute", { verb: "spawn" }), code("rpc_execution_fence_unsupported"));
  assert.equal(off.calls.length, 0);
  const on = await fixture(t);
  assert.equal(on.client.capabilities.includes("rpc-execution-fence.archive-send.v1"), true);
  assert.equal(on.client.capabilities.includes("rpc-execution-fence.v1"), false);
  await on.register();
  const before = on.store.dumpState();
  await assert.rejects(on.client.request("rpc.execution.execute", { verb: "spawn" }), code("rpc_execution_fence_unsupported"));
  assert.deepEqual(on.store.dumpState(), before);
});

test("execution installation requires registered peer, issuer binding, and refuses relay identity spoofing", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.request("rpc.execution.coordinator.register", { issuerId: "project-home" }), code("caller_not_trusted"));
  await f.register();
  const p = await f.plan("send");
  for (const lane of ["remote", "node_relay"] as const) {
    const client = await RpcClient.connect(join(f.root, "s"), 1000, lane); f.clients.push(client);
    await assert.rejects(client.request("rpc.execution.claim.compareAndSet", { transitionId: "spoof", expectedClaim: p.claim, claim: { ...p.claim, generation: 2, claimId: "claim-2" } }), code("rpc_execution_fence_unsupported"));
  }
  await assert.rejects(f.client.request("rpc.execution.claim.compareAndSet", { transitionId: "other", expectedClaim: null, claim: { ...p.claim, issuerId: "unregistered" } }), code("caller_not_trusted"));
});

test("execution send is mailbox admission only; exact replay observes and changed args conflict", async t => {
  const f = await fixture(t); await f.register(); const p = await f.plan("send");
  const response = await f.client.request<{ executionReceipt: ExecutionReceipt; admissionReceipt: { key: string } }>("rpc.execution.execute", p.request);
  assert.equal(response.executionReceipt.status, "completed"); assert.equal(response.executionReceipt.boundary, "mailbox-admission");
  assert.equal(response.admissionReceipt.key, p.request.idempotencyKey);
  assert.deepEqual(await f.client.request("rpc.execution.execute", p.request), response);
  assert.equal(f.store.listMessages(p.bee.id).length, 1);
  const args = { ...p.request.args, body: "other" };
  await assert.rejects(f.client.request("rpc.execution.execute", { ...p.request, args, requestDigest: executionRequestDigest("send", p.request.resource, args) }), code("idempotency_conflict"));
  await assert.rejects(f.client.request("rpc.execution.execute", { ...p.request, executionFence: { ...p.request.executionFence, generation: 2 } }), code("rpc_execution_stale"));
});

test("execution archive revocation gives typed stale receipt without lifecycle mutation", async t => {
  const f = await fixture(t); await f.register(); const p = await f.plan("archive");
  const response = await f.client.request<{ executionReceipt: ExecutionReceipt }>("rpc.execution.execute", p.request);
  assert.equal(response.executionReceipt.status, "queued");
  await f.client.request("rpc.execution.claim.compareAndSet", { transitionId: "revoke", expectedClaim: p.claim, claim: { ...p.claim, generation: 2, claimId: "claim-2" } });
  await assert.rejects(f.client.request("rpc.execution.execute", p.request), error => code("rpc_execution_stale")(error) && (error as RpcError).details?.executionReceipt !== undefined);
  const resolved = await f.client.request<{ executionReceipt: ExecutionReceipt }>("rpc.execution.resolve", p.request);
  assert.equal(resolved.executionReceipt.status, "refused_stale");
  assert.equal(f.store.getBee(p.bee.id)?.lifecycle, "active");
});

test("execution resolve is read-only; only explicit effect.resolve fences a never-seen key", async t => {
  const f = await fixture(t); await f.register(); const p = await f.plan("archive");
  const before = f.store.auditTail(0, 1000);
  await assert.rejects(f.client.request("rpc.execution.resolve", p.request), code("rpc_effect_history_unknown"));
  assert.deepEqual(f.store.auditTail(0, 1000), before);
  const first = await f.client.request<{ executionReceipt: ExecutionReceipt }>("rpc.execution.execute", p.request);
  assert.equal(first.executionReceipt.status, "queued");
  const late = await f.plan("archive", "late");
  await f.client.resolveEffect("archive", late.request.idempotencyKey, f.store.effectCoverage());
  const resolution = await f.client.request<{ status: string }>("rpc.execution.resolve", late.request);
  assert.equal(resolution.status, "never_seen_fenced");
  await assert.rejects(f.client.request("rpc.execution.execute", late.request), code("rpc_effect_fenced"));
});
