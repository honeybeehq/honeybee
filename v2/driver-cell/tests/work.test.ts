/**
 * Cell work bundles: what git calls work is measured, bundled with a
 * temporary index and a shadow object store (the Cell untouched), verified
 * by a throwaway restore, written durably, and restored into a fresh
 * checkout so `git status`, `git diff`, the refs and HEAD read as they did.
 * Over-cap, unbundleable and corrupted cases refuse before anything is
 * removed. Temp dirs only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { cellPaths } from "../src/layout.ts";
import { provisionCell } from "../src/provision.ts";
import { WorkError, bundleWork, checkWorkPrerequisites, dropWorkBundle, listStashes, listWorkBundles, measureWork, readWorkRecord, restoreWork, rewriteWorkBundle, verifyRestoredWork, verifyWorkBundle, workBundlePaths, workNeeded } from "../src/work.ts";
import { commitInCell, commitOn, g, makeRig } from "./helpers.ts";

const OPTS = { disableCow: true, useGitImages: false } as const;
const GIB = 1024 ** 3;

function provisioned(rig: ReturnType<typeof makeRig>, id: string) {
  const req = { beeId: `bee-${id}`, originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: `w-${id}`, repoName: "repo", cellId: id };
  provisionCell(rig.cellsRoot, req, `op-${id}`, OPTS);
  const paths = cellPaths(rig.cellsRoot, req.wrapper, req.repoName, req.cellId);
  return { req, paths, space: paths.spaceDir, workRoot: join(rig.root, "cell-work") };
}

function snapshot(space: string) {
  const symbolic = (() => { try { return g(space, ["symbolic-ref", "HEAD"]); } catch { return null; } })();
  return {
    status: g(space, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    refs: g(space, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
    head: g(space, ["rev-parse", "HEAD"]),
    branch: symbolic,
    diff: g(space, ["diff"]),
    cached: g(space, ["diff", "--cached"]),
    reflog: g(space, ["reflog", "show", "--format=%H", "HEAD"]),
  };
}

/** The agent's work: commits on a branch and a side branch, staged and unstaged edits, a deletion, untracked files, ignored output, an info/exclude rule. */
function makeWork(space: string, baseSha: string): void {
  writeFileSync(join(space, ".gitignore"), "build/\n*.log\n");
  g(space, ["add", ".gitignore"]);
  g(space, ["commit", "-q", "-m", "ignores"]);
  g(space, ["checkout", "-q", "-b", "feature"]);
  commitInCell(space, "a.txt", "a\n", "c1");
  commitInCell(space, "b.txt", "b\n", "c2");
  g(space, ["branch", "side", "HEAD~1"]);
  g(space, ["branch", "landed", baseSha]);
  writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");
  writeFileSync(join(space, "staged.txt"), "staged\n");
  g(space, ["add", "staged.txt"]);
  writeFileSync(join(space, "README.md"), "# staged edit\n");
  g(space, ["add", "README.md"]);
  writeFileSync(join(space, "README.md"), "# staged edit + unstaged\n");
  writeFileSync(join(space, "untracked.ts"), "u\n");
  mkdirSync(join(space, "newdir", "deep"), { recursive: true });
  writeFileSync(join(space, "newdir", "deep", "f.bin"), Buffer.alloc(300_000, 7));
  mkdirSync(join(space, "build"));
  writeFileSync(join(space, "build", "out.js"), "ignored\n");
  writeFileSync(join(space, "x.log"), "ignored\n");
  rmSync(join(space, "a.txt"));
  writeFileSync(join(space, ".git", "info", "exclude"), "scratch-*\n");
  writeFileSync(join(space, "scratch-1"), "excluded\n");
}

