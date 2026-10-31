/**
 * H6 two-host re-seed: executor B keeps its OWN object directory, so A's
 * resume bundle is not on B's disk. bee.import carries the bundle bytes
 * inline (resume.bundleBytes, verified against bundleRef); B stores them
 * under its resume-bundles directory and restores natively. Without the
 * bytes the same import is fresh/bundle_missing; bytes that do not hash to
 * the ref are refused as invalid_request. Stub agents and temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectKey } from "../../driver-tmux/src/transcripts.ts";
import { RpcError, type BeeImportResult, type BeeResumeBundlesResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import { resumeBundlePath } from "../src/resumeBundles.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(objects: string, keyFile: string, durability: Record<string, unknown>) {
  return makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    durability: { resumeBundle: { enabled: true, keyFile }, ...durability },
    transcripts: { segments: { storeDir: objects } },
    agents: { cellstub: { command: process.execPath, args: [CELL_AGENT_PATH], adapter: "stub", env: { STUB_SESSION_ID: "stub-session-1" } } },
  });
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

test("resume-import-bytes.1: an import onto an executor with its own object directory restores natively from inline bundle bytes", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-import-bytes-"));
  const objectsA = join(root, "objects-a");
  const objectsB = join(root, "objects-b");
  mkdirSync(objectsA, { recursive: true });
  mkdirSync(objectsB, { recursive: true });
  const keyA = join(root, "keys-a", "ws.key");
  const keyB = join(root, "keys-b", "ws.key");
  const rigA = makeRig(objectsA, keyA, {});
  const rigB = makeRig(objectsB, keyB, { import: { enabled: true } });
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
    const bytes = readFileSync(resumeBundlePath(objectsA, bundle.ref));
    assert.equal(bytes.length, bundle.bytes);
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
    };
    const resume = { bundleRef: bundle.ref, epoch: bundle.epoch, providerSessionId: bundle.providerSessionId, stateKey: bundle.stateKey, scope: bundle.scope };
    assert.equal(existsSync(resumeBundlePath(objectsB, bundle.ref)), false, "B does not hold A's bundle");
    const forged = Buffer.concat([bytes, Buffer.from([0])]).toString("base64");
    await assert.rejects(clientB.request("bee.import", { descriptor, resume: { ...resume, bundleBytes: forged }, idempotencyKey: "imp-forged" }), (err: unknown) => err instanceof RpcError && err.code === "invalid_request" && /do not hash/.test(err.message));
    assert.equal(existsSync(resumeBundlePath(objectsB, bundle.ref)), false, "refused bytes are never stored");
    const imported = await clientB.request<BeeImportResult>("bee.import", { descriptor, resume: { ...resume, bundleBytes: bytes.toString("base64") }, idempotencyKey: "imp-1" });
    assert.equal(imported.resumed, "native");
    assert.equal(imported.reason, null);
    assert.equal(imported.epoch, 1);
    assert.ok(existsSync(resumeBundlePath(objectsB, bundle.ref)), "B stored the carried bundle under its own object directory");
    const restored = join(cwdB, "projects", claudeProjectKey(cwdB), "stub-session-1.json");
    assert.ok(existsSync(restored), "the state is restored under the importing cwd's key");
    assert.equal(JSON.parse(readFileSync(restored, "utf8")).fact, "the lab is blue");
    assert.match(readFileSync(join(rigB.dir, "hived.log"), "utf8"), /bee\.import\.bundle_adopted bee=.* created=true/);
    const viewB = await idle(clientB, beeId);
    assert.equal(viewB.bee?.cwd, cwdB);
  } finally {
    await a?.stop();
    await b?.stop();
    rigA.cleanup();
    rigB.cleanup();
  }
});

test("resume-import-bytes.2: without the bytes the same import is fresh with bundle_missing", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-import-nobytes-"));
  const objectsA = join(root, "objects-a");
  const objectsB = join(root, "objects-b");
  mkdirSync(objectsA, { recursive: true });
  mkdirSync(objectsB, { recursive: true });
  const keyA = join(root, "keys-a", "ws.key");
  const keyB = join(root, "keys-b", "ws.key");
  const rigA = makeRig(objectsA, keyA, {});
  const rigB = makeRig(objectsB, keyB, { import: { enabled: true } });
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
    await shIn(clientA, beeId, `mkdir -p projects/${keyAName} && printf '{"turn":1}\\n' > projects/${keyAName}/stub-session-1.json`);
    const bundles = await waitFor(async () => {
      const r = await clientA.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId });
      return r.bundles.length > 0 ? r : null;
    }, "bundled on A", 30_000);
    const bundle = bundles.bundles[0]!;
    await a.kill();
    a = null;
    mkdirSync(dirname(keyB), { recursive: true });
    copyFileSync(keyA, keyB);
    b = await startDaemon(rigB.dir, { env: { HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS: "0" } });
    const clientB = await b.client();
    const cwdB = join(root, "work-b");
    mkdirSync(cwdB, { recursive: true });
    const descriptor = { id: beeId, name: viewA.bee!.name, agent: viewA.bee!.agent, args: viewA.bee!.args, tags: viewA.bee!.tags, cwd: cwdB, providerSessionId: viewA.bee!.providerSessionId, handle: viewA.bee!.handle!, createdAt: viewA.bee!.createdAt };
    const resume = { bundleRef: bundle.ref, epoch: bundle.epoch, providerSessionId: bundle.providerSessionId, stateKey: bundle.stateKey, scope: bundle.scope };
    const imported = await clientB.request<BeeImportResult>("bee.import", { descriptor, resume, idempotencyKey: "imp-1" });
    assert.equal(imported.resumed, "fresh");
    assert.equal(imported.reason, "bundle_missing");
  } finally {
    await a?.stop();
    await b?.stop();
    rigA.cleanup();
    rigB.cleanup();
  }
});
