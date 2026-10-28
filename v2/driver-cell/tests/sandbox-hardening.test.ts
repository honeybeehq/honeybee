import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bwrapArgs as productionBwrapArgs, defaultWritablePaths, sandboxEnvironment, sandboxProtectedPaths, seatbeltProfile, wrapWithSandbox as productionWrapWithSandbox } from "../src/sandbox.ts";
import { inspectProcess } from "../../harness/src/processIdentity.ts";
import { spawnCallerBee } from "../../daemon/src/spawnLineage.ts";
import { prepareSandboxHarnessHome } from "../src/harnessHome.ts";
import { validatedCellScopeBinary } from "../src/cellScope.ts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertSandboxToolchainMetadata, sandboxToolchainRoot } from "../src/sandbox.ts";

import { withFixtureGateway } from "./sandboxFixture.ts";
const bwrapArgs: typeof productionBwrapArgs = (policy, ...args) => productionBwrapArgs(withFixtureGateway(policy), ...args);
const wrapWithSandbox: typeof productionWrapWithSandbox = (policy, ...args) => productionWrapWithSandbox(withFixtureGateway(policy), ...args);

const linux = process.platform === "linux";
const dispose = (path: string): void => { assert.equal(spawnSync("trash", [path]).status, 0); };

test("hardening: defaults and overrides cannot reopen protected host paths", () => {
  assert.deepEqual(defaultWritablePaths(), []);
  const root = mkdtempSync("/tmp/hb-hardening-");
  try {
    const alias = join(root, "alias");
    symlinkSync(join(homedir(), ".config"), alias);
    for (const path of [...sandboxProtectedPaths(), alias, join(alias, "missing", "child"), "/run/user", homedir(), "/"]) {
      for (const field of ["writablePaths", "scratchPaths"] as const) {
        const policy = { cellDir: root, writablePaths: [], [field]: [path] };
        assert.throws(() => bwrapArgs(policy, "/bin/true", []), /protected writable/);
        assert.throws(() => seatbeltProfile(policy), /protected writable/);
      }
    }
    const dataDir = join(root, "custom-data");
    assert.throws(() => bwrapArgs({ cellDir: root, writablePaths: [join(dataDir, "store")], protectedPaths: [dataDir] }, "/bin/true", []), /protected writable/);
    const env = sandboxEnvironment(root, { DBUS_SESSION_BUS_ADDRESS: "fixture", XDG_RUNTIME_DIR: "fixture", SSH_AUTH_SOCK: "fixture" });
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, undefined);
    assert.equal(env.XDG_RUNTIME_DIR, undefined);
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.ok(env.XDG_CACHE_HOME!.startsWith(root + "/"));
  } finally { dispose(root); }
});

test("hardening: harness projection binds only existing explicit input files", () => {
  const root = mkdtempSync("/tmp/hb-harness-inputs-");
  try {
    const home = join(root, "account"), cell = join(root, "cell");
    mkdirSync(home); mkdirSync(cell);
    writeFileSync(join(home, "auth.json"), "fixture");
    writeFileSync(join(home, "config.toml"), "fixture");
    writeFileSync(join(home, "unlisted"), "hidden");
    mkdirSync(join(home, "skills"));
    writeFileSync(join(home, "skills", "fixture.md"), "fixture");
    mkdirSync(join(home, "skills", ".git"));
    writeFileSync(join(home, "skills", ".git", "config"), "hidden");
    writeFileSync(join(home, "skills", ".env"), "hidden");
    const projection = prepareSandboxHarnessHome(cell, "codex", home);
    assert.deepEqual(projection.files.map(file => file.source), [join(home, "auth.json"), join(home, "config.toml"), join(home, "skills", "fixture.md")]);
    assert.ok(projection.files.every(file => file.destination.startsWith(projection.home + "/")));
    symlinkSync(join(root, "missing"), join(home, "skills", "unsafe"));
    assert.throws(() => prepareSandboxHarnessHome(cell, "codex", home), /symlink account input/);
    const policy = { cellDir: cell, writablePaths: [home], harnessHome: { harness: "codex", path: home, cwd: cell } };
    assert.throws(() => bwrapArgs(policy, "/bin/true", []), /protected writable/);
  } finally { dispose(root); }
});