test("work.measure: commits the origin lacks, changed paths and their apparent bytes, largest first; ignored and excluded files are not work", () => {
  const rig = makeRig();
  try {
    const { space } = provisioned(rig, "m");
    assert.equal(workNeeded(measureWork(space, rig.origin.repo)), false, "a fresh checkout holds no work");
    makeWork(space, rig.origin.sha);
    const m = measureWork(space, rig.origin.repo);
    assert.equal(m.commits, 3, "ignores + c1 + c2 are not in the origin; side and landed add none");
    assert.equal(m.paths, 6);
    assert.equal(m.modified, 4);
    assert.equal(m.untracked, 2);
    assert.equal(m.capturedBytes, 300_000 + 25 + 26 + 7 + 2);
    assert.deepEqual(m.largest.map((e) => e.path), ["newdir", "src/app.ts", "README.md", "staged.txt", "untracked.ts"]);
    assert.equal(m.refusal, null);
    assert.equal(workNeeded(m), true);
  } finally {
    rig.cleanup();
  }
});

test("work.bundle+restore: the Cell is untouched by the capture and a fresh checkout reads byte-identical after the restore", { timeout: 120_000 }, async () => {
  const rig = makeRig();
  try {
    const { req, paths, space, workRoot } = provisioned(rig, "r");
    makeWork(space, rig.origin.sha);
    const before = snapshot(space);
    const record = bundleWork(space, rig.origin.repo, "r", workRoot, { now: () => 1_700_000_000_000 });
    assert.deepEqual(snapshot(space), before, "bundling wrote nothing into the Cell's worktree, index, refs or reflog");
    assert.deepEqual(readdirSync(workRoot).filter((e) => !e.startsWith("tmp")).sort(), ["r.bundle", "r.json"]);
    assert.equal(record.commits, 3);
    assert.equal(record.paths, 6);
    assert.equal(record.head.branch, "feature");
    assert.deepEqual(record.branches.map((b) => b.name), ["feature", "landed", "main", "side"]);
    assert.ok(record.work && record.index.sha, "a working-tree commit and a distinct staged commit");
    assert.deepEqual(record.prerequisites, [rig.origin.sha]);
    assert.ok(record.bundleBytes > 0 && record.bundleBytes < 20_000, `a few KB, got ${record.bundleBytes}`);
    assert.equal(readWorkRecord(workRoot, "r")?.createdAt, 1_700_000_000_000);
    assert.equal(record.infoExclude, "scratch-*\n");

    rmSync(paths.wrapperDir, { recursive: true });
    provisionCell(rig.cellsRoot, req, "op-r2", OPTS);
    const outcome = restoreWork(space, workRoot, "r", { expectedHead: rig.origin.sha });
    assert.deepEqual(outcome, { status: "restored", verified: true, reason: null, commits: 3, paths: 6 });
    const after = snapshot(space);
    for (const key of ["status", "refs", "head", "branch", "diff", "cached"] as const) assert.equal(after[key], before[key], key);
    assert.equal(statSync(join(space, "newdir", "deep", "f.bin")).size, 300_000);
    assert.equal(readFileSync(join(space, ".git", "info", "exclude"), "utf8"), "scratch-*\n");
    assert.equal(existsSync(join(space, "build", "out.js")), false, "ignored output is not work and does not come back through the bundle");
    assert.equal(existsSync(join(space, "scratch-1")), false, "a file excluded by info/exclude is ignored, not work");
    assert.equal(g(space, ["for-each-ref", "refs/hive"]), "", "no restore refs are left behind");
    assert.equal(verifyRestoredWork(space, record), null);
    assert.equal(dropWorkBundle(workRoot, "r"), true);
    assert.equal(readWorkRecord(workRoot, "r"), null);
  } finally {
    rig.cleanup();
  }
});

