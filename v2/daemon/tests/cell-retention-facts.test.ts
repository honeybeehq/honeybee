/**
 * What a hold is made of, and when a remembered hold is re-judged: declared
 * agent leftovers never hold a Cell (undeclared ones do, as before); a Cell whose HEAD is landed by content is not
 * unlanded; a Cell judged unlanded is re-inspected when the origin's main
 * moves, not before; the plan carries the working-tree facts and the hold
 * breakdown so `hive cell gc` can say why. Deterministic clock; no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { cellPaths } from "../../driver-cell/src/layout.ts";
import { provisionCell } from "../../driver-cell/src/provision.ts";
import { commitInCell, commitOn, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { CellRetentionService, holdBreakdownOf } from "../src/cellRetention.ts";
import { defaultCellRetention, type ResolvedCellRetention } from "../src/config.ts";
import { cellGcHoldLines } from "../../cli/src/main.ts";

const DAY = 24 * 3_600_000;
const GIB = 1024 ** 3;

type Shape = "leftovers" | "untracked" | "modified" | "unlanded_head" | "unlanded_branch" | "landed_rebased";

function rig(policy: Partial<ResolvedCellRetention> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-facts-"));
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const origin = makeOrigin(root);
  const base = 1_800_000_000_000;
  let now = base - 10 * DAY;
  const store = openCoreStore(join(root, "core.sqlite3"), { ephemeral: true, now: () => now });
  const logs: string[] = [];
  const cells = new Map<Shape, { beeId: string; cellId: string; spaceDir: string }>();
  for (const [index, shape] of (["leftovers", "untracked", "modified", "unlanded_head", "unlanded_branch", "landed_rebased"] as Shape[]).entries()) {
    const id = `c${index}`;
    const req = { beeId: `bee-${id}`, originRepo: origin.repo, sha: origin.sha, wrapper: `w-${id}`, repoName: "repo", cellId: id };
    provisionCell(cellsRoot, req, `op-${id}`, { disableCow: true, useGitImages: false });
    const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
    const { bee, runtime } = store.createBee({ id: req.beeId, name: shape, agent: "stub", substrate: "cell", cwd: paths.spaceDir });
    const cell = store.putCell({ sourceBeeId: bee.id, originRepo: origin.repo, sha: origin.sha, wrapper: req.wrapper, spaceName: `repo-space-${id}`, spaceDir: paths.spaceDir, gitCommonDirRealpath: join(origin.repo, ".git"), objectFormat: "sha1" });
    store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    store.archiveBee(bee.id);
    const space = paths.spaceDir;
    if (shape === "leftovers") {
      mkdirSync(join(space, ".audit", "run"), { recursive: true });
      writeFileSync(join(space, ".audit", "run", "trace.json"), "{}\n");
      mkdirSync(join(space, ".proof"), { recursive: true });
      writeFileSync(join(space, ".proof", "shot.png"), "png\n");
    }
    if (shape === "untracked") writeFileSync(join(space, "notes.md"), "draft\n");
    if (shape === "modified") writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");
    if (shape === "unlanded_head") commitInCell(space, `${id}.ts`, "head work\n", `${id} head work`);
    if (shape === "unlanded_branch") {
      g(space, ["checkout", "-q", "-b", "save/v1"]);
      commitInCell(space, `${id}.ts`, "branch work\n", `${id} branch work`);
      g(space, ["checkout", "-q", "--detach", origin.sha]);
    }
    if (shape === "landed_rebased") {
      const sha = commitInCell(space, `${id}.ts`, "landed work\n", `${id} landed work`);
      g(origin.repo, ["fetch", "--no-tags", "-q", space, `+${sha}:refs/scratch/cell`]);
      g(origin.repo, ["cherry-pick", sha]);
      g(origin.repo, ["update-ref", "-d", "refs/scratch/cell"]);
    }
    cells.set(shape, { beeId: bee.id, cellId: cell.id, spaceDir: space });
  }
  now = base;
  const service = new CellRetentionService({
    cellsRoot,
    policy: { ...defaultCellRetention("workstation"), workBundle: false, ...policy },
    store: () => store,
    now: () => now,
    log: (op) => logs.push(op),
    cellInUse: (_beeId, runtime) => runtime != null && runtime.state !== "stopped",
    opInFlight: () => false,
    forgetCell: () => undefined,
    statfs: () => ({ totalBytes: 100 * GIB, freeBytes: 90 * GIB }),
    loadJudgments: () => store.cellRetentionJudgments(),
    saveJudgments: (encoded) => store.putCellRetentionJudgments(encoded),
  });
  const pass = async () => {
    const from = logs.length;
    const result = await service.run({ dryRun: true, kind: "scheduled" });
    const line = logs.slice(from).find((l) => l.startsWith("cell.retention.plan"))!;
    return { result, line, inspected: Number(/inspected=(\d+)/.exec(line)![1]) };
  };
  const item = (result: Awaited<ReturnType<typeof pass>>["result"], shape: Shape) => result.items.find((i) => i.beeId === cells.get(shape)!.beeId)!;
  return { service, store, origin, cells, pass, item, logs, advance: (ms: number) => { now += ms; }, cleanup: async () => { await service.stop(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("facts: declared leftovers never hold, landed-by-content is not unlanded, and the plan says what each hold is made of", { timeout: 120_000 }, async () => {
  const r = rig({ leftoverPatterns: [".audit", ".proof"] });
  try {
    const first = await r.pass();
    assert.deepEqual(
      (["leftovers", "untracked", "modified", "unlanded_head", "unlanded_branch", "landed_rebased"] as Shape[]).map((s) => [s, r.item(first.result, s).verdict, r.item(first.result, s).reason]),
      [
        ["leftovers", "evict", "archived_age"],
        ["untracked", "hold", "dirty_uncommitted"],
        ["modified", "hold", "dirty_uncommitted"],
        ["unlanded_head", "hold", "dirty_unlanded"],
        ["unlanded_branch", "hold", "dirty_unlanded"],
        ["landed_rebased", "evict", "archived_age"],
      ],
    );
    assert.deepEqual(r.item(first.result, "leftovers").workingTree, { modifiedFiles: 0, untrackedFiles: 0, leftoverPaths: [".audit/", ".proof/"] });
    assert.deepEqual(r.item(first.result, "untracked").workingTree, { modifiedFiles: 0, untrackedFiles: 1, leftoverPaths: [] });
    assert.equal(r.item(first.result, "modified").workingTree?.modifiedFiles, 1);
    assert.equal(r.item(first.result, "unlanded_head").headUnlanded, true);
    assert.equal(r.item(first.result, "unlanded_branch").headUnlanded, false);
    assert.deepEqual(r.item(first.result, "unlanded_branch").report?.unlandedBranches, ["save/v1"]);
    assert.deepEqual(holdBreakdownOf(first.result.items), { modified: 1, untrackedOnly: 1, unlandedHead: 1, unlandedBranchesOnly: 1, unlandedCommits: 2, leftoverOnly: 1 });
    assert.match(first.line, / held_modified=1 held_untracked_only=1 held_unlanded_head=1 held_unlanded_branches_only=1 unlanded_commits=2 leftover_only=1/);
    const lines = cellGcHoldLines(first.result);
    assert.match(lines[0]!, /^why held: uncommitted 2 Cells \(tracked files modified in 1, untracked files only in 1\) · unlanded 2 Cells \(HEAD unlanded in 1, only side branches in 1; 2 commits on no branch of the origin\) · set cellRetention\.evictionRequiresWip/);
    assert.match(lines[1]!, /^leftovers ignored: 1 Cells hold only agent leftovers and count as clean \(\.audit\/×1 \.proof\/×1\)$/);
  } finally {
    await r.cleanup();
  }
});

test("facts: with no declared leftovers an untracked .audit/ holds the Cell exactly as before", { timeout: 120_000 }, async () => {
  const r = rig();
  try {
    const first = await r.pass();
    assert.deepEqual([r.item(first.result, "leftovers").verdict, r.item(first.result, "leftovers").reason], ["hold", "dirty_uncommitted"]);
    assert.deepEqual(r.item(first.result, "leftovers").workingTree, { modifiedFiles: 0, untrackedFiles: 2, leftoverPaths: [] });
    assert.equal(holdBreakdownOf(first.result.items).leftoverOnly, 0);
    assert.equal(cellGcHoldLines(first.result).length, 1, "no leftovers line when nothing is declared");
  } finally {
    await r.cleanup();
  }
});

test("facts: an unlanded hold is remembered until the origin's main moves or the Cell does; landing the work releases it", { timeout: 120_000 }, async () => {
  const r = rig({ leftoverPatterns: [".audit", ".proof"] });
  try {
    const first = await r.pass();
    assert.equal(first.inspected, 6);
    const second = await r.pass();
    assert.equal(second.inspected, 2, "only the two evictable Cells are inspected again; every hold is remembered, unlanded ones included");
    assert.equal(r.item(second.result, "unlanded_head").reason, "dirty_unlanded");

    const unlanded = r.cells.get("unlanded_head")!;
    const sha = g(unlanded.spaceDir, ["rev-parse", "HEAD"]);
    g(r.origin.repo, ["fetch", "--no-tags", "-q", unlanded.spaceDir, `+${sha}:refs/scratch/cell`]);
    g(r.origin.repo, ["cherry-pick", sha]);
    g(r.origin.repo, ["update-ref", "-d", "refs/scratch/cell"]);
    const landed = await r.pass();
    assert.equal(landed.inspected, 4, "main moved: every unlanded hold is re-judged, the uncommitted ones are not");
    assert.equal(r.item(landed.result, "unlanded_head").verdict, "evict");
    assert.equal(r.item(landed.result, "unlanded_head").reason, "archived_age");
    assert.equal(r.item(landed.result, "unlanded_branch").reason, "dirty_unlanded", "the side branch still holds its own work");

    commitOn(r.origin.repo, "other.ts", "unrelated\n", "main keeps moving");
    const moved = await r.pass();
    assert.equal(moved.inspected, 4, "main moved again: the branch hold is re-judged");
    assert.equal((await r.pass()).inspected, 3, "and settles again when nothing moved");

    const branchCell = r.cells.get("unlanded_branch")!;
    await new Promise((done) => setTimeout(done, 20));
    g(branchCell.spaceDir, ["branch", "-D", "save/v1"]);
    const dropped = await r.pass();
    assert.equal(r.item(dropped.result, "unlanded_branch").verdict, "evict", "deleting the branch in the Cell moves its fingerprint and clears the hold");
  } finally {
    await r.cleanup();
  }
});

test("facts: with work bundling on, a stash and side branches are work the bundle carries: the Cell is planned, and the plan no longer points at evictionRequiresWip", { timeout: 120_000 }, async () => {
  const r = rig({ workBundle: true, leftoverPatterns: [".audit", ".proof"] });
  try {
    const branchy = r.cells.get("unlanded_branch")!;
    writeFileSync(join(branchy.spaceDir, "src", "app.ts"), "export const version = 9;\n");
    g(branchy.spaceDir, ["stash", "push", "-q", "-m", "parked"]);
    const first = await r.pass();
    for (const shape of ["untracked", "modified", "unlanded_head", "unlanded_branch", "landed_rebased"] as Shape[]) {
      assert.deepEqual([shape, r.item(first.result, shape).verdict, r.item(first.result, shape).reason], [shape, "evict", "archived_age"]);
    }
    const planned = r.item(first.result, "unlanded_branch");
    assert.equal(planned.report?.stashed, true);
    assert.deepEqual(planned.report?.unlandedBranches, ["save/v1"]);
    assert.deepEqual({ commits: planned.work?.commits, stashes: planned.work?.stashes, bundled: planned.work?.bundled }, { commits: 1, stashes: 1, bundled: true });
    assert.equal(first.result.totals.workCells, 4);
    const lines = cellGcHoldLines(first.result).join("\n");
    assert.doesNotMatch(lines, /evictionRequiresWip/);
    assert.match(lines, /work bundling is on: work never holds a Cell/);
    assert.equal(first.result.items.filter((i) => i.reason.startsWith("dirty_")).length, 0, "no dirty hold remains when bundling is on");
  } finally {
    await r.cleanup();
  }
});
