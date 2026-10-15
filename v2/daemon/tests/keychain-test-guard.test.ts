import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readClaudeKeychainState, securityExecutable, underTest } from "../../../src/keychain.ts";

test("keychain test guard: a test process refuses the real security binary before any exec", async (t) => {
  const realExecFile = childProcess.execFile;
  let execs = 0;
  (childProcess as { execFile: unknown }).execFile = (...args: unknown[]) => {
    execs += 1;
    return (realExecFile as (...a: unknown[]) => unknown)(...args);
  };
  syncBuiltinESMExports();
  const saved = process.env.HIVE_TEST_SECURITY_BIN;
  const dir = mkdtempSync(join(tmpdir(), "hb-keychain-guard-"));
  t.after(() => {
    (childProcess as { execFile: unknown }).execFile = realExecFile;
    syncBuiltinESMExports();
    if (saved === undefined) delete process.env.HIVE_TEST_SECURITY_BIN;
    else process.env.HIVE_TEST_SECURITY_BIN = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(underTest({ HIVE_TEST_PLATFORM: "darwin" }), true);
  assert.equal(underTest({ NODE_TEST_CONTEXT: "child-v8" }), true);
  assert.equal(underTest({ HOME: "/Users/x" }), false);
  assert.equal(securityExecutable({ HOME: "/Users/x" }), "security");

  delete process.env.HIVE_TEST_SECURITY_BIN;
  assert.throws(() => securityExecutable({ HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1" }), /may not run the real security binary/);
  assert.throws(() => securityExecutable({ HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1", HIVE_TEST_SECURITY_BIN: "security" }), /may not run the real security binary/);
  await assert.rejects(readClaudeKeychainState("/tmp/home", { available: () => true }), /may not run the real security binary/);
  assert.equal(execs, 0, "the refusal comes before any exec");

  const shim = join(dir, "security");
  writeFileSync(shim, "#!/bin/sh\nexit 44\n");
  chmodSync(shim, 0o755);
  assert.equal(securityExecutable({ HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1", HIVE_TEST_SECURITY_BIN: shim }), shim);
});
