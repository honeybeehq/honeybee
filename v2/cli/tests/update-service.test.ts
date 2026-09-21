import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serviceEnv, serviceExecArgs } from "../src/main.ts";

test("verified installation preserves Electron's Node mode in the service", () => {
  assert.deepEqual(serviceEnv("/data", { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" }),
    { HIVE_V2_DATA_DIR: "/data", PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
});

test("service entry follows selected node current, independent of ambient home", () => {
  const dir = mkdtempSync(join(tmpdir(), "hon8-service-"));
  try {
    const entry = join(dir, "runtime", "current", "dist", "cli.js");
    mkdirSync(join(dir, "runtime", "current", "dist"), { recursive: true });
    writeFileSync(entry, "fixture");
    assert.deepEqual(serviceExecArgs(join(dir, "v2"), {}), [process.execPath, entry, "v2", "daemon", "run", "--data-dir", join(dir, "v2")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
