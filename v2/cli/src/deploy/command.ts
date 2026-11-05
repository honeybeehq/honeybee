import { provisionQuestionWithdrawal, verifyQuestionWithdrawal } from "./questionWithdrawal.ts";
import { parseNpmPackResult } from "./npmPack.ts";
import { serviceDirectory } from "../../../core/src/servicePaths.ts";
import { randomUUID } from "node:crypto";
import { probeNativeNode, resolveNodePin, nativeNodeEnv, nodePinEnv, nodePinFile, nodeRepairFile, type NodePin } from "../../../core/src/nodeRuntime.ts";
// `hive deploy` — versioned runtime deploys (reset WP0, spec 00). The
// orchestration lives in src/deployRuntime.ts; this module wires the CLI
// surface plus the two production hooks: the real clean-checkout build and
// the real daemon restart. Tests drive deployRuntime with injected hooks and
// never reach the code in this file's hook implementations.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  DeployActivationHeldError,
  assertRollbackStoreCompatible,
  CURRENT_LINK_NAME,
  DEFAULT_KEEP_VERSIONS,
  currentDeployTarget,
  deployVersion,
  readDeployHistory,
  rollbackDeploy,
  rollbackTargetEntry,
  runtimeRoot,
  type BuildArtifactContext,
  type RestartDaemonContext,
} from "./runtime.ts";
import { actionLine, bold, dim, errorLine, formatRelativeTime, isPretty, joinParts, tildify, yellow } from "../style.ts";
import type { CliIo } from "../main.ts";

import { collectBuildProvenance } from "../../../core/src/release/buildIdentityProducer.ts";
import { hostGitEnv } from "../../../core/src/hostGit.ts";
import { HARNESS_HOME_ENV } from "../../../core/src/accountRecipes.ts";
import { socketPathFits } from "../../../core/src/socketPath.ts";
import { prepareRuntimeTarget, validateRuntimeBuildTarget } from "../../../core/src/release/runtimeTarget.ts";
import { waitForDeployReadiness, type DeployProcessIdentity } from "./readiness.ts";
import { inspectProcess } from "../../../harness/src/processIdentity.ts";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

type Parsed = { args: string[]; flags: Map<string, string | true | string[]> };

const BOOLEAN_FLAGS = new Set(["provision-question-withdrawal", "skip-tests", "allow-non-descendant", "rollback", "list", "json", "init", "help", "h"]);
const KNOWN_FLAGS = new Set([...BOOLEAN_FLAGS, "keep"]);

function setFlag(flags: Parsed["flags"], key: string, value: string | true): void {
  const existing = flags.get(key);
  if (Array.isArray(existing)) existing.push(String(value));
  else if (existing !== undefined) flags.set(key, [String(existing), String(value)]);
  else flags.set(key, value);
}

export function parseDeployArgs(argv: string[]): Parsed {
  const flags: Parsed["flags"] = new Map();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]!;
    if (item === "--") break;
    if (item.startsWith("-") && item.length > 1) {
      const long = item.startsWith("--");
      const eq = long ? item.indexOf("=") : -1;
      const key = item.slice(long ? 2 : 1, eq > -1 ? eq : undefined);
      const booleanFlag = BOOLEAN_FLAGS.has(key) || !KNOWN_FLAGS.has(key);
      const nextIsValue = i + 1 < argv.length && (!argv[i + 1]!.startsWith("-") || argv[i + 1] === "-");
      const value = eq > -1 ? item.slice(eq + 1) : booleanFlag ? true : nextIsValue ? argv[++i]! : true;
      setFlag(flags, key, value);
      continue;
    }
    args.push(item);
  }
  return { args, flags };
}

function flag(parsed: Parsed, key: string): string | true | string[] | undefined {
  return parsed.flags.get(key);
}

function numberFlag(parsed: Parsed, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = flag(parsed, key);
    if (typeof value === "string") {
      const parsedValue = Number(value);
      if (Number.isFinite(parsedValue)) return parsedValue;
    }
  }
  return fallback;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function note(message: string): string {
  return dim(`hive: ${message}`);
}

/** `hive deploy …`: parses its own flags and never opens the daemon. */
export async function runDeployCli(argv: string[], io: CliIo): Promise<number> {
  try {
    await cmdDeploy(parseDeployArgs(argv), io);
    return 0;
  } catch (error) {
    const [first = "", ...rest] = (error instanceof Error ? error.message : String(error)).split("\n");
    io.err(errorLine(first));
    for (const line of rest) io.err(dim(line));
    return 1;
  }
}

