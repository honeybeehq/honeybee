import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { rmSync, mkdirSync, mkdtempSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxEnvironment, wrapWithSandbox } from "../src/sandbox.ts";
import { fixtureGatewaySocket } from "./sandboxFixture.ts";

test("real home and nearest systemd ancestor refuse one exclusive create inside a Cell", {skip: process.platform !== "linux"}, t => {
  const allowUnproven = process.env.HIVE_TEST_ALLOW_UNPROVEN_HOME_PROBE === "1";
  assert.ok(!allowUnproven || !process.env.CI && !process.env.GITHUB_ACTIONS, "unproven attribution opt-in is forbidden on CI");
  const root = mkdtempSync("/tmp/hb-real-home-probe-");
  const cell = join(root, "cell");
  mkdirSync(cell);
  console.log(JSON.stringify({fixture: "T11 real-home launch venue", nodeExecutable: process.execPath}));
  const home = userInfo().homedir;
  const marker = `.hb-t11-write-${randomUUID()}`;
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const home = ${JSON.stringify(home)}, marker = ${JSON.stringify(marker)};
    const requested = path.join(home, '.config', 'systemd', 'user');
    let ancestor = requested;
    while (true) {
      try { if (fs.lstatSync(ancestor).isDirectory()) break; }
      catch (error) { if (!['ENOENT','ENOTDIR','EACCES'].includes(error.code)) throw error; }
      if (ancestor === home) throw Error('No existing real-home ancestor');
      ancestor = path.dirname(ancestor);
    }
    const attempt = (directory, suffix) => {
      const target = path.join(directory, marker + suffix);
      let fd;
      try {
        fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      } catch (error) { return {directory, result:error.code}; }
      try { fs.closeSync(fd); } finally { fs.unlinkSync(target); }
      return {directory, result:'CREATED_AND_REMOVED'};
    };
    if (process.argv[1] === 'select') console.log(JSON.stringify({requestedSystemd:requested, directories:[home,ancestor]}));
    else {
      const directories=JSON.parse(process.argv[2]);
      console.log(JSON.stringify({home:attempt(directories[0],'-home'),systemd:attempt(directories[1],'-systemd')}));
    }
  `;
  try {
    const env = sandboxEnvironment(cell, {});
    const runInside = (mode: string, directories: string[] = []) => {
      const wrapped = wrapWithSandbox({cellDir: cell, writablePaths: [], gatewaySocketPath: fixtureGatewaySocket}, process.execPath, ["-e", script, mode, JSON.stringify(directories)], join(cell, "profile"));
      const result = spawnSync(wrapped.command, wrapped.args, {cwd: cell, env, encoding: "utf8", timeout: 10000});
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const selected = runInside("select");
    assert.deepEqual(selected.directories.slice(0, 1), [home]);
    assert.ok([home, join(home, ".config"), join(home, ".config/systemd"), join(home, ".config/systemd/user")].includes(selected.directories[1]));
    const control = spawnSync(process.execPath, ["-e", script, "attempt", JSON.stringify(selected.directories)], {cwd: cell, env, encoding: "utf8", timeout: 10000});
    assert.equal(control.status, 0, control.stderr);
    const controls = JSON.parse(control.stdout);
    const inner = runInside("attempt", selected.directories);
    const report = {fixture: "T11 real home exclusive create", requestedSystemd: selected.requestedSystemd, controls, inner,
      attribution: [controls.home, controls.systemd].every(attempt => attempt.result === "CREATED_AND_REMOVED") ? "proven by successful outer controls" : "unproven (outer layer denies)"};
    console.log(JSON.stringify(report));
    for (const key of ["home", "systemd"] as const) {
      assert.notEqual(inner[key].result, "CREATED_AND_REMOVED", "inner Cell created a forbidden home file (removed immediately)");
      if (controls[key].result === "CREATED_AND_REMOVED") assert.ok(["EROFS", "EACCES"].includes(inner[key].result), JSON.stringify(inner[key]));
    }
    if (report.attribution === "unproven (outer layer denies)") {
      if (allowUnproven) t.todo(report.attribution);
      else assert.fail(report.attribution + "; positive controls must succeed for the denial release gate");
    }
  } finally {
    try { rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch (error) { console.error("owned fixture cleanup failed", error); process.exitCode = 1; }
  }
});
