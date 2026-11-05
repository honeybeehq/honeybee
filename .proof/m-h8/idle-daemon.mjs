#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name), value = at < 0 ? fallback : args[at + 1];
  assert.ok(value !== undefined && !String(value).startsWith("--"), `${name} requires a value`);
  return value;
}
const root = resolve(option("--root", "."));
const out = resolve(option("--out", ".proof/m-h8/idle-daemon.json"));
const bees = Number(option("--bees", "1000"));
const generations = Number(option("--generations", "5"));
const policyBees = Number(option("--policy-bees", "100"));
const live = Number(option("--live", "30"));
const hung = Number(option("--hung", "5"));
const seconds = Number(option("--seconds", "60"));
const settleMs = Number(option("--settle-ms", "15000"));
const lsRuns = Number(option("--ls-runs", "20"));
const rpcRuns = Number(option("--rpc-runs", "100"));
const tickMs = Number(option("--tick-ms", "200"));
const perfDir = option("--perf-dir", "");
const cpuProfDir = option("--cpu-prof-dir", "");
assert.ok(hung <= live);

const local = (file) => import(pathToFileURL(join(root, file)).href);
const { openCoreStore } = await local("v2/core/src/index.ts");
const { seedStore } = await local("scripts/perf/fixtures.mjs");
const { makeDaemonDir, startDaemon, waitFor, sleep } = await local("v2/daemon/tests/helpers.ts");
const git = (...a) => { const r = spawnSync("git", a, { cwd: root, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const revision = git("rev-parse", "HEAD"), status = git("status", "--porcelain");

const { dir, cleanup } = makeDaemonDir({ tickMs, naming: { auto: true, command: "echo scratch-title" } });
const storePath = join(dir, "core.sqlite3");
{
  const store = openCoreStore(storePath);
  seedStore(store, bees, generations);
  store.transact(() => {
    let enabled = 0;
    for (let i = 0; i < bees && enabled < policyBees; i++) {
      const id = `perf-${i}`;
      if (store.getBee(id)?.lifecycle !== "active") continue;
      store.setHumanFirstPolicy(id, true);
      store.setMailBatchingPolicy(id, true);
      enabled += 1;
    }
  });
  store.close();
}

function cpuOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticksPerSecond = 100;
  return (Number(fields[11]) + Number(fields[12])) / ticksPerSecond;
}

const daemon = await startDaemon(dir, { env: { ...(perfDir ? { HIVE_PERF_DIR: resolve(perfDir), HIVE_PERF_DURATION_MS: String(settleMs + seconds * 1000 + 30000) } : {}), ...(cpuProfDir ? { NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${resolve(cpuProfDir)}` } : {}) } });
let report;
try {
  const client = await daemon.client();
  const liveIds = [];
  for (let i = 0; i < live; i++) {
    const spawned = await client.request("spawn", { name: `live-${i}`, agent: "stub", cwd: "/tmp" }, 30_000);
    liveIds.push(spawned.beeId);
  }
  await waitFor(async () => {
    const { views } = await client.request("list", {});
    const idle = views.filter((v) => liveIds.includes(v.view.beeId) && v.view.runtimeState === "idle").length;
    return idle === live;
  }, "live stub bees idle", 120_000, 100);
  for (let i = 0; i < hung; i++) {
    await client.request("send", { beeId: liveIds[i], body: "@hang", urgency: "next" });
  }
  await waitFor(async () => {
    const { views } = await client.request("list", {});
    return views.filter((v) => liveIds.slice(0, hung).includes(v.view.beeId) && v.view.runtimeState === "running").length === hung;
  }, "hung bees running", 60_000, 100);
  for (let i = 0; i < hung; i++) {
    await client.request("send", { beeId: liveIds[i], body: "held until idle", urgency: "idle" });
  }
  await sleep(settleMs);
  const statusBefore = await client.request("health", {});
  const cpuBefore = cpuOf(daemon.proc.pid), wallBefore = performance.now(), loadBefore = loadavg();
  await sleep(seconds * 1000);
  const cpuAfter = cpuOf(daemon.proc.pid), wallAfter = performance.now();
  const statusAfter = await client.request("health", {});
  const ticks = statusAfter.ticks - statusBefore.ticks;
  const cpuSeconds = cpuAfter - cpuBefore;
  const { views } = await client.request("list", {});
  const pendingHeld = views.filter((v) => liveIds.slice(0, hung).includes(v.view.beeId) && v.view.runtimeState === "running").length;
  const rpcMs = [];
  for (let i = 0; i < rpcRuns; i++) {
    const t = performance.now();
    await client.request("list", {});
    rpcMs.push(performance.now() - t);
  }
  client.close();
  const cliMs = [];
  const cliEnv = { ...process.env, HIVE_V2_DATA_DIR: dir, HOME: join(dir, "cli-home"), HIVE_NO_KEYCHAIN: "1" };
  mkdirSync(cliEnv.HOME, { recursive: true });
  for (let i = 0; i < lsRuns; i++) {
    const t = performance.now();
    const r = spawnSync(process.execPath, [join(root, "v2/cli/src/bin.ts"), "ls", "--json", "--data-dir", dir, "--socket", daemon.socketPath], { env: cliEnv, encoding: "utf8" });
    cliMs.push(performance.now() - t);
    assert.equal(r.status, 0, r.stderr);
  }
  const sorted = (xs) => [...xs].sort((a, b) => a - b);
  const pct = (xs, p) => sorted(xs)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const dist = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length });
  report = {
    timestamp: new Date().toISOString(), hostname: hostname(), node: process.version, revision, dirty: status.length > 0,
    workload: { bees, generations, activeBees: Math.ceil(bees / 10), policyBees, live, hung, tickMs, settleMs, seconds, pendingHeldObserved: pendingHeld, namingAuto: true },
    idle: { cpuSeconds, wallSeconds: (wallAfter - wallBefore) / 1000, cpuPercent: (100 * cpuSeconds) / ((wallAfter - wallBefore) / 1000), ticks, cpuMsPerTick: ticks ? (1000 * cpuSeconds) / ticks : null, tickErrors: statusAfter.tickErrors - statusBefore.tickErrors, loadBefore, loadAfter: loadavg() },
    listRpcMs: dist(rpcMs), hiveLsCliMs: dist(cliMs), rawListRpcMs: rpcMs, rawHiveLsCliMs: cliMs,
    scope: "Real hived scratch daemon in a temp dir with its own socket, stopped seeded bees, live stub runtimes (hung ones holding idle mail), mail batching and human-first on the policy bees, auto-title on. CPU from /proc utime+stime over the idle window. RPC list latency in-process; hive ls wall time includes CLI process startup.",
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ out, idle: report.idle, listRpcMs: report.listRpcMs, hiveLsCliMs: report.hiveLsCliMs }, null, 2));
} finally {
  await daemon.stop();
  cleanup();
}
