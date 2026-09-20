import assert from "node:assert/strict";
import { test } from "node:test";
import type { SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

/**
 * A spawn's start command must not wait for the tick cadence: the RPC and the
 * account activation each request an immediate tick, so the runtime starts
 * within milliseconds even when the cadence is seconds.
 */
test("spawn: the start command claims without waiting for the tick cadence", async () => {
  const tickMs = 5_000;
  const { dir, cleanup } = makeDaemonDir({ tickMs });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const startedAt = performance.now();
    const spawned = await client.request<SpawnResult>("spawn", { name: "kicked", agent: "stub", cwd: "/tmp" });
    await waitFor(async () => {
      const { view } = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return view.runtimeState != null && view.runtimeState !== "stopped";
    }, "runtime started", tickMs - 1_000);
    const elapsedUs = (performance.now() - startedAt) * 1000;
    assert.ok(elapsedUs < (tickMs - 1_000) * 1000, `runtime start took ${elapsedUs} us with a ${tickMs} ms cadence`);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
