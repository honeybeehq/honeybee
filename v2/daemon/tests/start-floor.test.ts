import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDaemon } from "../src/daemon.ts";
import { CellRetentionService } from "../src/cellRetention.ts";
import { defaultCellRetention, loadNodeConfig } from "../src/config.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type CommandsResult, type ListResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import { openCoreStore, type AuditRow, type NodeCapacity } from "../../core/src/index.ts";
import { makeDaemonDir, waitFor } from "./helpers.ts";

const GIB = 1024 ** 3;
const HOST_TMP = process.platform === "darwin" ? "/private/tmp" : "/tmp";

interface FakeVolumes {
  hostTmpFreeInodes: number;
  statfs: (path: string) => { device: string; totalBytes: number; freeBytes: number; totalInodes: number | null; freeInodes: number | null };
}

function fakeVolumes(hostTmpFreeInodes: number): FakeVolumes {
  const volumes: FakeVolumes = {
    hostTmpFreeInodes,
    statfs: (path) => path === HOST_TMP
      ? { device: "host-tmp", totalBytes: 8 * GIB, freeBytes: 4 * GIB, totalInodes: 1_048_576, freeInodes: volumes.hostTmpFreeInodes }
      : { device: "data-disk", totalBytes: 1024 * GIB, freeBytes: 500 * GIB, totalInodes: 60_000_000, freeInodes: 59_000_000 },
  };
  return volumes;
}

async function startRig(volumes: FakeVolumes) {
  const savedEnv = { TMPDIR: process.env.TMPDIR, NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE };
  const rig = makeDaemonDir({ tickMs: 20 });
  const cfg = loadNodeConfig(rig.dir);
  const daemon = new HiveDaemon(cfg, {
    keychainReader: async () => null,
    startFloorStatfs: volumes.statfs,
    startFloorSampleMs: 20,
    startFloorBelowSampleMs: 20,
  } as ConstructorParameters<typeof HiveDaemon>[1]);
  await daemon.start();
  const client = await RpcClient.connect(cfg.socketPath);
  return {
    client,
    async capacity(): Promise<NodeCapacity> {
      const info = await client.request<{ capacity: NodeCapacity }>("deployInfo", {});
      return info.capacity;
    },
    async capacityEvents(): Promise<AuditRow[]> {
      const { rows } = await client.request<{ rows: AuditRow[] }>("audit.tail", { afterSeq: 0, limit: 10_000 });
      return rows.filter((row) => row.kind === "node.capacity");
    },
    async cleanup() {
      client.close();
      await daemon.shutdown({ preserveRuntimes: false }).catch(() => undefined);
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rig.cleanup();
    },
    dir: rig.dir,
  };
}

