import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { HsrDriver } from "../src/driver.ts";
import { BRIDGE_ENV } from "../src/externalBridge.ts";
import { externalExecAdapter } from "../../adapters/src/externalExec.ts";
import { sha256 } from "../../core/src/externalExec.ts";
import { externalFixture, externalReceipt } from "../../core/tests/fixtures/externalExec.ts";
import { drainUntil } from "./helpers.ts";

test("external stop uses the owner control lane and waits for validated terminal capture", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "host-"));
  const short = `/proc/self/cwd/.local/external-exec-tests/${basename(root)}`;
  const binding = externalFixture();
  const started = { schema: "honeybee.external.observation.v1", event: { schema: "urbench.bridge.event.v1", type: "started", seq: 1, attemptId: binding.dispatch.attemptId, fencingTokenSha256: sha256(binding.dispatch.fencingToken), data: { status: "running" } } };
  const terminal = { ...started, event: { ...started.event, type: "terminal", seq: 2, data: { ...externalReceipt(binding), status: "stopped" } } };
  const script = `const r = require('node:readline').createInterface({ input: process.stdin });
process.on('SIGTERM', () => process.exit(99));
console.log(${JSON.stringify(JSON.stringify(started))});
r.on('line', line => { if (JSON.parse(line).operation === 'stop') {
console.log(${JSON.stringify(JSON.stringify(terminal))}); r.close(); process.stdin.destroy();
} });`;
  let receipts = 0;
  const driver = new HsrDriver({ sessionLogDir: join(root, "logs"), socketDir: short, isExternal: () => true,
    onExternalReceipt: () => { receipts++; },
    resolve: () => ({ adapter: externalExecAdapter(binding), command: process.execPath, args: ["-e", script], cwd: "/", env: { ...BRIDGE_ENV } }) });
  try {
    driver.start("synthetic-external", 1);
    await drainUntil(driver, events => events.some(e => e.kind === "booted"));
    assert.equal(statSync(join(root, "runners", "synthetic-external.1.json")).mode & 0o077, 0);
    assert.equal(driver.stop("synthetic-external", 1, "stopped_by_user").hadProcess, true);
    const events = await drainUntil(driver, events => events.some(e => e.kind === "exited"));
    assert.equal(events.find(e => e.kind === "exited")?.exitCause, "stopped_by_user");
    assert.equal(receipts, 1);
  } finally { driver.disposeAll(); }
});
