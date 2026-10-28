import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sandboxEnvironment, wrapWithSandbox } from "../src/sandbox.ts";

interface CacheReport {
  writes: boolean[];
  tmpdirIsPrivateTmp: boolean;
  otherTempVisible: boolean;
  otherCacheVisible: boolean;
  tempWritable: boolean;
  cacheWritable: boolean;
}

test("shared cache: Cells cannot write host homes or another bee's TMPDIR, and each TMPDIR is private", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const managedRoot = process.env.HIVE_TEST_SHARED_CACHE_ROOT;
  const root = mkdtempSync(join(managedRoot ?? "/tmp", "hb-shared-cache-"));
  const home = join(root, "home");
  const cells = [join(root, "cell-a"), join(root, "cell-b")];
  const paths = [".cache", ".cache/honeybee/tmp/other-bee", ".config", ".config/systemd", ".config/systemd/user", ".npm", ".bun", ".local/share", ".local/share/muse", ".local/share/pnpm", ".claude", ".claude.json", ".codex", ".gemini", ".grok", "Library/Caches"];
  const marker = "fixture-" + randomUUID();
  const protectedFiles = paths.map(path => path === ".claude.json" ? join(home, path) : join(home, path, marker));
  const tempFiles = cells.map((_, index) => join(root, marker + "-temp-" + index));
  const cacheFiles = cells.map(cell => join(cell, "sandbox-state", "cache", marker));
  const metadata = (path: string) => {
    const info = statSync(path, { bigint: true, throwIfNoEntry: false });
    return info ? [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String) : null;
  };
  const server = createServer(socket => socket.destroy());
  const children: Array<{ child: ReturnType<typeof spawn>; closed: Promise<number | null> }> = [];
  try {
    mkdirSync(home);
    for (const cell of cells) mkdirSync(cell);
    for (const path of paths) {
      if (path === ".claude.json") writeFileSync(join(home, path), "fixture");
      else mkdirSync(join(home, path), { recursive: true });
    }
    const before = paths.map(path => metadata(join(home, path)));
    const gateway = join(root, "gateway.sock");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(gateway, resolve); });
    const launch = async (index: number): Promise<CacheReport> => {
      const cell = cells[index]!;
      const env = sandboxEnvironment(cell, { HOME: home, TMPDIR: join(home, ".cache/honeybee/tmp/other-bee"), PATH: "/usr/bin:/bin" });
      const script = `
        const fs = require('node:fs'), path = require('node:path');
        const paths = ${JSON.stringify(paths)};
        const home = ${JSON.stringify(home)}, marker = ${JSON.stringify(marker)};
        const otherTempVisible = !!fs.statSync(${JSON.stringify(tempFiles[1 - index])}, {throwIfNoEntry:false});
        const otherCacheVisible = !!fs.statSync(${JSON.stringify(cacheFiles[1 - index])}, {throwIfNoEntry:false});
        const writes = paths.map(relative => {
          try {
            const target = path.join(home, relative);
            if (relative !== '.claude.json') fs.mkdirSync(target, {recursive:true});
            fs.writeFileSync(relative === '.claude.json' ? target : path.join(target, marker), 'poison');
            return true;
          } catch { return false; }
        });
        const temp = path.join(process.env.TMPDIR, ${JSON.stringify(basename(root))}, marker + '-temp-' + ${index});
        fs.mkdirSync(path.dirname(temp), {recursive:true});
        fs.writeFileSync(temp, 'private');
        const cache = path.join(process.env.XDG_CACHE_HOME, marker);
        fs.writeFileSync(cache, 'cache');
        console.log(JSON.stringify({writes, tmpdirIsPrivateTmp:process.env.TMPDIR === '/tmp', otherTempVisible, otherCacheVisible, tempWritable:fs.statSync(temp).size === 7, cacheWritable:fs.statSync(cache).size === 5}));
        process.stdin.resume();
        process.stdin.once('end', () => process.exit(0));
      `;
      const command = wrapWithSandbox({ cellDir: cell, writablePaths: [], homePaths: [home], gatewaySocketPath: gateway }, process.execPath, ["-e", script], join(cell, "profile"));
      const child = spawn(command.command, command.args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true, timeout: 15000 });
      const closed = new Promise<number | null>(resolve => { child.once("close", resolve); child.once("error", () => resolve(null)); });
      children.push({ child, closed });
      let stdout = "", stderr = "";
      child.stderr!.on("data", chunk => stderr += chunk);
      return new Promise<CacheReport>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => { if (!stdout.includes("\n")) reject(new Error("fixture did not report: " + stderr)); });
        child.stdout!.on("data", chunk => {
          stdout += chunk;
          const end = stdout.indexOf("\n");
          if (end !== -1) {
            try { resolve(JSON.parse(stdout.slice(0, end))); } catch (error) { reject(error); }
          }
        });
      });
    };
    const first = await launch(0);
    assert.equal(children[0]!.child.exitCode, null);
    const second = await launch(1);
    for (const report of [first, second]) {
      assert.deepEqual(report.writes, paths.map(() => false));
      assert.equal(report.tmpdirIsPrivateTmp, true);
      assert.equal(report.otherTempVisible, false);
      assert.equal(report.otherCacheVisible, false);
      assert.equal(report.tempWritable, true);
      assert.equal(report.cacheWritable, true);
    }
    assert.deepEqual(paths.map(path => metadata(join(home, path))), before);
    for (const path of protectedFiles.filter(path => path !== join(home, ".claude.json"))) assert.equal(metadata(path), null);
    for (const path of tempFiles) assert.equal(metadata(path), null);
    for (const path of cacheFiles) assert.equal(statSync(path).size, 5);
    console.log(JSON.stringify({ fixture: "T11 shared home caches", paths, concurrentCells: 2, protectedWrites: false, hostMetadataUnchanged: true, hostPoisonFilesAbsent: true, hostTempFilesAbsent: true, ownTmpWorks: true, crossCellTmpVisible: false, crossCellCacheVisible: false }));
  } finally {
    for (const { child } of children) child.stdin?.end();
    const exits = await Promise.all(children.map(({ closed }) => closed));
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (!managedRoot) assert.equal(spawnSync("trash", [root]).status, 0);
    assert.deepEqual(exits, children.map(() => 0));
  }
});
