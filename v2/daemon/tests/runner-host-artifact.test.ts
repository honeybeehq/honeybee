/**
 * Production runner-host placement contract. These tests deliberately drive
 * the real dist/v2 artifacts: no module-URL injection and no source fallback.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { pidAlive, processStartTimeMs, verifyProcessIdentity } from "../../driver-hsr/src/psutil.ts";
import { makeDaemonDir, waitFor } from "./helpers.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUILT_CLI = join(ROOT, "dist", "v2", "cli.js");
const BUILT_PROVISION_WORKER = join(ROOT, "dist", "v2", "provision-worker.js");
const BUILT_RUNNER_HOST = join(ROOT, "dist", "v2", "runner-host.js");
const EMBEDDED_ENTRY = "renamed-honeybee-runtime.mjs";

interface ProcessOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface CapturedProcess {
  child: ChildProcess;
  output(): string;
}

interface StagedRuntime {
  currentDir: string;
  currentEntry: string;
  releaseA: string;
  releaseB: string;
  wrapper: string;
}

interface RunnerStatusRecord {
  beeId?: string;
  hostPid: number;
  agentPid?: number;
  spawnError?: string;
  statusPath: string;
  configPath: string;
}

interface RunnerIdentity {
  pid: number;
  startedAt: number;
}

function captureProcess(child: ChildProcess): CapturedProcess {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  return { child, output: () => `${stdout}${stderr}` };
}

function runtimeEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HIVE_V2_DATA_DIR: dir,
    HIVE_NO_KEYCHAIN: "1",
    HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1",
  };
}

function spawnEmbedded(
  staged: StagedRuntime,
  dir: string,
  args: string[],
  nodeFlags: string[] = [],
): ChildProcess {
  return spawn(process.execPath, [...nodeFlags, staged.wrapper, staged.currentEntry, ...args], {
    cwd: ROOT,
    env: runtimeEnv(dir),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runEmbedded(
  staged: StagedRuntime,
  dir: string,
  args: string[],
  nodeFlags: string[] = [],
  timeoutMs = 15_000,
): Promise<ProcessOutcome> {
  const child = spawnEmbedded(staged, dir, args, nodeFlags);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });
    return { code, signal, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function stageRuntime(dir: string, releaseBHost: "poison" | "missing"): StagedRuntime {
  const runtimeDir = join(dir, "runtime");
  const releaseA = join(runtimeDir, "release-a");
  const releaseB = join(runtimeDir, "release-b");
  for (const release of [releaseA, releaseB]) {
    mkdirSync(join(release, "v2"), { recursive: true });
    writeFileSync(join(release, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    copyFileSync(BUILT_CLI, join(release, "v2", EMBEDDED_ENTRY));
    copyFileSync(BUILT_PROVISION_WORKER, join(release, "v2", "provision-worker.js"));
  }
  copyFileSync(BUILT_RUNNER_HOST, join(releaseA, "v2", "runner-host.js"));
  if (releaseBHost === "poison") {
    writeFileSync(
      join(releaseB, "v2", "runner-host.js"),
      'process.stderr.write("wrong release runner-host executed\\n"); process.exit(91);\n',
    );
  }

  const currentDir = join(runtimeDir, "current");
  symlinkSync(releaseA, currentDir, "dir");
  const wrapper = join(dir, "embedded-cli.mjs");
  writeFileSync(
    wrapper,
    [
      'import { pathToFileURL } from "node:url";',
      "const [entry, ...args] = process.argv.slice(2);",
      'if (!entry) throw new Error("missing embedded entry");',
      "const { runV2Cli } = await import(pathToFileURL(entry).href);",
      "process.exitCode = await runV2Cli(args);",
      "",
    ].join("\n"),
  );
  return {
    currentDir,
    currentEntry: join(currentDir, "v2", EMBEDDED_ENTRY),
    releaseA,
    releaseB,
    wrapper,
  };
}

function swapCurrent(staged: StagedRuntime): void {
  const replacement = `${staged.currentDir}.next`;
  symlinkSync(staged.releaseB, replacement, "dir");
  renameSync(replacement, staged.currentDir);
}

async function socketAccepts(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolveResult) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolveResult(true);
    });
    socket.once("error", () => resolveResult(false));
  });
}

function runnerStatuses(dir: string): RunnerStatusRecord[] {
  const runnersDir = join(dir, "runners");
  if (!existsSync(runnersDir)) return [];
  const statuses: RunnerStatusRecord[] = [];
  for (const name of readdirSync(runnersDir).filter((entry) => entry.endsWith(".status.json"))) {
    try {
      const statusPath = join(runnersDir, name);
      const parsed = JSON.parse(readFileSync(statusPath, "utf8")) as {
        beeId?: unknown;
        hostPid?: unknown;
        agentPid?: unknown;
        spawnError?: unknown;
        exited?: unknown;
      };
      if (typeof parsed.hostPid === "number" && parsed.exited !== true) {
        statuses.push({
          ...(typeof parsed.beeId === "string" ? { beeId: parsed.beeId } : {}),
          hostPid: parsed.hostPid,
          ...(typeof parsed.agentPid === "number" ? { agentPid: parsed.agentPid } : {}),
          ...(typeof parsed.spawnError === "string" ? { spawnError: parsed.spawnError } : {}),
          statusPath,
          configPath: statusPath.slice(0, -".status.json".length) + ".json",
        });
      }
    } catch {
      // A status update may be between writes; the next poll retries it.
    }
  }
  return statuses;
}

function runnerStatus(dir: string, beeId?: string): RunnerStatusRecord | null {
  const statuses = runnerStatuses(dir);
  return (beeId === undefined ? statuses[0] : statuses.find((status) => status.beeId === beeId)) ?? null;
}

function readProcessCommand(pid: number): string | null {
  const result = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const command = result.stdout.trim();
  return command.length > 0 ? command : null;
}

function pathsReferToSameFile(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  try {
    return realpathSync(actual) === realpathSync(expected);
  } catch {
    return false;
  }
}

function commandOwnsRunnerStatus(command: string, status: RunnerStatusRecord, expectedHostEntry: string): boolean {
  const argv = command.split(/\s+/);
  return (
    argv.some((argument) => pathsReferToSameFile(argument, expectedHostEntry)) &&
    argv.some((argument) => pathsReferToSameFile(argument, status.configPath))
  );
}

function runnerIdentities(dir: string, expectedHostEntry: string): RunnerIdentity[] {
  return runnerStatuses(dir).flatMap((status) => {
    if (!pidAlive(status.hostPid)) return [];
    const command = readProcessCommand(status.hostPid);
    if (command == null) {
      if (pidAlive(status.hostPid)) {
        throw new Error(`could not read command for live fixture runner host ${status.hostPid}`);
      }
      return [];
    }
    // A status file alone is not authority: its pid may be stale and reused.
    // Both immutable launch arguments must identify this exact fixture before
    // its current OS birth is admitted as an owned cleanup target.
    if (!commandOwnsRunnerStatus(command, status, expectedHostEntry)) return [];
    const startedAt = processStartTimeMs(status.hostPid);
    if (startedAt == null) {
      throw new Error(`could not read process birth for live fixture runner host ${status.hostPid}`);
    }
    return [{ pid: status.hostPid, startedAt }];
  });
}

function captureRunnerIdentity(status: RunnerStatusRecord, expectedHostEntry: string): RunnerIdentity {
  const command = readProcessCommand(status.hostPid);
  if (command == null || !commandOwnsRunnerStatus(command, status, expectedHostEntry)) {
    throw new Error(
      `runner-host ${status.hostPid} does not own expected entry/config: ${expectedHostEntry} ${status.configPath}; command=${String(command)}`,
    );
  }
  const startedAt = processStartTimeMs(status.hostPid);
  if (startedAt == null) throw new Error(`could not read process birth for runner host ${status.hostPid}`);
  return { pid: status.hostPid, startedAt };
}

function requireRunnerIdentity(identity: RunnerIdentity | null, message: string): RunnerIdentity {
  if (identity == null) throw new Error(message);
  return identity;
}

function uniqueIdentities(identities: RunnerIdentity[]): RunnerIdentity[] {
  const seen = new Set<number>();
  return identities.filter((identity) => {
    if (seen.has(identity.pid)) return false;
    seen.add(identity.pid);
    return true;
  });
}

function liveOwnedRunnerIdentities(identities: RunnerIdentity[]): RunnerIdentity[] {
  return identities.filter((identity) => verifyProcessIdentity(identity.pid, identity.startedAt));
}

async function reapOwnedRunnerHosts(dir: string, expectedHostEntry: string, known: RunnerIdentity[]): Promise<void> {
  const owned = uniqueIdentities([...known, ...runnerIdentities(dir, expectedHostEntry)]);
  for (const identity of owned) {
    // Detached runner hosts are process-group leaders. Re-verify the durable
    // pid/start-time pair immediately before signaling so a recycled pid can
    // never become a cleanup target.
    if (!verifyProcessIdentity(identity.pid, identity.startedAt)) continue;
    try {
      process.kill(-identity.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await waitFor(
    () => liveOwnedRunnerIdentities(owned).length === 0,
    "identity-verified runner-host fallback reap",
    5_000,
    20,
  );
}

async function stopDaemon(
  captured: CapturedProcess,
  dir: string,
  expectedHostEntry: string,
  known: RunnerIdentity[],
): Promise<void> {
  // Observe every fixture-owned host while the daemon and its children are
  // still live. processStartTimeMs is immutable process birth; status.at is
  // deliberately not used because the host updates it on every status patch.
  known.push(...runnerIdentities(dir, expectedHostEntry));
  const owned = uniqueIdentities(known);
  if (captured.child.exitCode == null && captured.child.signalCode == null) {
    captured.child.kill("SIGTERM");
  }
  await waitFor(
    () => captured.child.exitCode != null || captured.child.signalCode != null,
    "embedded daemon stop",
    10_000,
    20,
  );
  if (captured.child.exitCode !== 0) {
    throw new Error(
      `embedded daemon did not stop cleanly: code=${String(captured.child.exitCode)} signal=${String(captured.child.signalCode)}\n${captured.output()}`,
    );
  }
  await waitFor(
    () => liveOwnedRunnerIdentities(owned).length === 0,
    "embedded daemon runner hosts reaped",
    5_000,
    20,
  );
}

async function forceStopOwnedDaemon(captured: CapturedProcess): Promise<void> {
  if (captured.child.exitCode != null || captured.child.signalCode != null) return;
  captured.child.kill("SIGKILL");
  await waitFor(
    () => captured.child.exitCode != null || captured.child.signalCode != null,
    "owned embedded daemon fallback kill",
    5_000,
    20,
  );
}

async function cleanupFixture(
  captured: CapturedProcess,
  dir: string,
  expectedHostEntry: string,
  known: RunnerIdentity[],
  cleanup: () => void,
): Promise<void> {
  let failure: unknown;
  try {
    await stopDaemon(captured, dir, expectedHostEntry, known);
  } catch (error) {
    failure = error;
    try {
      await forceStopOwnedDaemon(captured);
      await reapOwnedRunnerHosts(dir, expectedHostEntry, known);
    } catch (reapError) {
      failure = new AggregateError([error, reapError], "embedded daemon stop and runner-host fallback reap failed");
    }
  } finally {
    cleanup();
  }
  if (failure !== undefined) throw failure;
}

function processCommand(pid: number): string {
  const command = readProcessCommand(pid);
  assert.ok(command, `could not read command for process ${pid}`);
  return command;
}

test.before(() => {
  // Drive the production builder itself: its import-graph and byte-size gates
  // must pass before any runtime behavior is exercised. The official daemon
  // runner classifies this file as an integration test and runs that group
  // serially after units, so this shared dist stage cannot race a peer file.
  const built = spawn(process.execPath, [join(ROOT, "scripts", "build-v2-artifact.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  return new Promise<void>((resolveBuilt, reject) => {
    built.once("error", reject);
    built.once("exit", (code, signal) => {
      if (code === 0) resolveBuilt();
      else reject(new Error(`v2 artifact build failed: code=${String(code)} signal=${String(signal)}`));
    });
  });
});

test("bundled HsrDriver pins its release before current is swapped", { timeout: 120_000 }, async (t) => {
  const modes = [
    { name: "default resolution", flags: [] },
    { name: "preserve-symlinks resolution", flags: ["--preserve-symlinks", "--preserve-symlinks-main"] },
  ];
  for (const mode of modes) {
    await t.test(mode.name, { timeout: 50_000 }, async () => {
      const { dir, cleanup } = makeDaemonDir();
      const staged = stageRuntime(dir, "poison");
      const expectedHostEntry = join(staged.releaseA, "v2", "runner-host.js");
      const ownedHosts: RunnerIdentity[] = [];
      const daemon = captureProcess(
        spawnEmbedded(staged, dir, ["daemon", "run", "--data-dir", dir], mode.flags),
      );
      let hostIdentity: RunnerIdentity | null = null;
      try {
        await waitFor(
          async () => {
            if (daemon.child.exitCode != null || daemon.child.signalCode != null) {
              throw new Error(`embedded daemon exited before readiness:\n${daemon.output()}`);
            }
            return socketAccepts(join(dir, "hived.sock"));
          },
          "embedded daemon socket",
          30_000,
          20,
        );

        // The daemon imported/constructed HsrDriver from release A. An atomic
        // deployment now points current at B, whose host is intentionally
        // poisonous. The next spawn must still use A's pinned sibling.
        swapCurrent(staged);
        const spawned = await runEmbedded(
          staged,
          dir,
          ["spawn", "embedded-worker", "--agent", "stub", "--cwd", dir, "--data-dir", dir, "--json"],
          mode.flags,
        );
        assert.equal(spawned.timedOut, false, `${mode.name}: spawn CLI timed out`);
        assert.equal(spawned.code, 0, `${mode.name}: ${spawned.stderr}${spawned.stdout}`);
        const spawnResult = JSON.parse(spawned.stdout.trim()) as { beeId?: string };
        assert.ok(spawnResult.beeId, `${mode.name}: spawn result has a bee id`);
        const status = await waitFor(
          () => {
            const found = runnerStatus(dir);
            if (found && hostIdentity == null) {
              hostIdentity = captureRunnerIdentity(found, expectedHostEntry);
              ownedHosts.push(hostIdentity);
            }
            return found?.agentPid && !found.spawnError ? found : false;
          },
          `${mode.name} runner host status`,
          20_000,
          20,
        );
        assert.equal(status.beeId, spawnResult.beeId);
        assert.ok(status.hostPid > 0);
        assert.ok((status.agentPid ?? 0) > 0);
        requireRunnerIdentity(hostIdentity, "runner-host identity was not captured at first status observation");
        const hostCommand = processCommand(status.hostPid);
        assert.ok(
          commandOwnsRunnerStatus(hostCommand, status, expectedHostEntry),
          `${mode.name}: host command was ${hostCommand}`,
        );
        assert.ok(!hostCommand.includes(staged.currentDir), `${mode.name}: host launch remained symlink-relative`);
        assert.ok(!hostCommand.includes(staged.releaseB), `${mode.name}: host launched from replacement release`);
        assert.ok(!hostCommand.includes(EMBEDDED_ENTRY), `${mode.name}: host re-entered the full CLI`);
        assert.doesNotMatch(daemon.output(), /wrong release runner-host executed/);
      } finally {
        await cleanupFixture(daemon, dir, expectedHostEntry, ownedHosts, cleanup);
      }
    });
  }
});

test("a staged Cell spawn uses the bundled sibling host through ready, turn, and stop", { timeout: 90_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir({ bootHangTimeoutMs: 60_000 });
  const origin = makeOrigin(dir, "cell-origin");
  const staged = stageRuntime(dir, "missing");
  const expectedHostEntry = join(staged.releaseA, "v2", "runner-host.js");
  const ownedHosts: RunnerIdentity[] = [];
  const daemon = captureProcess(spawnEmbedded(staged, dir, ["daemon", "run", "--data-dir", dir]));
  let hostIdentity: RunnerIdentity | null = null;
  try {
    await waitFor(
      async () => {
        if (daemon.child.exitCode != null || daemon.child.signalCode != null) {
          throw new Error(`embedded Cell daemon exited before readiness:\n${daemon.output()}`);
        }
        return socketAccepts(join(dir, "hived.sock"));
      },
      "embedded Cell daemon socket",
      30_000,
      20,
    );

    const spawned = await runEmbedded(
      staged,
      dir,
      [
        "spawn",
        "embedded-cell",
        "--agent",
        "stub",
        "--origin",
        origin.repo,
        "--sha",
        origin.sha,
        "--data-dir",
        dir,
        "--json",
      ],
      [],
      30_000,
    );
    assert.equal(spawned.timedOut, false, "Cell spawn CLI timed out");
    assert.equal(spawned.code, 0, `${spawned.stderr}${spawned.stdout}`);
    const spawnResult = JSON.parse(spawned.stdout.trim()) as { beeId?: string };
    assert.ok(spawnResult.beeId, "Cell spawn result has a bee id");

    const ready = await waitFor(
      async () => {
        const viewed = await runEmbedded(
          staged,
          dir,
          ["view", spawnResult.beeId!, "--data-dir", dir, "--json"],
        );
        assert.equal(viewed.code, 0, `${viewed.stderr}${viewed.stdout}`);
        const parsed = JSON.parse(viewed.stdout.trim()) as {
          bee?: { substrate?: string; cwd?: string };
          view?: { runtimeState?: string };
        };
        return parsed.view?.runtimeState === "idle" ? parsed : false;
      },
      "built Cell ready",
      60_000,
      100,
    );
    assert.equal(ready.bee?.substrate, "cell");
    assert.ok(ready.bee?.cwd?.startsWith(join(dir, "cells")), `unexpected Cell cwd: ${String(ready.bee?.cwd)}`);

    const status = await waitFor(
      () => {
        const found = runnerStatus(dir, spawnResult.beeId);
        if (found && hostIdentity == null) {
          hostIdentity = captureRunnerIdentity(found, expectedHostEntry);
          ownedHosts.push(hostIdentity);
        }
        return found?.agentPid && !found.spawnError ? found : false;
      },
      "built Cell runner host status",
      20_000,
      20,
    );
    const cellHostIdentity = requireRunnerIdentity(
      hostIdentity,
      "Cell runner-host identity was not captured at first status observation",
    );
    const hostCommand = processCommand(status.hostPid);
    assert.ok(commandOwnsRunnerStatus(hostCommand, status, expectedHostEntry), hostCommand);
    assert.ok(!hostCommand.includes(EMBEDDED_ENTRY), `Cell host re-entered the full CLI: ${hostCommand}`);

    const sent = await runEmbedded(
      staged,
      dir,
      ["send", spawnResult.beeId, "built Cell turn", "--wait", "--data-dir", dir, "--json"],
      [],
      30_000,
    );
    assert.equal(sent.timedOut, false, "Cell send CLI timed out");
    assert.equal(sent.code, 0, `${sent.stderr}${sent.stdout}`);
    const waited = await runEmbedded(
      staged,
      dir,
      ["wait", spawnResult.beeId, "--timeout", "20000", "--data-dir", dir, "--json"],
      [],
      25_000,
    );
    assert.equal(waited.timedOut, false, "Cell turn wait timed out");
    assert.equal(waited.code, 0, `${waited.stderr}${waited.stdout}`);

    const stopped = await runEmbedded(
      staged,
      dir,
      ["stop", spawnResult.beeId, "--data-dir", dir, "--json"],
    );
    assert.equal(stopped.code, 0, `${stopped.stderr}${stopped.stdout}`);
    await waitFor(
      () => !verifyProcessIdentity(cellHostIdentity.pid, cellHostIdentity.startedAt),
      "built Cell runner host stopped",
      15_000,
      20,
    );
    await waitFor(
      async () => {
        const viewed = await runEmbedded(
          staged,
          dir,
          ["view", spawnResult.beeId!, "--data-dir", dir, "--json"],
        );
        if (viewed.code !== 0) return false;
        const parsed = JSON.parse(viewed.stdout.trim()) as { view?: { runtimeState?: string } };
        return parsed.view?.runtimeState === "stopped";
      },
      "built Cell stopped state",
      15_000,
      100,
    );
  } finally {
    await cleanupFixture(daemon, dir, expectedHostEntry, ownedHosts, cleanup);
  }
});

test("fallback reap rejects a stale status PID owned by an unrelated process", { timeout: 15_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    cwd: dir,
    detached: true,
    stdio: "ignore",
  });
  const pid = unrelated.pid;
  assert.ok(pid, "unrelated fixture child has a pid");
  try {
    await waitFor(() => pidAlive(pid), "unrelated fixture child live", 5_000, 20);
    const runnersDir = join(dir, "runners");
    mkdirSync(runnersDir, { recursive: true });
    const configPath = join(runnersDir, "stale.1.json");
    writeFileSync(configPath, "{}\n");
    writeFileSync(
      join(runnersDir, "stale.1.status.json"),
      `${JSON.stringify({ beeId: "stale", hostPid: pid, exited: false, at: Date.now() })}\n`,
    );

    const expectedHostEntry = join(dir, "runtime", "release-a", "v2", "runner-host.js");
    await reapOwnedRunnerHosts(dir, expectedHostEntry, []);
    assert.ok(pidAlive(pid), "a stale status file must not bless and kill an unrelated live pid");
  } finally {
    try {
      if (pidAlive(pid)) unrelated.kill("SIGKILL");
      await waitFor(
        () => unrelated.exitCode != null || unrelated.signalCode != null,
        "unrelated fixture child explicitly terminated",
        5_000,
        20,
      );
    } finally {
      cleanup();
    }
  }
});

test("a built daemon reports a missing required runner-host sibling without CLI fallback", { timeout: 30_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  try {
    const staged = stageRuntime(dir, "missing");
    // Point at release B, which contains the renamed embedded CLI but no host.
    swapCurrent(staged);
    const outcome = await runEmbedded(staged, dir, ["daemon", "run", "--data-dir", dir]);
    assert.equal(outcome.timedOut, false, "daemon should refuse the incomplete artifact immediately");
    assert.notEqual(outcome.code, 0);
    const output = `${outcome.stderr}${outcome.stdout}`;
    assert.match(output, /required bundled runner-host artifact/);
    assert.match(output, /runner-host\.js/);
    assert.match(output, /rebuild or reinstall Honeybee/);
    assert.doesNotMatch(output, /unknown command|runner-host-main\.ts/);
  } finally {
    cleanup();
  }
});
