import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readBuildIdentity } from "./release/buildIdentity.js";
import { recordedSocketPath, readLiveUpdateOwner } from "./v2/updateOwnerClient.mjs";
import { resolveNodePin } from "./nodeRuntime.js";
/**
 * Versioned runtime deploys (reset WP0 — docs/design/specs/reset-00-deploy.md).
 *
 * `hive deploy` installs an immutable build of a committed sha under
 * `<storeRoot>/runtime/<sha>/` and atomically retargets the `runtime/current`
 * symlink, so the daemon and the global CLI never execute out of a mutable
 * working tree (core contract invariant 8). The developer tree is only ever
 * READ (a `git archive` of a committed sha); building happens in a disposable
 * temp checkout, and every failure before the final renames leaves `current`
 * — and therefore the running system — untouched.
 *
 * This module is the pure orchestration layer: history, symlink retarget,
 * prune, rollback. The two effectful steps — building the artifact and
 * restarting the daemon — arrive as injected hooks so tests exercise the full
 * deploy state machine against a temp runtime root without ever compiling the
 * repo or touching a real daemon. The production hooks live in
 * src/commands/deploy.ts.
 */

import { execFile } from "node:child_process";
import { existsSync, type Dirent } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "./lock.js";
import { configuredV2Runtime, installedV2Identity, runtimeUsesV2, RUNTIME_MODE_CONFIG, V2_DEPLOY_MARKER } from "./cliRoute.js";
import { exposeDeployedCli } from "./deployCli.js";
import { unpackDeployArtifact, artifactTreeDigest, assertArtifactLinksContained } from "./deployArtifact.js";
import type { ComponentIdentity } from "./release/index.js";
import { canonicalDigest } from "./comb/canonical.js";
import { assertUpdateAdmission, assertUpdateRecoveryAdmission, UpdateAdmissionError, UPDATE_RECOVERY_CONTRACT, type UpdateAdmission } from "./updateAdmission.js";
import { hashDirectoryTree, readBuildStamp, verifyDistAgainstArtifact, writeBuildStamp } from "./deploySettle.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";
import { hostGitEnv } from "./hostGit.js";
import { assertRuntimeUpdateAllowed, readUpdateReservation, DeployReservationHeldError } from "./readUpdateReservation.js";
import { isApiarySwap } from "./apiarySwap.js";
import { parseUpdateReservation, type UpdateReservation } from "./updateReservation.js";

const execFileAsync = promisify(execFile);

export { DeployReservationHeldError } from "./readUpdateReservation.js";

export const RUNTIME_DIR_NAME = "runtime";
export const CURRENT_LINK_NAME = "current";
export const DEPLOY_HISTORY_FILENAME = "deploys.json";
export const DEFAULT_KEEP_VERSIONS = 5;

/** Full-length commit shas only: version dirs must be unambiguous forever. */
const DEPLOY_SHA_PATTERN = /^[0-9a-f]{40}$/;

/** `~/.hive/runtime` (HIVE_STORE_ROOT-aware, like every other store path). */
export function runtimeRoot(): string {
  return join(storeRoot(), RUNTIME_DIR_NAME);
}

export type DeployHistoryEntry = {
  sha: string;
  at: string;
  artifactHash: string;
  by: string;
  gate?: "full" | "tests-skipped";
  activation?: "held" | "unconfirmed";
};

export type BuildArtifactContext = {
  repoRoot: string;
  sha: string;
  /** Disposable temp dir for the clean checkout + build; removed afterwards. */
  workDir: string;
  log: (line: string) => void;
  /**
   * Skip the test gate (check + build still run).
   */
  skipTests?: boolean;
  /** Publication runs every release gate regardless of local deployment state. */
  release?: boolean;
  /** Explicit release target; omitted for native local deploy builds. */
  target?: string;
};

export type RestartDaemonContext = {
  /** Verified artifact installs explicitly activate v2, including fresh nodes. */
  runtime?: "v2";
  root: string;
  installedDir: string;
  sha: string;
  log: (line: string) => void;
  restorePrevious?: () => Promise<boolean>;
  assertRollbackSafe?: () => Promise<void>;
};

export class DeployActivationHeldError extends Error {
  readonly code = "DEPLOY_ACTIVATION_HELD";
  readonly serviceFilesRetained = true;
  constructor(readonly sha: string, detail: string, options?: ErrorOptions, readonly candidateReadiness: "ready" | "unavailable" | "unknown" = "unknown") {
    super(`deploy: DEPLOY_ACTIVATION_HELD: current candidate ${sha} retained; service configuration preserved; ${detail}`, options);
    this.name = "DeployActivationHeldError";
  }
}