test("work.stash+branches: stashes and every side branch the origin lacks are bundled and come back byte-identical, with the stash list in order", { timeout: 120_000 }, () => {
  const rig = makeRig();
  try {
    const { req, paths, space, workRoot } = provisioned(rig, "s");
    g(space, ["checkout", "-q", "-b", "side/one"]);
    commitInCell(space, "one.txt", "one\n", "side one");
    g(space, ["checkout", "-q", "-b", "side/two"]);
    commitInCell(space, "two.txt", "two\n", "side two");
    g(space, ["checkout", "-q", "--detach", rig.origin.sha]);
    writeFileSync(join(space, "src", "app.ts"), "export const version = 3;\n");
    writeFileSync(join(space, "scratch.txt"), "untracked in the stash\n");
    g(space, ["stash", "push", "-q", "-u", "-m", "first idea"]);
    writeFileSync(join(space, "README.md"), "# second\n");
    g(space, ["stash", "push", "-q", "-m", "second idea"]);
    assert.equal(g(space, ["status", "--porcelain"]), "", "the tree is clean: only stashes and side branches hold work");
    const before = { ...snapshot(space), stashes: g(space, ["stash", "list", "--format=%H %gd %gs"]), one: g(space, ["log", "--format=%H %s", "side/one"]), two: g(space, ["log", "--format=%H %s", "side/two"]) };
    const m = measureWork(space, rig.origin.repo);
    assert.deepEqual({ commits: m.commits, stashes: m.stashes, paths: m.paths, needed: workNeeded(m) }, { commits: 2, stashes: 2, paths: 0, needed: true });
    const record = bundleWork(space, rig.origin.repo, "s", workRoot);
    assert.equal(record.work, null, "a clean tree needs no work commit");
    assert.deepEqual(record.stashes.map((x) => x.message), ["On (no branch): second idea", "On (no branch): first idea"]);
    assert.deepEqual(record.branches.map((b) => b.name), ["main", "side/one", "side/two"]);
    rmSync(paths.wrapperDir, { recursive: true });
    provisionCell(rig.cellsRoot, req, "op-s2", OPTS);
    const outcome = restoreWork(space, workRoot, "s", { expectedHead: rig.origin.sha });
    assert.deepEqual(outcome, { status: "restored", verified: true, reason: null, commits: 2, paths: 0 });
    const after = { ...snapshot(space), stashes: g(space, ["stash", "list", "--format=%H %gd %gs"]), one: g(space, ["log", "--format=%H %s", "side/one"]), two: g(space, ["log", "--format=%H %s", "side/two"]) };
    for (const key of ["status", "refs", "head", "branch", "diff", "cached", "stashes", "one", "two"] as const) assert.equal(after[key], before[key], key);
    assert.equal(listStashes(space).length, 2);
    assert.equal(g(space, ["show", "stash@{1}^3:scratch.txt"]), "untracked in the stash", "the untracked part of the stash travelled too");
    assert.equal(g(space, ["for-each-ref", "refs/hive"]), "");
  } finally {
    rig.cleanup();
  }
});

test("work.landed-branch: a local branch the origin already reaches is not in the bundle but is recreated from the origin; verifyWorkBundle reports it, and a corrupted bundle", { timeout: 120_000 }, () => {
  const rig = makeRig();
  try {
    const { req, paths, space, workRoot } = provisioned(rig, "lb");
    g(space, ["branch", "lab/followup", rig.origin.sha]);
    commitOn(rig.origin.repo, "later.txt", "origin moved on\n", "origin advance");
    g(space, ["checkout", "-q", "-b", "feat"]);
    commitInCell(space, "feat.txt", "feat\n", "unlanded");
    const before = snapshot(space);
    const record = bundleWork(space, rig.origin.repo, "lb", workRoot);
    assert.deepEqual(record.branches.map((b) => b.name), ["feat", "lab/followup", "main"]);
    assert.deepEqual(record.bundledRefs, ["refs/heads/feat", "refs/hive/head"], "git drops a ref the --not boundary already reaches; the record says which refs the bundle carries");
    const report = verifyWorkBundle(rig.origin.repo, workRoot, "lb");
    assert.equal(report.ok, true, report.problems.join("; "));
    assert.deepEqual(report.refs.map((r) => [r.ref, r.source, r.ok]), [["refs/heads/feat", "bundle", true], ["refs/heads/lab/followup", "origin", true], ["refs/heads/main", "origin", true], ["refs/hive/head", "bundle", true]]);
    assert.equal(report.connectivity, true);
    assert.equal(report.prerequisites.missing.length, 0);
    rmSync(paths.wrapperDir, { recursive: true });
    provisionCell(rig.cellsRoot, req, "op-lb2", OPTS);
    assert.equal(restoreWork(space, workRoot, "lb", { expectedHead: rig.origin.sha }).verified, true);
    const after = snapshot(space);
    for (const key of ["status", "refs", "head", "branch", "diff", "cached"] as const) assert.equal(after[key], before[key], key);
    const { bundle } = workBundlePaths(workRoot, "lb");
    truncateSync(bundle, Math.floor(statSync(bundle).size / 2));
    const broken = verifyWorkBundle(rig.origin.repo, workRoot, "lb");
    assert.equal(broken.ok, false);
    assert.ok(broken.problems.some((p) => /fetch_failed|bundle_unverifiable/.test(p)), broken.problems.join("; "));
    assert.equal(verifyWorkBundle(rig.origin.repo, workRoot, "nope").problems[0], "no_bundle");
  } finally {
    rig.cleanup();
  }
});

