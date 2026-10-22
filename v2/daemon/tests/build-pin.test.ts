import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPinFile, BuildPinMismatchError } from "../../../src/buildPin.ts";
import { writeNodeRuntimeState } from "../../../src/nodeRuntime.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";

test("daemon build pin mismatch refuses before the fixture store is opened", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-start-pin-")), dataDir = join(root, "v2");
  mkdirSync(dataDir);
  writeNodeRuntimeState(buildPinFile(join(root, "runtime")), { schemaVersion: 1, sourceRevision: "a".repeat(40), target: `${process.platform}-${process.arch}` });
  const daemon = new HiveDaemon(loadNodeConfig(dataDir));
  await assert.rejects(daemon.start(), BuildPinMismatchError);
  assert.equal(existsSync(join(dataDir, "core.sqlite3")), false);
});
