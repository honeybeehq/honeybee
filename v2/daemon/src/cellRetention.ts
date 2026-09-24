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
 *     and the parked directories are deleted asynchronously.
 *
 * An evicted bee keeps its row, mailbox, transcript, cwd and Cell id. Its next
 * runtime start re-provisions the same path at the recorded HEAD and the row
 * returns to `active` (CellDriver.onCellMaterialized). Only CLEAN Cells are
 * ever evicted automatically: no uncommitted changes, no commits the origin
 * lacks, origin reachable. Dirty Cells are listed as held, never touched.
 */
import { Worker } from "node:worker_threads";
import { dirname, resolve } from "node:path";
import type { BeeRow, CellRow, CoreStore, RuntimeRow } from "../../core/src/index.ts";
import {
  CellDeleteRefused,
  CellHeadMovedError,
  evictCellWrapper,
  retentionWorkerUrl,
  sweepEvicting,
  type CellWrapperInspection,
  type RetentionWorkerRequest,
  type RetentionWorkerResult,
} from "../../driver-cell/src/index.ts";
import type { ResolvedCellRetention } from "./config.ts";
import type { CellGcItem, CellGcOutcome, CellGcReason, CellGcResult, CellGcVerdict } from "./protocol.ts";

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
}

interface Candidate {
  key: string;
  cell: CellRow | null;
  bee: BeeRow | null;
  beeId: string;
  runtime: RuntimeRow | null;
  wrapperDir: string;
}

const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;

