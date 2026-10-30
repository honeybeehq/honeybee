import { passDiagnostics, readPassDiagnostics } from "./cellRetentionDiagnostics.ts";
import { withoutRpcCaller } from "../../core/src/rpcAuditContext.ts";
/**
 * Cell disk retention (v31) — the daemon policy over Honeybee-owned Cells.
 *
 * Nothing else reclaims a Cell: `hive archive` keeps it (spec 05 point 7),
 * Apiary must not delete Cells behind Honeybee's back, and a workstation
 * accumulates one full checkout per bee forever. This service runs a bounded
 * pass (daily by default, `hive cell gc` on demand) that:
 *
 *  1. gathers registry facts synchronously (cells × bees × runtimes × in-flight
 *     operations) — cheap, on the main thread;
 *  2. inspects every wrapper in a worker thread (git status, HEAD, du walk) —
 *     seconds to minutes on a big root, never on the RPC lane;
 *  3. decides per Cell with a closed verdict/reason vocabulary;
 *  4. optionally applies: each eviction re-checks its preconditions at the
 *     moment it happens, parks the wrapper by an atomic rename
 *     (driver-cell/retention.ts), records `evicted` (+ HEAD) in the registry,
 *     and the parked directories are deleted asynchronously;
 *  5. trims Cells that stay: rebuildable build output of a Cell idle past
 *     `trimAfterMs` is parked the same way, dirty or not, never while in use.
 *
 * An evicted bee keeps its row, mailbox, transcript, cwd and Cell id. Its next
 * runtime start re-provisions the same path at the recorded HEAD and the row
 * returns to `active` (CellDriver.onCellMaterialized). Only CLEAN Cells are
 * ever evicted automatically: no uncommitted changes, no commits the origin
 * lacks, origin reachable. Dirty Cells are listed as held, never evicted.
 * Ignored files that are not rebuildable move to `cell-keep/` on eviction and
 * back on revive.
 */
