import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCellRepoBatch } from "../src/cellRepo.ts";
import { CellRepoRefusal, parseCellRepoInspection, type CellRepoIdentity } from "../src/cellRepoProtocol.ts";

const sha = "a".repeat(40);
const clean = { head: sha, status: "", branches: [], stashed: false };

test("repository reports reject malformed fields", () => {
  assert.deepEqual(parseCellRepoInspection(clean), clean);
  for (const value of [null, { ...clean, head: "HEAD" }, { ...clean, extra: true }, { ...clean, branches: [{ ref: "refs/heads/x\u001b", sha }] }]) {
    assert.throws(() => parseCellRepoInspection(value), CellRepoRefusal);
  }
});

test("unconfined operations use the policy backend without requiring a helper", async () => {
  let calls = 0;
  const identity: CellRepoIdentity = { cellsRoot: "/unused", wrapper: "one", spaceDir: "/unused/one/repo", independentInodes: false, sandboxed: false };
  const result = await runCellRepoBatch(identity, { operation: "inspect", ignored: false }, {
    helperPath: "/missing", unconfined: async () => { calls++; return clean; },
  });
  assert.equal(result.head, sha);
  assert.equal(calls, 1);
});

test("confined inspection returns a batch and refuses redirected allocation paths", { skip: process.platform !== "linux" }, async t => {
  mkdirSync(resolve(".cache"), { recursive: true });
  const fixture = mkdtempSync(resolve(".cache/repo-batch-"));
  t.after(() => {
    const result = spawnSync("trash", ["--trash-dir", resolve(".cache/t11o-trash"), fixture], { stdio: "ignore" });
    assert.equal(result.status, 0);
  });
  const cellsRoot = join(fixture, "cells");
  const spaceDir = join(cellsRoot, "one", "repo");
  mkdirSync(spaceDir, { recursive: true });
  const env = { PATH: "/usr/bin:/bin", HOME: fixture, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const git = (...args: string[]) => {
    const result = spawnSync("/usr/bin/git", args, { cwd: spaceDir, env, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  git("init", "--quiet");
  writeFileSync(join(spaceDir, "file.txt"), "initial\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(spaceDir, "file.txt"), "changed\n");
  const identity: CellRepoIdentity = { cellsRoot, wrapper: "one", spaceDir, independentInodes: true, sandboxed: true };
  const options = { unconfined: async () => { throw new Error("unexpected backend"); } };
  const result = await runCellRepoBatch(identity, { operation: "inspect", ignored: false }, options);
  assert.equal(result.head, head);
  assert.match(result.status, /file\.txt/);
  assert.equal(result.stashed, false);
  await assert.rejects(runCellRepoBatch(identity, { operation: "inspect", ignored: false }, { ...options, helperPath: join(fixture, "missing") }), CellRepoRefusal);
  const redirected = join(cellsRoot, "two");
  symlinkSync(join(cellsRoot, "one"), redirected);
  await assert.rejects(runCellRepoBatch({ ...identity, wrapper: "two", spaceDir: join(redirected, "repo") }, { operation: "inspect", ignored: false }, options), CellRepoRefusal);
  await assert.rejects(runCellRepoBatch({ ...identity, independentInodes: false }, { operation: "inspect", ignored: false }, options), CellRepoRefusal);
});