/** The origin gains a side branch `feature/x` with two commits; the Cell is spawned at its tip. */
function featureBranchOrigin(rig: ReturnType<typeof makeRig>): { c: string } {
  g(rig.origin.repo, ["checkout", "-q", "-b", "feature/x"]);
  commitOn(rig.origin.repo, "x.txt", "x1\n", "x1");
  const c = commitOn(rig.origin.repo, "x.txt", "x2\n", "x2");
  g(rig.origin.repo, ["checkout", "-q", "main"]);
  return { c };
}

/** The origin squash-merges `feature/x`, deletes it, expires its reflogs and prunes: `c` is gone. */
function squashDeletePrune(rig: ReturnType<typeof makeRig>, c: string): void {
  g(rig.origin.repo, ["merge", "-q", "--squash", "feature/x"]);
  g(rig.origin.repo, ["commit", "-q", "-m", "squash x"]);
  g(rig.origin.repo, ["branch", "-D", "feature/x"]);
  g(rig.origin.repo, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
  g(rig.origin.repo, ["gc", "-q", "--prune=now"]);
  assert.throws(() => g(rig.origin.repo, ["cat-file", "-e", `${c}^{commit}`]), "the spawn commit is pruned from the origin");
}

test("work.boundary: a bundle is cut against the landing targets, so a squash-merged, deleted and pruned side branch cannot take its prerequisites away; the restore lands on main's tip", { timeout: 120_000 }, () => {
  const rig = makeRig();
  try {
    const { c } = featureBranchOrigin(rig);
    const req = { beeId: "bee-fb", originRepo: rig.origin.repo, sha: c, wrapper: "w-fb", repoName: "repo", cellId: "fb" };
    provisionCell(rig.cellsRoot, req, "op-fb", OPTS);
    const paths = cellPaths(rig.cellsRoot, req.wrapper, req.repoName, req.cellId);
    const space = paths.spaceDir;
    const workRoot = join(rig.root, "cell-work");
    g(space, ["checkout", "-q", "-b", "agent/work"]);
    const tip = commitInCell(space, "agent.txt", "agent work\n", "agent commit");
    writeFileSync(join(space, "README.md"), "# edited\n");
    const before = snapshot(space);
    const record = bundleWork(space, rig.origin.repo, "fb", workRoot);
    assert.equal(record.boundaryKind, "landing");
    assert.deepEqual(record.boundary, [rig.origin.sha], "cut against main, not feature/x");
    assert.deepEqual(record.prerequisites, [rig.origin.sha], "the prerequisite is on main's history");
    assert.equal(record.commits, 3, "x1, x2 and the agent commit travel in the bundle");
    rmSync(paths.wrapperDir, { recursive: true });
    squashDeletePrune(rig, c);
    assert.deepEqual(checkWorkPrerequisites(rig.origin.repo, workRoot, "fb"), { restorable: true, missing: [], prerequisites: 1 });
    const mainTip = g(rig.origin.repo, ["rev-parse", "main"]);
    provisionCell(rig.cellsRoot, { ...req, sha: mainTip }, "op-fb2", OPTS);
    const outcome = restoreWork(space, workRoot, "fb", { expectedHead: mainTip });
    assert.deepEqual(outcome, { status: "restored", verified: true, reason: null, commits: 3, paths: 1 });
    const after = snapshot(space);
    for (const key of ["status", "refs", "head", "branch", "diff", "cached"] as const) assert.equal(after[key], before[key], key);
    assert.equal(g(space, ["rev-parse", "HEAD"]), tip);
    assert.equal(g(space, ["log", "--format=%s", "agent/work"]).split("\n").join(" < "), "agent commit < x2 < x1 < initial");
  } finally {
    rig.cleanup();
  }
});

test("work.rewrite: an old bundle cut against every ref is rewritten to the landing targets from the origin's objects; run before the prune it restores, run after it is named unrestorable and the old pair is untouched", { timeout: 120_000 }, () => {
  const rig = makeRig();
  try {
    const { c } = featureBranchOrigin(rig);
    const workRoot = join(rig.root, "cell-work");
    const make = (id: string) => {
      const req = { beeId: `bee-${id}`, originRepo: rig.origin.repo, sha: c, wrapper: `w-${id}`, repoName: "repo", cellId: id };
      provisionCell(rig.cellsRoot, req, `op-${id}`, OPTS);
      const paths = cellPaths(rig.cellsRoot, req.wrapper, req.repoName, req.cellId);
      g(paths.spaceDir, ["checkout", "-q", "-b", "agent/work"]);
      commitInCell(paths.spaceDir, "agent.txt", `agent ${id}\n`, `agent ${id}`);
      writeFileSync(join(paths.spaceDir, "README.md"), `# ${id}\n`);
      const before = snapshot(paths.spaceDir);
      const record = bundleWork(paths.spaceDir, rig.origin.repo, id, workRoot, { boundaryShas: [c] });
      assert.deepEqual(record.prerequisites, [c], "the old boundary leaves the side-branch tip as the prerequisite");
      rmSync(paths.wrapperDir, { recursive: true });
      return { req, paths, before, record };
    };
    const early = make("early");
    const late = make("late");

    const dry = rewriteWorkBundle(rig.origin.repo, workRoot, "early", {});
    assert.equal(dry.status, "rewrite", dry.problems.join("; "));
    assert.deepEqual(dry.oldPrerequisites, [c]);
    assert.deepEqual(dry.newPrerequisites, [rig.origin.sha]);
    assert.ok((dry.newBytes ?? 0) > dry.oldBytes, "x1 and x2 now travel in the bundle");
    assert.deepEqual(readWorkRecord(workRoot, "early")?.prerequisites, [c], "a dry run writes nothing");
    const applied = rewriteWorkBundle(rig.origin.repo, workRoot, "early", { apply: true, now: () => 1_700_000_000_000 });
    assert.equal(applied.status, "rewritten", applied.problems.join("; "));
    const rewritten = readWorkRecord(workRoot, "early")!;
    assert.deepEqual(rewritten.prerequisites, [rig.origin.sha]);
    assert.equal(rewritten.boundaryKind, "landing");
    assert.equal(statSync(workBundlePaths(workRoot, "early").bundle).size, applied.newBytes);
    assert.equal(verifyWorkBundle(rig.origin.repo, workRoot, "early").ok, true);
    assert.equal(rewriteWorkBundle(rig.origin.repo, workRoot, "early", {}).status, "unchanged", "a second pass has nothing to do");

    squashDeletePrune(rig, c);
    const mainTip = g(rig.origin.repo, ["rev-parse", "main"]);
    provisionCell(rig.cellsRoot, { ...early.req, sha: mainTip }, "op-early2", OPTS);
    assert.equal(restoreWork(early.paths.spaceDir, workRoot, "early", { expectedHead: mainTip }).verified, true, "rewritten before the prune: restores");
    const after = snapshot(early.paths.spaceDir);
    for (const key of ["status", "refs", "head", "branch", "diff", "cached"] as const) assert.equal(after[key], early.before[key], key);

    const oldBundle = workBundlePaths(workRoot, "late");
    const oldBytes = statSync(oldBundle.bundle).size;
    const oldRecord = readFileSync(oldBundle.record, "utf8");
    const tooLate = rewriteWorkBundle(rig.origin.repo, workRoot, "late", { apply: true });
    assert.equal(tooLate.status, "unrestorable");
    assert.deepEqual(tooLate.missing, [c], "named by the commit the origin no longer has");
    assert.equal(statSync(oldBundle.bundle).size, oldBytes, "the old bundle is untouched");
    assert.equal(readFileSync(oldBundle.record, "utf8"), oldRecord, "and so is its record");
    assert.deepEqual(checkWorkPrerequisites(rig.origin.repo, workRoot, "late"), { restorable: false, missing: [c], prerequisites: 1 });
    provisionCell(rig.cellsRoot, { ...late.req, sha: mainTip }, "op-late2", OPTS);
    assert.match(restoreWork(late.paths.spaceDir, workRoot, "late", { expectedHead: mainTip }).reason ?? "", /bundle_unverifiable|fetch_failed/);
    assert.equal(late.record.cellId, "late");
  } finally {
    rig.cleanup();
  }
});

test("work.detached: unlanded commits on no branch restore as a detached HEAD at the same sha", () => {
  const rig = makeRig();
  try {
    const { req, paths, space, workRoot } = provisioned(rig, "d");
    const tip = commitInCell(space, "d.txt", "detached\n", "detached work");
    const record = bundleWork(space, rig.origin.repo, "d", workRoot);
    assert.equal(record.head.branch, null);
    assert.equal(record.work, null, "a clean working tree needs no work commit");
    rmSync(paths.wrapperDir, { recursive: true });
    provisionCell(rig.cellsRoot, req, "op-d2", OPTS);
    assert.equal(restoreWork(space, workRoot, "d", { expectedHead: rig.origin.sha }).verified, true);
    assert.equal(g(space, ["rev-parse", "HEAD"]), tip);
    assert.throws(() => g(space, ["symbolic-ref", "HEAD"]));
    assert.equal(g(space, ["status", "--porcelain"]), "");
  } finally {
    rig.cleanup();
  }
});

test("work.cap: a 2 GiB untracked file is measured by apparent size and named; bundling above the cap refuses and writes nothing", () => {
  const rig = makeRig();
  try {
    const { space, workRoot } = provisioned(rig, "big");
    writeFileSync(join(space, "note.txt"), "small\n");
    const fd = openSync(join(space, "huge.bin"), "w");
    writeSync(fd, Buffer.from("end"), 0, 3, 2 * GIB - 3);
    closeSync(fd);
    const m = measureWork(space, rig.origin.repo);
    assert.equal(m.capturedBytes, 2 * GIB + 6);
    assert.deepEqual(m.largest[0], { path: "huge.bin", bytes: 2 * GIB });
    assert.throws(() => bundleWork(space, rig.origin.repo, "big", workRoot, { maxBytes: GIB }), (err: unknown) => err instanceof WorkError && err.reason === "over_cap");
    assert.equal(existsSync(join(workRoot, "big.bundle")), false);
    assert.equal(existsSync(join(workRoot, "big.json")), false);
    assert.equal(existsSync(join(space, "huge.bin")), true);
  } finally {
    rig.cleanup();
  }
});

test("work.corrupt: a bundle that fails verification is never written and the Cell stays as it was; a bundle corrupted on disk refuses the restore", () => {
  const rig = makeRig();
  try {
    const { req, paths, space, workRoot } = provisioned(rig, "c");
    makeWork(space, rig.origin.sha);
    const before = snapshot(space);
    assert.throws(
      () => bundleWork(space, rig.origin.repo, "c", workRoot, { beforeVerify: (bundle) => truncateSync(bundle, Math.floor(statSync(bundle).size / 2)) }),
      (err: unknown) => err instanceof WorkError && err.stage === "verify" && /index-pack|early EOF/.test(err.message),
      "git bundle verify reads the header only; the throwaway restore is what catches a truncated pack",
    );
    assert.equal(existsSync(join(workRoot, "c.bundle")), false, "nothing durable was written");
    assert.equal(existsSync(join(workRoot, "c.json")), false);
    assert.deepEqual(snapshot(space), before);
    assert.equal(existsSync(join(workRoot, "tmp")), false, "scratch is cleaned up, the empty tmp root with it");

    const record = bundleWork(space, rig.origin.repo, "c", workRoot);
    const { bundle } = workBundlePaths(workRoot, "c");
    truncateSync(bundle, Math.floor(statSync(bundle).size / 2));
    rmSync(paths.wrapperDir, { recursive: true });
    provisionCell(rig.cellsRoot, req, "op-c2", OPTS);
    const fresh = snapshot(space);
    const outcome = restoreWork(space, workRoot, "c", { expectedHead: rig.origin.sha });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.reason ?? "", /^(bundle_unverifiable|fetch_failed)/, "refused before any ref or file is written");
    assert.deepEqual(snapshot(space), fresh, "a refused restore leaves the fresh checkout untouched");
    assert.equal(existsSync(bundle), true, "the bundle is kept for the operator");
    assert.equal(record.cellId, "c");
  } finally {
    rig.cleanup();
  }
});