import { Worker } from "node:worker_threads";
import { existsSync, realpathSync, statfsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { BeeRow, CellRow, CoreStore, NodeCapacity, RuntimeRow } from "../../core/src/index.ts";
import {
  CellDeleteRefused,
  CellHeadMovedError,
  cellEnvRootForCells,
  cellKeepRootForCells,
  evictCellWrapper,
  unparkCellWrapper,
  type EvictResult,
  listPendingKeeps,
  applyParkPlan,
  parkPaths,
  preserveEnvFiles,
  type ParkMode,
  type ParkPlan,
  type ParkPlanWorkerRequest,
  type ParkPlanWorkerResult,
  restoreKeptPaths,
  retentionWorkerUrl,
  sweepEvicting,
  upstreamRootFor,
  type CellWrapperInspection,
  type LandingReceipt,
  type RetentionUpstreamStatus,
  type RetentionWorkerInspection,
  type RetentionWorkerProgress,
  type RetentionWorkerRequest,
  type WipPushWorkerRequest,
  type WipPushWorkerResult,
  type WipRefSweepWorkerRequest,
  type WipRefSweepWorkerResult,
  type RetentionWorkerResult,
  type UpstreamRef,
  type TrimSkip,
  type TrimVerifyWorkerRequest,
  type TrimVerifyWorkerResult,
} from "../../driver-cell/src/index.ts";
import type { ResolvedCellRetention } from "./config.ts";
import {
  CELL_GC_PASS_KINDS,
  CELL_GC_PASS_OUTCOMES,
  type CellDiskStatus,
  type CellGcItem,
  type CellGcOutcome,
  type CellGcPassKind,
  type CellGcPassSummary,
  type CellGcPathBytes,
  type CellGcProgress,
  type CellGcPurgeReport,
  type CellGcReason,
  type CellGcResult,
  type CellGcTrimOutcome,
  type CellGcVerdict,
  type CellParkResult,
} from "./protocol.ts";

export interface CellRetentionDeps {
  cellsRoot: string;
  policy: ResolvedCellRetention;
  store: () => CoreStore;
  now: () => number;
  log: (op: string) => void;
  /**
   * The Cell is in use: for an `active` Cell, the bee's runtime is not stopped
   * or the driver still owns its process; for a `retained` Cell (the bee runs
   * elsewhere) only a live Cell-substrate process for that bee counts.
   */
  cellInUse: (beeId: string, runtime: RuntimeRow | null, cellState: CellRow["state"]) => boolean;
  /** A capture/exec/remove op currently holds the Cell gate. */
  opInFlight: (cellId: string) => boolean;
  /** Drop the driver's cached allocation after a park. */
  forgetCell: (beeId: string) => void;
  /** Tests: substitute the inspection worker entrypoint. */
  workerUrl?: URL;
  /** Delay before the first automatic pass after boot (default 5 min). */
  initialDelayMs?: number;
  /** Data dir: upstream mirrors live under `<dataDir>/upstream/`. Absent = no mirrors. */
  dataDir?: string;
  /** Size and free bytes of the volume holding `path` (default: statfs). */
  statfs?: (path: string) => { totalBytes: number; freeBytes: number };
  /** Append an informational retention audit row. */
  audit?: (kind: "cell.retention.pass" | "cell.pressure.floor_unmet" | "cell.retention.daily_cap" | "cell.parked" | "node.capacity", payload: Record<string, unknown>) => void;
  clearBeeTmp?: (beeId: string) => boolean;
  transcriptObjects?: () => NodeCapacity["transcriptObjects"];
  wipBoxDir?: (cell: CellRow) => string;
  /** Times of retention evictions since `sinceTs`, to restore the daily cap's window after a restart. */
  recentEvictionTimes?: (sinceTs: number) => number[];
  /** When the daily cap was last audited, so a restart does not audit it twice in one window. */
  lastDailyCapAt?: () => number | null;
  /** The newest recorded pass (optionally of one kind), to restore `lastPass` and the floor-unmet episode after a restart. */
  lastRecordedPass?: (kind?: CellGcPassKind) => Record<string, unknown> | null;
  /** Free-space check cadence (default 60 s). */
  diskCheckMs?: number;
  /** After a pass ends floor_unmet, wait this long before the next pressure pass (default 30 min). */
  pressureRetryMs?: number;
  /** Automatic passes refetch a mirror older than this (default 1 h); manual passes after 60 s. */
  upstreamMaxAgeMs?: number;
  /** Bound on one mirror fetch (default 60 s). */
  upstreamTimeoutMs?: number;
}


export interface DiskReading {
  root: string;
  totalBytes: number;
  freeBytes: number;
  floorBytes: number | null;
  targetBytes: number | null;
  bandBytes: number | null;
  floorWarning: string | null;
  at: number;
}

interface Candidate {
  key: string;
  cell: CellRow | null;
  bee: BeeRow | null;
  beeId: string;
  runtime: RuntimeRow | null;
  wrapperDir: string;
  receipts: LandingReceipt[];
}

const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;
const DEFAULT_DISK_CHECK_MS = 60_000;
const DEFAULT_PRESSURE_RETRY_MS = 30 * 60_000;
const DEFAULT_UPSTREAM_MAX_AGE_MS = 60 * 60_000;
const MANUAL_UPSTREAM_MAX_AGE_MS = 60_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000;
const PRESSURE_BATCH = 16;
const DAY_WINDOW_MS = 24 * 60 * 60_000;
const GIB = 1024 ** 3;

export type WipPushTrigger = "turn_ended" | "exited" | "eviction" | "manual";

const AGE_REASONS: ReadonlySet<CellGcReason> = new Set(["archived_age", "stopped_age", "too_young", "policy_disabled"]);

function defaultStatfs(path: string): { totalBytes: number; freeBytes: number } {
  const st = statfsSync(path);
  return { totalBytes: Number(st.blocks) * Number(st.bsize), freeBytes: Number(st.bavail) * Number(st.bsize) };
}

/** The disk-pressure floor and hysteresis target for a volume of `totalBytes`; null floor = trigger off. */
export function pressureThresholds(totalBytes: number, minFreePercent: number | null, minFreeBytes: number | null): { floorBytes: number | null; targetBytes: number | null; bandBytes: number | null } {
  const terms = [minFreePercent == null ? null : (totalBytes * minFreePercent) / 100, minFreeBytes].filter((t): t is number => t != null);
  if (terms.length === 0) return { floorBytes: null, targetBytes: null, bandBytes: null };
  const floorBytes = Math.floor(Math.max(...terms));
  const bandBytes = Math.floor(Math.min(Math.max(totalBytes * 0.02, 10 * GIB), floorBytes / 4));
  return { floorBytes, targetBytes: floorBytes + bandBytes, bandBytes };
}

function summaryFrom(raw: Record<string, unknown> | null): CellGcPassSummary | null {
  if (raw == null) return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const kind = raw.kind as CellGcPassKind;
  const outcome = raw.outcome as CellGcPassSummary["outcome"];
  if (!CELL_GC_PASS_KINDS.includes(kind) || !CELL_GC_PASS_OUTCOMES.includes(outcome)) return null;
  return {
    kind,
    outcome,
    startedAt: num(raw.startedAt) ?? 0,
    endedAt: num(raw.endedAt) ?? 0,
    evicted: num(raw.evicted) ?? 0,
    freedBytes: num(raw.freedBytes),
    freeBefore: num(raw.freeBefore),
    freeAfter: num(raw.freeAfter),
    floorBytes: num(raw.floorBytes),
    targetBytes: num(raw.targetBytes),
    error: typeof raw.error === "string" ? raw.error : null,
    diagnostics: readPassDiagnostics(raw.diagnostics),
  };
}

const TRIM_BLOCKING_REASONS: ReadonlySet<CellGcReason> = new Set([
  "runtime_live",
  "op_in_flight",
  "move_in_flight",
  "handoff_in_flight",
  "already_evicted",
  "already_removed",
  "unregistered",
  "inspect_failed",
  "absent",
  "not_provisioned",
]);

function sumBytes(entries: CellGcPathBytes[]): number | null {
  return entries.some((e) => e.bytes == null) ? null : entries.reduce((sum, e) => sum + (e.bytes ?? 0), 0);
}

function verdictOf(reason: CellGcReason): CellGcVerdict {
  switch (reason) {
    case "archived_age":
    case "stopped_age":
    case "byte_budget":
    case "disk_pressure":
      return "evict";
    case "retained_age":
    case "bee_deleted":
      return "remove_retained";
    case "too_young":
    case "pass_limit":
    case "wip_unconfirmed":
    case "wip_incomplete":
    case "dirty_uncommitted":
    case "dirty_unlanded":
    case "dirty_stash":
    case "dirty_origin_unknown":
    case "not_provisioned":
    case "absent":
    case "unregistered":
    case "inspect_failed":
      return "hold";
    case "policy_disabled":
    case "runtime_live":
    case "op_in_flight":
    case "move_in_flight":
    case "handoff_in_flight":
    case "already_evicted":
    case "already_removed":
      return "keep";
  }
}

export class CellRetentionService {
  private readonly deps: CellRetentionDeps;
  private readonly bootedAt: number;
  private lastPassAt: number | null = null;
  private passInFlight: Promise<CellGcResult> | null = null;
  private sweepInFlight: Promise<void> | null = null;
  private stopping = false;
  private readonly workers = new Set<Worker>();
  private lastDiskCheckAt: number | null = null;
  private lastDisk: DiskReading | null = null;
  private lastStatfsError: string | null = null;
  private lastFloorWarning: string | null = null;
  private floorUnmet = false;
  private unmetAt: number | null = null;
  private unmetFree: number | null = null;
  private lastPass: CellGcPassSummary | null;
  private progress: CellGcProgress | null = null;
  private upstreamRefs = new Map<string, UpstreamRef>();
  private evictionTimes: number[] = [];
  private submoduleHolds: Array<{ cellId: string | null; beeId: string; paths: string[] }> = [];
  private lastCapAuditAt: number | null = null;
  private cappedInPlan = false;
  private blockedSince: number | null = null;
  private announcedAdmission: { blocked: boolean; newCells: NodeCapacity["admission"]["newCells"] } | null = null;
  private warnedBelowFloorAt: number | null = null;
  private lastPresentBytes: number | null = null;
  private cellCounts: { cellCount: number; liveCells: number; at: number } | null = null;
  private readonly wipInFlight = new Map<string, Promise<WipPushWorkerResult>>();
  private readonly wipBlocked = new Map<string, number>();
  private readonly wipConfirmedForEviction = new Map<string, string>();
  private readonly wipLastPushAt = new Map<string, number>();
  private readonly wipTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly wipRerun = new Set<string>();
  private lastWipRefSweepAt: number | null = null;

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.wipTimers.values()) clearTimeout(timer);
    this.wipTimers.clear();
    await Promise.allSettled([...this.workers].map(worker => {
      worker.unref();
      return worker.terminate();
    }));
  }

  private assertRunning(): void {
    if (this.stopping) throw new Error("Cell retention stopped");
  }

  constructor(deps: CellRetentionDeps) {
    this.deps = deps;
    this.bootedAt = deps.now();
    let recorded: Record<string, unknown> | null = null;
    let pressure: Record<string, unknown> | null = null;
    try {
      recorded = deps.lastRecordedPass?.() ?? null;
      pressure = deps.lastRecordedPass?.("pressure") ?? null;
    } catch (err) {
      deps.log(`cell.retention.last_pass_unreadable ${err instanceof Error ? err.message : String(err)}`);
    }
    this.lastPass = summaryFrom(recorded);
    try {
      this.evictionTimes = deps.recentEvictionTimes?.(this.bootedAt - DAY_WINDOW_MS) ?? [];
      this.lastCapAuditAt = deps.lastDailyCapAt?.() ?? null;
    } catch (err) {
      deps.log(`cell.retention.eviction_history_unreadable ${err instanceof Error ? err.message : String(err)}`);
    }
    this.floorUnmet = summaryFrom(pressure)?.outcome === "floor_unmet";
  }

  get policy(): ResolvedCellRetention {
    return this.deps.policy;
  }

  /** Called every daemon tick: a free-space check every `diskCheckMs`, then at most one automatic pass per interval. */
  tick(): void {
    if (this.stopping) return;
    const now = this.deps.now();
    this.checkPressure(now);
    this.sweepWipRefsIfDue(now);
    const policy = this.deps.policy;
    if (!policy.enabled || this.passInFlight) return;
    const due = this.lastPassAt == null
      ? now - this.bootedAt >= (this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
      : now - this.lastPassAt >= policy.intervalMs;
    if (!due) return;
    this.lastPassAt = now;
    void withoutRpcCaller(() => this.run({ dryRun: false, measure: true, kind: "scheduled" })).catch((err) => {
      if (!this.stopping) this.deps.log(`cell.retention.error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    });
  }

  private diskPath(): string {
    let path = resolve(this.deps.cellsRoot);
    while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  }

  /** Measure the Cells volume now; null when statfs fails. */
  readDisk(): DiskReading | null {
    const root = this.diskPath();
    try {
      const { totalBytes, freeBytes } = (this.deps.statfs ?? defaultStatfs)(root);
      if (!(totalBytes > 0) || !(freeBytes >= 0)) throw new Error(`statfs reported total=${totalBytes} free=${freeBytes}`);
      const policy = this.deps.policy;
      const bytesTermFits = policy.minFreeBytes == null || policy.minFreeBytes < totalBytes;
      const floorWarning = bytesTermFits
        ? null
        : `cells.retention.minFreeBytes ${policy.minFreeBytes} is not below the Cells volume size ${totalBytes}; ignored`;
      if (floorWarning !== this.lastFloorWarning && floorWarning != null) this.deps.log(`config.retention.invalid ${floorWarning}`);
      this.lastFloorWarning = floorWarning;
      const reading: DiskReading = {
        root,
        totalBytes,
        freeBytes,
        ...pressureThresholds(totalBytes, policy.minFreePercent, bytesTermFits ? policy.minFreeBytes : null),
        floorWarning,
        at: this.deps.now(),
      };
      this.lastDisk = reading;
      this.lastStatfsError = null;
      return reading;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (detail !== this.lastStatfsError) this.deps.log(`cell.disk.statfs_failed root=${root} err=${JSON.stringify(detail)}`);
      this.lastStatfsError = detail;
      return null;
    }
  }

  /** The byte budget: explicit `maxBytes`, else the configured share of the Cells volume. */
  effectiveMaxBytes(disk: DiskReading | null = this.lastDisk ?? this.readDisk()): number | null {
    const policy = this.deps.policy;
    if (policy.maxBytes != null) return policy.maxBytes;
    if (policy.maxBytesVolumeShare == null || disk == null) return null;
    return Math.floor(disk.totalBytes * policy.maxBytesVolumeShare);
  }

  private checkPressure(now: number): void {
    if (this.lastDiskCheckAt != null && now - this.lastDiskCheckAt < (this.deps.diskCheckMs ?? DEFAULT_DISK_CHECK_MS)) return;
    this.lastDiskCheckAt = now;
    const disk = this.readDisk();
    if (disk == null) return;
    this.announceCapacity(this.capacityOf(disk));
    if (disk.floorBytes == null) return;
    if (disk.freeBytes >= disk.floorBytes) {
      if (this.floorUnmet) this.deps.log(`cell.pressure.recovered free=${disk.freeBytes} floor=${disk.floorBytes}`);
      this.floorUnmet = false;
      this.unmetAt = null;
      this.unmetFree = null;
      this.warnedBelowFloorAt = null;
      return;
    }
    if (!this.deps.policy.budgetEnforce) {
      if (this.warnedBelowFloorAt == null) {
        this.warnedBelowFloorAt = now;
        this.deps.log(`cell.pressure.below_floor_warn free=${disk.freeBytes} floor=${disk.floorBytes} total=${disk.totalBytes} enforce=false (cells.retention.budgetEnforce)`);
      }
      return;
    }
    if (!this.deps.policy.enabled || this.passInFlight) return;
    if (this.unmetAt != null && now - this.unmetAt < (this.deps.pressureRetryMs ?? DEFAULT_PRESSURE_RETRY_MS)) {
      const droppedFurther = this.unmetFree != null && disk.bandBytes != null && this.unmetFree - disk.freeBytes >= disk.bandBytes;
      if (!droppedFurther) return;
    }
    this.deps.log(`cell.pressure.below_floor free=${disk.freeBytes} floor=${disk.floorBytes} target=${disk.targetBytes} total=${disk.totalBytes}`);
    this.passInFlight = withoutRpcCaller(() => this.pressurePass(disk))
      .catch((err) => {
        if (!this.stopping) {
          this.deps.log(`cell.retention.error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
          this.unmetAt = this.deps.now();
          this.unmetFree = disk.freeBytes;
          this.recordPass({
            kind: "pressure", startedAt: now, endedAt: this.deps.now(), outcome: "failed", evicted: 0, freedBytes: null,
            freeBefore: disk.freeBytes, freeAfter: null, floorBytes: disk.floorBytes, targetBytes: disk.targetBytes,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      })
      .finally(() => {
        this.passInFlight = null;
        this.progress = null;
      });
    this.passInFlight.catch(() => undefined);
  }

  parkMode(): ParkMode {
    return this.deps.policy.purgeIgnoredOnPark ? "purge" : "trim";
  }

  capacity(fresh = false): NodeCapacity | null {
    const disk = fresh ? this.readDisk() : this.lastDisk ?? this.readDisk();
    return disk == null ? null : this.capacityOf(disk);
  }

  refusingNewCells(): NodeCapacity | null {
    const capacity = this.capacity(true);
    if (capacity == null) return null;
    this.announceCapacity(capacity);
    return capacity.admission.newCells === "refuse" ? capacity : null;
  }

  private countCells(now: number): { cellCount: number; liveCells: number } {
    const maxAge = this.deps.diskCheckMs ?? DEFAULT_DISK_CHECK_MS;
    if (this.cellCounts && now - this.cellCounts.at < maxAge) return this.cellCounts;
    let cellCount = 0;
    let liveCells = 0;
    try {
      const store = this.deps.store();
      for (const cell of store.listCells()) {
        if (cell.state === "removed" || cell.state === "removing") continue;
        cellCount += 1;
        if (cell.state === "active" && this.deps.cellInUse(cell.sourceBeeId, store.currentRuntime(cell.sourceBeeId), cell.state)) liveCells += 1;
      }
    } catch (err) {
      this.deps.log(`cell.capacity.count_failed ${err instanceof Error ? err.message : String(err)}`);
    }
    this.cellCounts = { cellCount, liveCells, at: now };
    return this.cellCounts;
  }

  private wipBlockedSince(): number | null {
    const store = this.deps.store();
    for (const cellId of [...this.wipBlocked.keys()]) {
      if (store.getCell(cellId)?.state !== "active") this.wipBlocked.delete(cellId);
    }
    if (this.wipBlocked.size === 0) return null;
    return Math.min(...this.wipBlocked.values());
  }

  private capacityOf(disk: DiskReading): NodeCapacity {
    const belowFloor = disk.floorBytes != null && disk.freeBytes < disk.floorBytes;
    if (belowFloor) this.blockedSince ??= disk.at;
    else this.blockedSince = null;
    const wipSince = this.wipBlockedSince();
    const blocked = belowFloor || wipSince != null;
    const enforce = this.deps.policy.budgetEnforce;
    const { cellCount, liveCells } = this.countCells(disk.at);
    return {
      schema: 1,
      checkedAt: disk.at,
      cells: {
        root: disk.root,
        totalBytes: disk.totalBytes,
        freeBytes: disk.freeBytes,
        floorBytes: disk.floorBytes,
        targetBytes: disk.targetBytes,
        belowFloor,
        floorUnmet: this.floorUnmet,
        cellCount,
        liveCells,
        cellBytes: this.lastPresentBytes,
        wipBlockedCells: this.wipBlocked.size,
      },
      resourceBlocked: { blocked, since: belowFloor ? this.blockedSince : wipSince, reason: belowFloor ? "disk_floor" : wipSince != null ? "wip_unconfirmed" : null },
      admission: { newCells: belowFloor && enforce ? "refuse" : "accept", enforce },
      transcriptObjects: this.deps.transcriptObjects?.() ?? null,
    };
  }

  private announceCapacity(capacity: NodeCapacity): void {
    const current = { blocked: capacity.resourceBlocked.blocked, newCells: capacity.admission.newCells };
    const previous = this.announcedAdmission;
    if (previous != null && previous.blocked === current.blocked && previous.newCells === current.newCells) return;
    this.announcedAdmission = current;
    if (previous == null && !current.blocked) return;
    this.deps.log(`node.capacity blocked=${current.blocked} new_cells=${current.newCells} free=${capacity.cells.freeBytes} floor=${capacity.cells.floorBytes ?? "-"} enforce=${capacity.admission.enforce}`);
    try {
      this.deps.audit?.("node.capacity", { capacity });
    } catch (err) {
      this.deps.log(`cell.retention.audit_failed ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `cellDisk` for `deployInfo` / `health`: a fresh statfs plus the pass state. */
  diskStatus(): CellDiskStatus | null {
    const disk = this.readDisk();
    if (disk == null) return null;
    return {
      root: disk.root,
      totalBytes: disk.totalBytes,
      freeBytes: disk.freeBytes,
      floorBytes: disk.floorBytes,
      targetBytes: disk.targetBytes,
      belowFloor: disk.floorBytes != null && disk.freeBytes < disk.floorBytes,
      floorWarning: disk.floorWarning,
      floorUnmet: this.floorUnmet,
      checkedAt: disk.at,
      currentPass: this.progress ? structuredClone(this.progress) : null,
      lastPass: this.lastPass ? structuredClone(this.lastPass) : null,
    };
  }

  /** Delete parked wrappers off the event loop; single-flight, re-armed when one is already running. */
  sweep(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = withoutRpcCaller(() => sweepEvicting(this.deps.cellsRoot))
      .then(({ removed, failed }) => {
        if (removed.length > 0 || failed.length > 0) {
          this.deps.log(`cell.retention.sweep removed=${removed.length} failed=${failed.length}${failed.length > 0 ? ` first=${JSON.stringify(failed[0])}` : ""}`);
        }
      })
      .catch((err) => this.deps.log(`cell.retention.sweep_error ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        this.sweepInFlight = null;
      });
    return this.sweepInFlight;
  }

  /** A sweep that starts after every park so far: waits out one already running, then runs again. */
  private async sweepAfterParks(): Promise<void> {
    if (this.sweepInFlight) await this.sweepInFlight;
    await this.sweep();
  }

  /** Plan (and with `dryRun: false` apply) one pass. Concurrent callers share the in-flight pass. */
  run(opts: { dryRun: boolean; measure: boolean; kind?: CellGcPassKind }): Promise<CellGcResult> {
    if (this.stopping) return Promise.reject(new Error("Cell retention stopped"));
    if (this.passInFlight) return this.passInFlight;
    this.passInFlight = this.pass({ ...opts, kind: opts.kind ?? "manual" }).finally(() => {
      this.passInFlight = null;
      this.progress = null;
    });
    return this.passInFlight;
  }

  private policySnapshot(disk: DiskReading | null): CellGcResult["policy"] {
    const policy = this.deps.policy;
    return {
      enabled: policy.enabled,
      archivedAfterMs: policy.archivedAfterMs,
      stoppedAfterMs: policy.stoppedAfterMs,
      retainedAfterMs: policy.retainedAfterMs,
      maxBytes: this.effectiveMaxBytes(disk),
      maxPerPass: policy.maxPerPass,
      trimAfterMs: policy.trimAfterMs,
      trimPatterns: [...policy.trimPatterns],
      purgeIgnoredOnPark: policy.purgeIgnoredOnPark,
    };
  }

  private startProgress(kind: CellGcPassKind, dryRun: boolean, total: number): CellGcProgress {
    this.submoduleHolds = [];
    this.progress = { kind, dryRun, startedAt: this.deps.now(), total, inspected: 0, planned: 0, plannedBytes: 0, held: 0, heldBytes: 0, dirty: 0, byReason: {} };
    return this.progress;
  }

  private countProgress(progress: CellGcProgress, reason: CellGcReason, bytes: number | null): void {
    const verdict = verdictOf(reason);
    const size = bytes ?? 0;
    progress.inspected += 1;
    if (verdict === "evict" || verdict === "remove_retained") {
      progress.planned += 1;
      progress.plannedBytes += size;
    } else if (verdict === "hold") {
      progress.held += 1;
      progress.heldBytes += size;
    }
    if (reason.startsWith("dirty_")) progress.dirty += 1;
    const entry = progress.byReason[reason] ?? { cells: 0, bytes: 0 };
    entry.cells += 1;
    entry.bytes += size;
    progress.byReason[reason] = entry;
  }

  private recordPass(summary: CellGcPassSummary): void {
    if (summary.diagnostics?.errorCount && summary.error == null) {
      summary.error = `${summary.diagnostics.inspectErrors} Cell inspections and ${summary.diagnostics.applyErrors} Cell apply operations failed`;
    }
    this.lastPass = structuredClone(summary);
    this.deps.log(
      `cell.retention.pass kind=${summary.kind} outcome=${summary.outcome} evicted=${summary.evicted} freed_bytes=${summary.freedBytes ?? "?"}` +
        ` errors=${summary.diagnostics?.errorCount ?? 0} free_before=${summary.freeBefore ?? "?"} free_after=${summary.freeAfter ?? "?"} floor=${summary.floorBytes ?? "-"}${summary.error ? ` err=${JSON.stringify(summary.error)}` : ""}`,
    );
    try {
      this.deps.audit?.("cell.retention.pass", { ...summary, ...(this.submoduleHolds.length > 0 ? { submoduleHolds: this.submoduleHolds } : {}) });
    } catch (err) {
      this.deps.log(`cell.retention.audit_failed ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async pass(opts: { dryRun: boolean; measure: boolean; kind: CellGcPassKind }): Promise<CellGcResult> {
    const startedAt = this.deps.now();
    const before = this.readDisk();
    try {
      const result = await this.planAndApply(opts, startedAt, before);
      if (opts.dryRun) return result;
      await this.sweepAfterParks();
      const after = this.readDisk();
      const evicted = (result.outcomes ?? []).filter((o) => o.status === "evicted" || o.status === "removed").length;
      const trimmed = (result.trimOutcomes ?? []).filter((o) => o.status === "trimmed").length;
      result.pass = {
        kind: opts.kind,
        startedAt,
        endedAt: this.deps.now(),
        outcome: evicted + trimmed > 0 ? "ok" : "nothing_to_do",
        evicted,
        freedBytes: before && after ? Math.max(0, after.freeBytes - before.freeBytes) : null,
        freeBefore: before?.freeBytes ?? null,
        freeAfter: after?.freeBytes ?? null,
        floorBytes: after?.floorBytes ?? before?.floorBytes ?? null,
        targetBytes: after?.targetBytes ?? before?.targetBytes ?? null,
        error: null,
        diagnostics: result.diagnostics,
      };
      this.recordPass(result.pass);
      return result;
    } catch (err) {
      if (!opts.dryRun && !this.stopping) {
        this.recordPass({
          kind: opts.kind, startedAt, endedAt: this.deps.now(), outcome: "failed", evicted: 0, freedBytes: null,
          freeBefore: before?.freeBytes ?? null, freeAfter: null, floorBytes: before?.floorBytes ?? null, targetBytes: before?.targetBytes ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  private async planAndApply(opts: { dryRun: boolean; measure: boolean; kind: CellGcPassKind }, startedAt: number, disk: DiskReading | null): Promise<CellGcResult> {
    const candidates = this.gather();
    const progress = this.startProgress(opts.kind, opts.dryRun, candidates.length);
    const byKey = new Map(candidates.map((c) => [c.key, c] as const));
    for (const c of candidates) if (c.cell?.state === "evicted") this.countProgress(progress, "already_evicted", null);
    const inspectStarted = Date.now();
    const inspections = await this.inspect(candidates, opts.measure, opts.kind, (entry) => {
      const c = byKey.get(entry.key);
      if (!c) return;
      const base = this.baseOf(c, entry.inspection);
      this.countProgress(progress, this.reasonFor(c, entry.inspection, entry.error, this.deps.now(), base), entry.inspection?.bytes ?? null);
    });
    this.assertRunning();
    const inspectMs = Date.now() - inspectStarted;
    const plannedAt = this.deps.now();
    this.cappedInPlan = false;
    const items = this.decide(candidates, inspections, plannedAt, this.effectiveMaxBytes(disk));
    if (this.cappedInPlan && !opts.dryRun) this.auditDailyCap(plannedAt);
    const result: CellGcResult = {
      dryRun: opts.dryRun,
      plannedAt,
      policy: this.policySnapshot(disk),
      items,
      totals: totalsOf(items),
      outcomes: null,
      trimOutcomes: null,
      inspectMs,
      purge: purgeReportOf(items, this.parkMode()),
    };
    this.lastPresentBytes = result.totals.presentBytes;
    this.deps.log(
      `cell.retention.plan dry_run=${opts.dryRun} kind=${opts.kind} cells=${result.totals.cells} planned=${result.totals.plannedCells}` +
        ` planned_bytes=${result.totals.plannedBytes ?? "?"} held=${result.totals.heldCells} dirty=${result.totals.dirtyCells}` +
        ` present_bytes=${result.totals.presentBytes ?? "?"} trim_cells=${result.totals.trimCells} trim_bytes=${result.totals.trimBytes ?? "?"}` +
        ` inspect_ms=${inspectMs} gather_ms=${plannedAt - startedAt - inspectMs}`,
    );
    const inspectionErrors = [...inspections.values()].filter(i => i.error != null || i.inspection == null).length;
    result.diagnostics = passDiagnostics(items, [], [], inspectionErrors);
    if (opts.dryRun) {
      result.pass = {
        kind: opts.kind, startedAt, endedAt: this.deps.now(), outcome: "dry_run", evicted: 0, freedBytes: null,
        freeBefore: disk?.freeBytes ?? null, freeAfter: disk?.freeBytes ?? null, floorBytes: disk?.floorBytes ?? null, targetBytes: disk?.targetBytes ?? null, error: null,
      };
      return result;
    }
    result.outcomes = await this.apply(items);
    this.assertRunning();
    result.trimOutcomes = await this.applyTrims(items);
    const evicted = result.outcomes.filter((o) => o.status === "evicted" || o.status === "removed");
    const trimmed = result.trimOutcomes.filter((o) => o.status === "trimmed");
    this.deps.log(
      `cell.retention.apply evicted=${evicted.length} refused=${result.outcomes.filter((o) => o.status === "refused").length}` +
        ` failed=${result.outcomes.filter((o) => o.status === "failed").length} bytes=${evicted.reduce((sum, o) => sum + (o.bytes ?? 0), 0)}` +
        ` trimmed=${trimmed.length} trim_bytes=${trimmed.reduce((sum, o) => sum + (o.bytes ?? 0), 0)}` +
        ` trim_refused=${result.trimOutcomes.filter((o) => o.status === "refused").length} trim_failed=${result.trimOutcomes.filter((o) => o.status === "failed").length}`,
    );
    result.diagnostics = passDiagnostics(items, result.outcomes ?? [], result.trimOutcomes ?? [], inspectionErrors);
    return result;
  }

  /**
   * Disk pressure: free space is under the floor. Clean Cells of archived
   * bees, then of active bees stopped at least `pressureIdleAfterMs`, oldest
   * idle first, inspected and evicted in small batches until the measured
   * free space reaches the target. Live, held and dirty Cells (including
   * unlanded work) are never evicted and never forced.
   */
  private async pressurePass(disk: DiskReading): Promise<CellGcResult> {
    const startedAt = this.deps.now();
    const policy = this.deps.policy;
    const idleAfter = policy.pressureIdleAfterMs;
    const idle = (c: Candidate) => this.idleSinceOf(c) ?? startedAt;
    const gathered = this.gather();
    const liveCells = gathered.filter((c) => c.cell?.state === "active" && c.runtime != null && c.runtime.state !== "stopped").length;
    const eligible = gathered
      .filter((c) => {
        if (c.cell?.state !== "active" || c.bee == null) return false;
        if (c.bee.lifecycle === "archived") return true;
        if (c.bee.lifecycle !== "active" || idleAfter == null) return false;
        if (c.runtime != null && c.runtime.state !== "stopped") return false;
        return startedAt - idle(c) >= idleAfter;
      })
      .sort((a, b) => {
        const rank = (c: Candidate) => (c.cell?.parkedAt != null ? 0 : c.bee?.lifecycle === "archived" ? 1 : 2);
        return rank(a) - rank(b) || idle(a) - idle(b);
      });
    const floor = disk.floorBytes as number;
    const target = disk.targetBytes as number;
    const progress = this.startProgress("pressure", false, eligible.length);
    const items: CellGcItem[] = [];
    const outcomes: CellGcOutcome[] = [];
    let reading = disk;
    let evicted = 0;
    let inspectMs = 0;
    let inspectionErrors = 0;
    let cursor = 0;
    let capped = false;
    while (!capped && cursor < eligible.length && reading.freeBytes < target && evicted < policy.maxPerPass) {
      const batch = eligible.slice(cursor, cursor + PRESSURE_BATCH);
      const inspectStarted = Date.now();
      const inspections = await this.inspect(batch, true, "pressure");
      inspectionErrors += [...inspections.values()].filter(i => i.error != null || i.inspection == null).length;
      inspectMs += Date.now() - inspectStarted;
      this.assertRunning();
      const now = this.deps.now();
      let projectedFree = reading.freeBytes;
      for (const c of batch) {
        if (projectedFree >= target || evicted >= policy.maxPerPass) break;
        cursor += 1;
        const found = inspections.get(c.key);
        const inspection = found?.inspection ?? null;
        const base = this.baseOf(c, inspection);
        const gate = this.reasonFor(c, inspection, found?.error ?? null, now, base);
        const reason: CellGcReason = AGE_REASONS.has(gate) ? "disk_pressure" : gate;
        const item: CellGcItem = { ...base, reason, verdict: verdictOf(reason) };
        items.push(item);
        this.countProgress(progress, item.reason, item.bytes);
        if (item.verdict !== "evict") continue;
        if (!(await this.wipGate(item))) continue;
        const outcome = this.applyCapped(item);
        if (outcome == null) {
          capped = true;
          break;
        }
        outcomes.push(outcome);
        if (outcome.status === "evicted") {
          evicted += 1;
          projectedFree += item.bytes ?? 0;
        }
        await new Promise<void>((r) => setImmediate(r));
        this.assertRunning();
      }
      await this.sweepAfterParks();
      reading = this.readDisk() ?? reading;
    }
    const met = reading.freeBytes >= floor;
    const summary: CellGcPassSummary = {
      kind: "pressure",
      startedAt,
      endedAt: this.deps.now(),
      outcome: met ? "floor_met" : "floor_unmet",
      evicted,
      freedBytes: Math.max(0, reading.freeBytes - disk.freeBytes),
      freeBefore: disk.freeBytes,
      freeAfter: reading.freeBytes,
      floorBytes: floor,
      targetBytes: target,
      error: null,
      diagnostics: passDiagnostics(items, outcomes, [], inspectionErrors),
    };
    const result: CellGcResult = {
      dryRun: false,
      plannedAt: startedAt,
      policy: this.policySnapshot(reading),
      items,
      totals: totalsOf(items),
      outcomes,
      trimOutcomes: [],
      inspectMs,
      pass: summary,
    };
    this.recordPass(summary);
    if (met) {
      this.floorUnmet = false;
      this.unmetAt = null;
      this.unmetFree = null;
    } else {
      this.reportFloorUnmet(summary, items, eligible.length, liveCells);
    }
    return result;
  }

  private reportFloorUnmet(summary: CellGcPassSummary, items: CellGcItem[], eligible: number, liveCells: number): void {
    this.unmetAt = summary.endedAt;
    this.unmetFree = summary.freeAfter;
    if (this.floorUnmet) return;
    this.floorUnmet = true;
    const group = (pick: (i: CellGcItem) => boolean) => {
      const list = items.filter(pick);
      return { cells: list.length, bytes: list.reduce((sum, i) => sum + (i.bytes ?? 0), 0) };
    };
    const breakdown = {
      dirtyUnlanded: group((i) => i.reason === "dirty_unlanded"),
      dirtyOther: group((i) => i.reason.startsWith("dirty_") && i.reason !== "dirty_unlanded"),
      live: { cells: liveCells + items.filter((i) => i.reason === "runtime_live").length },
      otherHeld: group((i) => !i.reason.startsWith("dirty_") && i.reason !== "runtime_live" && i.verdict !== "evict"),
    };
    this.deps.log(
      `cell.pressure.floor_unmet free=${summary.freeAfter} floor=${summary.floorBytes} evicted=${summary.evicted} eligible=${eligible}` +
        ` held_unlanded=${breakdown.dirtyUnlanded.cells}/${breakdown.dirtyUnlanded.bytes} held_dirty=${breakdown.dirtyOther.cells}/${breakdown.dirtyOther.bytes}` +
        ` live=${breakdown.live.cells} other=${breakdown.otherHeld.cells}`,
    );
    try {
      this.deps.audit?.("cell.pressure.floor_unmet", { ...summary, eligible, ...breakdown });
    } catch (err) {
      this.deps.log(`cell.retention.audit_failed ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Registry facts: every non-removed Cell row plus Cell bees the backfill could not register. */
  private gather(): Candidate[] {
    const store = this.deps.store();
    const root = resolve(this.deps.cellsRoot);
    const out: Candidate[] = [];
    const registeredBees = new Set<string>();
    for (const cell of store.listCells()) {
      if (cell.state === "removed" || cell.state === "removing") continue;
      registeredBees.add(cell.sourceBeeId);
      const bee = store.getBee(cell.sourceBeeId);
      out.push({
        key: cell.id,
        cell,
        bee,
        beeId: cell.sourceBeeId,
        runtime: bee ? store.currentRuntime(bee.id) : null,
        wrapperDir: dirname(resolve(cell.spaceDir)),
        receipts: store.listLandingReceipts(cell.sourceBeeId),
      });
    }
    for (const bee of store.listBees()) {
      if (bee.substrate !== "cell" || bee.lifecycle === "deleted" || bee.cellId || registeredBees.has(bee.id)) continue;
      const wrapperDir = dirname(resolve(bee.cwd));
      if (dirname(wrapperDir) !== root) continue;
      out.push({ key: `bee:${bee.id}`, cell: null, bee, beeId: bee.id, runtime: store.currentRuntime(bee.id), wrapperDir, receipts: store.listLandingReceipts(bee.id) });
    }
    return out;
  }

  private upstreamRequest(kind: CellGcPassKind): RetentionWorkerRequest["upstream"] {
    if (!this.deps.dataDir || !this.deps.policy.fetchUpstream) return null;
    return {
      root: upstreamRootFor(this.deps.dataDir),
      maxAgeMs: kind === "manual" ? MANUAL_UPSTREAM_MAX_AGE_MS : this.deps.upstreamMaxAgeMs ?? DEFAULT_UPSTREAM_MAX_AGE_MS,
      timeoutMs: this.deps.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    };
  }

  private noteUpstreams(statuses: RetentionUpstreamStatus[]): void {
    for (const s of statuses) {
      if (s.ref) this.upstreamRefs.set(s.originRepo, s.ref);
      else this.upstreamRefs.delete(s.originRepo);
      if (s.status === "fetched") this.deps.log(`cell.retention.upstream_fetched origin=${s.originRepo} sha=${s.ref?.sha ?? "-"}`);
      if (s.status === "failed") {
        this.deps.log(`cell.retention.upstream_failed origin=${s.originRepo} url=${JSON.stringify(s.url)} kept=${s.ref?.sha ?? "-"} err=${JSON.stringify(s.error)}`);
      }
    }
  }

  private async inspect(
    candidates: Candidate[],
    measure: boolean,
    kind: CellGcPassKind,
    onProgress?: (entry: RetentionWorkerInspection) => void,
  ): Promise<Map<string, { inspection: CellWrapperInspection | null; error: string | null }>> {
    const wrappers = candidates
      .filter((c) => c.cell?.state !== "evicted")
      .map((c) => ({ key: c.key, wrapperDir: c.wrapperDir, receipts: c.receipts, originRepo: c.cell?.originRepo ?? null }));
    if (wrappers.length === 0) return new Map();
    const message = await this.runWorker<RetentionWorkerResult>(
      { wrappers, measure, trimPatterns: [...this.deps.policy.trimPatterns], upstream: this.upstreamRequest(kind), progress: onProgress != null } satisfies RetentionWorkerRequest,
      onProgress,
    );
    this.noteUpstreams(message.upstreams ?? []);
    for (const entry of message.inspections) {
      const paths = entry.inspection?.dirtySubmodules ?? [];
      if (paths.length === 0) continue;
      const c = candidates.find((x) => x.key === entry.key);
      this.submoduleHolds.push({ cellId: c?.cell?.id ?? null, beeId: c?.beeId ?? "", paths });
      this.deps.log(`cell.retention.submodule_hold cell=${c?.cell?.id ?? "-"} bee=${c?.beeId ?? "-"} paths=${JSON.stringify(paths)}`);
    }
    return new Map(message.inspections.map((i) => [i.key, { inspection: i.inspection, error: i.error }] as const));
  }

  private runWorker<T>(request: RetentionWorkerRequest | TrimVerifyWorkerRequest | ParkPlanWorkerRequest | WipPushWorkerRequest | WipRefSweepWorkerRequest, onProgress?: (entry: RetentionWorkerInspection) => void): Promise<T> {
    this.assertRunning();
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(this.deps.workerUrl ?? retentionWorkerUrl(), { execArgv: [], workerData: request });
      this.workers.add(worker);
      let settled = false;
      worker.on("message", (message: T | RetentionWorkerProgress) => {
        if (settled) return;
        if ((message as RetentionWorkerProgress).kind === "progress") {
          try {
            onProgress?.((message as RetentionWorkerProgress).inspection);
          } catch (err) {
            this.deps.log(`cell.retention.progress_error ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }
        settled = true;
        resolvePromise(message as T);
      });
      worker.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      worker.once("exit", (code) => {
        this.workers.delete(worker);
        if (settled) return;
        settled = true;
        reject(new Error(`cell retention inspection worker exited with code ${code} without a result`));
      });
    });
  }

  private baseOf(c: Candidate, inspection: CellWrapperInspection | null): Omit<CellGcItem, "verdict" | "reason"> {
    return {
      cellId: c.cell?.id ?? null,
      parkedAt: c.cell?.parkedAt ?? null,
      beeId: c.beeId,
      beeName: c.bee?.name ?? "",
      beeLifecycle: c.bee?.lifecycle ?? "deleted",
      runtimeState: c.runtime?.state ?? null,
      cellState: c.cell?.state ?? null,
      wrapperDir: c.wrapperDir,
      originRepo: c.cell?.originRepo ?? null,
      head: inspection?.head ?? null,
      bytes: inspection?.bytes ?? null,
      idleSince: this.idleSinceOf(c),
      report: inspection?.report ?? null,
      envFiles: inspection?.envFiles ?? [],
      trim: { entries: inspection?.trim ?? [], bytes: sumBytes(inspection?.trim ?? []), planned: false },
      install: { entries: inspection?.install ?? [], bytes: sumBytes(inspection?.install ?? []) },
      keep: { entries: inspection?.keep ?? [], bytes: sumBytes(inspection?.keep ?? []) },
    };
  }

  private parkPathsOf(item: Pick<CellGcItem, "trim" | "install" | "keep" | "envFiles">): string[] {
    return parkPathsFor(item, this.parkMode());
  }

  private decide(
    candidates: Candidate[],
    inspections: Map<string, { inspection: CellWrapperInspection | null; error: string | null }>,
    now: number,
    maxBytes: number | null,
  ): CellGcItem[] {
    const policy = this.deps.policy;
    const items: CellGcItem[] = [];
    for (const c of candidates) {
      const found = inspections.get(c.key);
      const inspection = found?.inspection ?? null;
      const base = this.baseOf(c, inspection);
      const reason = this.reasonFor(c, inspection, found?.error ?? null, now, base);
      items.push({ ...base, verdict: verdictOf(reason), reason });
    }
    this.applyByteBudget(items, maxBytes);
    let planned = 0;
    for (const item of items) {
      this.assertRunning();
      if (item.verdict !== "evict" && item.verdict !== "remove_retained") continue;
      planned += 1;
      if (planned > policy.maxPerPass) {
        item.verdict = "hold";
        item.reason = "pass_limit";
      }
    }
    const budget = this.evictionBudget(now);
    if (budget != null) {
      let allowed = budget;
      for (const item of items) {
        if (item.verdict !== "evict" && item.verdict !== "remove_retained") continue;
        if (allowed > 0) allowed -= 1;
        else {
          item.verdict = "hold";
          item.reason = "pass_limit";
          this.cappedInPlan = true;
        }
      }
    }
    for (const item of items) item.trim.planned = this.trimDue(item, now);
    return items;
  }

  private trimDue(item: CellGcItem, now: number): boolean {
    const after = this.deps.policy.trimAfterMs;
    if (after == null || this.parkPathsOf(item).length === 0 || item.idleSince == null) return false;
    if (item.verdict === "evict" || item.verdict === "remove_retained" || TRIM_BLOCKING_REASONS.has(item.reason)) return false;
    return now - item.idleSince >= after;
  }

  private idleSinceOf(c: Pick<Candidate, "cell" | "bee" | "runtime">): number | null {
    if (c.cell == null || c.bee == null) return null;
    if (c.cell.state === "retained") return c.cell.retainedAt ?? c.cell.createdAt;
    if (c.bee.lifecycle === "archived") return c.bee.archivedAt ?? c.bee.createdAt;
    return Math.max(c.runtime?.updatedAt ?? 0, c.bee.lastOutputAt ?? 0, c.bee.createdAt);
  }

  private reasonFor(
    c: Candidate,
    inspection: CellWrapperInspection | null,
    inspectError: string | null,
    now: number,
    base: Omit<CellGcItem, "verdict" | "reason">,
  ): CellGcReason {
    const policy = this.deps.policy;
    if (c.cell?.state === "evicted") return "already_evicted";
    if (c.cell == null) return "unregistered";
    if (inspectError != null || inspection == null) return "inspect_failed";
    if (!inspection.present) return "absent";
    if (!inspection.provisioned) return "not_provisioned";
    if (this.deps.cellInUse(c.beeId, c.runtime, c.cell.state)) return "runtime_live";
    if (this.deps.opInFlight(c.cell.id)) return "op_in_flight";
    if (c.bee?.activeMoveId) return "move_in_flight";
    if (c.bee?.activeHandoffId) return "handoff_in_flight";
    const report = inspection.report;
    const wipCovers = policy.evictionRequiresWip && c.cell.state === "active" && inspection.dirtySubmodules.length === 0;
    if (report?.uncommitted && !wipCovers) return "dirty_uncommitted";
    if (report?.unpushed && !wipCovers) return "dirty_unlanded";
    if (report?.stashed) return "dirty_stash";
    if (report?.originUnknown) return "dirty_origin_unknown";
    if (c.bee == null || c.bee.lifecycle === "deleted") return "bee_deleted";
    const idleFor = now - (base.idleSince ?? now);
    if (c.cell.state === "retained") {
      if (policy.retainedAfterMs == null) return "policy_disabled";
      return idleFor >= policy.retainedAfterMs ? "retained_age" : "too_young";
    }
    if (c.bee.lifecycle === "archived") {
      return idleFor >= policy.archivedAfterMs ? "archived_age" : "too_young";
    }
    if (policy.stoppedAfterMs == null) return "policy_disabled";
    return idleFor >= policy.stoppedAfterMs ? "stopped_age" : "too_young";
  }

  /** Over budget: promote clean-but-young Cells, archived before stopped, oldest idle first. */
  private applyByteBudget(items: CellGcItem[], maxBytes: number | null): void {
    if (maxBytes == null) return;
    const present = items.reduce((sum, i) => sum + (i.bytes ?? 0), 0);
    let planned = items.filter((i) => i.verdict === "evict" || i.verdict === "remove_retained").reduce((sum, i) => sum + (i.bytes ?? 0), 0);
    if (present - planned <= maxBytes) return;
    const young = items
      .filter((i) => i.verdict === "hold" && i.reason === "too_young" && i.cellState === "active" && i.bytes != null)
      .sort((a, b) => {
        const rank = (i: CellGcItem) => (i.parkedAt != null ? 0 : i.beeLifecycle === "archived" ? 1 : 2);
        return rank(a) - rank(b) || (a.idleSince ?? 0) - (b.idleSince ?? 0);
      });
    for (const item of young) {
      if (present - planned <= maxBytes) break;
      item.verdict = "evict";
      item.reason = "byte_budget";
      planned += item.bytes ?? 0;
    }
  }

  private async apply(items: CellGcItem[]): Promise<CellGcOutcome[]> {
    const outcomes: CellGcOutcome[] = [];
    for (const item of items) {
      this.assertRunning();
      if (item.verdict !== "evict" && item.verdict !== "remove_retained") continue;
      if (!(await this.wipGate(item))) continue;
      const outcome = this.applyCapped(item);
      if (outcome) outcomes.push(outcome);
      await new Promise<void>((r) => setImmediate(r));
    }
    return outcomes;
  }

  private async wipGate(item: CellGcItem): Promise<boolean> {
    if (!this.deps.policy.evictionRequiresWip || item.verdict !== "evict" || item.cellId == null) return true;
    const result = await this.pushWip(item.cellId, "eviction");
    this.assertRunning();
    if (result.confirmed && result.snapshot?.complete) {
      this.wipConfirmedForEviction.set(item.cellId, result.snapshot.sha);
      return true;
    }
    const incomplete = result.confirmed && result.snapshot != null && !result.snapshot.complete;
    item.verdict = "hold";
    item.reason = incomplete ? "wip_incomplete" : "wip_unconfirmed";
    this.wipBlocked.set(item.cellId, this.wipBlocked.get(item.cellId) ?? this.deps.now());
    const detail = incomplete ? JSON.stringify(result.snapshot!.skipped.map((s) => s.path)) : JSON.stringify(result.error ?? "ref_mismatch");
    this.deps.log(`cell.retention.held cell=${item.cellId} bee=${item.beeId} reason=${item.reason} ${incomplete ? "skipped" : "err"}=${detail}`);
    return false;
  }

  requestWipPush(cellId: string, trigger: WipPushTrigger): void {
    if (this.stopping) return;
    if (this.wipInFlight.has(cellId)) {
      this.wipRerun.add(cellId);
      return;
    }
    if (this.wipTimers.has(cellId)) return;
    const interval = this.deps.policy.wipMinIntervalMs;
    const since = this.deps.now() - (this.wipLastPushAt.get(cellId) ?? Number.NEGATIVE_INFINITY);
    if (since >= interval) {
      void this.pushWip(cellId, trigger);
      return;
    }
    const timer = setTimeout(() => {
      this.wipTimers.delete(cellId);
      if (!this.stopping) void this.pushWip(cellId, trigger);
    }, interval - since);
    timer.unref();
    this.wipTimers.set(cellId, timer);
  }

  pushWip(cellId: string, trigger: WipPushTrigger): Promise<WipPushWorkerResult> {
    const inFlight = this.wipInFlight.get(cellId);
    if (inFlight) return inFlight;
    const run = this.pushWipNow(cellId, trigger).finally(() => {
      this.wipInFlight.delete(cellId);
      if (this.wipRerun.delete(cellId)) this.requestWipPush(cellId, trigger);
    });
    this.wipInFlight.set(cellId, run);
    return run;
  }

  private sweepWipRefsIfDue(now: number): void {
    const policy = this.deps.policy;
    if (!policy.wipPushOnTurnEnd && !policy.evictionRequiresWip) return;
    if (this.lastWipRefSweepAt != null && now - this.lastWipRefSweepAt < DAY_WINDOW_MS) return;
    this.lastWipRefSweepAt = now;
    void this.sweepWipRefs().catch((err) => {
      if (!this.stopping) this.deps.log(`cell.wip.sweep_failed ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async sweepWipRefs(): Promise<Array<{ originRepo: string; refs: string[] }>> {
    const origins = new Map<string, string[]>();
    for (const cell of this.deps.store().listCells()) {
      if (cell.state === "removed" || cell.state === "removing") continue;
      const live = origins.get(cell.originRepo) ?? [];
      live.push(cell.id);
      origins.set(cell.originRepo, live);
    }
    if (origins.size === 0) return [];
    const result = await this.runWorker<WipRefSweepWorkerResult>({
      kind: "sweepWipRefs",
      origins: [...origins].filter(([originRepo]) => existsSync(originRepo)).map(([originRepo, liveCellIds]) => ({ originRepo, liveCellIds })),
    } satisfies WipRefSweepWorkerRequest);
    if (result.error != null) throw new Error(result.error);
    for (const origin of result.dropped) this.deps.log(`cell.wip.refs_swept origin=${origin.originRepo} dropped=${origin.refs.length}`);
    return result.dropped;
  }

  private async pushWipNow(cellId: string, trigger: WipPushTrigger): Promise<WipPushWorkerResult> {
    const store = this.deps.store();
    const cell = store.getCell(cellId);
    if (!cell || cell.state !== "active") return { snapshot: null, confirmed: false, unchanged: false, error: "cell_not_active" };
    const spaceDir = resolve(cell.spaceDir);
    if (!existsSync(spaceDir)) return { snapshot: null, confirmed: false, unchanged: false, error: "space_absent" };
    const started = Date.now();
    this.wipLastPushAt.set(cellId, this.deps.now());
    let result: WipPushWorkerResult;
    try {
      result = await this.runWorker<WipPushWorkerResult>({
        kind: "pushWip", spaceDir, boxDir: this.deps.wipBoxDir?.(cell) ?? join(dirname(spaceDir), "box"), originRepo: cell.originRepo, cellId,
        maxFileBytes: this.deps.policy.wipMaxFileBytes,
        previous: cell.wipSha && cell.wipTree && cell.wipConfirmedAt != null ? { sha: cell.wipSha, tree: cell.wipTree } : null,
      } satisfies WipPushWorkerRequest);
    } catch (err) {
      result = { snapshot: null, confirmed: false, unchanged: false, error: err instanceof Error ? err.message : String(err) };
    }
    const pushedAt = this.deps.now();
    if (result.snapshot && !result.unchanged) {
      try {
        store.recordCellWip(cellId, { sha: result.snapshot.sha, tree: result.snapshot.tree, pushedAt, confirmedAt: result.confirmed ? pushedAt : null });
      } catch (err) {
        result = { ...result, confirmed: false, error: `registry write failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (result.confirmed) {
      if (result.snapshot?.complete) this.wipBlocked.delete(cellId);
      const skipped = result.snapshot?.skipped ?? [];
      this.deps.log(`cell.wip.${result.unchanged ? "unchanged" : "pushed"} cell=${cellId} bee=${cell.sourceBeeId} trigger=${trigger} sha=${result.snapshot?.sha ?? "-"} dirty=${result.snapshot?.dirty ?? "?"} skipped=${skipped.length}${skipped.length > 0 ? ` first_skip=${JSON.stringify(skipped[0])}` : ""} ms=${Date.now() - started}`);
    } else {
      this.deps.log(`cell.wip.push_failed cell=${cellId} bee=${cell.sourceBeeId} trigger=${trigger} err=${JSON.stringify(result.error ?? "ref_mismatch")} ms=${Date.now() - started}`);
    }
    return result;
  }

  /** Evictions still allowed in the rolling 24 h window; null = no cap. */
  private evictionBudget(now: number): number | null {
    const cap = this.deps.policy.maxEvictionsPerDay;
    if (cap == null) return null;
    this.evictionTimes = this.evictionTimes.filter((t) => now - t < DAY_WINDOW_MS);
    return Math.max(0, cap - this.evictionTimes.length);
  }

  /** Hold an eviction the daily cap forbids; the cap is audited once per window. */
  private holdForDailyCap(item: CellGcItem, now: number): void {
    item.verdict = "hold";
    item.reason = "pass_limit";
    this.auditDailyCap(now);
  }

  private auditDailyCap(now: number): void {
    if (this.lastCapAuditAt != null && now - this.lastCapAuditAt < DAY_WINDOW_MS) return;
    this.lastCapAuditAt = now;
    const payload = { cap: this.deps.policy.maxEvictionsPerDay, evictedInWindow: this.evictionTimes.length, windowStart: now - DAY_WINDOW_MS, at: now };
    this.deps.log(`cell.retention.daily_cap cap=${payload.cap} evicted_in_window=${payload.evictedInWindow}`);
    try {
      this.deps.audit?.("cell.retention.daily_cap", payload);
    } catch (err) {
      this.deps.log(`cell.retention.audit_failed ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** applyOne under the daily cap: a capped item is held, a reclaimed one counts against the window. */
  private applyCapped(item: CellGcItem): CellGcOutcome | null {
    const now = this.deps.now();
    if (this.evictionBudget(now) === 0) {
      this.holdForDailyCap(item, now);
      return null;
    }
    const outcome = this.applyOne(item);
    if (outcome.status === "evicted" || outcome.status === "removed") this.evictionTimes.push(this.deps.now());
    return outcome;
  }

  /** One eviction, preconditions re-checked synchronously at the moment of the rename. */
  private applyOne(item: CellGcItem): CellGcOutcome {
    const store = this.deps.store();
    const outcome = (status: CellGcOutcome["status"], reason: string | null, envFiles: string[] = [], keptPaths: string[] = []): CellGcOutcome => ({
      cellId: item.cellId, beeId: item.beeId, wrapperDir: item.wrapperDir, status, reason, bytes: item.bytes, envFiles, keptPaths,
    });
    const cell = item.cellId ? store.getCell(item.cellId) : null;
    if (!cell || cell.state !== item.cellState) return outcome("refused", "cell_state_changed");
    const bee = store.getBee(item.beeId);
    if (bee && bee.lifecycle !== item.beeLifecycle) return outcome("refused", "lifecycle_changed");
    if (this.deps.cellInUse(item.beeId, store.currentRuntime(item.beeId), cell.state)) return outcome("refused", "runtime_live");
    if (this.deps.opInFlight(cell.id)) return outcome("refused", "op_in_flight");
    if (bee?.activeMoveId) return outcome("refused", "move_in_flight");
    if (bee?.activeHandoffId) return outcome("refused", "handoff_in_flight");
    const wipSha = item.cellId ? this.wipConfirmedForEviction.get(item.cellId) ?? null : null;
    if (item.cellId) this.wipConfirmedForEviction.delete(item.cellId);
    const wipConfirmed = wipSha != null && cell.wipSha === wipSha && cell.wipConfirmedAt != null;
    if (this.deps.policy.evictionRequiresWip && item.verdict === "evict" && !wipConfirmed) return outcome("refused", "wip_unconfirmed");
    try {
      const parked = evictCellWrapper(this.deps.cellsRoot, item.wrapperDir, {
        force: wipConfirmed,
        expectedHead: item.head,
        now: this.deps.now,
        trimPatterns: this.deps.policy.trimPatterns,
        receipts: store.listLandingReceipts(item.beeId),
        upstream: item.originRepo ? this.upstreamRefs.get(item.originRepo) ?? null : null,
      });
      this.deps.forgetCell(item.beeId);
      if (parked == null) {
        if (item.verdict === "remove_retained") store.markCellRemoved(cell.id);
        return outcome("absent", null);
      }
      const env = parked.envFiles.length > 0 ? ` env_files=${parked.envFiles.length} env_stash=${cellEnvRootForCells(this.deps.cellsRoot)}` : "";
      const kept = parked.keptPaths.length > 0 ? ` kept=${parked.keptPaths.length} keep_stash=${cellKeepRootForCells(this.deps.cellsRoot)}` : "";
      const recorded = this.recordOrUnpark(cell.id, item, parked, () => {
        if (item.verdict === "remove_retained") store.markCellRemoved(cell.id);
        else store.evictCell(cell.id, { head: parked.head, bytes: item.bytes, reason: item.reason, envFiles: parked.envFiles, keptPaths: parked.keptPaths });
      });
      if (recorded != null) return outcome("failed", recorded);
      if (item.verdict === "remove_retained") {
        this.deps.log(`cell.retention.removed cell=${cell.id} bee=${item.beeId} reason=${item.reason} head=${parked.head ?? "-"} bytes=${item.bytes ?? "?"} parked=${parked.parkedDir}${env}${kept}`);
        return outcome("removed", item.reason, parked.envFiles, parked.keptPaths);
      }
      this.deps.log(`cell.retention.evicted cell=${cell.id} bee=${item.beeId} reason=${item.reason} head=${parked.head ?? "-"} bytes=${item.bytes ?? "?"} parked=${parked.parkedDir}${env}${kept}${wipSha ? ` wip=${wipSha}${parked.forced ? " dirty" : ""}` : ""}`);
      return outcome("evicted", item.reason, parked.envFiles, parked.keptPaths);
    } catch (err) {
      if (err instanceof CellDeleteRefused) return outcome("refused", "dirty");
      if (err instanceof CellHeadMovedError) return outcome("refused", "head_moved");
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log(`cell.retention.failed cell=${cell.id} bee=${item.beeId} err=${JSON.stringify(detail)}`);
      return outcome("failed", detail);
    }
  }

  /** Record the park in the registry; when that write fails, put the wrapper back and return the error. */
  private recordOrUnpark(cellId: string, item: CellGcItem, parked: EvictResult, record: () => void): string | null {
    try {
      record();
      return null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      try {
        const { keptConflicts } = unparkCellWrapper(this.deps.cellsRoot, item.wrapperDir, parked);
        this.deps.log(`cell.retention.unparked cell=${cellId} bee=${item.beeId} kept_conflicts=${keptConflicts.length} err=${JSON.stringify(detail)}`);
      } catch (undoErr) {
        this.deps.log(`cell.retention.unpark_failed cell=${cellId} bee=${item.beeId} parked=${parked.parkedDir} err=${JSON.stringify(detail)} undo_err=${JSON.stringify(undoErr instanceof Error ? undoErr.message : String(undoErr))}`);
      }
      return `registry write failed: ${detail}`;
    }
  }

  private async applyTrims(items: CellGcItem[]): Promise<CellGcTrimOutcome[]> {
    const planned = items.filter((i) => i.trim.planned);
    if (planned.length === 0) return [];
    const after = this.deps.policy.trimAfterMs ?? 0;
    const verified = await this.runWorker<TrimVerifyWorkerResult>({
      kind: "verifyTrim",
      cells: planned.map((i, index) => ({ key: String(index), wrapperDir: i.wrapperDir, paths: this.parkPathsOf(i), modifiedSinceMs: this.deps.now() - after })),
      trimPatterns: [...this.deps.policy.trimPatterns],
      mode: this.parkMode(),
    } satisfies TrimVerifyWorkerRequest);
    this.assertRunning();
    const byKey = new Map(verified.verified.map((v) => [v.key, v] as const));
    const outcomes: CellGcTrimOutcome[] = [];
    for (const [index, item] of planned.entries()) {
      this.assertRunning();
      outcomes.push(this.trimOne(item, byKey.get(String(index)) ?? null));
      await new Promise<void>((r) => setImmediate(r));
    }
    return outcomes;
  }

  private trimOne(item: CellGcItem, verified: TrimVerifyWorkerResult["verified"][number] | null): CellGcTrimOutcome {
    const store = this.deps.store();
    const mode = this.parkMode();
    const outcome = (status: CellGcTrimOutcome["status"], reason: string | null, paths: string[] = [], skipped: TrimSkip[] = verified?.skipped ?? []): CellGcTrimOutcome => {
      const trimmed = new Set(paths);
      const entries = [...item.trim.entries, ...(item.install?.entries ?? []), ...item.keep.entries].filter((e) => trimmed.has(e.path));
      return { cellId: item.cellId, beeId: item.beeId, wrapperDir: item.wrapperDir, status, reason, paths, skipped, bytes: sumBytes(entries) };
    };
    if (verified == null) return outcome("failed", "verification_missing");
    if (verified.error != null) {
      this.deps.log(`cell.retention.trim_failed cell=${item.cellId} bee=${item.beeId} err=${JSON.stringify(verified.error)}`);
      return outcome("failed", verified.error);
    }
    const cell = item.cellId ? store.getCell(item.cellId) : null;
    if (!cell || cell.state !== item.cellState) return outcome("refused", "cell_state_changed");
    const bee = store.getBee(item.beeId);
    if (bee && bee.lifecycle !== item.beeLifecycle) return outcome("refused", "lifecycle_changed");
    const runtime = store.currentRuntime(item.beeId);
    if (this.deps.cellInUse(item.beeId, runtime, cell.state)) return outcome("refused", "runtime_live");
    if (this.deps.opInFlight(cell.id)) return outcome("refused", "op_in_flight");
    if (bee?.activeMoveId) return outcome("refused", "move_in_flight");
    if (bee?.activeHandoffId) return outcome("refused", "handoff_in_flight");
    const idleSince = this.idleSinceOf({ cell, bee, runtime });
    if (idleSince == null || this.deps.now() - idleSince < (this.deps.policy.trimAfterMs ?? Number.POSITIVE_INFINITY)) return outcome("refused", "not_idle");
    if (verified.confirmed.length === 0) return outcome("refused", "nothing_to_trim");
    try {
      const envFiles = mode === "purge" ? preserveEnvFiles(this.deps.cellsRoot, cell.spaceDir, verified.confirmed.filter((rel) => item.envFiles.includes(rel))) : [];
      const res = parkPaths(this.deps.cellsRoot, item.wrapperDir, verified.confirmed, { now: this.deps.now, label: mode === "purge" ? "park" : "trim", shallow: verified.shallow });
      const skipped = [...verified.skipped, ...res.skipped];
      const result = outcome(res.trimmed.length > 0 ? "trimmed" : "refused", res.trimmed.length > 0 ? null : "nothing_to_trim", res.trimmed, skipped);
      this.deps.log(
        `cell.retention.parked mode=${mode} cell=${cell.id} bee=${item.beeId} paths=${res.trimmed.length} skipped=${skipped.length} bytes=${result.bytes ?? "?"}` +
          ` parked=${res.parkedDir ?? "-"}${envFiles.length > 0 ? ` env_files=${envFiles.length}` : ""}${skipped.length > 0 ? ` first_skip=${JSON.stringify(skipped[0])}` : ""}`,
      );
      if (res.trimmed.length > 0) this.recordParked(cell.id, item.beeId, mode, res.trimmed, result.bytes, envFiles, "idle");
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log(`cell.retention.trim_failed cell=${cell.id} bee=${item.beeId} err=${JSON.stringify(detail)}`);
      return outcome("failed", detail);
    }
  }

  private recordParked(cellId: string, beeId: string, mode: ParkMode, paths: string[], bytes: number | null, envFiles: string[], trigger: "idle" | "operator"): void {
    const tmpCleared = this.deps.clearBeeTmp?.(beeId) ?? false;
    try {
      this.deps.store().markCellParked(cellId);
    } catch (err) {
      this.deps.log(`cell.retention.park_record_failed cell=${cellId} ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.deps.audit?.("cell.parked", { cellId, beeId, mode, trigger, paths, bytes, envFiles, tmpCleared, at: this.deps.now() });
    } catch (err) {
      this.deps.log(`cell.retention.audit_failed ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async planPark(cell: CellRow): Promise<ParkPlan | null> {
    const wrapperDir = dirname(resolve(cell.spaceDir));
    if (!existsSync(wrapperDir)) return null;
    const result = await this.runWorker<ParkPlanWorkerResult>({ kind: "planPark", wrapperDir, mode: this.parkMode(), trimPatterns: [...this.deps.policy.trimPatterns] } satisfies ParkPlanWorkerRequest);
    if (result.error != null) throw new Error(result.error);
    return result.plan;
  }

  applyPark(cell: CellRow, beeId: string, plan: ParkPlan | null): CellParkResult {
    const mode = this.parkMode();
    const wrapperDir = dirname(resolve(cell.spaceDir));
    if (plan == null || !existsSync(wrapperDir)) return { cell, status: "absent", mode, paths: [], skipped: [], bytes: null, sharedBytes: null, envFiles: [] };
    const parked = applyParkPlan(this.deps.cellsRoot, wrapperDir, plan, { now: this.deps.now });
    const status = parked.parked.length > 0 ? "parked" : "nothing_to_park";
    this.deps.log(`cell.park mode=${mode} cell=${cell.id} bee=${beeId} status=${status} paths=${parked.parked.length} skipped=${parked.skipped.length} bytes=${parked.bytes ?? "?"} shared_bytes=${parked.sharedBytes ?? "?"} parked=${parked.parkedDir ?? "-"} env_files=${parked.envFiles.length}`);
    if (status === "parked") {
      this.recordParked(cell.id, beeId, mode, parked.parked, parked.bytes, parked.envFiles, "operator");
      void this.sweep();
    }
    return { cell, status, mode, paths: parked.parked, skipped: parked.skipped, bytes: parked.bytes, sharedBytes: parked.sharedBytes, envFiles: parked.envFiles };
  }

  reconcileKept(): void {
    const pending = listPendingKeeps(this.deps.cellsRoot);
    if (pending.length === 0) return;
    const store = this.deps.store();
    const active = new Map(store.listCells().filter((c) => c.state === "active").map((c) => [basename(resolve(c.spaceDir)), c] as const));
    for (const spaceName of pending) {
      const cell = active.get(spaceName);
      if (!cell) continue;
      try {
        const { restored, conflicts } = restoreKeptPaths(this.deps.cellsRoot, cell.spaceDir);
        if (restored.length > 0 || conflicts.length > 0) {
          this.deps.log(`cell.keep.reconciled cell=${cell.id} bee=${cell.sourceBeeId} restored=${restored.length} conflicts=${conflicts.length}`);
        }
      } catch (err) {
        this.deps.log(`cell.keep.reconcile_failed cell=${cell.id} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export function parkPathsFor(item: Pick<CellGcItem, "trim" | "install" | "keep" | "envFiles">, mode: ParkMode): string[] {
  const trim = item.trim.entries.map((e) => e.path);
  if (mode === "trim") return trim;
  return [...trim, ...(item.install?.entries ?? []).map((e) => e.path), ...item.keep.entries.map((e) => e.path), ...item.envFiles].sort();
}

export function purgeReportOf(items: CellGcItem[], mode: ParkMode): CellGcPurgeReport {
  const inspected = items.filter((i) => i.cellState === "active" && i.reason !== "absent" && i.reason !== "not_provisioned" && i.reason !== "inspect_failed" && i.reason !== "already_evicted");
  const measured = inspected.some((i) => i.bytes != null);
  const sum = (pick: (i: CellGcItem) => number | null) => (measured ? inspected.reduce((acc, i) => acc + (pick(i) ?? 0), 0) : null);
  const groups = new Map<string, { name: string; cells: Set<string>; paths: number; bytes: number }>();
  for (const item of inspected) {
    for (const entry of item.keep.entries) {
      const name = basename(entry.path);
      const group = groups.get(name) ?? { name, cells: new Set<string>(), paths: 0, bytes: 0 };
      group.cells.add(item.beeId);
      group.paths += 1;
      group.bytes += entry.bytes ?? 0;
      groups.set(name, group);
    }
  }
  return {
    mode,
    cells: inspected.length,
    trimBytes: sum((i) => i.trim.bytes),
    installBytes: sum((i) => i.install?.bytes ?? null),
    installSharedBytes: sum((i) => (i.install?.entries ?? []).reduce((acc, e) => acc + (e.sharedBytes ?? 0), 0)),
    otherIgnoredBytes: sum((i) => i.keep.bytes),
    otherIgnored: [...groups.values()]
      .map((g) => ({ name: g.name, cells: g.cells.size, paths: g.paths, bytes: measured ? g.bytes : null }))
      .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || b.cells - a.cells || (a.name < b.name ? -1 : 1)),
  };
}

export function totalsOf(items: CellGcItem[]): CellGcResult["totals"] {
  const measured = items.some((i) => i.bytes != null);
  const sum = (list: CellGcItem[]) => (measured ? list.reduce((acc, i) => acc + (i.bytes ?? 0), 0) : null);
  const planned = items.filter((i) => i.verdict === "evict" || i.verdict === "remove_retained");
  const held = items.filter((i) => i.verdict === "hold");
  return {
    cells: items.length,
    presentBytes: sum(items),
    plannedCells: planned.length,
    plannedBytes: sum(planned),
    heldCells: held.length,
    heldBytes: sum(held),
    dirtyCells: items.filter((i) => i.reason.startsWith("dirty_")).length,
    trimCells: items.filter((i) => i.trim.planned).length,
    trimBytes: measured ? items.filter((i) => i.trim.planned).reduce((acc, i) => acc + (i.trim.bytes ?? 0), 0) : null,
  };
}
