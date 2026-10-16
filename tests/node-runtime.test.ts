import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nativeNodeEnv, nodePinFile, persistNodePin, probeNativeNode, resolveNodePin, withoutInspectorArgs } from "../src/nodeRuntime.js";

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