const USAGE = [
  "Usage: hive deploy [<sha>] [--keep <n>] [--skip-tests]   build+verify <sha> (default HEAD) in a temp checkout, install to ~/.hive/runtime/<sha>, retarget current, restart daemon",
  "       --provision-question-withdrawal provisions registered local service trust for an approved host; explicit false in config remains disabled",
  "       --skip-tests skips tests with a not release-grade warning; release artifacts cannot skip tests",
  "       refuses a <sha> that does not contain the deployed commit (silent-revert guard); --allow-non-descendant overrides",
  "       hive deploy --rollback             retarget current to the previous deploy and restart the daemon",
  "       hive deploy --list [--json]        show the deploy history",
  "       hive deploy --init                 print the manual steps that make the global `hive` resolve through ~/.hive/runtime/current",
].join("\n");

export async function cmdDeploy(parsed: Parsed, io: CliIo): Promise<void> {
  // Help and unknown flags must never fall through to a real deploy: a bare
  // `hive deploy --help` once built and restarted the live daemon.
  if (parsed.flags.has("help") || parsed.flags.has("h")) {
    io.out(USAGE);
    return;
  }
  const unknown = [...parsed.flags.keys()].filter((key) => !KNOWN_FLAGS.has(key));
  if (unknown.length > 0) throw new Error(`deploy: unknown flag ${unknown.map((key) => `--${key}`).join(", ")}\n${USAGE}`);
  const provision = flag(parsed, "provision-question-withdrawal");
  if (provision !== undefined && provision !== true) throw new Error("deploy: --provision-question-withdrawal is a switch");
  if (provision && ["rollback", "list", "init"].some(name => parsed.flags.has(name))) throw new Error(USAGE);
  const skipTests = flag(parsed, "skip-tests");
  if (skipTests !== undefined && skipTests !== true && !["true", "1", "yes", "false", "0", "no"].includes(String(skipTests))) {
    throw new Error("deploy: --skip-tests requires a boolean value");
  }
  if (skipTests !== undefined && ["rollback", "list", "init"].some(name => parsed.flags.has(name))) throw new Error(USAGE);
  const wantsList = truthy(flag(parsed, "list"));
  const wantsInit = truthy(flag(parsed, "init"));
  const wantsRollback = truthy(flag(parsed, "rollback"));
  const modes = [wantsList, wantsInit, wantsRollback].filter(Boolean).length;
  if (modes > 1 || (modes === 1 && parsed.args.length > 0)) throw new Error(USAGE);
  if (wantsList) return deployList(parsed, io);
  if (wantsInit) return deployInit(io);
  if (wantsRollback) return deployRollback(io);
  if (parsed.args.length > 1) throw new Error(USAGE);
  return deployRun(parsed, io);
}

const HARNESS_HOME_VARIABLES = new Set(Object.values(HARNESS_HOME_ENV));
const RUNNER_HOST_SOCKET_SAMPLE = join("hc-XXXXXX", "s", `hb-rh-${"0".repeat(16)}`, "stdin.sock");

function keepsGateTestVariable(key: string): boolean {
  if (key.startsWith("HIVE_")) return key.startsWith("HIVE_TEST_");
  return !HARNESS_HOME_VARIABLES.has(key);
}

