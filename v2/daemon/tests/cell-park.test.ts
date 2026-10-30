/**
 * H1 `cell.park` and the purge report, and H2 admission, in the REAL daemon:
 * parking one bee's Cell removes build output (trim mode) or every ignored
 * path (purge mode) while the checkout, bee, mailbox and transcript stay; a
 * live runtime is a typed refusal; the next runtime start restores preserved
 * env files; `cell.gc` carries the purge report; a node below its floor with
 * enforcement on refuses NEW Cells with `resource_blocked` and still spawns
 * non-Cell bees. Temp dirs, stub agents and a simulated volume only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import {
  DAEMON_CAPABILITIES,
  RPC_VERBS,
  RpcError,
  type AuditTailResult,
  type CellGcResult,
  type CellParkResult,
  type HealthResult,
  type SnapshotResult,
  type SpawnResult,
  type ViewResult,
} from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(retention: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-park-"));
  const origin = makeOrigin(root);
  writeFileSync(join(origin.repo, ".gitignore"), ".env\n.next/\nnode_modules/\n.proof/\ntmp/\n");
  g(origin.repo, ["add", ".gitignore"]);
  g(origin.repo, ["commit", "-q", "-m", "ignores"]);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot, { recursive: true });
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
    ...extra,
    cells: { root: cellsRoot, retention },
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
      stub: { command: process.execPath, args: [join(here, "..", "..", "driver-hsr", "test-agent", "agent.mjs")], adapter: "stub" },
    },
  });
  return { dir, cellsRoot, origin, cleanup: () => { cleanup(); rmSync(root, { recursive: true, force: true }); } };
}

async function spawnIdle(client: RpcClient, name: string, originRepo: string): Promise<{ beeId: string; view: ViewResult }> {
  const spawned = await client.request<SpawnResult>("spawn", { name, agent: "cellstub", substrate: "cell", cell: { originRepo } });
  const view = await waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    return v.view.runtimeState === "idle" && v.cell ? v : null;
  }, `${name} idle`, 60_000);
  return { beeId: spawned.beeId, view };
}

async function stopped(client: RpcClient, beeId: string): Promise<void> {
  await client.request("stop", { beeId });
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "stopped");
}

function populate(space: string): void {
  for (const [rel, body] of [[".env", "SECRET=1\n"], [".next/server/page.js", "built\n"], ["node_modules/pkg/index.js", "dep\n"], [".proof/shot.png", "png\n"], ["tmp/scratch.bin", "x".repeat(4096)]] as const) {
    mkdirSync(join(space, dirname(rel)), { recursive: true });
    writeFileSync(join(space, rel), body);
  }
}

const park = (client: RpcClient, beeId: string, key = `park-${beeId}-${Math.random().toString(36).slice(2)}`) =>
  client.request<CellParkResult>("cell.park", { beeId, idempotencyKey: key }, 60_000);

test("cell-park.0: verb, capability and error code are published", () => {
  assert.ok(RPC_VERBS.includes("cell.park"));
  assert.ok((DAEMON_CAPABILITIES as readonly string[]).includes("cell.park.v1"));
  assert.ok((DAEMON_CAPABILITIES as readonly string[]).includes("node.capacity.v1"));
});

test("cell-park.1: trim mode parks only build output; a live runtime is a typed refusal; replaying the key returns the same report", { timeout: 180_000 }, async () => {
  const rig = makeRig({ enabled: false, trimAfterHours: null });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const bee = await spawnIdle(client, "trimmed", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    populate(space);
    await assert.rejects(park(client, bee.beeId), (err: unknown) => err instanceof RpcError && err.code === "runtime_refused", "a Cell is never parked mid-turn or while idle-live");
    await stopped(client, bee.beeId);
    const key = "park-once";
    const first = await park(client, bee.beeId, key);
    assert.equal(first.status, "parked");
    assert.equal(first.mode, "trim");
    assert.deepEqual(first.paths, [".next"]);
    assert.deepEqual(first.envFiles, []);
    assert.ok((first.bytes ?? 0) > 0);
    for (const kept of [".env", "node_modules/pkg/index.js", ".proof/shot.png", "tmp/scratch.bin", "README.md"]) assert.ok(existsSync(join(space, kept)), `${kept} stays`);
    assert.equal(existsSync(join(space, ".next")), false);
    const replay = await park(client, bee.beeId, key);
    assert.equal(replay.deduped, true);
    assert.deepEqual(replay.paths, [".next"]);
    const again = await park(client, bee.beeId);
    assert.equal(again.status, "nothing_to_park");
    assert.equal((await client.request<ViewResult>("view", { beeId: bee.beeId })).cell?.state, "active", "parking never changes the Cell state");
    const parked = (await client.request<AuditTailResult>("audit.tail", { limit: 200 })).rows.filter((r) => r.kind === "cell.parked");
    assert.equal(parked.length, 1, "one informational audit row per park that removed something");
    assert.equal(parked[0]!.payload.mode, "trim");
    assert.equal(parked[0]!.payload.trigger, "operator");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    rig.cleanup();
  }
});

test("cell-park.2: purge mode parks every ignored path, copies env files aside, and the next runtime start restores them; the idle pass does the same", { timeout: 240_000 }, async () => {
  const rig = makeRig({ enabled: false, trimAfterHours: 0, purgeIgnoredOnPark: true });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const explicit = await spawnIdle(client, "purged", rig.origin.repo);
    const idle = await spawnIdle(client, "idle-purged", rig.origin.repo);
    populate(explicit.view.bee!.cwd);
    populate(idle.view.bee!.cwd);
    await stopped(client, explicit.beeId);
    await stopped(client, idle.beeId);

    const parked = await park(client, explicit.beeId);
    assert.equal(parked.status, "parked");
    assert.equal(parked.mode, "purge");
    assert.deepEqual(parked.paths, [".env", ".next", ".proof", "node_modules", "tmp"]);
    assert.deepEqual(parked.envFiles, [".env"]);
    const space = explicit.view.bee!.cwd;
    for (const gone of [".env", ".next", ".proof", "node_modules", "tmp"]) assert.equal(existsSync(join(space, gone)), false, `${gone} is parked`);
    assert.ok(existsSync(join(space, "README.md")));
    assert.equal(g(space, ["status", "--porcelain"]), "", "a purged Cell is still clean");
    assert.ok(existsSync(join(dirname(rig.cellsRoot), "cell-env", explicit.view.cell!.spaceName, ".env")), "the env copy waits under cell-env/");

    await client.request("send", { beeId: explicit.beeId, body: "wake up", urgency: "next" });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: explicit.beeId })).view.runtimeState === "idle", "revived", 60_000);
    await waitFor(() => (existsSync(join(space, ".env")) ? true : null), "env restored", 30_000);
    assert.equal(readFileSync(join(space, ".env"), "utf8"), "SECRET=1\n");
    assert.equal(existsSync(join(dirname(rig.cellsRoot), "cell-env", explicit.view.cell!.spaceName, ".env")), false, "a restored copy leaves the stash");

    const plan = await client.request<CellGcResult>("cell.gc", {}, 120_000);
    assert.equal(plan.policy.purgeIgnoredOnPark, true);
    assert.ok(plan.purge, "every gc result carries the purge report");
    assert.equal(plan.purge!.mode, "purge");
    assert.ok((plan.purge!.installBytes ?? 0) > 0, "installs are measured");
    assert.deepEqual(plan.purge!.otherIgnored.map((g) => g.name).sort(), [".proof", "tmp"], "ignored paths outside the known patterns are named");
    const idleItem = plan.items.find((i) => i.beeId === idle.beeId)!;
    assert.equal(idleItem.trim.planned, true, "the stopped idle Cell is due for a park");
    assert.deepEqual(idleItem.install?.entries.map((e) => e.path), ["node_modules"]);

    const applied = await client.request<CellGcResult>("cell.gc", { dryRun: false }, 120_000);
    const outcome = applied.trimOutcomes!.find((o) => o.beeId === idle.beeId)!;
    assert.equal(outcome.status, "trimmed");
    assert.deepEqual(outcome.paths, [".env", ".next", ".proof", "node_modules", "tmp"]);
    const idleSpace = idle.view.bee!.cwd;
    for (const gone of [".env", ".next", ".proof", "node_modules", "tmp"]) assert.equal(existsSync(join(idleSpace, gone)), false, `${gone} is parked by the pass`);
    assert.ok(existsSync(join(dirname(rig.cellsRoot), "cell-env", idle.view.cell!.spaceName, ".env")));
    const rows = (await client.request<AuditTailResult>("audit.tail", { limit: 500 })).rows.filter((r) => r.kind === "cell.parked");
    assert.deepEqual(rows.map((r) => r.payload.trigger).sort(), ["idle", "operator"]);
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    rig.cleanup();
  }
});

test("cell-park.3: below the floor, enforcement off reports resource-blocked and still admits Cells; enforcement on refuses new Cells with resource_blocked and keeps non-Cell spawns, snapshots and health working", { timeout: 240_000 }, async () => {
  const volume = { HIVE_TEST_CELL_VOLUME_BYTES: String(64 * 1024), HIVE_TEST_CELL_DISK_CHECK_MS: "200" };
  const warnOnly = makeRig({ enabled: false, minFreePercent: 50, minFreeBytes: null, budgetEnforce: false });
  const enforcing = makeRig({ enabled: false, minFreePercent: 50, minFreeBytes: null, budgetEnforce: true });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(warnOnly.dir, { env: volume });
    let client = await daemon.client();
    const admitted = await spawnIdle(client, "admitted", warnOnly.origin.repo);
    assert.ok(admitted.view.cell, "warn-only admits Cells below the floor");
    const snapshot = await waitFor(async () => {
      const s = await client.request<SnapshotResult>("snapshot");
      return s.capacity?.resourceBlocked.blocked ? s : null;
    }, "capacity reports blocked", 30_000);
    assert.equal(snapshot.capacity!.admission.newCells, "accept");
    assert.equal(snapshot.capacity!.admission.enforce, false);
    assert.equal(snapshot.capacity!.resourceBlocked.reason, "disk_floor");
    assert.equal(snapshot.capacity!.cells.cellCount, 1);
    const health = await client.request<HealthResult>("health");
    assert.equal(health.capacity?.resourceBlocked.blocked, true);
    const flips = (await client.request<AuditTailResult>("audit.tail", { limit: 500 })).rows.filter((r) => r.kind === "node.capacity");
    assert.equal(flips.length, 1, "one node.capacity row for the blocked flip");
    client.close();
    await daemon.stop();

    mkdirSync(join(enforcing.cellsRoot, ".capacity-filler"), { recursive: true });
    writeFileSync(join(enforcing.cellsRoot, ".capacity-filler", "used.bin"), Buffer.alloc(48 * 1024, 1));
    daemon = await startDaemon(enforcing.dir, { env: volume });
    client = await daemon.client();
    await waitFor(async () => ((await client.request<SnapshotResult>("snapshot")).capacity?.resourceBlocked.blocked ? true : null), "enforcing node sees the floor", 30_000);
    await assert.rejects(
      client.request<SpawnResult>("spawn", { name: "refused", agent: "cellstub", substrate: "cell", cell: { originRepo: enforcing.origin.repo } }),
      (err: unknown) => err instanceof RpcError && err.code === "resource_blocked" && /below its disk floor/.test(err.message),
    );
    const plain = await client.request<SpawnResult>("spawn", { name: "plain", agent: "stub", cwd: enforcing.dir });
    assert.ok(plain.beeId, "a non-Cell bee still spawns");
    const s = await client.request<SnapshotResult>("snapshot");
    assert.equal(s.capacity!.admission.newCells, "refuse");
    assert.equal(s.views.some((v) => v.view.beeId === plain.beeId), true);
    assert.equal(s.views.some((v) => v.bee?.name === "refused"), false, "the refused spawn left no bee");
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    warnOnly.cleanup();
    enforcing.cleanup();
  }
});
