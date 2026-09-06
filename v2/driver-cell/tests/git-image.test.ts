/** Local immutable Git-image cache: publication, hot materialization, refresh,
 * cache-miss fallback, and origin isolation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";
import { probeCow } from "../src/cow.ts";
import { gitEnv } from "../src/git.ts";
import {
  gitImageRepoKey,
  gitImagesRootForCells,
  readCurrentGitImage,
  refreshGitImage,
  tryMaterializeGitImage,
} from "../src/gitImage.ts";
import { readLedger } from "../src/ledger.ts";
import { provisionCell, type ProvisionRequest } from "../src/provision.ts";
import { commitOn, fingerprintOrigin, g, makeRig } from "./helpers.ts";

const COW_AVAILABLE = (() => {
  if (platform() !== "darwin" && platform() !== "linux") return false;
  const rig = makeRig();
  try {
    return probeCow(join(rig.origin.repo, ".git"), rig.cellsRoot);
  } finally {
    rig.cleanup();
  }
})();

function request(
  rig: ReturnType<typeof makeRig>,
  beeId: string,
  cellId: string,
  sha = rig.origin.sha,
): ProvisionRequest {
  return {
    beeId,
    originRepo: rig.origin.repo,
    sha,
    wrapper: beeId,
    repoName: "fixture",
    cellId,
  };
}

function imageGitDir(imagesRoot: string, originRepo: string, generation: string): string {
  return join(imagesRoot, gitImageRepoKey(originRepo), "generations", generation, "repo.git");
}

function fileCount(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      total += 1;
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return total;
}

test("git-image.refresh: publishes one validated pack-only generation without mutating the origin", () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    const before = fingerprintOrigin(rig.origin.repo);
    const result = refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
    assert.equal(result.status, "refreshed");
    if (result.status !== "refreshed") return;

    const current = readCurrentGitImage(imagesRoot, rig.origin.repo);
    assert.deepEqual(current, result.image);
    const imageRepo = imageGitDir(imagesRoot, rig.origin.repo, current!.generation);
    assert.equal(g(imageRepo, ["cat-file", "-e", `${rig.origin.sha}^{commit}`]), "");
    assert.equal(g(imageRepo, ["show-ref"]), `${rig.origin.sha} refs/hive/image/anchor`);
    assert.deepEqual(
      readdirSync(join(imageRepo, "objects"), { withFileTypes: true }).map((entry) => entry.name).sort(),
      ["info", "pack"],
      "published images contain no loose-object fanout",
    );
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), before, "image construction is read-only at the origin");
    assert.equal(refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha).status, "ready");
  } finally {
    rig.cleanup();
  }
});

test("git-image.provision: hot Cell copies the compact image, not origin metadata", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);

    // This is the real regression shape: thousands of mutable metadata files
    // may exist in a long-lived origin, but none belong in a fresh Cell.
    const noise = join(rig.origin.repo, ".git", "worktrees", "noise");
    mkdirSync(noise, { recursive: true });
    for (let i = 0; i < 300; i += 1) writeFileSync(join(noise, `entry-${i}`), "metadata\n");
    writeFileSync(join(rig.origin.repo, ".git", "MERGE_MSG"), "origin-only state\n");

    const cell = provisionCell(rig.cellsRoot, request(rig, "bee-hot", "hot"), "cmd-hot", { gitImagesRoot: imagesRoot });
    assert.equal(cell.copyMode, "image-cow");
    assert.equal(g(cell.paths.spaceDir, ["rev-parse", "HEAD"]), rig.origin.sha);
    assert.equal(g(cell.paths.spaceDir, ["status", "--porcelain"]), "");
    assert.equal(g(cell.paths.spaceDir, ["config", "core.hooksPath"]), cell.paths.emptyHooksDir);
    assert.equal(g(cell.paths.spaceDir, ["config", "core.fsmonitor"]), "false");
    assert.equal(existsSync(join(cell.paths.spaceDir, ".git", "worktrees")), false);
    assert.equal(existsSync(join(cell.paths.spaceDir, ".git", "MERGE_MSG")), false);
    assert.ok(fileCount(join(cell.paths.spaceDir, ".git")) < 80, "Cell .git size is independent of origin metadata fanout");

    const placed = Object.values(readLedger(cell.paths.ledgerPath)!.operations)[0]?.steps.git_placed;
    assert.equal(placed?.mode, "image-cow");
    assert.match(placed?.image?.repoKey ?? "", /^[0-9a-f]{64}$/);
    assert.match(placed?.image?.generation ?? "", /^g-/);
    assert.equal(readFileSync(join(rig.origin.repo, ".git", "MERGE_MSG"), "utf8"), "origin-only state\n");
  } finally {
    rig.cleanup();
  }
});

test("git-image.provision: fresh config avoids config subprocesses and preserves init semantics", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  const previousPath = process.env.PATH;
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  const previousRealGit = process.env.HONEYBEE_TEST_REAL_GIT;
  const previousGitLog = process.env.HONEYBEE_TEST_GIT_LOG;
  try {
    const originRepo = join(rig.root, "origin-sha256");
    mkdirSync(originRepo);
    g(originRepo, ["init", "--object-format=sha256", "-b", "main"]);
    writeFileSync(join(originRepo, "README.md"), "# sha256 fixture\n");
    g(originRepo, ["add", "README.md"]);
    g(originRepo, ["commit", "-m", "initial"]);
    const sha = g(originRepo, ["rev-parse", "HEAD"]);

    const cellsRoot = join(rig.root, "cells \\ \" newline\n tab\t # space");
    const imagesRoot = join(rig.root, "images");
    refreshGitImage(imagesRoot, originRepo, sha);

    const templateDir = join(rig.root, "template");
    const templateHooksDir = join(templateDir, "hooks");
    mkdirSync(templateHooksDir, { recursive: true });
    writeFileSync(
      join(templateDir, "config"),
      "[hive-test]\n\tfromTemplate = kept\n",
    );
    writeFileSync(join(templateHooksDir, "pre-commit"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });

    const gitLookup = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
    assert.equal(gitLookup.status, 0, gitLookup.stderr);
    const realGit = gitLookup.stdout.trim();
    const traceBin = join(rig.root, "trace-bin");
    const tracePath = join(rig.root, "git-calls.log");
    mkdirSync(traceBin);
    writeFileSync(
      join(traceBin, "git"),
      "#!/bin/sh\nprintf '%s\\t%s\\n' \"$1\" \"$2\" >> \"$HONEYBEE_TEST_GIT_LOG\"\n\"$HONEYBEE_TEST_REAL_GIT\" \"$@\"\nstatus=$?\nif [ \"$status\" -eq 0 ] && [ \"$1\" = init ]; then\n  for final_arg in \"$@\"; do :; done\n  chmod 0664 \"$final_arg/.git/config\"\nfi\nexit \"$status\"\n",
      { mode: 0o755 },
    );

    process.env.GIT_TEMPLATE_DIR = templateDir;
    process.env.HONEYBEE_TEST_REAL_GIT = realGit;
    process.env.HONEYBEE_TEST_GIT_LOG = tracePath;
    process.env.PATH = `${traceBin}${delimiter}${previousPath ?? ""}`;
    const cell = provisionCell(
      cellsRoot,
      {
        beeId: "bee-config",
        originRepo,
        sha,
        wrapper: "bee-config",
        repoName: "fixture",
        cellId: "config",
      },
      "cmd-config",
      { gitImagesRoot: imagesRoot },
    );
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;

    assert.equal(cell.copyMode, "image-cow");
    assert.doesNotMatch(
      readFileSync(tracePath, "utf8"),
      /^config\tcore\.(?:hooksPath|fsmonitor)$/mu,
      "fresh image placement must not spawn git config",
    );

    const hooksPath = spawnSync(
      realGit,
      ["-C", cell.paths.spaceDir, "config", "--null", "--get", "core.hooksPath"],
      { encoding: "utf8", env: gitEnv() },
    );
    assert.equal(hooksPath.status, 0, hooksPath.stderr);
    assert.equal(hooksPath.stdout, `${cell.paths.emptyHooksDir}\0`);
    assert.equal(g(cell.paths.spaceDir, ["config", "--type=bool", "core.fsmonitor"]), "false");
    assert.equal(g(cell.paths.spaceDir, ["config", "hive-test.fromTemplate"]), "kept");
    assert.equal(g(cell.paths.spaceDir, ["config", "core.repositoryformatversion"]), "1");
    assert.match(g(cell.paths.spaceDir, ["config", "--type=bool", "core.filemode"]), /^(?:true|false)$/u);
    assert.equal(g(cell.paths.spaceDir, ["config", "--type=bool", "core.bare"]), "false");
    assert.equal(g(cell.paths.spaceDir, ["config", "--type=bool", "core.logallrefupdates"]), "true");
    assert.equal(g(cell.paths.spaceDir, ["config", "extensions.objectformat"]), "sha256");
    assert.equal(statSync(join(cell.paths.spaceDir, ".git", "config")).mode & 0o7777, 0o664);
    assert.ok(existsSync(join(cell.paths.spaceDir, ".git", "hooks", "pre-commit")));

    assert.equal(g(cell.paths.spaceDir, ["status", "--porcelain"]), "");
    writeFileSync(join(cell.paths.spaceDir, "hook-proof.txt"), "hook stays inert\n");
    g(cell.paths.spaceDir, ["add", "hook-proof.txt"]);
    g(cell.paths.spaceDir, ["commit", "-m", "prove hooks are inert"]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    if (previousRealGit === undefined) delete process.env.HONEYBEE_TEST_REAL_GIT;
    else process.env.HONEYBEE_TEST_REAL_GIT = previousRealGit;
    if (previousGitLog === undefined) delete process.env.HONEYBEE_TEST_GIT_LOG;
    else process.env.HONEYBEE_TEST_GIT_LOG = previousGitLog;
    rig.cleanup();
  }
});

test("git-image.provision: Git fallback preserves control paths and replaces template safety keys", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  const previousFsmonitorMarker = process.env.HONEYBEE_TEST_FSMONITOR_MARKER;
  try {
    const cellsRoot = join(rig.root, "cells \\ \" newline\n tab\t cr\r # space");
    const imagesRoot = join(rig.root, "images");
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);

    const templateDir = join(rig.root, "template-fallback");
    const templateHooksDir = join(templateDir, "hooks");
    const fsmonitorHook = join(rig.root, "template-fsmonitor");
    const fsmonitorMarker = join(rig.root, "fsmonitor-ran");
    mkdirSync(templateHooksDir, { recursive: true });
    writeFileSync(
      join(templateDir, "config"),
      `[core]\n\thooksPath = .git/hooks\n\tfsmonitor = "${fsmonitorHook}"\n[hive-test]\n\tfromTemplate = kept\n`,
    );
    writeFileSync(join(templateHooksDir, "pre-commit"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
    writeFileSync(
      fsmonitorHook,
      "#!/bin/sh\n: > \"$HONEYBEE_TEST_FSMONITOR_MARKER\"\nexit 1\n",
      { mode: 0o755 },
    );
    process.env.GIT_TEMPLATE_DIR = templateDir;
    process.env.HONEYBEE_TEST_FSMONITOR_MARKER = fsmonitorMarker;

    const cell = provisionCell(
      cellsRoot,
      request(rig, "bee-config-fallback", "fallback"),
      "cmd-config-fallback",
      { gitImagesRoot: imagesRoot },
    );
    assert.equal(cell.copyMode, "image-cow");

    const hooksPaths = spawnSync(
      "git",
      ["-C", cell.paths.spaceDir, "config", "--null", "--get-all", "core.hooksPath"],
      { encoding: "utf8", env: gitEnv() },
    );
    assert.equal(hooksPaths.status, 0, hooksPaths.stderr);
    assert.equal(hooksPaths.stdout, `${cell.paths.emptyHooksDir}\0`);
    const fsmonitorValues = spawnSync(
      "git",
      ["-C", cell.paths.spaceDir, "config", "--null", "--get-all", "core.fsmonitor"],
      { encoding: "utf8", env: gitEnv() },
    );
    assert.equal(fsmonitorValues.status, 0, fsmonitorValues.stderr);
    assert.equal(fsmonitorValues.stdout, "false\0");
    assert.equal(g(cell.paths.spaceDir, ["config", "hive-test.fromTemplate"]), "kept");
    assert.ok(existsSync(join(cell.paths.spaceDir, ".git", "hooks", "pre-commit")));

    assert.equal(g(cell.paths.spaceDir, ["status", "--porcelain"]), "");
    writeFileSync(join(cell.paths.spaceDir, "hook-proof.txt"), "hooks stay inert\n");
    g(cell.paths.spaceDir, ["add", "hook-proof.txt"]);
    g(cell.paths.spaceDir, ["commit", "-m", "prove fallback hooks are inert"]);
    assert.equal(existsSync(fsmonitorMarker), false, "template fsmonitor hook must stay inert");
  } finally {
    if (previousTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    if (previousFsmonitorMarker === undefined) delete process.env.HONEYBEE_TEST_FSMONITOR_MARKER;
    else process.env.HONEYBEE_TEST_FSMONITOR_MARKER = previousFsmonitorMarker;
    rig.cleanup();
  }
});

test("git-image.provision: symlinked template config retains Git's update behavior", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);

    const templateDir = join(rig.root, "template-symlink");
    const configTarget = join(rig.root, "shared-template-config");
    mkdirSync(templateDir);
    writeFileSync(configTarget, "[hive-test]\n\tsymlink = kept\n");
    symlinkSync(configTarget, join(templateDir, "config"));
    process.env.GIT_TEMPLATE_DIR = templateDir;

    const cell = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-config-symlink", "symlink"),
      "cmd-config-symlink",
      { gitImagesRoot: imagesRoot },
    );
    assert.equal(cell.copyMode, "image-cow");
    assert.equal(lstatSync(join(cell.paths.spaceDir, ".git", "config")).isSymbolicLink(), true);
    assert.equal(g(cell.paths.spaceDir, ["config", "hive-test.symlink"]), "kept");
    assert.equal(g(cell.paths.spaceDir, ["config", "core.hooksPath"]), cell.paths.emptyHooksDir);
    assert.equal(g(cell.paths.spaceDir, ["config", "core.fsmonitor"]), "false");
    assert.match(readFileSync(configTarget, "utf8"), /hooksPath/u);
  } finally {
    if (previousTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
    rig.cleanup();
  }
});

test("git-image.materialize: template multivalue and config lock remain cache misses", { skip: !COW_AVAILABLE }, () => {
  const templateCases: ("multivalue" | "lock")[] = ["multivalue", "lock"];
  const previousTemplateDir = process.env.GIT_TEMPLATE_DIR;
  try {
    for (const templateCase of templateCases) {
      if (previousTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR;
      else process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
      const rig = makeRig();
      try {
        const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
        refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
        const templateDir = join(rig.root, `template-${templateCase}`);
        mkdirSync(templateDir);
        if (templateCase === "multivalue") {
          writeFileSync(
            join(templateDir, "config"),
            "[core]\n\thooksPath = /first\n\thooksPath = /second\n",
          );
        } else {
          writeFileSync(join(templateDir, "config.lock"), "occupied\n");
        }
        process.env.GIT_TEMPLATE_DIR = templateDir;

        const boxDir = join(rig.root, `box-${templateCase}`);
        const spaceDir = join(rig.root, `space-${templateCase}`);
        mkdirSync(boxDir);
        assert.equal(
          tryMaterializeGitImage(
            imagesRoot,
            rig.origin.repo,
            rig.origin.sha,
            spaceDir,
            boxDir,
            join(boxDir, "hooks-empty"),
          ),
          null,
        );
        assert.equal(existsSync(spaceDir), false);
      } finally {
        rig.cleanup();
      }
    }
  } finally {
    if (previousTemplateDir === undefined) delete process.env.GIT_TEMPLATE_DIR;
    else process.env.GIT_TEMPLATE_DIR = previousTemplateDir;
  }
});

test("git-image.provision: preserves absent, same, and rewritten split remotes", { skip: !COW_AVAILABLE }, () => {
  const remoteCases: ("absent" | "same" | "split")[] = ["absent", "same", "split"];
  for (const remoteCase of remoteCases) {
    const rig = makeRig();
    try {
      const fetchBase = `${join(rig.root, "fetch")}/`;
      const pushBase = `${join(rig.root, "push")}/`;
      if (remoteCase !== "absent") {
        g(rig.origin.repo, ["remote", "add", "origin", "fixture:repo"]);
        g(rig.origin.repo, ["config", `url.${fetchBase}.insteadOf`, "fixture:"]);
        if (remoteCase === "split") {
          g(rig.origin.repo, ["config", `url.${pushBase}.pushInsteadOf`, "fixture:"]);
        }
      }

      const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
      refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
      const cell = provisionCell(
        rig.cellsRoot,
        request(rig, `bee-remote-${remoteCase}`, remoteCase),
        `cmd-remote-${remoteCase}`,
        { gitImagesRoot: imagesRoot },
      );
      assert.equal(cell.copyMode, "image-cow");

      if (remoteCase === "absent") {
        assert.equal(g(cell.paths.spaceDir, ["remote"]), "");
      } else {
        assert.equal(g(cell.paths.spaceDir, ["remote", "get-url", "origin"]), `${fetchBase}repo`);
        assert.equal(
          g(cell.paths.spaceDir, ["remote", "get-url", "--push", "origin"]),
          remoteCase === "split" ? `${pushBase}repo` : `${fetchBase}repo`,
        );
      }
    } finally {
      rig.cleanup();
    }
  }
});

test("git-image.provision: the first Cell builds an image in its worker and uses it", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo), null);

    const cell = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-first", "first"),
      "cmd-first",
      { gitImagesRoot: imagesRoot },
    );

    assert.equal(cell.copyMode, "image-cow");
    assert.equal(g(cell.paths.spaceDir, ["rev-parse", "HEAD"]), rig.origin.sha);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo)?.anchorSha, rig.origin.sha);
  } finally {
    rig.cleanup();
  }
});

test("git-image.refresh: first generation CoW-seeds origin packs and packs only the loose delta", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    g(rig.origin.repo, ["repack", "-ad"]);
    const nextSha = commitOn(rig.origin.repo, "loose.txt", "loose\n", "loose delta");
    const before = fingerprintOrigin(rig.origin.repo);
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    const result = refreshGitImage(imagesRoot, rig.origin.repo, nextSha);
    assert.equal(result.status, "refreshed");
    if (result.status !== "refreshed") return;
    const packFiles = readdirSync(
      join(imageGitDir(imagesRoot, rig.origin.repo, result.image.generation), "objects", "pack"),
    ).filter((name) => name.endsWith(".pack"));
    assert.ok(packFiles.length >= 2, "origin pack plus image-owned loose-object delta are retained");
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), before);
  } finally {
    rig.cleanup();
  }
});

test("git-image.provision: a stale image is incrementally extended before checkout", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    const first = refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
    assert.notEqual(first.status, "busy");
    const firstGeneration = "image" in first ? first.image.generation : "";
    const nextSha = commitOn(rig.origin.repo, "next.txt", "next\n", "next");

    const extended = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-miss", "miss", nextSha),
      "cmd-miss",
      { gitImagesRoot: imagesRoot },
    );
    assert.equal(extended.copyMode, "image-cow");
    assert.equal(g(extended.paths.spaceDir, ["rev-parse", "HEAD"]), nextSha);
    const refreshed = readCurrentGitImage(imagesRoot, rig.origin.repo);
    assert.ok(refreshed);
    assert.equal(refreshed.anchorSha, nextSha);
    assert.notEqual(refreshed.generation, firstGeneration);
    assert.ok(existsSync(imageGitDir(imagesRoot, rig.origin.repo, firstGeneration)), "previous generation is retained for readers");

    const hot = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-next", "next", nextSha),
      "cmd-next",
      { gitImagesRoot: imagesRoot },
    );
    assert.equal(hot.copyMode, "image-cow");
    assert.equal(g(hot.paths.spaceDir, ["rev-parse", "HEAD"]), nextSha);
  } finally {
    rig.cleanup();
  }
});

test("git-image.corruption: malformed publication is rebuilt before Cell placement", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
    const currentPath = join(imagesRoot, gitImageRepoKey(rig.origin.repo), "current.json");
    writeFileSync(currentPath, "{\"version\":1,\"generation\":\"../../origin\"}\n");
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo), null);

    const repaired = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-fallback", "fallback"),
      "cmd-fallback",
      { gitImagesRoot: imagesRoot },
    );
    assert.equal(repaired.copyMode, "image-cow");
    assert.equal(g(repaired.paths.spaceDir, ["rev-parse", "HEAD"]), rig.origin.sha);
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo)?.anchorSha, rig.origin.sha);
  } finally {
    rig.cleanup();
  }
});

test("git-image.policy: an existing image is ignored when the node policy disables local images", { skip: !COW_AVAILABLE }, () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
    const cell = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-policy", "policy"),
      "cmd-policy",
      { gitImagesRoot: imagesRoot, useGitImages: false },
    );
    assert.notEqual(cell.copyMode, "image-cow");
    assert.equal(g(cell.paths.spaceDir, ["rev-parse", "HEAD"]), rig.origin.sha);
  } finally {
    rig.cleanup();
  }
});

test("git-image.lock: a provisioning contender waits for publication, then extends the image", { skip: !COW_AVAILABLE }, async () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
    const nextSha = commitOn(rig.origin.repo, "contended.txt", "next\n", "contended");
    const lockDir = join(imagesRoot, gitImageRepoKey(rig.origin.repo), "build.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ token: "other", pid: 1, startedAt: 10_000 })}\n`);

    const releaser = spawn(process.execPath, [
      "-e",
      "setTimeout(() => require('node:fs').rmSync(process.argv[1], { recursive: true, force: true }), 150)",
      lockDir,
    ], { stdio: "ignore" });
    const released = once(releaser, "exit");
    const cell = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-contended", "contended", nextSha),
      "cmd-contended",
      { gitImagesRoot: imagesRoot, gitImageBusyWaitMs: 2_000, now: () => 20_000 },
    );
    const [exitCode] = await released;

    assert.equal(exitCode, 0);
    assert.equal(cell.copyMode, "image-cow");
    assert.equal(readCurrentGitImage(imagesRoot, rig.origin.repo)?.anchorSha, nextSha);
  } finally {
    rig.cleanup();
  }
});

test("git-image.lock: live builder is single-flight and a stale lock is recovered", () => {
  const rig = makeRig();
  try {
    const imagesRoot = gitImagesRootForCells(rig.cellsRoot);
    refreshGitImage(imagesRoot, rig.origin.repo, rig.origin.sha);
    const nextSha = commitOn(rig.origin.repo, "locked.txt", "locked\n", "locked");
    const repoRoot = join(imagesRoot, gitImageRepoKey(rig.origin.repo));
    const lockDir = join(repoRoot, "build.lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "owner.json"), `${JSON.stringify({ token: "other", pid: 1, startedAt: 10_000 })}\n`);

    assert.equal(
      refreshGitImage(imagesRoot, rig.origin.repo, nextSha, { now: () => 20_000 }).status,
      "busy",
    );
    const boundedFallback = provisionCell(
      rig.cellsRoot,
      request(rig, "bee-busy", "busy", nextSha),
      "cmd-busy",
      { gitImagesRoot: imagesRoot, gitImageBusyWaitMs: 0, now: () => 20_000 },
    );
    assert.notEqual(boundedFallback.copyMode, "image-cow", "a busy image builder never blocks correctness");
    const recovered = refreshGitImage(imagesRoot, rig.origin.repo, nextSha, { now: () => 2_000_000 });
    assert.equal(recovered.status, "refreshed");
    assert.ok(readCurrentGitImage(imagesRoot, rig.origin.repo));
  } finally {
    rig.cleanup();
  }
});
