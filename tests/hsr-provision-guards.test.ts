/**
 * Provision argument-injection guards (HIVE-57).
 *
 * `provision` places operator-supplied repo/branch/ref into git argv; without
 * validation a `-`-leading value is parsed as a git flag (`--upload-pack=…`,
 * `--force`) and an `ext::` url invokes a remote helper that executes arbitrary
 * commands. These tests drive the runner-host controller's `provision` method
 * directly (no ssh/rpc plumbing) and assert: hostile repo/branch/ref values are
 * rejected up front with `{ ok:false }` (git never runs), while ordinary urls,
 * branches, and pinned refs still provision — including through the reuse path
 * — with the `--` argv guards in place.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildController } from "../src/hsr/remoteHost.js";
import { REMOTE_HSR_SAFETY_PROTOCOL, writeRemoteHsrLaunchReceipt } from "../src/hsr/remoteLaunchReceipt.js";
import { ensureHsrRunDir, writeHsrMeta } from "../src/hsr/runDir.js";
import type { RpcConnectionCtx } from "../src/hsr/rpc.js";

type ProvisionResult = { ok: boolean; error?: string; path?: string; branch?: string; reused?: boolean };

const ctx: RpcConnectionCtx = { connectionId: 0, close: () => undefined };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "hive",
      GIT_AUTHOR_EMAIL: "hive@example.com",
      GIT_COMMITTER_NAME: "hive",
      GIT_COMMITTER_EMAIL: "hive@example.com",
    },
  })
    .toString()
    .trim();
}

/** A LOCAL source repo on branch `main` with two commits, exposed as a `file://` url. */
async function makeSourceRepo(dir: string): Promise<{ path: string; url: string; firstSha: string }> {
  await mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
  await writeFile(join(dir, "README.md"), "hello\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  const firstSha = git(dir, ["rev-parse", "HEAD"]);
  await writeFile(join(dir, "second.txt"), "second\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "second"]);
  return { path: dir, url: `file://${dir}`, firstSha };
}

async function withTempStore(fn: (dir: string) => Promise<void>): Promise<void> {
  const prev = process.env.HIVE_STORE_ROOT;
  const dir = await mkdtemp("/tmp/hb-provg-");
  process.env.HIVE_STORE_ROOT = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.HIVE_STORE_ROOT;
    else process.env.HIVE_STORE_ROOT = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("provision rejects -leading and remote-helper repo urls, and -leading/malformed branch/ref", async () => {
  await withTempStore(async (dir) => {
    const controller = buildController();
    const provision = controller.methods.provision!;
    const source = await makeSourceRepo(join(dir, "source-repo"));
    try {
      const hostileRepos = [
        "--upload-pack=/bin/sh",
        "-oProxyCommand=touch /tmp/pwned",
        "ext::sh -c whoami",
        "fd::17",
      ];
      for (const repo of hostileRepos) {
        const res = (await provision({ repo, name: "wc" }, ctx)) as ProvisionResult;
        assert.equal(res.ok, false, `repo ${JSON.stringify(repo)} must be rejected`);
        assert.match(res.error ?? "", /invalid repo url/, `repo ${JSON.stringify(repo)} rejected as invalid`);
      }

      const hostileRefs = ["--force", "-x", "--detach", "ref with space", "$(id)", "a..b", "ref@{1}"];
      for (const branch of hostileRefs) {
        const res = (await provision({ repo: source.url, branch, name: "wc" }, ctx)) as ProvisionResult;
        assert.equal(res.ok, false, `branch ${JSON.stringify(branch)} must be rejected`);
        assert.match(res.error ?? "", /invalid branch/, `branch ${JSON.stringify(branch)} rejected as invalid`);
      }
      for (const ref of hostileRefs) {
        const res = (await provision({ repo: source.url, ref, name: "wc" }, ctx)) as ProvisionResult;
        assert.equal(res.ok, false, `ref ${JSON.stringify(ref)} must be rejected`);
        assert.match(res.error ?? "", /invalid ref/, `ref ${JSON.stringify(ref)} rejected as invalid`);
      }

      // Nothing was provisioned by any rejected call.
      assert.equal(existsSync(join(dir, "worktrees", "wc")), false, "no checkout created for rejected inputs");
    } finally {
      await controller.close();
    }
  });
});

test("provision still clones/reuses ordinary urls, branches and pinned refs with the -- guards", async () => {
  await withTempStore(async (dir) => {
    const controller = buildController();
    const provision = controller.methods.provision!;
    const source = await makeSourceRepo(join(dir, "source-repo"));
    try {
      // Fresh shallow clone of branch main (clone `-- <url> <path>` guard).
      const first = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(first.ok, true, `branch clone succeeds: ${first.error ?? ""}`);
      assert.equal(first.branch, "main");
      assert.equal(first.reused, false);
      const path = join(dir, "worktrees", "wc1");
      assert.equal(first.path, path);

      // Reuse path: fetch `origin -- <branch>` + `checkout <branch> --` + reset.
      const second = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(second.ok, true, `branch reuse succeeds: ${second.error ?? ""}`);
      assert.equal(second.reused, true);
      assert.equal(git(path, ["rev-parse", "HEAD"]), git(source.path, ["rev-parse", "HEAD"]));

      // Pinned ref: full clone then `checkout <sha> --`.
      const pinned = (await provision({ repo: source.url, ref: source.firstSha, name: "wc2" }, ctx)) as ProvisionResult;
      assert.equal(pinned.ok, true, `ref clone succeeds: ${pinned.error ?? ""}`);
      const pinnedPath = join(dir, "worktrees", "wc2");
      assert.equal(git(pinnedPath, ["rev-parse", "HEAD"]), source.firstSha, "checkout is pinned to the requested ref");
    } finally {
      await controller.close();
    }
  });
});

function plantCommand(path: string, canary: string, label: string): string {
  writeFileSync(path, `#!/bin/sh\necho ${label} >> ${JSON.stringify(canary)}\ncat\n`);
  chmodSync(path, 0o755);
  return path;
}

function firedCanaries(canary: string): string[] {
  if (!existsSync(canary)) return [];
  return [...new Set(readFileSync(canary, "utf8").split("\n").filter((line) => line.length > 0))].sort();
}

test("reusing a checkout rewrites its config host-owned so planted filters, signing, credentials, url rewrites and upload-pack never run", async () => {
  await withTempStore(async (dir) => {
    const controller = buildController();
    const provision = controller.methods.provision!;
    const source = await makeSourceRepo(join(dir, "source-repo"));
    const canary = join(dir, "canary.log");
    try {
      const first = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(first.ok, true, first.error ?? "");
      const path = join(dir, "worktrees", "wc1");
      const gitDir = join(path, ".git");
      const smudge = plantCommand(join(dir, "smudge-canary"), canary, "filter:smudge");
      const clean = plantCommand(join(dir, "clean-canary"), canary, "filter:clean");
      const gpg = plantCommand(join(dir, "gpg-canary"), canary, "gpg:program");
      const credential = plantCommand(join(dir, "credential-canary"), canary, "credential:helper");
      const uploadPack = plantCommand(join(dir, "upload-pack-canary"), canary, "remote:uploadpack");
      const fsmonitor = plantCommand(join(dir, "fsmonitor-canary"), canary, "core:fsmonitor");
      const hooks = join(dir, "planted-hooks");
      await mkdir(hooks, { recursive: true });
      plantCommand(join(hooks, "post-checkout"), canary, "hook:post-checkout");
      for (const [key, value] of [
        ["filter.evil.smudge", `${smudge} %f`],
        ["filter.evil.clean", `${clean} %f`],
        ["filter.evil.required", "true"],
        ["commit.gpgsign", "true"],
        ["gpg.program", gpg],
        ["credential.helper", credential],
        [`url.${join(dir, "nowhere")}.insteadOf`, source.url],
        ["remote.origin.uploadpack", uploadPack],
        ["core.fsmonitor", fsmonitor],
        ["core.hooksPath", hooks],
      ]) git(path, ["config", "--local", key!, value!]);
      await writeFile(join(gitDir, "info", "attributes"), "* filter=evil\n");
      await writeFile(join(gitDir, "config.worktree"), "[core]\n\tfsmonitor = true\n");

      await rm(join(path, "README.md"));
      execFileSync("git", ["-C", path, "checkout", "--", "README.md"], { stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
      const unguarded = firedCanaries(canary);
      assert.ok(unguarded.includes("core:fsmonitor") && unguarded.includes("filter:smudge"), `unguarded checkout must run the planted config: ${unguarded.join(",")}`);
      await rm(canary, { force: true });

      await writeFile(join(source.path, "third.txt"), "third\n");
      git(source.path, ["add", "-A"]);
      git(source.path, ["commit", "-q", "-m", "third"]);
      const second = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(second.ok, true, second.error ?? "");
      assert.equal(second.reused, true);
      assert.equal(git(path, ["rev-parse", "HEAD"]), git(source.path, ["rev-parse", "HEAD"]));
      assert.equal(readFileSync(join(path, "third.txt"), "utf8"), "third\n");
      assert.deepEqual(firedCanaries(canary), []);
      const config = readFileSync(join(gitDir, "config"), "utf8");
      for (const planted of ["filter", "gpg", "credential", "insteadOf", "uploadpack", "canary", "planted-hooks"]) {
        assert.ok(!config.toLowerCase().includes(planted.toLowerCase()), `${planted} survived the host-owned rewrite:\n${config}`);
      }
      assert.equal(git(path, ["config", "--local", "core.hooksPath"]), "/dev/null");
      assert.equal(git(path, ["config", "--local", "--type=bool", "core.fsmonitor"]), "false");
      assert.equal(git(path, ["config", "--local", "remote.origin.url"]), source.url);
      assert.equal(existsSync(join(gitDir, "config.worktree")), false);

      git(path, ["config", "--local", "remote.origin.url", "file:///elsewhere/other-repo"]);
      const foreign = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(foreign.ok, false);
      assert.match(foreign.error ?? "", /different repo/u);
    } finally {
      await controller.close();
    }
  });
});

test("the host-owned rewrite never follows a planted symlink, keeps branch tracking, and the listing never rewrites", async () => {
  await withTempStore(async (dir) => {
    const controller = buildController();
    const provision = controller.methods.provision!;
    const listCheckouts = controller.methods.listCheckouts!;
    const source = await makeSourceRepo(join(dir, "source-repo"));
    const canary = join(dir, "canary.log");
    try {
      const first = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(first.ok, true, first.error ?? "");
      const path = join(dir, "worktrees", "wc1");
      const gitDir = join(path, ".git");
      assert.equal(git(path, ["config", "--local", "branch.main.remote"]), "origin");
      assert.equal(git(path, ["config", "--local", "branch.main.merge"]), "refs/heads/main");

      const hostFile = join(dir, "HOST-OWNED-FILE");
      await writeFile(hostFile, "precious host content\n");
      symlinkSync(hostFile, join(gitDir, "config.hive-owned"));
      git(path, ["config", "--local", "user.name", "planted"]);
      git(path, ["config", "--local", "remote.extra.url", "file:///elsewhere/extra"]);
      git(path, ["config", "--local", "filter.evil.clean", `${plantCommand(join(dir, "clean-canary"), canary, "filter:clean")} %f`]);
      await writeFile(join(gitDir, "info", "attributes"), "* filter=evil\n");
      const before = readFileSync(join(gitDir, "config"), "utf8");
      await writeFile(join(path, "dirty.txt"), "dirty\n");

      const rows = (await listCheckouts({}, ctx)) as Array<{ name: string; dirty?: boolean; repo?: string | null }>;
      const row = rows.find((candidate) => candidate.name === "wc1");
      assert.ok(row);
      assert.equal(row.dirty, true);
      assert.equal(row.repo, source.url);
      assert.equal(readFileSync(join(gitDir, "config"), "utf8"), before, "listing must not rewrite a live checkout's config");
      assert.deepEqual(firedCanaries(canary), [], "listing status must not run a planted clean filter");
      assert.equal(readFileSync(hostFile, "utf8"), "precious host content\n");

      await rm(join(path, "dirty.txt"));
      const second = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(second.ok, true, second.error ?? "");
      assert.equal(readFileSync(hostFile, "utf8"), "precious host content\n", "the staged rewrite must never follow a planted symlink");
      assert.equal(lstatSync(join(gitDir, "config")).isSymbolicLink(), false);
      assert.equal(lstatSync(join(gitDir, "config.hive-owned")).isSymbolicLink(), true);
      assert.equal(git(path, ["config", "--local", "branch.main.remote"]), "origin");
      assert.equal(git(path, ["config", "--local", "branch.main.merge"]), "refs/heads/main");
      assert.deepEqual(firedCanaries(canary), []);

      await mkdir(join(gitDir, "config.worktree"));
      const blocked = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(blocked.ok, false);
      assert.match(blocked.error ?? "", /config\.worktree is a directory/u);
      await rm(join(gitDir, "config.worktree"), { recursive: true });

      const bee = "attached-bee";
      await ensureHsrRunDir(bee);
      await writeHsrMeta(bee, {
        bee,
        harness: "stub",
        tier: "stream",
        hostPid: process.pid,
        startedAt: new Date().toISOString(),
        controlSocket: "/tmp/unused.sock",
        status: "running",
      });
      await writeRemoteHsrLaunchReceipt({
        version: REMOTE_HSR_SAFETY_PROTOCOL,
        bee,
        launchId: "1".repeat(64),
        incarnation: "2".repeat(64),
        requestDigest: "3".repeat(64),
        state: "running",
        createdAt: new Date().toISOString(),
        cwd: join(path, "sub"),
        tier: "stream",
        host: { hostPid: process.pid, startedAt: new Date().toISOString(), hostFingerprint: { pgid: process.pid, startedAt: "attached-bee-birth" } },
      });
      const inUse = (await provision({ repo: source.url, branch: "main", name: "wc1" }, ctx)) as ProvisionResult;
      assert.equal(inUse.ok, false);
      assert.match(inUse.error ?? "", /in use by bee attached-bee/u);
      await rm(join(dir, "hsr"), { recursive: true, force: true });
    } finally {
      await controller.close();
    }
  });
});
