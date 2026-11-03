/**
 * The retention pass touches only what a verdict can act on, in-process with
 * real Cell wrappers and the real inspection worker: live and young Cells are
 * settled from registry facts without an inspection, an inspected hold is
 * remembered until its facts change or `cell.exec` touches the Cell, bytes are
 * walked only for a census or when `statfs` says the byte budget can bind, and
 * the verdicts match a census throughout. Deterministic clock; no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { cellPaths } from "../../driver-cell/src/layout.ts";
import { provisionCell } from "../../driver-cell/src/provision.ts";
import { makeOrigin } from "../../driver-cell/tests/helpers.ts";
import { CellRetentionService } from "../src/cellRetention.ts";
import { defaultCellRetention, type ResolvedCellRetention } from "../src/config.ts";
import type { CellGcResult } from "../src/protocol.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

type Shape = "live" | "young" | "archived_clean" | "archived_dirty";

function rig(policy: Partial<ResolvedCellRetention> = {}, volume: { totalBytes: number; freeBytes: number } = { totalBytes: 100 * GIB, freeBytes: 90 * GIB }) {
  const root = mkdtempSync(join(tmpdir(), "hb-v2-settle-"));
  const cellsRoot = join(root, "cells");
  mkdirSync(cellsRoot);
  const origin = makeOrigin(root);
  const base = 1_800_000_000_000;
  let now = base;
  const store = openCoreStore(join(root, "core.sqlite3"), { ephemeral: true, now: () => now });
  const logs: string[] = [];
  const cells = new Map<Shape, { beeId: string; cellId: string; spaceDir: string }>();
  for (const [index, shape] of (["live", "young", "archived_clean", "archived_dirty"] as Shape[]).entries()) {
    now = shape === "live" ? base - HOUR : shape === "young" ? base - 2 * HOUR : base - 10 * DAY;
    const id = `c${index}`;
    const req = { beeId: `bee-${id}`, originRepo: origin.repo, sha: origin.sha, wrapper: `w-${id}`, repoName: "repo", cellId: id };
    provisionCell(cellsRoot, req, `op-${id}`, { disableCow: true, useGitImages: false });
    const paths = cellPaths(cellsRoot, req.wrapper, req.repoName, req.cellId);
    const { bee, runtime } = store.createBee({ id: req.beeId, name: shape, agent: "stub", substrate: "cell", cwd: paths.spaceDir });
    const cell = store.putCell({ sourceBeeId: bee.id, originRepo: origin.repo, sha: origin.sha, wrapper: req.wrapper, spaceName: `repo-space-${id}`, spaceDir: paths.spaceDir, gitCommonDirRealpath: join(origin.repo, ".git"), objectFormat: "sha1" });
    if (shape === "live") store.updateRuntimeState(bee.id, runtime.generation, "running", { pid: process.pid, pidStartedAt: now });
    else store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    if (shape.startsWith("archived")) store.archiveBee(bee.id);
    if (shape === "archived_dirty") writeFileSync(join(paths.spaceDir, "wip.txt"), "uncommitted\n");
    cells.set(shape, { beeId: bee.id, cellId: cell.id, spaceDir: paths.spaceDir });
  }
  now = base;
  const service = new CellRetentionService({
    cellsRoot,
    policy: { ...defaultCellRetention("workstation"), ...policy },
    store: () => store,
    now: () => now,
    log: (op) => logs.push(op),
    cellInUse: (_beeId, runtime) => runtime != null && runtime.state !== "stopped",
    opInFlight: () => false,
    forgetCell: () => undefined,
    statfs: () => ({ ...volume }),
  });
  const pass = async (opts: { measure?: boolean } = {}): Promise<{ result: CellGcResult; inspected: number; census: boolean }> => {
    const from = logs.length;
    const result = await service.run({ dryRun: true, kind: "scheduled", ...opts });
    const line = logs.slice(from).find((l) => l.startsWith("cell.retention.plan"));
    assert.ok(line, "every pass logs its plan");
    return { result, inspected: Number(/inspected=(\d+)/.exec(line)![1]), census: /census=true/.test(line) };
  };
  const item = (result: CellGcResult, shape: Shape) => result.items.find((i) => i.beeId === cells.get(shape)!.beeId)!;
  return {
    service, store, cells, volume, pass, item,
    cleanup: async () => { await service.stop(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("settle: a default pass inspects only Cells a verdict can act on, walks no bytes, and keeps the census's verdicts", { timeout: 120_000 }, async () => {
  const r = rig();
  try {
    const first = await r.pass();
    assert.equal(first.census, false);
    assert.equal(first.inspected, 2, "the two archived-old Cells; live and young are settled from registry facts");
    assert.deepEqual(
      (["live", "young", "archived_clean", "archived_dirty"] as Shape[]).map((s) => [r.item(first.result, s).verdict, r.item(first.result, s).reason]),
      [["keep", "runtime_live"], ["hold", "too_young"], ["evict", "archived_age"], ["hold", "dirty_uncommitted"]],
    );
    assert.ok(first.result.items.every((i) => i.bytes == null), "no bytes are walked");
    assert.equal(r.item(first.result, "live").head, null, "a settled Cell carries no inspection facts");
    assert.equal(r.item(first.result, "archived_clean").head, r.store.getCell(r.cells.get("archived_clean")!.cellId)!.sha, "an inspected Cell carries its HEAD");
    assert.equal(first.result.purge, undefined);

    const census = await r.pass({ measure: true });
    assert.equal(census.census, true);
    assert.equal(census.inspected, 4, "a census inspects every present Cell");
    assert.ok(census.result.items.every((i) => (i.bytes ?? 0) > 0), "a census walks every Cell's bytes");
    assert.ok(census.result.purge);
    assert.deepEqual(census.result.items.map((i) => [i.beeId, i.verdict, i.reason]), first.result.items.map((i) => [i.beeId, i.verdict, i.reason]), "the census decides the same");
  } finally {
    await r.cleanup();
  }
});

test("settle: an inspected hold stands until its registry facts change or cell.exec touches the Cell; the inspection then re-judges it", { timeout: 120_000 }, async () => {
  const r = rig();
  try {
    assert.equal((await r.pass()).inspected, 2);
    const second = await r.pass();
    assert.equal(second.inspected, 1, "the dirty hold is settled; only the evictable Cell is inspected again");
    assert.equal(r.item(second.result, "archived_dirty").reason, "dirty_uncommitted");
    assert.equal(r.item(second.result, "archived_dirty").verdict, "hold");

    const dirty = r.cells.get("archived_dirty")!;
    unlinkSync(join(dirty.spaceDir, "wip.txt"));
    const stale = await r.pass();
    assert.equal(stale.inspected, 1, "a change no Honeybee event reported leaves the judgment standing");
    assert.equal(r.item(stale.result, "archived_dirty").reason, "dirty_uncommitted", "held, never evicted, until the Cell is re-judged");

    r.service.noteCellTouched(dirty.cellId);
    const touched = await r.pass();
    assert.equal(touched.inspected, 2, "cell.exec on the Cell forces a fresh inspection");
    assert.equal(r.item(touched.result, "archived_dirty").verdict, "evict");
    assert.equal(r.item(touched.result, "archived_dirty").reason, "archived_age");

    writeFileSync(join(dirty.spaceDir, "wip.txt"), "again\n");
    assert.equal(r.item((await r.pass()).result, "archived_dirty").reason, "dirty_uncommitted", "an evictable Cell is always inspected");
    assert.equal((await r.pass()).inspected, 1, "and the new hold settles");
    r.store.markCellParked(dirty.cellId);
    const parked = await r.pass();
    assert.equal(parked.inspected, 2, "a registry fact change (parked_at) re-inspects the Cell");
    assert.equal(r.item(parked.result, "archived_dirty").reason, "dirty_uncommitted");
  } finally {
    await r.cleanup();
  }
});

test("settle: bytes are walked for the byte budget only when statfs shows the volume holding more than the budget", { timeout: 120_000 }, async () => {
  const r = rig({ maxBytes: 10 * GIB, maxBytesVolumeShare: null, stoppedAfterMs: 30 * DAY }, { totalBytes: 100 * GIB, freeBytes: 95 * GIB });
  try {
    const under = await r.pass();
    assert.equal(under.census, false, "5 GiB used cannot exceed a 10 GiB budget");
    assert.ok(under.result.items.every((i) => i.bytes == null));
    r.volume.freeBytes = 50 * GIB;
    const over = await r.pass();
    assert.equal(over.census, true, "50 GiB used may exceed the budget: a census measures the Cells");
    assert.equal(over.inspected, 4);
    assert.ok(over.result.items.every((i) => (i.bytes ?? 0) > 0));
    assert.equal(r.item(over.result, "young").reason, "too_young", "the measured Cells are far below the budget, so nothing is promoted");
  } finally {
    await r.cleanup();
  }
});

test("settle: a tiny budget over a used volume promotes young clean Cells exactly as before", { timeout: 120_000 }, async () => {
  const r = rig({ maxBytes: 1, maxBytesVolumeShare: null }, { totalBytes: 100 * GIB, freeBytes: 50 * GIB });
  try {
    const plan = await r.pass();
    assert.equal(plan.census, true);
    assert.equal(r.item(plan.result, "young").reason, "byte_budget");
    assert.equal(r.item(plan.result, "young").verdict, "evict");
    assert.equal(r.item(plan.result, "archived_dirty").verdict, "hold");
    assert.equal(r.item(plan.result, "live").verdict, "keep");
  } finally {
    await r.cleanup();
  }
});