export class DeployActivationRefusedError extends Error {
  readonly code = "DEPLOY_ACTIVATION_REFUSED";
  constructor(sha: string, cause: unknown) {
    super(`deploy: DEPLOY_ACTIVATION_REFUSED: ${sha} was not selected or started; ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "DeployActivationRefusedError";
  }
}

export type DeployHooks = {
  /**
   * Produce the installable artifact for `sha` inside `workDir` and return
   * the directory whose CONTENTS become `runtime/<sha>/`. The artifact must
   * be self-sufficient: dist/, contracts/, package.json and production
   * node_modules — nothing in it may resolve back into the repo tree.
   */
  backupStore?: (context: { root: string; installedDir: string; sourceRevision: string | null }) => Promise<{ receiptPath: string }>;
  buildArtifact: (context: BuildArtifactContext) => Promise<{ artifactDir: string }>;
  /** Separate final step so tests (and --no-restart futures) never touch a real daemon. */
  restartDaemon: (context: RestartDaemonContext) => Promise<void>;
};

const admittedRestarts = new WeakMap<RestartDaemonContext, Pick<RestartDaemonContext, "root" | "installedDir" | "sha" | "runtime"> & { reservation?: UpdateReservation }>();

export function hasDeployRestartAdmission(context: RestartDaemonContext): boolean {
  const admission = admittedRestarts.get(context);
  return admission !== undefined && admission.root === context.root && admission.installedDir === context.installedDir
    && admission.sha === context.sha && admission.runtime === context.runtime;
}

export async function assertDeployRestartAdmission(context: RestartDaemonContext): Promise<void> {
  if (!hasDeployRestartAdmission(context)) throw new Error("deploy: restart admission expired");
  const expected = admittedRestarts.get(context)!.reservation;
  const live = await readUpdateReservation(context.root);
  if (!hasDeployRestartAdmission(context)) throw new Error("deploy: restart admission expired");
  if (!live?.active) return;
  if (isApiarySwap(live)) throw new DeployReservationHeldError(live.id, live.epoch, "apiary-swap");
  const reservation = parseUpdateReservation(live);
  if (!expected || reservation.id !== expected.id || reservation.epoch !== expected.epoch
    || reservation.recoverySubjectDigest !== expected.recoverySubjectDigest) throw new DeployReservationHeldError(reservation.id, reservation.epoch);
}

async function restartWithAdmission(hooks: Pick<DeployHooks, "restartDaemon" | "backupStore">, context: RestartDaemonContext, reservation?: UpdateReservation): Promise<void> {
  const restore = context.restorePrevious;
  if (restore) context.restorePrevious = async () => {
    if (!hasDeployRestartAdmission(context)) throw new Error("deploy: restart admission expired");
    return restore();
  };
  const checkRollback = context.assertRollbackSafe;
  if (checkRollback) context.assertRollbackSafe = async () => {
    if (!hasDeployRestartAdmission(context)) throw new Error("deploy: restart admission expired");
    return checkRollback();
  };
  admittedRestarts.set(context, { root: context.root, installedDir: context.installedDir, sha: context.sha, runtime: context.runtime, reservation });
  try { await hooks.restartDaemon(context); } finally { admittedRestarts.delete(context); }
}

export type DeployOptions = {
  repoRoot: string;
  hooks: DeployHooks;
  /** Commit-ish to deploy; default HEAD. */
  ref?: string;
  /** Runtime root override (tests); default runtimeRoot(). */
  root?: string;
  /** History depth protected from pruning; default DEFAULT_KEEP_VERSIONS. */
  keep?: number;
  by?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Skip the ancestry guard. Deploys REFUSE when the target commit is not a
   * descendant of the currently deployed one — 2026-08-21: a deploy cut from
   * a stale checkout silently rolled back a landed fix for an hour. Explicit
   * downgrades go through `hive deploy --rollback`, or this flag when a
   * non-linear replacement is genuinely intended.
   */
  allowNonDescendant?: boolean;
  skipTests?: boolean;
};

export type DeployOutcome = {
  sha: string;
  artifactHash: string;
  installedDir: string;
  previousSha: string | null;
  pruned: string[];
  entry: DeployHistoryEntry;
};

export type RollbackOptions = {
  hooks: Pick<DeployHooks, "restartDaemon" | "backupStore">;
  root?: string;
  by?: string;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Skip the ancestry guard. Deploys REFUSE when the target commit is not a
   * descendant of the currently deployed one — 2026-08-21: a deploy cut from
   * a stale checkout silently rolled back a landed fix for an hour. Explicit
   * downgrades go through `hive deploy --rollback`, or this flag when a
   * non-linear replacement is genuinely intended.
   */
  allowNonDescendant?: boolean;
};

export type RollbackOutcome = {
  /** Sha `current` pointed at before the rollback. */
  from: string;
  sha: string;
  entry: DeployHistoryEntry;
};

function isHistoryEntry(value: unknown): value is DeployHistoryEntry {
  const entry = value as Partial<DeployHistoryEntry> | null;
  return (
    typeof entry?.sha === "string" && DEPLOY_SHA_PATTERN.test(entry.sha) &&
    typeof entry.at === "string" &&
    typeof entry.artifactHash === "string" &&
    typeof entry.by === "string" &&
    (entry.activation === undefined || entry.activation === "held" || entry.activation === "unconfirmed")
  );
}

/**
 * Append-only deploy log, oldest first; `current` always corresponds to the
 * last entry (rollbacks append too, so the log reads as "what `current`
 * pointed at over time"). Tolerant of a missing/foreign file — deploys.json
 * is bookkeeping, never the thing that decides whether a runtime is live.
 */
export async function readDeployHistory(root: string): Promise<DeployHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(root, DEPLOY_HISTORY_FILENAME), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed?.entries)) return [];
    return parsed.entries.filter(isHistoryEntry);
  } catch {
    return [];
  }
}

async function appendDeployHistory(root: string, entry: DeployHistoryEntry): Promise<void> {
  const entries = [...(await readDeployHistory(root)), entry];
  await atomicWriteFile(
    join(root, DEPLOY_HISTORY_FILENAME),
    `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`,
    { mode: 0o644 },
  );
}

/** Sha the `current` symlink names, or null when nothing is deployed yet. */
export async function currentDeployTarget(root: string): Promise<string | null> {
  let target: string;
  try {
    target = await readlink(join(root, CURRENT_LINK_NAME));
  } catch {
    return null;
  }
  if (DEPLOY_SHA_PATTERN.test(target)) return target;
  try {
    const identity = readBuildIdentity(join(root, CURRENT_LINK_NAME, "dist", "build-identity.json"));
    if (identity.component !== "honeybee" || !identity.sourceRevision) return null;
    return identity.sourceRevision;
  } catch { return null; }
}

export class DeployRollbackError extends Error {
  constructor(readonly code: "ROLLBACK_CURRENT_IDENTITY_MISSING" | "ROLLBACK_PREVIOUS_INSTALL_MISSING" | "ROLLBACK_SCHEMA_UNKNOWN" | "ROLLBACK_STORE_RESTORE_REQUIRED" | "ROLLBACK_PREVIOUS_INSTALL_CONFLICT", message: string, options?: ErrorOptions) {
    super(`deploy: ${code}: ${message}`, options);
    this.name = "DeployRollbackError";
  }
}

export async function assertRollbackStoreCompatible(root: string, installedDir: string): Promise<void> {
  const dataDir = join(root, "..", "v2"), store = join(dataDir, "core.sqlite3");
  if (!existsSync(store)) return;
  const bundle = await readFile(join(installedDir, "dist", "v2", "cli.js"), "utf8").catch(() => "");
  const versions = [...bundle.matchAll(/^(?:var|let|const) SCHEMA_VERSION\d* = (\d+);$/gm)].map(match => Number(match[1]));
  if (versions.length !== 1 || !Number.isSafeInteger(versions[0])) {
    throw new DeployRollbackError("ROLLBACK_SCHEMA_UNKNOWN", `missing unambiguous store schema capability in ${installedDir}/dist/v2/cli.js; verify the matching runtime and store backup before rollback`);
  }
  let stored: number;
  try {
    const socket = recordedSocketPath(dataDir);
    const response = existsSync(socket) ? await readLiveUpdateOwner(socket, dataDir) : { kind: "offline" as const };
    if (response.kind === "live") stored = Number((response.owner as { schemaVersion?: unknown }).schemaVersion);
    else {
      const db = new DatabaseSync(store, { readOnly: true });
      try { stored = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value); }
      finally { db.close(); }
    }
  } catch (error) {
    throw new DeployRollbackError("ROLLBACK_SCHEMA_UNKNOWN", `cannot read store schema at ${store}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isSafeInteger(stored) || stored < 1) throw new DeployRollbackError("ROLLBACK_SCHEMA_UNKNOWN", `missing valid schema_version in ${store}`);
  if (stored > versions[0]! || stored === 29) {
    throw new DeployRollbackError("ROLLBACK_STORE_RESTORE_REQUIRED", `store schema ${stored} cannot be opened by rollback build schema ${versions[0]}; restore the matching pre-deploy backup with hive v2 store restore --from <absolute receipt.json> --data-dir ${dataDir} before retrying rollback; if no compatible backup exists, select a compatible runtime instead (restore discards writes after that backup)`);
  }
}

/**
 * The entry `--rollback` would retarget to right now: the most recent history
 * entry naming a different sha than `current`. `requireInstalled` additionally
 * demands the version dir still exists (the actual rollback needs bytes;
 * prune protection must shield the target even if something deleted it).
 */
export function rollbackTargetEntry(
  entries: DeployHistoryEntry[],
  currentSha: string | null,
  options: { root?: string; requireInstalled?: boolean } = {},
): DeployHistoryEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]!;
    if (candidate.sha === currentSha) continue;
    if (options.requireInstalled && options.root !== undefined &&
      !existsSync(join(options.root, candidate.sha, "dist", "cli.js"))) continue;
    return candidate;
  }
  return null;
}

