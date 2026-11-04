import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { sandboxEnvironment, wrapWithSandbox } from "../src/sandbox.ts";
import { fixtureGatewaySocket } from "./sandboxFixture.ts";

test("real home and nearest systemd ancestor refuse one exclusive create inside a Cell", {skip: process.platform !== "linux"}, () => {
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
    console.log(JSON.stringify({requestedSystemd:requested, home:attempt(home,'-home'), systemd:attempt(ancestor,'-systemd')}));
  `;
  try {
    const wrapped = wrapWithSandbox({cellDir: cell, writablePaths: [], gatewaySocketPath: fixtureGatewaySocket}, process.execPath, ["-e", script], join(cell, "profile"));
    const result = spawnSync(wrapped.command, wrapped.args, {cwd: cell, env: sandboxEnvironment(cell, process.env as Record<string, string>), encoding: "utf8", timeout: 10000});
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    console.log(JSON.stringify({fixture: "T11 real home exclusive create", ...report}));
    for (const attempt of [report.home, report.systemd]) assert.ok(["EROFS", "EACCES"].includes(attempt.result), JSON.stringify(attempt));
  } finally {
    const trash = join(tmpdir(), "honeybee-test-trash");
    mkdirSync(trash, {recursive: true, mode: 0o700});
    assert.equal(spawnSync("trash", ["--trash-dir", trash, root]).status, 0);
  }
});
