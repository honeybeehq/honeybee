import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_ENV, bridgeOperation } from "../src/externalBridge.ts";
import { externalExecAdapter } from "../../adapters/src/externalExec.ts";
import { externalFixture, externalReceipt } from "../../core/tests/fixtures/externalExec.ts";
import { sha256 } from "../../core/src/externalExec.ts";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, renameSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";

test("every external lifecycle operation refuses an unavailable pinned install before emitting", async () => {
  for (const operation of ["start", "wait", "stop", "reconcile"] as const) {
    let events = 0;
    await assert.rejects(bridgeOperation(externalFixture(), operation, () => events++, () => events++));
    assert.equal(events, 0);
  }
  assert.deepEqual(Object.keys(BRIDGE_ENV).sort(), ["LANG", "LC_ALL", "PATH"]);
});

test("external adapter has no app-server init, mail encoding or resume; raw native data cannot settle it", () => {
  const b = externalFixture(), adapter = externalExecAdapter(b);
  assert.deepEqual(adapter.bootLines(), []);
  assert.equal(adapter.encodeMessage("ignored", { sessionId: null, messageId: 1, turnActive: false, turnId: null }), null);
  assert.equal(adapter.resumeArgs, undefined);
  assert.deepEqual(adapter.parseLine(JSON.stringify(externalReceipt(b))), []);
  assert.deepEqual(adapter.parseLine('{"type":"turn.completed"}'), []);
  const event = { schema: "urbench.bridge.event.v1", type: "terminal", seq: 1, attemptId: b.dispatch.attemptId, fencingTokenSha256: sha256(b.dispatch.fencingToken), data: externalReceipt(b) };
  assert.equal(adapter.parseLine(JSON.stringify({ schema: "honeybee.external.observation.v1", event }))[0]?.kind, "external_receipt");
  assert.deepEqual(adapter.parseLine(JSON.stringify({ schema: "honeybee.external.observation.v1", event: { ...event, attemptId: "other" } })), []);
});

test("Linux fd exec retains the opened script when its pathname is replaced", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "fd-exec-")), path = join(root, "bridge");
  writeFileSync(path, "#!/bin/sh\n/usr/bin/printf original\n", { mode: 0o500 });
  const fd = openSync(path, "r");
  renameSync(path, join(root, "original"));
  writeFileSync(path, "#!/bin/sh\n/usr/bin/printf replacement\n", { mode: 0o500 });
  try {
    const child = spawn("/proc/self/fd/3", ["start", "--manifest", "-"], { env: { ...BRIDGE_ENV }, stdio: ["pipe", "pipe", "pipe", fd] });
    let output = "";
    child.stdout!.on("data", chunk => { output += chunk.toString(); });
    child.stdin!.end("synthetic manifest");
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0);
    assert.equal(output, "original");
  } finally { closeSync(fd); }
});
