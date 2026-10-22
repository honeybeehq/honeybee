import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPinFile } from "../../../src/buildPin.ts";
import { writeNodeRuntimeState } from "../../../src/nodeRuntime.ts";
import { createHmac } from "node:crypto";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { startDaemon, type DaemonHandle } from "./helpers.ts";

test("future desired pin reports drift and permits previous daemon restart for recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-start-pin-")), dataDir = join(root, "v2");
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ rpcLocalTrust: { requireObservationCaller: true }, accounts: { discover: false } }));
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
      await assert.rejects(client.request("build.pin.clear"), (e: unknown) => (e as {code: string}).code === "caller_not_trusted");
      assert.deepEqual(JSON.parse(readFileSync(buildPinFile(join(root, "runtime")), "utf8")), pin);
      assert.equal(existsSync(join(root, "runtime", "build-pin-changes.jsonl")), false);
      const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
      const key = readFileSync(join(dataDir, "rpc-private", "registration.key"));
      const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex");
      key.fill(0);
      await client.request("rpc.localTrust.register", {pid: process.pid, challengeId: challenge.challengeId, token});
      const cleared = await client.request<{ desired: null }>("build.pin.clear");
      assert.equal(cleared.desired, null);
      const rows = readFileSync(join(root, "runtime", "build-pin-changes.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0].previous, pin);
      assert.equal(rows[1].desired, null);
      assert.equal(rows[1].caller.pid, process.pid);
    } finally { client.close(); }
  } finally { await daemon?.stop(); }
});
