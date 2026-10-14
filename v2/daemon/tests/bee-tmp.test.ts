import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  beeTmpDir,
  beeTmpName,
  describeBeeTmpPolicy,
  ensureBeeTmpEnv,
  removeBeeTmpDir,
  resolveBeeTmpPolicy,
  sweepBeeTmpDirs,
} from "../src/beeTmp.ts";
import { DatabaseSync } from "node:sqlite";
import { loadNodeConfig } from "../src/config.ts";
import type { HealthResult, MailboxResult, MutationResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { AGENT_PATH, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tmp-probe", "probe.mjs");

interface ProbeReport {
  TMPDIR: string | null;
  tmpdir: string;
  NODE_COMPILE_CACHE: string | null;
  cacheStatus: number;
  cacheDirectory: string | null;
  cacheEntries: number;
  tmpWritable: boolean;
}

test("policy: bees.tmpRoot wins, absent defaults by nodeKind, null turns it off", () => {
  assert.equal(resolveBeeTmpPolicy("workstation", undefined, {}, "/h"), null);
  assert.equal(resolveBeeTmpPolicy("cloud", undefined, { XDG_CACHE_HOME: "/x" }, "/h"), null);
  assert.equal(resolveBeeTmpPolicy("satellite", null, {}, "/h"), null);
  assert.deepEqual(resolveBeeTmpPolicy("satellite", undefined, {}, "/h"), {
    source: "satellite_default",
    root: "/h/.cache/honeybee/tmp",
    daemonDir: "/h/.cache/honeybee/tmp/daemon",
    compileCache: "/h/.cache/honeybee/node-compile-cache",
  });
  assert.equal(resolveBeeTmpPolicy("satellite", undefined, { XDG_CACHE_HOME: "/x" }, "/h")?.root, "/x/honeybee/tmp");
  assert.equal(resolveBeeTmpPolicy("satellite", undefined, { XDG_CACHE_HOME: "rel" }, "/h")?.root, "/h/.cache/honeybee/tmp");
  const explicit = resolveBeeTmpPolicy("workstation", "/data/bee-tmp", { XDG_CACHE_HOME: "/x" }, "/h");
  assert.deepEqual(explicit, {
    source: "config",
    root: "/data/bee-tmp",
    daemonDir: "/data/bee-tmp/daemon",
    compileCache: "/x/honeybee/node-compile-cache",
  });
  assert.equal(resolveBeeTmpPolicy("workstation", "~/t", {}, "/h")?.root, "/h/t");
  assert.equal(describeBeeTmpPolicy(null), "tmp.policy beeTmpRoot=off");
  assert.match(describeBeeTmpPolicy(explicit), /^tmp\.policy beeTmpRoot=\/data\/bee-tmp source=config daemonTmp=\/data\/bee-tmp\/daemon nodeCompileCache=\/x\/honeybee\/node-compile-cache$/);
});

test("config: bees.tmpRoot is additive and validated", () => {
  const rig = makeDaemonDir();
  try {
    const write = (bees: unknown): void => {
      const path = join(rig.dir, "config.json");
      writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), bees }));
    };
    assert.equal("beeTmpRoot" in loadNodeConfig(rig.dir), false);
    write({});
    assert.equal("beeTmpRoot" in loadNodeConfig(rig.dir), false);
    write({ tmpRoot: null });
    assert.equal(loadNodeConfig(rig.dir).beeTmpRoot, null);
    write({ tmpRoot: "~/.cache/honeybee/tmp" });
    assert.equal(loadNodeConfig(rig.dir).beeTmpRoot, "~/.cache/honeybee/tmp");
    write({ tmpRoot: "/abs" });
    assert.equal(loadNodeConfig(rig.dir).beeTmpRoot, "/abs");
    for (const bad of [{ tmpRoot: "rel" }, { tmpRoot: "" }, { tmpRoot: 3 }]) {
      write(bad);
      assert.throws(() => loadNodeConfig(rig.dir), /bees\.tmpRoot/);
    }
    write([]);
    assert.throws(() => loadNodeConfig(rig.dir), /bees must be an object/);
  } finally {
    rig.cleanup();
  }
});