function verdictOf(reason: CellGcReason): CellGcVerdict {
  switch (reason) {
    case "archived_age":
    case "stopped_age":
    case "byte_budget":
      return "evict";
    case "retained_age":
    case "bee_deleted":
      return "remove_retained";
    case "too_young":
    case "pass_limit":
    case "dirty_uncommitted":
    case "dirty_unlanded":
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

  constructor(deps: CellRetentionDeps) {
    this.deps = deps;
    this.bootedAt = deps.now();
  }

  get policy(): ResolvedCellRetention {
    return this.deps.policy;
  }

  /** Called every daemon tick; starts at most one automatic pass per interval. */
  tick(): void {
    const policy = this.deps.policy;
    if (!policy.enabled || this.passInFlight) return;
    const now = this.deps.now();
    const due = this.lastPassAt == null
      ? now - this.bootedAt >= (this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS)
      : now - this.lastPassAt >= policy.intervalMs;
    if (!due) return;
    this.lastPassAt = now;
    void this.run({ dryRun: false, measure: true }).catch((err) => {
      this.deps.log(`cell.retention.error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    });
  }

  /** Delete parked wrappers off the event loop; single-flight, re-armed when one is already running. */
  sweep(): Promise<void> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = sweepEvicting(this.deps.cellsRoot)
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

  /** Plan (and with `dryRun: false` apply) one pass. Concurrent callers share the in-flight pass. */
  run(opts: { dryRun: boolean; measure: boolean }): Promise<CellGcResult> {
    if (this.passInFlight) return this.passInFlight;
    this.passInFlight = this.pass(opts).finally(() => {
      this.passInFlight = null;
    });
    return this.passInFlight;
  }

  private async pass(opts: { dryRun: boolean; measure: boolean }): Promise<CellGcResult> {
    const startedAt = this.deps.now();
    const candidates = this.gather();
    const inspectStarted = Date.now();
    const inspections = await this.inspect(candidates, opts.measure);
    const inspectMs = Date.now() - inspectStarted;
    const plannedAt = this.deps.now();
    const items = this.decide(candidates, inspections, plannedAt);
    const result: CellGcResult = {
      dryRun: opts.dryRun,
      plannedAt,
      policy: {
        enabled: this.deps.policy.enabled,
        archivedAfterMs: this.deps.policy.archivedAfterMs,
        stoppedAfterMs: this.deps.policy.stoppedAfterMs,
        retainedAfterMs: this.deps.policy.retainedAfterMs,
        maxBytes: this.deps.policy.maxBytes,
        maxPerPass: this.deps.policy.maxPerPass,
      },
      items,
      totals: totalsOf(items),
      outcomes: null,
      inspectMs,
    };
    this.deps.log(
      `cell.retention.plan dry_run=${opts.dryRun} cells=${result.totals.cells} planned=${result.totals.plannedCells}` +
        ` planned_bytes=${result.totals.plannedBytes ?? "?"} held=${result.totals.heldCells} dirty=${result.totals.dirtyCells}` +
        ` present_bytes=${result.totals.presentBytes ?? "?"} inspect_ms=${inspectMs} gather_ms=${plannedAt - startedAt - inspectMs}`,
    );
    if (opts.dryRun) return result;
    result.outcomes = await this.apply(items);
    const evicted = result.outcomes.filter((o) => o.status === "evicted" || o.status === "removed");
    this.deps.log(
      `cell.retention.apply evicted=${evicted.length} refused=${result.outcomes.filter((o) => o.status === "refused").length}` +
        ` failed=${result.outcomes.filter((o) => o.status === "failed").length} bytes=${evicted.reduce((sum, o) => sum + (o.bytes ?? 0), 0)}`,
    );
    void this.sweep();
    return result;
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
      });
    }
    for (const bee of store.listBees()) {
      if (bee.substrate !== "cell" || bee.lifecycle === "deleted" || bee.cellId || registeredBees.has(bee.id)) continue;
      const wrapperDir = dirname(resolve(bee.cwd));
      if (dirname(wrapperDir) !== root) continue;
      out.push({ key: `bee:${bee.id}`, cell: null, bee, beeId: bee.id, runtime: store.currentRuntime(bee.id), wrapperDir });
    }
    return out;
  }

  private inspect(candidates: Candidate[], measure: boolean): Promise<Map<string, { inspection: CellWrapperInspection | null; error: string | null }>> {
    const wrappers = candidates
      .filter((c) => c.cell?.state !== "evicted")
      .map((c) => ({ key: c.key, wrapperDir: c.wrapperDir }));
    if (wrappers.length === 0) return Promise.resolve(new Map());
    const request: RetentionWorkerRequest = { wrappers, measure };
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(this.deps.workerUrl ?? retentionWorkerUrl(), { execArgv: [], workerData: request });
      let settled = false;
      worker.once("message", (message: RetentionWorkerResult) => {
        settled = true;
        resolvePromise(new Map(message.inspections.map((i) => [i.key, { inspection: i.inspection, error: i.error }] as const)));
      });
      worker.once("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      worker.once("exit", (code) => {
        if (settled) return;
        settled = true;
        reject(new Error(`cell retention inspection worker exited with code ${code} without a result`));
      });
    });
  }

  private decide(
    candidates: Candidate[],
    inspections: Map<string, { inspection: CellWrapperInspection | null; error: string | null }>,
    now: number,
  ): CellGcItem[] {
    const policy = this.deps.policy;
    const items: CellGcItem[] = [];
    for (const c of candidates) {
      const found = inspections.get(c.key);
      const inspection = found?.inspection ?? null;
      const base: Omit<CellGcItem, "verdict" | "reason"> = {
        cellId: c.cell?.id ?? null,
        beeId: c.beeId,
        beeName: c.bee?.name ?? "",
        beeLifecycle: c.bee?.lifecycle ?? "deleted",
        runtimeState: c.runtime?.state ?? null,
        cellState: c.cell?.state ?? null,
        wrapperDir: c.wrapperDir,
        originRepo: c.cell?.originRepo ?? null,
        head: inspection?.head ?? null,
        bytes: inspection?.bytes ?? null,
        idleSince: null,
        report: inspection?.report ?? null,
      };
      const reason = this.reasonFor(c, inspection, found?.error ?? null, now, base);
      items.push({ ...base, verdict: verdictOf(reason), reason });
    }
    this.applyByteBudget(items, policy.maxBytes);
    let planned = 0;
    for (const item of items) {
      if (item.verdict !== "evict" && item.verdict !== "remove_retained") continue;
      planned += 1;
      if (planned > policy.maxPerPass) {
        item.verdict = "hold";
        item.reason = "pass_limit";
      }
    }
    return items;
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
    if (report?.uncommitted) return "dirty_uncommitted";
    if (report?.unpushed) return "dirty_unlanded";
    if (report?.originUnknown) return "dirty_origin_unknown";
    if (c.bee == null || c.bee.lifecycle === "deleted") return "bee_deleted";
    if (c.cell.state === "retained") {
      base.idleSince = c.cell.retainedAt ?? c.cell.createdAt;
      if (policy.retainedAfterMs == null) return "policy_disabled";
      return now - base.idleSince >= policy.retainedAfterMs ? "retained_age" : "too_young";
    }
    if (c.bee.lifecycle === "archived") {
      base.idleSince = c.bee.archivedAt ?? c.bee.createdAt;
      return now - base.idleSince >= policy.archivedAfterMs ? "archived_age" : "too_young";
    }
    base.idleSince = Math.max(c.runtime?.updatedAt ?? 0, c.bee.lastOutputAt ?? 0, c.bee.createdAt);
    if (policy.stoppedAfterMs == null) return "policy_disabled";
    return now - base.idleSince >= policy.stoppedAfterMs ? "stopped_age" : "too_young";
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
        const rank = (i: CellGcItem) => (i.beeLifecycle === "archived" ? 0 : 1);
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
      if (item.verdict !== "evict" && item.verdict !== "remove_retained") continue;
      outcomes.push(this.applyOne(item));
      await new Promise<void>((r) => setImmediate(r));
    }
    return outcomes;
  }

  /** One eviction, preconditions re-checked synchronously at the moment of the rename. */
  private applyOne(item: CellGcItem): CellGcOutcome {
    const store = this.deps.store();
    const outcome = (status: CellGcOutcome["status"], reason: string | null): CellGcOutcome => ({
      cellId: item.cellId, beeId: item.beeId, wrapperDir: item.wrapperDir, status, reason, bytes: item.bytes,
    });
    const cell = item.cellId ? store.getCell(item.cellId) : null;
    if (!cell || cell.state !== item.cellState) return outcome("refused", "cell_state_changed");
    const bee = store.getBee(item.beeId);
    if (bee && bee.lifecycle !== item.beeLifecycle) return outcome("refused", "lifecycle_changed");
    if (this.deps.cellInUse(item.beeId, store.currentRuntime(item.beeId), cell.state)) return outcome("refused", "runtime_live");
    if (this.deps.opInFlight(cell.id)) return outcome("refused", "op_in_flight");
    if (bee?.activeMoveId) return outcome("refused", "move_in_flight");
    if (bee?.activeHandoffId) return outcome("refused", "handoff_in_flight");
    try {
      const parked = evictCellWrapper(this.deps.cellsRoot, item.wrapperDir, { expectedHead: item.head, now: this.deps.now });
      this.deps.forgetCell(item.beeId);
      if (parked == null) {
        if (item.verdict === "remove_retained") store.markCellRemoved(cell.id);
        return outcome("absent", null);
      }
      if (item.verdict === "remove_retained") {
        store.markCellRemoved(cell.id);
        this.deps.log(`cell.retention.removed cell=${cell.id} bee=${item.beeId} reason=${item.reason} head=${parked.head ?? "-"} bytes=${item.bytes ?? "?"} parked=${parked.parkedDir}`);
        return outcome("removed", item.reason);
      }
      store.evictCell(cell.id, { head: parked.head, bytes: item.bytes, reason: item.reason });
      this.deps.log(`cell.retention.evicted cell=${cell.id} bee=${item.beeId} reason=${item.reason} head=${parked.head ?? "-"} bytes=${item.bytes ?? "?"} parked=${parked.parkedDir}`);
      return outcome("evicted", item.reason);
    } catch (err) {
      if (err instanceof CellDeleteRefused) return outcome("refused", "dirty");
      if (err instanceof CellHeadMovedError) return outcome("refused", "head_moved");
      const detail = err instanceof Error ? err.message : String(err);
      this.deps.log(`cell.retention.failed cell=${cell.id} bee=${item.beeId} err=${JSON.stringify(detail)}`);
      return outcome("failed", detail);
    }
  }
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
  };
}
