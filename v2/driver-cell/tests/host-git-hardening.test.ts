import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureWork } from "../src/capture.ts";
import { gitEnv, hostGitConfig, porcelainStatus } from "../src/git.ts";
import { describeCommits, unlandedCommitsByTip } from "../src/landed.ts";
import { provisionCell } from "../src/provision.ts";
import { commitInCell, g, makeOrigin, makeRig } from "./helpers.ts";

function plantCommand(dir: string, name: string, canary: string, label: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ${label} >> ${JSON.stringify(canary)}\necho -\n`);
  chmodSync(path, 0o755);
  return path;
}

function plantRepoConfig(gitDir: string, canary: string, label: string): void {
  const fsmonitor = plantCommand(gitDir, "fsmonitor-canary", canary, `${label}:fsmonitor`);
  const hooks = join(gitDir, "hooks");
  const config = join(gitDir, "config");
  writeFileSync(config, readFileSync(config, "utf8").replace(/^\s*hookspath\s*=.*$/gim, ""));
  g(gitDir, ["config", "-f", config, "core.fsmonitor", fsmonitor]);
  g(gitDir, ["config", "-f", config, "core.hooksPath", hooks]);
  mkdirSync(hooks, { recursive: true });
  for (const hook of ["pre-commit", "post-commit", "post-checkout", "post-merge", "post-index-change", "reference-transaction"]) {
    plantCommand(hooks, hook, canary, `${label}:${hook}`);
  }
}

function gitlinkSpawns(trace: string): string[] {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, "utf8").split("\n").filter((line) => line.includes("run_command") && line.includes("vendor/sub"));
}

function firedCanaries(canary: string): string[] {
  if (!existsSync(canary)) return [];
  return [...new Set(readFileSync(canary, "utf8").split("\n").filter((line) => line.length > 0))].sort();
}

test("host git never runs a hook or fsmonitor planted in a Cell, a nested repo, or a submodule gitdir", () => {
  const rig = makeRig();
  try {
    const submoduleOrigin = makeOrigin(rig.root, "submodule-origin");
    const cell = provisionCell(
      rig.cellsRoot,
      { beeId: "bee-1", originRepo: rig.origin.repo, sha: rig.origin.sha, wrapper: "bee-1", repoName: "fixture", cellId: "c1" },
      "cmd-1",
      { disableCow: true },
    );
    const space = cell.paths.spaceDir;
    g(space, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submoduleOrigin.repo, "vendor/sub"]);
    g(space, ["commit", "--quiet", "-m", "add submodule"]);
    const work = commitInCell(space, "feature.ts", "export const f = 1;\n", "add feature");
    const nested = join(space, "vendor", "inner");
    mkdirSync(nested, { recursive: true });
    g(nested, ["init", "--quiet"]);

    const canary = join(rig.root, "canary.log");
    plantRepoConfig(join(space, ".git"), canary, "cell");
    plantRepoConfig(join(space, ".git", "modules", "vendor", "sub"), canary, "submodule");
    plantRepoConfig(join(nested, ".git"), canary, "nested");
    writeFileSync(join(space, "vendor", "sub", "dirty.txt"), "dirty\n");
    g(space, ["config", "-f", ".gitmodules", "submodule.vendor/sub.ignore", "none"]);
    g(space, ["config", "-f", ".gitmodules", "submodule.vendor/sub.fetchRecurseSubmodules", "true"]);
    writeFileSync(join(space, ".git", "objects", "info", "alternates"), `${join(rig.origin.repo, ".git", "objects")}\n`);
    g(space, ["config", "core.alternateRefsCommand", plantCommand(join(space, ".git"), "alternate-refs-canary", canary, "cell:alternateRefsCommand")]);
    g(space, ["config", "uploadpack.packObjectsHook", plantCommand(join(space, ".git"), "pack-objects-canary", canary, "cell:packObjectsHook")]);
    const trace = join(rig.root, "git-trace.log");
    const previousTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;

    const unguarded = spawnSync("git", ["status", "--porcelain"], { cwd: space, encoding: "utf8", env: gitEnv() });
    assert.equal(unguarded.status, 0, unguarded.stderr);
    assert.deepEqual(firedCanaries(canary), [
      "cell:fsmonitor",
      "cell:post-index-change",
      "submodule:fsmonitor",
      "submodule:post-index-change",
    ]);
    assert.ok(gitlinkSpawns(trace).length > 0, "unguarded status must spawn into the gitlink for the control to mean anything");
    rmSync(canary, { force: true });
    rmSync(trace, { force: true });

    porcelainStatus(space);
    unlandedCommitsByTip({ spaceDir: space, originRepo: rig.origin.repo, tips: [work], base: rig.origin.sha });
    describeCommits(space, [work]);
    const report = captureWork({
      originRepo: rig.origin.repo,
      cellSpaceDir: space,
      targetBranch: "bee/feature",
      mode: "merge",
      opId: "cmd-77",
    });
    assert.equal(report.status, "landed");
    assert.equal(g(rig.origin.repo, ["rev-parse", "refs/heads/bee/feature"]), work);
    assert.deepEqual(firedCanaries(canary), []);
    assert.deepEqual(gitlinkSpawns(trace), []);
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
    assert.deepEqual(hostGitConfig.map(([key]) => key), ["core.fsmonitor", "core.hooksPath", "submodule.recurse", "diff.ignoreSubmodules"]);
  } finally {
    rig.cleanup();
  }
});