test("R1 start floor: a host /tmp with 0 free inodes is published as a volume under its inode floor and refuses new sessions", async () => {
  const volumes = fakeVolumes(0);
  const rig = await startRig(volumes);
  try {
    const capacity = await rig.capacity();
    assert.equal(capacity.schema, 1);
    assert.ok(capacity.volumes, "capacity.volumes is published");
    assert.ok(rig.client.capabilities.includes("node.capacity.volumes.v1"), "the hello names the capability");
    const hostTmp = capacity.volumes.find((volume) => volume.roles.includes("hostTmp"));
    assert.ok(hostTmp, "the host /tmp is its own volume");
    assert.deepEqual(hostTmp.roles, ["hostTmp"]);
    assert.equal(hostTmp.path, HOST_TMP);
    assert.equal(hostTmp.freeInodes, 0);
    assert.equal(hostTmp.floorInodes, 20_000);
    assert.equal(hostTmp.floorBytes, 512 * 1024 ** 2);
    assert.equal(hostTmp.below, "inodes");
    const data = capacity.volumes.find((volume) => volume.roles.includes("data"));
    assert.ok(data);
    assert.deepEqual(data.roles.filter((role) => role !== "scratch"), ["data", "sockets", "cells"], "folders on one device are reported once");
    assert.equal(data.below, null);
    assert.equal(capacity.resourceBlocked.blocked, true);
    assert.equal(capacity.resourceBlocked.reason, "start_floor");
    assert.deepEqual(capacity.resourceBlocked.detail, { role: "hostTmp", path: HOST_TMP, metric: "inodes", free: 0, floor: 20_000 });
    assert.equal(capacity.admission.newSessions, "refuse");
    assert.equal(capacity.admission.newCells, "refuse");
    assert.equal(capacity.cells.freeInodes, 59_000_000);
    await waitFor(async () => (await rig.capacityEvents()).length === 1, "one node.capacity event on entering the floor", 3000);

    volumes.hostTmpFreeInodes = 500_000;
    await waitFor(async () => (await rig.capacity()).admission.newSessions === "accept", "the floor clears", 3000);
    const cleared = await rig.capacity();
    assert.equal(cleared.resourceBlocked.blocked, false);
    assert.equal(cleared.resourceBlocked.reason, null);
    assert.equal(cleared.resourceBlocked.detail, null);
    assert.equal(cleared.volumes?.find((volume) => volume.roles.includes("hostTmp"))?.below, null);
    await waitFor(async () => (await rig.capacityEvents()).length === 2, "one node.capacity event on leaving the floor", 3000);
    const events = await rig.capacityEvents();
    assert.equal((events[0]!.payload.capacity as NodeCapacity).resourceBlocked.reason, "start_floor");
    assert.equal((events[1]!.payload.capacity as NodeCapacity).admission.newSessions, "accept");
  } finally {
    await rig.cleanup();
  }
});

test("R2 start floor: spawn of an in-place bee under the floor is refused as resource_blocked/start_floor and creates nothing", async () => {
  const volumes = fakeVolumes(0);
  const rig = await startRig(volumes);
  try {
    const refused = await rig.client.request<SpawnResult>("spawn", { name: "floored", agent: "stub", cwd: rig.dir }).then(
      () => null,
      (err: unknown) => err,
    );
    assert.ok(refused instanceof RpcError, "spawn is refused");
    assert.equal(refused.code, "resource_blocked");
    assert.equal(refused.message, `spawn: this computer cannot start sessions: ${HOST_TMP} has 0 free inodes (floor 20000)`);
    assert.deepEqual(refused.details, { reason: "start_floor", role: "hostTmp", path: HOST_TMP, metric: "inodes", free: 0, floor: 20_000 });
    const { views } = await rig.client.request<ListResult>("list", {});
    assert.equal(views.length, 0, "no bee row and no runtime row");
  } finally {
    await rig.cleanup();
  }
});

