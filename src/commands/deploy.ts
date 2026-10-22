import { assertRunningBuildPin, readBuildPin, type ObservedBuild } from "../buildPin.ts";
import { parseNpmPackResult } from "../npmPack.js";
import { serviceDirectory } from "../servicePaths.js";
import { randomUUID } from "node:crypto";
import { probeNativeNode, resolveNodePin, nativeNodeEnv, nodePinEnv, nodePinFile, nodeRepairFile, type NodePin } from "../nodeRuntime.js";
// `hive deploy` — versioned runtime deploys (reset WP0, spec 00). The
// orchestration lives in src/deployRuntime.ts; this module wires the CLI
// surface plus the two production hooks: the real clean-checkout build and
// the real daemon restart. Tests drive deployRuntime with injected hooks and
// never reach the code in this file's hook implementations.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, open, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  assertDeployRestartAdmission,
  hasDeployRestartAdmission,
  CURRENT_LINK_NAME,
  DEFAULT_KEEP_VERSIONS,
  currentDeployTarget,
  deployVersion,
  deployArtifact,
  readDeployHistory,
  rollbackDeploy,
  rollbackTargetEntry,
  runtimeRoot,
  type BuildArtifactContext,
  type RestartDaemonContext,
} from "../deployRuntime.js";
import { assertRuntimeUpdateAllowed } from "../readUpdateReservation.js";
import { withFileLock } from "../lock.js";
import { runtimeUsesV2 } from "../cliRoute.js";
import { actionLine, bold, dim, formatRelativeTime, isPretty, note, tildify, yellow } from "../format.js";
import { flag, numberFlag, truthy, type Parsed } from "../parse.js";

import { collectBuildProvenance } from "../release/buildIdentityProducer.js";
import { hostGitEnv } from "../hostGit.js";
import { prepareRuntimeTarget, validateRuntimeBuildTarget } from "../release/runtimeTarget.js";

const execFileAsync = promisify(execFile);

const USAGE = [
  "Usage: hive deploy [<sha>] [--keep <n>] [--skip-tests]   build+verify <sha> (default HEAD) in a temp checkout, install to ~/.hive/runtime/<sha>, retarget current, restart daemon",
  "       --override-build-pin <reason> records an explicit desired-build policy override",
  "       --skip-tests skips tests with a not release-grade warning; release artifacts cannot skip tests",
  "       refuses a <sha> that does not contain the deployed commit (silent-revert guard); --allow-non-descendant overrides",
  "       hive deploy --rollback             retarget current to the previous deploy and restart the daemon",
  "       hive deploy --artifact <archive> --identity <json> --admission <json> --expected-current <sha|none> [--bin-dir <directory>]   install exact verified release bytes",
  "       hive deploy --list [--json]        show the deploy history",
  "       hive deploy --init                 print the manual steps that make the global `hive` resolve through ~/.hive/runtime/current",
].join("\n");

const KNOWN_FLAGS = new Set(["override-build-pin", "skip-tests", "keep", "allow-non-descendant", "rollback", "list", "json", "init", "artifact", "identity", "expected-current", "admission", "bin-dir"]);

export async function cmdDeploy(parsed: Parsed): Promise<void> {
  // Help and unknown flags must never fall through to a real deploy: a bare
  // `hive deploy --help` once built and restarted the live daemon.
  if (parsed.flags.has("help") || parsed.flags.has("h")) {
    console.log(USAGE);
    return;
  }
  const unknown = [...parsed.flags.keys()].filter((key) => !KNOWN_FLAGS.has(key));
  if (unknown.length > 0) throw new Error(`deploy: unknown flag ${unknown.map((key) => `--${key}`).join(", ")}\n${USAGE}`);
  const pinOverride = flag(parsed, "override-build-pin");
  if (pinOverride !== undefined && (typeof pinOverride !== "string" || !pinOverride.trim())) throw new Error("deploy: --override-build-pin requires a reason");
  const skipTests = flag(parsed, "skip-tests");
  if (skipTests !== undefined && skipTests !== true && !["true", "1", "yes", "false", "0", "no"].includes(String(skipTests))) {
    throw new Error("deploy: --skip-tests requires a boolean value");
  }
  if (skipTests !== undefined && ["artifact", "rollback", "list", "init"].some(name => parsed.flags.has(name))) throw new Error(USAGE);
  const archive = flag(parsed, "artifact");
  if (archive !== undefined) {
    const identity = flag(parsed, "identity"), expected = flag(parsed, "expected-current"), admission = flag(parsed, "admission"), binDirectory = flag(parsed, "bin-dir");
    if (typeof archive !== "string" || typeof identity !== "string" || typeof expected !== "string" || typeof admission !== "string"
      || (binDirectory !== undefined && (typeof binDirectory !== "string" || binDirectory.length === 0))
      || (expected !== "none" && !/^[a-f0-9]{40}$/.test(expected)) || parsed.args.length
      || ["list", "init", "rollback"].some(name => parsed.flags.has(name))) throw new Error(USAGE);
    const result = await deployArtifact({ buildPinOverride: pinOverride as string | undefined, archive, identity: JSON.parse(await readFile(identity, "utf8")),
      admission: JSON.parse(await readFile(admission, "utf8")),
      ...(typeof binDirectory === "string" ? { cliBinDirectory: binDirectory } : {}),
      expectedCurrent: expected === "none" ? null : expected, hooks: { backupStore: backupBeforeSwap, restartDaemon: restartDeployedDaemon } });
    console.log(JSON.stringify(result));
    return;
  }
  if (["identity", "admission", "expected-current", "bin-dir"].some(name => parsed.flags.has(name))) throw new Error(USAGE);
  const wantsList = truthy(flag(parsed, "list"));
  const wantsInit = truthy(flag(parsed, "init"));
  const wantsRollback = truthy(flag(parsed, "rollback"));
  const modes = [wantsList, wantsInit, wantsRollback].filter(Boolean).length;
  if (modes > 1 || (modes === 1 && parsed.args.length > 0)) throw new Error(USAGE);
  if (wantsList) return deployList(parsed);
  if (wantsInit) return deployInit();
  if (wantsRollback) return deployRollback();
  if (parsed.args.length > 1) throw new Error(USAGE);
  return deployRun(parsed);
}

