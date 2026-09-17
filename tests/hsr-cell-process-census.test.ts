import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { listProcessRows, readProcessBirthFingerprint, inspectProcessBirth } from "../src/hsr/processIdentity.js";

test("macOS Cell census captures a real child birth and topology without privileged ps", { skip: process.platform !== "darwin" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", detached: true });
  try {
    assert.ok(child.pid);
    const birth = await readProcessBirthFingerprint(child.pid);
    assert.ok(birth);
    assert.equal(birth.pgid, child.pid);
    const row = (await listProcessRows()).find(r => r.pid === child.pid);
    assert.equal(row?.ppid, process.pid);
    assert.equal(row?.startedAt, birth.startedAt);
    assert.equal(await inspectProcessBirth(child.pid, birth), "match");
    assert.equal(await inspectProcessBirth(child.pid, { ...birth, startedAt: "Mon Jan  1 00:00:00 2001" }), "mismatch");
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("close", () => resolve()));
  }
});

// Test the native failure paths rather than mocking the JavaScript caller.
test("native census refuses partial, denied, empty, or malformed snapshots", { skip: process.platform !== "darwin" }, async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "hive-census-fault-"));
  try {
    const binary = join(dir, "census");
    execFileSync("/usr/bin/xcrun", ["clang", "-Wall", "-Wextra", "-Werror", "-Dsysctl=census_test_sysctl",
      ...(process.env.SDKROOT ? ["-isysroot", process.env.SDKROOT] : []),
      fileURLToPath(new URL("../native/process-census-darwin.c", import.meta.url)),
      fileURLToPath(new URL("./fixtures/process-census-sysctl.c", import.meta.url)), "-o", binary]);
    for (const fault of ["denied", "growth", "truncated", "empty", "missing-self", "bad-state"]) {
      const result = spawnSync(binary, [], { encoding: "utf8", env: { ...process.env, CENSUS_TEST_FAULT: fault } });
      assert.equal(result.status, 2, `${fault}: ${result.stderr}`);
      assert.equal(result.stdout, "", `${fault}: never publish a partial census`);
    }
    const valid = spawnSync(binary, [], { encoding: "utf8", env: { ...process.env, CENSUS_TEST_FAULT: "none" } });
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /^\d+ 0 0 R .+ 2023\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native census matches ps birth fields where system ps is executable", { skip: process.platform !== "darwin" }, async t => {
  const { spawnSync } = await import("node:child_process");
  const { macProcessCensusPath } = await import("../src/hsr/processCensus.js");
  const { parseProcessRows } = await import("../src/hsr/processIdentity.js");
  const env = { ...process.env, LC_ALL: "C" };
  const ps = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", env });
  if ((ps.error as NodeJS.ErrnoException | undefined)?.code === "EPERM") { t.skip("system ps cannot execute in this inherited Cell sandbox"); return; }
  assert.equal(ps.status, 0, ps.stderr);
  const binary = macProcessCensusPath();
  assert.ok(binary, "build the native helper before testing");
  const native = spawnSync(binary, ["--identity"], { encoding: "utf8", env });
  assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(parseProcessRows(native.stdout).find(r => r.pid === process.pid), parseProcessRows(ps.stdout)[0]);
});

test("production macOS Cell wrapper permits census and keeps write containment", { skip: process.platform !== "darwin" }, async t => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { macProcessCensusPath } = await import("../src/hsr/processCensus.js");
  const { probeCellSandbox, wrapCellSandboxCommandForState } = await import("../src/hsr/cellSandbox.js");
  const probe = probeCellSandbox();
  if (probe.status !== "ready") { t.skip(probe.installHint); return; }
  const dir = await mkdtemp(join(tmpdir(), "hive-native-census-policy-"));
  try {
    const cell = join(dir, "cell");
    await mkdir(cell);
    const helper = macProcessCensusPath();
    assert.ok(helper);
    const script = `
      const {execFileSync} = require('node:child_process');
      const {writeFileSync} = require('node:fs');
      const assert = require('node:assert/strict');
      const rows = execFileSync(process.argv[1], [], {encoding:'utf8'}).trim().split('\\n');
      assert.ok(rows.some(row => Number(row.split(/\\s+/)[0]) === process.pid));
      writeFileSync(process.argv[2], 'inside');
      assert.throws(() => writeFileSync(process.argv[3], 'outside'), {code:'EPERM'});
      console.log('census and containment verified');
    `;
    const wrapped = await wrapCellSandboxCommandForState({ backend: "macos-seatbelt", cwd: cell,
      scratchRoot: cell, allowWrite: [cell], denyWrite: [], packageManagerWriteTrees: [], bashPath: "/bin/bash",
    }, process.execPath, ["-e", script, helper, join(cell, "allowed"), join(dir, "denied")]);
    assert.ok(wrapped.args[1]!.includes("(allow process-info* (target same-sandbox))"));
    assert.ok(wrapped.args[1]!.includes("(allow signal (target same-sandbox))"));
    const result = spawnSync(wrapped.command, wrapped.args, { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /census and containment verified/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("native helper exit 1 stays unverifiable rather than proving a PID absent", { skip: process.platform !== "darwin" }, async () => {
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "hive-census-exit-"));
  try {
    await mkdir(join(dir, "hsr"));
    await mkdir(join(dir, "native"));
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    // Isolate a package with a failing companion; never replace the real helper
    // used by concurrent tests or change the production command selection seam.
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    for (const name of ["processIdentity", "processCensus"]) {
      await copyFile(new URL(`../src/hsr/${name}.${extension}`, import.meta.url), join(dir, "hsr", `${name}.${extension}`));
    }
    await writeFile(join(dir, "native", "process-census"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const reader = await import(pathToFileURL(join(dir, "hsr", `processIdentity.${extension}`)).href);
    await assert.rejects(reader.listProcessRows(), { code: 1 });
    await assert.rejects(reader.readProcessBirthFingerprint(process.pid), { code: 1 });
    assert.equal(await reader.inspectProcessBirth(process.pid, { pgid: process.pid, startedAt: "Thu Sep 17 00:00:00 2026" }), "unverifiable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
