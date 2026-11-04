import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, truncateSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { apiaryToolchainRoot, assertApiaryToolchainMetadata } from "../src/apiaryToolchain.ts";
import { sandboxProtectedPaths, wrapWithSandbox } from "../src/sandbox.ts";
import { withFixtureGateway } from "./sandboxFixture.ts";

function fixture(realNode = false) {
  const parent = mkdtempSync("/tmp/hb-apiary-node-");
  const home = join(parent, "home");
  const base = join(home, ".local", "share", "apiary-satellite");
  const root = join(base, "node-v24.18.0-linux-x64");
  mkdirSync(join(root, "bin"), {recursive: true, mode: 0o700});
  if (realNode) copyFileSync(process.execPath, join(root, "bin", "node"));
  else writeFileSync(join(root, "bin", "node"), "fixture-node");
  chmodSync(join(root, "bin", "node"), 0o755);
  const node = join(root, "bin", "node");
  return {parent, home, base, root, node, uid: process.geteuid!()};
}

const dispose = (path: string) => { try { rmSync(path, {recursive: true, force: true}); } catch (error) { console.error(error); process.exitCode = 1; } };

test("Apiary Node accepts only the exact immutable version leaf", () => {
  const f = fixture();
  try {
    assert.equal(apiaryToolchainRoot(f.node, f.home, f.uid), f.root);
    assert.equal(apiaryToolchainRoot("/usr/bin/node", f.home, f.uid), null);
    assert.throws(() => apiaryToolchainRoot(join(f.base, "node-v24.18.0-linux-x64.tmp", "bin", "node"), f.home, f.uid), /name refused/);
    assert.throws(() => apiaryToolchainRoot(join(f.base, "node-v24.18.0-linux-ppc64", "bin", "node"), f.home, f.uid), /name refused/);
    assert.ok(sandboxProtectedPaths(f.home).includes(f.base));
  } finally { dispose(f.parent); }
});

test("Apiary Node checks every ancestor and tree mode and owner each launch", () => {
  const f = fixture();
  try {
    for (const path of [f.home, join(f.home, ".local"), join(f.home, ".local", "share"), f.base, f.root, join(f.root, "bin"), f.node]) {
      const mode = statSync(path).mode & 0o777;
      chmodSync(path, mode | 0o020);
      assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /writable mode refused/);
      chmodSync(path, mode);
    }
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid + 1), /owner refused/);
    assert.throws(() => assertApiaryToolchainMetadata({uid: 65534, mode: 0o700}, 65534), /owner refused/);
    chmodSync(f.node, 0o4755);
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /privileged mode refused/);
  } finally { dispose(f.parent); }
});

test("Apiary Node refuses symlinked ancestors and escaping or dangling tree links", () => {
  const f = fixture();
  try {
    const moved = join(f.parent, "moved");
    renameSync(join(f.home, ".local"), moved);
    symlinkSync(moved, join(f.home, ".local"));
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /ancestor refused/);
    rmSync(join(f.home, ".local"));
    renameSync(moved, join(f.home, ".local"));
    writeFileSync(join(f.parent, "outside"), "fixture");
    symlinkSync(join(f.parent, "outside"), join(f.root, "escape"));
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /escapes leaf/);
    rmSync(join(f.root, "escape"));
    symlinkSync(join(f.root, "missing"), join(f.root, "dangling"));
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /ENOENT/);
    rmSync(join(f.root, "dangling"));
    renameSync(join(f.root, "bin"), join(f.root, "actual-bin"));
    symlinkSync("actual-bin", join(f.root, "bin"));
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /ancestor refused/);
    rmSync(join(f.root, "bin"));
    renameSync(join(f.root, "actual-bin"), join(f.root, "bin"));
    symlinkSync("node", join(f.root, "bin", "node-alias"));
    assert.equal(apiaryToolchainRoot(f.node, f.home, f.uid), f.root);
  } finally { dispose(f.parent); }
});

test("Apiary Node refuses special files and bounded-tree overflow", {skip: process.platform !== "linux"}, () => {
  const f = fixture();
  try {
    const special = join(f.root, "pipe");
    assert.equal(spawnSync("mkfifo", [special]).status, 0);
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /entry refused/);
    rmSync(special);
    const large = join(f.root, "large"); writeFileSync(large, "", {mode: 0o600}); truncateSync(large, 512 * 1024 * 1024 + 1);
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /byte limit/);
    rmSync(large);
    let nested = f.root;
    for (let i = 0; i < 18; i++) { nested = join(nested, "deep"); mkdirSync(nested, {mode: 0o700}); }
    assert.throws(() => apiaryToolchainRoot(f.node, f.home, f.uid), /tree exceeds/);
  } finally { dispose(f.parent); }
});

test("a Cell cannot write the validated fixture Node leaf", {skip: process.platform !== "linux"}, () => {
  const f = fixture(true);
  try {
    apiaryToolchainRoot(f.node, f.home, f.uid);
    const before = statSync(f.node);
    const cell = join(f.parent, "cell"); mkdirSync(cell);
    const marker = join(f.root, "cell-poison");
    writeFileSync(marker, "control", {flag: "wx"}); rmSync(marker);
    const program = `const fs=require('node:fs');let code;try{const fd=fs.openSync(${JSON.stringify(marker)},'wx');fs.closeSync(fd);fs.unlinkSync(${JSON.stringify(marker)});code='OPENED'}catch(e){code=e.code}console.log(JSON.stringify({fixture:'Apiary Node leaf read-only',code,node:process.execPath}));if(!['EROFS','EACCES'].includes(code))process.exit(1);`;
    const wrapped = wrapWithSandbox(withFixtureGateway({cellDir: cell, writablePaths: []}), f.node, ["-e", program], join(cell, "profile"));
    const result = spawnSync(wrapped.command, wrapped.args, {encoding: "utf8", timeout: 15000});
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const after = statSync(f.node);
    assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
    console.log(result.stdout.trim());
  } finally { dispose(f.parent); }
});
