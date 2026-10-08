/**
 * Landed-work detection for the A2 dirty guard.
 *
 * A Cell commit the origin never received is still safe to lose when its
 * change already sits on a landing target in the origin: landing queues
 * rebase, cherry-pick and squash, so the same work arrives under new SHAs.
 * A commit counts as landed when ANY of these holds against a landing target
 * (the origin's main/master, its remote-tracking main/master, and the target
 * branch of every landing receipt):
 *
 *  1. it is reachable from the target, the provisioned base, or the source
 *     head of a landing receipt whose result commit the target contains;
 *  2. the merge of the tip into the target is clean and yields the target's
 *     own tree (the tip's whole range is already there: squash, rebase);
 *  3. a commit with the same `git patch-id --stable` is on the target
 *     (`rev-list --cherry-mark`: cherry-picks that main later built on);
 *  4. replaying the commit onto the target is clean and changes nothing
 *     (a cherry-pick that would be empty: trivially resolved rebases).
 *
 * Every check fails closed: a git error, a conflict, an old git without
 * `merge-tree --write-tree`, or a budget overrun leaves the commit unlanded.
 *
 * The cell and the origin are separate object stores. The probes run in the
 * cell with both stores as read-only alternates and a throwaway primary
 * object directory, so the trees `merge-tree` writes never land in either
 * repository.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isAncestor, tryGit } from "./git.ts";

export interface LandingReceipt {
  /** The Cell commit that was landed. */
  cellHead: string;
  /** The commit the landing produced on the target branch. */
  resultSha: string;
  targetBranch: string | null;
}

export interface UnlandedCommit {
  sha: string;
  subject: string;
}

const DEFAULT_TARGET_REFS = [
  "refs/heads/main",
  "refs/heads/master",
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
] as const;

const MAX_RANGE_COMMITS = 500;
const MAX_REPLAY_PROBES = 64;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Commit shas of the origin's landing targets, deduplicated. */
export function landingTargets(originRepo: string, receipts: readonly LandingReceipt[]): string[] {
  const wanted = new Set<string>(DEFAULT_TARGET_REFS);
  for (const r of receipts) {
    if (r.targetBranch && !r.targetBranch.startsWith("-")) wanted.add(`refs/heads/${r.targetBranch}`);
  }
  const res = tryGit(originRepo, ["for-each-ref", "--format=%(refname)%00%(objectname)", ...wanted]);
  if (res.status !== 0) return [];
  const shas = new Set<string>();
  for (const line of res.stdout.split("\n")) {
    const [ref, sha] = line.split("\0");
    if (ref && sha && wanted.has(ref)) shas.add(sha);
  }
  return [...shas];
}

function objectsDir(repo: string): string | null {
  const res = tryGit(repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]);
  return res.status === 0 ? res.stdout.trim() : null;
}

