/**
 * v31 Cell disk retention in the REAL daemon: `cell.gc` plans over the
 * registry (age floors, dirty holds, live-runtime keeps), `--apply` parks the
 * wrapper and records `evicted` while the bee, its transcript path and cwd
 * survive; a message to the archived bee revives it and the Cell is
 * re-provisioned in place at the evicted HEAD and returns to `active`;
 * `cell.evict` handles one bee with the dirty guard; the automatic pass runs
 * on the configured interval. Temp dirs and stub agents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitOn, g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { EVICTING_DIR } from "../../driver-cell/src/retention.ts";
import {
  DAEMON_CAPABILITIES,
  RPC_VERBS,
  type CellEvictResult,
  type CellGcResult,
  type MailboxResult,
  type SendRpcResult,
  type SpawnResult,
  type ViewResult,
} from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

function makeRig(retention: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-retention-"));
  const origin = makeOrigin(root);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot, { recursive: true });
  const { dir, cleanup } = makeDaemonDir({
    bootHangTimeoutMs: 60_000,
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

async function archived(client: RpcClient, beeId: string): Promise<void> {
  await client.request("archive", { beeId });
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.lifecycle === "archived", "archived");
}

const gc = (client: RpcClient, params: Record<string, unknown> = {}) => client.request<CellGcResult>("cell.gc", params, 120_000);
const itemFor = (r: CellGcResult, beeId: string) => r.items.find((i) => i.beeId === beeId)!;

test("cell-retention.0: verbs and capability are published", () => {
  assert.ok(RPC_VERBS.includes("cell.gc"));
  assert.ok(RPC_VERBS.includes("cell.evict"));
  assert.ok((DAEMON_CAPABILITIES as readonly string[]).includes("cell.retention.v1"));
});

test("cell-retention.1: plan holds young and dirty Cells, keeps live ones; apply evicts a clean archived Cell; a message revives it in place", { timeout: 180_000 }, async () => {
  const rig = makeRig({ enabled: false, archivedAfterDays: 0 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const clean = await spawnIdle(client, "clean", rig.origin.repo);
    const dirty = await spawnIdle(client, "dirty", rig.origin.repo);
    const live = await spawnIdle(client, "live", rig.origin.repo);
    const cleanSpace = clean.view.bee!.cwd;
    const cleanWrapper = dirname(cleanSpace);
    writeFileSync(join(dirty.view.bee!.cwd, "wip.txt"), "uncommitted\n");

    // Live (idle runtime) is kept; stopped-but-active is too young under the 30d default; archived-0d is planned.
    await stopped(client, clean.beeId);
    await stopped(client, dirty.beeId);
    await archived(client, clean.beeId);
    await archived(client, dirty.beeId);

    const plan = await gc(client);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.outcomes, null);
    assert.equal(itemFor(plan, live.beeId).verdict, "keep");
    assert.equal(itemFor(plan, live.beeId).reason, "runtime_live");
    assert.equal(itemFor(plan, dirty.beeId).verdict, "hold");
    assert.equal(itemFor(plan, dirty.beeId).reason, "dirty_uncommitted");
    assert.equal(itemFor(plan, clean.beeId).verdict, "evict");
    assert.equal(itemFor(plan, clean.beeId).reason, "archived_age");
    assert.equal(itemFor(plan, clean.beeId).head, rig.origin.sha);
    assert.ok((itemFor(plan, clean.beeId).bytes ?? 0) > 0);
    assert.equal(plan.totals.plannedCells, 1);
    assert.equal(plan.totals.dirtyCells, 1);
    assert.equal(existsSync(cleanSpace), true, "dry run changed nothing");

    const applied = await gc(client, { dryRun: false });
    assert.ok(applied.outcomes);
    const outcome = applied.outcomes.find((o) => o.beeId === clean.beeId)!;
    assert.equal(outcome.status, "evicted");
    assert.equal(existsSync(cleanWrapper), false, "the wrapper is gone from the bee's path");
    await waitFor(() => !existsSync(join(rig.cellsRoot, EVICTING_DIR)) || readdirSync(join(rig.cellsRoot, EVICTING_DIR)).length === 0, "parked wrapper swept", 20_000);
    assert.equal(existsSync(dirty.view.bee!.cwd), true, "the dirty Cell was not touched");

    const after = await client.request<ViewResult>("view", { beeId: clean.beeId });
    assert.equal(after.bee?.lifecycle, "archived", "the bee survives eviction");
    assert.equal(after.bee?.cellId, clean.view.cell!.id, "…with its Cell id");
    assert.equal(after.bee?.cwd, cleanSpace, "…and its cwd");
    assert.equal(after.bee?.sessionLogPath, clean.view.bee!.sessionLogPath, "…and its transcript path");
    assert.equal(after.cell?.state, "evicted");
    assert.equal(after.cell?.evictedHead, rig.origin.sha);
    assert.equal(existsSync(after.bee!.sessionLogPath!), true, "the transcript file is untouched");
    const again = await gc(client);
    assert.equal(itemFor(again, clean.beeId).reason, "already_evicted");

    // Revive by message: auto-unarchive → new generation → Cell re-provisioned in place → row active again.
    commitOn(rig.origin.repo, "later.txt", "origin moved on\n", "origin advance");
    const sent = await client.request<SendRpcResult>("send", { beeId: clean.beeId, body: "hello again" });
    assert.equal(sent.unarchived, true);
    await waitFor(async () => {
      const { messages } = await client.request<MailboxResult>("mailbox", { beeId: clean.beeId });
      return messages.find((m) => m.id === sent.messageId)?.deliveredAt != null;
    }, "delivered after re-provision", 60_000);
    const revived = await client.request<ViewResult>("view", { beeId: clean.beeId });
    assert.equal(revived.view.generation, 2);
    assert.equal(revived.bee?.cwd, cleanSpace);
    assert.equal(existsSync(join(cleanSpace, ".git")), true, "re-provisioned at the same path");
    assert.equal(g(cleanSpace, ["rev-parse", "HEAD"]), rig.origin.sha, "at the evicted HEAD, not the origin's new tip");
    assert.equal(revived.cell?.state, "active");
    assert.equal(revived.cell?.evictedAt, null);
    assert.equal(revived.cell?.evictedHead, null);
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /cell\.reprovisioned bee=/);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-retention.2: cell.evict on one bee — refused dirty, forced parks, live runtime is typed-refused, idempotent replay", { timeout: 180_000 }, async () => {
  const rig = makeRig({ enabled: false });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const bee = await spawnIdle(client, "one", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    await assert.rejects(
      client.request("cell.evict", { beeId: bee.beeId, idempotencyKey: "live" }),
      (err: Error & { code?: string }) => err.code === "runtime_refused",
    );
    await stopped(client, bee.beeId);
    writeFileSync(join(space, "wip.txt"), "uncommitted\n");
    const refused = await client.request<CellEvictResult>("cell.evict", { beeId: bee.beeId, idempotencyKey: "k1" });
    assert.equal(refused.status, "refused");
    assert.equal(refused.report?.uncommitted, true);
    assert.equal(existsSync(space), true);
    const forced = await client.request<CellEvictResult>("cell.evict", { beeId: bee.beeId, idempotencyKey: "k2", force: true });
    assert.equal(forced.status, "evicted");
    assert.equal(forced.forced, true);
    assert.equal(forced.cell?.state, "evicted");
    assert.equal(existsSync(dirname(space)), false);
    const replay = await client.request<CellEvictResult>("cell.evict", { beeId: bee.beeId, idempotencyKey: "k2", force: true });
    assert.equal(replay.deduped, true);
    assert.equal(replay.status, "evicted");
    const fresh = await client.request<CellEvictResult>("cell.evict", { beeId: bee.beeId, idempotencyKey: "k3" });
    assert.equal(fresh.status, "absent");
    const view = await client.request<ViewResult>("view", { beeId: bee.beeId });
    assert.equal(view.bee?.lifecycle, "active");
    assert.equal(view.view.reachable, true);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-retention.3: the automatic pass runs on its interval and evicts a clean stopped Cell past the age floor", { timeout: 180_000 }, async () => {
  const rig = makeRig({ enabled: true, stoppedAfterDays: 0, archivedAfterDays: 0, intervalHours: 1 });
  let daemon: DaemonHandle | null = null;
  try {
    // A short first-pass delay: the pass fires shortly after boot, then hourly.
    daemon = await startDaemon(rig.dir, { env: { HIVE_TEST_RETENTION_INITIAL_DELAY_MS: "1500" } });
    const client = await daemon.client();
    const bee = await spawnIdle(client, "auto", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    await stopped(client, bee.beeId);
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: bee.beeId })).cell?.state === "evicted", "auto-evicted", 60_000);
    assert.equal(existsSync(dirname(space)), false);
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /cell\.retention\.evicted .*reason=stopped_age/);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-retention.4: a clean retained Cell (its bee moved away) is removed by the pass; the moved bee is untouched", { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-retention-move-"));
  const origin = makeOrigin(root);
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const rig = makeDaemonDir({
    cells: { root: cellsRoot, allowStubMove: true, retention: { enabled: false, retainedAfterDays: 0 } },
    agents: { stub: { command: process.execPath, adapter: "stub", args: [fileURLToPath(new URL("../../driver-cell/test-agent/agent.mjs", import.meta.url))] } },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "mover", agent: "stub", substrate: "cell", cell: { originRepo: origin.repo } });
    const source = await waitFor(async () => {
      const v = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return v.view.runtimeState === "idle" && v.cell ? v : null;
    }, "Cell ready", 60_000);
    const { localRepoIdentity } = await import("../../driver-cell/src/git.ts");
    const repository = localRepoIdentity(origin.repo)!;
    const move = await client.request<{ id: string }>("bee.move", {
      beeId: spawned.beeId, idempotencyKey: "move",
      expected: { placementVersion: 0, cellId: source.cell!.id },
      destination: { kind: "local_checkout", cwd: origin.repo, repository, observedHead: origin.sha },
    });
    await client.request("send", { beeId: spawned.beeId, body: "continue", idempotencyKey: "first-task" });
    await waitFor(async () => (await client.request<{ phase: string }>("bee.move.get", { moveId: move.id })).phase === "complete", "move complete", 60_000);
    const retainedWrapper = dirname(source.cell!.spaceDir);
    assert.equal(existsSync(retainedWrapper), true);

    const plan = await gc(client);
    const item = plan.items.find((i) => i.cellId === source.cell!.id)!;
    assert.equal(item.cellState, "retained");
    assert.equal(item.verdict, "remove_retained");
    assert.equal(item.reason, "retained_age");
    const applied = await gc(client, { dryRun: false });
    assert.equal(applied.outcomes?.find((o) => o.cellId === source.cell!.id)?.status, "removed");
    assert.equal(existsSync(retainedWrapper), false);
    const after = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.equal(after.bee?.lifecycle, "active");
    assert.equal(after.bee?.cwd, origin.repo, "the moved bee keeps its checkout");
    assert.equal(after.bee?.cellId, null);
    assert.equal(after.view.reachable, true);
  } finally {
    await daemon?.stop();
    rig.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