/**
 * Atomic retarget: publish a fresh symlink under a temp name, then rename it
 * over `current`. Readers observe either the old target or the new one —
 * never a missing or half-written link. The target is relative (just the
 * sha), so a moved store root stays coherent.
 */
async function retargetCurrent(root: string, sha: string): Promise<void> {
  const temp = join(root, `.${CURRENT_LINK_NAME}.${process.pid}.${Date.now()}.tmp`);
  await rm(temp, { force: true });
  await symlink(sha, temp);
  try {
    await rename(temp, join(root, CURRENT_LINK_NAME));
    await syncDeployPath(root);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function syncDeployPath(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}

/** Sync downloaded bytes before publication; validated links are persisted by
 * syncing their containing directories rather than following them. */
async function syncDeployTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await syncDeployTree(path);
    else if (entry.isFile()) await syncDeployPath(path);
  }
  await syncDeployPath(directory);
}

/** Refuse anything uncommitted — deployed bytes must equal committed bytes. */
async function verifyCleanWorkingTree(repoRoot: string): Promise<void> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"],
  );
  const dirt = stdout.trim();
  if (dirt.length > 0) {
    throw new Error(`deploy: working tree is dirty; commit (or stash) everything first\n${dirt}`);
  }
}

async function resolveCommit(repoRoot: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`],
    );
    const sha = stdout.trim();
    if (!DEPLOY_SHA_PATTERN.test(sha)) throw new Error(`unexpected rev-parse output: ${sha}`);
    return sha;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`deploy: cannot resolve '${ref}' to a commit in ${repoRoot}\n${detail}`);
  }
}

function deployedBy(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? "unknown";
  }
}

/**
 * The deploy sequence, in refuse-early order. Everything before the publish
 * renames happens in temp space; a failure at any point leaves `current`,
 * the history, and every installed version exactly as they were.
 */
/**
 * The ancestry guard: refuse to deploy a commit that does not contain the
 * currently running one. Two crews deploying from different checkouts is the
 * live failure mode — the second deploy silently reverts the first crew's
 * landed work (observed 2026-08-21: the watcher-flush fix rolled back for an
 * hour by a stale-checkout deploy). A current sha the checkout does not even
 * know is the same failure with worse visibility, so it refuses too.
 */
async function verifyDescendantOfCurrent(
  repoRoot: string,
  root: string,
  sha: string,
  allowNonDescendant: boolean,
): Promise<void> {
  if (allowNonDescendant) return;
  const currentSha = await currentDeployTarget(root);
  if (currentSha === null || currentSha === sha) return;
  try {
    await execFileAsync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", currentSha, sha], { env: hostGitEnv() });
  } catch {
    throw new Error(
      `deploy: ${sha.slice(0, 12)} does not contain the currently deployed ${currentSha.slice(0, 12)} — ` +
        `deploying it would silently revert landed work. Fetch/rebase this checkout onto the deployed ` +
        `commit first; use \`hive deploy --rollback\` for an intentional downgrade, or ` +
        `--allow-non-descendant to override deliberately.`,
    );
  }
}

