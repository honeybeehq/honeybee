import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCellRepoBatch } from "../src/cellRepo.ts";
import { executeCellRepoBatch } from "../src/cellRepoExecutor.ts";
import { inspectProcess, type ProcessIdentity } from "../../harness/src/processIdentity.ts";
import { validatedCellScopeBinary } from "../src/cellScope.ts";
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
  if (spawnSync("trash", ["--help"], { stdio: "ignore" }).error) { t.skip("fixture cleanup utility unavailable"); return; }
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
  const pinned = join(cellsRoot, "one", "pinned");
  const foreign = join(fixture, "other");
  mkdirSync(foreign);
  const selected = await executeCellRepoBatch({ identity, request: { operation: "inspect", ignored: false }, timeoutMs: 5000 }, undefined, undefined, async () => {
    renameSync(spaceDir, pinned);
    symlinkSync(foreign, spaceDir);
    return async () => {
      renameSync(spaceDir, join(fixture, "redirected-link"));
      renameSync(pinned, spaceDir);
    };
  });
  assert.equal(selected.head, head);
  const fake = join(fixture, "waiting.mjs");
  const content = "setInterval(() => {}, 1000);\n";
  writeFileSync(fake, content);
  chmodSync(fake, 0o444);
  writeFileSync(join(fixture, "cell-repo-manifest.json"), JSON.stringify({ version: 1, files: { "waiting.mjs": createHash("sha256").update(content).digest("hex") } }));
  const abort = new AbortController();
  let processIdentity: ProcessIdentity | null = null;
  await assert.rejects(executeCellRepoBatch({ identity, request: { operation: "inspect", ignored: false }, timeoutMs: 5000, helperPath: fake }, abort.signal, process => {
    processIdentity = process;
    setTimeout(() => abort.abort(), 100);
  }), (error: unknown) => error instanceof CellRepoRefusal && error.code === "deadline");
  assert.ok(processIdentity);
  assert.equal(inspectProcess((processIdentity as ProcessIdentity).pid).kind, "gone");
  for (let round = 0; round < 50; round++) {
    const cancel = new AbortController();
    await assert.rejects(executeCellRepoBatch({ identity, request: { operation: "inspect", ignored: false }, timeoutMs: 5000, helperPath: fake }, cancel.signal, () => {
      setTimeout(() => cancel.abort(), 100);
    }), (error: unknown) => error instanceof CellRepoRefusal && error.code === "deadline");
  }
  const scope = validatedCellScopeBinary();
  assert.equal(spawnSync(scope, ["--parent-pid", String(process.pid), "--", "/usr/bin/true"], { env: {}, timeout: 1000 }).status, 0);
  assert.equal(spawnSync(scope, ["--parent-pid", "2147483646", "--", "/usr/bin/true"], { env: {}, timeout: 1000 }).status, 124);
  assert.equal(spawnSync(scope, ["--parent-pid", "1", "--", "/usr/bin/true"], { env: {}, timeout: 1000 }).status, 125);
  let workerProcess: ProcessIdentity | null = null;
  await assert.rejects(runCellRepoBatch(identity, { operation: "inspect", ignored: false }, {
    ...options, helperPath: fake, deadlineMs: 1000, onStarted: process => { workerProcess = process; },
  }), (error: unknown) => error instanceof CellRepoRefusal && error.code === "deadline");
  assert.ok(workerProcess);
  for (let attempt = 0; attempt < 20 && inspectProcess((workerProcess as ProcessIdentity).pid).kind !== "gone"; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(inspectProcess((workerProcess as ProcessIdentity).pid).kind, "gone");
  for (const mode of ["owner", "supervisor", "setup"] as const) {
    const owner = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, [workerData.supervisor], { env: { PATH: "/usr/bin:/bin" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
      parentPort.postMessage({ kind: "supervisor", pid: child.pid });
      if (workerData.mode !== "setup") {
        let output = "";
        child.stdout.on("data", chunk => {
          output += chunk.toString();
          const end = output.indexOf("\\n");
          if (end >= 0) parentPort.postMessage({ kind: "helper", pid: child.pid, helper: JSON.parse(output.slice(0, end)).started });
        });
      }
      child.stdin.write(JSON.stringify(workerData.request) + "\\n");
    `, { eval: true, workerData: { mode, supervisor: resolve("dist/v2/cell-repo-supervisor.js"), request: { identity, request: { operation: "inspect", ignored: false }, timeoutMs: 5000, helperPath: fake } } });
    const receipt = await new Promise<{ pid: number; helper?: ProcessIdentity }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture did not start")), 5000);
      owner.on("message", message => {
        if (mode === "setup" ? message.kind === "supervisor" : message.kind === "helper") { clearTimeout(timer); resolve(message); }
      });
      owner.once("error", reject);
    }).catch(async error => { await owner.terminate(); throw error; });
    const supervisor = inspectProcess(receipt.pid);
    assert.ok(supervisor.kind === "present" && supervisor.pgid === supervisor.pid);
    let first = receipt.helper?.pid;
    if (mode === "setup") {
      for (let attempt = 0; attempt < 1000 && !first; attempt++) {
        first = readFileSync(`/proc/${receipt.pid}/task/${receipt.pid}/children`, "utf8").trim().split(/\s+/).map(Number).find(pid => Number.isSafeInteger(pid) && pid > 0);
        if (!first) await new Promise(resolve => setTimeout(resolve, 1));
      }
    } else await new Promise(resolve => setTimeout(resolve, 100));
    const descendants: ProcessIdentity[] = [];
    const pending = first ? [first] : [];
    while (pending.length > 0) {
      const pid = pending.pop()!;
      const info = inspectProcess(pid);
      if (info.kind !== "present" || info.state !== "live") continue;
      descendants.push({ pid: info.pid, birth: info.birth, bootId: info.bootId });
      for (const word of readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/)) {
        const child = Number(word);
        if (Number.isSafeInteger(child) && child > 0) pending.push(child);
      }
    }
    if (mode !== "owner") {
      const current = inspectProcess(supervisor.pid);
      assert.ok(current.kind === "present" && current.birth === supervisor.birth);
      process.kill(supervisor.pid, "SIGKILL");
    }
    await owner.terminate();
    assert.ok(descendants.length >= (mode === "setup" ? 1 : 2));
    for (let attempt = 0; attempt < 30; attempt++) {
      const live = [supervisor, ...descendants].some(identity => {
        const current = inspectProcess(identity.pid);
        return current.kind === "present" && current.birth === identity.birth && current.state === "live";
      });
      if (!live) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const identity of [supervisor, ...descendants]) {
      const current = inspectProcess(identity.pid);
      assert.ok(current.kind !== "present" || current.birth !== identity.birth || current.state !== "live");
    }
  }
  for (const name of ["commondir", "objects/info/alternates", "objects/info/http-alternates"]) {
    const file = join(spaceDir, ".git", name);
    writeFileSync(file, "unavailable\n");
    await assert.rejects(runCellRepoBatch(identity, { operation: "inspect", ignored: false }, options), (error: unknown) => error instanceof CellRepoRefusal && error.code === "invalid_repository");
    renameSync(file, join(fixture, name.replaceAll("/", "-")));
  }
  renameSync(join(spaceDir, ".git"), join(fixture, "saved-git"));
  writeFileSync(join(spaceDir, ".git"), "gitdir: unavailable\n");
  await assert.rejects(runCellRepoBatch(identity, { operation: "inspect", ignored: false }, options), (error: unknown) => error instanceof CellRepoRefusal && error.code === "invalid_repository");
  renameSync(join(spaceDir, ".git"), join(fixture, "git-pointer"));
  renameSync(join(fixture, "saved-git"), join(spaceDir, ".git"));
  for (let index = 0; index < 3000; index++) writeFileSync(join(spaceDir, `${index}-${"p".repeat(190)}`), "fixture\n");
  await assert.rejects(runCellRepoBatch(identity, { operation: "inspect", ignored: false }, options), (error: unknown) => error instanceof CellRepoRefusal && error.code === "output_limit");
});
