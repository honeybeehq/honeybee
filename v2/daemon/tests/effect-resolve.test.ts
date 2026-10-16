import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { RpcServer, type RpcDispatch } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type SpawnResult } from "../src/protocol.ts";

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "effect-rpc-")), path = join(dir, "core.sqlite3");
  let store = openCoreStore(path, { ephemeral: true, maxRpcIdempotencyRows: 2 });
  const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
  Object.assign(owner, { cfg: { dataDir: dir, logPath: join(dir, "log"), agents: { stub: { adapter: "stub" } } }, store, stopping: false, opLog: [], deps: {}, refusedClaims: new Map() });
  const calls: string[] = [];
  const server = new RpcServer({ socketPath: join(dir, "s"), log() {}, dispatch: (verb, params, conn) => { calls.push(verb); return (owner.dispatch as RpcDispatch).call(owner, verb, params, conn); } });
  await server.listen();
  const client = await RpcClient.connect(join(dir, "s"));
  t.after(async () => { client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { client, owner, calls, get store() { return store; }, reopen() { store.close(); store = openCoreStore(path, { ephemeral: true }); owner.store = store; } };
}
const refusal = (code: string) => (value: unknown) => value instanceof RpcError && value.code === code;

test("effect RPC commits spawn/send/archive once and resolves despite cache pruning and reopen", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage();
  const key = (id: string) => `effect-v1:${coverage.coverageId}:${id}`;
  const first = await f.client.request<SpawnResult>("spawn", { name: "one", agent: "stub", account: null, cwd: tmpdir(), prompt: "once", idempotencyKey: key("spawn") });
  const replay = await f.client.request<SpawnResult>("spawn", { name: "one", agent: "stub", account: null, cwd: tmpdir(), prompt: "once", idempotencyKey: key("spawn") });
  assert.equal(first.beeId, replay.beeId);
  const sent = await f.client.request("send", { beeId: first.beeId, body: "mail", idempotencyKey: key("send") });
  const archive = await f.client.request("archive", { beeId: first.beeId, idempotencyKey: key("archive") });
  for (const verb of ["spawn", "send", "archive"] as const) {
    const resolution = await f.client.resolveEffect(verb, key(verb), coverage);
    assert.equal(resolution.status, "committed");
    if (resolution.status === "committed") assert.deepEqual(resolution.receipt.result, { spawn: first, send: sent, archive }[verb]);
  }
  assert.equal(f.store.listMessages(first.beeId).length, 2);
  f.reopen();
  const next = await f.client.effectCoverage();
  assert.notEqual(next.coverageId, coverage.coverageId);
  assert.equal((await f.client.resolveEffect("send", key("send"), next)).status, "committed");
  const again = await f.client.request("send", { beeId: first.beeId, body: "mail", idempotencyKey: key("send") });
  assert.equal((again as { deduped: boolean }).deduped, true);
  assert.equal(f.store.listMessages(first.beeId).length, 2);
});

test("effect RPC fences late spawn send archive before effects and holds retired negatives", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage();
  const { bee } = f.store.createBee({ name: "target", agent: "stub", substrate: "hsr", cwd: tmpdir() });
  const before = f.store.dumpState();
  for (const verb of ["spawn", "send", "archive"] as const) {
    const idempotencyKey = `effect-v1:${coverage.coverageId}:${verb}`;
    assert.equal((await f.client.resolveEffect(verb, idempotencyKey, coverage)).status, "never_seen_fenced");
    const params = verb === "spawn" ? { name: "late", agent: "stub", account: null, cwd: tmpdir() } : { beeId: bee.id, body: "late" };
    await assert.rejects(f.client.request(verb, { ...params, idempotencyKey }), refusal("rpc_effect_fenced"));
    assert.equal((await f.client.resolveEffect(verb, idempotencyKey, coverage)).status, "never_seen_fenced");
  }
  assert.deepEqual(f.store.dumpState(), before);
  f.reopen();
  await assert.rejects(f.client.resolveEffect("spawn", `effect-v1:${coverage.coverageId}:spawn`, await f.client.effectCoverage()), refusal("rpc_effect_history_unknown"));
});

test("effect RPC registers before the actual account freshness await, joins exact replay, then commits", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage();
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.owner.accounts = { allocationMode: () => "shadow", async ensureFreshAdmissionLimits() { entered(); await wait; }, isolationRefusal: () => null };
  const key = `effect-v1:${coverage.coverageId}:pending`, params = { name: "pending", agent: "stub", cwd: tmpdir(), idempotencyKey: key };
  const pending = f.client.request<SpawnResult>("spawn", params);
  await seen;
  assert.equal((await f.client.resolveEffect("spawn", key, coverage)).status, "in_flight");
  const duplicate = f.client.request<SpawnResult>("spawn", params);
  await assert.rejects(f.client.request("spawn", { ...params, name: "other" }), refusal("idempotency_conflict"));
  release();
  assert.equal((await pending).beeId, (await duplicate).beeId);
  assert.equal((await f.client.resolveEffect("spawn", key, coverage)).status, "committed");
  assert.equal(f.store.listBees().length, 1);
});

test("effect RPC missing capability fails locally without sending a resolver frame", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage(), calls = f.calls.length;
  f.client.capabilities = [];
  await assert.rejects(f.client.resolveEffect("send", "legacy", coverage), refusal("rpc_effect_resolve_unsupported"));
  await assert.rejects(f.client.effectCoverage(), refusal("rpc_effect_resolve_unsupported"));
  assert.equal(f.calls.length, calls);
});
