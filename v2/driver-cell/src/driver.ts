import type { ExecutionStart } from "../../core/src/executionStart.ts";
import { ExecutionFenceError } from "../../core/src/executionFence.ts";
import { stateDirectory } from "../../harness/src/statePath.ts";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { Worker } from "node:worker_threads";
import type { DriverObservation, LiveProcess } from "../../harness/src/driver.ts";
import type { FlagEvidence, PreparedStart, SpawnSpec } from "../../driver-hsr/src/index.ts";
import { captureWork, type CaptureMode, type CaptureReport } from "./capture.ts";
import { cellPaths, looksLikeCellWrapper, type CellPaths } from "./layout.ts";
import { isProvisioned, readLedger, type CellLedger } from "./ledger.ts";
import { provisionCell, type ProvisionedCell, type ProvisionRequest, restoreWipAfterProvision } from "./provision.ts";
import { describeSandboxTmpfs, SandboxTmpWatch, sandboxTmpfsCap, type SandboxTmpfsCap } from "./sandboxTmp.ts";
import { claimFromPool, repoKeyFor } from "./warmPool.ts";
import type { PoolWorkerResult, RefreshRequest } from "./poolWorker.ts";
import { deleteCell, type DeleteResult, type DirtyReportOptions } from "./remove.ts";
import {
  DEFAULT_SANDBOX_TMPFS_BYTES,
  defaultWritablePaths,
  mergeSandboxWritablePaths,
  sandboxEnabled,
  wrapWithSandbox,
  type NodeKind,
  type SandboxWritableDirectory,
} from "./sandbox.ts";

/** What the cell driver needs to know per bee, beyond the harness spawn. */
export interface CellSpec {
  /** The provisioning request (origin, sha, layout, warm artifacts). */
  provision: ProvisionRequest;
  /** Per-cell sandbox override; null/undefined = node-kind default (A4). */
  sandbox?: boolean | null;
}

export interface CellServiceConfig {
  cellsRoot: string;
  nodeKind: NodeKind;
  resolveCell(beeId: string): CellSpec;
  runtimeLive(beeId: string): boolean;
  /** Baseline sandbox-writable paths (defaults: harness homes + caches). */
  sandboxWritablePaths?: string[];
  sandboxKvm?: boolean;
  /**
   * Additional authoritative paths for this bee. Callers must derive these
   * from trusted state, never from the harness spawn environment.
   */
  resolveSandboxWritablePaths?(beeId: string): readonly SandboxWritableDirectory[];
  sandboxTmpfsBytes?: number | null;
  sandboxTmpSampleMs?: number;
  log?(op: string): void;
  /** Tests: force the clone fallback / cold cells. */
  disableCow?: boolean;
  /** Daemon mode: provision Cells off the RPC/event-loop hot lane. */
  backgroundProvisioning?: boolean;
  /** Tests: substitute the provisioning worker entrypoint. */
  provisionWorkerUrl?: URL;
  /** Override the Honeybee-owned Git-image root (tests). */
  gitImagesRoot?: string;
  /**
   * Per-repository warm Cell pool (2026-09-21 spawn-floor work). When set with
   * `targetFree > 0`, each spawn first tries to CLAIM a pre-provisioned member
   * (rename + checkout delta) instead of a cold clone+checkout, then tops the
   * pool back up in the background off the event loop. Absent/0 = disabled
   * (identical behaviour to before). See warmPool.ts.
   */
  warmPool?: { targetFree: number; maxSize?: number };
  /** Tests: substitute the pool top-up worker entrypoint. */
  poolWorkerUrl?: URL;
  upstreamRefresh?: { root: string } & Partial<UpstreamRefreshPolicy>;
  onUpstreamRefreshed?(originRepo: string, result: PoolWorkerResult): void;
  /**
   * v31 — the Cell's checkout now exists on disk for a runtime start (cold
   * provision, background provision, or a warm-pool claim). The daemon uses
   * it to move an `evicted` registry row back to `active`. Idempotent.
   */
  onCellMaterialized?(beeId: string, execution?: ExecutionStart): void;
}

export interface UpstreamRefreshPolicy {
  intervalMs: number;
  maxAgeMs: number;
  recentMs: number;
  timeoutMs: number;
}

