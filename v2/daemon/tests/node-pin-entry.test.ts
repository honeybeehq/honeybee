import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodePinFile, nodeRepairFile, persistNodePin, probeNativeNode, validateDaemonNode } from "../../../src/nodeRuntime.ts";
import { runDaemon } from "../src/main.ts";

for (const corrupt of [false, true]) test(`daemon entry holds before store/socket open on ${corrupt ? "corrupt record" : "identity drift"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-node-entry-")), data = join(root, "v2");
  try {
    const pin = probeNativeNode(process.execPath);
    persistNodePin(data, { ...pin, version: "0.0.0" });
    if (corrupt) writeFileSync(nodePinFile(data), "corrupt JSON");
    assert.equal(await runDaemon(["--data-dir", data]), 0);
    assert.equal(existsSync(join(data, "core.sqlite3")), false);
    assert.equal(existsSync(join(data, "hived.sock")), false);
    assert.equal(JSON.parse(readFileSync(nodeRepairFile(data), "utf8")).state, "held");
    persistNodePin(data, pin);
    assert.equal(validateDaemonNode(data, true), null);
    assert.equal(existsSync(nodeRepairFile(data)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
