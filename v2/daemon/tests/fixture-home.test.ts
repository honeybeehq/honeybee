import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { forceStopTestDaemon, makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

test("daemon fixture isolates HOME and every XDG directory, disables gateway registration and preserves explicit disposable overrides", { timeout: 90_000 }, async t => {
  const root = makeDaemonDir();
  const handles: DaemonHandle[] = [];
  const capture = join(root.dir, "environment.json");
  const preload = join(root.dir, "capture.mjs");
  writeFileSync(preload, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(Object.fromEntries(['HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','HIVE_GATEWAYS_DISABLE'].map(k=>[k,process.env[k]]))));`);
  t.after(async () => { await Promise.all(handles.map(forceStopTestDaemon)); root.cleanup(); });
  for (const explicit of [false, true]) {
    const daemon = await startDaemon(root.dir, { env: { NODE_OPTIONS: `--import=${preload}`, ...(explicit ? { HOME: join(root.dir, "explicit-home"), XDG_CACHE_HOME: join(root.dir, "explicit-cache") } : {}) }, stopTimeoutMs: 30_000 });
    handles.push(daemon);
    const env = JSON.parse(readFileSync(capture, "utf8")) as Record<string, string>;
    assert.notEqual(realpathSync(env.HOME!), realpathSync(userInfo().homedir));
    assert.equal(env.HIVE_GATEWAYS_DISABLE, "1");
    for (const key of explicit ? ["HOME", "XDG_CACHE_HOME"] : ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) assert.ok(realpathSync(env[key]!).startsWith(realpathSync(root.dir) + "/"));
    if (explicit) for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) assert.equal(env[key], undefined);
    if (explicit) { assert.equal(env.HOME, join(root.dir, "explicit-home")); assert.equal(env.XDG_CACHE_HOME, join(root.dir, "explicit-cache")); }
    await daemon.stop();
  }
  await assert.rejects(startDaemon(root.dir, { env: { HOME: userInfo().homedir } }), /HOME must differ/);
});

test("fixture child preload rejects a real HOME before child code executes", () => {
  const guard = fileURLToPath(new URL("./fixtures/isolated-home.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, ["--import", guard, "-e", "process.exit(0)"], { env: { ...process.env, HOME: userInfo().homedir }, stdio: "pipe" }), /Command failed/);
});
