import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nodePinFile, nodeRepairFile, persistNodePin, probeNativeNode, validateDaemonNode } from "../../../src/nodeRuntime.ts";
import { ConfigError, defaultDataDir } from "../src/config.ts";
import { resolveDaemonConfig, runDaemon } from "../src/main.ts";

async function withEntryDir(fn: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "hb-entry-path-"));
  const previousCwd = process.cwd(), previousDataDir = process.env.HIVE_V2_DATA_DIR;
  process.chdir(root);
  process.env.HIVE_V2_DATA_DIR = join(root, "default");
  try { await fn(root); }
  finally {
    process.chdir(previousCwd);
    if (previousDataDir === undefined) delete process.env.HIVE_V2_DATA_DIR;
    else process.env.HIVE_V2_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const source of ["flag", "env"] as const) test(`daemon entry resolves relative ${source} data-dir before config and Node pin effects`, async () => {
  await withEntryDir(async root => {
    const data = join(root, "data");
    const args = source === "flag" ? { dataDir: "./data" } : {};
    if (source === "env") process.env.HIVE_V2_DATA_DIR = "./data";
    assert.equal(resolveDaemonConfig(args).dataDir, data);
    assert.deepEqual(readdirSync(root), []);
    const pin = probeNativeNode(process.execPath);
    persistNodePin(data, { ...pin, version: "0.0.0" });
    writeFileSync(join(data, "config.json"), JSON.stringify({ tickMs: 71 }));
    assert.equal(resolveDaemonConfig(args).tickMs, 71);
    assert.equal(await runDaemon(source === "flag" ? ["--data-dir", "./data"] : []), 0);
    assert.equal(JSON.parse(readFileSync(nodeRepairFile(data), "utf8")).state, "held");
    assert.deepEqual(readdirSync(root), ["data"]);
    assert.equal(existsSync(join(data, "core.sqlite3")), false);
    assert.equal(existsSync(join(data, "hived.sock")), false);
  });
});

test("daemon entry without a data-dir flag keeps defaultDataDir", async () => {
  await withEntryDir(root => {
    assert.equal(resolveDaemonConfig({}).dataDir, defaultDataDir());
    assert.equal(resolveDaemonConfig({}).dataDir, join(root, "default"));
    assert.deepEqual(readdirSync(root), []);
  });
});

for (const cwd of ["fixture", "/"] as const) {
  for (const invalid of ["empty flag", "empty env", "missing value", "option as value", "filesystem root"] as const) {
    test(`daemon entry refuses ${invalid} before any write with cwd ${cwd}`, async () => {
      await withEntryDir(async root => {
        if (cwd === "/") process.chdir("/");
        if (invalid === "empty env") process.env.HIVE_V2_DATA_DIR = "";
        const argv = invalid === "empty flag" ? ["--data-dir", ""]
          : invalid === "missing value" ? ["--data-dir"]
          : invalid === "filesystem root" ? ["--data-dir", "/"]
          : invalid === "option as value" ? ["--data-dir", "--socket", "./socket"] : [];
        const beforeRoot = readdirSync(root).sort(), beforeCwd = readdirSync(process.cwd()).sort();
        const expected = invalid === "filesystem root" ? "daemon run: --data-dir must not be the filesystem root" : "daemon run: --data-dir requires a non-empty path";
        await assert.rejects(runDaemon(argv), (error: unknown) => error instanceof ConfigError && error.message === expected);
        assert.deepEqual(readdirSync(root).sort(), beforeRoot);
        assert.deepEqual(readdirSync(process.cwd()).sort(), beforeCwd);
      });
    });
  }
}

test("daemon entry refuses a relative path resolving to root before Node pin effects", async () => {
  await withEntryDir(async root => {
    process.chdir("/");
    const before = readdirSync("/").sort();
    await assert.rejects(runDaemon(["--data-dir", "."]), (error: unknown) => error instanceof ConfigError && error.message === "daemon run: --data-dir must not be the filesystem root");
    assert.deepEqual(readdirSync("/").sort(), before);
    assert.deepEqual(readdirSync(root), []);
  });
});

for (const corrupt of [false, true]) test(`daemon entry holds before store/socket open on ${corrupt ? "corrupt record" : "identity drift"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-node-entry-")), data = join(root, "v2");
  try {
    const pin = probeNativeNode(process.execPath);
    persistNodePin(data, { ...pin, version: "0.0.0" });
    if (corrupt) writeFileSync(nodePinFile(data), "corrupt JSON");
    assert.equal(await runDaemon(["--data-dir", data]), 0);
    assert.equal(existsSync(join(data, "core.sqlite3")), false);
    assert.equal(existsSync(join(data, "hived.sock")), false);
    assert.equal(JSON.parse(readFileSync(nodeRepairFile(data), "utf8")).state, "held");
    persistNodePin(data, pin);
    assert.equal(validateDaemonNode(data, true), null);
    assert.equal(existsSync(nodeRepairFile(data)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
