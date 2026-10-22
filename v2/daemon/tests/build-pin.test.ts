import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPinFile } from "../../../src/buildPin.ts";
import { writeNodeRuntimeState } from "../../../src/nodeRuntime.ts";
import { startDaemon, type DaemonHandle } from "./helpers.ts";

test("future desired pin reports drift and permits previous daemon restart for recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-start-pin-")), dataDir = join(root, "v2");
  mkdirSync(dataDir);
  const pin = { schemaVersion: 1, sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}` };
  writeNodeRuntimeState(buildPinFile(join(root, "runtime")), pin);
  let daemon: DaemonHandle | null = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      daemon = await startDaemon(dataDir);
      const client = await daemon.client();
      try {
        const report = await client.request<{ desired: unknown; running: unknown; verdict: string; drift: string[] }>("build.report");
        assert.deepEqual(report.desired, pin);
        assert.ok(report.running);
        assert.equal(report.verdict, "drift");
        assert.ok(report.drift.includes("running.sourceRevision"));
        await assert.rejects(client.request("build.pin.set", { pin: { schemaVersion: 99 } }));
      } finally { client.close(); }
      await daemon.stop();
      daemon = null;
    }
    daemon = await startDaemon(dataDir);
    const client = await daemon.client();
    try {
      const cleared = await client.request<{ desired: null }>("build.pin.clear");
      assert.equal(cleared.desired, null);
    } finally { client.close(); }
  } finally { await daemon?.stop(); }
});