export async function deployVersion(options: DeployOptions): Promise<DeployOutcome> {
  await verifyCleanWorkingTree(options.repoRoot);
  const root = options.root ?? runtimeRoot();
  await mkdir(root, { recursive: true });
  return withFileLock(join(root, ".deploy.lock"), () => deployVersionLocked(options));
}

async function deployVersionLocked(options: DeployOptions): Promise<DeployOutcome> {
  const root = options.root ?? runtimeRoot();
  await assertRuntimeUpdateAllowed(root, "deploy");
  const keep = Math.max(1, Math.floor(options.keep ?? DEFAULT_KEEP_VERSIONS));
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const by = options.by ?? deployedBy();

  await verifyCleanWorkingTree(options.repoRoot);
  await reconcileCurrentDeployHistory(root, now, by);
  const sha = await resolveCommit(options.repoRoot, options.ref ?? "HEAD");
  await verifyDescendantOfCurrent(options.repoRoot, root, sha, options.allowNonDescendant === true);
  log(`deploy: building ${sha.slice(0, 12)} in a clean temp checkout`);

  const workDir = await mkdtemp(join(tmpdir(), "hive-deploy-"));
  try {
    const { artifactDir } = await options.hooks.buildArtifact({
      repoRoot: options.repoRoot,
      sha,
      workDir,
      log,
      skipTests: options.skipTests,
    });
    if (!existsSync(join(artifactDir, "dist", "cli.js"))) {
      throw new Error(`deploy: built artifact has no dist/cli.js under ${artifactDir}`);
    }
    // Stamp before staging so the recorded hash names exactly the dist bytes
    // that get installed (deploySettle's tree digest, stamp excluded).
    const stamp = await writeBuildStamp(join(artifactDir, "dist"));

    return await publishDeploy({ root, sha, artifactDir, artifactHash: stamp.hash, keep, by, now, log, hooks: options.hooks, gate: options.skipTests ? "tests-skipped" : "full" });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}


/** Called only under the deploy lock after admission. Sync the config before a
 * current switch so a crash cannot lose v2 selection when provenance changes. */
async function persistV2RuntimeMode(root: string): Promise<void> {
  if (!configuredV2Runtime(root)) {
    const temporary = join(root, `.runtime-mode.${process.pid}.${Date.now()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify({ schemaVersion: 1, runtime: "v2" })}\n`);
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, join(root, RUNTIME_MODE_CONFIG));
    } finally { await rm(temporary, { force: true }); }
  } else {
    const file = await open(join(root, RUNTIME_MODE_CONFIG), "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  for (const directory of [root, dirname(root)]) {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

async function retainExternalCurrent(root: string, link: string, sha: string, now: () => Date, by: string): Promise<string> {
  const source = resolve(root, link), installed = join(root, sha);
  const identity = readBuildIdentity(join(source, "dist", "build-identity.json"));
  if (identity.component !== "honeybee" || identity.sourceRevision !== sha) throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", `external current ${source} changed build identity while preserving rollback bytes`);
  if (identity.target !== `${process.platform}-${process.arch}`) throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", `external current ${source} has build target ${identity.target}; a native ${process.platform}-${process.arch} rollback build must be reconciled before deploying`);
  await assertArtifactLinksContained(source);
  const digest = await artifactTreeDigest(source);
  if (existsSync(installed)) {
    if (await artifactTreeDigest(installed) !== digest) throw new DeployRollbackError("ROLLBACK_PREVIOUS_INSTALL_CONFLICT", `installed ${sha} differs from external current ${source}; preserve and reconcile both builds before deploying`);
  } else {
    const temporary = join(root, `.previous.${sha}.${randomUUID()}`);
    try {
      await cp(source, temporary, { recursive: true, verbatimSymlinks: true });
      await assertArtifactLinksContained(temporary);
      if (await artifactTreeDigest(temporary) !== digest || await artifactTreeDigest(source) !== digest) throw new DeployRollbackError("ROLLBACK_PREVIOUS_INSTALL_CONFLICT", `external current ${source} changed while preserving its rollback bytes`);
      await syncDeployTree(temporary);
      await rename(temporary, installed);
      await syncDeployPath(root);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const history = await readDeployHistory(root), artifactHash = await hashDirectoryTree(join(installed, "dist"));
  if (history.at(-1)?.sha !== sha || history.at(-1)?.artifactHash !== artifactHash) await appendDeployHistory(root, {
    sha, at: now().toISOString(), by: `${by} (adopted external current)`, artifactHash });
  return digest;
}

async function reconcileCurrentDeployHistory(root: string, now: () => Date, by: string): Promise<void> {
  const sha = await readlink(join(root, CURRENT_LINK_NAME)).catch(() => null);
  if (!sha || !DEPLOY_SHA_PATTERN.test(sha) || (await readDeployHistory(root)).at(-1)?.sha === sha) return;
  let identity;
  try { identity = readBuildIdentity(join(root, sha, "dist", "build-identity.json")); }
  catch (cause) { throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", "current runtime lacks a verified build identity", { cause }); }
  if (identity.component !== "honeybee" || identity.sourceRevision !== sha || identity.dirty !== false || identity.target !== `${process.platform}-${process.arch}`) {
    throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", "current runtime build identity differs from its native committed installation");
  }
  await appendDeployHistory(root, { sha, at: now().toISOString(), artifactHash: await hashDirectoryTree(join(root, sha, "dist")),
    by: `${by} (adopted current; activation unconfirmed)`, activation: "unconfirmed" });
}

async function backupBeforeRuntimeSwap(root: string, hooks: Pick<DeployHooks, "backupStore">, installedDir: string, previousSha: string | null, log: (line: string) => void): Promise<string | null> {
  const dataDir = resolve(root, "..", "v2");
  if (process.env.HIVE_V2_DATA_DIR?.trim() && resolve(process.env.HIVE_V2_DATA_DIR) !== dataDir) throw new Error("deploy: custom HIVE_V2_DATA_DIR requires an explicit coordinated store backup owner; refusing swap");
  const storePath = join(dataDir, "core.sqlite3");
  const configPath = join(dataDir, "config.json");
  if (existsSync(configPath)) {
    const config: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)
      || ("storePath" in config && config.storePath !== storePath)
      || ("socketPath" in config && config.socketPath !== join(dataDir, "hived.sock"))) throw new Error("deploy: custom store/socket configuration requires a coordinated backup owner; refusing swap");
  }
  if (!existsSync(storePath)) {
    const directory = join(root, ".store-absence");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const receiptPath = join(directory, `${Date.now()}-${process.pid}.json`);
    const file = await open(`${receiptPath}.partial`, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify({ format: 1, kind: "store_absent", storePath, sourceBuild: previousSha, createdAt: new Date().toISOString() }));
      await file.sync();
    } finally { await file.close(); }
    await rename(`${receiptPath}.partial`, receiptPath);
    await syncDeployPath(directory);
    await syncDeployPath(root);
    for (const name of (await readdir(directory)).filter(name => name.endsWith(".json")).sort().reverse().slice(10)) await rm(join(directory, name));
    await syncDeployPath(directory);
    log(`deploy: no prior store; absence receipt ${receiptPath}`);
    return null;
  }
  if (!hooks.backupStore) throw new UpdateAdmissionError("backup_missing", "store backup owner is required before swap");
  const receipt = await hooks.backupStore({ root, installedDir, sourceRevision: previousSha });
  if (!receipt.receiptPath || !existsSync(receipt.receiptPath)) throw new UpdateAdmissionError("backup_missing", "durable store backup receipt missing");
  const manifest = JSON.parse(await readFile(receipt.receiptPath, "utf8"));
  if (manifest.format !== 1 || manifest.integrityCheck !== "ok" || manifest.storePath !== storePath
    || manifest.receiptPath !== resolve(receipt.receiptPath) || typeof manifest.backupPath !== "string"
    || dirname(manifest.backupPath) !== dirname(resolve(receipt.receiptPath))
    || manifest.sha256 !== createHash("sha256").update(await readFile(manifest.backupPath)).digest("hex")) throw new UpdateAdmissionError("backup_invalid", "invalid store backup receipt");
  log(`deploy: store backup receipt ${receipt.receiptPath}`);
  return receipt.receiptPath;
}

async function publishDeploy({ root, sha, artifactDir, artifactHash, keep, by, now, log, hooks, immutable = false, gate, reservation, admit }: {
  root: string; sha: string; artifactDir: string; artifactHash: string; keep: number; by: string;
  now: () => Date; log: (line: string) => void; hooks: Pick<DeployHooks, "restartDaemon" | "backupStore">; immutable?: boolean; gate?: "full" | "tests-skipped"; reservation?: UpdateReservation; admit?: (receiptPath: string | null, startedAt: number) => Promise<void>;
}): Promise<DeployOutcome> {
  const previousLink = await readlink(join(root, CURRENT_LINK_NAME)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
  const previousSha = await currentDeployTarget(root);
  if (previousLink && !previousSha) throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", `runtime/current points to ${previousLink}, which has no valid Honeybee build identity`);
  const retainedDigest = previousLink && previousSha && previousLink !== previousSha
    ? await retainExternalCurrent(root, previousLink, previousSha, now, by) : null;
  const v2 = runtimeUsesV2(root) || immutable;
  let staging: string | null = null;
  try {
    // Stage on the runtime filesystem so publishing is a same-device rename.
    await mkdir(root, { recursive: true });
    staging = join(root, `.staging.${sha}.${process.pid}.${Date.now()}`);
    await cp(artifactDir, staging, { recursive: true, verbatimSymlinks: true });
    if (immutable) await syncDeployTree(staging);

    const backupStartedAt = Date.now();
    const backupReceiptPath = await backupBeforeRuntimeSwap(root, hooks, staging, previousSha, log);
    await admit?.(backupReceiptPath, backupStartedAt);
    if (previousLink) {
      try { await assertRollbackStoreCompatible(root, resolve(root, previousLink)); }
      catch (cause) { throw new DeployActivationRefusedError(sha, cause); }
    }

    // Publish runtime/<sha>. A redeploy of an existing sha swaps the old dir
    // aside first; the rename pair keeps a complete install in place at every
    // instant `current` could be pointing at it.
    const versionDir = join(root, sha);
    let displaced: string | null = null;
    if (immutable && existsSync(versionDir)) {
      // Full-tree comparison includes dependencies, contracts and executable metadata.
      if (await artifactTreeDigest(versionDir) !== await artifactTreeDigest(artifactDir)) throw new Error("deploy: immutable version conflict");
      await rm(staging, { recursive: true });
      staging = null;
    }
    if (v2) await persistV2RuntimeMode(root);
    if (staging && existsSync(versionDir)) {
      displaced = join(root, `.displaced.${sha}.${process.pid}.${Date.now()}`);
      await rename(versionDir, displaced);
    }
    try {
      if (staging) await rename(staging, versionDir);
      if (immutable) await syncDeployPath(root);
    } catch (error) {
      if (displaced) await rename(displaced, versionDir).catch(() => undefined);
      throw error;
    }
    staging = null;
    if (await readlink(join(root, CURRENT_LINK_NAME)).catch(() => null) !== previousLink) throw new Error("deploy: current runtime changed while staging");
    if (retainedDigest && await artifactTreeDigest(resolve(root, previousLink!)) !== retainedDigest) throw new Error("deploy: external current bytes changed while staging");
    await retargetCurrent(root, sha);
    const last = immutable && previousSha === sha ? (await readDeployHistory(root)).at(-1) : undefined;
    const entry: DeployHistoryEntry = last?.sha === sha && last.artifactHash === artifactHash
      ? last : { sha, at: now().toISOString(), artifactHash, by, ...(gate ? { gate } : {}) };
    let restored = false;
    const restorePrevious = async (): Promise<boolean> => {
      if (!previousLink) return false;
      if (restored) return true;
      await assertRollbackStoreCompatible(root, displaced && previousSha === sha ? displaced : resolve(root, previousLink));
      if (displaced && previousSha === sha) {
        await rm(versionDir, { recursive: true, force: true });
        await rename(displaced, versionDir);
        displaced = null;
      }
      await retargetCurrent(root, previousLink);
      restored = true;
      log(`deploy: restored previous runtime ${previousSha}`);
      return true;
    };
    const assertRollbackSafe = async () => {
      if (previousLink) await assertRollbackStoreCompatible(root, displaced && previousSha === sha ? displaced : resolve(root, previousLink));
    };
    let activated = false;
    try {
      await restartWithAdmission(hooks, { root, installedDir: versionDir, sha, log, ...(previousLink ? { restorePrevious, assertRollbackSafe } : {}), ...(v2 ? { runtime: "v2" as const } : {}) }, reservation);
      if (restored) throw new Error("deploy: activation rolled back");
      activated = true;
    } catch (error) {
      if (error instanceof DeployActivationHeldError) {
        if (await currentDeployTarget(root) === sha) await appendDeployHistory(root, { ...entry, activation: "held" });
        throw error;
      }
      try { await restorePrevious(); }
      catch (recoveryError) { if (recoveryError instanceof Error) recoveryError.cause ??= error; throw recoveryError; }
      throw error;
    } finally {
      if (displaced) {
        if (activated || previousSha !== sha || restored) await rm(displaced, { recursive: true, force: true }).catch(() => undefined);
        else log(`deploy: previous runtime bytes retained for recovery at ${displaced}`);
      }
    }
    if (entry !== last) await appendDeployHistory(root, entry);
    const pruned = immutable ? [] : await pruneRuntimeVersionsLocked(root, { keep });
    for (const removed of pruned) log(`deploy: pruned old version ${removed.slice(0, 12)}`);
    return { sha, artifactHash: artifactHash, installedDir: versionDir, previousSha, pruned, entry };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

export type DeployArtifactOptions = {
  archive: string;
  identity: ComponentIdentity;
  /** Compare-and-swap fence supplied by the coordinated update owner. */
  expectedCurrent: string | null;
  admission: UpdateAdmission | { fresh: true };
  /** Optional owner-managed CLI exposure after successful activation. */
  cliBinDirectory?: string;
  root?: string;
  hooks: Pick<DeployHooks, "restartDaemon" | "backupStore">;
};

export async function deployArtifact(options: DeployArtifactOptions): Promise<DeployOutcome> {
  const root = options.root ?? runtimeRoot();
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, ".artifact-"));
  try {
    return await withFileLock(join(root, ".deploy.lock"), async () => {
      await assertRuntimeUpdateAllowed(root, "artifact");
      const prepared = await unpackDeployArtifact(options.archive, options.identity, workDir);
      if (prepared.recoveryContract !== UPDATE_RECOVERY_CONTRACT) throw new Error("deploy: artifact lacks the recovery admission contract; coordinated migration required");
      // The archive cannot supply its own admission receipt or redirect this write.
      const marker = join(prepared.artifactDir, V2_DEPLOY_MARKER);
      await rm(marker, { force: true });
      await writeFile(marker, JSON.stringify({ schemaVersion: 1, runtime: "v2", recoveryContract: prepared.recoveryContract, identity: prepared.identity }), { flag: "wx" });
      const currentPath = join(root, CURRENT_LINK_NAME);
      const current = await lstat(currentPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current && !current.isSymbolicLink()) throw new Error("deploy: current runtime changed");
      const currentSha = current ? await currentDeployTarget(root) : null;
      if (current && !currentSha) throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", "missing valid build identity at runtime/current");
      if (current && await readlink(currentPath) !== currentSha) {
        await assertArtifactLinksContained(currentPath);
        const external = readBuildIdentity(join(currentPath, "dist", "build-identity.json"));
        const stamp = await readBuildStamp(join(currentPath, "dist"));
        if (external.target !== `${process.platform}-${process.arch}` || !stamp) throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", "external current lacks a native build target or verified dist build stamp; reconcile the Apiary installation before artifact admission");
        await verifyDistAgainstArtifact(join(currentPath, "dist"), stamp.hash);
      }
      const installed = installedV2Identity(root);
      // Resume after an atomic switch followed by a lost restart response. This
      // exception is only for the identical owner-verified complete artifact.
      const replay = currentSha === prepared.identity.sourceRevision
        && installed !== null && canonicalDigest(installed) === canonicalDigest(prepared.identity)
        && await artifactTreeDigest(join(root, currentSha)) === await artifactTreeDigest(prepared.artifactDir);
      if (currentSha !== options.expectedCurrent && !replay) throw new Error("deploy: current runtime changed");
      const reservation = "fresh" in options.admission ? undefined : parseUpdateReservation(options.admission.reservation);
      if ("fresh" in options.admission) {
        if (options.admission.fresh !== true || Object.keys(options.admission).length !== 1 || options.expectedCurrent !== null
          || (!replay && ["v2", "store.json", "bees", "sessions", "legacy-agentpit", "FROZEN"].some(name => existsSync(join(root, "..", name)))))
          throw new Error("deploy: fresh installation requires an empty node; coordinated migration required");
      } else await assertUpdateRecoveryAdmission(root, prepared.identity, { ...options.admission, reservation: reservation! }, prepared.candidateSchemaVersion);
      const admission = options.admission;
      const outcome = await publishDeploy({ root, sha: prepared.identity.sourceRevision, ...prepared,
        keep: DEFAULT_KEEP_VERSIONS, by: deployedBy(), now: () => new Date(), log: () => undefined,
        hooks: options.hooks, immutable: true, reservation,
        ...("fresh" in admission ? {} : { admit: (receiptPath: string | null, startedAt: number) => assertUpdateAdmission(root, prepared.identity,
          { ...admission, reservation: reservation! }, { receiptPath: receiptPath ?? "", startedAt, candidateSchemaVersion: prepared.candidateSchemaVersion }) }) });
      if (options.cliBinDirectory !== undefined) await exposeDeployedCli(root, options.cliBinDirectory, resolveNodePin(join(root, "..", "v2")).path);
      return outcome;
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Retarget `current` to the previous history entry (most recent distinct sha
 * whose install still exists) and record the move. No pruning here — a
 * rollback must never delete anything.
 */
export async function rollbackDeploy(options: RollbackOptions): Promise<RollbackOutcome> {
  const root = options.root ?? runtimeRoot();
  await mkdir(root, { recursive: true });
  return withFileLock(join(root, ".deploy.lock"), () => rollbackDeployLocked(options));
}

async function rollbackDeployLocked(options: RollbackOptions): Promise<RollbackOutcome> {
  const root = options.root ?? runtimeRoot();
  await assertRuntimeUpdateAllowed(root, "rollback");
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const by = options.by ?? deployedBy();

  await reconcileCurrentDeployHistory(root, now, by);
  const currentSha = await currentDeployTarget(root);
  const currentLink = await readlink(join(root, CURRENT_LINK_NAME)).catch(() => null);
  if (!currentSha) {
    if (currentLink) throw new DeployRollbackError("ROLLBACK_CURRENT_IDENTITY_MISSING", `runtime/current points to ${currentLink}; missing valid dist/build-identity.json with sourceRevision`);
    throw new Error("deploy: nothing deployed yet (no runtime/current)");
  }
  const entries = await readDeployHistory(root);
  const target = rollbackTargetEntry(entries, currentSha, { root, requireInstalled: true });
  if (!target) throw new DeployRollbackError("ROLLBACK_PREVIOUS_INSTALL_MISSING", `no previous installed version to roll back to; deploy history ${join(root, DEPLOY_HISTORY_FILENAME)} must name a distinct build with installed dist/cli.js`);
  log(`deploy: rollback planned ${currentSha} → ${target.sha}`);
  if (target.activation) log(`deploy: rollback target activation unconfirmed (${target.activation})`);
  await assertRollbackStoreCompatible(root, join(root, target.sha));
  if (currentLink && currentLink !== currentSha) await retainExternalCurrent(root, currentLink, currentSha, now, by);

  await backupBeforeRuntimeSwap(root, options.hooks, join(root, currentSha), currentSha, log);
  const v2 = runtimeUsesV2(root);
  if (v2) await persistV2RuntimeMode(root);
  await retargetCurrent(root, target.sha);
  const entry: DeployHistoryEntry = {
    sha: target.sha,
    at: now().toISOString(),
    artifactHash: target.artifactHash,
    by,
  };
  log(`deploy: rolled back ${currentSha.slice(0, 12)} → ${target.sha.slice(0, 12)}`);
  try {
    await restartWithAdmission(options.hooks, { root, installedDir: join(root, target.sha), sha: target.sha, log,
      restorePrevious: async () => { await assertRollbackStoreCompatible(root, resolve(root, currentLink!)); await retargetCurrent(root, currentLink!); return true; },
      assertRollbackSafe: async () => { await assertRollbackStoreCompatible(root, resolve(root, currentLink!)); },
      ...(v2 ? { runtime: "v2" as const } : {}) });
  } catch (error) {
    if (error instanceof DeployActivationHeldError) {
      if (await currentDeployTarget(root) === target.sha) await appendDeployHistory(root, { ...entry, activation: "held" });
      throw error;
    }
    try {
      await assertRollbackStoreCompatible(root, resolve(root, currentLink!));
      await retargetCurrent(root, currentLink!);
    } catch (recoveryError) { if (recoveryError instanceof Error) recoveryError.cause ??= error; throw recoveryError; }
    throw error;
  }
  await appendDeployHistory(root, entry);
  return { from: currentSha, sha: target.sha, entry };
}

/**
 * Remove installed versions beyond the protected set: `current`, its rollback
 * target, and the last `keep` distinct shas in history. Only exact 40-hex
 * dirs are candidates — `current`, deploys.json, and staging temp names are
 * structurally exempt. Returns the removed shas (sorted).
 */
export async function pruneRuntimeVersions(
  root: string,
  options: { keep?: number } = {},
): Promise<string[]> {
  return withFileLock(join(root, ".deploy.lock"), async () => {
    await assertRuntimeUpdateAllowed(root, "prune");
    return pruneRuntimeVersionsLocked(root, options);
  });
}

async function pruneRuntimeVersionsLocked(root: string, options: { keep?: number }): Promise<string[]> {
  const keep = Math.max(1, Math.floor(options.keep ?? DEFAULT_KEEP_VERSIONS));
  const entries = await readDeployHistory(root);
  const currentSha = await currentDeployTarget(root);

  const protectedShas = new Set<string>();
  if (currentSha) protectedShas.add(currentSha);
  const rollback = rollbackTargetEntry(entries, currentSha);
  if (rollback) protectedShas.add(rollback.sha);
  const lastDistinct: string[] = [];
  for (let index = entries.length - 1; index >= 0 && lastDistinct.length < keep; index -= 1) {
    const sha = entries[index]!.sha;
    if (!lastDistinct.includes(sha)) lastDistinct.push(sha);
  }
  for (const sha of lastDistinct) protectedShas.add(sha);

  let dirents: Dirent[];
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (!DEPLOY_SHA_PATTERN.test(dirent.name)) continue;
    if (protectedShas.has(dirent.name)) continue;
    await rm(join(root, dirent.name), { recursive: true, force: true });
    removed.push(dirent.name);
  }
  return removed.sort();
}
