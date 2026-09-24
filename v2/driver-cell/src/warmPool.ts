/**
 * Per-repository warm Cell pool (spawn floor work, 2026-09-21).
 *
 * The dominant Honeybee-owned cost in a Cell spawn is provisioning: `git clone
 * --local` + `git checkout` of the working tree (measured ~300 ms warm, ~985 ms
 * cold-cache for a 3,915-file tree on satellite ext4; see
 * docs/performance/2026-09-21-boot-attribution.json). That cost is identical for
 * every harness. A warm pool moves it OFF the spawn critical path: members are
 * pre-provisioned in the background, and a spawn CLAIMS one by an atomic
 * directory rename plus, when the wanted sha differs, a cheap checkout delta.
 *
 * Layout — a pool member is an ordinary cell wrapper the reaper already
 * understands, parked under a reserved namespace:
 *
 *   <cells-root>/_warmpool/<repoKey>/<memberId>/box/cell.json   (beeId = "__warmpool__")
 *   <cells-root>/<repoKey>/<memberId>/<repo>-space-<id>/        the provisioned checkout
 *
 * The pool NEVER touches the daemon or the core store: the daemon still
 * `reserveCell`s the bee's own wrapper (box/cell.json seed) exactly as before;
 * claim only fills that reserved wrapper's space dir from a member and rewrites
 * the seed ledger to "provisioned". So a bee's cwd, cell row and spaceName are
 * unchanged whether it was served cold or from the pool.
 *
 * Safety invariants (unit-tested in warmPool.test.ts):
 *  - A member is served only when it is provisioned, CLEAN (`git status` empty)
 *    and can reach the wanted sha (exact, present, or fetched from the origin
 *    for a delta). A dirty member is discarded, never handed out.
 *  - The claim is an atomic `rename` of the member's space dir into the bee's
 *    reserved wrapper: two concurrent spawns cannot claim the same member (the
 *    loser gets ENOENT and tries the next).
 *  - After a claim the bee ledger has a completed operation, so `provisionCell`
 *    short-circuits (`replayed`) — provisioning replay and ledger idempotency
 *    survive a warm pool unchanged.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { cellPaths, parseSpaceName, sanitizeComponent, type CellPaths } from "./layout.ts";
import {
  isProvisioned,
  newLedger,
  readLedger,
  writeLedger,
  type CellLedger,
  type LedgerOperation,
} from "./ledger.ts";
import { git, gitCommonDirRealpath, hasCommit, tryGit } from "./git.ts";
import { provisionCell, type ProvisionedCell, type ProvisionOptions, type ProvisionRequest } from "./provision.ts";

/** Reserved wrapper prefix; pool members live under `<cells-root>/_warmpool/<repoKey>/`. */
export const WARM_POOL_DIR = "_warmpool";
/** The placeholder bee id a parked member's ledger carries until it is claimed. */
export const WARM_POOL_BEE = "__warmpool__";
const DISCARD_PREFIX = ".discard-";
const BUILD_PREFIX = ".build-";
export const RACY_INDEX_WINDOW_MS = 1_100;

const CHECKOUT_WORKERS = Math.max(1, Math.min(8, availableParallelism()));
const PARALLEL_CHECKOUT_CONFIG = [
  "-c", `checkout.workers=${CHECKOUT_WORKERS}`,
  "-c", "checkout.thresholdForParallelism=100",
];