function alternatesValue(dirs: string[]): string {
  return dirs.map((d) => (d.includes(delimiter) || d.startsWith('"') ? `"${d.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : d)).join(delimiter);
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

/**
 * For each tip, the commits on it that are not landed in the origin, newest
 * first. A tip mapped to an empty list is fully landed.
 */
export function unlandedCommitsByTip(req: {
  spaceDir: string;
  originRepo: string;
  tips: readonly string[];
  base: string | null;
  receipts?: readonly LandingReceipt[];
}): Map<string, string[]> {
  const tips = [...new Set(req.tips)];
  try {
    return probeTips(req.spaceDir, req.originRepo, tips, req.base, req.receipts ?? []);
  } catch {
    return new Map(tips.map((tip) => [tip, commitsSinceBase(req.spaceDir, tip, req.base)]));
  }
}

function commitsSinceBase(spaceDir: string, tip: string, base: string | null): string[] {
  const res = tryGit(spaceDir, ["rev-list", `--max-count=${MAX_RANGE_COMMITS + 1}`, tip, ...(base ? ["--not", base] : [])]);
  const range = res.status === 0 ? lines(res.stdout) : [];
  return range.length > 0 ? range : [tip];
}

function probeTips(spaceDir: string, originRepo: string, tips: string[], base: string | null, receipts: readonly LandingReceipt[]): Map<string, string[]> {
  const cellObjects = objectsDir(spaceDir);
  const originObjects = objectsDir(originRepo);
  if (cellObjects == null || originObjects == null) throw new Error("object directories unresolvable");
  const targets = landingTargets(originRepo, receipts);
  const landedHeads = receipts
    .filter((r) => SHA.test(r.cellHead) && SHA.test(r.resultSha) && targets.some((t) => isAncestor(originRepo, r.resultSha, t)))
    .map((r) => r.cellHead);

  const scratch = mkdtempSync(join(tmpdir(), "hive-landed-"));
  try {
    const env = { GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue([cellObjects, originObjects]) };
    const run = (args: string[]) => tryGit(spaceDir, args, { env });
    const must = (args: string[]) => {
      const res = run(args);
      if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr.trim()}`);
      return res.stdout;
    };
    const trees = new Map<string, string>();
    const treeOf = (commit: string) => {
      let tree = trees.get(commit);
      if (tree === undefined) {
        tree = must(["rev-parse", `${commit}^{tree}`]).trim();
        trees.set(commit, tree);
      }
      return tree;
    };
    const mergesToTarget = (target: string, args: string[]) => {
      const res = run(["merge-tree", "--write-tree", ...args]);
      return res.status === 0 && lines(res.stdout)[0] === treeOf(target);
    };
    const replayVerdicts = new Map<string, boolean>();
    let replayBudget = MAX_REPLAY_PROBES;
    const replaysEmpty = (commit: string): boolean => {
      const known = replayVerdicts.get(commit);
      if (known !== undefined) return known;
      if (replayBudget <= 0) return false;
      replayBudget -= 1;
      const parent = lines(must(["rev-list", "--parents", "-n", "1", commit]))[0]?.split(" ")[1];
      const empty = parent != null && targets.some((t) => mergesToTarget(t, [`--merge-base=${parent}`, t, commit]));
      replayVerdicts.set(commit, empty);
      return empty;
    };

    const out = new Map<string, string[]>();
    for (const tip of tips) {
      must(["cat-file", "-e", `${tip}^{commit}`]);
      const exclude = [...(base ? [base] : []), ...targets, ...landedHeads];
      const range = lines(must(["rev-list", "--ignore-missing", `--max-count=${MAX_RANGE_COMMITS + 1}`, tip, "--not", ...exclude]));
      if (range.length === 0 || targets.some((t) => mergesToTarget(t, [t, tip]))) {
        out.set(tip, []);
        continue;
      }
      if (range.length > MAX_RANGE_COMMITS) {
        out.set(tip, range);
        continue;
      }
      const remaining = new Set(range);
      for (const target of targets) {
        for (const line of lines(must(["rev-list", "--cherry-mark", "--right-only", "--no-merges", `${target}...${tip}`]))) {
          if (line.startsWith("=")) remaining.delete(line.slice(1));
        }
      }
      for (const commit of range) {
        if (remaining.has(commit) && replaysEmpty(commit)) remaining.delete(commit);
      }
      out.set(tip, range.filter((c) => remaining.has(c)));
    }
    return out;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Subjects for display; a commit whose subject cannot be read keeps an empty one. */
export function describeCommits(spaceDir: string, shas: readonly string[]): UnlandedCommit[] {
  if (shas.length === 0) return [];
  const res = tryGit(spaceDir, ["log", "--no-walk=unsorted", "--format=%H%x00%s", ...shas]);
  const subjects = new Map<string, string>();
  if (res.status === 0) {
    for (const line of res.stdout.split("\n")) {
      const [sha, subject] = line.split("\0");
      if (sha) subjects.set(sha, subject ?? "");
    }
  }
  return shas.map((sha) => ({ sha, subject: subjects.get(sha) ?? "" }));
}
