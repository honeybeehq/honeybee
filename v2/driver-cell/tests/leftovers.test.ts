/**
 * Agent leftovers are whatever `leftoverPatterns` declares, nothing by
 * default: declared ones do not make a Cell dirty, stay out of a WIP
 * snapshot and are deleted on eviction instead of kept; undeclared untracked
 * files are work and undeclared ignored files are kept, as before. The cheap
 * Cell fingerprint moves when the Cell does and holds still when only an
 * inspection ran. A side branch the agent switched away from is saved beside
 * the WIP and comes back on revive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionCell } from "../src/provision.ts";
import { dirtyReportDetailed, dirtyCauses } from "../src/remove.ts";
import { cellFingerprint, cellKeepRootForCells, classifyIgnored, evictCellWrapper, inspectCellWrapper, listPendingKeeps } from "../src/retention.ts";
import { DEFAULT_LEFTOVER_PATTERNS, isLeftoverPath, matchesLeftoverPattern, partitionLeftovers } from "../src/leftovers.ts";
import { dropWipRef, listWipBranches, pushWip, restoreWipBranches, snapshotWip, sweepWipRefs, wipBranchRefPrefix, wipRefFor } from "../src/wip.ts";
import { commitInCell, commitOn, g, makeRig } from "./helpers.ts";

const NODE = "node-a";
const DECLARED = [".audit", ".proof", "*.log", ".review-*", ".*-evidence"];

function provisioned(rig: ReturnType<typeof makeRig>, id = "c1") {
  const req = { beeId: `bee-${id}`, originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: `bee-${id}`, repoName: "fixture", cellId: id };
  return { req, cell: provisionCell(rig.cellsRoot, req, `cmd-${id}`, { disableCow: true, useGitImages: false }) };
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test("leftovers.patterns: nothing is a leftover by default; declared names match literally or by a single glob, nested paths by their first component", () => {
  assert.deepEqual(DEFAULT_LEFTOVER_PATTERNS, []);
  assert.equal(matchesLeftoverPattern(".audit"), false, "an undeclared name is work");
  assert.equal(isLeftoverPath(".audit/"), false);
  assert.equal(matchesLeftoverPattern(".audit", DECLARED), true);
  assert.equal(matchesLeftoverPattern(".review-f35", DECLARED), true);
  assert.equal(matchesLeftoverPattern(".t10-evidence", DECLARED), true);
  assert.equal(matchesLeftoverPattern("server.log", DECLARED), true);
  assert.equal(matchesLeftoverPattern(".audits", DECLARED), false);
  assert.equal(matchesLeftoverPattern("src", DECLARED), false);
  assert.equal(isLeftoverPath(".audit/", DECLARED), true);
  assert.equal(isLeftoverPath(".audit/run-1/trace.json", DECLARED), true);
  assert.equal(isLeftoverPath("apps/web/server.log", DECLARED), false, "a nested log is not a top-level leftover");
  assert.equal(isLeftoverPath("notes.md", DECLARED), false);
  assert.deepEqual(partitionLeftovers([".proof/", "notes.md", ".cache/x"], [".proof", ".cache"]), { leftovers: [".proof/", ".cache/x"], kept: ["notes.md"] });
  assert.deepEqual(partitionLeftovers([".proof/", "notes.md"]), { leftovers: [], kept: [".proof/", "notes.md"] });
});

test("leftovers.dirty: declared untracked leftovers do not make a Cell dirty; undeclared ones, untracked work and tracked edits do, and the counts say which", () => {
  const rig = makeRig();
  try {
    const { cell } = provisioned(rig);
    const space = cell.paths.spaceDir;
    mkdirSync(join(space, ".audit", "run-1"), { recursive: true });
    writeFileSync(join(space, ".audit", "run-1", "trace.json"), "{}\n");
    mkdirSync(join(space, ".proof"), { recursive: true });
    writeFileSync(join(space, ".proof", "shot.png"), "png\n");
    writeFileSync(join(space, "hive.log"), "log\n");

    const undeclared = dirtyReportDetailed(cell.paths.wrapperDir);
    assert.equal(undeclared.report.uncommitted, true, "by default every untracked entry is work");
    assert.deepEqual(undeclared.workingTree, { modifiedFiles: 0, untrackedFiles: 3, leftoverPaths: [] });

    const clean = dirtyReportDetailed(cell.paths.wrapperDir, { leftoverPatterns: DECLARED });
    assert.equal(clean.report.dirty, false);
    assert.equal(clean.report.uncommitted, false);
    assert.deepEqual(clean.workingTree, { modifiedFiles: 0, untrackedFiles: 0, leftoverPaths: [".audit/", ".proof/", "hive.log"] });
    assert.equal(clean.headUnlanded, false);

    writeFileSync(join(space, "notes.md"), "draft\n");
    const untracked = dirtyReportDetailed(cell.paths.wrapperDir, { leftoverPatterns: DECLARED });
    assert.equal(untracked.report.uncommitted, true);
    assert.deepEqual(untracked.workingTree, { modifiedFiles: 0, untrackedFiles: 1, leftoverPaths: [".audit/", ".proof/", "hive.log"] });
    assert.deepEqual(dirtyCauses(untracked.report, untracked.workingTree), ["uncommitted changes (1 untracked)"]);

    unlinkSync(join(space, "notes.md"));
    writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");
    const modified = dirtyReportDetailed(cell.paths.wrapperDir, { leftoverPatterns: DECLARED });
    assert.equal(modified.report.uncommitted, true);
    assert.equal(modified.workingTree.modifiedFiles, 1);
    assert.deepEqual(dirtyCauses(modified.report, modified.workingTree), ["uncommitted changes (1 modified)"]);

    const narrower = dirtyReportDetailed(cell.paths.wrapperDir, { leftoverPatterns: [".proof"] });
    assert.deepEqual(narrower.workingTree.leftoverPaths, [".proof/"]);
    assert.equal(narrower.workingTree.untrackedFiles, 2, "with a narrower list .audit and the log count as work");
  } finally {
    rig.cleanup();
  }
});

test("leftovers.evict: declared ignored leftovers are deleted with the Cell; undeclared ignored files go to cell-keep as before", () => {
  const rig = makeRig();
  try {
    writeFileSync(join(rig.origin.repo, ".gitignore"), ".proof/\ndata/\n");
    rig.origin.sha = commitOn(rig.origin.repo, ".gitignore", ".proof/\ndata/\n", "ignores");
    const { cell } = provisioned(rig);
    const space = cell.paths.spaceDir;
    mkdirSync(join(space, ".proof"), { recursive: true });
    writeFileSync(join(space, ".proof", "shot.png"), "png\n");
    mkdirSync(join(space, "data"), { recursive: true });
    writeFileSync(join(space, "data", "seed.db"), "db\n");

    const byDefault = classifyIgnored(space);
    assert.deepEqual(byDefault.disposable, []);
    assert.deepEqual(byDefault.keep, [".proof", "data"], "nothing is disposable until declared");
    const ignored = classifyIgnored(space, undefined, DECLARED);
    assert.deepEqual(ignored.disposable, [".proof"]);
    assert.deepEqual(ignored.keep, ["data"]);
    const inspection = inspectCellWrapper(cell.paths.wrapperDir, { measure: false, leftoverPatterns: DECLARED });
    assert.deepEqual(inspection.keep.map((e) => e.path), ["data"]);
    assert.deepEqual(inspection.disposable.map((e) => e.path), [".proof"]);

    const res = evictCellWrapper(rig.cellsRoot, cell.paths.wrapperDir, { expectedHead: rig.origin.sha, leftoverPatterns: DECLARED });
    assert.ok(res);
    assert.deepEqual(res.keptPaths, ["data"]);
    assert.equal(existsSync(join(res.parkedDir, cell.paths.spaceName, ".proof", "shot.png")), true, "the leftover goes with the parked wrapper");
    assert.equal(existsSync(join(cellKeepRootForCells(rig.cellsRoot), cell.paths.spaceName, ".proof")), false);
    assert.deepEqual(listPendingKeeps(rig.cellsRoot), [cell.paths.spaceName]);
  } finally {
    rig.cleanup();
  }
});

test("leftovers.wip: a WIP snapshot leaves declared leftovers out and keeps the rest of the working tree", () => {
  const rig = makeRig();
  try {
    const { cell } = provisioned(rig);
    const space = cell.paths.spaceDir;
    mkdirSync(join(space, ".audit"), { recursive: true });
    writeFileSync(join(space, ".audit", "trace.json"), "{}\n");
    writeFileSync(join(space, "notes.md"), "draft\n");
    writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");
    const everything = snapshotWip(space, join(cell.paths.wrapperDir, "box"), "c1");
    assert.ok(g(space, ["ls-tree", "-r", "--name-only", everything.tree]).split("\n").includes(".audit/trace.json"), "by default every untracked file is WIP");
    const snap = snapshotWip(space, join(cell.paths.wrapperDir, "box"), "c1", Date.now, undefined, DECLARED);
    assert.equal(snap.dirty, true);
    const files = g(space, ["ls-tree", "-r", "--name-only", snap.tree]).split("\n");
    assert.ok(files.includes("notes.md"));
    assert.ok(files.includes("src/app.ts"));
    assert.ok(!files.some((f) => f.startsWith(".audit/")), "declared leftovers are not WIP");

    const onlyLeftovers = snapshotWip(space, join(cell.paths.wrapperDir, "box"), "c1", Date.now, undefined, [".audit", "notes.md", "src"]);
    assert.equal(onlyLeftovers.dirty, true, "a tracked edit is never a leftover");
  } finally {
    rig.cleanup();
  }
});

test("leftovers.fingerprint: the fingerprint moves on a commit or a top-level change and holds still across an inspection", () => {
  const rig = makeRig();
  try {
    const { cell } = provisioned(rig);
    const space = cell.paths.spaceDir;
    const first = cellFingerprint(space);
    assert.ok(first);
    inspectCellWrapper(cell.paths.wrapperDir, { measure: false });
    dirtyReportDetailed(cell.paths.wrapperDir);
    assert.equal(cellFingerprint(space), first, "an inspection writes nothing the fingerprint sees");

    sleepMs(20);
    writeFileSync(join(space, "wip.txt"), "x\n");
    const added = cellFingerprint(space);
    assert.notEqual(added, first, "a new top-level entry moves the space mtime");
    sleepMs(20);
    unlinkSync(join(space, "wip.txt"));
    assert.notEqual(cellFingerprint(space), added);

    sleepMs(20);
    commitInCell(space, "src/app.ts", "export const version = 3;\n", "cell work");
    const committed = cellFingerprint(space);
    assert.notEqual(committed, added, "a commit moves the index and the HEAD reflog");
    assert.equal(cellFingerprint(join(rig.root, "nowhere")), null);
  } finally {
    rig.cleanup();
  }
});

test("leftovers.branches: a side branch the agent switched away from is unlanded without HEAD being so, is pushed beside the WIP, swept with the Cell and restored on revive", () => {
  const rig = makeRig();
  try {
    const { req, cell } = provisioned(rig);
    const space = cell.paths.spaceDir;
    g(space, ["checkout", "-q", "-b", "save/v1"]);
    const saved = commitInCell(space, "a.ts", "a\n", "savepoint");
    g(space, ["checkout", "-q", "--detach", rig.origin.sha]);

    const detailed = dirtyReportDetailed(cell.paths.wrapperDir);
    assert.equal(detailed.report.unpushed, true);
    assert.deepEqual(detailed.report.unlandedBranches, ["save/v1"]);
    assert.equal(detailed.headUnlanded, false, "HEAD sits on the origin; only the branch holds work");

    const snap = snapshotWip(space, join(cell.paths.wrapperDir, "box"), "c1");
    pushWip(rig.origin.repo, space, NODE, "c1", snap.sha);
    assert.equal(g(rig.origin.repo, ["rev-parse", wipRefFor(NODE, "c1")]), snap.sha);
    assert.deepEqual(listWipBranches(rig.origin.repo, NODE, "c1"), [{ name: "save/v1", sha: saved }]);
    assert.equal(g(rig.origin.repo, ["rev-parse", `${wipBranchRefPrefix(NODE, "c1")}/save/v1`]), saved);

    g(space, ["branch", "-D", "save/v1"]);
    pushWip(rig.origin.repo, space, NODE, "c1", snap.sha);
    assert.deepEqual(listWipBranches(rig.origin.repo, NODE, "c1"), [], "a branch deleted in the Cell leaves the save on the next push");
    g(space, ["branch", "save/v1", saved]);
    pushWip(rig.origin.repo, space, NODE, "c1", snap.sha);

    rmSync(cell.paths.wrapperDir, { recursive: true, force: true });
    const revived = provisionCell(rig.cellsRoot, req, "cmd-revive", { disableCow: true, useGitImages: false });
    assert.equal(g(revived.paths.spaceDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").includes("save/v1"), false);
    assert.deepEqual(restoreWipBranches(revived.paths.spaceDir, rig.origin.repo, NODE, "c1"), ["save/v1"]);
    assert.equal(g(revived.paths.spaceDir, ["rev-parse", "save/v1"]), saved);
    assert.deepEqual(restoreWipBranches(revived.paths.spaceDir, rig.origin.repo, NODE, "c1"), [], "an existing branch is left alone");
    assert.equal(readFileSync(join(revived.paths.spaceDir, "src", "app.ts"), "utf8").length > 0, true);

    const swept = sweepWipRefs(rig.origin.repo, [NODE], new Set(["other"]), new Set(["c1", "other"]));
    assert.ok(swept.dropped.includes(`${wipBranchRefPrefix(NODE, "c1")}/save/v1`), "a dead Cell's saved branches are swept");
    assert.ok(swept.dropped.includes(wipRefFor(NODE, "c1")));

    pushWip(rig.origin.repo, revived.paths.spaceDir, NODE, "c1", snap.sha);
    assert.equal(listWipBranches(rig.origin.repo, NODE, "c1").length, 1);
    assert.equal(dropWipRef(rig.origin.repo, NODE, "c1"), true);
    assert.deepEqual(listWipBranches(rig.origin.repo, NODE, "c1"), [], "dropping the WIP drops the saved branches too");
  } finally {
    rig.cleanup();
  }
});
