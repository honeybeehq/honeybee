/**
 * H3 WIP push in the REAL daemon: a turn end pushes everything that is not
 * ignored to refs/hive/wip/<cell> in the origin and the row records the
 * read-back; with evictionRequiresWip a dirty stopped Cell is evicted only
 * after a confirmed push and comes back with its WIP on revive; an origin
 * that refuses the ref holds the eviction as wip_unconfirmed, sets
 * resource-blocked and refuses new Cells under enforcement; cell.remove
 * drops the ref. Temp dirs, stub agents and a simulated volume only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { hostname } from "node:os";
import { wipNodeScope, wipRefFor } from "../../driver-cell/src/wip.ts";
import { type AuditTailResult, type CellGcResult, type CellRemoveResult, type HealthResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");

const allowFile = ["-c", "protocol.file.allow=always"];
const FLAGS = { enabled: true, stoppedAfterDays: 0, archivedAfterDays: 0, intervalHours: 1, wipPushOnTurnEnd: true, evictionRequiresWip: true, budgetEnforce: true, wipMinIntervalSeconds: 0 };

function makeRig(retention: Record<string, unknown>, opts: { submodule?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-wip-"));
  const origin = makeOrigin(root);
  writeFileSync(join(origin.repo, ".gitignore"), ".next/\nnode_modules/\n");
  g(origin.repo, ["add", ".gitignore"]);
  g(origin.repo, ["commit", "-q", "-m", "ignores"]);
  if (opts.submodule) {
    const lib = makeOrigin(root, "lib");
    g(origin.repo, [...allowFile, "submodule", "add", "-q", lib.repo, "vendor/lib"]);
    g(origin.repo, ["commit", "-q", "-m", "add submodule"]);
  }
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

async function shInCell(client: RpcClient, beeId: string, cmd: string): Promise<void> {
  const before = (await client.request<ViewResult>("view", { beeId })).view;
  const sent = await client.request<SendRpcResult>("send", { beeId, body: `@sh ${cmd}` });
  await waitFor(async () => {
    const v = (await client.request<ViewResult>("view", { beeId })).view;
    return v.runtimeState === "idle" && (v.lastOutputAt ?? 0) > (before.lastOutputAt ?? 0);
  }, `turn ended: ${cmd} (message ${sent.messageId})`, 30_000);
}

async function stopped(client: RpcClient, beeId: string): Promise<void> {
  await client.request("stop", { beeId });
  await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "stopped");
}

async function wipConfirmed(client: RpcClient, beeId: string, after: number): Promise<ViewResult> {
  return waitFor(async () => {
    const v = await client.request<ViewResult>("view", { beeId });
    return v.cell?.wipConfirmedAt != null && v.cell.wipConfirmedAt > after ? v : null;
  }, "the turn end pushed and confirmed the WIP", 30_000);
}

const gc = (client: RpcClient) => client.request<CellGcResult>("cell.gc", { dryRun: false }, 120_000);

test("cell-wip.1: a turn end pushes WIP with read-back; a dirty stopped Cell is evicted only after a confirmed push and revives with its WIP; cell.remove drops the ref", { timeout: 240_000 }, async () => {
  const rig = makeRig(FLAGS);
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const { beeId, view } = await spawnIdle(client, "wip-bee", rig.origin.repo);
    const cell = view.cell!;
    assert.equal(cell.wipSha, null);
    const ref = wipRefFor(wipNodeScope(null, hostname()), cell.id);

    await shInCell(client, beeId, "printf 'draft\\n' > notes.md && mkdir -p .next && printf 'b\\n' > .next/out.js && printf 'v2\\n' >> README.md");
    const pushed = await wipConfirmed(client, beeId, 0);
    const wip = pushed.cell!;
    assert.ok(wip.wipSha && wip.wipTree && wip.wipPushedAt, "the row carries the WIP commit");
    assert.equal(g(rig.origin.repo, ["rev-parse", ref]), wip.wipSha, "the origin holds the WIP ref at the pushed sha");
    const files = g(rig.origin.repo, ["ls-tree", "-r", "--name-only", wip.wipTree!]).split("\n");
    assert.ok(files.includes("notes.md"), "untracked WIP is in the tree");
    assert.ok(!files.includes(".next/out.js"), "ignored output is not");
    assert.equal(g(rig.origin.repo, ["rev-parse", `${wip.wipSha}^`]), g(cell.spaceDir, ["rev-parse", "HEAD"]), "the WIP commit sits on the Cell's HEAD");
    const head = g(cell.spaceDir, ["rev-parse", "HEAD"]);
    const putsBefore = (await client.request<AuditTailResult>("audit.tail", { limit: 500 })).rows.filter((r) => r.kind === "cell.put" && (r.payload as { cell?: { id?: string } }).cell?.id === cell.id).length;
    await shInCell(client, beeId, "true");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle" ? true : null, "idle again");
    await new Promise((r) => setTimeout(r, 1500));
    const unchanged = (await client.request<ViewResult>("view", { beeId })).cell!;
    assert.equal(unchanged.wipSha, wip.wipSha, "an unchanged tree pushes nothing new");
    assert.equal(unchanged.wipPushedAt, wip.wipPushedAt, "and writes no row");
    const putsAfter = (await client.request<AuditTailResult>("audit.tail", { limit: 500 })).rows.filter((r) => r.kind === "cell.put" && (r.payload as { cell?: { id?: string } }).cell?.id === cell.id).length;
    assert.equal(putsAfter, putsBefore, "no cell.put audit churn for an unchanged WIP");

    await stopped(client, beeId);
    const applied = await gc(client);
    const item = applied.items.find((i) => i.cellId === cell.id);
    assert.ok(item, "the Cell is in the plan");
    assert.equal(item.verdict, "evict", "a dirty Cell with a confirmed WIP is evictable under the flag");
    const outcome = applied.outcomes?.find((o) => o.cellId === cell.id);
    assert.equal(outcome?.status, "evicted", JSON.stringify(outcome));
    assert.equal(existsSync(cell.spaceDir), false, "the checkout is gone from the executor");
    assert.equal(g(rig.origin.repo, ["rev-parse", ref]).length, 40, "eviction keeps the WIP ref");
    const evicted = (await client.request<ViewResult>("view", { beeId })).cell!;
    assert.equal(evicted.state, "evicted");
    assert.equal(evicted.evictedHead, head);

    await client.request<SendRpcResult>("send", { beeId, body: "back to work" });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "revived", 60_000);
    const revived = (await client.request<ViewResult>("view", { beeId })).cell!;
    assert.equal(revived.state, "active");
    assert.equal(readFileSync(join(revived.spaceDir, "notes.md"), "utf8"), "draft\n", "the WIP is back in the working tree");
    assert.ok(readFileSync(join(revived.spaceDir, "README.md"), "utf8").endsWith("v2\n"));
    assert.equal(g(revived.spaceDir, ["rev-parse", "HEAD"]), head, "HEAD is where the agent left it");
    assert.equal(existsSync(join(revived.spaceDir, ".next")), false);

    await stopped(client, beeId);
    const removed = await client.request<CellRemoveResult>("cell.remove", { beeId, force: true });
    assert.equal(removed.status, "deleted");
    assert.throws(() => g(rig.origin.repo, ["rev-parse", "--verify", "--quiet", ref]), "cell.remove drops the WIP ref");
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-wip.2: an origin that refuses the WIP ref holds the eviction as wip_unconfirmed and reports it in capacity without refusing admission; the hold lifts when the push lands", { timeout: 240_000 }, async () => {
  const rig = makeRig(FLAGS);
  let daemon: DaemonHandle | null = null;
  const wipDir = join(rig.origin.repo, ".git", "refs", "hive", "wip", wipNodeScope(null, hostname()));
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const { beeId, view } = await spawnIdle(client, "wip-blocked", rig.origin.repo);
    const cell = view.cell!;
    await shInCell(client, beeId, "printf 'one\\n' > a.txt");
    const first = await wipConfirmed(client, beeId, 0);
    chmodSync(wipDir, 0o555);
    await shInCell(client, beeId, "printf 'two\\n' > b.txt");
    await stopped(client, beeId);

    const held = await gc(client);
    const item = held.items.find((i) => i.cellId === cell.id);
    assert.equal(item?.verdict, "hold");
    assert.equal(item?.reason, "wip_unconfirmed");
    assert.equal(held.outcomes?.some((o) => o.cellId === cell.id), false, "nothing was applied to the held Cell");
    assert.ok(existsSync(join(cell.spaceDir, "b.txt")), "the unpushed work is still on disk");
    const row = (await client.request<ViewResult>("view", { beeId })).cell!;
    assert.equal(row.state, "active");
    assert.equal(row.wipSha, first.cell!.wipSha, "the last confirmed WIP stays on the row");
    const health = await client.request<HealthResult>("health");
    assert.equal(health.capacity?.resourceBlocked.blocked, true);
    assert.equal(health.capacity?.resourceBlocked.reason, "wip_unconfirmed");
    assert.equal(health.capacity?.cells.wipBlockedCells, 1);
    assert.equal(health.capacity?.admission.newCells, "accept", "a stuck WIP push never refuses new Cells");
    const other = await spawnIdle(client, "still-admitted", rig.origin.repo);
    assert.ok(other.view.cell, "a new Cell spawns while another Cell's push is unconfirmed");
    await stopped(client, other.beeId);

    chmodSync(wipDir, 0o755);
    const applied = await gc(client);
    assert.equal(applied.outcomes?.find((o) => o.cellId === cell.id)?.status, "evicted");
    const after = (await client.request<ViewResult>("view", { beeId })).cell!;
    assert.equal(after.state, "evicted");
    assert.ok(after.wipConfirmedAt! > first.cell!.wipConfirmedAt!, "the eviction-time push confirmed the newer WIP");
    const tree = g(rig.origin.repo, ["ls-tree", "-r", "--name-only", after.wipTree!]).split("\n");
    assert.ok(tree.includes("a.txt") && tree.includes("b.txt"));
    const clear = await client.request<HealthResult>("health");
    assert.equal(clear.capacity?.resourceBlocked.blocked, false);
    assert.equal(clear.capacity?.admission.newCells, "accept");
  } finally {
    if (existsSync(wipDir)) chmodSync(wipDir, 0o755);
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-wip.3: an oversize changed file makes the WIP incomplete: the Cell is held as wip_incomplete and nothing is deleted", { timeout: 240_000 }, async () => {
  const rig = makeRig({ ...FLAGS, wipMaxFileBytes: 1024 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const { beeId, view } = await spawnIdle(client, "wip-big", rig.origin.repo);
    const cell = view.cell!;
    await shInCell(client, beeId, "head -c 4096 /dev/zero > big.bin && printf 'small\\n' > small.txt");
    const pushed = await wipConfirmed(client, beeId, 0);
    const tree = g(rig.origin.repo, ["ls-tree", "-r", "--name-only", pushed.cell!.wipTree!]).split("\n");
    assert.ok(tree.includes("small.txt") && !tree.includes("big.bin"), "the oversize file is not in the pushed WIP");
    await stopped(client, beeId);
    const held = await gc(client);
    const item = held.items.find((i) => i.cellId === cell.id);
    assert.equal(item?.verdict, "hold");
    assert.equal(item?.reason, "wip_incomplete");
    assert.ok(existsSync(join(cell.spaceDir, "big.bin")), "the file the WIP could not carry is still on disk");
    assert.equal((await client.request<ViewResult>("view", { beeId })).cell!.state, "active");
    const health = await client.request<HealthResult>("health");
    assert.equal(health.capacity?.cells.wipBlockedCells, 1);
    assert.equal(health.capacity?.admission.newCells, "accept");
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-wip.4: a merge in progress and a stash hold the Cell under evictionRequiresWip", { timeout: 240_000 }, async () => {
  const rig = makeRig(FLAGS);
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const merging = await spawnIdle(client, "wip-merge", rig.origin.repo);
    await shInCell(client, merging.beeId, "printf 'x\\n' > x.txt && git rev-parse HEAD > .git/MERGE_HEAD");
    await stopped(client, merging.beeId);
    const stashed = await spawnIdle(client, "wip-stash", rig.origin.repo);
    await shInCell(client, stashed.beeId, "printf 'y\\n' >> README.md && git stash -q && printf 'z\\n' > z.txt");
    await stopped(client, stashed.beeId);
    const held = await gc(client);
    const mergeItem = held.items.find((i) => i.cellId === merging.view.cell!.id);
    assert.equal(mergeItem?.verdict, "hold");
    assert.equal(mergeItem?.reason, "wip_unconfirmed", "an in-progress operation is never flattened into a WIP commit");
    assert.ok(existsSync(join(merging.view.cell!.spaceDir, "x.txt")));
    const stashItem = held.items.find((i) => i.cellId === stashed.view.cell!.id);
    assert.equal(stashItem?.verdict, "hold");
    assert.equal(stashItem?.reason, "dirty_stash", "a stash is not carried by the WIP ref and still holds");
    assert.ok(existsSync(join(stashed.view.cell!.spaceDir, "z.txt")));
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /cell\.wip\.push_failed .*operation_in_progress:MERGE_HEAD/);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-wip.5: a dirty populated submodule holds the Cell under evictionRequiresWip", { timeout: 240_000 }, async () => {
  const rig = makeRig(FLAGS, { submodule: true });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const { beeId, view } = await spawnIdle(client, "wip-sub", rig.origin.repo);
    await shInCell(client, beeId, "git -c protocol.file.allow=always submodule update --init -q && printf 'local\\n' > vendor/lib/local.txt");
    await stopped(client, beeId);
    const held = await gc(client);
    const item = held.items.find((i) => i.cellId === view.cell!.id);
    assert.equal(item?.verdict, "hold");
    assert.equal(item?.reason, "dirty_uncommitted", "submodule contents are not in the WIP tree, only the gitlink");
    assert.ok(existsSync(join(view.cell!.spaceDir, "vendor", "lib", "local.txt")));
    assert.equal((await client.request<ViewResult>("view", { beeId })).cell!.state, "active");
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});