test("names: safe ids map to themselves; unsafe ids and the daemon name hash into one segment", () => {
  assert.equal(beeTmpName("15ecdadc-f4b1-4265-9fac-9516a5ada650"), "15ecdadc-f4b1-4265-9fac-9516a5ada650");
  for (const id of ["../escape", "daemon", "a/b", ".hidden", "x".repeat(200), "ünï"]) {
    const name = beeTmpName(id);
    assert.match(name, /^~[0-9a-f]{32}$/);
    assert.equal(name, beeTmpName(id));
  }
});

test("dirs: ensure creates, remove deletes, sweep keeps daemon and kept bees", () => {
  const rig = makeDaemonDir();
  try {
    const policy = resolveBeeTmpPolicy("satellite", undefined, { XDG_CACHE_HOME: join(rig.dir, "cache") })!;
    mkdirSync(policy.daemonDir, { recursive: true });
    const a = ensureBeeTmpEnv(policy, "a");
    const b = ensureBeeTmpEnv(policy, "../b");
    assert.equal(a.TMPDIR, beeTmpDir(policy, "a"));
    assert.ok(existsSync(a.TMPDIR) && existsSync(b.TMPDIR) && existsSync(a.NODE_COMPILE_CACHE));
    writeFileSync(join(a.TMPDIR, "f"), "x");
    assert.equal(removeBeeTmpDir(policy, "a"), true);
    assert.equal(existsSync(a.TMPDIR), false);
    ensureBeeTmpEnv(policy, "c");
    mkdirSync(join(policy.root, "foreign"));
    assert.deepEqual(sweepBeeTmpDirs(policy, ["../b", "never-created"]), [beeTmpName("../b")]);
    assert.ok(existsSync(policy.daemonDir) && existsSync(beeTmpDir(policy, "c")) && existsSync(join(policy.root, "foreign")), "the sweep only touches the released bees it was given");
  } finally {
    rig.cleanup();
  }
});

async function runProbe(opts: { nodeKind?: "satellite"; bees?: { tmpRoot?: string | null }; env?: Record<string, string>; inheritedTmp: string }): Promise<{
  report: ProbeReport;
  beeId: string;
  cache: string;
  daemon: DaemonHandle;
  cleanup: () => Promise<void>;
}> {
  const outDir = join(opts.inheritedTmp, "probe-out");
  mkdirSync(outDir, { recursive: true });
  const rig = makeDaemonDir({
    ...(opts.nodeKind ? { nodeKind: opts.nodeKind } : {}),
    ...(opts.bees ? { bees: opts.bees } : {}),
    agents: {
      probe: {
        command: process.execPath,
        args: ["--import", PROBE, AGENT_PATH],
        adapter: "stub",
        env: { STUB_TURN_MS: "10", PROBE_OUT_DIR: outDir },
      },
    },
  });
  const cache = join(rig.dir, "xdg-cache");
  const daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache, TMPDIR: opts.inheritedTmp, ...(opts.env ?? {}) } });
  const client = await daemon.client();
  const spawned = await client.request<SpawnResult>("spawn", { name: "tmp-probe", agent: "probe", cwd: rig.dir });
  const path = join(outDir, `${spawned.beeId}.json`);
  const report = await waitFor(() => existsSync(path) && JSON.parse(readFileSync(path, "utf8")) as ProbeReport, "probe report", 30_000);
  const view = await client.request<ViewResult>("view", { beeId: spawned.beeId, revealEnv: true });
  assert.equal(view.bee?.env.TMPDIR, undefined, "daemon-set tmp env never lands in the stored bee env");
  assert.equal(view.bee?.env.NODE_COMPILE_CACHE, undefined);
  client.close();
  return {
    report,
    beeId: spawned.beeId,
    cache,
    daemon,
    cleanup: async () => {
      await daemon.stop();
      rig.cleanup();
    },
  };
}

