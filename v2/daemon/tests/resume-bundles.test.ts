/**
 * H6a resume bundles in the REAL daemon: with the flag on, a turn end bundles
 * the harness-native session state (the stub's projects/<key>/<session>.json)
 * encrypted into the object store with a pointer row carrying the epoch; the
 * ciphertext hides the plaintext; unchanged state writes no row; pointer rows
 * are capped per bee; a fenced bee stops bundling; the status rides on
 * deployInfo. Flag off: nothing happens and no status appears.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectKey } from "../../driver-tmux/src/transcripts.ts";
import { DAEMON_CAPABILITIES, type BeeResumeBundlesResult, type DeployInfoResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(root: string, durability: Record<string, unknown>) {
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    durability,
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

async function spawnIdle(client: RpcClient, cwd: string): Promise<string> {
  const spawned = await client.request<SpawnResult>("spawn", { name: "durable", agent: "cellstub", cwd });
  await waitFor(async () => ((await client.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState === "idle" ? true : null), "idle", 60_000);
  return spawned.beeId;
}

async function bundlesOf(client: RpcClient, beeId: string) {
  return (await client.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId })).bundles;
}

test("resume-bundles.0: capability published; flag off bundles nothing and reports no status", { timeout: 120_000 }, async () => {
  assert.ok(DAEMON_CAPABILITIES.includes("bee.resume_bundle.v1"));
  const root = mkdtempSync(join(tmpdir(), "hb-v2-rb-off-"));
  const rig = makeRig(root, {});
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const beeId = await spawnIdle(client, cwd);
    await shIn(client, beeId, `mkdir -p projects/${claudeProjectKey(cwd)} && printf '{"turn":1}\\n' > projects/${claudeProjectKey(cwd)}/stub-session-1.json`);
    await new Promise((r) => setTimeout(r, 1000));
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.equal(info.resumeBundles, undefined);
    assert.deepEqual(await bundlesOf(client, beeId), []);
    assert.equal(existsSync(join(root, "objects", "blobs", "resume-bundles")), false);
  } finally {
    await daemon?.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume-bundles.1: turn ends bundle the harness state encrypted with the epoch; unchanged state writes no row; rows are capped", { timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-rb-"));
  const rig = makeRig(root, { resumeBundle: { enabled: true, keep: 2, keyFile: join(root, "keys", "ws.key") } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir, { env: { HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS: "0" } });
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.equal(info.resumeBundles?.enabled, true);
    assert.equal(info.resumeBundles?.keyPresent, true, "a missing key file is minted at boot");
    assert.equal(readFileSync(join(root, "keys", "ws.key"), "utf8").trim().length, 64);
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const beeId = await spawnIdle(client, cwd);
    const view = await client.request<ViewResult>("view", { beeId });
    assert.equal(view.bee?.providerSessionId, "stub-session-1");
    const key = claudeProjectKey(cwd);
    await shIn(client, beeId, `mkdir -p projects/${key} && printf '{"turn":1,"secret":"PASTED-TOKEN"}\\n' > projects/${key}/stub-session-1.json`);
    const first = await waitFor(async () => {
      const rows = await bundlesOf(client, beeId);
      return rows.length > 0 ? rows[0]! : null;
    }, "the turn end bundled the state", 30_000);
    assert.equal(first.harness, "stub");
    assert.equal(first.providerSessionId, "stub-session-1");
    assert.equal(first.stateKey, key);
    assert.equal(first.epoch, 0);
    assert.equal(first.files, 1);
    const object = readFileSync(join(root, "objects", "blobs", "resume-bundles", first.ref));
    assert.equal(object.subarray(0, 5).toString(), "hbrb2");
    assert.equal(object.subarray(5, 13).toString("hex"), first.keyId, "the header names the key the bundle was written under");
    assert.equal(first.keyId.length, 16);
    assert.equal(object.includes("PASTED-TOKEN"), false, "the object is ciphertext");
    assert.equal(object.includes("stub-session-1"), false, "not even the file names leak");

    await shIn(client, beeId, "true");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await bundlesOf(client, beeId)).length, 1, "an unchanged state writes no new row");
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /bee\.resume\.unchanged bee=/);

    await shIn(client, beeId, `printf '{"turn":2}\\n' > projects/${key}/stub-session-1.json`);
    await waitFor(async () => ((await bundlesOf(client, beeId)).length === 2 ? true : null), "second bundle", 30_000);
    await shIn(client, beeId, `printf '{"turn":3}\\n' > projects/${key}/stub-session-1.json`);
    await waitFor(async () => ((await bundlesOf(client, beeId)).filter((r) => r.ref !== first.ref).length === 2 ? true : null), "third bundle replaces the oldest row", 30_000);
    const rows = await bundlesOf(client, beeId);
    assert.equal(rows.length, 2, "keep=2 caps the pointer rows per bee");
    assert.ok(!rows.some((r) => r.ref === first.ref), "the oldest pointer is gone (its object waits for the sweep)");
    const status = (await client.request<DeployInfoResult>("deployInfo")).resumeBundles!;
    assert.equal(status.bundles, 2);
    assert.equal(status.bees, 1);
    assert.ok(status.bytes > 0);
  } finally {
    await daemon?.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
