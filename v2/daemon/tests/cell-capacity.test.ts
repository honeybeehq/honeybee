/**
 * H2 capacity fact, in-process: the retention service turns a statfs reading
 * into `NodeCapacity`, flips admission only when the floor is crossed with
 * enforcement on, audits each flip once, and reports (never evicts, never
 * refuses) when enforcement is off. Deterministic clock and volume; no daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { CellRetentionService } from "../src/cellRetention.ts";
import { defaultCellRetention } from "../src/config.ts";

const GIB = 1024 ** 3;

function rig(opts: { enforce: boolean; freeBytes: number }) {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-capacity-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  const policy = { ...defaultCellRetention("workstation"), budgetEnforce: opts.enforce, minFreePercent: 10, minFreeBytes: null };
  const volume = { totalBytes: 100 * GIB, freeBytes: opts.freeBytes };
  let now = 1_000_000;
  const audits: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const service = new CellRetentionService({
    cellsRoot: join(dir, "cells"),
    policy,
    store: () => store,
    now: () => now,
    log: (op) => logs.push(op),
    cellInUse: () => false,
    opInFlight: () => false,
    forgetCell: () => undefined,
    statfs: () => ({ ...volume }),
    diskCheckMs: 1_000,
    audit: (kind, payload) => audits.push({ kind, payload }),
  });
  return {
    service, audits, logs, volume,
    advance: (ms: number) => { now += ms; },
    cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("capacity: below the floor with enforcement off reports blocked, keeps admission open, warns once and never starts a pressure pass", () => {
  const r = rig({ enforce: false, freeBytes: 4 * GIB });
  try {
    r.service.tick();
    const capacity = r.service.capacity();
    assert.ok(capacity);
    assert.equal(capacity.schema, 1);
    assert.equal(capacity.cells.floorBytes, 10 * GIB);
    assert.equal(capacity.cells.belowFloor, true);
    assert.deepEqual(capacity.resourceBlocked, { blocked: true, since: 1_000_000, reason: "disk_floor" });
    assert.deepEqual(capacity.admission, { newCells: "accept", enforce: false });
    assert.equal(r.service.refusingNewCells(), null, "warn-only never refuses");
    assert.deepEqual(r.audits.map((a) => a.kind), ["node.capacity"], "the first blocked reading is announced once");
    assert.equal((r.audits[0]!.payload.capacity as { resourceBlocked: { blocked: boolean } }).resourceBlocked.blocked, true);
    assert.equal(r.logs.filter((l) => l.startsWith("cell.pressure.below_floor_warn")).length, 1);
    r.advance(1_500);
    r.service.tick();
    r.advance(1_500);
    r.service.tick();
    assert.equal(r.audits.length, 1, "no re-announcement while nothing flips");
    assert.equal(r.logs.filter((l) => l.startsWith("cell.pressure.below_floor_warn")).length, 1, "the warning is per episode");
    assert.equal(r.logs.some((l) => l.startsWith("cell.pressure.below_floor ")), false, "no pressure pass without enforcement");
    assert.equal(r.service.diskStatus()?.belowFloor, true);
  } finally {
    r.cleanup();
  }
});

test("capacity: enforcement on refuses new Cells below the floor, and the flip back to accept is audited once", () => {
  const r = rig({ enforce: true, freeBytes: 4 * GIB });
  try {
    r.service.tick();
    const refusing = r.service.refusingNewCells();
    assert.ok(refusing, "below the floor with enforcement on refuses");
    assert.deepEqual(refusing.admission, { newCells: "refuse", enforce: true });
    const flips = () => r.audits.filter((a) => a.kind === "node.capacity");
    assert.equal(flips().length, 1);
    r.volume.freeBytes = 40 * GIB;
    r.advance(1_500);
    r.service.tick();
    assert.equal(r.service.refusingNewCells(), null);
    const after = r.service.capacity();
    assert.deepEqual(after?.resourceBlocked, { blocked: false, since: null, reason: null });
    assert.deepEqual(after?.admission, { newCells: "accept", enforce: true });
    assert.deepEqual(flips().map((a) => (a.payload.capacity as { admission: { newCells: string } }).admission.newCells), ["refuse", "accept"]);
    assert.ok(r.audits.some((a) => a.kind === "cell.retention.pass"), "enforcement started a pressure pass");
    assert.ok(r.logs.some((l) => l.startsWith("cell.pressure.recovered")));
  } finally {
    r.cleanup();
  }
});

test("capacity: above the floor from the start announces nothing and reports accept", () => {
  const r = rig({ enforce: true, freeBytes: 60 * GIB });
  try {
    r.service.tick();
    r.advance(1_500);
    r.service.tick();
    assert.deepEqual(r.audits, []);
    const capacity = r.service.capacity();
    assert.equal(capacity?.resourceBlocked.blocked, false);
    assert.equal(capacity?.admission.newCells, "accept");
    assert.equal(capacity?.cells.cellCount, 0);
    assert.equal(capacity?.cells.cellBytes, null, "no pass has measured the Cells yet");
  } finally {
    r.cleanup();
  }
});

test("capacity: Cells are counted from the registry and only the bees that can be using one are asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-capacity-count-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  try {
    const cell = (beeId: string) => {
      store.createBee({ id: beeId, name: beeId, agent: "stub", substrate: "cell", cwd: join(dir, "cells", beeId, "space") });
      return store.putCell({ sourceBeeId: beeId, originRepo: join(dir, "origin"), sha: "a".repeat(40), wrapper: join(dir, "cells", beeId), spaceName: `space-${beeId}`, spaceDir: join(dir, "cells", beeId, "space"), gitCommonDirRealpath: join(dir, "origin", ".git"), objectFormat: "sha1", sandbox: true });
    };
    for (const beeId of ["evicted-1", "evicted-2", "evicted-3"]) store.evictCell(cell(beeId).id, { head: null, bytes: null, reason: "archived_age" });
    for (const beeId of ["retained-1", "retained-2"]) store.retainCell(cell(beeId).id);
    for (const beeId of ["idle-1", "idle-2", "live", "booting"]) cell(beeId);
    const asked: string[] = [];
    const build = (users: (() => Iterable<string>) | undefined) => new CellRetentionService({
      cellsRoot: join(dir, "cells"),
      policy: { ...defaultCellRetention("workstation"), minFreePercent: 10, minFreeBytes: null },
      store: () => store,
      now: () => 1_000_000,
      log: () => undefined,
      cellInUse: (beeId) => { asked.push(beeId); return beeId === "live" || beeId === "booting"; },
      ...(users ? { cellUsers: users } : {}),
      opInFlight: () => false,
      forgetCell: () => undefined,
      statfs: () => ({ totalBytes: 100 * GIB, freeBytes: 50 * GIB }),
      diskCheckMs: 1_000,
    });
    const narrowed = build(() => ["live", "booting", "live", "retained-1", "evicted-1", "no-cell"]);
    narrowed.tick();
    assert.deepEqual([narrowed.capacity()?.cells.cellCount, narrowed.capacity()?.cells.liveCells], [9, 2]);
    assert.deepEqual(asked.sort(), ["booting", "live"], "only active Cells of bees that can be using one are asked");
    asked.length = 0;
    const everyone = build(undefined);
    everyone.tick();
    assert.deepEqual([everyone.capacity()?.cells.cellCount, everyone.capacity()?.cells.liveCells], [9, 2]);
    assert.deepEqual(asked.sort(), ["booting", "idle-1", "idle-2", "live"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
