import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { HiveDaemon } from "../src/daemon.ts";
import { openCoreStore, type CoreStore } from "../../core/src/store.ts";
import { externalFixture, externalReceipt } from "../../core/tests/fixtures/externalExec.ts";
import type { ExternalExecConfig } from "../../core/src/externalExec.ts";
import type { RpcConn, RpcDispatch } from "../src/rpc.ts";
import { RpcError, type SpawnResult } from "../src/protocol.ts";

test("daemon external admission is atomic, workspace gated, immutable and credential independent", () => {
  const binding = externalFixture();
  const config: ExternalExecConfig = { bridges: { "urbench-v2": binding.registration }, workspaces: { ur: { capabilities: ["external-exec.v1"], bridges: ["urbench-v2"] } } };
  const store = openCoreStore(":memory:", { ephemeral: true });
  const daemon = Object.create(HiveDaemon.prototype) as { cfg: { externalExec: ExternalExecConfig }; store: CoreStore; stopping: boolean; dispatch: RpcDispatch; externalDispatches: Map<string, unknown>; settleExternal(beeId: string, generation: number, receipt: unknown, truncated?: boolean): void };
  daemon.cfg = { externalExec: config }; daemon.store = store; daemon.stopping = false;
  const conn: RpcConn = { ingress: "local_unix", externalExecWorkspace: "ur", send() {}, subscribeWatch() {}, alignWatch() {} };
  const params = { name: "isolated", agent: "external-exec-v1", bridgeId: "urbench-v2", dispatch: binding.dispatch, idempotencyKey: "attempt-key" };
  try {
    const refused = (code: string) => (error: unknown) => error instanceof RpcError && error.code === code;
    assert.throws(() => daemon.dispatch("spawn", params, { ...conn, externalExecWorkspace: undefined }), refused("caller_not_trusted"));
    assert.throws(() => daemon.dispatch("spawn", params, { ...conn, externalExecWorkspace: "other" }), refused("capability_missing"));
    for (const extra of [{ account: "auto" }, { env: {} }, { prompt: "injected" }, { args: [] }, { command: "/bin/sh" }]) assert.throws(() => daemon.dispatch("spawn", { ...params, ...extra }, conn), refused("invalid_request"));
    assert.equal(store.listBees().length, 0);
    const result = daemon.dispatch("spawn", params, conn) as SpawnResult;
    assert.equal(store.getBee(result.beeId)?.account, null);
    assert.equal(store.externalBinding(result.beeId)?.bridgeId, "urbench-v2");
    assert.equal((daemon.dispatch("spawn", params, conn) as SpawnResult).deduped, true);
    assert.equal(store.listBees().length, 1);
    assert.throws(() => daemon.dispatch("spawn", { ...params, name: "duplicate-attempt", idempotencyKey: "another-key" }, conn));
    assert.equal(store.listBees().length, 1);
    assert.throws(() => daemon.dispatch("spawn", { ...params, dispatch: { ...binding.dispatch, fencingToken: "a-different-valid-fence" } }, conn), refused("idempotency_conflict"));
    assert.throws(() => daemon.dispatch("delete", { beeId: result.beeId }, conn), refused("runtime_refused"));
    assert.equal(store.claimExternalDispatch(result.beeId), "start");
    assert.equal(store.claimExternalDispatch(result.beeId), "reconcile");
    assert.ok(!JSON.stringify(store.listBeeViewRows()).includes(binding.dispatch.fencingToken));
    assert.ok(!JSON.stringify(store.auditRows()).includes(binding.dispatch.fencingToken));
    assert.ok(daemon.externalDispatches.has(result.beeId));
    daemon.settleExternal(result.beeId, store.currentRuntime(result.beeId)!.generation, externalReceipt(binding), true);
    assert.equal(daemon.externalDispatches.has(result.beeId), false);
    assert.equal(store.externalView(result.beeId)?.capture, "truncated");
    daemon.dispatch("spawn", params, conn);
    assert.equal(daemon.externalDispatches.has(result.beeId), false);
  } finally { store.close(); }
});

test("late external receipt does not touch a stopped daemon's writer", () => {
  const daemon = Object.create(HiveDaemon.prototype) as {stopping: boolean; settleExternal(beeId: string, generation: number, receipt: unknown): void};
  daemon.stopping = true;
  assert.doesNotThrow(() => daemon.settleExternal("external", 1, {}));
});

test("daemon detaches pending stop ownership while its writer is still open", async () => {
  const daemon = Object.create(HiveDaemon.prototype);
  const calls: string[] = [];
  Object.assign(daemon, {
    stopping: false,
    cfg: {dataDir: mkdtempSync(join(tmpdir(), "hb-shutdown-order-"))},
    log() {},
    performance: {stop() {}},
    driver: {detachAll() {calls.push("uncertainty");}},
    store: {close() {calls.push("close");}},
  });
  await daemon.shutdown();
  assert.deepEqual(calls, ["uncertainty", "close"]);
});
