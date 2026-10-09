/**
 * v33 `bee.resolvedModel` over the real daemon + HSR driver: the provider
 * model id the runtime itself reports (claude stream-json init/assistant),
 * published on the bee snapshot and as `bee.resolved_model` seq deltas.
 *  - no `--model`: absent until the runtime reports, then the account default
 *    (context-window suffix stripped)
 *  - `--model fable`: the resolved id, never the alias
 *  - an in-harness switch updates it with exactly one delta; subagent and
 *    `<synthetic>` lines never leak in
 *  - a new generation resets it to null until that runtime reports
 *
 * Temp dirs only; the spawned "claude" is a node fixture.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { SnapshotResult, SpawnResult, ViewResult, WatchFrame } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude-model.mjs", import.meta.url));
const STARTUP_MS = 60_000;

test("resolved-model.1: claude bees publish the model their runtime reports, update on switch, reset per generation", async () => {
  const { dir, cleanup } = makeDaemonDir({
    agents: { claude: { command: process.execPath, args: [FAKE_CLAUDE], adapter: "claude" } },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = (frame: WatchFrame) => frames.push(frame);
    await watcher.request<SnapshotResult>("watch");

    const view = async (beeId: string) => (await client.request<ViewResult>("view", { beeId }));
    const snapshotModel = async (beeId: string) =>
      (await client.request<SnapshotResult>("snapshot")).views.find((v) => v.bee?.id === beeId)?.bee?.resolvedModel;
    const modelDeltas = (beeId: string) => frames.flatMap((frame) =>
      frame.type === "delta"
        ? frame.events.filter((e) => e.kind === "bee.resolved_model" && e.beeId === beeId).map((e) => e.payload.resolvedModel)
        : []);

    // Spawn without --model: nothing is guessed before the runtime speaks.
    const bare = await client.request<SpawnResult>("spawn", { name: "bare", agent: "claude", cwd: "/tmp" });
    await waitFor(async () => (await view(bare.beeId)).view.runtimeState === "idle", "bare idle", STARTUP_MS);
    assert.equal(await snapshotModel(bare.beeId), null, "absent until the runtime reports a model");
    await client.request("send", { beeId: bare.beeId, body: "hi" });
    await waitFor(async () => (await snapshotModel(bare.beeId)) === "claude-opus-5-5", "bare model reported", STARTUP_MS);

    // Spawn with an alias: the provider id, not the alias.
    const aliased = await client.request<SpawnResult>("spawn", {
      name: "aliased", agent: "claude", cwd: "/tmp", args: ["--model", "fable"], prompt: "hi",
    });
    await waitFor(async () => (await snapshotModel(aliased.beeId)) === "claude-fable-5-1", "alias resolved", STARTUP_MS);
    assert.deepEqual((await view(aliased.beeId)).bee?.args, ["--model", "fable"], "args keep the requested alias");

    // Mid-session switch inside the harness.
    await client.request("send", { beeId: aliased.beeId, body: "@switch claude-sonnet-5-5" });
    await waitFor(async () => (await snapshotModel(aliased.beeId)) === "claude-sonnet-5-5", "switch observed", STARTUP_MS);
    await client.request("send", { beeId: aliased.beeId, body: "again" });
    await waitFor(async () => (await view(aliased.beeId)).view.runtimeState === "idle"
      && (await client.request<{ messages: Array<{ deliveredAt: number | null }> }>("mailbox", { beeId: aliased.beeId }))
        .messages.every((m) => m.deliveredAt !== null), "follow-up turn settled", STARTUP_MS);
    await waitFor(() => modelDeltas(aliased.beeId).length >= 2 || null, "deltas arrived");
    assert.deepEqual(modelDeltas(aliased.beeId), ["claude-fable-5-1", "claude-sonnet-5-5"],
      "one delta per change; subagent and <synthetic> lines never count");

    // A new generation starts unknown, then reports its own model.
    const before = (await view(aliased.beeId)).view.generation ?? 0;
    await client.request("stop", { beeId: aliased.beeId });
    await waitFor(async () => (await view(aliased.beeId)).view.runtimeState === "stopped", "stopped", STARTUP_MS);
    assert.equal(await snapshotModel(aliased.beeId), "claude-sonnet-5-5", "a stopped bee keeps the model it last ran");
    await client.request("revive", { beeId: aliased.beeId });
    await waitFor(async () => {
      const v = await view(aliased.beeId);
      return v.view.generation === before + 1 && v.view.runtimeState === "idle";
    }, "revived idle", STARTUP_MS);
    assert.equal(await snapshotModel(aliased.beeId), null, "new generation resets the model");
    await client.request("send", { beeId: aliased.beeId, body: "back" });
    await waitFor(async () => (await snapshotModel(aliased.beeId)) === "claude-fable-5-1", "revived model reported", STARTUP_MS);
    await waitFor(() => modelDeltas(aliased.beeId).length >= 4 || null, "reset deltas arrived");
    assert.deepEqual(modelDeltas(aliased.beeId), ["claude-fable-5-1", "claude-sonnet-5-5", null, "claude-fable-5-1"]);

    watcher.close();
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