export const DEFAULT_UPSTREAM_REFRESH: UpstreamRefreshPolicy = {
  intervalMs: 2 * 60_000,
  maxAgeMs: 30_000,
  recentMs: 24 * 60 * 60_000,
  timeoutMs: 15_000,
};

interface TrackedOrigin {
  request: RefreshRequest;
  lastUsedAt: number;
  lastFetchAt: number;
}

interface PendingProvision {
  beeId: string;
  generation: number;
  worker: Worker;
  settled: boolean;
  done: (failure?: string) => void;
}

interface ProvisionWorkerResult {
  ok: boolean;
  error?: string;
  wipRestore?: { restored: boolean; reason: string | null; branches?: string[] };
}

/** `removeCell` refusal: the bee still has a live runtime — stop it first. */
export class CellRuntimeLiveError extends Error {
  constructor(beeId: string) {
    super(`removeCell: bee ${beeId} still has a live runtime; stop it before removing its cell`);
    this.name = "CellRuntimeLiveError";
  }
}

export class CellService {
  private readonly cfg: CellServiceConfig;
  private readonly cells = new Map<string, ProvisionedCell>();
  private readonly pending = new Map<string, PendingProvision>();
  private readonly maintenanceWorkers = new Set<Worker>();
  private readonly maintenanceByRuntime = new Map<string, Worker>();
  private readonly poolWorkers = new Map<string, Worker>();
  private sandboxTmp: SandboxTmpWatch | null = null;
  private sandboxCap: SandboxTmpfsCap | null = null;
  private readonly origins = new Map<string, TrackedOrigin>();
  private readonly upstreamPolicy: (UpstreamRefreshPolicy & { root: string }) | null;
  private upstreamTimer: ReturnType<typeof setInterval> | null = null;

  constructor(cfg: CellServiceConfig) {
    stateDirectory(cfg.cellsRoot, "cellsRoot");
    if (cfg.gitImagesRoot !== undefined) stateDirectory(cfg.gitImagesRoot, "gitImagesRoot");
    if (cfg.upstreamRefresh !== undefined) stateDirectory(cfg.upstreamRefresh.root, "upstreamRefresh.root");
    this.cfg = cfg;
    this.upstreamPolicy = cfg.upstreamRefresh == null ? null : { ...DEFAULT_UPSTREAM_REFRESH, ...cfg.upstreamRefresh };
  }

  prepare(beeId: string, generation: number, execution: ExecutionStart | null, done: (failure?: string) => void): PreparedStart | null {
    if (execution) throw new ExecutionFenceError("rpc_execution_fence_unsupported", "Fenced Cell preparation is NOT_COVERED until descendant containment is reviewed and proven");
    const opId = `start-${beeId}-g${generation}`;
    if (this.cfg.backgroundProvisioning !== true) {
      const claimed = this.warmPoolEnabled() ? this.tryClaimFromPool(beeId) : null;
      if (claimed) this.cells.set(beeId, claimed);
      else this.ensureCell(beeId, opId);
      this.cfg.onCellMaterialized?.(beeId);
      this.refreshOriginOf(beeId);
      return null;
    }
    if (this.pending.has(beeId)) {
      throw new Error(`cell service: bee ${beeId} already has provisioning in flight`);
    }
    const spec = this.cfg.resolveCell(beeId);
    const workerUrl = this.cfg.provisionWorkerUrl ?? (import.meta.url.endsWith(".ts")
      ? new URL("./provisionWorker.ts", import.meta.url)
      : new URL("./provision-worker.js", import.meta.url));
    const worker = new Worker(workerUrl, {
      execArgv: [],
      workerData: {
        cellsRoot: this.cfg.cellsRoot,
        request: spec.provision,
        opId,
        disableCow: this.cfg.disableCow ?? false,
        useGitImages: this.cfg.nodeKind === "workstation",
        gitImagesRoot: this.cfg.gitImagesRoot,
        claimFromPool: this.warmPoolEnabled(),
      },
    });
    const pending: PendingProvision = { beeId, generation, worker, settled: false, done };
    this.pending.set(beeId, pending);
    worker.once("message", (message: ProvisionWorkerResult) => {
      this.refreshOriginOf(beeId);
      if (message.wipRestore) this.logWipRestore(beeId, message.wipRestore);
      if (message.ok) {
        this.maintenanceWorkers.add(worker);
        this.maintenanceByRuntime.set(`${pending.beeId}:g${pending.generation}`, worker);
        worker.unref();
        this.finishProvision(pending);
      }
      else this.failProvision(pending, message.error ?? "cell provisioning failed");
    });
    worker.once("error", (error) => this.failProvision(
      pending,
      error instanceof Error ? error.message : String(error),
    ));
    worker.once("exit", (code) => {
      this.maintenanceWorkers.delete(worker);
      for (const [key, candidate] of this.maintenanceByRuntime) {
        if (candidate === worker) this.maintenanceByRuntime.delete(key);
      }
      if (!pending.settled) {
        this.failProvision(
          pending,
          `cell provisioning worker exited with code ${code} without a result`,
        );
      }
    });
    return {
      cancel: () => {
        if (pending.settled || this.pending.get(beeId) !== pending) return;
        pending.settled = true;
        this.pending.delete(beeId);
        void pending.worker.terminate();
      },
    };
  }