test("hardening: private directory setup never chmods a symlink target", () => {
  const root = mkdtempSync("/tmp/hb-private-directory-");
  try {
    const account = join(root, "account"), cell = join(root, "cell"), target = join(root, "target");
    mkdirSync(account); mkdirSync(cell); mkdirSync(target, {mode: 0o755});
    chmodSync(target, 0o755);
    symlinkSync(target, join(cell, "sandbox-state"));
    assert.throws(() => prepareSandboxHarnessHome(cell, "codex", account), /unsafe private harness directory/);
    assert.equal(statSync(target).mode & 0o777, 0o755);
  } finally { dispose(root); }
});

test("hardening: launcher protects autorun/config and masks only a test-owned socket", { skip: !linux }, async () => {
  const root = mkdtempSync("/tmp/hb-hardening-");
  const socketRoot = mkdtempSync("/tmp/hb-owned-bus-");
  const socket = join(socketRoot, "fixture.sock");
  const server = createServer(connection => connection.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try {
    const home = join(root, "home"), cell = join(root, "cell");
    mkdirSync(home); mkdirSync(cell);
    const protectedPaths = [...sandboxProtectedPaths(home), join(home, ".local/share/apiary-satellite"), join(home, ".config/systemd/user"), join(home, ".config/autostart"), join(home, ".config/environment.d"), join(home, ".config/git")];
    for (const path of protectedPaths) mkdirSync(path, { recursive: true });
    const script = `
      const fs = require('node:fs'), net = require('node:net');
      const paths = ${JSON.stringify(protectedPaths)};
      const writes = paths.map(path => { try { fs.writeFileSync(path + '/denied', 'bad'); return true; } catch { return false; } });
      const writable = paths.map(path => { try { fs.accessSync(path, fs.constants.W_OK); return true; } catch { return false; } });
      fs.writeFileSync(${JSON.stringify(join(cell, "allowed"))}, 'ok');
      const abstract = fs.readFileSync('/proc/net/unix', 'utf8').split('\\n').filter(row => row.trim().split(/\\s+/).at(-1)?.startsWith('@'));
      const result = { writes, writable, runtime: fs.readdirSync('/run/user'), pid: process.pid, abstract: abstract.map(row => row.trim().split(/\\s+/).at(-1)) };
      const client = net.connect(${JSON.stringify(socket)});
      client.once('connect', () => { client.destroy(); console.log(JSON.stringify({...result, connected: true})); });
      client.once('error', error => console.log(JSON.stringify({...result, connected: false, socketError: error.code})));
    `;
    const scriptPath = join(root, "fixture.cjs");
    writeFileSync(scriptPath, script);
    const wrapped = wrapWithSandbox({ cellDir: cell, writablePaths: defaultWritablePaths(home), scratchPaths: [], protectedPaths }, process.execPath, [scriptPath], join(root, "profile"));
    const result = spawnSync(wrapped.command, wrapped.args, { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.writes, protectedPaths.map(() => false));
    assert.deepEqual(report.writable, protectedPaths.map(() => false));
    assert.deepEqual(report.runtime, []);
    assert.equal(report.connected, false);
    assert.equal(report.socketError, "ENOENT");
    assert.equal(report.pid, 2);
    assert.equal(readFileSync(join(cell, "allowed"), "utf8"), "ok");
    console.log(JSON.stringify({ fixture: "T11 autorun/runtime", ...report }));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    dispose(root); dispose(socketRoot);
  }
});

test("hardening: an old bwrap refuses launch without a fallback", { skip: !linux }, () => {
  const root = mkdtempSync("/tmp/hb-old-bwrap-");
  try {
    writeFileSync(join(root, "bwrap"), "#!/bin/sh\nfor arg do\nif [ \"$arg\" = --unshare-pid ]; then exit 64; fi\ndone\nexec \"$@\"\n", { mode: 0o700 });
    const marker = join(root, "escaped");
    const wrapped = wrapWithSandbox({ cellDir: root, writablePaths: [] }, "/usr/bin/touch", [marker], join(root, "profile"));
    const result = spawnSync(wrapped.command, wrapped.args, { env: { PATH: root }, timeout: 5000 });
    assert.equal(result.status, 64);
    assert.equal(existsSync(marker), false);
  } finally { dispose(root); }
});

test("hardening: PID namespace descendants retain host runtime ancestry and fail closed", { skip: !linux }, async () => {
  const root = mkdtempSync("/tmp/hb-pid-lineage-");
  const child = spawn("bwrap", bwrapArgs({ cellDir: root, writablePaths: [] }, "/bin/sh", ["-c", "sleep 20"]), { stdio: "ignore" });
  try {
    const owner = inspectProcess(child.pid!);
    assert.equal(owner.kind, "present");
    if (owner.kind !== "present") return;
    let descendant = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const children = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim();
      if (children) { descendant = Number(children.split(/\s+/)[0]); break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(descendant > 0);
    const peer = inspectProcess(descendant);
    assert.equal(peer.kind, "present");
    if (peer.kind !== "present") return;
    assert.equal(spawnCallerBee({ pid: peer.pid, uid: peer.uid, processBirth: peer.birth }, [{ beeId: "fixture", identity: owner }], inspectProcess), "fixture");
    assert.throws(() => spawnCallerBee({ pid: peer.pid, uid: peer.uid, processBirth: "wrong" }, [{ beeId: "fixture", identity: owner }], inspectProcess), /ancestry is unavailable/);
  } finally {
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("close", resolve));
    dispose(root);
  }
});

test("hardening: full Cell launcher denies outside abstract sockets and permits its own", { skip: !linux }, async () => {
  const root = mkdtempSync("/tmp/hb-abstract-fixture-");
  const name = "hive-t11-fixture-" + randomUUID();
  const server = createServer(connection => connection.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen("\0" + name, resolve); });
  try {
    const script = `
      const net = require('node:net');
      const outside = net.connect('\\0' + process.argv[1]);
      outside.once('connect', () => process.exit(3));
      outside.once('error', error => {
        if (error.code !== 'EPERM') process.exit(4);
        const name = '\\0' + process.argv[1] + '-inside';
        const server = net.createServer(connection => connection.end('inside'));
        server.listen(name, () => {
          const client = net.connect(name); let data = '';
          client.on('data', part => data += part);
          client.on('end', () => { server.close(); console.log(JSON.stringify({outside: error.code, inside: data})); });
        });
      });
    `;
    const wrapped = wrapWithSandbox({ cellDir: root, writablePaths: [] }, process.execPath, ["-e", script, name], join(root, "profile"));
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const code = await new Promise(resolve => child.once("close", resolve));
    clearTimeout(timer);
    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { outside: "EPERM", inside: "inside" });
    console.log(JSON.stringify({ fixture: "T11 abstract scope", ...JSON.parse(stdout) }));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); dispose(root); }
});

