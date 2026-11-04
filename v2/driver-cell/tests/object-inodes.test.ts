import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { probeCow } from "../src/cow.ts";
import { gitImagesRootForCells, gitImageRepoKey, readCurrentGitImage, refreshGitImage } from "../src/gitImage.ts";
import { provisionCell } from "../src/provision.ts";
import { buildPoolMember, claimFromPool, listPoolMembers, repoKeyFor } from "../src/warmPool.ts";
import { commitOn, g, makeRig } from "./helpers.ts";

function objectFiles(root: string): Array<{ dev: number; ino: number; nlink: number }> {
  const files: Array<{ dev: number; ino: number; nlink: number }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...objectFiles(path));
    else if (entry.isFile()) files.push(lstatSync(path));
    else assert.fail("Object storage must contain regular files and directories");
  }
  return files;
}

function assertPrivateObjects(gitDir: string, others: string[]): void {
  const objects = join(gitDir, "objects");
  assert.equal(existsSync(join(objects, "info", "alternates")), false);
  const files = objectFiles(objects);
  assert.ok(files.length > 0);
  const foreign = new Set(others.flatMap(dir => objectFiles(join(dir, "objects"))).map(stat => `${stat.dev}:${stat.ino}`));
  for (const stat of files) {
    assert.equal(stat.nlink, 1, "Provisioning must not share object inodes");
    assert.equal(foreign.has(`${stat.dev}:${stat.ino}`), false, "Provisioning must not share object inodes");
  }
}

for (const mode of ["clone", "cow", "image-cow"] as const) {
  test(`provision.${mode}: object inodes belong to each provisioned repository`, t => {
    const rig = makeRig();
    try {
      if (mode !== "clone" && !probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot)) {
        t.skip("Venue does not support real reflink copies");
        return;
      }
      const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
      if (mode === "image-cow") g(rig.origin.repo, ["repack", "-ad"]);
      const prior = [join(rig.origin.repo, ".git")];
      for (let i = 0; i < 2; i++) {
        const cell = provisionCell(rig.cellsRoot, {
          beeId: `bee-${i}`, originRepo: rig.origin.repo, sha: rig.origin.sha,
          wrapper: `bee-${i}`, repoName: "fixture", cellId: `c${i}`,
        }, `cmd-${i}`, { disableCow: mode === "clone", useGitImages: mode === "image-cow" });
        assert.equal(cell.copyMode, mode);
        if (mode === "image-cow") {
          const image = readCurrentGitImage(imagesRoot, rig.origin.repo);
          assert.ok(image);
          const imageGit = join(imagesRoot, gitImageRepoKey(rig.origin.repo), "generations", image.generation, "repo.git");
          assertPrivateObjects(imageGit, [prior[0]!]);
          if (!prior.includes(imageGit)) prior.push(imageGit);
        }
        const gitDir = join(cell.paths.spaceDir, ".git");
        assertPrivateObjects(gitDir, prior);
        prior.push(gitDir);
      }
    } finally { rig.cleanup(); }
  });
}

test("git-image refresh keeps independently owned object inodes", () => {
  const rig = makeRig();
  try {
    const root = gitImagesRootForCells(rig.cellsRoot);
    g(rig.origin.repo, ["repack", "-ad"]);
    const first = refreshGitImage(root, rig.origin.repo, rig.origin.sha);
    assert.notEqual(first.status, "busy");
    const image = readCurrentGitImage(root, rig.origin.repo);
    assert.ok(image);
    const oldGit = join(root, gitImageRepoKey(rig.origin.repo), "generations", image.generation, "repo.git");
    assertPrivateObjects(oldGit, [join(rig.origin.repo, ".git")]);
    const sha = commitOn(rig.origin.repo, "next.txt", "next\n", "next");
    refreshGitImage(root, rig.origin.repo, sha);
    const next = readCurrentGitImage(root, rig.origin.repo);
    assert.ok(next);
    assert.notEqual(next.generation, image.generation);
    const newGit = join(root, gitImageRepoKey(rig.origin.repo), "generations", next.generation, "repo.git");
    assertPrivateObjects(newGit, [join(rig.origin.repo, ".git"), oldGit]);
  } finally { rig.cleanup(); }
});

test("warm pool members and claimed repositories retain independent object inodes", () => {
  const rig = makeRig();
  try {
    const prior = [join(rig.origin.repo, ".git")];
    for (let i = 0; i < 2; i++) {
      assert.ok(buildPoolMember(rig.cellsRoot, { originRepo: rig.origin.repo, repoName: "fixture", sha: rig.origin.sha }, { disableCow: true }, { racyIndexWindowMs: 0 }));
    }
    for (const member of listPoolMembers(rig.cellsRoot, repoKeyFor(rig.origin.repo, "fixture"))) {
      const gitDir = join(member.paths.spaceDir, ".git");
      assertPrivateObjects(gitDir, prior);
      prior.push(gitDir);
    }
    const claimed = claimFromPool(rig.cellsRoot, { beeId: "claimed", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "claimed", repoName: "fixture", cellId: "claimed" });
    assert.ok(claimed);
    const others = listPoolMembers(rig.cellsRoot, repoKeyFor(rig.origin.repo, "fixture")).map(member => join(member.paths.spaceDir, ".git"));
    assertPrivateObjects(join(claimed.paths.spaceDir, ".git"), [join(rig.origin.repo, ".git"), ...others]);
  } finally { rig.cleanup(); }
});
