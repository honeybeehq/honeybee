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
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "./lock.js";
import { configuredV2Runtime, installedV2Identity, runtimeUsesV2, RUNTIME_MODE_CONFIG, V2_DEPLOY_MARKER } from "./cliRoute.js";
import { exposeDeployedCli } from "./deployCli.js";
import { unpackDeployArtifact, artifactTreeDigest } from "./deployArtifact.js";
import type { ComponentIdentity } from "./release/index.js";
import { canonicalDigest } from "./comb/canonical.js";
import { assertUpdateAdmission, assertNoUpdateReservation, UPDATE_RECOVERY_CONTRACT, type UpdateAdmission } from "./updateAdmission.js";
import { writeBuildStamp } from "./deploySettle.js";
import { atomicWriteFile, storeRoot } from "./fsx.js";

const execFileAsync = promisify(execFile);

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
};

export type BuildArtifactContext = {
  repoRoot: string;
  sha: string;
  /** Disposable temp dir for the clean checkout + build; removed afterwards. */
  workDir: string;
  log: (line: string) => void;
  /**
   * Skip the test gate (check + build still run). Never set by `hive deploy`;
   * only scripts/build-runtime-artifact.mjs --skip-tests for local iteration,
   * and such an artifact is marked `gate: "tests-skipped"` in its manifest.
   */
  skipTests?: boolean;
  /** Publication runs every release gate regardless of local deployment state. */
  release?: boolean;
};

export type RestartDaemonContext = {
  /** Verified artifact installs explicitly activate v2, including fresh nodes. */
  runtime?: "v2";
  root: string;
  installedDir: string;
  sha: string;
  log: (line: string) => void;
};

export type DeployHooks = {
  /**
   * Produce the installable artifact for `sha` inside `workDir` and return
   * the directory whose CONTENTS become `runtime/<sha>/`. The artifact must
   * be self-sufficient: dist/, contracts/, package.json and production
   * node_modules — nothing in it may resolve back into the repo tree.
   */
  buildArtifact: (context: BuildArtifactContext) => Promise<{ artifactDir: string }>;
  /** Separate final step so tests (and --no-restart futures) never touch a real daemon. */
  restartDaemon: (context: RestartDaemonContext) => Promise<void>;
};

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
  hooks: Pick<DeployHooks, "restartDaemon">;
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
    typeof entry.by === "string"
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
  const sha = basename(target);
  return DEPLOY_SHA_PATTERN.test(sha) ? sha : null;
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
    ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
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
    await execFileAsync("git", ["-C", repoRoot, "merge-base", "--is-ancestor", currentSha, sha]);
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
  await assertNoUpdateReservation(root);
  const keep = Math.max(1, Math.floor(options.keep ?? DEFAULT_KEEP_VERSIONS));
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const by = options.by ?? deployedBy();

  await verifyCleanWorkingTree(options.repoRoot);
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
    });
    if (!existsSync(join(artifactDir, "dist", "cli.js"))) {
      throw new Error(`deploy: built artifact has no dist/cli.js under ${artifactDir}`);
    }
    // Stamp before staging so the recorded hash names exactly the dist bytes
    // that get installed (deploySettle's tree digest, stamp excluded).
    const stamp = await writeBuildStamp(join(artifactDir, "dist"));

    return await publishDeploy({ root, sha, artifactDir, artifactHash: stamp.hash, keep, by, now, log, hooks: options.hooks });
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