test("work.crash: a bundle written but never followed by removal is simply replaced by the next capture; both restore", () => {
  const rig = makeRig();
  try {
    const { req, paths, space, workRoot } = provisioned(rig, "k");
    writeFileSync(join(space, "one.txt"), "one\n");
    const first = bundleWork(space, rig.origin.repo, "k", workRoot);
    writeFileSync(join(space, "two.txt"), "two\n");
    const second = bundleWork(space, rig.origin.repo, "k", workRoot);
    assert.notEqual(first.work?.sha, second.work?.sha);
    assert.equal(readWorkRecord(workRoot, "k")?.work?.sha, second.work?.sha, "the record always names the bundle beside it");
    assert.deepEqual(listWorkBundles(workRoot).map((b) => b.cellId), ["k"]);
    rmSync(paths.wrapperDir, { recursive: true });
    provisionCell(rig.cellsRoot, req, "op-k2", OPTS);
    assert.equal(restoreWork(space, workRoot, "k", { expectedHead: rig.origin.sha }).verified, true);
    assert.deepEqual(g(space, ["status", "--porcelain"]).split("\n").sort(), ["?? one.txt", "?? two.txt"]);
  } finally {
    rig.cleanup();
  }
});

test("work.refusals: an operation in progress, a sparse checkout and a leftover-only tree are reported; the restore refuses a checkout that is not fresh", () => {
  const rig = makeRig();
  try {
    const a = provisioned(rig, "a");
    writeFileSync(join(a.space, "real.ts"), "work\n");
    writeFileSync(join(a.space, ".git", "MERGE_HEAD"), `${rig.origin.sha}\n`);
    const merging = measureWork(a.space, rig.origin.repo);
    assert.equal(merging.refusal, "operation_in_progress");
    assert.equal(merging.refusalDetail, "MERGE_HEAD");
    assert.throws(() => bundleWork(a.space, rig.origin.repo, "a", a.workRoot), (err: unknown) => err instanceof WorkError && err.reason === "operation_in_progress");
    rmSync(join(a.space, ".git", "MERGE_HEAD"));
    g(a.space, ["config", "core.sparseCheckout", "true"]);
    assert.equal(measureWork(a.space, rig.origin.repo).refusal, "sparse_checkout");
    g(a.space, ["config", "--unset", "core.sparseCheckout"]);

    mkdirSync(join(a.space, ".audit"));
    writeFileSync(join(a.space, ".audit", "trace.json"), "{}\n");
    const declared = measureWork(a.space, rig.origin.repo, { leftoverPatterns: [".audit"] });
    assert.equal(declared.paths, 1, "a declared leftover is not work");
    assert.equal(measureWork(a.space, rig.origin.repo).paths, 2, "without a declaration it is");
    const record = bundleWork(a.space, rig.origin.repo, "a", a.workRoot, { leftoverPatterns: [".audit"] });
    assert.deepEqual(record.excluded, [".audit"]);

    const b = provisioned(rig, "b");
    writeFileSync(join(b.space, "dirt.txt"), "x\n");
    assert.deepEqual(restoreWork(b.space, a.workRoot, "a", { expectedHead: rig.origin.sha }), { status: "skipped", verified: false, reason: "space_dirty", commits: 0, paths: 0 });
    rmSync(join(b.space, "dirt.txt"));
    assert.equal(restoreWork(b.space, a.workRoot, "a", { expectedHead: "0".repeat(40) }).reason, "head_mismatch");
    assert.equal(restoreWork(b.space, a.workRoot, "nope", {}).reason, "no_bundle");
    const restored = restoreWork(b.space, a.workRoot, "a", { expectedHead: rig.origin.sha });
    assert.equal(restored.verified, true);
    assert.equal(g(b.space, ["status", "--porcelain"]), "?? real.ts");
  } finally {
    rig.cleanup();
  }
});
