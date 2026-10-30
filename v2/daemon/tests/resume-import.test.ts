/**
 * H6b bee.import in the REAL daemon: executor A bundles a stub bee's state;
 * A is killed; executor B (its own data dir, the shared object store and the
 * same workspace key) imports the bee under its id, handle and human_ref
 * with the bundle restored under B's cwd key and a fork seed; the epoch
 * advances; a second import is bee_exists; an older epoch is refused; A comes
 * back, is fenced, its revive refuses and its bundling stops. Flag off is
 * capability_missing. Stub agents and temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectKey } from "../../driver-tmux/src/transcripts.ts";
import { RpcError, type BeeFenceResult, type BeeImportResult, type BeeResumeBundlesResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(root: string, keyFile: string, durability: Record<string, unknown>) {
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    durability: { resumeBundle: { enabled: true, keyFile }, ...durability },
    transcripts: { segments: { storeDir: join(root, "objects") } },
    agents: { cellstub: { command: process.execPath, args: [CELL_AGENT_PATH], adapter: "stub", env: { STUB_SESSION_ID: "stub-session-1" } } },
  });
  return { dir, cleanup };
}

async function shIn(client: RpcClient, beeId: string, cmd: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view;
  const sent = await client.request<SendRpcResult>("send", { beeId, body: `@sh ${cmd}` });
  await waitFor(async () => {
    const v = (await client.request<ViewResult>("view", { beeId })).view;
    return v.runtimeState === "idle" && (v.lastOutputAt ?? 0) > (before.lastOutputAt ?? 0);
  }, `turn ended: ${cmd} (message ${sent.messageId})`, 30_000);
}

async function idle(client: RpcClient, beeId: string): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.view.runtimeState === "idle" ? v : null;
  }, "idle", 60_000);
}

test("resume-import.1: a killed executor's bee is imported elsewhere with its state, id and handle; epochs fence the old executor", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-import-"));
  mkdirSync(join(root, "objects"), { recursive: true });
  const keyA = join(root, "keys-a", "ws.key");
  const keyB = join(root, "keys-b", "ws.key");
  const rigA = makeRig(root, keyA, {});
  const rigB = makeRig(root, keyB, { import: { enabled: true } });
  let a: DaemonHandle | null = null;
  let b: DaemonHandle | null = null;
  try {
    a = await startDaemon(rigA.dir, { env: { HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS: "0" } });
    const clientA = await a.client();
    const cwdA = join(root, "work-a");
    mkdirSync(cwdA, { recursive: true });
    const spawned = await clientA.request<SpawnResult>("spawn", { name: "durable", agent: "cellstub", cwd: cwdA, tags: ["apiary:workspace=ws-1"] });
    const beeId = spawned.beeId;
    const viewA = await idle(clientA, beeId);
    const keyAName = claudeProjectKey(cwdA);
    await shIn(clientA, beeId, `mkdir -p projects/${keyAName} && printf '{"turn":1,"fact":"the lab is blue"}\\n' > projects/${keyAName}/stub-session-1.json`);
    const bundles = await waitFor(async () => {
      const r = await clientA.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId });
      return r.bundles.length > 0 ? r : null;
    }, "bundled on A", 30_000);
    const bundle = bundles.bundles[0]!;
    assert.equal(bundle.epoch, 0);
    await assert.rejects(clientA.request("bee.import", { descriptor: { id: beeId, name: "x", agent: "cellstub", cwd: cwdA }, idempotencyKey: "imp-off" }), (err: unknown) => err instanceof RpcError && err.code === "capability_missing");
    await a.kill();
    a = null;

    mkdirSync(dirname(keyB), { recursive: true });
    copyFileSync(keyA, keyB);
    b = await startDaemon(rigB.dir, { env: { HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS: "0" } });
    const clientB = await b.client();
    const cwdB = join(root, "work-b");
    mkdirSync(cwdB, { recursive: true });
    const descriptor = {
      id: beeId, name: viewA.bee!.name, agent: viewA.bee!.agent, args: viewA.bee!.args, tags: viewA.bee!.tags, cwd: cwdB,
      providerSessionId: viewA.bee!.providerSessionId, handle: viewA.bee!.handle!, createdAt: viewA.bee!.createdAt,
      ...(viewA.bee!.human_ref ? { humanRef: viewA.bee!.human_ref, issuingNamespace: viewA.bee!.issuing_namespace } : {}),
    };
    const resume = { bundleRef: bundle.ref, epoch: bundle.epoch, providerSessionId: bundle.providerSessionId, stateKey: bundle.stateKey, scope: bundle.scope };
    await assert.rejects(clientB.request("bee.import", { descriptor, resume, lost: { questions: 1 } }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /idempotencyKey/.test(err.message));
    const imported = await clientB.request<BeeImportResult>("bee.import", { descriptor, resume, lost: { questions: 1 }, idempotencyKey: "imp-1" });
    assert.equal(imported.beeId, beeId);
    assert.equal(imported.handle, viewA.bee!.handle);
    assert.equal(imported.resumed, "native");
    assert.equal(imported.reason, null);
    assert.equal(imported.epoch, 1, "the import takes the next epoch");
    assert.deepEqual(imported.lost, { questions: 1 });
    const again = await clientB.request<BeeImportResult>("bee.import", { descriptor, resume, lost: { questions: 1 }, idempotencyKey: "imp-1" });
    assert.equal(again.deduped, true);
    await assert.rejects(clientB.request("bee.import", { descriptor, resume, idempotencyKey: "imp-2" }), (err: unknown) => err instanceof RpcError && err.code === "bee_exists");
    const restored = join(cwdB, "projects", claudeProjectKey(cwdB), "stub-session-1.json");
    assert.ok(existsSync(restored), "the state is restored under the importing cwd's key");
    assert.equal(JSON.parse(readFileSync(restored, "utf8")).fact, "the lab is blue");
    assert.equal(existsSync(join(cwdB, "projects", keyAName)), false, "the source key dir is gone after the rename");
    const viewB = await idle(clientB, beeId);
    assert.equal(viewB.bee?.cwd, cwdB);
    assert.equal(viewB.bee?.handle, viewA.bee!.handle);
    assert.deepEqual(viewB.bee?.tags, viewA.bee!.tags);
    assert.equal(viewB.bee?.forkSeed, null, "the stub reported its own session, consuming the fork seed");
    const epochB = await clientB.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId });
    assert.equal(epochB.epoch.epoch, 1);
    await shIn(clientB, beeId, `printf '{"turn":2}\\n' > projects/${claudeProjectKey(cwdB)}/stub-session-1.json`);
    await waitFor(async () => ((await clientB.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId })).bundles.some((r) => r.epoch === 1) ? true : null), "B bundles under epoch 1", 30_000);
    await assert.rejects(clientB.request("bee.fence", { beeId, epoch: 0, idempotencyKey: "fence-old-b" }), (err: unknown) => err instanceof RpcError && err.code === "champion_fenced");

    a = await startDaemon(rigA.dir, { env: { HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS: "0" } });
    const clientA2 = await a.client();
    const back = await clientA2.request<ViewResult>("view", { beeId });
    assert.ok(back.bee, "the dead executor still has its row");
    const fenced = await clientA2.request<BeeFenceResult>("bee.fence", { beeId, epoch: 1, idempotencyKey: "fence-a" });
    assert.equal(fenced.epoch, 1);
    assert.ok(fenced.fencedAt != null);
    await assert.rejects(clientA2.request("revive", { beeId, idempotencyKey: "revive-a" }), (err: unknown) => err instanceof RpcError && err.code === "champion_fenced");
    await assert.rejects(clientA2.request("bee.import", { descriptor, resume: { ...resume, epoch: 0 }, idempotencyKey: "imp-a-old" }), (err: unknown) => err instanceof RpcError && err.code === "capability_missing", "A has import off; and even on, an older epoch would be champion_fenced");
    const sent = await clientA2.request<SendRpcResult>("send", { beeId, body: "@sh true" });
    assert.ok(sent.messageId);
    await new Promise((r) => setTimeout(r, 2500));
    const afterA = await clientA2.request<ViewResult>("view", { beeId });
    assert.notEqual(afterA.view.runtimeState, "idle", "a fenced bee never comes back to life on this executor");
    assert.match(readFileSync(join(rigA.dir, "hived.log"), "utf8"), /is fenced at epoch 1/);
  } finally {
    await a?.stop();
    await b?.stop();
    rigA.cleanup();
    rigB.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