test("hardening: helper integrity and ABI below six refuse execution", { skip: !linux }, () => {
  const root = mkdtempSync("/tmp/hb-scope-refusal-");
  try {
    assert.throws(() => validatedCellScopeBinary(root));
    writeFileSync(join(root, "cell-scope"), "tampered", { mode: 0o700 });
    writeFileSync(join(root, "hive"), "fixture");
    writeFileSync(join(root, "manifest.json"), JSON.stringify({version: 1, target: `linux-${process.arch}`, sha256: "0".repeat(64), sourceSha256: "0".repeat(64)}));
    assert.throws(() => validatedCellScopeBinary(root), /mismatched Landlock/);
    const mock = join(root, "mock.c");
    writeFileSync(mock, "long fixture_syscall(long number, ...) { (void)number; return 5; }\n");
    const binary = join(root, "abi5");
    const source = fileURLToPath(new URL("../native/cell-scope.c", import.meta.url));
    const build = spawnSync("cc", ["-Dsyscall=fixture_syscall", source, mock, "-o", binary], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const marker = join(root, "escaped");
    const run = spawnSync(binary, ["--", "/usr/bin/touch", marker], { encoding: "utf8" });
    assert.equal(run.status, 125);
    assert.match(run.stderr, /Landlock ABI >= 6 required, observed 5/);
    assert.equal(existsSync(marker), false);
  } finally { dispose(root); }
});

test("hardening: private writes stay local, account inputs stay read only, and symlinks refuse relaunch", { skip: !linux }, () => {
  const root = mkdtempSync("/tmp/hb-projection-fixture-");
  try {
    const account = join(root, "account"), cell = join(root, "cell");
    mkdirSync(account); mkdirSync(cell);
    const auth = join(account, "auth.json"), config = join(account, "config.toml");
    writeFileSync(auth, "fixture-not-a-credential"); writeFileSync(config, "fixture");
    writeFileSync(join(account, "unlisted"), "hidden");
    const script = `
      const fs = require('node:fs');
      const home = process.env.CODEX_HOME;
      const write = path => { try { fs.writeFileSync(path, 'changed'); return true; } catch { return false; } };
      console.log(JSON.stringify({privateWrite: write(home + '/local-state'), authWrite: write(home + '/auth.json'), configWrite: write(home + '/config.toml'), unlisted: fs.existsSync(home + '/unlisted'), sourceUnlisted: fs.existsSync(${JSON.stringify(join(account, "unlisted"))})}));
    `;
    const policy = { cellDir: cell, writablePaths: [], harnessHome: { harness: "codex", path: account, cwd: cell } };
    const wrapped = wrapWithSandbox(policy, process.execPath, ["-e", script], join(cell, "profile"));
    const run = spawnSync(wrapped.command, wrapped.args, { encoding: "utf8", timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { privateWrite: true, authWrite: false, configWrite: false, unlisted: false, sourceUnlisted: false });
    assert.equal(readFileSync(auth, "utf8"), "fixture-not-a-credential");
    assert.equal(readFileSync(config, "utf8"), "fixture");
    assert.equal(existsSync(join(account, "local-state")), false);
    symlinkSync(account, join(cell, "sandbox-state", "codex", "skills"));
    mkdirSync(join(account, "skills"));
    assert.throws(() => wrapWithSandbox(policy, "/bin/true", [], join(cell, "profile")), /symlink private input/);
  } finally { dispose(root); }
});

test("hardening: fixture systemd private socket is masked and gh token file is hidden", { skip: !linux }, async () => {
  const root = mkdtempSync("/tmp/hb-manager-fixture-");
  const runtime = join(root, "runtime"), uid = String(process.getuid!());
  const systemd = join(runtime, uid, "systemd"); mkdirSync(systemd, { recursive: true });
  const socket = join(systemd, "private");
  const server = createServer(connection => connection.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try {
    await new Promise<void>((resolve, reject) => {
      const client = createConnection(socket);
      client.once("connect", () => { client.destroy(); resolve(); }); client.once("error", reject);
    });
    const gh = join(root, "gh"); mkdirSync(gh);
    writeFileSync(join(gh, "hosts.yml"), "fixture-not-a-token");
    const cell = join(root, "cell"); mkdirSync(cell);
    const target = `/run/user/${uid}/systemd/private`;
    const script = `
      const fs = require('node:fs'), net = require('node:net');
      const report = { managerExists: fs.existsSync(${JSON.stringify(target)}), busExists: fs.existsSync('/run/user/${uid}/bus'), tokenExists: fs.existsSync(${JSON.stringify(join(gh, "hosts.yml"))}) };
      const client = net.connect(${JSON.stringify(target)});
      client.once('connect', () => { client.destroy(); console.log(JSON.stringify({...report, connected:true})); });
      client.once('error', error => console.log(JSON.stringify({...report, connected:false, error:error.code})));
    `;
    const wrapped = wrapWithSandbox({ cellDir: cell, writablePaths: [], hiddenPaths: [gh] }, process.execPath, ["-e", script], join(cell, "profile"));
    const mask = wrapped.args.findIndex((arg, index) => arg === "--tmpfs" && wrapped.args[index + 1] === "/run");
    assert.ok(mask > 0);
    wrapped.args.splice(mask, 0, "--ro-bind", runtime, "/run");
    const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data); child.stderr.on("data", data => stderr += data);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const code = await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer);
    assert.equal(code, 0, stderr);
    const report = JSON.parse(stdout);
    assert.deepEqual(report, { managerExists:false, busExists:false, tokenExists:false, connected:false, error:"ENOENT" });
    assert.equal(readFileSync(join(gh, "hosts.yml"), "utf8"), "fixture-not-a-token");
    console.log(JSON.stringify({fixture:"T11 manager path and gh", hostFixtureConnected:true, ...report}));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); dispose(root); }
});

