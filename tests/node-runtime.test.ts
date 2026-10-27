import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { childNodePath, nativeNodeEnv, nodePinFile, persistNodePin, probeNativeNode, resolveNodePin, withoutInspectorArgs } from "../src/nodeRuntime.js";

function fixture(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "hb-pin-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("fresh service pin requires explicit managed node and refuses Electron", () => fixture(dir => {
  assert.throws(() => resolveNodePin(join(dir, "v2"), {}), /HIVE_NODE_PATH required/);
  assert.throws(() => probeNativeNode("/Applications/Apiary.app/Contents/MacOS/Apiary"), /never Electron/);
  assert.throws(() => probeNativeNode("node"), /absolute native Node/);
  const electron = join(dir, "electron");
  writeFileSync(electron, '#!/bin/sh\nprintf \'{"node":"24.18.0","electron":"40.0.0","execPath":"' + electron + '"}\'\n', { mode: 0o755 });
  assert.throws(() => probeNativeNode(electron), /refused Electron/);
}));

test("pin persists resolved executable identity and refuses version or byte drift", () => fixture(dir => {
  const node = join(dir, "node-24"), link = join(dir, "node"), data = join(dir, "v2");
  copyFileSync(process.execPath, node);
  symlinkSync(node, link);
  const pin = resolveNodePin(data, { HIVE_NODE_PATH: link });
  assert.equal(pin.path, node);
  assert.equal(pin.version, process.versions.node);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  persistNodePin(data, pin);
  assert.deepEqual(JSON.parse(readFileSync(nodePinFile(data), "utf8")), pin);
  assert.deepEqual(resolveNodePin(data, {}), pin);
  assert.throws(() => resolveNodePin(data, { HIVE_NODE_VERSION: "0.0.0" }), /identity drift/);
  persistNodePin(data, { ...pin, sha256: "0".repeat(64) });
  assert.throws(() => resolveNodePin(data, {}), /identity drift/);
  persistNodePin(data, { ...pin, version: "0.0.0" });
  assert.throws(() => resolveNodePin(data, {}), /identity drift/);
  persistNodePin(data, pin);
  appendFileSync(node, "changed bytes");
  assert.throws(() => resolveNodePin(data, {}), /identity drift|identity probe failed/);
}));

test("runtime environment and inspector arguments are scrubbed", () => {
  assert.deepEqual(nativeNodeEnv({ PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" }), { PATH: "/bin" });
  assert.deepEqual(withoutInspectorArgs(["--inspect", "--inspect-brk=0", "--inspect-port=9229", "--import", "tsx", "--debug=123"]), ["--import", "tsx"]);
});

test("foreground helpers discover the persisted pin without inherited service environment", () => fixture(dir => {
  const keys = ["HIVE_NODE_PATH", "HIVE_NODE_VERSION", "HIVE_NODE_SHA256", "HIVE_STORE_ROOT", "HIVE_V2_DATA_DIR"];
  const saved = new Map(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.HIVE_STORE_ROOT = dir;
    const node = join(dir, "node-pinned");
    copyFileSync(process.execPath, node);
    const pin = probeNativeNode(node);
    persistNodePin(join(dir, "v2"), pin);
    assert.equal(childNodePath(), node);
    persistNodePin(join(dir, "v2"), { ...pin, version: "0.0.0" });
    assert.throws(() => childNodePath(), /identity drift/);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}));

test("a recorded real executable replaced by a symlink cannot silently move the pin", () => fixture(dir => {
  const node = join(dir, "node-pinned"), moved = join(dir, "node-moved"), data = join(dir, "v2");
  copyFileSync(process.execPath, node);
  persistNodePin(data, probeNativeNode(node));
  renameSync(node, moved);
  symlinkSync(moved, node);
  assert.throws(() => resolveNodePin(data, {}), /identity drift/);
}));

test("only an explicit different HIVE_NODE_PATH permits installer migration", () => fixture(dir => {
  const node = join(dir, "node-other"), data = join(dir, "v2");
  copyFileSync(process.execPath, node);
  persistNodePin(data, probeNativeNode(process.execPath));
  assert.throws(() => resolveNodePin(data, { HIVE_NODE_PATH: "/Applications/Apiary.app/Contents/MacOS/Apiary" }, undefined, true), /never Electron/);
  assert.throws(() => resolveNodePin(data, {}, node, true), /identity drift/);
  assert.throws(() => resolveNodePin(data, { HIVE_NODE_PATH: node }), /identity drift/);
  assert.equal(resolveNodePin(data, { HIVE_NODE_PATH: node }, node, true).path, node);
}));

test("aliases to the recorded executable cannot migrate changed bytes", () => fixture(dir => {
  const node = join(dir, "node"), alias = join(dir, "alias"), data = join(dir, "v2");
  copyFileSync(process.execPath, node);
  persistNodePin(data, probeNativeNode(node));
  symlinkSync(node, alias);
  appendFileSync(node, "changed bytes");
  for (const path of [alias, `${dir}/./node`]) {
    assert.throws(() => resolveNodePin(data, { HIVE_NODE_PATH: path }, undefined, true), /identity drift|identity probe failed/);
  }
}));

test("deploy child migration selects an explicitly different pin without mutating the recorded pin", () => fixture(dir => {
  const data = join(dir, "v2"), node = join(dir, "candidate-node");
  copyFileSync(process.execPath, node);
  persistNodePin(data, probeNativeNode(process.execPath));
  const recorded = readFileSync(nodePinFile(data), "utf8");
  const saved = process.env.HIVE_NODE_PATH;
  try {
    process.env.HIVE_NODE_PATH = node;
    assert.throws(() => childNodePath(data), /identity drift/);
    assert.equal(childNodePath(data, true), node);
    assert.equal(readFileSync(nodePinFile(data), "utf8"), recorded);
  } finally {
    if (saved === undefined) delete process.env.HIVE_NODE_PATH;
    else process.env.HIVE_NODE_PATH = saved;
  }
}));
