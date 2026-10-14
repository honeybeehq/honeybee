import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureWork } from "../src/capture.ts";
import { gitEnv, hostGitConfig, parseConfigListing, porcelainStatus, repoLocalExecOverrides, tryGit } from "../src/git.ts";
import { describeCommits, unlandedCommitsByTip } from "../src/landed.ts";
import { provisionCell } from "../src/provision.ts";
import { commitInCell, g, makeOrigin, makeRig } from "./helpers.ts";

function plantCommand(dir: string, name: string, canary: string, label: string, passThrough = false): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho ${label} >> ${JSON.stringify(canary)}\n${passThrough ? "cat" : "echo -"}\n`);
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
    const filterCanary = plantCommand(join(space, ".git"), "filter-canary", canary, "cell:filter", true);
    for (const key of ["filter.evil.smudge", "filter.evil.clean", "diff.evil.textconv", "diff.evil.command", "merge.evil.driver", "diff.external"]) {
      g(space, ["config", key, `${filterCanary} %f`]);
    }
    g(space, ["config", "filter.evil.required", "true"]);
    g(space, ["config", "core.alternateRefsCommand", plantCommand(join(space, ".git"), "alternate-refs-client-canary", canary, "cell:alternateRefsCommandClient")]);
    g(space, ["config", "protocol.ext.allow", "always"]);
    g(space, ["config", "log.showSignature", "true"]);
    g(space, ["config", "gpg.program", plantCommand(join(space, ".git"), "gpg-canary", canary, "cell:gpg")]);
    writeFileSync(join(space, ".git", "info", "attributes"), "* filter=evil\n*.ts diff=evil merge=evil\n");
    const trace = join(rig.root, "git-trace.log");
    const previousTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = trace;

    const unguarded = spawnSync("git", ["status", "--porcelain"], { cwd: space, encoding: "utf8", env: gitEnv() });
    assert.equal(unguarded.status, 0, unguarded.stderr);
    assert.deepEqual(firedCanaries(canary), [
      "cell:filter",
      "cell:fsmonitor",
      "cell:post-index-change",
      "submodule:fsmonitor",
      "submodule:post-index-change",
    ]);
    for (const target of [rig.origin.sha, work]) {
      const unguardedCheckout = spawnSync("git", ["checkout", "--force", "--detach", target], { cwd: space, encoding: "utf8", env: gitEnv() });
      assert.equal(unguardedCheckout.status, 0, unguardedCheckout.stderr);
    }
    assert.ok(firedCanaries(canary).includes("cell:filter"), "unguarded checkout runs the planted smudge filter");
    rmSync(canary, { force: true });
    const unguardedFetch = spawnSync("git", ["fetch", "--no-tags", rig.origin.repo, rig.origin.sha], { cwd: space, encoding: "utf8", env: gitEnv() });
    assert.equal(unguardedFetch.status, 0, unguardedFetch.stderr);
    assert.ok(firedCanaries(canary).includes("cell:alternateRefsCommandClient"), "unguarded fetch inside the Cell runs the planted alternateRefsCommand");
    assert.ok(gitlinkSpawns(trace).length > 0, "unguarded status must spawn into the gitlink for the control to mean anything");
    rmSync(canary, { force: true });
    rmSync(trace, { force: true });

    g(space, ["config", "filter.evil.process", `${filterCanary} %f`]);
    assert.deepEqual(
      repoLocalExecOverrides(space, gitEnv()).filter(([key]) => key.startsWith("filter.evil.")).sort(),
      [["filter.evil.clean", ""], ["filter.evil.process", ""], ["filter.evil.required", "false"], ["filter.evil.smudge", ""]],
    );
    porcelainStatus(space);
    for (const target of [rig.origin.sha, work]) {
      const checkout = tryGit(space, ["checkout", "--force", "--detach", "--no-recurse-submodules", target]);
      assert.equal(checkout.status, 0, checkout.stderr);
    }
    assert.equal(readFileSync(join(space, "feature.ts"), "utf8"), "export const f = 1;\n");
    const fetch = tryGit(space, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--upload-pack=git-upload-pack", "--no-write-fetch-head", rig.origin.repo, rig.origin.sha]);
    assert.equal(fetch.status, 0, fetch.stderr);
    tryGit(space, ["log", "--show-signature", "-1"]);
    g(space, ["config", `url.ext::${filterCanary} %S.insteadOf`, rig.origin.repo]);
    const rewritten = tryGit(space, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--upload-pack=git-upload-pack", "--no-write-fetch-head", rig.origin.repo, rig.origin.sha]);
    assert.notEqual(rewritten.status, 0, "a planted ext:: url rewrite must fail closed");
    assert.match(rewritten.stderr, /transport 'ext' not allowed/u);
    g(space, ["config", "--remove-section", `url.ext::${filterCanary} %S`]);
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
    assert.deepEqual(hostGitConfig.map(([key]) => key), ["core.fsmonitor", "core.hooksPath", "submodule.recurse", "diff.ignoreSubmodules", "commit.gpgsign", "tag.gpgsign", "log.showSignature", "core.alternateRefsCommand"]);
  } finally {
    rig.cleanup();
  }
});

test("the exec-config probe fails closed on a listing whose scope/record parity or scope names are off", () => {
  assert.deepEqual(parseConfigListing(""), []);
  assert.deepEqual(parseConfigListing("local\0filter.evil.smudge\ncat\0"), [["local", "filter.evil.smudge"]]);
  assert.throws(() => parseConfigListing("local\0filter.n\0ul.smudge\ncat\0"), /scope\/record pairs|unknown scope field/u);
  assert.throws(() => parseConfigListing("local\0filter.n\0ul.smudge\ncat\0local\0core.bare\nfalse\0x\0"), /unknown scope field/u);
  assert.throws(() => parseConfigListing("local\0core.bare\nfalse"), /scope\/record pairs/u);
  const rig = makeRig();
  try {
    const repo = join(rig.root, "nul-subsection");
    mkdirSync(repo);
    g(repo, ["init", "--quiet"]);
    const config = join(repo, ".git", "config");
    writeFileSync(config, Buffer.concat([readFileSync(config), Buffer.from('[filter "n\0ul"]\n\tsmudge = cat\n', "latin1")]));
    let overrides: Array<readonly [string, string]> = [];
    try {
      overrides = repoLocalExecOverrides(repo, gitEnv());
    } catch (error) {
      assert.match(error instanceof Error ? error.message : String(error), /scope\/record pairs|unknown scope field/u);
      return;
    }
    assert.ok(overrides.every(([key]) => !key.startsWith("filter.n")), `a truncated key must never be half-applied: ${JSON.stringify(overrides)}`);
  } finally {
    rig.cleanup();
  }
});
