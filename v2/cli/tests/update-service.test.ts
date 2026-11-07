import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { createServiceManager } from "../../daemon/src/service.ts";
import { nodePinEnv, probeNativeNode, persistNodePin } from "../../core/src/nodeRuntime.ts";
import { runV2Cli, serviceEnv, serviceExecArgs } from "../src/main.ts";

test("service environment records native pin and drops Electron mode", () => {
  assert.deepEqual(serviceEnv("/data", { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", HIVE_NODE_PATH: process.execPath }),
    { HIVE_V2_DATA_DIR: "/data", PATH: "/bin", ...nodePinEnv(probeNativeNode(process.execPath)) });
});

test("service entry follows selected node current, independent of ambient home", () => {
  const dir = mkdtempSync(join(tmpdir(), "hon8-service-"));
  try {
    const entry = join(dir, "runtime", "current", "dist", "cli.js");
    mkdirSync(join(dir, "runtime", "current", "dist"), { recursive: true });
    writeFileSync(entry, "fixture");
    assert.deepEqual(serviceExecArgs(join(dir, "v2"), { HIVE_NODE_PATH: process.execPath }), [process.execPath, entry, "v2", "daemon", "run", "--data-dir", join(dir, "v2")]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fresh service install requires a pin and validates explicit argv overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-service-pin-"));
  const data = join(dir, "v2");
  try {
    assert.throws(() => serviceExecArgs(data, {}), /HIVE_NODE_PATH required/);
    for (const args of ["node", [], [1, "cli.js"], ["/Applications/Apiary.app/Contents/MacOS/Apiary", "cli.js"]]) {
      assert.throws(() => serviceExecArgs(data, { HIVE_V2_SERVICE_ARGS: JSON.stringify(args) }));
    }
    assert.throws(() => serviceExecArgs(data, { HIVE_V2_SERVICE_ARGS: JSON.stringify([process.execPath, "--inspect=0", "cli.js"]) }), /inspector/);
    assert.deepEqual(serviceExecArgs(data, { HIVE_V2_SERVICE_ARGS: JSON.stringify([process.execPath, "cli.js", "custom"]) }), [probeNativeNode(process.execPath).path, "cli.js", "custom"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("daemon start, restart and status expose a held pin without opening the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-held-cli-")), data = join(root, "v2");
  try {
    persistNodePin(data, { ...probeNativeNode(process.execPath), version: "0.0.0" });
    for (const verb of ["start", "restart", "status"]) {
      const out: string[] = [], err: string[] = [];
      assert.equal(await runV2Cli(["daemon", verb, "--data-dir", data, "--json"], { out: line => out.push(line), err: line => err.push(line) }), 0, err.join("\n"));
      assert.equal(JSON.parse(out[0] ?? "{}").repair.state, "held");
    }
    assert.equal((await import("node:fs")).existsSync(join(data, "core.sqlite3")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVICE_ENV_KEYS = ["PATH", "HOME", "HIVE_V2_SERVICE_DIR", "HIVE_V2_SERVICE_LABEL", "HIVE_CELL", "HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH", "HIVE_NODE_PATH"] as const;

function serviceSandbox(): { root: string; nodeDir: string; scratch: string; units: string; calls: () => string[]; resetCalls: () => void; installUnit: (dir: string, label: string, dataDir: string) => Promise<void>; restore: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-service-guard-")));
  const shim = join(root, "bin"), units = join(root, "units"), nodeDir = join(root, "node", "v2"), scratch = join(root, "scratch"), log = join(root, "calls.log");
  mkdirSync(shim, { recursive: true }); mkdirSync(units, { recursive: true }); mkdirSync(nodeDir, { recursive: true }); mkdirSync(scratch, { recursive: true });
  for (const tool of ["systemctl", "launchctl"]) {
    writeFileSync(join(shim, tool), `#!/bin/sh\necho "${tool} $*" >> "${log}"\ncase "$*" in print*) exit 1 ;; esac\nexit 0\n`, { mode: 0o755 });
  }
  writeFileSync(log, "");
  const saved = Object.fromEntries(SERVICE_ENV_KEYS.map(key => [key, process.env[key]]));
  const account = os.userInfo();
  const userInfo = mock.method(os, "userInfo", () => ({ ...account, homedir: root }));
  syncBuiltinESMExports();
  process.env.HOME = root;
  process.env.PATH = `${shim}:${process.env.PATH ?? ""}`;
  process.env.HIVE_V2_SERVICE_DIR = units;
  process.env.HIVE_V2_SERVICE_LABEL = "hb.guard.test";
  process.env.HIVE_NODE_PATH = process.execPath;
  delete process.env.HIVE_CELL; delete process.env.HIVE_V2_DATA_DIR; delete process.env.HIVE_V2_SOCKET_PATH;
  const noExec = async () => ({ code: 0, stdout: "", stderr: "" });
  return {
    root, nodeDir, scratch, units,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    resetCalls: () => writeFileSync(log, ""),
    installUnit: (dir, label, dataDir) => createServiceManager(process.platform, { label, execArgs: [process.execPath, "/nowhere/dist/cli.js", "v2", "daemon", "run", "--data-dir", dataDir], logPath: join(root, "hived.log") }, { exec: noExec, dir, uid: process.getuid?.() ?? 0 }).install(),
    restore: () => {
      userInfo.mock.restore();
      syncBuiltinESMExports();
      for (const key of SERVICE_ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function cli(argv: string[]): Promise<{ code: number; json: Record<string, unknown>; err: string }> {
  const out: string[] = [], err: string[] = [];
  const code = await runV2Cli([...argv, "--json"], { out: line => out.push(line), err: line => err.push(line) });
  return { code, json: JSON.parse(out[0] ?? "{}") as Record<string, unknown>, err: err.join("\n") };
}

function errorCode(json: Record<string, unknown>): string | undefined {
  return (json.error as { code?: string } | undefined)?.code;
}

test("daemon service verbs reach the service manager only for the unit's own data dir under the account home", { skip: process.platform === "win32" }, async () => {
  const sb = serviceSandbox();
  try {
    await sb.installUnit(sb.units, "hb.guard.test", sb.nodeDir);
    for (const verb of ["stop", "start", "restart"]) {
      sb.resetCalls();
      const owned = await cli(["daemon", verb, "--data-dir", sb.nodeDir]);
      assert.equal(owned.code, 0, owned.err);
      assert.ok(sb.calls().length > 0, `${verb} on the unit's data dir must reach the service manager`);
      assert.ok(sb.calls().every(line => line.includes("hb.guard.test")), sb.calls().join("\n"));
    }
    sb.resetCalls();
    const scratchStop = await cli(["daemon", "stop", "--data-dir", sb.scratch]);
    assert.equal(scratchStop.code, 0, scratchStop.err);
    assert.deepEqual({ running: scratchStop.json.running, stopped: scratchStop.json.stopped, service: scratchStop.json.service }, { running: false, stopped: false, service: null });
    for (const verb of ["start", "restart", "install", "uninstall"]) {
      const refused = await cli(["daemon", verb, "--data-dir", sb.scratch]);
      assert.equal(refused.code, 1);
      assert.equal(errorCode(refused.json), "service_data_dir_mismatch", verb);
    }
    process.env.HIVE_CELL = "1";
    const inCell = await cli(["daemon", "stop", "--data-dir", sb.nodeDir]);
    assert.equal(errorCode(inCell.json), "service_refused_in_cell");
    const cellStatus = await cli(["daemon", "status", "--data-dir", sb.nodeDir]);
    assert.deepEqual({ running: cellStatus.json.running, service: cellStatus.json.service }, { running: false, service: null });
    delete process.env.HIVE_CELL;
    const otherHome = join(sb.root, "other-home");
    mkdirSync(otherHome, { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = otherHome;
    try {
      const redirected = await cli(["daemon", "start", "--data-dir", sb.nodeDir]);
      assert.equal(errorCode(redirected.json), "service_home_redirected");
      const redirectedInstall = await cli(["daemon", "install", "--data-dir", join(otherHome, "custom")]);
      assert.equal(errorCode(redirectedInstall.json), "service_home_redirected");
    } finally {
      process.env.HOME = savedHome;
    }
    const emptyUnits = join(sb.root, "empty-units");
    mkdirSync(emptyUnits, { recursive: true });
    process.env.HIVE_V2_SERVICE_DIR = emptyUnits;
    for (const verb of ["restart", "uninstall"]) {
      const missing = await cli(["daemon", verb, "--data-dir", sb.nodeDir]);
      assert.equal(errorCode(missing.json), "service_not_installed", verb);
    }
    process.env.HIVE_V2_SERVICE_DIR = sb.units;
    const defaultLabelUnits = join(sb.root, "default-label-units");
    await sb.installUnit(defaultLabelUnits, "dev.honeybee.hive.v2", sb.nodeDir);
    process.env.HIVE_V2_SERVICE_DIR = defaultLabelUnits;
    delete process.env.HIVE_V2_SERVICE_LABEL;
    const unpaired = await cli(["daemon", "stop", "--data-dir", sb.nodeDir]);
    assert.equal(errorCode(unpaired.json), "service_label_unpaired");
    process.env.HIVE_V2_SERVICE_DIR = sb.units;
    process.env.HIVE_V2_SERVICE_LABEL = "hb.guard.test";
    assert.deepEqual(sb.calls(), [], "no refused or scratch verb may reach the service manager");
    const ownedAgain = await cli(["daemon", "stop", "--data-dir", sb.nodeDir]);
    assert.equal(ownedAgain.code, 0, ownedAgain.err);
    assert.ok(sb.calls().length > 0);
  } finally {
    sb.restore();
  }
});

test("hive daemon stop on a scratch data dir signals only that daemon, by its own pid", { skip: process.platform === "win32" || !existsSync(join(REPO_ROOT, "dist", "v2", "peercred", `${process.platform}-${process.arch}`, "peercred.node")), timeout: 60_000 }, async () => {
  const sb = serviceSandbox();
  await sb.installUnit(sb.units, "hb.guard.test", sb.nodeDir);
  const daemonHome = mkdtempSync(join(tmpdir().length > 40 && existsSync("/tmp") ? "/tmp" : tmpdir(), "hbsg-"));
  const daemon = spawn(process.execPath, [join(REPO_ROOT, "v2", "cli", "src", "bin.ts"), "daemon", "run", "--data-dir", sb.scratch], {
    env: { ...process.env, HOME: daemonHome, HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  daemon.stdout?.on("data", chunk => { output += String(chunk); });
  daemon.stderr?.on("data", chunk => { output += String(chunk); });
  const exited = new Promise<number | null>(resolveExit => daemon.once("exit", code => resolveExit(code)));
  try {
    const record = join(sb.scratch, "hived.endpoint.json");
    for (let i = 0; i < 300 && !existsSync(record); i++) await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    assert.ok(existsSync(record), `scratch daemon never published its endpoint record:\n${output}`);
    const stopped = await cli(["daemon", "stop", "--data-dir", sb.scratch]);
    assert.equal(stopped.code, 0, `${stopped.err}\n${output}`);
    assert.deepEqual({ stopped: stopped.json.stopped, pid: stopped.json.pid, dataDir: stopped.json.dataDir, service: stopped.json.service }, { stopped: true, pid: daemon.pid, dataDir: sb.scratch, service: null });
    assert.equal(await exited, 0, output);
    assert.deepEqual(sb.calls(), []);
  } finally {
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await exited;
    sb.restore();
    rmSync(daemonHome, { recursive: true, force: true });
  }
});
