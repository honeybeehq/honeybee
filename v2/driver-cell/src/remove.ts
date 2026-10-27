/** Cell inspection facts and retired local deletion entrypoint.
 * Physical disposal belongs to the independently verified Honeybee owner worker.
 * A dirty/clean report and force flag never authorize deletion by themselves.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, hasCommit, revParse, tryGit } from "./git.ts";
import { describeCommits, unlandedCommitsByTip, type LandingReceipt, type UnlandedCommit } from "./landed.ts";
import { CELL_SPACE_DIRECTORY, looksLikeCellWrapper } from "./layout.ts";
import { readLedger } from "./ledger.ts";
import type { UpstreamRef } from "./upstream.ts";

const REPORTED_COMMITS = 20;

export interface DirtyReport {
  dirty: boolean;
  /** Uncommitted working-tree changes in the space. */
  uncommitted: boolean;
  /** Cell HEAD, or any local branch tip, holds commits that are neither in the origin nor landed there under other SHAs. */
  unpushed: boolean;
  /** v31 — `git stash list` is not empty: stashed work exists only in this Cell. */
  stashed: boolean;
  /** v31 — local branches whose tip the origin does not contain (the agent committed, then switched away). */
  unlandedBranches: string[];
  /** The commits behind `unpushed`, newest first, at most 20. */
  unlandedCommits: UnlandedCommit[];
  /** How many unlanded commits there are in total (may exceed `unlandedCommits.length`). */
  unlandedCommitCount: number;
  /** The origin could not be consulted (missing/moved) — treated as dirty. */
  originUnknown: boolean;
}

export function dirtyCauses(report: DirtyReport): string[] {
  return [
    report.uncommitted ? "uncommitted changes" : null,
    report.unpushed ? unlandedCommitsCause(report) : null,
    report.stashed ? "stashed changes" : null,
    report.unlandedBranches.length > 0 ? `unlanded branches (${report.unlandedBranches.join(", ")})` : null,
    report.originUnknown ? "origin unreachable" : null,
  ].filter((c): c is string => c != null);
}

function unlandedCommitsCause(report: DirtyReport): string {
  if (report.unlandedCommitCount === 0) return "uncaptured commits";
  const listed = report.unlandedCommits.map((c) => `${c.sha.slice(0, 12)} ${c.subject}`.trim()).join("; ");
  const more = report.unlandedCommitCount - report.unlandedCommits.length;
  return `${report.unlandedCommitCount} unlanded commit${report.unlandedCommitCount === 1 ? "" : "s"}: ${listed}${more > 0 ? `; +${more} more` : ""}`;
}

export class CellDeleteRefused extends Error {
  readonly report: DirtyReport;

  readonly dirtySubmodules: string[];

  constructor(wrapperDir: string, report: DirtyReport, dirtySubmodules: string[] = []) {
    const submodules = dirtySubmodules.length > 0 ? `; submodules with local state: ${dirtySubmodules.join(", ")}` : "";
    super(`cell ${wrapperDir} is dirty (${dirtyCauses(report).join(", ")}${submodules}); pass force to delete anyway`);
    this.dirtySubmodules = dirtySubmodules;
    this.name = "CellDeleteRefused";
    this.report = report;
  }
}

export class CellShapeError extends Error {
  constructor(path: string, why: string) {
    super(`refusing to delete '${path}': ${why} — cell deletion only operates on -space- shaped wrappers`);
    this.name = "CellShapeError";
  }
}

/** Locate the space directory inside a wrapper (shape check included). */
function spaceDirOf(wrapperDir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(wrapperDir);
  } catch {
    throw new CellShapeError(wrapperDir, "not a readable directory");
  }
  if (!looksLikeCellWrapper(wrapperDir, entries)) {
    throw new CellShapeError(wrapperDir, "no -space- checkout inside");
  }
  const space = entries.find((e) => CELL_SPACE_DIRECTORY.test(e)) as string;
  return join(wrapperDir, space);
}

export interface DirtyReportOptions {
  /** Landing receipts for the Cell's bee: exact proof that a Cell commit landed under another SHA. */
  receipts?: readonly LandingReceipt[];
  /** Honeybee upstream mirror ref for the origin: ancestry of it counts as landed. */
  upstream?: UpstreamRef | null;
}

export function dirtyReport(wrapperDir: string, opts: DirtyReportOptions = {}): DirtyReport {
  return dirtyReportDetailed(wrapperDir, opts).report;
}

/**
 * The dirty report plus the populated submodules that hold local state. Their
 * dirt is reported as `uncommitted` (the report shape is a wire contract);
 * the paths are for refusal messages, logs and audit rows.
 */
