/**
 * Cell deletion (WP5, spec 05 point 6 — the A2 ruling).
 *
 * A dirty cell — uncommitted changes in the space, or commits that have not
 * landed in the origin (landed.ts) — refuses deletion without `force`.
 * Deletion only ever operates on shape-checked paths (a wrapper containing a
 * `-space-` checkout), so a mis-wired variable can never point the reaper at
 * a user directory.
 * ENOTEMPTY (a racing writer mid-delete) retries exactly once.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, hasCommit, revParse } from "./git.ts";
import { describeCommits, unlandedCommitsByTip, type LandingReceipt, type UnlandedCommit } from "./landed.ts";
import { CELL_SPACE_DIRECTORY, looksLikeCellWrapper } from "./layout.ts";
import { readLedger } from "./ledger.ts";

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

  constructor(wrapperDir: string, report: DirtyReport) {
    super(`cell ${wrapperDir} is dirty (${dirtyCauses(report).join(", ")}); pass force to delete anyway`);
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
}

export function dirtyReport(wrapperDir: string, opts: DirtyReportOptions = {}): DirtyReport {
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
  if (!existsSync(join(spaceDir, ".git"))) return clean; // half-provisioned: nothing to lose

  const uncommitted = git(spaceDir, ["status", "--porcelain"]).length > 0;
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
      const byTip = unlandedCommitsByTip({ spaceDir, originRepo: origin, tips, base: ledger.sha, receipts: opts.receipts ?? [] });
      const at = (sha: string) => byTip.get(sha) ?? [sha];
      if (headTip) unpushed = at(headTip).length > 0;
      for (const b of branches) if (at(b.sha).length > 0) unlandedBranches.push(b.name);
      unlanded = [...new Set(tips.flatMap(at))];
    }
  }
  if (unlandedBranches.length > 0) unpushed = true;
  return {
    dirty: uncommitted || unpushed || stashed || originUnknown,
    uncommitted,
    unpushed,
    stashed,
    unlandedBranches,
    unlandedCommits: describeCommits(spaceDir, unlanded.slice(0, REPORTED_COMMITS)),
    unlandedCommitCount: unlanded.length,
    originUnknown,
  };
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
export function deleteCell(wrapperDir: string, opts: DirtyReportOptions & { force?: boolean } = {}): DeleteResult {
  const target = resolve(wrapperDir);
  const report = existsSync(target) ? dirtyReport(target, opts) : null;
  if (report == null) return { deleted: false, forced: false, report: null };
  if (report.dirty && !(opts.force ?? false)) {
    throw new CellDeleteRefused(target, report);
  }
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (err) {
    // A racing writer (agent teardown, indexer) can repopulate a directory
    // between unlink and rmdir. Exactly one retry (spec 05 point 6).
    if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
    rmSync(target, { recursive: true, force: true });
  }
  return { deleted: true, forced: report.dirty, report };
}
