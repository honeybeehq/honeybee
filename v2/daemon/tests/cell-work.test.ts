/**
 * Cell work bundles in the REAL daemon: a dirty stopped Cell (an unlanded
 * commit, a modified tracked file, a staged file, an untracked file, ignored
 * build output) is planned `evict` with its work measured, the dry run
 * writes nothing, apply saves a verified bundle under cell-work/ and parks the
 * checkout, and a message revives the bee into a checkout whose status, diff,
 * refs and HEAD read as they did; a 2 GiB untracked file holds the Cell as
 * work_over_cap with the path named on the row; cell.keep.remove clears kept
 * files of an evicted Cell; the pass deletes keeps and bundles past their
 * windows. Temp dirs and stub agents only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { g, makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { DAEMON_CAPABILITIES, RPC_VERBS, type CellGcResult, type CellKeepRemoveResult, type MailboxResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CELL_AGENT_PATH = join(here, "..", "..", "driver-cell", "test-agent", "agent.mjs");
const PARK_THEN_CRASH = join(here, "fixtures", "park-then-crash.ts");
const GIB = 1024 ** 3;

function makeRig(retention: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-work-"));
  const origin = makeOrigin(root);
  writeFileSync(join(origin.repo, ".gitignore"), "artifacts/\n");
  g(origin.repo, ["add", ".gitignore"]);
  g(origin.repo, ["commit", "-q", "-m", "ignores"]);
  origin.sha = g(origin.repo, ["rev-parse", "HEAD"]);
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
  return { dir, root, cellsRoot, origin, workRoot: join(root, "cell-work"), keepRoot: join(root, "cell-keep"), cleanup: () => { cleanup(); rmSync(root, { recursive: true, force: true }); } };
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

async function revive(client: RpcClient, beeId: string): Promise<ViewResult> {
  const sent = await client.request<SendRpcResult>("send", { beeId, body: "back to work" });
  await waitFor(async () => {
    const { messages } = await client.request<MailboxResult>("mailbox", { beeId });
    return messages.find((m) => m.id === sent.messageId)?.deliveredAt != null;
  }, "delivered after re-provision", 90_000);
  return client.request<ViewResult>("view", { beeId });
}

function snapshot(space: string) {
  let branch: string | null = null;
  try { branch = g(space, ["symbolic-ref", "HEAD"]); } catch { branch = null; }
  return {
    status: g(space, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
    refs: g(space, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]),
    head: g(space, ["rev-parse", "HEAD"]),
    branch,
    diff: g(space, ["diff"]),
    cached: g(space, ["diff", "--cached"]),
    stashes: g(space, ["stash", "list", "--format=%H %gd %gs"]),
  };
}

function makeWork(space: string): void {
  writeFileSync(join(space, "README.md"), "# parked idea\n");
  g(space, ["stash", "push", "-q", "-m", "parked idea"]);
  g(space, ["checkout", "-q", "-b", "feat"]);
  writeFileSync(join(space, "feature.ts"), "export const feature = true;\n");
  g(space, ["add", "feature.ts"]);
  g(space, ["commit", "-q", "-m", "feature"]);
  writeFileSync(join(space, "src", "app.ts"), "export const version = 2;\n");
  writeFileSync(join(space, "staged.txt"), "staged\n");
  g(space, ["add", "staged.txt"]);
  writeFileSync(join(space, "notes.md"), "draft\n");
  mkdirSync(join(space, "artifacts"));
  writeFileSync(join(space, "artifacts", "out.js"), "ignored output\n");
}

const gc = (client: RpcClient, params: Record<string, unknown> = {}) => client.request<CellGcResult>("cell.gc", params, 180_000);
const itemFor = (r: CellGcResult, beeId: string) => r.items.find((i) => i.beeId === beeId)!;

test("cell-work.0: the verb and capability are published", () => {
  assert.ok(RPC_VERBS.includes("cell.keep.remove"));
  assert.ok((DAEMON_CAPABILITIES as readonly string[]).includes("cell.work.v1"));
});

test("cell-work.1: a dirty stopped Cell is evicted with its work bundled and revives byte-identical; ignored output rides cell-keep", { timeout: 300_000 }, async () => {
  const rig = makeRig({ enabled: false, stoppedAfterDays: 0, archivedAfterDays: 0 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const bee = await spawnIdle(client, "worker", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    const cellId = bee.view.cell!.id;
    makeWork(space);
    await stopped(client, bee.beeId);
    const before = snapshot(space);

    const plan = await gc(client);
    const planned = itemFor(plan, bee.beeId);
    assert.equal(planned.verdict, "evict");
    assert.equal(planned.reason, "stopped_age");
    assert.equal(planned.report?.uncommitted, true);
    assert.equal(planned.report?.unpushed, true);
    assert.equal(planned.report?.stashed, true, "a stash is work the bundle carries, not a hold");
    assert.deepEqual({ commits: planned.work?.commits, stashes: planned.work?.stashes, paths: planned.work?.paths, modified: planned.work?.modified, untracked: planned.work?.untracked, bundled: planned.work?.bundled }, { commits: 1, stashes: 1, paths: 3, modified: 2, untracked: 1, bundled: true });
    assert.equal(plan.policy.workBundle, true);
    assert.deepEqual(plan.stale, { keeps: [], bundles: [] });
    assert.equal(existsSync(rig.workRoot), false, "a dry run writes no bundle");
    assert.deepEqual(snapshot(space), before, "a dry run changes nothing");

    const applied = await gc(client, { dryRun: false });
    const outcome = applied.outcomes!.find((o) => o.beeId === bee.beeId)!;
    assert.equal(outcome.status, "evicted");
    assert.deepEqual({ commits: outcome.workBundle?.commits, paths: outcome.workBundle?.paths }, { commits: 1, paths: 3 });
    assert.ok((outcome.workBundle?.bytes ?? 0) > 0 && (outcome.workBundle?.bytes ?? 0) < 20_000, `a few KB: ${outcome.workBundle?.bytes}`);
    assert.deepEqual(outcome.keptPaths, ["artifacts"]);
    assert.equal(existsSync(dirname(space)), false, "the checkout is gone");
    assert.equal(existsSync(join(rig.workRoot, `${cellId}.bundle`)), true);
    assert.equal(existsSync(join(rig.workRoot, `${cellId}.json`)), true);
    assert.equal(existsSync(join(rig.keepRoot, bee.view.cell!.spaceName, "artifacts", "out.js")), true);
    const evicted = await client.request<ViewResult>("view", { beeId: bee.beeId });
    assert.equal(evicted.cell?.state, "evicted");
    assert.equal(evicted.cell?.evictedHead, before.head);
    assert.ok(evicted.cell?.workBundleAt != null && evicted.cell.workBundleSha != null && (evicted.cell.workBundleBytes ?? 0) > 0, "the row carries the bundle");
    assert.equal(evicted.cell?.holdReason, null);
    const log = () => readFileSync(join(rig.dir, "hived.log"), "utf8");
    assert.match(log(), /cell\.work\.bundled cell=.* commits=1 paths=3/);
    assert.match(log(), /cell\.retention\.evicted .*work_bundle=\d+ work_commits=1 work_paths=3/);

    const revived = await revive(client, bee.beeId);
    assert.equal(revived.cell?.state, "active");
    const after = snapshot(space);
    for (const key of ["status", "refs", "head", "branch", "diff", "cached", "stashes"] as const) assert.equal(after[key], before[key], key);
    assert.match(after.stashes, /stash@\{0\} On \(no branch\): parked idea/);
    assert.equal(readFileSync(join(space, "artifacts", "out.js"), "utf8"), "ignored output\n", "kept ignored output came back");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: bee.beeId })).cell?.workBundleAt == null, "bundle reference cleared", 30_000);
    assert.equal(existsSync(join(rig.workRoot, `${cellId}.bundle`)), false, "a verified restore drops the bundle");
    assert.match(log(), /cell\.work\.restored bee=.* commits=1 paths=3/);
    assert.match(log(), /cell\.work\.dropped cell=.* why=restored/);
    assert.equal((await gc(client)).stale?.bundles.length, 0);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-work.2: a 2 GiB untracked file holds the Cell as work_over_cap, named on the row and in the plan; cell.keep.remove clears an evicted Cell's kept files", { timeout: 300_000 }, async () => {
  const rig = makeRig({ enabled: false, stoppedAfterDays: 0, archivedAfterDays: 0 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const big = await spawnIdle(client, "big", rig.origin.repo);
    const bigSpace = big.view.bee!.cwd;
    writeFileSync(join(bigSpace, "note.txt"), "small\n");
    const fd = openSync(join(bigSpace, "huge.bin"), "w");
    writeSync(fd, Buffer.from("end"), 0, 3, 2 * GIB - 3);
    closeSync(fd);
    const kept = await spawnIdle(client, "kept", rig.origin.repo);
    const keptSpace = kept.view.bee!.cwd;
    writeFileSync(join(keptSpace, "notes.md"), "draft\n");
    mkdirSync(join(keptSpace, "artifacts"));
    writeFileSync(join(keptSpace, "artifacts", "out.js"), "ignored output\n");
    await stopped(client, big.beeId);
    await stopped(client, kept.beeId);

    const plan = await gc(client);
    const held = itemFor(plan, big.beeId);
    assert.equal(held.verdict, "hold");
    assert.equal(held.reason, "work_over_cap");
    assert.equal(held.work?.bundled, false);
    assert.equal(held.work?.capturedBytes, 2 * GIB + 6);
    assert.deepEqual(held.work?.largest[0], { path: "huge.bin", bytes: 2 * GIB });
    const row = (await client.request<ViewResult>("view", { beeId: big.beeId })).cell!;
    assert.equal(row.holdReason, "work_over_cap");
    assert.equal(row.holdDetail?.maxBytes, GIB);
    assert.equal(row.holdDetail?.capturedBytes, 2 * GIB + 6);
    assert.deepEqual(row.holdDetail?.largest[0], { path: "huge.bin", bytes: 2 * GIB });
    assert.equal(itemFor(plan, kept.beeId).verdict, "evict");

    const applied = await gc(client, { dryRun: false });
    assert.equal(applied.outcomes!.some((o) => o.beeId === big.beeId), false, "a held Cell is never applied");
    const settled = itemFor(applied, big.beeId);
    assert.equal(settled.reason, "work_over_cap");
    assert.equal(settled.work, null, "settled from the judgment, not inspected again");
    assert.deepEqual(settled.holdDetail?.largest[0], { path: "huge.bin", bytes: 2 * GIB }, "the item still names the paths from the row");
    assert.deepEqual((await client.request<ViewResult>("view", { beeId: big.beeId })).cell?.holdDetail?.largest[0], { path: "huge.bin", bytes: 2 * GIB }, "the row keeps its detail");
    assert.equal(existsSync(join(bigSpace, "huge.bin")), true);
    assert.equal(existsSync(join(bigSpace, ".git")), true);
    assert.equal(applied.outcomes!.find((o) => o.beeId === kept.beeId)?.status, "evicted");
    assert.equal(existsSync(join(rig.keepRoot, kept.view.cell!.spaceName, "artifacts", "out.js")), true);

    const removed = await client.request<CellKeepRemoveResult>("cell.keep.remove", { beeId: kept.beeId });
    assert.deepEqual(removed.removed.map((k) => [k.spaceName, k.beeId]), [[kept.view.cell!.spaceName, kept.beeId]]);
    assert.deepEqual(removed.skipped, []);
    assert.equal(existsSync(join(rig.keepRoot, kept.view.cell!.spaceName)), false);
    assert.equal(existsSync(join(rig.keepRoot, `${kept.view.cell!.spaceName}.json`)), false);
    const again = await client.request<CellKeepRemoveResult>("cell.keep.remove", { beeId: kept.beeId });
    assert.deepEqual(again, { removed: [], skipped: [{ spaceName: kept.view.cell!.spaceName, reason: "nothing_kept" }] });
    const all = await client.request<CellKeepRemoveResult>("cell.keep.remove", { all: true });
    assert.deepEqual(all, { removed: [], skipped: [] });

    const revived = await revive(client, kept.beeId);
    assert.equal(revived.cell?.state, "active");
    assert.equal(g(keptSpace, ["status", "--porcelain"]), "?? notes.md", "the work came back; the removed kept files did not");
    assert.equal(existsSync(join(keptSpace, "artifacts")), false);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-work.3: the pass deletes kept files and unrestored bundles past their windows and reports them; a dry run only plans", { timeout: 300_000 }, async () => {
  const rig = makeRig({ enabled: false, stoppedAfterDays: 0, archivedAfterDays: 0, keepDays: 0, workBundleKeepDays: 0 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const bee = await spawnIdle(client, "stale", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    const cellId = bee.view.cell!.id;
    writeFileSync(join(space, "notes.md"), "draft\n");
    mkdirSync(join(space, "artifacts"));
    writeFileSync(join(space, "artifacts", "out.js"), "ignored output\n");
    await stopped(client, bee.beeId);
    const dry = await gc(client);
    assert.equal(itemFor(dry, bee.beeId).verdict, "evict");
    assert.deepEqual(dry.stale, { keeps: [], bundles: [] }, "nothing is stale before the eviction");
    assert.equal(existsSync(rig.workRoot), false, "a dry run writes nothing");

    const applied = await gc(client, { dryRun: false });
    const outcome = applied.outcomes!.find((o) => o.beeId === bee.beeId)!;
    assert.equal(outcome.status, "evicted");
    assert.deepEqual(outcome.keptPaths, ["artifacts"]);
    assert.ok((outcome.workBundle?.bytes ?? 0) > 0, "the work was bundled before the park");
    assert.deepEqual(applied.stale?.keeps.map((k) => [k.beeId, k.status, k.reason]), [[bee.beeId, "removed", null]], "a zero-day window: the same pass deletes the keep");
    assert.deepEqual(applied.stale?.bundles.map((b) => [b.cellId, b.status, b.reason]), [[cellId, "removed", null]], "and the bundle");
    assert.equal(existsSync(join(rig.workRoot, `${cellId}.bundle`)), false);
    assert.equal(readdirSync(rig.keepRoot).length, 0);
    assert.equal((await client.request<ViewResult>("view", { beeId: bee.beeId })).cell?.workBundleAt, null, "the row no longer claims a bundle");
    const log = readFileSync(join(rig.dir, "hived.log"), "utf8");
    assert.match(log, /cell\.keep\.removed space=/);
    assert.match(log, /cell\.work\.dropped cell=.* why=window_elapsed/);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-work.4: a crash between the park and the registry flip loses nothing: the row still names its bundle, the next runtime start restores the work", { timeout: 300_000 }, async () => {
  const rig = makeRig({ enabled: false, stoppedAfterDays: 0, archivedAfterDays: 0 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir);
    let client = await daemon.client();
    const bee = await spawnIdle(client, "crash", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    const cellId = bee.view.cell!.id;
    makeWork(space);
    await stopped(client, bee.beeId);
    const before = snapshot(space);
    await daemon.stop();
    daemon = null;

    const crashed = spawnSync(process.execPath, [PARK_THEN_CRASH, join(rig.dir, "core.sqlite3"), rig.cellsRoot, cellId], { encoding: "utf8", env: { ...process.env, HIVE_NO_KEYCHAIN: "1" } });
    assert.equal(crashed.signal, "SIGKILL", `the pass died inside the registry write:\n${crashed.stdout}\n${crashed.stderr}`);
    assert.match(crashed.stdout, /cell\.work\.bundled cell=.* commits=1 paths=3/);
    assert.match(crashed.stdout, /parked .*; dying before the registry flips the row/);
    assert.equal(existsSync(dirname(space)), false, "the wrapper was parked");
    assert.ok(readdirSync(join(rig.cellsRoot, "_evicting")).length > 0, "…and waits under _evicting/");
    assert.equal(existsSync(join(rig.workRoot, `${cellId}.bundle`)), true, "the bundle is on disk");

    daemon = await startDaemon(rig.dir);
    client = await daemon.client();
    const row = (await client.request<ViewResult>("view", { beeId: bee.beeId })).cell!;
    assert.equal(row.state, "active", "the crash left the row un-flipped");
    assert.ok(row.workBundleAt != null && row.workBundleSha != null, "but it names its bundle, recorded before the park");
    await waitFor(() => !existsSync(join(rig.cellsRoot, "_evicting")) || readdirSync(join(rig.cellsRoot, "_evicting")).length === 0, "boot swept the parked wrapper", 30_000);

    const revived = await revive(client, bee.beeId);
    assert.equal(revived.cell?.state, "active");
    const after = snapshot(space);
    for (const key of ["status", "refs", "head", "branch", "diff", "cached", "stashes"] as const) assert.equal(after[key], before[key], key);
    assert.equal(readFileSync(join(space, "artifacts", "out.js"), "utf8"), "ignored output\n", "kept ignored output came back too");
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: bee.beeId })).cell?.workBundleAt == null, "bundle reference cleared", 30_000);
    assert.equal(existsSync(join(rig.workRoot, `${cellId}.bundle`)), false);
    assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /cell\.work\.restored bee=.* commits=1 paths=3/);
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});

test("cell-work.5: mode=plan makes the scheduled pass a dry run that still logs and audits its plan; a tiny inspection budget holds the rest as pass_limit; hive cell gc is never cut", { timeout: 300_000 }, async () => {
  const rig = makeRig({ enabled: true, stoppedAfterDays: 0, archivedAfterDays: 0, intervalHours: 200 / 3_600_000, mode: "plan", inspectBudgetSeconds: 0.001 });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(rig.dir, { env: { HIVE_TEST_RETENTION_INITIAL_DELAY_MS: "1500" } });
    const client = await daemon.client();
    const bee = await spawnIdle(client, "planned", rig.origin.repo);
    const space = bee.view.bee!.cwd;
    makeWork(space);
    await stopped(client, bee.beeId);
    const log = () => readFileSync(join(rig.dir, "hived.log"), "utf8");
    await waitFor(() => /cell\.retention\.plan dry_run=true kind=scheduled .*mode=plan/.test(log()), "a scheduled dry run", 60_000);
    await waitFor(() => /cell\.retention\.pass kind=scheduled outcome=dry_run/.test(log()), "…recorded as dry_run", 30_000);
    assert.equal(existsSync(join(space, ".git")), true, "nothing was evicted");
    assert.equal(existsSync(rig.workRoot), false, "no bundle was written");
    assert.doesNotMatch(log(), /cell\.retention\.evicted/);
    const scheduled = /cell\.retention\.plan dry_run=true kind=scheduled [^\n]*budget_cut=(\d+)/.exec(log());
    assert.ok(scheduled && Number(scheduled[1]) >= 1, `the 1 ms budget cut the candidate: ${scheduled?.[0]}`);

    const manual = await gc(client);
    assert.equal(manual.policy.mode, "plan");
    assert.equal(itemFor(manual, bee.beeId).verdict, "evict", "a manual plan is never cut by the budget");
    assert.equal(manual.totals.budgetCut, 0);
    assert.equal(manual.totals.workCells, 1);
    assert.equal(manual.totals.workCommits, 1);
    assert.ok((manual.totals.workCapturedBytes ?? 0) > 0);
    const applied = await gc(client, { dryRun: false });
    assert.equal(applied.outcomes!.find((o) => o.beeId === bee.beeId)?.status, "evicted", "hive cell gc --apply is the operator's explicit act and still applies");
  } finally {
    await daemon?.stop();
    rig.cleanup();
  }
});
