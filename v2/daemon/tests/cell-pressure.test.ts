/**
 * P7 Cell disk pressure in the REAL daemon, on a simulated volume whose only
 * occupant is the Cells root (HIVE_TEST_CELL_VOLUME_BYTES): below the free-space
 * floor the daemon evicts clean Cells of archived bees, then of long-idle
 * stopped bees, oldest first, and stops once the target is reached; dirty,
 * unlanded, live and recently stopped Cells are kept; every eviction and pass
 * is audited; `cellDisk` reports it; an unreachable floor is reported once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { commitInCell, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { measureDirectoryBytes } from "../../driver-cell/src/retention.ts";
import type { CellGcResult, DeployInfoResult, HealthResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { liveRunnerHostPids, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");
const IDLE_AFTER_MS = 15_000;

function writeConfig(dir: string, cellsRoot: string, retention: Record<string, unknown>): void {
  const configPath = join(dir, "config.json");
  const current = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const cells = (current.cells ?? {}) as Record<string, unknown>;
  writeFileSync(configPath, JSON.stringify({ ...current, cells: { ...cells, root: cellsRoot, retention } }));
}

async function spawnIdle(client: RpcClient, name: string, originRepo: string): Promise<{ beeId: string; view: ViewResult }> {
  const spawned = await client.request<SpawnResult>("spawn", { name, agent: "cellstub", substrate: "cell", cell: { originRepo } });
  const view = await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    return v.view.runtimeState === "idle" && v.cell ? v : null;
  }, `${name} idle`, 60_000);
  return { beeId: spawned.beeId, view };
}

async function stop(client: RpcClient, beeId: string): Promise<void> {
  await client.request("stop", { beeId });
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "stopped");
}

async function archive(client: RpcClient, beeId: string): Promise<void> {
  await client.request("archive", { beeId });
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.lifecycle === "archived", "archived");
}

const cellState = async (client: RpcClient, beeId: string) => (await client.request<ViewResult>("view", { beeId })).cell?.state;

function auditRows(dir: string, kind: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(join(dir, "core.sqlite3"), { readOnly: true });
  try {
    return (db.prepare("SELECT payload FROM audit WHERE kind = ? ORDER BY seq").all(kind) as Array<{ payload: string }>).map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

test("cell-pressure.1: below the floor, clean archived then idle Cells go oldest first until the target; held, dirty, unlanded, live and fresh Cells stay; an unreachable floor is reported once", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-pressure-"));
  const origin = makeOrigin(root);
  writeFileSync(join(origin.repo, "payload.bin"), randomBytes(3 * 1024 * 1024));
  g(origin.repo, ["add", "payload.bin"]);
  g(origin.repo, ["commit", "-q", "-m", "payload"]);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot, { recursive: true });
  const off = { enabled: true, archivedAfterDays: 30, stoppedAfterDays: null, trimAfterHours: null, fetchUpstream: false, minFreePercent: null, minFreeBytes: null, pressureIdleAfterDays: IDLE_AFTER_MS / 86_400_000 };
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    cells: { root: cellsRoot, retention: off },
    agents: {
      cellstub: {
        command: process.execPath,
        args: [CELL_AGENT_PATH],
        adapter: "stub",
        env: {
          GIT_AUTHOR_NAME: "cell-bee", GIT_AUTHOR_EMAIL: "bee@hive.invalid",
          GIT_COMMITTER_NAME: "cell-bee", GIT_COMMITTER_EMAIL: "bee@hive.invalid",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        },
      },
    },
  });
  const keepRuntimes = { HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "0" };
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: keepRuntimes });
    let client = await daemon.client();
    const idleBee = await spawnIdle(client, "idle-old", origin.repo);
    await stop(client, idleBee.beeId);
    const idleStoppedAt = Date.now();
    const a1 = await spawnIdle(client, "archived-1", origin.repo);
    const dirty = await spawnIdle(client, "archived-dirty", origin.repo);
    const a2 = await spawnIdle(client, "archived-2", origin.repo);
    const unlanded = await spawnIdle(client, "archived-unlanded", origin.repo);
    const a3 = await spawnIdle(client, "archived-3", origin.repo);
    const live = await spawnIdle(client, "live", origin.repo);
    writeFileSync(join(dirty.view.bee!.cwd, "wip.txt"), "uncommitted\n");
    commitInCell(unlanded.view.bee!.cwd, "work.txt", "not landed anywhere\n", "unlanded work");
    for (const bee of [a1, dirty, a2, unlanded, a3]) {
      await stop(client, bee.beeId);
      await archive(client, bee.beeId);
      await new Promise((r) => setTimeout(r, 30));
    }
    const plan = await client.request<CellGcResult>("cell.gc", {}, 120_000);
    const bytesOf = (beeId: string) => plan.items.find((i) => i.beeId === beeId)!.bytes!;
    assert.equal(plan.items.find((i) => i.beeId === dirty.beeId)!.reason, "dirty_uncommitted");
    assert.equal(plan.items.find((i) => i.beeId === unlanded.beeId)!.reason, "dirty_unlanded");
    const info0 = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info0.cellDisk, "deployInfo carries cellDisk");
    assert.equal(info0.cellDisk!.floorBytes, null, "no floor configured yet");
    await daemon.kill();
    daemon = null;

    const used = measureDirectoryBytes(cellsRoot);
    const slack = 512 * 1024;
    const volume = used + slack;
    const target = slack + bytesOf(a1.beeId) + Math.floor(bytesOf(a2.beeId) / 2);
    const floor = Math.ceil(target / 1.25);
    writeConfig(dir, cellsRoot, { ...off, minFreeBytes: floor });
    const waitIdle = IDLE_AFTER_MS + 1_000 - (Date.now() - idleStoppedAt);
    if (waitIdle > 0) await new Promise((r) => setTimeout(r, waitIdle));
    const pressureEnv = { HIVE_TEST_CELL_VOLUME_BYTES: String(volume), HIVE_TEST_CELL_DISK_CHECK_MS: "200", HIVE_TEST_CELL_PRESSURE_RETRY_MS: "300" };
    daemon = await startDaemon(dir, { env: { ...keepRuntimes, ...pressureEnv } });
    client = await daemon.client();
    const met = await waitFor(async () => {
      const info = await client.request<DeployInfoResult>("deployInfo");
      return info.cellDisk?.lastPass?.kind === "pressure" ? info.cellDisk : null;
    }, "pressure pass recorded", 120_000);
    assert.equal(met.lastPass!.outcome, "floor_met");
    assert.equal(met.lastPass!.evicted, 2);
    assert.ok(met.freeBytes >= floor, `free ${met.freeBytes} >= floor ${floor}`);
    assert.equal(met.floorUnmet, false);
    assert.equal(await cellState(client, a1.beeId), "evicted", "oldest archived first");
    assert.equal(await cellState(client, a2.beeId), "evicted", "next oldest clean archived");
    for (const bee of [dirty, unlanded, a3, idleBee, live]) assert.equal(await cellState(client, bee.beeId), "active", bee.view.bee!.name);
    assert.notEqual((await client.request<ViewResult>("view", { beeId: live.beeId })).view.runtimeState, "stopped", "the live bee was live through the pass");
    await daemon.kill();
    daemon = null;
    const evictedRows = auditRows(dir, "cell.evicted");
    assert.deepEqual(evictedRows.map((r) => r.reason), ["disk_pressure", "disk_pressure"]);
    assert.deepEqual(evictedRows.map((r) => r.cellId), [a1.view.cell!.id, a2.view.cell!.id]);
    const passRows = auditRows(dir, "cell.retention.pass");
    assert.equal(passRows.length, 1);
    assert.equal(passRows[0]!.kind, "pressure");
    assert.equal(passRows[0]!.outcome, "floor_met");

    writeConfig(dir, cellsRoot, { ...off, minFreeBytes: volume });
    daemon = await startDaemon(dir, { env: { ...pressureEnv } });
    client = await daemon.client();
    const restored = (await client.request<HealthResult>("health")).cellDisk;
    assert.ok(restored?.lastPass, "the last pass survives a restart");
    const fresh = await spawnIdle(client, "fresh-stopped", origin.repo);
    await stop(client, fresh.beeId);
    const unmet = await waitFor(async () => {
      const health = await client.request<HealthResult>("health");
      return health.cellDisk?.floorUnmet ? health.cellDisk : null;
    }, "floor unmet reported", 120_000);
    assert.equal(unmet.lastPass!.outcome, "floor_unmet");
    assert.equal(unmet.belowFloor, true);
    await new Promise((r) => setTimeout(r, 2_000));
    assert.equal(await cellState(client, a3.beeId), "evicted");
    assert.equal(await cellState(client, idleBee.beeId), "evicted", "a long-idle stopped bee's clean Cell goes after the archived ones");
    for (const bee of [dirty, unlanded, fresh, live]) assert.equal(await cellState(client, bee.beeId), "active", bee.view.bee!.name);
    await daemon.stop();
    daemon = null;
    const unmetRows = auditRows(dir, "cell.pressure.floor_unmet");
    assert.equal(unmetRows.length, 1, "one loud row per episode, however often the pass retries");
    assert.ok(auditRows(dir, "cell.retention.pass").filter((r) => r.outcome === "floor_unmet").length >= 2, "the pass did retry");
    const breakdown = unmetRows[0] as { dirtyUnlanded: { cells: number }; dirtyOther: { cells: number } };
    assert.equal(breakdown.dirtyUnlanded.cells, 1);
    assert.equal(breakdown.dirtyOther.cells, 1);
    assert.deepEqual(auditRows(dir, "cell.evicted").map((r) => r.cellId).slice(2), [a3.view.cell!.id, idleBee.view.cell!.id]);
  } finally {
    await daemon?.kill().catch(() => undefined);
    for (const pid of liveRunnerHostPids(dir)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cell-pressure.2: a Cell whose work landed upstream, past a stale origin checkout, is planned once the daemon's mirror fetched it", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-mirror-"));
  const origin = makeOrigin(root);
  const upstream = join(root, "upstream.git");
  g(root, ["clone", "--quiet", "--bare", origin.repo, upstream]);
  g(origin.repo, ["remote", "add", "origin", upstream]);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot, { recursive: true });
  const retention = { enabled: false, archivedAfterDays: 0, trimAfterHours: null, minFreePercent: null, minFreeBytes: null };
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    cells: { root: cellsRoot, retention: { ...retention, fetchUpstream: false } },
    agents: {
      cellstub: {
        command: process.execPath,
        args: [CELL_AGENT_PATH],
        adapter: "stub",
        env: {
          GIT_AUTHOR_NAME: "cell-bee", GIT_AUTHOR_EMAIL: "bee@hive.invalid",
          GIT_COMMITTER_NAME: "cell-bee", GIT_COMMITTER_EMAIL: "bee@hive.invalid",
          GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    let client = await daemon.client();
    const bee = await spawnIdle(client, "landed-upstream", origin.repo);
    const work = commitInCell(bee.view.bee!.cwd, "feature.txt", "landed upstream\n", "cell work");
    g(upstream, ["fetch", "--quiet", bee.view.bee!.cwd, "+HEAD:refs/heads/main"]);
    await stop(client, bee.beeId);
    await archive(client, bee.beeId);
    const withoutMirror = await client.request<CellGcResult>("cell.gc", {}, 120_000);
    assert.equal(withoutMirror.items.find((i) => i.beeId === bee.beeId)!.reason, "dirty_unlanded");
    await daemon.stop();
    daemon = null;

    writeConfig(dir, cellsRoot, { ...retention, fetchUpstream: true });
    daemon = await startDaemon(dir);
    client = await daemon.client();
    const originBefore = g(origin.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const plan = await client.request<CellGcResult>("cell.gc", {}, 120_000);
    const item = plan.items.find((i) => i.beeId === bee.beeId)!;
    assert.equal(item.reason, "archived_age");
    assert.equal(item.head, work);
    const applied = await client.request<CellGcResult>("cell.gc", { dryRun: false }, 120_000);
    assert.equal(applied.outcomes!.find((o) => o.beeId === bee.beeId)!.status, "evicted");
    assert.equal(applied.pass?.kind, "manual");
    assert.equal(g(origin.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), originBefore, "the origin checkout is never written");
    assert.match(readFileSync(join(dir, "hived.log"), "utf8"), /cell\.retention\.upstream_fetched origin=.* sha=/);
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
