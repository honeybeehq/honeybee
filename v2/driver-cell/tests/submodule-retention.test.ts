/**
 * P7b: a Cell's submodules can hold work the superproject status never shows
 * with --ignore-submodules=all. A populated submodule with any local state
 * makes the Cell dirty (reported as uncommitted, paths in the refusal), and a
 * park whose registry write fails is undone in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provisionCell } from "../src/provision.ts";
import { CellDeleteRefused, dirtyReport, dirtyReportDetailed } from "../src/remove.ts";
import { cellEnvRootForCells, cellKeepRootForCells, evictCellWrapper, unparkCellWrapper } from "../src/retention.ts";
import { commitInCell, commitOn, g, makeOrigin, makeRig } from "./helpers.ts";

const allowFile = ["-c", "protocol.file.allow=always"];

function withSubmodule() {
  const rig = makeRig();
  const lib = makeOrigin(rig.root, "lib");
  g(rig.origin.repo, [...allowFile, "submodule", "add", "-q", lib.repo, "vendor/lib"]);
  g(rig.origin.repo, ["commit", "-q", "-m", "add submodule"]);
  const sha = g(rig.origin.repo, ["rev-parse", "HEAD"]);
  const cell = provisionCell(
    rig.cellsRoot,
    { beeId: "bee-1", originRepo: rig.origin.repo, sha, wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
    "cmd-1",
    { disableCow: true },
  );
  g(cell.paths.spaceDir, [...allowFile, "submodule", "update", "--init", "-q"]);
  const sub = join(cell.paths.spaceDir, "vendor", "lib");
  g(sub, ["config", "user.name", "bee"]);
  g(sub, ["config", "user.email", "bee@hive.invalid"]);
  return { rig, lib, cell, sub };
}

test("submodule.clean: a populated submodule at its recorded commit with nothing local keeps the Cell clean, and so does an unpopulated one", () => {
  const { rig, cell, sub } = withSubmodule();
  try {
    const { report, dirtySubmodules } = dirtyReportDetailed(cell.paths.wrapperDir);
    assert.deepEqual(dirtySubmodules, []);
    assert.equal(report.dirty, false);
    g(cell.paths.spaceDir, ["submodule", "deinit", "-q", "-f", "vendor/lib"]);
    assert.equal(existsSync(join(sub, ".git")), false);
    assert.deepEqual(dirtyReportDetailed(cell.paths.wrapperDir).dirtySubmodules, [], "an empty, unpopulated submodule holds nothing");
  } finally {
    rig.cleanup();
  }
});

test("submodule.dirty: edits, untracked or ignored files, a stash, unpushed commits and a moved pointer each hold the Cell", () => {
  const cases: Array<[string, (sub: string, space: string) => void]> = [
    ["edited", (sub) => writeFileSync(join(sub, "README.md"), "edited\n")],
    ["untracked", (sub) => writeFileSync(join(sub, "notes.txt"), "mine\n")],
    ["ignored", (sub) => {
      writeFileSync(g(sub, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]), "secret.env\n");
      writeFileSync(join(sub, "secret.env"), "TOKEN=1\n");
    }],
    ["stashed", (sub) => {
      writeFileSync(join(sub, "README.md"), "stash me\n");
      g(sub, ["stash", "-q"]);
    }],
    ["unpushed-and-recorded", (sub, space) => {
      commitInCell(sub, "lib.ts", "local only\n", "submodule work nobody pushed");
      g(space, ["add", "vendor/lib"]);
      g(space, ["commit", "-q", "-m", "bump submodule"]);
    }],
    ["de-submoduled", (sub) => {
      rmSync(join(sub, ".git"), { recursive: true, force: true });
      writeFileSync(join(sub, "edited-in-place.ts"), "vendored edit\n");
    }],
    ["moved-pointer", (sub) => {
      commitInCell(sub, "lib.ts", "moved\n", "moved");
      g(sub, ["update-ref", "refs/remotes/origin/moved", "HEAD"]);
    }],
  ];
  for (const [name, mutate] of cases) {
    const { rig, cell, sub } = withSubmodule();
    try {
      mutate(sub, cell.paths.spaceDir);
      const { report, dirtySubmodules } = dirtyReportDetailed(cell.paths.wrapperDir);
      assert.deepEqual(dirtySubmodules, ["vendor/lib"], name);
      assert.equal(report.dirty, true, name);
      assert.equal(report.uncommitted, true, `${name}: reported as uncommitted, no new report key`);
      assert.deepEqual(Object.keys(dirtyReport(cell.paths.wrapperDir)).sort(), ["dirty", "originUnknown", "stashed", "uncommitted", "unlandedBranches", "unlandedCommitCount", "unlandedCommits", "unpushed"], name);
      assert.throws(() => evictCellWrapper(rig.cellsRoot, cell.paths.wrapperDir), (err: unknown) => err instanceof CellDeleteRefused && /submodules with local state: vendor\/lib/.test(err.message), name);
      assert.equal(existsSync(cell.paths.spaceDir), true, `${name}: nothing was parked`);
    } finally {
      rig.cleanup();
    }
  }
});

test("unpark: a park whose registry write failed goes back in place with its kept paths, and its env copies are dropped", () => {
  const rig = makeRig();
  try {
    writeFileSync(join(rig.origin.repo, ".gitignore"), ".proof/\n.env\n");
    g(rig.origin.repo, ["add", ".gitignore"]);
    const sha = commitOn(rig.origin.repo, ".gitignore", ".proof/\n.env\n", "ignores");
    const cell = provisionCell(
      rig.cellsRoot,
      { beeId: "bee-1", originRepo: rig.origin.repo, sha, wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
      "cmd-1",
      { disableCow: true },
    );
    mkdirSync(join(cell.paths.spaceDir, ".proof"), { recursive: true });
    writeFileSync(join(cell.paths.spaceDir, ".proof", "shot.png"), "evidence\n");
    writeFileSync(join(cell.paths.spaceDir, ".env"), "SECRET=1\n");
    const parked = evictCellWrapper(rig.cellsRoot, cell.paths.wrapperDir)!;
    assert.equal(existsSync(cell.paths.wrapperDir), false);
    assert.deepEqual(parked.keptPaths, [".proof"]);
    assert.deepEqual(parked.envFiles, [".env"]);

    const undone = unparkCellWrapper(rig.cellsRoot, cell.paths.wrapperDir, parked);
    assert.deepEqual(undone.keptConflicts, []);
    assert.equal(readFileSync(join(cell.paths.spaceDir, ".proof", "shot.png"), "utf8"), "evidence\n");
    assert.equal(readFileSync(join(cell.paths.spaceDir, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(existsSync(parked.parkedDir), false);
    assert.equal(existsSync(join(cellKeepRootForCells(rig.cellsRoot), cell.paths.spaceName)), false, "kept paths left the stash");
    assert.equal(existsSync(join(cellEnvRootForCells(rig.cellsRoot), cell.paths.spaceName, ".env")), false, "env copy dropped");
    assert.equal(dirtyReport(cell.paths.wrapperDir).dirty, false);
    assert.ok(evictCellWrapper(rig.cellsRoot, cell.paths.wrapperDir), "the Cell can be evicted again later");
  } finally {
    rig.cleanup();
  }
});

test("unpark: refuses when the wrapper path is occupied again", () => {
  const rig = makeRig();
  try {
    const cell = provisionCell(
      rig.cellsRoot,
      { beeId: "bee-1", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
      "cmd-1",
      { disableCow: true },
    );
    const parked = evictCellWrapper(rig.cellsRoot, cell.paths.wrapperDir)!;
    mkdirSync(cell.paths.wrapperDir);
    assert.throws(() => unparkCellWrapper(rig.cellsRoot, cell.paths.wrapperDir, parked), /occupied/);
    assert.equal(existsSync(parked.parkedDir), true, "the parked copy stays where it is");
  } finally {
    rig.cleanup();
  }
});