test("R3 start floor: a wake under the floor is held without a boot attempt, flagged start_floor, and released when the floor lifts", async () => {
  const volumes = fakeVolumes(1_000_000);
  const rig = await startRig(volumes);
  try {
    const { beeId } = await rig.client.request<SpawnResult>("spawn", { name: "waker", agent: "stub", cwd: rig.dir });
    await waitFor(async () => (await rig.client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "first runtime idle", 15_000);
    await rig.client.request("stop", { beeId });
    await waitFor(async () => (await rig.client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", "runtime stopped", 15_000);
    const stoppedGeneration = (await rig.client.request<ViewResult>("view", { beeId })).view.generation ?? 0;

    volumes.hostTmpFreeInodes = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = await rig.client.request<SendRpcResult>("send", { beeId, body: "wake under the floor" });
    assert.ok(sent.messageId > 0, "mail is accepted under the floor");

    await waitFor(async () => {
      const { view } = await rig.client.request<ViewResult>("view", { beeId });
      return view.flags.includes("resource_blocked") || view.generation !== stoppedGeneration;
    }, "the wake is either held or started", 5000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const held = await rig.client.request<ViewResult>("view", { beeId });
    assert.equal(held.view.generation, stoppedGeneration, "no runtime was started");
    assert.equal(held.view.runtimeState, "stopped");
    assert.equal(held.bee?.spawnFailures, 0);
    assert.equal(held.view.blocked, true);
    const flag = held.flagDetails?.find((row) => row.flag === "resource_blocked");
    assert.ok(flag, "the flag detail rides the view");
    assert.deepEqual(flag.startFloor, { role: "hostTmp", path: HOST_TMP, metric: "inodes", free: 0, floor: 20_000 });
    assert.equal(flag.detail, `start_floor:${JSON.stringify({ role: "hostTmp", path: HOST_TMP, metric: "inodes", free: 0, floor: 20_000 })}`);
    const { commands } = await rig.client.request<CommandsResult>("commands", { beeId });
    const wake = commands.find((command) => command.verb === "send_wake" || command.verb === "revive");
    assert.ok(wake, "the wake is queued");
    assert.equal(wake.status, "queued");
    assert.equal(wake.attempts, 0, "no boot attempt was counted");

    const { rows } = await rig.client.request<{ rows: AuditRow[] }>("audit.tail", { afterSeq: 0, limit: 10_000 });
    const flagSet = rows.find((row) => row.kind === "flag.set" && (row.payload.flag as { detail: string }).detail.startsWith("start_floor:"));
    assert.ok(flagSet, "flag.set is audited");

    volumes.hostTmpFreeInodes = 1_000_000;
    await waitFor(async () => {
      const view = (await rig.client.request<ViewResult>("view", { beeId })).view;
      return (view.generation ?? 0) > stoppedGeneration && view.runtimeState === "idle";
    }, "the held wake starts once the floor lifts", 15_000);
    const released = await rig.client.request<ViewResult>("view", { beeId });
    assert.equal(released.view.flags.includes("resource_blocked"), false, "the flag is cleared");
    assert.equal(released.flagDetails, undefined);
    assert.equal(released.bee?.spawnFailures, 0);
  } finally {
    await rig.cleanup();
  }
});

test("R7 start floor: capacity keeps schema 1 and today's fields keep today's values beside the new ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-start-floor-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  try {
    const base = {
      cellsRoot: join(dir, "cells"),
      policy: { ...defaultCellRetention("workstation"), budgetEnforce: true, minFreePercent: 10, minFreeBytes: null },
      store: () => store,
      now: () => 1_000_000,
      log: () => undefined,
      cellInUse: () => false,
      opInFlight: () => false,
      forgetCell: () => undefined,
      statfs: () => ({ totalBytes: 100 * GIB, freeBytes: 4 * GIB }),
    };
    const today = new CellRetentionService(base).capacity(true)!;
    const reading = {
      at: 1_000_000,
      volumes: [{ roles: ["data" as const, "cells" as const], path: dir, totalBytes: 100 * GIB, freeBytes: 4 * GIB, totalInodes: 1000, freeInodes: 900, floorBytes: 512 * 1024 ** 2, floorInodes: 20, below: null }],
      below: null,
      blocksSessions: null,
      blocksCells: null,
      since: null,
    };
    const withVolumes = new CellRetentionService({ ...base, startFloor: () => reading } as ConstructorParameters<typeof CellRetentionService>[0]).capacity(true)!;
    type TodayCapacity = {
      schema: 1;
      checkedAt: number;
      cells: { root: string; totalBytes: number; freeBytes: number; floorBytes: number | null; targetBytes: number | null; belowFloor: boolean; floorUnmet: boolean; cellCount: number; wipBlockedCells?: number; liveCells: number; cellBytes: number | null };
      resourceBlocked: { blocked: boolean; since: number | null; reason: string | null };
      admission: { newCells: "accept" | "refuse"; enforce: boolean };
    };
    const todaysReader = (capacity: TodayCapacity) => ({
      schema: capacity.schema,
      checkedAt: capacity.checkedAt,
      cells: { root: capacity.cells.root, totalBytes: capacity.cells.totalBytes, freeBytes: capacity.cells.freeBytes, floorBytes: capacity.cells.floorBytes, targetBytes: capacity.cells.targetBytes, belowFloor: capacity.cells.belowFloor, floorUnmet: capacity.cells.floorUnmet, cellCount: capacity.cells.cellCount, liveCells: capacity.cells.liveCells, cellBytes: capacity.cells.cellBytes },
      resourceBlocked: { blocked: capacity.resourceBlocked.blocked, since: capacity.resourceBlocked.since, reason: capacity.resourceBlocked.reason },
      admission: { newCells: capacity.admission.newCells, enforce: capacity.admission.enforce },
    });
    assert.equal(withVolumes.schema, 1);
    assert.deepEqual(todaysReader(withVolumes), todaysReader(today));
    assert.equal(today.volumes, undefined);
    assert.deepEqual(withVolumes.volumes, reading.volumes);
    assert.equal(withVolumes.admission.newSessions, "accept");
    assert.equal(withVolumes.resourceBlocked.reason, "disk_floor");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("start floor: a full Cells-only volume refuses Cell starts but never in-place ones, and a volume smaller than the bytes floor is judged on inodes alone", async () => {
  const { StartFloor } = await import("../src/startFloor.ts");
  const { defaultStartFloor } = await import("../src/config.ts");
  const root = mkdtempSync(join(tmpdir(), "hb-v2-start-floor-roles-"));
  for (const name of ["data", "cells", "small-tmp"]) mkdirSync(join(root, name));
  const logs: string[] = [];
  const devices: Record<string, { device: string; totalBytes: number; freeBytes: number; totalInodes: number | null; freeInodes: number | null }> = {
    [join(root, "data")]: { device: "data", totalBytes: 1024 * GIB, freeBytes: 500 * GIB, totalInodes: 1_000_000, freeInodes: 900_000 },
    [join(root, "cells")]: { device: "cells", totalBytes: 1024 * GIB, freeBytes: 100 * 1024 ** 2, totalInodes: 1_000_000, freeInodes: 900_000 },
    [join(root, "small-tmp")]: { device: "tmp", totalBytes: 256 * 1024 ** 2, freeBytes: 200 * 1024 ** 2, totalInodes: 65_536, freeInodes: 60_000 },
  };
  const floor = new StartFloor({
    policy: defaultStartFloor(),
    roles: () => [{ role: "data", path: join(root, "data") }, { role: "hostTmp", path: join(root, "small-tmp") }, { role: "cells", path: join(root, "cells") }],
    now: () => 1,
    log: (op) => logs.push(op),
    statfs: (path) => devices[path]!,
  });
  const reading = floor.sample();
  assert.equal(reading.volumes.find((volume) => volume.path === join(root, "small-tmp"))?.floorBytes, null);
  assert.equal(reading.volumes.find((volume) => volume.path === join(root, "small-tmp"))?.below, null);
  assert.equal(logs.filter((line) => line.startsWith(`node.start_floor.bytes_floor_skipped path=${join(root, "small-tmp")}`)).length, 1);
  assert.equal(floor.refusal("spawn", "hsr"), null, "an in-place start does not write the Cells folder");
  assert.deepEqual(floor.refusal("spawn", "cell")?.details, { reason: "start_floor", role: "cells", path: join(root, "cells"), metric: "bytes", free: 100 * 1024 ** 2, floor: 512 * 1024 ** 2 });
  devices[join(root, "small-tmp")]!.freeInodes = 10;
  floor.sample();
  assert.deepEqual(floor.refusal("spawn", "hsr")?.details, { reason: "start_floor", role: "hostTmp", path: join(root, "small-tmp"), metric: "inodes", free: 10, floor: 20_000 });
  assert.equal(logs.filter((line) => line.startsWith("node.start_floor.bytes_floor_skipped")).length, 1, "the skip is logged once");
  rmSync(root, { recursive: true, force: true });
});