  observed(event: DriverObservation): void {
    if (event.kind === "exited") this.sandboxTmp?.exited(event.beeId, event.generation);
    if (event.kind !== "turn_ended" && event.kind !== "exited") return;
    const key = `${event.beeId}:g${event.generation}`;
    const worker = this.maintenanceByRuntime.get(key);
    if (worker == null) return;
    this.maintenanceByRuntime.delete(key);
    worker.postMessage({ kind: "refresh_git_image" });
  }

  evidence(live: () => LiveProcess[], clearedBeeIds: string[]): FlagEvidence[] {
    if (this.sandboxTmp === null) return [];
    return this.sandboxTmp.observe(live(), clearedBeeIds);
  }

  private effectiveSandboxCap(): SandboxTmpfsCap {
    this.sandboxCap ??= sandboxTmpfsCap(
      this.cfg.sandboxTmpfsBytes === undefined ? DEFAULT_SANDBOX_TMPFS_BYTES : this.cfg.sandboxTmpfsBytes,
      platform(),
    );
    return this.sandboxCap;
  }

  dispose(): void {
    this.cancelPending();
  }

  // -------------------------------------------------------------------------
  // Cell surface (the daemon/UI-facing half; WP6 wires the UI)
  // -------------------------------------------------------------------------

  /** Provision (or replay) the bee's cell, keyed by an explicit operation id. */
  ensureCell(beeId: string, opId: string): ProvisionedCell {
    const cached = this.cells.get(beeId);
    if (cached) return cached;
    const spec = this.cfg.resolveCell(beeId);
    const cell = provisionCell(this.cfg.cellsRoot, spec.provision, opId, {
      disableCow: this.cfg.disableCow ?? false,
      useGitImages: this.cfg.nodeKind === "workstation",
      gitImagesRoot: this.cfg.gitImagesRoot,
    });
    if (cell.wipRestore) this.logWipRestore(beeId, cell.wipRestore);
    this.cells.set(beeId, cell);
    return cell;
  }

  private logWipRestore(beeId: string, outcome: { restored: boolean; reason: string | null; branches?: string[] }): void {
    const branches = (outcome.branches?.length ?? 0) > 0 ? ` branches=${JSON.stringify(outcome.branches)}` : "";
    if (outcome.restored) this.cfg.log?.(`cell.wip.restored bee=${beeId}${branches}`);
    else if (outcome.reason !== "nothing_to_restore" || branches) this.cfg.log?.(`cell.wip.restore_skipped bee=${beeId} reason=${outcome.reason ?? "-"}${branches}`);
  }

