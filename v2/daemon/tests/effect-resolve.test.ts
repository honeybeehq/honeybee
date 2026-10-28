import { EFFECT_RESULT_REQUIRED_FIELDS, type EffectVerb } from "../../core/src/effectResolve.ts";
import { executionRequestDigest, type ExecutionClaim } from "../../core/src/executionFence.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { IdentityRecovery } from "../src/identityRecovery.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { RpcServer, type RpcDispatch } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type SpawnResult, type SendRpcResult, type MutationResult } from "../src/protocol.ts";

type RequiredFields<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type WriterResults = { spawn: SpawnResult; send: SendRpcResult; archive: MutationResult };
const writerFieldCoverage: { [V in EffectVerb]: Exclude<RequiredFields<WriterResults[V]>, keyof typeof EFFECT_RESULT_REQUIRED_FIELDS[V]> extends never ? true : false } = { spawn: true, send: true, archive: true };
function assertWriterResult(verb: EffectVerb, value: unknown): void {
  assert.equal(writerFieldCoverage[verb], true);
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  for (const [field, type] of Object.entries(EFFECT_RESULT_REQUIRED_FIELDS[verb])) {
    assert.ok(Object.hasOwn(value, field), `${verb} writer missing ${field}`);
    const entry: unknown = (value as Record<string, unknown>)[field];
    if (type === "nonempty-string") assert.ok(typeof entry === "string" && entry.length > 0);
    else if (type === "boolean") assert.equal(typeof entry, "boolean");
    else if (entry !== null || type !== "command-id-or-null") assert.ok(typeof entry === "number" && Number.isSafeInteger(entry) && entry > 0);
  }
}

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "effect-rpc-")), path = join(dir, "core.sqlite3");
  let store = openCoreStore(path, { ephemeral: true, maxRpcIdempotencyRows: 2 });
  const owner = Object.create(HiveDaemon.prototype) as Record<string, unknown>;
  Object.assign(owner, { cfg: { dataDir: dir, logPath: join(dir, "log"), agents: { stub: { adapter: "stub" } } }, store, stopping: false, opLog: [], deps: {}, refusedClaims: new Map(), identityRecovery: new IdentityRecovery(), secretExecutions: new Map() });
  const calls: string[] = [];
  const server = new RpcServer({ socketPath: join(dir, "s"), log() {}, dispatch: (verb, params, conn) => { calls.push(verb); return (owner.dispatch as RpcDispatch).call(owner, verb, params, conn); } });
  await server.listen();
  const client = await RpcClient.connect(join(dir, "s"));
  t.after(async () => { client.close(); await server.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { client, owner, calls, get store() { return store; }, reopen() { store.close(); store = openCoreStore(path, { ephemeral: true }); owner.store = store; } };
}
const refusal = (code: string) => (value: unknown) => value instanceof RpcError && value.code === code;

test("dark fenced-spawn production writer satisfies the shared effect-result contract", async t => {
  const f = await fixture(t), uid = process.geteuid!();
  const args = { id: "fenced-writer", name: "fenced-writer", agent: "stub", substrate: "hsr", cwd: tmpdir(), account: null };
  const resource = { beeId: args.id }, coverage = f.store.effectCoverage();
  const claim: ExecutionClaim = { version: 1, issuerId: "writer-project", continuationId: "spawn", claimId: "one", generation: 1, grantDigest: "sha256:" + "a".repeat(64), ...coverage, digestVersion: 1, verb: "spawn", resource, requestDigest: executionRequestDigest("spawn", resource, args), idempotencyKey: `effect-v1:${coverage.coverageId}:fenced-writer` };
  f.store.registerExecutionCoordinator(claim.issuerId, uid);
  f.store.compareAndSetExecutionClaim({ transitionId: "one", expectedClaim: null, claim }, uid);
  const { verb, resource: target, digestVersion, requestDigest, idempotencyKey, ...executionFence } = claim;
  const request = { verb, resource: target, digestVersion, requestDigest, idempotencyKey, executionFence, args };
  const invoke = () => (f.owner.rpcFencedSpawn as (params: Record<string, unknown>, conn: Parameters<RpcDispatch>[2]) => Promise<{ admissionReceipt: { result: unknown; commandId: number | null }; executionReceipt: { result: unknown } }>).call(f.owner, request, { executionCoordinatorUid: uid } as Parameters<RpcDispatch>[2]);
  const first = await invoke();
  assertWriterResult("spawn", first.admissionReceipt.result);
  assertWriterResult("spawn", first.executionReceipt.result);
  const produced = first.admissionReceipt.result as SpawnResult;
  assert.equal(produced.beeId, args.id);
  assert.equal(produced.commandId, first.admissionReceipt.commandId);
  assert.ok(produced.commandId !== null && Number.isSafeInteger(produced.commandId) && produced.commandId > 0);
  const resolved = f.store.resolveEffect(idempotencyKey, "spawn");
  assert.equal(resolved.status, "committed");
  if (resolved.status === "committed") assert.deepEqual(resolved.receipt.result, produced);
  assert.deepEqual(await invoke(), first);
  assert.equal(f.store.listBees().length, 1);
});

test("effect RPC commits spawn/send/archive once and resolves despite cache pruning and reopen", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage();
  const key = (id: string) => `effect-v1:${coverage.coverageId}:${id}`;
  const first = await f.client.request<SpawnResult>("spawn", { name: "one", agent: "stub", account: null, cwd: tmpdir(), prompt: "once", idempotencyKey: key("spawn") });
  const replay = await f.client.request<SpawnResult>("spawn", { name: "one", agent: "stub", account: null, cwd: tmpdir(), prompt: "once", idempotencyKey: key("spawn") });
  assert.equal(first.beeId, replay.beeId);
  const sent = await f.client.request("send", { beeId: first.beeId, body: "mail", idempotencyKey: key("send") });
  const archive = await f.client.request("archive", { beeId: first.beeId, idempotencyKey: key("archive") });
  for (const verb of ["spawn", "send", "archive"] as const) {
    assertWriterResult(verb, { spawn: first, send: sent, archive }[verb]);
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

test("legacy effect RPC rejects changed in-flight args but replays changed args after commit and reopen", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage();
  let entered!: () => void, release!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  f.owner.accounts = { allocationMode: () => "shadow", async ensureFreshAdmissionLimits() { entered(); await wait; }, isolationRefusal: () => null };
  const key = `effect-v1:${coverage.coverageId}:pending`, params = { name: "pending", agent: "stub", cwd: tmpdir(), prompt: "original prompt", idempotencyKey: key };
  const pending = f.client.request<SpawnResult>("spawn", params);
  await seen;
  assert.equal((await f.client.resolveEffect("spawn", key, coverage)).status, "in_flight");
  const duplicate = f.client.request<SpawnResult>("spawn", params);
  const differentPeer = (f.owner.rpcSpawnEffect as (params: Record<string, unknown>) => Promise<SpawnResult>).call(f.owner, {
    ...params, spawnProvenance: { callerBeeId: null, authority: "unattributed", peerPid: process.pid + 1 },
  });
  await assert.rejects(f.client.request("spawn", { ...params, name: "other" }), refusal("idempotency_conflict"));
  release();
  const original = await pending, joined = await duplicate;
  assert.equal(original.beeId, joined.beeId);
  assert.equal(joined.deduped, true);
  assert.equal((await differentPeer).beeId, original.beeId);
  assert.equal((await differentPeer).deduped, true);
  assert.equal((await f.client.resolveEffect("spawn", key, coverage)).status, "committed");
  assert.equal(f.store.listBees().length, 1);
  const replayArgs = { ...params, name: "ignored-after-commit", parentExternal: false, prompt: undefined };
  assert.equal((await f.client.request<SpawnResult>("spawn", replayArgs)).beeId, original.beeId);
  f.reopen();
  assert.equal((await f.client.request<SpawnResult>("spawn", replayArgs)).beeId, original.beeId);

});

test("effect RPC missing capability fails locally without sending a resolver frame", async t => {
  const f = await fixture(t), coverage = await f.client.effectCoverage(), calls = f.calls.length;
  f.client.capabilities = [];
  await assert.rejects(f.client.resolveEffect("send", "legacy", coverage), refusal("rpc_effect_resolve_unsupported"));
  await assert.rejects(f.client.effectCoverage(), refusal("rpc_effect_resolve_unsupported"));
  assert.equal(f.calls.length, calls);
});