/** A stable, filesystem-safe key for a repo origin (identity, not display name). */
export function repoKeyFor(originRepo: string, repoName: string): string {
  const identity = gitCommonDirRealpath(originRepo) ?? resolve(originRepo);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${sanitizeComponent(repoName)}-${digest}`;
}

function poolRootFor(cellsRoot: string, repoKey: string): string {
  return join(resolve(cellsRoot), WARM_POOL_DIR, sanitizeComponent(repoKey));
}

export interface PoolMember {
  memberId: string;
  wrapperDir: string;
  paths: CellPaths;
  ledger: CellLedger;
  sha: string;
}

/** Enumerate provisioned pool members for a repo, newest-first is not required. */
export function listPoolMembers(cellsRoot: string, repoKey: string): PoolMember[] {
  const root = poolRootFor(cellsRoot, repoKey);
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const members: PoolMember[] = [];
  for (const memberId of entries) {
    if (memberId.startsWith(".")) continue;
    const wrapperDir = join(root, memberId);
    let ledger: CellLedger | null;
    try {
      if (!statSync(wrapperDir).isDirectory()) continue;
      ledger = readLedger(join(wrapperDir, "box", "cell.json"));
    } catch {
      continue;
    }
    if (ledger == null || ledger.beeId !== WARM_POOL_BEE || !isProvisioned(ledger)) continue;
    const parsed = parseSpaceName(ledger.spaceName);
    if (parsed == null) continue;
    const paths = cellPaths(root, memberId, parsed.repoName, parsed.cellId);
    if (!existsSync(paths.spaceDir)) continue;
    members.push({ memberId, wrapperDir, paths, ledger, sha: ledger.sha });
  }
  return members;
}

export function poolMemberCount(cellsRoot: string, repoKey: string): number {
  return listPoolMembers(cellsRoot, repoKey).length;
}

/** The completed operation a claimed member contributes to the bee's ledger. */
function completedOperationFrom(ledger: CellLedger): LedgerOperation | null {
  return Object.values(ledger.operations).find((op) => op.completedAt != null) ?? null;
}

/**
 * Try to satisfy an already-reserved bee cell from the pool. Returns the
 * provisioned cell on success (the bee's own paths), or null to fall back to a
 * cold provision. Never throws for an unusable member — it is discarded and the
 * next is tried.
 */
export function claimFromPool(
  cellsRoot: string,
  req: ProvisionRequest,
  opts: { now?: () => number } = {},
): ProvisionedCell | null {
  const now = opts.now ?? Date.now;
  const repoKey = repoKeyFor(req.originRepo, req.repoName);
  const claimStartedAt = now();
  const beePaths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
  // The bee's own space dir must be empty: reserveCell created only box/.
  if (existsSync(beePaths.spaceDir)) return null;

  // Prefer an exact-sha member (no delta), then any reachable member.
  const members = listPoolMembers(cellsRoot, repoKey);
  const ordered = [
    ...members.filter((m) => m.sha === req.sha),
    ...members.filter((m) => m.sha !== req.sha),
  ];

  for (const member of ordered) {
    const exact = member.sha === req.sha;
    // Guard BEFORE claiming: clean tree, and the wanted sha is reachable.
    if (!isClean(member.paths.spaceDir)) {
      discardMember(member.wrapperDir);
      continue;
    }
    if (!exact && !reachCommit(member.paths.spaceDir, req.originRepo, req.sha)) continue;
    // Atomic claim: the first rename wins; a raced loser sees ENOENT.
    mkdirSync(beePaths.wrapperDir, { recursive: true });
    try {
      renameSync(member.paths.spaceDir, beePaths.spaceDir);
    } catch {
      continue; // another spawn took this member, or it vanished
    }
    // No re-check after the move: an atomic same-filesystem rename cannot change
    // contents, and a parked member has no other writer (only buildPoolMember,
    // which completes before the member is listed). The pre-claim status above
    // is the dirty guard; a second `git status` on a large tree is pure cost.
    const memberOp = completedOperationFrom(member.ledger);
    if (memberOp == null) {
      rmSync(beePaths.spaceDir, { recursive: true, force: true });
      discardMember(member.wrapperDir);
      continue;
    }
    if (!exact) {
      // A cheap checkout delta to the wanted sha (the commit is present).
      git(beePaths.spaceDir, [...PARALLEL_CHECKOUT_CONFIG, "checkout", "--force", "--detach", req.sha]);
    }
    // Rewrite the bee's seed ledger to "provisioned": keep the bee identity,
    // adopt the member's copy mode and step record, land the wanted sha.
    const beeLedger = readLedger(beePaths.ledgerPath) ?? newLedger({
      beeId: req.beeId,
      origin: req.originRepo,
      sha: req.sha,
      wrapper: req.wrapper,
      spaceName: beePaths.spaceName,
      now: now(),
      warm: req.warmArtifacts,
    });
    const opId = `warmpool-claim-${member.memberId}`;
    beeLedger.sha = req.sha;
    beeLedger.copy_mode = member.ledger.copy_mode;
    beeLedger.operations[opId] = {
      startedAt: claimStartedAt,
      completedAt: now(),
      steps: {
        ...memberOp.steps,
        ...(memberOp.steps.checkout ? { checkout: { sha: req.sha, at: now() } } : {}),
      },
    };
    writeLedger(beePaths.ledgerPath, beeLedger);
    discardMember(member.wrapperDir);

    const warm = memberOp.steps.warm ?? { mode: "cold" as const, dirs: [], reason: "none_listed" };
    return {
      paths: beePaths,
      copyMode: member.ledger.copy_mode ?? "clone",
      warm,
      sha: req.sha,
      originRepo: req.originRepo,
      replayed: true,
    };
  }
  return null;
}

function hiddenEntries(root: string): string[] {
  try {
    return readdirSync(root).filter((entry) => entry.startsWith("."));
  } catch {
    return [];
  }
}

function isClean(spaceDir: string): boolean {
  try {
    const res = tryGit(spaceDir, ["status", "--porcelain"]);
    return res.status === 0 && res.stdout.trim() === "";
  } catch {
    return false;
  }
}

function reachCommit(spaceDir: string, originRepo: string, sha: string): boolean {
  try {
    if (hasCommit(spaceDir, sha)) return true;
    tryGit(spaceDir, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", originRepo, sha]);
    return hasCommit(spaceDir, sha);
  } catch {
    return false;
  }
}

function discardMember(wrapperDir: string): void {
  const doomed = join(wrapperDir, "..", `${DISCARD_PREFIX}${randomBytes(6).toString("hex")}`);
  try {
    renameSync(wrapperDir, doomed);
  } catch {
    return;
  }
  rmSync(doomed, { recursive: true, force: true });
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
}

function settleIndex(spaceDir: string, racyWindowMs: number): void {
  sleepSync(racyWindowMs);
  tryGit(spaceDir, ["update-index", "-q", "--refresh"]);
}

export interface TopUpRequest {
  originRepo: string;
  repoName: string;
  sha: string;
  warmArtifacts?: string[];
}

/**
 * Build ONE pool member at `req.sha`, provisioned the same way a cold spawn
 * would be. Returns the member id, or null when the pool is already at/over
 * `maxSize` or the sha is missing from the origin. Heavy (a real checkout):
 * callers run it OFF the daemon event loop (poolWorker.ts).
 */
export function buildPoolMember(
  cellsRoot: string,
  req: TopUpRequest,
  provisionOpts: ProvisionOptions = {},
  opts: { maxSize?: number; now?: () => number; racyIndexWindowMs?: number } = {},
): string | null {
  const repoKey = repoKeyFor(req.originRepo, req.repoName);
  const maxSize = opts.maxSize ?? 32;
  if (poolMemberCount(cellsRoot, repoKey) >= maxSize) return null;
  if (!hasCommit(req.originRepo, req.sha)) return null;
  const root = poolRootFor(cellsRoot, repoKey);
  mkdirSync(root, { recursive: true });
  const buildDir = mkdtempSync(join(root, BUILD_PREFIX));
  const buildId = buildDir.slice(root.length + 1);
  const memberId = `m-${buildId.slice(BUILD_PREFIX.length)}`;
  const cellId = createHash("sha256").update(buildDir).digest("hex").slice(0, 12);
  const request: ProvisionRequest = {
    beeId: WARM_POOL_BEE,
    originRepo: req.originRepo,
    sha: req.sha,
    wrapper: buildId,
    repoName: req.repoName,
    cellId,
    ...(req.warmArtifacts && req.warmArtifacts.length > 0 ? { warmArtifacts: [...req.warmArtifacts] } : {}),
  };
  try {
    const cell = provisionCell(root, request, `warmpool-build-${memberId}`, provisionOpts);
    settleIndex(cell.paths.spaceDir, opts.racyIndexWindowMs ?? RACY_INDEX_WINDOW_MS);
    renameSync(buildDir, join(root, memberId));
  } catch (error) {
    rmSync(buildDir, { recursive: true, force: true });
    throw error;
  }
  return memberId;
}

/** Discard members whose sha is not the current one and any dirty member. */
export function reapPool(cellsRoot: string, repoKey: string, keepSha: string): number {
  const root = poolRootFor(cellsRoot, repoKey);
  for (const leftover of hiddenEntries(root)) rmSync(join(root, leftover), { recursive: true, force: true });
  let removed = 0;
  for (const member of listPoolMembers(cellsRoot, repoKey)) {
    if (member.sha !== keepSha || !isClean(member.paths.spaceDir)) {
      discardMember(member.wrapperDir);
      removed++;
    }
  }
  return removed;
}

/** Guard: refuse a cells root that is not an absolute path (never operate on cwd). */
export function assertPoolRoot(cellsRoot: string): void {
  if (!isAbsolute(cellsRoot)) throw new Error(`warm pool: cellsRoot must be absolute: ${cellsRoot}`);
}
