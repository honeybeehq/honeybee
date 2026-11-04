import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import test from "node:test";
import { inspectProcess, sameProcess } from "../../harness/src/processIdentity.ts";
import { runCellRepoBatch } from "../src/cellRepo.ts";
import { validatedCellScopeBinary } from "../src/cellScope.ts";

test("runner preserves resource boundaries across execution layers", { skip: process.platform !== "linux" }, async t => {
  if (spawnSync("trash", ["--help"], { stdio: "ignore" }).error) { t.skip("fixture cleanup utility unavailable"); return; }
  mkdirSync(resolve(".cache"), { recursive: true });
  const fixture = mkdtempSync(resolve(".cache/repo-scope-"));
  t.after(() => assert.equal(spawnSync("trash", ["--trash-dir", resolve(".cache/t11o-trash"), fixture], { stdio: "ignore" }).status, 0));
  const target = spawn("/usr/bin/sleep", ["30"], { env: {}, stdio: "ignore" });
  assert.ok(target.pid && target.pid > 2);
  const owned = inspectProcess(target.pid);
  assert.ok(owned.kind === "present");
  t.after(async () => {
    const current = inspectProcess(owned.pid);
    if (sameProcess(owned, current) && current.state === "live") {
      target.kill("SIGKILL");
      await new Promise(resolve => target.once("close", resolve));
    }
  });
  const address = "\0repo-fixture-" + randomUUID();
  let connections = 0;
  const server = createServer(connection => { connections++; connection.destroy(); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection(address);
    connection.once("connect", () => { connection.destroy(); resolve(); });
    connection.once("error", reject);
  });
  process.kill(owned.pid, 0);
  const program = `
import net from 'node:net';
const codes = {};
try { process.kill(${owned.pid}, 0); codes.signal = 'connected'; } catch (error) { codes.signal = error.code; }
await new Promise(resolve => {
  const connection = net.createConnection(${JSON.stringify(address)});
  connection.once('connect', () => { codes.socket = 'connected'; connection.destroy(); resolve(); });
  connection.once('error', error => { codes.socket = error.code; resolve(); });
});
if (process.argv[2] === 'diagnostic') process.stdout.write(JSON.stringify(codes));
else process.stdout.write(JSON.stringify({head:'${"a".repeat(40)}',statusBase64:Buffer.from(JSON.stringify(codes)).toString('base64'),branches:[],stashed:false}));
`;
  const helper = join(fixture, "probe.mjs");
  writeFileSync(helper, program);
  chmodSync(helper, 0o444);
  writeFileSync(join(fixture, "cell-repo-manifest.json"), JSON.stringify({ version: 1, files: { "probe.mjs": createHash("sha256").update(program).digest("hex") } }));
  const cellsRoot = join(fixture, "cells");
  const spaceDir = join(cellsRoot, "one", "repo");
  mkdirSync(join(spaceDir, ".git", "objects"), { recursive: true });
  const result = await runCellRepoBatch({ cellsRoot, wrapper: "one", spaceDir, sandboxed: true, independentInodes: true }, { operation: "inspect", ignored: false }, {
    helperPath: helper, unconfined: async () => { throw new Error("unexpected backend"); },
  });
  const composite = JSON.parse(result.status);
  assert.ok(["ECONNREFUSED", "ESRCH", "EPERM"].includes(composite.socket));
  assert.ok(["ECONNREFUSED", "ESRCH", "EPERM"].includes(composite.signal));
  const scope = validatedCellScopeBinary();
  const parentNamespace = statSync("/proc/self/ns/user");
  const args = ["--parent-pid", String(process.pid), "--", "/usr/bin/bwrap", "--unshare-user", "--die-with-parent", "--clearenv", "--cap-drop", "ALL", "--tmpfs", "/",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--dir", "/run",
    "--ro-bind", realpathSync(process.execPath), "/run/node", "--ro-bind", helper, "/run/probe.mjs", "--ro-bind", scope, "/run/scope",
    "/run/scope", "--assert-userns", `${parentNamespace.dev}:${parentNamespace.ino}`, "--", "/run/node", "/run/probe.mjs", "diagnostic"];
  const diagnostic = await new Promise<string>((resolve, reject) => {
    const child = spawn(scope, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error("fixture execution failed")); });
  });
  assert.deepEqual(JSON.parse(diagnostic), { signal: "EPERM", socket: "EPERM" });
  assert.equal(connections, 1);
});
