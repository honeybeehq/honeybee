import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodePinEnv, probeNativeNode, persistNodePin } from "../../../src/nodeRuntime.ts";
import { runV2Cli, serviceEnv, serviceExecArgs } from "../src/main.ts";

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

test("daemon start, restart and status expose a held pin without opening the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-held-cli-")), data = join(root, "v2");
  try {
    persistNodePin(data, { ...probeNativeNode(process.execPath), version: "0.0.0" });
    for (const verb of ["start", "restart", "status"]) {
      const out: string[] = [], err: string[] = [];
      assert.equal(await runV2Cli(["daemon", verb, "--data-dir", data, "--json"], { out: line => out.push(line), err: line => err.push(line) }), 0, err.join("\n"));
      assert.equal(JSON.parse(out[0] ?? "{}").repair.state, "held");
    }
    assert.equal((await import("node:fs")).existsSync(join(data, "core.sqlite3")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("service environment preserves explicit vault without propagating a service label", () => {
  const env = serviceEnv("/data", { HIVE_NODE_PATH: process.execPath, HIVE_V2_VAULT_DIR: "/isolated/vault", HIVE_V2_SERVICE_LABEL: "dev.honeybee.fixture" });
  assert.equal(env.HIVE_V2_VAULT_DIR, "/isolated/vault");
  assert.equal(env.HIVE_V2_SERVICE_LABEL, undefined);
});