export function dirtyReportDetailed(wrapperDir: string, opts: DirtyReportOptions = {}): { report: DirtyReport; dirtySubmodules: string[] } {
  const spaceDir = spaceDirOf(wrapperDir);
  const clean: DirtyReport = {
    dirty: false,
    uncommitted: false,
    unpushed: false,
    stashed: false,
    unlandedBranches: [],
    unlandedCommits: [],
    unlandedCommitCount: 0,
    originUnknown: false,
  };
  if (!existsSync(join(spaceDir, ".git"))) return { report: clean, dirtySubmodules: [] }; // half-provisioned: nothing to lose

  const dirtySubmodules = submodulesWithLocalState(spaceDir);
  const uncommitted = git(spaceDir, ["status", "--porcelain", "--ignore-submodules=all"]).length > 0 || dirtySubmodules.length > 0;
  const stashed = git(spaceDir, ["stash", "list"]).length > 0;

  let unpushed = false;
  let originUnknown = false;
  const unlandedBranches: string[] = [];
  let unlanded: string[] = [];
  const head = revParse(spaceDir, "HEAD");
  const ledger = readLedger(join(wrapperDir, "box", "cell.json"));
  const origin = ledger?.origin;
  if (ledger == null || origin == null || !existsSync(origin)) {
    if (head != null) originUnknown = true;
  } else {
    // A tip the origin has never seen may still be landed under other SHAs
    // (rebased, cherry-picked, squashed); only commits that are not count.
    const unseen = (sha: string) => sha !== ledger.sha && !hasCommit(origin, sha);
    const headTip = head != null && unseen(head) ? head : null;
    // A branch the agent committed to and then switched away from is not
    // HEAD, yet deleting the Cell would destroy it just the same.
    const branches: Array<{ name: string; sha: string }> = [];
    const refs = git(spaceDir, ["for-each-ref", "--format=%(refname:short)%00%(objectname)", "refs/heads"]);
    for (const line of refs.split("\n")) {
      const [name, sha] = line.split("\0");
      if (name && sha && unseen(sha)) branches.push({ name, sha });
    }
    const tips = [...(headTip ? [headTip] : []), ...branches.map((b) => b.sha)];
    if (tips.length > 0) {
      const byTip = unlandedCommitsByTip({ spaceDir, originRepo: origin, tips, base: ledger.sha, receipts: opts.receipts ?? [], upstream: opts.upstream ?? null });
      const at = (sha: string) => byTip.get(sha) ?? [sha];
      if (headTip) unpushed = at(headTip).length > 0;
      for (const b of branches) if (at(b.sha).length > 0) unlandedBranches.push(b.name);
      unlanded = [...new Set(tips.flatMap(at))];
    }
  }
  if (unlandedBranches.length > 0) unpushed = true;
  const report: DirtyReport = {
    dirty: uncommitted || unpushed || stashed || originUnknown,
    uncommitted,
    unpushed,
    stashed,
    unlandedBranches,
    unlandedCommits: describeCommits(spaceDir, unlanded.slice(0, REPORTED_COMMITS)),
    unlandedCommitCount: unlanded.length,
    originUnknown,
  };
  return { report, dirtySubmodules };
}

const GITLINK_MODE = "160000";

function gitlinksOf(repo: string): Array<{ path: string; sha: string }> | null {
  const res = tryGit(repo, ["ls-files", "--stage", "-z"]);
  if (res.status !== 0) return null;
  const links: Array<{ path: string; sha: string }> = [];
  for (const entry of res.stdout.split("\0")) {
    if (!entry.startsWith(`${GITLINK_MODE} `)) continue;
    const tab = entry.indexOf("\t");
    const [, sha] = entry.slice(0, tab).split(" ");
    if (tab > 0 && sha) links.push({ path: entry.slice(tab + 1), sha });
  }
  return links;
}

/**
 * Submodules whose deletion would lose something: a gitlink directory holding
 * files without its own repository (de-submoduled in place), or a populated
 * submodule where the superproject
 * sees a change in them, they hold uncommitted, untracked or ignored files or
 * a stash, their HEAD or a local branch has commits on no remote-tracking ref,
 * or they nest further submodules. An unreadable index counts as dirty.
 */
export function submodulesWithLocalState(spaceDir: string): string[] {
  const links = gitlinksOf(spaceDir);
  if (links == null) return ["(index unreadable)"];
  if (links.length === 0) return [];
  const changed = tryGit(spaceDir, ["status", "--porcelain=v1", "-z", "--ignore-submodules=none", "--untracked-files=no"]);
  const changedPaths = new Set(
    changed.status === 0 ? changed.stdout.split("\0").filter((r) => r.length > 3).map((r) => r.slice(3)) : links.map((l) => l.path),
  );
  const dirty: string[] = [];
  for (const link of links) {
    const subDir = join(spaceDir, link.path);
    if (!existsSync(join(subDir, ".git"))) {
      if (existsSync(subDir) && (!statSync(subDir).isDirectory() || readdirSync(subDir).length > 0)) dirty.push(link.path);
      continue;
    }
    const holds = (): boolean => {
      if (changedPaths.has(link.path)) return true;
      const status = tryGit(subDir, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=normal"]);
      if (status.status !== 0 || status.stdout.trim().length > 0) return true;
      const stash = tryGit(subDir, ["stash", "list"]);
      if (stash.status !== 0 || stash.stdout.trim().length > 0) return true;
      const head = revParse(subDir, "HEAD");
      if (head == null || head !== link.sha) return true;
      const onRemote = tryGit(subDir, ["for-each-ref", "--contains", head, "--count=1", "--format=%(refname)", "refs/remotes"]);
      if (onRemote.status !== 0 || onRemote.stdout.trim().length === 0) return true;
      const localOnly = tryGit(subDir, ["rev-list", "--max-count=1", "--branches", "--not", "--remotes"]);
      if (localOnly.status !== 0 || localOnly.stdout.trim().length > 0) return true;
      const nested = gitlinksOf(subDir);
      return nested == null || nested.length > 0;
    };
    if (holds()) dirty.push(link.path);
  }
  return dirty;
}

export interface DeleteResult {
  deleted: boolean;
  forced: boolean;
  report: DirtyReport | null;
}

/**
 * Delete a cell wrapper. Throws CellDeleteRefused for a dirty cell without
 * `force` (A2), CellShapeError for anything not cell-shaped.
 */
export class CellBackupRequiredError extends Error {
  readonly reason: "receipt_missing" | "unknown_policy";
  constructor(reason: "receipt_missing" | "unknown_policy" = "receipt_missing") {super(reason);this.reason=reason;}
}
/** Physical deletion is exclusively performed by Honeybee's verified owner worker. */
export function deleteCell(_wrapperDir: string, _opts: DirtyReportOptions & { force?: boolean } = {}): DeleteResult {
  throw new CellBackupRequiredError();
}