  /**
   * The provisioned cell for a bee, if any. After a daemon restart the
   * in-memory cache is empty; the cell is re-hydrated from its on-disk
   * ledger (cell.json is the durable allocation truth).
   */
  cellOf(beeId: string): ProvisionedCell | null {
    const cached = this.cells.get(beeId);
    if (cached) return cached;
    let spec: CellSpec;
    try {
      spec = this.cfg.resolveCell(beeId);
    } catch {
      return null;
    }
    const p = spec.provision;
    const paths = cellPaths(this.cfg.cellsRoot, p.wrapper, p.repoName, p.cellId);
    const ledger = (() => {
      try {
        return readLedger(paths.ledgerPath);
      } catch {
        return null;
      }
    })();
    if (ledger == null || !isProvisioned(ledger) || ledger.beeId !== beeId) return null;
    const done = Object.values(ledger.operations).find((op) => op.completedAt != null);
    const cell: ProvisionedCell = {
      paths,
      copyMode: ledger.copy_mode ?? "clone",
      warm: done?.steps.warm ?? { mode: "cold", dirs: [], reason: "none_listed" },
      sha: ledger.sha,
      originRepo: ledger.origin,
      replayed: true,
    };
    this.cells.set(beeId, cell);
    return cell;
  }

  /** The native exit path (spec 05 point 4). */
  capture(beeId: string, opts: { targetBranch: string; mode: CaptureMode; opId: string }): CaptureReport {
    const cell = this.cellOf(beeId);
    if (!cell) throw new Error(`capture: bee ${beeId} has no provisioned cell`);
    return captureWork({
      originRepo: cell.originRepo,
      cellSpaceDir: cell.paths.spaceDir,
      targetBranch: opts.targetBranch,
      mode: opts.mode,
      opId: opts.opId,
    });
  }

  /**
   * Delete the bee's cell (A2 dirty guard applies). Archive is deliberately
   * NOT here: archiving keeps the cell (spec 05 point 7); retention reaping
   * is daemon policy. A cell that was only reserved (seed ledger, never
   * provisioned) has nothing to lose and is removed outright; a
   * half-provisioned one goes through the shape-checked dirty guard like
   * any other. Throws CellRuntimeLiveError while a runtime is live.
   */
  /** v31 — retention parked the bee's Cell: drop the cached allocation so `cellOf` re-reads disk. */
  forgetCell(beeId: string): void {
    this.cells.delete(beeId);
  }

  removeCell(beeId: string, opts: DirtyReportOptions & { force?: boolean } = {}): DeleteResult {
    if (this.pending.has(beeId) || this.cfg.runtimeLive(beeId)) {
      throw new CellRuntimeLiveError(beeId);
    }
    const cell = this.cellOf(beeId);
    if (cell) {
      const result = deleteCell(cell.paths.wrapperDir, opts);
      this.cells.delete(beeId);
      return result;
    }
    const reserved = this.reservedOf(beeId);
    if (reserved == null || !existsSync(reserved.paths.wrapperDir)) {
      return { deleted: false, forced: false, report: null };
    }
    const entries = readdirSync(reserved.paths.wrapperDir);
    if (looksLikeCellWrapper(reserved.paths.wrapperDir, entries)) {
      // A space checkout exists (provisioning was interrupted): the A2
      // guard decides, on shape-checked paths only.
      return deleteCell(reserved.paths.wrapperDir, opts);
    }
    // Seed ledger + box only — no checkout was ever materialized.
    rmSync(reserved.paths.wrapperDir, { recursive: true, force: true });
    return { deleted: true, forced: false, report: null };
  }

