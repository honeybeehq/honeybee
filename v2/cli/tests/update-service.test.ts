import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodePinEnv, probeNativeNode } from "../../../src/nodeRuntime.ts";
import { serviceEnv, serviceExecArgs } from "../src/main.ts";

test("service environment records native pin and drops Electron mode", () => {
  assert.deepEqual(serviceEnv("/data", { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", HIVE_NODE_PATH: process.execPath }),
    { HIVE_V2_DATA_DIR: "/data", PATH: "/bin", ...nodePinEnv(probeNativeNode(process.execPath)) });
});

test("service entry follows selected node current, independent of ambient home", () => {
  const dir = mkdtempSync(join(tmpdir(), "hon8-service-"));
  try {
    const entry = join(dir, "runtime", "current", "dist", "cli.js");
    mkdirSync(join(dir, "runtime", "current", "dist"), { recursive: true });
    writeFileSync(entry, "fixture");
    assert.deepEqual(serviceExecArgs(join(dir, "v2"), { HIVE_NODE_PATH: process.execPath }), [process.execPath, entry, "v2", "daemon", "run", "--data-dir", join(dir, "v2")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fresh service install requires a pin and validates explicit argv overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-service-pin-"));
  const data = join(dir, "v2");
  try {
    assert.throws(() => serviceExecArgs(data, {}), /HIVE_NODE_PATH required/);
    for (const args of ["node", [], [1, "cli.js"], ["/Applications/Apiary.app/Contents/MacOS/Apiary", "cli.js"]]) {
      assert.throws(() => serviceExecArgs(data, { HIVE_V2_SERVICE_ARGS: JSON.stringify(args) }));
    }
    assert.throws(() => serviceExecArgs(data, { HIVE_V2_SERVICE_ARGS: JSON.stringify([process.execPath, "--inspect=0", "cli.js"]) }), /inspector/);
    assert.deepEqual(serviceExecArgs(data, { HIVE_V2_SERVICE_ARGS: JSON.stringify([process.execPath, "cli.js", "custom"]) }), [probeNativeNode(process.execPath).path, "cli.js", "custom"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