test("satellite daemon: per-bee TMPDIR, shared compile cache, removed on archive after stop", { timeout: 90_000 }, async () => {
  const inherited = makeDaemonDir();
  const run = await runProbe({ nodeKind: "satellite", inheritedTmp: inherited.dir });
  try {
    const beeTmp = join(run.cache, "honeybee", "tmp", run.beeId);
    const compileCache = join(run.cache, "honeybee", "node-compile-cache");
    assert.equal(run.report.TMPDIR, beeTmp);
    assert.equal(run.report.tmpdir, beeTmp);
    assert.equal(run.report.NODE_COMPILE_CACHE, compileCache);
    assert.ok(run.report.cacheDirectory?.startsWith(`${compileCache}/`), run.report.cacheDirectory ?? "no cache dir");
    assert.ok(run.report.cacheEntries > 0, "enableCompileCache wrote entries under the shared cache");
    assert.equal(run.report.tmpWritable, true);
    assert.ok(existsSync(beeTmp));
    assert.ok(existsSync(join(run.cache, "honeybee", "tmp", "daemon")));
    assert.match(run.daemon.output() + readFileSync(join(run.daemon.dir, "hived.log"), "utf8"), /tmp\.policy beeTmpRoot=\S+ source=satellite_default /);

    const client = await run.daemon.client();
    await client.request<MutationResult>("archive", { beeId: run.beeId });
    await client.request<MutationResult>("stop", { beeId: run.beeId });
    await waitFor(() => !existsSync(beeTmp), "archived bee tmp removed", 30_000);
    client.close();
  } finally {
    await run.cleanup();
    inherited.cleanup();
  }
});

test("bees.tmpRoot turns it on for a node whose nodeKind is unset, and null turns a satellite off", { timeout: 90_000 }, async () => {
  const inherited = makeDaemonDir();
  const root = join(inherited.dir, "configured-root");
  const on = await runProbe({ bees: { tmpRoot: root }, inheritedTmp: inherited.dir });
  try {
    assert.equal(on.report.TMPDIR, join(root, on.beeId));
    assert.equal(on.report.NODE_COMPILE_CACHE, join(on.cache, "honeybee", "node-compile-cache"));
    assert.match(readFileSync(join(on.daemon.dir, "hived.log"), "utf8"), new RegExp(`tmp\\.policy beeTmpRoot=${root} source=config `));
  } finally {
    await on.cleanup();
  }
  const off = await runProbe({ nodeKind: "satellite", bees: { tmpRoot: null }, inheritedTmp: inherited.dir });
  try {
    assert.equal(off.report.TMPDIR, inherited.dir);
    assert.equal(existsSync(join(off.cache, "honeybee")), false);
    assert.match(readFileSync(join(off.daemon.dir, "hived.log"), "utf8"), /tmp\.policy beeTmpRoot=off/);
  } finally {
    await off.cleanup();
    inherited.cleanup();
  }
});

test("workstation daemon: TMPDIR and compile cache are inherited unchanged", { timeout: 90_000 }, async () => {
  const inherited = makeDaemonDir();
  const inheritedCache = join(inherited.dir, "inherited-compile-cache");
  const run = await runProbe({ env: { NODE_COMPILE_CACHE: inheritedCache }, inheritedTmp: inherited.dir });
  try {
    assert.equal(run.report.TMPDIR, inherited.dir);
    assert.equal(run.report.NODE_COMPILE_CACHE, inheritedCache);
    assert.equal(existsSync(join(run.cache, "honeybee")), false);
    assert.match(readFileSync(join(run.daemon.dir, "hived.log"), "utf8"), /tmp\.policy beeTmpRoot=off/);
  } finally {
    await run.cleanup();
    inherited.cleanup();
  }
});

test("a restart that turns the policy on keeps reaching the surviving runner: same generation, mail delivered", { timeout: 120_000 }, async () => {
  const inherited = makeDaemonDir();
  const rig = makeDaemonDir({ stubEnv: { STUB_SURVIVE_STDIN_CLOSE: "1" } });
  const cache = join(rig.dir, "xdg-cache");
  const env = { XDG_CACHE_HOME: cache, TMPDIR: inherited.dir };
  let daemon = await startDaemon(rig.dir, { env });
  let pid = 0;
  try {
    let client = await daemon.client();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "survivor", agent: "stub", cwd: rig.dir });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "idle", 30_000);
    pid = (await client.request<ViewResult>("view", { beeId })).runtime?.pid as number;
    client.close();
    await daemon.kill();

    const configPath = join(rig.dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")), nodeKind: "satellite" }));
    daemon = await startDaemon(rig.dir, { env });
    client = await daemon.client();
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /tmp\.policy beeTmpRoot=\S+ source=satellite_default/);
    const health = await client.request<HealthResult>("health");
    assert.equal(health.lastBoot?.adopted, 1);
    const sent = await client.request<SendRpcResult>("send", { beeId, body: "after the policy change" });
    await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
      return messages.find((m) => m.id === sent.messageId)?.deliveredAt != null;
    }, "post-restart delivery", 30_000);
    const rt = (await client.request<ViewResult>("view", { beeId })).runtime;
    assert.equal(rt?.generation, 1);
    assert.equal(rt?.pid, pid);
    client.close();
  } finally {
    await daemon.stop().catch(() => {});
    if (pid > 0) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
    rig.cleanup();
    inherited.cleanup();
  }
});