test("hardening: toolchain owners, modes and escaping symlinks fail closed", { skip: !linux }, () => {
  const root = mkdtempSync("/tmp/hb-toolchain-owner-");
  const allowed = new Set([0, process.geteuid!()]);
  try {
    chmodSync(root, 0o755);
    assert.doesNotThrow(() => assertSandboxToolchainMetadata(statSync(root), allowed));
    chmodSync(root, 0o775);
    assert.throws(() => assertSandboxToolchainMetadata(statSync(root), allowed), /group- or world-writable/);
    chmodSync(root, 0o757);
    assert.throws(() => assertSandboxToolchainMetadata(statSync(root), allowed), /group- or world-writable/);
    assert.throws(() => assertSandboxToolchainMetadata({uid: 23456, mode: 0o755}, allowed), /untrusted owner/);
    assert.throws(() => assertSandboxToolchainMetadata({uid: 65534, mode: 0o755}, new Set([0, 65534])), /unmapped/);
    const outside = join(root, "outside"); mkdirSync(outside); mkdirSync(join(outside, "bin"));
    writeFileSync(join(outside, "bin", "node"), "fixture");
    const link = join(root, "node-v24.18.0-linux-x64"); symlinkSync(outside, link);
    assert.throws(() => sandboxToolchainRoot(join(link, "bin", "node")), /unapproved executable install root/);
  } finally { chmodSync(root, 0o755); dispose(root); }
});

test("hardening: missing gateway and unchanged user namespace refuse before harness exec", { skip: !linux }, () => {
  const root = mkdtempSync("/tmp/hb-userns-refusal-");
  try {
    assert.throws(() => productionWrapWithSandbox({cellDir:root,writablePaths:[]}, "/bin/true", [], join(root,"profile")), /gateway is required/);
    assert.throws(() => productionWrapWithSandbox({cellDir:root,writablePaths:[],gatewaySocketPath:join(root,"missing.sock")}, "/bin/true", [], join(root,"profile")), /gateway is missing or unsafe/);
    const ns = statSync("/proc/self/ns/user"), marker = join(root,"escaped");
    const run = spawnSync(validatedCellScopeBinary(), ["--assert-userns", `${ns.dev}:${ns.ino}`, "--", "/usr/bin/touch", marker], {encoding:"utf8"});
    assert.equal(run.status, 125);
    assert.match(run.stderr, /user namespace unchanged/);
    assert.equal(existsSync(marker), false);
  } finally { dispose(root); }
});
