import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNT_RECIPES, skillsDirFor } from "../../core/src/accountRecipes.ts";
import { SKILLS_MANIFEST, installSkillTreeForHarness, installSkillTreeIntoHome, parseSkillTree, readSkillTreeFromDirectory, readSkillsManifest, storeSkillTree } from "../src/skills.ts";

function storedTree(root: string, files: Record<string, string>): string {
  const src = join(root, `src-${Math.random().toString(36).slice(2)}`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, path, ".."), { recursive: true });
    writeFileSync(join(src, path), body);
  }
  return storeSkillTree(join(root, "store"), parseSkillTree(readSkillTreeFromDirectory(src)));
}

test("skills: every recipe names the directory its harness reads skills from", () => {
  const expected: Record<string, string> = { claude: "skills", codex: "skills", opencode: "skills", grok: "skills", kimi: "skills", cursor: "skills", agy: "skills", muse: "muse/skills" };
  assert.deepEqual(Object.fromEntries(Object.keys(ACCOUNT_RECIPES).map((harness) => [harness, skillsDirFor(harness)])), expected);
  assert.equal(skillsDirFor("no-such-harness"), undefined);
});

test("skills: a Muse home gets the tree under muse/skills and the manifest clears a tree written at the old path", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-skills-dir-"));
  try {
    const home = join(root, "home");
    const first = storedTree(root, { "alpha/SKILL.md": "alpha v1", "beta/SKILL.md": "beta" });
    installSkillTreeIntoHome(first, home, "skills");
    writeFileSync(join(home, "skills", "alpha", "mine.md"), "user file");
    mkdirSync(join(home, "skills", "own"), { recursive: true });
    writeFileSync(join(home, "skills", "own", "SKILL.md"), "user skill");

    const second = storedTree(root, { "alpha/SKILL.md": "alpha v2", "gamma/SKILL.md": "gamma" });
    const result = installSkillTreeForHarness(second, home, "muse");
    assert.ok(result);
    assert.equal(result.status, "installed");
    assert.equal(result.dir, join(home, "muse", "skills"));
    assert.equal(result.removedLegacy, 2);
    assert.equal(readFileSync(join(home, "muse", "skills", "alpha", "SKILL.md"), "utf8"), "alpha v2");
    assert.equal(readFileSync(join(home, "muse", "skills", "gamma", "SKILL.md"), "utf8"), "gamma");
    assert.equal(readSkillsManifest(join(home, "muse", "skills"))?.digest, readSkillsManifest(second)?.digest);

    assert.equal(existsSync(join(home, "skills", "alpha", "SKILL.md")), false);
    assert.equal(existsSync(join(home, "skills", "beta")), false);
    assert.equal(existsSync(join(home, "skills", SKILLS_MANIFEST)), false);
    assert.equal(readFileSync(join(home, "skills", "alpha", "mine.md"), "utf8"), "user file");
    assert.equal(readFileSync(join(home, "skills", "own", "SKILL.md"), "utf8"), "user skill");

    const again = installSkillTreeForHarness(second, home, "muse");
    assert.deepEqual({ status: again?.status, removedLegacy: again?.removedLegacy }, { status: "unchanged", removedLegacy: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skills: a legacy tree alone at the old Muse path is removed with its directory, even when the new path is already current", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-skills-dir-"));
  try {
    const home = join(root, "home");
    const tree = storedTree(root, { "alpha/SKILL.md": "alpha" });
    installSkillTreeIntoHome(tree, home, "muse/skills");
    installSkillTreeIntoHome(tree, home, "skills");
    const result = installSkillTreeForHarness(tree, home, "muse");
    assert.deepEqual({ status: result?.status, removedLegacy: result?.removedLegacy }, { status: "unchanged", removedLegacy: 1 });
    assert.equal(existsSync(join(home, "skills")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skills: a harness that reads <home>/skills keeps its tree there and nothing is treated as legacy", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-skills-dir-"));
  try {
    const home = join(root, "home");
    const first = storedTree(root, { "alpha/SKILL.md": "alpha v1", "beta/SKILL.md": "beta" });
    installSkillTreeForHarness(first, home, "claude");
    const second = storedTree(root, { "alpha/SKILL.md": "alpha v2" });
    const result = installSkillTreeForHarness(second, home, "claude");
    assert.deepEqual({ status: result?.status, dir: result?.dir, removedLegacy: result?.removedLegacy }, { status: "installed", dir: join(home, "skills"), removedLegacy: 0 });
    assert.equal(readFileSync(join(home, "skills", "alpha", "SKILL.md"), "utf8"), "alpha v2");
    assert.equal(existsSync(join(home, "skills", "beta")), false);
    assert.equal(installSkillTreeForHarness(second, home, "no-such-harness"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
