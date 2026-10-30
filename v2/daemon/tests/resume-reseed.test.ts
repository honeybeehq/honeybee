/**
 * H6c transcript re-seed in the REAL daemon: executor A cuts a stub bee's
 * transcript into projected segments; A is killed; executor B imports the bee
 * with no usable bundle (the bundle's account scope differs from B's) and the
 * segment refs; the import falls back to a handoff-style seed built from the
 * projected transcript, delivered before any mail, with reason
 * bundle_missing; a missing or unreadable transcript yields a fresh bee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HANDOFF_SEED_MARKER } from "../../core/src/handoff.ts";
import { claudeProjectKey } from "../../driver-tmux/src/transcripts.ts";
import { type BeeImportResult, type BeeResumeBundlesResult, type MailboxResult, type SendRpcResult, type SpawnResult, type TranscriptSegmentsResult, type ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(root: string, keyFile: string, durability: Record<string, unknown>) {
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    durability: { resumeBundle: { enabled: true, keyFile }, ...durability },
    transcripts: { segments: { enabled: true, storeDir: join(root, "objects") } },
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

test("resume-reseed.1: an import without a usable bundle re-seeds the bee from its projected transcript", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-reseed-"));
  mkdirSync(join(root, "objects"), { recursive: true });
  const keyFile = join(root, "ws.key");
  const rigA = makeRig(root, keyFile, {});
  const rigB = makeRig(root, keyFile, { import: { enabled: true } });
  let a: DaemonHandle | null = null;
  let b: DaemonHandle | null = null;
  try {
    a = await startDaemon(rigA.dir, { env: { HIVE_TEST_RESUME_BUNDLE_MIN_INTERVAL_MS: "0" } });
    const clientA = await a.client();
    const cwdA = join(root, "work-a");
    mkdirSync(cwdA, { recursive: true });
    const spawned = await clientA.request<SpawnResult>("spawn", { name: "memory", agent: "cellstub", cwd: cwdA });
    const beeId = spawned.beeId;
    await waitFor(async () => ((await clientA.request<ViewResult>("view", { beeId })).view.runtimeState === "idle" ? true : null), "idle", 60_000);
    await shIn(clientA, beeId, `mkdir -p projects/${claudeProjectKey(cwdA)} && printf '{}' > projects/${claudeProjectKey(cwdA)}/stub-session-1.json && echo 'the lab door code is 7731'`);
    await shIn(clientA, beeId, "echo 'second turn done'");
    const segments = await waitFor(async () => {
      const r = await clientA.request<TranscriptSegmentsResult>("transcript.segments", { beeId });
      return r.segments.length >= 1 ? r : null;
    }, "projected segments", 30_000);
    const bundle = await waitFor(async () => {
      const r = await clientA.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId });
      return r.bundles.length > 0 ? r.bundles[0]! : null;
    }, "bundle", 30_000);
    const viewA = await clientA.request<ViewResult>("view", { beeId });
    await a.kill();
    a = null;

    b = await startDaemon(rigB.dir);
    const clientB = await b.client();
    const cwdB = join(root, "work-b");
    mkdirSync(cwdB, { recursive: true });
    const descriptor = { id: beeId, name: viewA.bee!.name, agent: "cellstub", cwd: cwdB, providerSessionId: viewA.bee!.providerSessionId, handle: viewA.bee!.handle! };
    const refs = segments.segments.map((s) => s.projectedRef);
    const imported = await clientB.request<BeeImportResult>("bee.import", {
      descriptor,
      resume: { bundleRef: "0".repeat(64), epoch: bundle.epoch, providerSessionId: bundle.providerSessionId, stateKey: bundle.stateKey, scope: bundle.scope },
      transcript: { segmentRefs: refs, turns: [{ role: "user", text: "@sh echo 'the lab door code is 7731'" }, { role: "assistant", text: "the lab door code is 7731\nDONE" }] },
      lost: { questions: 2 },
      idempotencyKey: "reseed-1",
    });
    assert.equal(imported.resumed, "reseeded");
    assert.equal(imported.reason, "bundle_missing");
    assert.equal(imported.unfenced, true, "no fence receipt was given");
    assert.ok(imported.seedMessageId != null);
    const mailbox = await clientB.request<MailboxResult>("mailbox", { beeId });
    const seed = mailbox.messages.find((m) => m.id === imported.seedMessageId)!;
    assert.ok(seed.body.startsWith(HANDOFF_SEED_MARKER), "the seed is a handoff-marked message");
    assert.match(seed.body, /the lab door code is 7731/, "the seed carries what the bee saw before the loss");
    assert.match(seed.body, /could not be restored/);
    assert.match(seed.body, /2 question\(s\)/);
    assert.equal(mailbox.messages[0]!.id, seed.id, "the seed is the first message in the new mailbox");
    await waitFor(async () => ((await clientB.request<ViewResult>("view", { beeId })).view.runtimeState === "idle" ? true : null), "reseeded bee idle", 60_000);
    assert.equal((await clientB.request<MailboxResult>("mailbox", { beeId })).messages[0]!.deliveredAt != null, true, "the seed was delivered first");

    const fresh = await clientB.request<BeeImportResult>("bee.import", {
      descriptor: { ...descriptor, id: "11111111-2222-4333-8444-555555555555", name: "fresh", handle: undefined },
      resume: null,
      transcript: { segmentRefs: ["f".repeat(64)] },
      idempotencyKey: "reseed-2",
    });
    assert.equal(fresh.resumed, "fresh");
    assert.equal(fresh.reason, "no_transcript", "a transcript that yields no turns leaves the bee fresh with a typed reason");
    assert.equal(fresh.seedMessageId, null);
  } finally {
    await a?.stop();
    await b?.stop();
    rigA.cleanup();
    rigB.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
