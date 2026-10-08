/**
 * Landed-work detection: Cell commits that reached the origin's main under
 * other SHAs no longer block deletion; anything else still does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionCell } from "../src/provision.ts";
import { CellDeleteRefused, deleteCell, dirtyReport } from "../src/remove.ts";
import { commitInCell, commitOn, fingerprintOrigin, g, makeRig } from "./helpers.ts";

function provisioned(rig: ReturnType<typeof makeRig>) {
  return provisionCell(
    rig.cellsRoot,
    { beeId: "bee-1", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
    "cmd-1",
    { disableCow: true },
  );
}

function landInOrigin(origin: string, spaceDir: string, source: string, land: () => void): void {
  g(origin, ["fetch", "--no-tags", spaceDir, `+${source}:refs/scratch/cell`]);
  land();
  g(origin, ["update-ref", "-d", "refs/scratch/cell"]);
  g(origin, ["reflog", "expire", "--expire=now", "--all"]);
  g(origin, ["gc", "--prune=now", "--quiet"]);
}

function originLacks(origin: string, sha: string): boolean {
  try {
    g(origin, ["cat-file", "-e", `${sha}^{commit}`]);
    return false;
  } catch {
    return true;
  }
}

function cherryPick(origin: string, shas: string[]): void {
  for (const sha of shas) g(origin, ["cherry-pick", sha]);
}

test("landed.cherry-pick: commits re-landed on main under new SHAs delete clean", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitOn(rig.origin.repo, "other.ts", "main moved\n", "unrelated main work");
    const a = commitInCell(cell.paths.spaceDir, "a.ts", "a\n", "cell a");
    const b = commitInCell(cell.paths.spaceDir, "b.ts", "b\n", "cell b");
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "HEAD", () => cherryPick(rig.origin.repo, [a, b]));
    assert.ok(originLacks(rig.origin.repo, b), "the Cell SHAs are gone from the origin");

    const before = fingerprintOrigin(rig.origin.repo);
    const report = dirtyReport(cell.paths.wrapperDir);
    assert.equal(report.dirty, false);
    assert.equal(report.unlandedCommitCount, 0);
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), before, "the probe leaves the origin untouched");
    assert.equal(deleteCell(cell.paths.wrapperDir).deleted, true);
  } finally {
    rig.cleanup();
  }
});

test("landed.squash: several Cell commits squashed into one main commit delete clean", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitInCell(cell.paths.spaceDir, "a.ts", "a1\n", "cell a1");
    commitInCell(cell.paths.spaceDir, "a.ts", "a2\n", "cell a2");
    const head = commitInCell(cell.paths.spaceDir, "b.ts", "b\n", "cell b");
    commitOn(rig.origin.repo, "other.ts", "main moved\n", "unrelated main work");
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "HEAD", () => {
      g(rig.origin.repo, ["merge", "--squash", "refs/scratch/cell"]);
      g(rig.origin.repo, ["commit", "-m", "squashed cell work"]);
      commitOn(rig.origin.repo, "later.ts", "later\n", "main keeps moving");
    });
    assert.ok(originLacks(rig.origin.repo, head));

    assert.equal(dirtyReport(cell.paths.wrapperDir).dirty, false);
  } finally {
    rig.cleanup();
  }
});

test("landed.partial: one landed and one unlanded commit refuses and names only the unlanded one", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const landed = commitInCell(cell.paths.spaceDir, "a.ts", "a\n", "cell landed");
    const unlanded = commitInCell(cell.paths.spaceDir, "b.ts", "b\n", "cell unlanded");
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "HEAD", () => cherryPick(rig.origin.repo, [landed]));

    const report = dirtyReport(cell.paths.wrapperDir);
    assert.equal(report.unpushed, true);
    assert.equal(report.unlandedCommitCount, 1);
    assert.deepEqual(report.unlandedCommits, [{ sha: unlanded, subject: "cell unlanded" }]);
    assert.throws(() => deleteCell(cell.paths.wrapperDir), (err: unknown) => {
      assert.ok(err instanceof CellDeleteRefused);
      assert.match(err.message, new RegExp(`1 unlanded commit: ${unlanded.slice(0, 12)} cell unlanded`));
      assert.doesNotMatch(err.message, new RegExp(landed.slice(0, 12)));
      return true;
    });
    assert.ok(existsSync(cell.paths.spaceDir));
  } finally {
    rig.cleanup();
  }
});

test("landed.uncommitted: landed commits plus an uncommitted change still refuse", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const a = commitInCell(cell.paths.spaceDir, "a.ts", "a\n", "cell a");
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "HEAD", () => cherryPick(rig.origin.repo, [a]));
    writeFileSync(join(cell.paths.spaceDir, "untracked.ts"), "wip\n");

    const report = dirtyReport(cell.paths.wrapperDir);
    assert.equal(report.uncommitted, true);
    assert.equal(report.unpushed, false);
    assert.throws(() => deleteCell(cell.paths.wrapperDir), CellDeleteRefused);
  } finally {
    rig.cleanup();
  }
});

test("landed.landed-then-evolved: a cherry-picked commit main later edited still counts (patch-id)", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const a = commitInCell(cell.paths.spaceDir, "src/app.ts", "export const version = 2;\n", "bump version");
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "HEAD", () => cherryPick(rig.origin.repo, [a]));
    commitOn(rig.origin.repo, "src/app.ts", "export const version = 3;\n", "bump again");

    assert.equal(dirtyReport(cell.paths.wrapperDir).dirty, false);
  } finally {
    rig.cleanup();
  }
});

function listCell(rig: ReturnType<typeof makeRig>) {
  writeFileSync(join(rig.origin.repo, "list.txt"), "one\ntwo\nthree\n");
  g(rig.origin.repo, ["add", "-A"]);
  g(rig.origin.repo, ["commit", "-m", "list"]);
  return provisionCell(
    rig.cellsRoot,
    { beeId: "bee-1", originRepo: rig.origin.repo, sha: g(rig.origin.repo, ["rev-parse", "HEAD"]), wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
    "cmd-1",
    { disableCow: true },
  );
}

test("landed.conflict-resolved: a rebase conflict resolved to the Cell's version counts (empty replay)", () => {
  const rig = makeRig();
  try {
    const cell = listCell(rig);
    const head = commitInCell(cell.paths.spaceDir, "list.txt", "one\n2\nthree\n", "cell renames two");
    commitOn(rig.origin.repo, "list.txt", "one\nTWO\nthree\n", "main renames two");
    commitOn(rig.origin.repo, "list.txt", "one\n2\nthree\n", "land cell renames two (conflict resolved)");
    assert.ok(originLacks(rig.origin.repo, head));

    assert.equal(dirtyReport(cell.paths.wrapperDir).dirty, false);
  } finally {
    rig.cleanup();
  }
});

test("landed.combined-resolution: a conflict resolved by combining both sides stays refused (fail closed)", () => {
  const rig = makeRig();
  try {
    const cell = listCell(rig);
    const head = commitInCell(cell.paths.spaceDir, "list.txt", "one\ntwo\nthree\ncell\n", "cell appends");
    commitOn(rig.origin.repo, "list.txt", "one\ntwo\nthree\nmain\n", "main appends");
    commitOn(rig.origin.repo, "list.txt", "one\ntwo\nthree\nmain\ncell\n", "land cell appends (both kept)");

    assert.deepEqual(dirtyReport(cell.paths.wrapperDir).unlandedCommits.map((c) => c.sha), [head]);
  } finally {
    rig.cleanup();
  }
});

test("landed.receipt: a landing receipt whose result is on main clears the Cell head", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const head = commitInCell(cell.paths.spaceDir, "src/app.ts", "export const version = 2;\n", "cell work");
    commitOn(rig.origin.repo, "src/app.ts", "export const version = 7;\n", "main rewrote the same line");
    assert.equal(dirtyReport(cell.paths.wrapperDir).dirty, true, "no content evidence without the receipt");

    const resultSha = g(rig.origin.repo, ["rev-parse", "HEAD"]);
    assert.equal(dirtyReport(cell.paths.wrapperDir, { receipts: [{ cellHead: head, resultSha, targetBranch: "main" }] }).dirty, false);
    const elsewhere = commitOn(rig.origin.repo, "x.ts", "x\n", "x");
    g(rig.origin.repo, ["reset", "--hard", "HEAD~2"]);
    assert.equal(
      dirtyReport(cell.paths.wrapperDir, { receipts: [{ cellHead: head, resultSha: elsewhere, targetBranch: "main" }] }).dirty,
      true,
      "a receipt whose result left main proves nothing",
    );
  } finally {
    rig.cleanup();
  }
});

test("landed.not-landed: a conflicting change on main keeps the Cell commit unlanded", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    const head = commitInCell(cell.paths.spaceDir, "src/app.ts", "export const version = 2;\n", "cell bump");
    commitOn(rig.origin.repo, "src/app.ts", "export const version = 9;\n", "main bump");
    const report = dirtyReport(cell.paths.wrapperDir);
    assert.equal(report.unpushed, true);
    assert.deepEqual(report.unlandedCommits.map((c) => c.sha), [head]);
  } finally {
    rig.cleanup();
  }
});

test("landed.ancestor: work merged into main the ordinary way deletes clean", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitInCell(cell.paths.spaceDir, "a.ts", "a\n", "cell a");
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "HEAD", () => g(rig.origin.repo, ["merge", "--ff-only", "refs/scratch/cell"]));
    assert.equal(dirtyReport(cell.paths.wrapperDir).dirty, false);
    assert.equal(deleteCell(cell.paths.wrapperDir).deleted, true);
  } finally {
    rig.cleanup();
  }
});

test("landed.side-branch: an unlanded side branch is named; a landed one is not", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    g(cell.paths.spaceDir, ["switch", "-c", "landed-side"]);
    const a = commitInCell(cell.paths.spaceDir, "a.ts", "a\n", "landed side");
    g(cell.paths.spaceDir, ["switch", "--detach", rig.origin.sha]);
    g(cell.paths.spaceDir, ["switch", "-c", "open-side"]);
    commitInCell(cell.paths.spaceDir, "b.ts", "b\n", "open side");
    g(cell.paths.spaceDir, ["switch", "--detach", rig.origin.sha]);
    landInOrigin(rig.origin.repo, cell.paths.spaceDir, "refs/heads/landed-side", () => cherryPick(rig.origin.repo, [a]));

    const report = dirtyReport(cell.paths.wrapperDir);
    assert.deepEqual(report.unlandedBranches, ["open-side"]);
    assert.deepEqual(report.unlandedCommits.map((c) => c.subject), ["open side"]);
  } finally {
    rig.cleanup();
  }
});

test("landed.no-writes: probing writes nothing into the Cell's object store", () => {
  const rig = makeRig();
  try {
    const cell = provisioned(rig);
    commitInCell(cell.paths.spaceDir, "src/app.ts", "export const version = 2;\n", "cell bump");
    commitOn(rig.origin.repo, "other.ts", "o\n", "main moves");
    const objects = join(cell.paths.spaceDir, ".git", "objects");
    const before = readdirSync(objects).sort();
    dirtyReport(cell.paths.wrapperDir);
    assert.deepEqual(readdirSync(objects).sort(), before);
  } finally {
    rig.cleanup();
  }
});