test("boot sweep removes only this store's archived bees' dirs", { timeout: 90_000 }, async () => {
  const rig = makeDaemonDir({ nodeKind: "satellite" });
  const cache = join(rig.dir, "xdg-cache");
  const root = join(cache, "honeybee", "tmp");
  let daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache } });
  try {
    let client = await daemon.client();
    const kept = await client.request<SpawnResult>("spawn", { name: "kept", agent: "stub", cwd: rig.dir });
    const filed = await client.request<SpawnResult>("spawn", { name: "filed", agent: "stub", cwd: rig.dir });
    for (const beeId of [kept.beeId, filed.beeId]) {
      await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "idle", 30_000);
    }
    await client.request("stop", { beeId: filed.beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: filed.beeId })).view.runtimeState === "stopped", "stopped", 30_000);
    client.close();
    await daemon.stop();
    mkdirSync(join(root, filed.beeId), { recursive: true });
    mkdirSync(join(root, "other-daemons-bee"), { recursive: true });
    const store = new DatabaseSync(join(rig.dir, "core.sqlite3"));
    store.prepare("UPDATE bees SET lifecycle = 'archived', archived_at = 1 WHERE id = ?").run(filed.beeId);
    store.close();

    daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache } });
    client = await daemon.client();
    await client.request<HealthResult>("health");
    assert.equal(existsSync(join(root, filed.beeId)), false, "archived bee's dir swept");
    assert.equal(existsSync(join(root, kept.beeId)), true, "active bee's dir kept");
    assert.equal(existsSync(join(root, "other-daemons-bee")), true, "a dir this store does not know is never touched");
    client.close();
  } finally {
    await daemon.stop().catch(() => {});
    rig.cleanup();
  }
});

test("satellite sandboxed Cell: the per-bee TMPDIR and compile cache are writable inside the sandbox", { timeout: 120_000, skip: process.platform !== "linux" && process.platform !== "darwin" }, async () => {
  const rig = makeDaemonDir({
    nodeKind: "satellite",
    agents: {
      probe: {
        command: process.execPath,
        args: ["--import", PROBE, AGENT_PATH],
        adapter: "stub",
        env: { STUB_TURN_MS: "10", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      },
    },
  });
  const origin = makeOrigin(rig.dir);
  const cache = join(rig.dir, "xdg-cache");
  const daemon = await startDaemon(rig.dir, { env: { XDG_CACHE_HOME: cache }, platform: process.platform });
  try {
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", {
      name: "sandboxed-probe",
      agent: "probe",
      cwd: "/ignored",
      substrate: "cell",
      cell: { originRepo: origin.repo, sandbox: true },
    });
    const early = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    const path = join(early.bee?.cwd as string, `${spawned.beeId}.json`);
    const report = await waitFor(() => existsSync(path) && JSON.parse(readFileSync(path, "utf8")) as ProbeReport, "sandboxed probe report", 90_000);
    const beeTmp = join(cache, "honeybee", "tmp", spawned.beeId);
    assert.equal(report.TMPDIR, beeTmp);
    assert.equal(report.tmpWritable, true, "the per-bee TMPDIR is writable inside the sandbox");
    assert.equal(readFileSync(join(beeTmp, "probe-write"), "utf8"), "ok");
    assert.ok(report.cacheEntries > 0, "the shared compile cache is writable inside the sandbox");
    client.close();
  } finally {
    await daemon.stop();
    rig.cleanup();
  }
});