async function gateTestEnv(workDir: string): Promise<{ env: NodeJS.ProcessEnv; dispose: () => Promise<void> }> {
  const bin = join(workDir, "gate-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "security"), "#!/bin/sh\necho 'deploy gate: a test tried to run security; refused' >&2\nexit 1\n", { mode: 0o755 });
  const base = hostGitEnv();
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (keepsGateTestVariable(key)) env[key] = value;
  env.HIVE_NO_KEYCHAIN = "1";
  env.PATH = `${bin}${delimiter}${base.PATH ?? ""}`;
  const temp = socketPathFits(join(tmpdir(), RUNNER_HOST_SOCKET_SAMPLE)) ? null : await realpath(await mkdtemp(join("/tmp", "hive-gate-")));
  if (temp !== null) env.TMPDIR = temp;
  return { env, dispose: async () => { if (temp !== null) await rm(temp, { recursive: true, force: true }); } };
}

/** Stream a build/restart step; the child's output is the progress report. */
async function runStep(command: string, args: string[], cwd: string, log: (line: string) => void, env: NodeJS.ProcessEnv = hostGitEnv()): Promise<void> {
  log(`deploy: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(`deploy: '${command} ${args.join(" ")}' exited with ${result.code ?? `signal ${result.signal}`}`);
  }
}

/**
 * The production build: export the committed tree (never the developer tree),
 * install deps, run the check suite + full tests, build, then materialize the
 * exact published file set (npm pack) with production-only node_modules. The
 * returned stage directory is self-sufficient — nothing in it resolves back
 * into the repo.
 */
export async function buildDeployArtifact(
  { repoRoot, sha, workDir, log, skipTests, release, target }: BuildArtifactContext,
): Promise<{ artifactDir: string }> {
  if (release && skipTests) throw new Error("Release artifacts cannot skip tests");
  if (target !== undefined) validateRuntimeBuildTarget(target);
  const checkout = join(workDir, "checkout");
  await mkdir(checkout, { recursive: true });
  const tarPath = join(workDir, "source.tar");
  await runStep("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, sha], workDir, log);
  await runStep("tar", ["-xf", tarPath, "-C", checkout], workDir, log);

  // git archive removes .git; capture facts for the exported revision, not the working tree.
  await writeFile(join(checkout, ".build-provenance.json"), JSON.stringify(collectBuildProvenance(repoRoot, sha)));
  const gate = await gateTestEnv(workDir);
  try {
    await runStep("npm", ["ci"], checkout, log, gate.env);
    await runStep("npm", ["run", "check"], checkout, log, gate.env);
    await runStep("npm", ["run", "build"], checkout, log, gate.env);
    if (skipTests === true) {
      log("deploy: WARNING test gate skipped (--skip-tests) — this artifact is not release-grade");
    } else {
      for (const script of release ? ["v2:test", "v2:daemon", "v2:driver", "v2:driver2", "v2:harness"] : ["v2:test", "v2:daemon", "v2:driver", "v2:harness"]) {
        await runStep("npm", ["run", script], checkout, log, gate.env);
      }
    }
  } finally { await gate.dispose(); }

  // npm pack gives exactly the `files` set a real install would receive; the
  // lockfile rides along so the stage can `npm ci --omit=dev` production deps.
  const packDest = join(workDir, "pack");
  await mkdir(packDest, { recursive: true });
  const { stdout } = await execFileAsync("npm", ["pack", "--json", "--pack-destination", packDest], { cwd: checkout });
  const { filename } = parseNpmPackResult(stdout, "honeybee");
  const stage = join(workDir, "stage");
  await mkdir(stage, { recursive: true });
  await runStep("tar", ["-xzf", join(packDest, filename), "-C", stage, "--strip-components", "1"], workDir, log);
  await cp(join(checkout, "package-lock.json"), join(stage, "package-lock.json"));
  await runStep("npm", ["ci", "--omit=dev"], stage, log);
  if (target !== undefined) await prepareRuntimeTarget(stage, target);
  return { artifactDir: stage };
}

/**
 * The production restart, run THROUGH the `current` symlink so the LaunchAgent
 * plist binds the stable path — future deploys then only move the symlink.
 */
async function restoreServiceFile(file: string, data: Buffer | null, mode = 0o600): Promise<void> {
  if (data === null) { await rm(file, { force: true }); return; }
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}`;
  const fd = await open(temporary, "wx", mode);
  try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
  await rename(temporary, file);
  const directory = await open(dirname(file), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function restartDeployedDaemon(context: RestartDaemonContext, provision = false): Promise<void> {
  return restartAdmittedDaemon(context, provision);
}

export type LiveTmuxRuntime = { id: string; name: string; generation: number; pid: number | null };

export async function liveTmuxRuntimesFromDaemon(node: string, argv: string[], env: NodeJS.ProcessEnv): Promise<LiveTmuxRuntime[]> {
  const { stdout } = await execFileAsync(node, argv, { timeout: 15_000, env, maxBuffer: 256 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as { views?: Array<{ bee?: { id: string; name: string; substrate: string } | null; runtime?: { generation: number; state: string; pid: number | null } | null }> };
  return (parsed.views ?? [])
    .filter((row) => row.bee?.substrate === "tmux" && row.runtime != null && row.runtime.state !== "stopped")
    .map((row) => ({ id: row.bee!.id, name: row.bee!.name, generation: row.runtime!.generation, pid: row.runtime!.pid ?? null }));
}

export function liveTmuxRuntimes(storePath: string): LiveTmuxRuntime[] {
  if (!existsSync(storePath)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(storePath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=2000");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('bees','runtimes')").all().length) return [];
    return db.prepare(`SELECT b.id AS id, b.name AS name, r.generation AS generation, r.pid AS pid
      FROM bees b JOIN runtimes r ON r.bee_id = b.id
      WHERE b.substrate = 'tmux' AND r.state != 'stopped'
        AND r.generation = (SELECT MAX(generation) FROM runtimes WHERE bee_id = b.id)
      ORDER BY b.name, b.id`).all() as LiveTmuxRuntime[];
  } catch (error) {
    throw new Error(`deploy: the store is held by a running daemon that did not answer the tmux runtime check; retry once it answers (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  } finally {
    db?.close();
  }
}

export class DeployTmuxRuntimesLiveError extends Error {
  readonly code = "DEPLOY_TMUX_RUNTIMES_LIVE";
  readonly runtimes: LiveTmuxRuntime[];
  constructor(runtimes: LiveTmuxRuntime[]) {
    super(`deploy: DEPLOY_TMUX_RUNTIMES_LIVE: this build has no tmux substrate and will not adopt or signal a pane; stop these bees under the running daemon first (hive stop <bee>), then deploy again: ${runtimes.map(r => `${r.name} (${r.id}, generation ${r.generation}${r.pid != null ? `, pid ${r.pid}` : ""})`).join("; ")}`);
    this.name = "DeployTmuxRuntimesLiveError";
    this.runtimes = runtimes;
  }
}

async function restartAdmittedDaemon({ root, installedDir, sha, log, restorePrevious, assertRollbackSafe }: RestartDaemonContext, provision: boolean): Promise<void> {
  const dataDir = join(root, "..", "v2");
  let daemonLogPath = join(dataDir, "hived.log");
  try {
    const configured = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")).logPath;
    if (typeof configured === "string" && isAbsolute(configured)) daemonLogPath = configured;
  } catch {}
  const pin = resolveNodePin(dataDir, process.env, undefined, true);
  const tmuxRuntimes = await liveTmuxRuntimesFromDaemon(pin.path, [join(root, CURRENT_LINK_NAME, "dist", "cli.js"), "v2", "ls", "--json", "--all", "--data-dir", dataDir], { ...nativeNodeEnv(), ...nodePinEnv(pin) })
    .catch(() => liveTmuxRuntimes(join(dataDir, "core.sqlite3")));
  if (tmuxRuntimes.length > 0) throw new DeployTmuxRuntimesLiveError(tmuxRuntimes);
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("deploy: unsupported service platform");
  const directory = serviceDirectory();
  const service = join(directory, `${process.env.HIVE_V2_SERVICE_LABEL ?? "dev.honeybee.hive.v2"}.${process.platform === "darwin" ? "plist" : "service"}`);
  const files = await Promise.all([service, nodePinFile(dataDir), nodeRepairFile(dataDir)].map(async file => {
    const data = await readFile(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
    return { file, data, mode: data === null ? 0o600 : (await lstat(file)).mode & 0o777 };
  }));
  const cli = join(root, CURRENT_LINK_NAME, "dist", "cli.js");
  const args = (verb: string) => [cli, "v2", "daemon", verb, "--data-dir", dataDir];
  const run = (verb: string, selected: NodePin = pin) => runStep(selected.path, args(verb), root, log, { ...nativeNodeEnv(hostGitEnv()), ...nodePinEnv(selected) });
  const deployedIdentity = async (selected: NodePin) => {
    const { stdout } = await execFileAsync(selected.path, [cli, "v2", "deploy-info", "--data-dir", dataDir, "--json"], { timeout: 2000, env: { ...nativeNodeEnv(), ...nodePinEnv(selected) } });
    return JSON.parse(stdout) as { pid: number; startedAt: number; nodeVersion: string; identity?: { sourceRevision?: string } };
  };
  const verifyRunningPin = async (selected: NodePin, expected: Awaited<ReturnType<typeof deployedIdentity>>) => {
    const executable = process.platform === "linux" ? await realpath(`/proc/${expected.pid}/exe`)
      : (await execFileAsync("ps", ["-p", String(expected.pid), "-o", "comm="], { env: nativeNodeEnv(), timeout: 2000 })).stdout.trim();
    const running = probeNativeNode(executable), confirmed = await deployedIdentity(selected);
    if (running.path !== selected.path || running.version !== selected.version || running.sha256 !== selected.sha256
      || confirmed.pid !== expected.pid || confirmed.startedAt !== expected.startedAt) throw new Error("deploy: recovered daemon executable identity differs from its pin");
  };
  const label = process.env.HIVE_V2_SERVICE_LABEL ?? "dev.honeybee.hive.v2";
  const absent = async () => {
    if (process.platform === "darwin") {
      try { await execFileAsync("launchctl", ["print", `gui/${process.getuid!()}/${label}`], { env: nativeNodeEnv(), timeout: 2000 }); return false; }
      catch (error) { const e = error as { stderr?: string }; if (/Could not find service/.test(e.stderr ?? "")) return true; throw error; }
    }
    const { stdout } = await execFileAsync("systemctl", ["--user", "show", `${label}.service`, "--property=ActiveState,MainPID"], { env: nativeNodeEnv(), timeout: 2000 });
    return /^(?:ActiveState=inactive|ActiveState=failed)$/m.test(stdout) && /^MainPID=0$/m.test(stdout);
  };
  const waitAbsent = async () => {
    const deadline = Date.now() + 60_000;
    while (true) {
      if (await absent()) return;
      if (Date.now() >= deadline) throw new Error("deploy: service unload is unconfirmed; refusing recovery while a daemon may still be running");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const status = async (selected: NodePin) => {
    const { stdout } = await execFileAsync(selected.path, [...args("status"), "--json"], { timeout: 2000, env: { ...nativeNodeEnv(), ...nodePinEnv(selected) } });
    return JSON.parse(stdout) as { running?: boolean; repair?: unknown; health?: { pid?: number }; service?: { installed?: boolean } };
  };
  let candidateProcess: DeployProcessIdentity | undefined;
  let lastProgressLog = -Infinity;
  const ready = async (selected: NodePin) => waitForDeployReadiness({
    onProgress: (identity, elapsed) => {
      if (elapsed - lastProgressLog >= 5000) {
        log(`deploy: daemon startup progressing (pid ${identity.pid}, ${Math.round(elapsed / 1000)}s)`);
        lastProgressLog = elapsed;
      }
    },
    observe: async () => {
      const state = await status(selected).catch(() => ({ running: false }));
      if (state.running && !("health" in state)) return { ready: true, progress: "ready" };
      if ("repair" in state && state.repair) return { ready: false, repair: true, progress: "repair" };
      let pid = "health" in state ? state.health?.pid : undefined;
      try { if (!pid) {
        const output = process.platform === "darwin"
          ? (await execFileAsync("launchctl", ["print", `gui/${process.getuid!()}/${label}`], { env: nativeNodeEnv(), timeout: 2000 })).stdout
          : (await execFileAsync("systemctl", ["--user", "show", `${label}.service`, "--property=MainPID", "--value"], { env: nativeNodeEnv(), timeout: 2000 })).stdout;
        pid = Number(process.platform === "darwin" ? /\bpid = (\d+)/.exec(output)?.[1] : output.trim());
      }
      } catch { pid = undefined; }
      const observed = pid && Number.isSafeInteger(pid) ? inspectProcess(pid) : null;
      const live = observed?.kind === "present" && observed.state === "live"
        ? { pid: observed.pid, birth: observed.birth, bootId: observed.bootId } : undefined;
      candidateProcess = live ?? candidateProcess;
      if (state.running && live) return { ready: true, process: live, progress: "ready" };
      const paths = [join(dataDir, "core.sqlite3"), join(dataDir, "core.sqlite3-wal"), daemonLogPath];
      const metrics = await Promise.all(paths.map(async path => {
        try {
          const value = await lstat(path, { bigint: true });
          return [value.dev, value.ino, value.size, value.mtimeNs].map(String);
        } catch { return null; }
      }));
      let schema: string | null = null;
      if (existsSync(join(dataDir, "core.sqlite3"))) {
        try {
          const db = new DatabaseSync(join(dataDir, "core.sqlite3"), { readOnly: true });
          try { db.exec("PRAGMA busy_timeout=50"); schema = String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value); }
          finally { db.close(); }
        } catch { schema = null; }
      }
      return { ready: false, process: live, processGone: observed?.kind === "gone" || observed?.kind === "present" && observed.state === "zombie", progress: JSON.stringify({ metrics, schema }) };
    },
  });
  const checkRollback = async () => {
    if (!assertRollbackSafe) throw new Error("read-only rollback compatibility probe unavailable");
    await assertRollbackSafe();
  };
  const held = (error: unknown, refusal: unknown, readiness: DeployActivationHeldError["candidateReadiness"] = "unknown") => new DeployActivationHeldError(sha,
    `${error instanceof Error ? error.message : String(error)}; recovery held: ${refusal instanceof Error ? refusal.message : String(refusal)}${candidateProcess ? `; candidate pid ${candidateProcess.pid} birth ${candidateProcess.birth}` : ""}`,
    { cause: error }, readiness);
  let previousIdentity: Awaited<ReturnType<typeof deployedIdentity>> | undefined;
  if (restorePrevious) {
    try { previousIdentity = await deployedIdentity(pin); }
    catch (error) { if (!await absent()) throw error; }
    if (previousIdentity && (!Number.isSafeInteger(previousIdentity.pid) || !previousIdentity.identity?.sourceRevision)) throw new Error("deploy: previous daemon identity unavailable; refusing to stop");
  }
  let withdrawal: Awaited<ReturnType<typeof provisionQuestionWithdrawal>> | undefined;
  let stopped = false;
  let stopInitiated = false;
  try {
    await run("install");
    try { stopInitiated = true; await run("stop"); if (restorePrevious) await waitAbsent(); stopped = true; }
    catch (error) {
      if (restorePrevious) { await waitAbsent(); stopped = true; throw error; }
      const state = await status(pin);
      if (state.running !== false || state.service?.installed !== false) throw error;
      stopped = true;
      log("deploy: v2 service is absent (fresh start)");
    }
    withdrawal = provision ? await provisionQuestionWithdrawal(dataDir) : undefined;
    if (withdrawal) log(withdrawal.enabled ? "deploy: approved question withdrawal provisioning enabled" : "deploy: question withdrawal explicitly disabled; preserving opt-out");
    await run("start");
    await ready(pin);
    if (withdrawal?.enabled) await verifyQuestionWithdrawal(dataDir);
  } catch (error) {
    if (stopInitiated && restorePrevious) {
      try { await checkRollback(); }
      catch (refusal) {
        let readiness: DeployActivationHeldError["candidateReadiness"] = "unavailable";
        try {
          const info = await deployedIdentity(pin);
          if (info.identity?.sourceRevision === sha && info.nodeVersion === `v${pin.version}` && Number.isSafeInteger(info.pid) && info.pid > 0) {
            await verifyRunningPin(pin, info);
            readiness = "ready";
          }
        } catch {}
        throw held(error, refusal, readiness);
      }
      await run("stop").catch(() => undefined);
      await waitAbsent();
      stopped = true;
    } else if (stopped) throw held(error, "no previous runtime is available");
    let restored = false;
    let recoveryError: unknown;
    try { restored = await restorePrevious?.() ?? false; }
    catch (failure) { recoveryError = failure; if (failure instanceof Error) failure.cause ??= error; }
    if (recoveryError) {
      if (stopped) {
        try {
          await assertRollbackStoreCompatible(root, installedDir);
          candidateProcess = undefined;
          lastProgressLog = -Infinity;
          await run("start");
          await ready(pin);
          const recovered = await deployedIdentity(pin);
          if (recovered.identity?.sourceRevision !== sha || recovered.nodeVersion !== `v${pin.version}` || !Number.isSafeInteger(recovered.pid) || recovered.pid <= 0) throw new Error("candidate recovery identity differs");
          await verifyRunningPin(pin, recovered);
          throw held(error, `rollback refused after stop; candidate restarted and ready (pid ${recovered.pid}); ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, "ready");
        } catch (candidateError) {
          if (candidateError instanceof DeployActivationHeldError) throw candidateError;
          throw held(error, `rollback refused after stop; candidate recovery unavailable: ${candidateError instanceof Error ? candidateError.message : String(candidateError)}; ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, "unavailable");
        }
      }
      throw held(error, recoveryError);
    }
    if (restorePrevious && !restored) throw held(error, "previous runtime was not restored");
    let trustRestoreError: unknown;
    if (restored || !stopInitiated) {
      try { await withdrawal?.restore(); }
      catch (failure) { trustRestoreError = failure; }
    }
    if (restored) {
      for (const snapshot of files) await restoreServiceFile(snapshot.file, snapshot.data, snapshot.mode);
      if (process.platform === "linux") await execFileAsync("systemctl", ["--user", "daemon-reload"], { env: nativeNodeEnv() });
    }
    if (stopped && restored && previousIdentity) {
      const priorPin = resolveNodePin(dataDir, { ...process.env, HIVE_NODE_PATH: undefined, HIVE_NODE_VERSION: undefined, HIVE_NODE_SHA256: undefined });
      await run("start", priorPin);
      await ready(priorPin);
      const recovered = await deployedIdentity(priorPin);
      if (JSON.stringify(recovered.identity) !== JSON.stringify(previousIdentity.identity) || recovered.pid === previousIdentity.pid
        || recovered.nodeVersion !== `v${priorPin.version}` || !Number.isSafeInteger(recovered.pid)) throw new Error("deploy: recovered daemon build or interpreter identity differs from the previous runtime");
      await verifyRunningPin(priorPin, recovered);
      log("deploy: previous runtime and service recovered after failed activation");
    }
    if (trustRestoreError) throw held(error, `trust configuration restore failed; previous runtime ${stopped && restored && previousIdentity ? "restarted with current on-disk trust configuration" : "restart not confirmed"}; ${trustRestoreError instanceof Error ? trustRestoreError.message : String(trustRestoreError)}`);
    throw error;
  }
}

async function resolveHoneybeeRepoRoot(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), env: hostGitEnv() }));
  } catch {
    throw new Error("deploy: run this from inside the honeybee repo (not a git repository here)");
  }
  const repoRoot = stdout.trim();
  let name: unknown;
  try {
    name = (JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    name = undefined;
  }
  if (name !== "honeybee") {
    throw new Error(`deploy: ${repoRoot} is not the honeybee repo (package ${String(name ?? "unknown")})`);
  }
  return repoRoot;
}

async function deployRun(parsed: Parsed, io: CliIo): Promise<void> {
  const repoRoot = await resolveHoneybeeRepoRoot();
  const ref = parsed.args[0];
  const keep = numberFlag(parsed, ["keep"], DEFAULT_KEEP_VERSIONS);
  const log = (line: string) => io.out(isPretty() ? dim(line) : line);
  const outcome = await deployVersion({
    repoRoot,
    ...(ref !== undefined ? { ref } : {}),
    keep,
    skipTests: truthy(flag(parsed, "skip-tests")),
    log,
    ...(parsed.flags.has("allow-non-descendant") ? { allowNonDescendant: true } : {}),
    hooks: { buildArtifact: buildDeployArtifact, backupStore: backupBeforeSwap, restartDaemon: context => restartDeployedDaemon(context, flag(parsed, "provision-question-withdrawal") === true) },
  });
  if (isPretty()) {
    io.out(actionLine("ok", "deploy", joinParts([bold(outcome.sha.slice(0, 12)), dim(`→ ${tildify(outcome.installedDir)}`)])));
    io.out(dim(`  artifact: ${outcome.artifactHash.slice(0, 12)}  previous: ${outcome.previousSha?.slice(0, 12) ?? "none"}  pruned: ${outcome.pruned.length}`));
  } else {
    io.out(`deploy\t${outcome.sha}\t${outcome.artifactHash}\t${outcome.installedDir}\t${outcome.pruned.length}`);
  }
}

async function deployRollback(io: CliIo): Promise<void> {
  const log = (line: string) => io.out(isPretty() ? dim(line) : line);
  const outcome = await rollbackDeploy({
    log,
    hooks: { backupStore: backupBeforeSwap, restartDaemon: restartDeployedDaemon },
  });
  if (isPretty()) {
    io.out(actionLine("ok", "deploy", joinParts([bold("rollback"), dim(`${outcome.from.slice(0, 12)} → ${outcome.sha.slice(0, 12)}`)])));
  } else {
    io.out(`rollback\t${outcome.from}\t${outcome.sha}`);
  }
}

async function deployList(parsed: Parsed, io: CliIo): Promise<void> {
  const root = runtimeRoot();
  const entries = await readDeployHistory(root);
  const currentSha = await currentDeployTarget(root);
  if (truthy(flag(parsed, "json"))) {
    io.out(JSON.stringify({ root, current: currentSha, entries }, null, 2));
    return;
  }
  if (entries.length === 0) {
    io.out(note(`no deploys recorded under ${tildify(root)} — run: hive deploy`));
    return;
  }
  const pretty = isPretty();
  const rollback = rollbackTargetEntry(entries, currentSha);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const isCurrent = entry.sha === currentSha && !entries.slice(index + 1).some((later) => later.sha === currentSha);
    const marker = [isCurrent ? "current" : "", entry.activation ? `activation ${entry.activation}` : ""].filter(Boolean).join("; ");
    if (pretty) {
      const sha = isCurrent ? bold(entry.sha.slice(0, 12)) : entry.sha.slice(0, 12);
      const when = formatRelativeTime(Date.parse(entry.at));
      const badge = `${isCurrent ? ` ${yellow("← current")}` : ""}${entry.activation ? ` ${yellow(`activation ${entry.activation}`)}` : ""}`;
      io.out(`${sha}  ${dim(entry.artifactHash.slice(0, 12))}  ${dim(when)}  ${dim(entry.by)}${badge}`);
    } else {
      io.out(`${entry.sha}\t${entry.at}\t${entry.artifactHash}\t${entry.by}\t${marker}`);
    }
  }
  if (pretty && rollback) io.out(dim(`rollback target: ${rollback.sha.slice(0, 12)}`));
}

type PathState =
  | { kind: "missing" }
  | { kind: "symlink"; target: string }
  | { kind: "directory" }
  | { kind: "file" };

async function inspectPath(path: string): Promise<PathState> {
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    return { kind: "missing" };
  }
  if (stats.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
  if (stats.isDirectory()) return { kind: "directory" };
  return { kind: "file" };
}

/**
 * Print-only by design: rewiring the live global npm tree from inside a
 * process that is currently EXECUTING out of that tree (and that npm will
 * happily clobber on the next `npm i -g`) is exactly the class of hazard this
 * spec exists to remove. The one-time migration is four commands; the
 * operator runs them deliberately.
 */
async function deployInit(io: CliIo): Promise<void> {
  const root = runtimeRoot();
  const currentDir = join(root, CURRENT_LINK_NAME);
  const deployed = existsSync(join(currentDir, "dist", "cli.js"));
  let prefix: string;
  try {
    prefix = (await execFileAsync("npm", ["prefix", "-g"])).stdout.trim();
  } catch {
    throw new Error("deploy: cannot determine the npm global prefix (`npm prefix -g` failed)");
  }
  const pkgDir = join(prefix, "lib", "node_modules", "honeybee");
  const binPath = join(prefix, "bin", "hive");
  const pkgState = await inspectPath(pkgDir);
  const binState = await inspectPath(binPath);

  const pretty = isPretty();
  const heading = (line: string) => io.out(pretty ? bold(line) : line);
  const detail = (line: string) => io.out(pretty ? dim(line) : line);

  heading("hive deploy --init — migrate the global `hive` onto ~/.hive/runtime/current");
  detail("");
  detail(`  runtime root:    ${tildify(root)} ${deployed ? "(current deployed)" : "(NOTHING DEPLOYED YET)"}`);
  detail(`  global package:  ${pkgDir} [${pkgState.kind === "symlink" ? `symlink → ${pkgState.target}` : pkgState.kind}]`);
  detail(`  global bin:      ${binPath} [${binState.kind === "symlink" ? `symlink → ${binState.target}` : binState.kind}]`);
  detail("");
  if (pkgState.kind === "symlink" && pkgState.target.startsWith(currentDir)) {
    io.out(note("already migrated: the global package resolves through runtime/current."));
    return;
  }
  io.out("This step is print-only (it never rewires the live tree itself). Run, in order:");
  io.out("");
  let step = 1;
  if (!deployed) {
    io.out(`  ${step++}. hive deploy`);
    io.out("     # install a first version under ~/.hive/runtime before switching resolution");
  }
  if (pkgState.kind === "directory" || pkgState.kind === "file") {
    io.out(`  ${step++}. mv "${pkgDir}" "${pkgDir}.pre-runtime"`);
    io.out("     # keep the old npm-installed tree as an escape hatch; delete it once the migration is verified");
  }
  io.out(`  ${step++}. ln -s "${currentDir}" "${pkgDir}.new" && mv -h "${pkgDir}.new" "${pkgDir}"`);
  io.out("     # atomic swap (BSD mv -h: replace the link itself, never follow it)");
  if (binState.kind === "missing" || binState.kind === "symlink") {
    io.out(`  ${step++}. ln -sfn "../lib/node_modules/honeybee/dist/cli.js" "${binPath}"`);
    io.out("     # npm-style relative bin shim; resolves through the package symlink, i.e. through runtime/current");
  }
  io.out(`  ${step++}. hive daemon install --force && hive daemon restart`);
  io.out("     # rebind the LaunchAgent plist to the runtime/current CLI path");
  io.out(`  ${step}. readlink "${pkgDir}" && hive deploy --list`);
  io.out("     # verify: the package resolves through runtime/current and history shows the active sha");
  io.out("");
  io.out(note("warning: any future `npm i -g honeybee` / `npm update -g` will clobber the symlink — redo the ln/mv step after such commands (or simply never run them again; `hive deploy` replaces them)."));
}

export async function backupBeforeSwap({ root, installedDir, sourceRevision }: { root: string; installedDir: string; sourceRevision: string | null }): Promise<{ receiptPath: string }> {
  const dataDir = join(root, "..", "v2");
  const pin = resolveNodePin(dataDir, process.env);
  const sourceBuild = sourceRevision ? await readFile(join(root, sourceRevision, "dist", "build-identity.json"), "utf8") : "unknown: no previous runtime";
  const { stdout } = await execFileAsync(pin.path, [join(installedDir, "dist", "cli.js"), "v2", "store", "backup", "--data-dir", dataDir, "--source-build", sourceBuild, "--json"],
    { timeout: 120_000, env: { ...nativeNodeEnv(), ...nodePinEnv(pin) } });
  const receipt = JSON.parse(stdout.trim());
  if (receipt.format !== 1 || typeof receipt.receiptPath !== "string" || receipt.integrityCheck !== "ok") throw new Error("deploy: backup receipt was not finalized");
  if (sourceRevision && JSON.parse(receipt.sourceBuild).sourceRevision !== sourceRevision) throw new Error("deploy: backup source build differs from the selected runtime");
  return receipt;
}