/**
 * The test steps of a deploy gate never reach the login Keychain: the
 * Keychain bridge is switched off and a refusing `security` stands first on
 * PATH, so even a test child spawned with a fully replaced environment that
 * keeps PATH cannot run the real binary by name.
 */
async function keychainFreeGateEnv(workDir: string): Promise<NodeJS.ProcessEnv> {
  const bin = join(workDir, "gate-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "security"), "#!/bin/sh\necho 'deploy gate: a test tried to run security; refused' >&2\nexit 1\n", { mode: 0o755 });
  const env = hostGitEnv();
  return { ...env, HIVE_NO_KEYCHAIN: "1", PATH: `${bin}${delimiter}${env.PATH ?? ""}` };
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
  const gateEnv = await keychainFreeGateEnv(workDir);
  await runStep("npm", ["ci"], checkout, log, gateEnv);
  await runStep("npm", ["run", "check"], checkout, log, gateEnv);
  await runStep("npm", ["run", "build"], checkout, log, gateEnv);
  if (skipTests === true) {
    log("deploy: WARNING test gate skipped (--skip-tests) — this artifact is not release-grade");
  } else if (release) {
    for (const script of ["v2:check", "v2:test", "v2:daemon", "v2:driver", "v2:driver2", "v2:harness"]) {
      await runStep("npm", ["run", script], checkout, log, gateEnv);
    }
    await runStep("npm", ["test"], checkout, log, gateEnv);
  } else if (runtimeUsesV2(runtimeRoot())) {
    // Post-flip node (WP7): the old suite's CLI-shelling tests don't override
    // the store root, so on a frozen machine they route into v2 and hang
    // (2026-08-19: deploy gate deadlocked against its own flip). The v2
    // battery is the gate for what actually ships; the old suite keeps
    // running in repo CI until WP8 removes the old tree.
    log("deploy: v2 node — gating on the v2 battery instead of the legacy suite");
    for (const script of ["v2:test", "v2:daemon", "v2:driver", "v2:harness"]) {
      await runStep("npm", ["run", script], checkout, log, gateEnv);
    }
  } else {
    await runStep("npm", ["test"], checkout, log, gateEnv);
  }

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

export async function restartDeployedDaemon(context: RestartDaemonContext): Promise<void> {
  if (hasDeployRestartAdmission(context)) {
    await assertDeployRestartAdmission(context);
    return restartAdmittedDaemon(context);
  }
  await withFileLock(join(context.root, ".deploy.lock"), async () => {
    await assertRuntimeUpdateAllowed(context.root, "restart");
    await restartAdmittedDaemon(context);
  });
}

async function restartAdmittedDaemon({ root, log, runtime, restorePrevious }: RestartDaemonContext): Promise<void> {
  const v2 = runtime === "v2" || runtimeUsesV2(root);
  if (!v2) throw new Error("deploy: legacy service activation is refused; install the pinned v2 service first");
  const dataDir = join(root, "..", "v2");
  const pin = resolveNodePin(dataDir, process.env, undefined, true);
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
    return JSON.parse(stdout) as { running?: boolean; repair?: unknown; service?: { installed?: boolean } };
  };
  const ready = async (selected: NodePin) => {
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        const state = await status(selected);
        if (state.running === true) return;
        if (state.repair) throw new Error("deploy: daemon held, needs Node pin repair");
      } catch (error) {
        if (error instanceof Error && error.message.includes("needs Node pin repair")) throw error;
      }
      if (Date.now() >= deadline) throw new Error("deploy: daemon failed readiness after start");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  let previousIdentity: Awaited<ReturnType<typeof deployedIdentity>> | undefined;
  if (restorePrevious) {
    try { previousIdentity = await deployedIdentity(pin); }
    catch (error) { if (!await absent()) throw error; }
    if (previousIdentity && (!Number.isSafeInteger(previousIdentity.pid) || !previousIdentity.identity?.sourceRevision)) throw new Error("deploy: previous daemon identity unavailable; refusing to stop");
  }
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
    await run("start");
    await ready(pin);
    if (readBuildPin(root)) {
      const { stdout } = await execFileAsync(pin.path, [cli, "v2", "build-report", "--data-dir", dataDir, "--json"], { timeout: 5000, env: { ...nativeNodeEnv(), ...nodePinEnv(pin) } });
      const report = JSON.parse(stdout) as { running: ObservedBuild | null };
      if (!report.running) throw new Error("deploy: running build identity unavailable after activation");
      assertRunningBuildPin(root, report.running);
    }
  } catch (error) {
    if (stopInitiated && restorePrevious) {
      await run("stop").catch(() => undefined);
      await waitAbsent();
      stopped = true;
    } else if (stopped) await run("stop").catch(() => undefined);
    let restored = false;
    let recoveryError: unknown;
    try { restored = await restorePrevious?.() ?? false; }
    catch (failure) { recoveryError = failure; if (failure instanceof Error) failure.cause ??= error; }
    if (restorePrevious) {
      for (const snapshot of files) await restoreServiceFile(snapshot.file, snapshot.data, snapshot.mode);
      if (process.platform === "linux") await execFileAsync("systemctl", ["--user", "daemon-reload"], { env: nativeNodeEnv() });
    }
    if (recoveryError) throw recoveryError;
    if (stopped && restored && previousIdentity) {
      const priorPin = resolveNodePin(dataDir, { ...process.env, HIVE_NODE_PATH: undefined, HIVE_NODE_VERSION: undefined, HIVE_NODE_SHA256: undefined });
      await run("start", priorPin);
      await ready(priorPin);
      const recovered = await deployedIdentity(priorPin);
      if (JSON.stringify(recovered.identity) !== JSON.stringify(previousIdentity.identity) || recovered.pid === previousIdentity.pid
        || recovered.nodeVersion !== `v${priorPin.version}` || !Number.isSafeInteger(recovered.pid)) throw new Error("deploy: recovered daemon build or interpreter identity differs from the previous runtime");
      const executable = process.platform === "linux" ? await realpath(`/proc/${recovered.pid}/exe`)
        : (await execFileAsync("ps", ["-p", String(recovered.pid), "-o", "comm="], { env: nativeNodeEnv(), timeout: 2000 })).stdout.trim();
      const runningPin = probeNativeNode(executable);
      const confirmed = await deployedIdentity(priorPin);
      if (runningPin.path !== priorPin.path || runningPin.version !== priorPin.version || runningPin.sha256 !== priorPin.sha256
        || confirmed.pid !== recovered.pid || confirmed.startedAt !== recovered.startedAt) throw new Error("deploy: recovered daemon executable identity differs from the previous pin");
      log("deploy: previous runtime and service recovered after failed activation");
    }
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

async function deployRun(parsed: Parsed): Promise<void> {
  const repoRoot = await resolveHoneybeeRepoRoot();
  const ref = parsed.args[0];
  const keep = numberFlag(parsed, ["keep"], DEFAULT_KEEP_VERSIONS);
  const log = (line: string) => console.log(isPretty() ? dim(line) : line);
  const outcome = await deployVersion({
    repoRoot,
    ...(ref !== undefined ? { ref } : {}),
    keep,
    skipTests: truthy(flag(parsed, "skip-tests")),
    buildPinOverride: flag(parsed, "override-build-pin") as string | undefined,
    log,
    ...(parsed.flags.has("allow-non-descendant") ? { allowNonDescendant: true } : {}),
    hooks: { buildArtifact: buildDeployArtifact, backupStore: backupBeforeSwap, restartDaemon: restartDeployedDaemon },
  });
  if (isPretty()) {
    console.log(actionLine("ok", "deploy", [
      bold(outcome.sha.slice(0, 12)),
      dim(`→ ${tildify(outcome.installedDir)}`),
    ]));
    console.log(dim(`  artifact: ${outcome.artifactHash.slice(0, 12)}  previous: ${outcome.previousSha?.slice(0, 12) ?? "none"}  pruned: ${outcome.pruned.length}`));
  } else {
    console.log(`deploy\t${outcome.sha}\t${outcome.artifactHash}\t${outcome.installedDir}\t${outcome.pruned.length}`);
  }
}

async function deployRollback(): Promise<void> {
  const log = (line: string) => console.log(isPretty() ? dim(line) : line);
  const outcome = await rollbackDeploy({
    log,
    hooks: { backupStore: backupBeforeSwap, restartDaemon: restartDeployedDaemon },
  });
  if (isPretty()) {
    console.log(actionLine("ok", "deploy", [
      bold("rollback"),
      dim(`${outcome.from.slice(0, 12)} → ${outcome.sha.slice(0, 12)}`),
    ]));
  } else {
    console.log(`rollback\t${outcome.from}\t${outcome.sha}`);
  }
}

async function deployList(parsed: Parsed): Promise<void> {
  const root = runtimeRoot();
  const entries = await readDeployHistory(root);
  const currentSha = await currentDeployTarget(root);
  if (truthy(flag(parsed, "json"))) {
    console.log(JSON.stringify({ root, current: currentSha, entries }, null, 2));
    return;
  }
  if (entries.length === 0) {
    console.log(note(`no deploys recorded under ${tildify(root)} — run: hive deploy`));
    return;
  }
  const pretty = isPretty();
  const rollback = rollbackTargetEntry(entries, currentSha);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const isCurrent = entry.sha === currentSha && !entries.slice(index + 1).some((later) => later.sha === currentSha);
    const marker = isCurrent ? "current" : "";
    if (pretty) {
      const sha = isCurrent ? bold(entry.sha.slice(0, 12)) : entry.sha.slice(0, 12);
      const when = formatRelativeTime(entry.at);
      const badge = isCurrent ? ` ${yellow("← current")}` : "";
      console.log(`${sha}  ${dim(entry.artifactHash.slice(0, 12))}  ${dim(when)}  ${dim(entry.by)}${badge}`);
    } else {
      console.log(`${entry.sha}\t${entry.at}\t${entry.artifactHash}\t${entry.by}\t${marker}`);
    }
  }
  if (pretty && rollback) console.log(dim(`rollback target: ${rollback.sha.slice(0, 12)}`));
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
async function deployInit(): Promise<void> {
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
  const heading = (line: string) => console.log(pretty ? bold(line) : line);
  const detail = (line: string) => console.log(pretty ? dim(line) : line);

  heading("hive deploy --init — migrate the global `hive` onto ~/.hive/runtime/current");
  detail("");
  detail(`  runtime root:    ${tildify(root)} ${deployed ? "(current deployed)" : "(NOTHING DEPLOYED YET)"}`);
  detail(`  global package:  ${pkgDir} [${pkgState.kind === "symlink" ? `symlink → ${pkgState.target}` : pkgState.kind}]`);
  detail(`  global bin:      ${binPath} [${binState.kind === "symlink" ? `symlink → ${binState.target}` : binState.kind}]`);
  detail("");
  if (pkgState.kind === "symlink" && pkgState.target.startsWith(currentDir)) {
    console.log(note("already migrated: the global package resolves through runtime/current."));
    return;
  }
  console.log("This step is print-only (it never rewires the live tree itself). Run, in order:");
  console.log("");
  let step = 1;
  if (!deployed) {
    console.log(`  ${step++}. hive deploy`);
    console.log("     # install a first version under ~/.hive/runtime before switching resolution");
  }
  if (pkgState.kind === "directory" || pkgState.kind === "file") {
    console.log(`  ${step++}. mv "${pkgDir}" "${pkgDir}.pre-runtime"`);
    console.log("     # keep the old npm-installed tree as an escape hatch; delete it once the migration is verified");
  }
  console.log(`  ${step++}. ln -s "${currentDir}" "${pkgDir}.new" && mv -h "${pkgDir}.new" "${pkgDir}"`);
  console.log("     # atomic swap (BSD mv -h: replace the link itself, never follow it)");
  if (binState.kind === "missing" || binState.kind === "symlink") {
    console.log(`  ${step++}. ln -sfn "../lib/node_modules/honeybee/dist/cli.js" "${binPath}"`);
    console.log("     # npm-style relative bin shim; resolves through the package symlink, i.e. through runtime/current");
  }
  console.log(`  ${step++}. hive daemon install --force && hive daemon restart`);
  console.log("     # rebind the LaunchAgent plist to the runtime/current CLI path");
  console.log(`  ${step}. readlink "${pkgDir}" && hive deploy --list`);
  console.log("     # verify: the package resolves through runtime/current and history shows the active sha");
  console.log("");
  console.log(note("warning: any future `npm i -g honeybee` / `npm update -g` will clobber the symlink — redo the ln/mv step after such commands (or simply never run them again; `hive deploy` replaces them)."));
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