  /** The reserved (seed) ledger + paths for a bee, provisioned or not; null when unresolvable. */
  private reservedOf(beeId: string): { paths: CellPaths; ledger: CellLedger } | null {
    let spec: CellSpec;
    try {
      spec = this.cfg.resolveCell(beeId);
    } catch {
      return null;
    }
    const p = spec.provision;
    const paths = cellPaths(this.cfg.cellsRoot, p.wrapper, p.repoName, p.cellId);
    let ledger: CellLedger | null;
    try {
      ledger = readLedger(paths.ledgerPath);
    } catch {
      return null;
    }
    if (ledger == null || ledger.beeId !== beeId) return null;
    return { paths, ledger };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private finishProvision(pending: PendingProvision): void {
    if (pending.settled || this.pending.get(pending.beeId) !== pending) return;
    pending.settled = true;
    this.pending.delete(pending.beeId);
    try {
      this.ensureCell(pending.beeId, `start-${pending.beeId}-g${pending.generation}`);
      this.cfg.onCellMaterialized?.(pending.beeId);
    } catch (error) {
      pending.done(error instanceof Error ? error.message : String(error));
      return;
    }
    pending.done();
  }

  private failProvision(pending: PendingProvision, detail: string): void {
    if (pending.settled || this.pending.get(pending.beeId) !== pending) return;
    pending.settled = true;
    this.pending.delete(pending.beeId);
    pending.done(detail);
  }

  private cancelPending(): void {
    for (const pending of this.pending.values()) {
      pending.settled = true;
      void pending.worker.terminate();
    }
    this.pending.clear();
    for (const worker of this.maintenanceWorkers) void worker.terminate();
    this.maintenanceWorkers.clear();
    this.maintenanceByRuntime.clear();
    for (const worker of this.poolWorkers.values()) void worker.terminate();
    this.poolWorkers.clear();
    if (this.upstreamTimer != null) clearInterval(this.upstreamTimer);
    this.upstreamTimer = null;
  }

  // -------------------------------------------------------------------------
  // Warm pool (2026-09-21 spawn-floor work) — see warmPool.ts
  // -------------------------------------------------------------------------

  private warmPoolEnabled(): boolean {
    return (this.cfg.warmPool?.targetFree ?? 0) > 0;
  }

  /** Claim a pool member into the bee's reserved cell; null = cold provision. */
  private tryClaimFromPool(beeId: string): ProvisionedCell | null {
    let spec: CellSpec;
    try {
      spec = this.cfg.resolveCell(beeId);
    } catch {
      return null;
    }
    try {
      const claimed = claimFromPool(this.cfg.cellsRoot, spec.provision);
      if (!claimed) return null;
      const cell = restoreWipAfterProvision(claimed, spec.provision);
      if (cell.wipRestore) this.logWipRestore(beeId, cell.wipRestore);
      return cell;
    } catch {
      // A pool claim is best-effort: any failure falls back to cold provision.
      return null;
    }
  }

  trackOrigins(origins: readonly { originRepo: string; repoName: string; usedAt: number }[]): void {
    for (const origin of origins) this.trackOrigin({ originRepo: origin.originRepo, repoName: origin.repoName }, origin.usedAt);
    this.refreshRecentOrigins();
  }

  private trackOrigin(request: RefreshRequest, usedAt: number): TrackedOrigin {
    const known = this.origins.get(request.originRepo);
    if (known != null) {
      known.lastUsedAt = Math.max(known.lastUsedAt, usedAt);
      if (request.warmArtifacts != null) known.request = request;
      return known;
    }
    const tracked: TrackedOrigin = { request, lastUsedAt: usedAt, lastFetchAt: 0 };
    this.origins.set(request.originRepo, tracked);
    this.ensureUpstreamTimer();
    return tracked;
  }

  private ensureUpstreamTimer(): void {
    if (this.upstreamPolicy == null || this.upstreamTimer != null) return;
    this.upstreamTimer = setInterval(() => this.refreshRecentOrigins(), this.upstreamPolicy.intervalMs);
    this.upstreamTimer.unref();
  }

  private refreshRecentOrigins(): void {
    if (this.upstreamPolicy == null) return;
    const now = Date.now();
    for (const [originRepo, origin] of this.origins) {
      if (now - origin.lastUsedAt > this.upstreamPolicy.recentMs) {
        this.origins.delete(originRepo);
        continue;
      }
      this.scheduleRefresh(origin);
    }
  }

  private refreshOriginOf(beeId: string): void {
    if (this.upstreamPolicy == null && !this.warmPoolEnabled()) return;
    let spec: CellSpec;
    try {
      spec = this.cfg.resolveCell(beeId);
    } catch {
      return;
    }
    const p = spec.provision;
    const origin = this.trackOrigin({
      originRepo: p.originRepo,
      repoName: p.repoName,
      ...(p.warmArtifacts && p.warmArtifacts.length > 0 ? { warmArtifacts: [...p.warmArtifacts] } : {}),
    }, Date.now());
    this.scheduleRefresh(origin);
  }

  /**
   * Fetch the origin's upstream (when due) and refill its pool at the
   * resulting Cell base, in a worker off the event loop. Single-flight per
   * repoKey: a burst of spawns for one repo shares one in-flight worker.
   */
  private scheduleRefresh(origin: TrackedOrigin): void {
    const now = Date.now();
    const policy = this.upstreamPolicy;
    const fetchDue = policy != null && now - origin.lastFetchAt >= policy.maxAgeMs;
    const target = this.warmPoolEnabled() ? this.cfg.warmPool?.targetFree ?? 0 : 0;
    if (!fetchDue && target === 0) return;
    const request = origin.request;
    let repoKey: string;
    try {
      repoKey = repoKeyFor(request.originRepo, request.repoName);
    } catch {
      return;
    }
    if (this.poolWorkers.has(repoKey)) return;
    const workerUrl = this.cfg.poolWorkerUrl ?? (import.meta.url.endsWith(".ts")
      ? new URL("./poolWorker.ts", import.meta.url)
      : new URL("./pool-worker.js", import.meta.url));
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        execArgv: [],
        workerData: {
          cellsRoot: this.cfg.cellsRoot,
          request,
          target,
          maxSize: this.cfg.warmPool?.maxSize ?? 32,
          provisionOpts: {
            disableCow: this.cfg.disableCow ?? false,
            useGitImages: this.cfg.nodeKind === "workstation",
            ...(this.cfg.gitImagesRoot ? { gitImagesRoot: this.cfg.gitImagesRoot } : {}),
          },
          ...(fetchDue && policy != null ? { upstream: { root: policy.root, maxAgeMs: policy.maxAgeMs, timeoutMs: policy.timeoutMs } } : {}),
        },
      });
    } catch {
      return; // never let a refresh failure affect the spawn
    }
    if (fetchDue) origin.lastFetchAt = now;
    this.poolWorkers.set(repoKey, worker);
    const clear = (): void => { if (this.poolWorkers.get(repoKey) === worker) this.poolWorkers.delete(repoKey); };
    worker.once("message", (result: PoolWorkerResult) => {
      clear();
      if (result.sync != null) this.cfg.onUpstreamRefreshed?.(request.originRepo, result);
    });
    worker.once("error", clear);
    worker.once("exit", clear);
    worker.unref();
  }

  spawnSpec(beeId: string, harness: SpawnSpec, generation?: number): SpawnSpec {
    const cell = this.cellOf(beeId);
    if (!cell) throw new Error(`cell service: bee ${beeId} has no provisioned cell (prepare provisions first)`);
    const spec = this.cfg.resolveCell(beeId);
    const env: Record<string, string> = {
      ...(harness.env ?? (process.env as Record<string, string>)),
      HIVE_CELL: "1",
      HIVE_CELL_SPACE: cell.paths.spaceName,
      npm_config_yes: "false",
    };
    if (!sandboxEnabled(this.cfg.nodeKind, spec.sandbox)) {
      return { ...harness, cwd: cell.paths.spaceDir, env };
    }
    const cap = this.effectiveSandboxCap();
    if (generation !== undefined) this.cfg.log?.(describeSandboxTmpfs(beeId, generation, cap));
    if (cap.kind === "capped" && platform() === "linux") {
      this.sandboxTmp ??= new SandboxTmpWatch({
        intervalMs: this.cfg.sandboxTmpSampleMs ?? 5_000,
        ...(this.cfg.log ? { log: this.cfg.log } : {}),
      });
      this.sandboxTmp.track(beeId, generation ?? null);
    }
    const wrapped = wrapWithSandbox(
      {
        cellDir: cell.paths.wrapperDir,
        kvm: this.cfg.sandboxKvm,
        writablePaths: mergeSandboxWritablePaths(
          this.cfg.sandboxWritablePaths ?? defaultWritablePaths(),
          this.cfg.resolveSandboxWritablePaths?.(beeId) ?? [],
        ),
        tmpfsBytes: cap.kind === "capped" ? cap.bytes : null,
      },
      harness.command,
      harness.args,
      cell.paths.sandboxProfilePath,
    );
    if (wrapped.profile != null) writeFileSync(cell.paths.sandboxProfilePath, wrapped.profile);
    return {
      adapter: harness.adapter,
      command: wrapped.command,
      args: wrapped.args,
      cwd: cell.paths.spaceDir,
      env,
    };
  }
}
