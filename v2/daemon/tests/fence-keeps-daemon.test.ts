/**
 * H6 executor side: bee.fence on a live bee stops that bee's runtime and
 * nothing else. The daemon keeps serving, keeps the other bee running, and
 * the fenced bee stays fenced across a restart. Pins that a fence arriving
 * at a live executor (the partition heal) cannot take the daemon down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BeeFenceResult, BeeResumeBundlesResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

test("fence-keeps-daemon.1: fencing a live bee stops its runtime while the daemon and its other bees stay up", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-fence-alive-"));
  const rig = makeDaemonDir({ bootHangTimeoutMs: 60_000, durability: { resumeBundle: { enabled: true, keyFile: join(root, "keys", "ws.key") } } });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const cwd = join(root, "work");
    mkdirSync(cwd, { recursive: true });
    const fenced = await client.request<SpawnResult>("spawn", { name: "fenced", agent: "stub", cwd, tags: ["apiary:workspace=ws-1"] });
    const bystander = await client.request<SpawnResult>("spawn", { name: "bystander", agent: "stub", cwd, tags: ["apiary:workspace=ws-1"] });
    const idle = (beeId: string) => waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId });
      return v.view.runtimeState === "idle" ? v : null;
    }, `${beeId} idle`, 60_000);
    await idle(fenced.beeId);
    await idle(bystander.beeId);

    const receipt = await client.request<BeeFenceResult>("bee.fence", { beeId: fenced.beeId, epoch: 1, idempotencyKey: "fence-1" });
    assert.equal(receipt.epoch, 1);
    assert.equal(receipt.stopped, true, "a live bee is stopped by the fence");
    await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: fenced.beeId });
      return v.view.runtimeState === "stopped" ? v : null;
    }, "fenced bee stopped", 60_000);

    const alive = await daemon.client();
    const bystanderView = await alive.request<ViewResult>("view", { beeId: bystander.beeId });
    assert.equal(bystanderView.view.runtimeState, "idle", "the other bee keeps its runtime");
    const epoch = await alive.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId: fenced.beeId });
    assert.equal(epoch.epoch.epoch, 1);
    assert.ok(epoch.epoch.fencedAt != null);
    assert.equal(daemon.proc.exitCode, null, "the daemon process is still running after the fence");
    alive.close();
    client.close();

    await daemon.stop();
    daemon = await startDaemon(rig.dir);
    const after = await daemon.client();
    const restarted = await after.request<BeeResumeBundlesResult>("bee.resumeBundles", { beeId: fenced.beeId });
    assert.equal(restarted.epoch.epoch, 1, "the fence survives a daemon restart");
    assert.ok(restarted.epoch.fencedAt != null);
    const bystanderAfter = await after.request<ViewResult>("view", { beeId: bystander.beeId });
    assert.ok(bystanderAfter.bee, "the bystander still exists after the restart");
    after.close();
  } finally {
    if (daemon) await daemon.stop().catch(() => {});
    rig.cleanup();
  }
});