async function publishDeploy({ root, sha, artifactDir, artifactHash, keep, by, now, log, hooks, immutable = false }: {
  root: string; sha: string; artifactDir: string; artifactHash: string; keep: number; by: string;
  now: () => Date; log: (line: string) => void; hooks: Pick<DeployHooks, "restartDaemon">; immutable?: boolean;
}): Promise<DeployOutcome> {
  const v2 = runtimeUsesV2(root) || immutable;
  let staging: string | null = null;
  try {
    // Stage on the runtime filesystem so publishing is a same-device rename.
    await mkdir(root, { recursive: true });
    staging = join(root, `.staging.${sha}.${process.pid}.${Date.now()}`);
    await cp(artifactDir, staging, { recursive: true, verbatimSymlinks: true });
    if (immutable) await syncDeployTree(staging);

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
    if (displaced) await rm(displaced, { recursive: true, force: true }).catch(() => undefined);

    const previousSha = await currentDeployTarget(root);
    await retargetCurrent(root, sha);
    const last = immutable && previousSha === sha ? (await readDeployHistory(root)).at(-1) : undefined;
    const entry: DeployHistoryEntry = last?.sha === sha && last.artifactHash === artifactHash
      ? last : { sha, at: now().toISOString(), artifactHash, by };
    if (entry !== last) await appendDeployHistory(root, entry);
    // Keep every recovery candidate while the coordinated reservation is held.
    const pruned = immutable ? [] : await pruneRuntimeVersionsLocked(root, { keep });
    for (const removed of pruned) log(`deploy: pruned old version ${removed.slice(0, 12)}`);

    // Deliberately last and separate: the install is fully recorded before
    // anything restarts, and a restart failure never un-publishes a deploy.
    await hooks.restartDaemon({ root, installedDir: versionDir, sha, log, ...(v2 ? { runtime: "v2" as const } : {}) });
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
  hooks: Pick<DeployHooks, "restartDaemon">;
};

export async function deployArtifact(options: DeployArtifactOptions): Promise<DeployOutcome> {
  const root = options.root ?? runtimeRoot();
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(join(root, ".artifact-"));
  try {
    return await withFileLock(join(root, ".deploy.lock"), async () => {
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
      const currentSha = current ? await readlink(currentPath) : null;
      const installed = installedV2Identity(root);
      // Resume after an atomic switch followed by a lost restart response. This
      // exception is only for the identical owner-verified complete artifact.
      const replay = currentSha === prepared.identity.sourceRevision
        && installed !== null && canonicalDigest(installed) === canonicalDigest(prepared.identity)
        && await artifactTreeDigest(join(root, currentSha)) === await artifactTreeDigest(prepared.artifactDir);
      if (currentSha !== options.expectedCurrent && !replay) throw new Error("deploy: current runtime changed");
      if ("fresh" in options.admission) {
        if (options.admission.fresh !== true || Object.keys(options.admission).length !== 1 || options.expectedCurrent !== null
          || (!replay && ["v2", "store.json", "bees", "sessions", "legacy-agentpit", "FROZEN"].some(name => existsSync(join(root, "..", name)))))
          throw new Error("deploy: fresh installation requires an empty node; coordinated migration required");
        if (replay) await assertNoUpdateReservation(root);
      } else await assertUpdateAdmission(root, prepared.identity, options.admission);
      const outcome = await publishDeploy({ root, sha: prepared.identity.sourceRevision, ...prepared,
        keep: DEFAULT_KEEP_VERSIONS, by: deployedBy(), now: () => new Date(), log: () => undefined,
        hooks: options.hooks, immutable: true });
      if (options.cliBinDirectory !== undefined) await exposeDeployedCli(root, options.cliBinDirectory, process.execPath);
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
  await assertNoUpdateReservation(root);
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const by = options.by ?? deployedBy();

  const currentSha = await currentDeployTarget(root);
  if (!currentSha) throw new Error("deploy: nothing deployed yet (no runtime/current)");
  const entries = await readDeployHistory(root);
  const target = rollbackTargetEntry(entries, currentSha, { root, requireInstalled: true });
  if (!target) throw new Error("deploy: no previous installed version to roll back to");

  const v2 = runtimeUsesV2(root);
  if (v2) await persistV2RuntimeMode(root);
  await retargetCurrent(root, target.sha);
  const entry: DeployHistoryEntry = {
    sha: target.sha,
    at: now().toISOString(),
    artifactHash: target.artifactHash,
    by,
  };
  await appendDeployHistory(root, entry);
  log(`deploy: rolled back ${currentSha.slice(0, 12)} → ${target.sha.slice(0, 12)}`);
  await options.hooks.restartDaemon({ root, installedDir: join(root, target.sha), sha: target.sha, log, ...(v2 ? { runtime: "v2" as const } : {}) });
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
    await assertNoUpdateReservation(root);
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
