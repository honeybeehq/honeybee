import type { JsonValue } from "../../../src/comb/canonical.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { executionRequestDigest, type ExecutionClaim, type ExecutionReceipt } from "../../core/src/executionFence.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { RpcServer, toRpcError, type RpcDispatch } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { PROTOCOL, RpcError } from "../src/protocol.ts";

const code = (code: string) => (error: unknown) => error instanceof RpcError && error.code === code;
async function rawRequest(path: string, verb: string): Promise<{ error: { code: string } }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let buffer = "", hello = false;
    socket.setEncoding("utf8"); socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("raw RPC timeout")); });
    socket.on("error", reject);
    socket.on("data", data => {
      buffer += data;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n"), frame = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
        if (!hello) { hello = true; socket.write(JSON.stringify({ protocol: PROTOCOL }) + "\n" + JSON.stringify({ id: 1, verb, params: {} }) + "\n"); }
        else if (frame.id === 1) { socket.destroy(); resolve(frame); }
      }
    });
  });
}
async function fixture(t: TestContext, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "exec-rpc-")), keyFile = join(root, "private", "key"), store = openCoreStore(join(root, "core.sqlite3"), { ephemeral: true });
  const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
  Object.assign(owner, { cfg: { dataDir: root, logPath: join(root, "log"), agents: { stub: { adapter: "stub" } } }, store, stopping: false, opLog: [], deps: {}, refusedClaims: new Map(), requestTick() {} });
  const calls: string[] = [];
  const server = new RpcServer({ socketPath: join(root, "s"), dataDir: root, localTrust: { requireObservationCaller: enabled, registrationKeyFile: keyFile }, log() {}, dispatch: (verb, params, conn) => { calls.push(verb); return (owner.dispatch as RpcDispatch).call(owner, verb, params, conn); } });
  await server.listen();
  const client = await RpcClient.connect(join(root, "s")), clients = [client];
  t.after(async () => { clients.forEach(client => client.close()); await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  const register = async () => store.registerExecutionCoordinator("project-home", process.geteuid!());
  const internal = { request: async <T = unknown>(verb: Parameters<RpcDispatch>[0], params: Record<string, unknown>) => {
    try { return (owner.rpcExecution as RpcDispatch).call(owner, verb, params, { executionCoordinatorUid: process.geteuid!() } as Parameters<RpcDispatch>[2]) as T; }
    catch (error) { const wire = toRpcError(error); throw new RpcError(wire.code, wire.message, wire.details); }
  } };
  const plan = async (verb: "send" | "archive", suffix: string = verb) => {
    const { bee } = store.createBee({ name: suffix, agent: "stub", substrate: "hsr", cwd: root }), resource = { beeId: bee.id };
    const args: Record<string, JsonValue> = verb === "send" ? { beeId: bee.id, body: "once" } : { beeId: bee.id };
    const claim: ExecutionClaim = { version: 1, issuerId: "project-home", continuationId: suffix, grantDigest: "sha256:" + "a".repeat(64), generation: 1, claimId: "claim-1", ...store.effectCoverage(), digestVersion: 1, verb, resource, requestDigest: executionRequestDigest(verb, resource, args), idempotencyKey: `effect-v1:${store.effectCoverage().coverageId}:${suffix}` };
    const { digestVersion, verb: v, resource: r, requestDigest, idempotencyKey, ...executionFence } = claim;
    const request = { digestVersion, verb: v, resource: r, requestDigest, idempotencyKey, executionFence, args };
    await internal.request("rpc.execution.claim.compareAndSet", { transitionId: suffix, expectedClaim: null, claim });
    return { request, claim, bee };
  };
  return { client, internal, clients, register, plan, store, calls, root };
}

test("execution capability is phase-scoped, disabled without trust, and rejects spawn without fallback", async t => {
  const off = await fixture(t, false);
  assert.equal(off.client.capabilities.includes("rpc-execution-fence.archive-send.v1"), false);
  assert.equal(off.client.capabilities.includes("rpc-execution-fence.v1"), false);
  await assert.rejects(off.internal.request("rpc.execution.execute", { verb: "spawn" }), code("rpc_execution_fence_unsupported"));
  assert.equal(off.calls.length, 0);
  const on = await fixture(t);
  assert.equal(on.client.capabilities.includes("rpc-execution-fence.archive-send.v1"), false);
  assert.equal(on.client.capabilities.includes("rpc-execution-fence.v1"), false);
  await on.register();
  const before = on.store.dumpState();
  await assert.rejects(on.client.request("rpc.execution.execute", { verb: "spawn" }), code("rpc_execution_fence_unsupported"));
  assert.deepEqual(on.store.dumpState(), before);
});

test("dark wire refuses every execution verb regardless of local trust configuration or relay", async t => {
  const f = await fixture(t); await f.register();
  const clients = [f.client];
  for (const lane of ["remote", "node_relay"] as const) { const client = await RpcClient.connect(join(f.root, "s"), 1000, lane); f.clients.push(client); clients.push(client); }
  const before = f.store.dumpState();
  for (const client of clients) for (const verb of ["rpc.execution.coordinator.register", "rpc.execution.claim.compareAndSet", "rpc.execution.execute", "rpc.execution.resolve"] as const) {
    await assert.rejects(client.request(verb, { issuerId: "project-home" }), code("rpc_execution_fence_unsupported"));
    const response = await rawRequest(join(f.root, "s"), verb);
    assert.equal(response.error.code, "rpc_execution_fence_unsupported");
  }
  assert.deepEqual(f.store.dumpState(), before);
  assert.equal(f.calls.filter(verb => verb.startsWith("rpc.execution.")).length, 0);
});

test("dormant internal owner: execution send is mailbox admission only; exact replay observes and changed args conflict", async t => {
  const f = await fixture(t); await f.register(); const p = await f.plan("send");
  const response = await f.internal.request<{ executionReceipt: ExecutionReceipt; admissionReceipt: { key: string } }>("rpc.execution.execute", p.request);
  assert.equal(response.executionReceipt.status, "completed"); assert.equal(response.executionReceipt.boundary, "mailbox-admission");
  assert.equal(response.admissionReceipt.key, p.request.idempotencyKey);
  assert.deepEqual(await f.internal.request("rpc.execution.execute", p.request), response);
  assert.equal(f.store.listMessages(p.bee.id).length, 1);
  const args = { ...p.request.args, body: "other" };
  await assert.rejects(f.internal.request("rpc.execution.execute", { ...p.request, args, requestDigest: executionRequestDigest("send", p.request.resource, args) }), code("idempotency_conflict"));
  await assert.rejects(f.internal.request("rpc.execution.execute", { ...p.request, executionFence: { ...p.request.executionFence, generation: 2 } }), code("rpc_execution_stale"));
});

test("dormant internal owner: execution archive revocation gives typed stale receipt without lifecycle mutation", async t => {
  const f = await fixture(t); await f.register(); const p = await f.plan("archive");
  const response = await f.internal.request<{ executionReceipt: ExecutionReceipt }>("rpc.execution.execute", p.request);
  assert.equal(response.executionReceipt.status, "queued");
  await f.internal.request("rpc.execution.claim.compareAndSet", { transitionId: "revoke", expectedClaim: p.claim, claim: { ...p.claim, generation: 2, claimId: "claim-2" } });
  await assert.rejects(f.internal.request("rpc.execution.execute", p.request), error => code("rpc_execution_stale")(error) && (error as RpcError).details?.executionReceipt !== undefined);
  const resolved = await f.internal.request<{ executionReceipt: ExecutionReceipt }>("rpc.execution.resolve", p.request);
  assert.equal(resolved.executionReceipt.status, "refused_stale");
  assert.equal(f.store.getBee(p.bee.id)?.lifecycle, "active");
});

test("dormant internal owner: execution resolve is read-only; only explicit effect.resolve fences a never-seen key", async t => {
  const f = await fixture(t); await f.register(); const p = await f.plan("archive");
  const before = f.store.auditTail(0, 1000);
  await assert.rejects(f.internal.request("rpc.execution.resolve", p.request), code("rpc_effect_history_unknown"));
  assert.deepEqual(f.store.auditTail(0, 1000), before);
  const first = await f.internal.request<{ executionReceipt: ExecutionReceipt }>("rpc.execution.execute", p.request);
  assert.equal(first.executionReceipt.status, "queued");
  const late = await f.plan("archive", "late");
  await f.client.resolveEffect("archive", late.request.idempotencyKey, f.store.effectCoverage());
  const resolution = await f.internal.request<{ status: string }>("rpc.execution.resolve", late.request);
  assert.equal(resolution.status, "never_seen_fenced");
  await assert.rejects(f.internal.request("rpc.execution.execute", late.request), code("rpc_effect_fenced"));
});
