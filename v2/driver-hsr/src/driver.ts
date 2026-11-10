import { quotaSourceId } from "../../adapters/src/quota.ts";
import type { QuotaBoundary } from "../../core/src/quota.ts";
import type {RuntimeIdentityHooks} from "../../core/src/runtimeProcessIdentity.ts";
import { DELIVERY_CONFIRMATION_MAX_WIRE_BYTES } from "../../core/src/deliveryConfirmationTypes.ts";
import {authenticatedProcessPeer} from "../../harness/src/processIdentity.ts";
import { DELIVERY_FRAME_MAX_BYTES, DELIVERY_STATUS_CAPABILITY, type DeliveryStatus, type TaggedDelivery } from "./delivery-receipts.ts";
import { ExecutionFenceError } from "../../core/src/executionFence.ts";
import type { ExecutionStart, ExecutionRuntimeHooks, ExecutionProcess } from "../../core/src/executionStart.ts";
import { exactProcessBirth } from "../../harness/src/processIdentity.ts";
import { stateDirectory, stateFile } from "../../harness/src/statePath.ts";
import { canonicalDigest, type JsonValue } from "../../core/src/canonical.ts";
import { TurnQuiet } from "./turn-quiet.ts";
import { childNodePath, nativeNodeEnv } from "../../core/src/nodeRuntime.ts";
import type { ReconnectToolsReceipt } from "../../core/src/reconnectTools.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunnerStatus, type RunnerHostConfig } from "./runner-host.ts";
import {legacyRunnerCommandProof} from "./legacyRunnerProof.ts";
import type {
  DeliverOutcome,
  DeliveryConfirmationPlan,
  DeliveryConfirmationResult,
  DriverObservation,
  InterruptOutcome,
  LiveProcess,
  RuntimeDriver,
  StopCause,
} from "../../harness/src/driver.ts";
import type { HarnessAdapter } from "../../adapters/src/index.ts";
import type {ReadinessRecovery} from "../../adapters/src/types.ts";
import { executableNotFoundDetail, type SpawnCommandResolution } from "../../core/src/executables.ts";
import { inspectProcess, sameProcess, processDisposition, legacyProcessCandidate, ProcessIdentityUnavailableError, verifyProcessIdentity, type ProcessIdentity } from "./psutil.ts";
import { persistentSocketDir, socketPathFits } from "../../core/src/socketPath.ts";

const PINNED_HOST_MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const PINNED_HOST_MODULE_DIR = dirname(PINNED_HOST_MODULE_PATH);

const SWEEP_PROBE_MS = 1000;
const SWEEP_TAIL_MS = 5000;
const SWEEP_UNWATCHED_MS = 200;

export interface SpawnSpec {
  adapter: HarnessAdapter;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  commandResolution?: SpawnCommandResolution;
}

export interface PreparedStart {
  cancel(): void;
}

export interface RuntimeHostConfig {
  onRuntimeReady?(beeId: string, pid: number | null): void;
  runtimeIdentity?: RuntimeIdentityHooks;
  execution?: ExecutionRuntimeHooks;
  executionStartFor?(beeId: string, generation: number): ExecutionStart | null;
  executionHostFor?(start: ExecutionStart): ExecutionProcess | null;
  resolveExecutionAdapter?(beeId: string): HarnessAdapter;
  resolve(beeId: string, generation?: number): SpawnSpec;
  prepare?(beeId: string, generation: number, execution: ExecutionStart | null, done: (failure?: string) => void): PreparedStart | null;
  onObserved?(event: DriverObservation): void;
  extraEvidence?(live: () => LiveProcess[], clearedBeeIds: string[]): FlagEvidence[];
  sessionLogDir: string;
  sessionLogPathFor?: (beeId: string) => string | null;
  stopKillGraceMs?: number;
  adoptToleranceMs?: number;
  now?: () => number;
  random?: () => number;
  runnersDir?: string;
  socketDir?: string;
  hostCommand?: (configPath: string) => { command: string; args: string[] };
  wake?: () => void;
}

type HostLaunch =
  | { kind: "override"; commandFor: NonNullable<RuntimeHostConfig["hostCommand"]> }
  | { kind: "source"; entry: string }
  | { kind: "artifact"; entry: string };

export interface FlagEvidence {
  beeId: string;
  generation: number;
  flag: "auth_needed" | "resource_blocked" | "spawn_failed";
  action: "set" | "clear";
  detail: string;
  resetsAt?: number;
  turn?: TurnEvidence;
  owner?: "sandbox_tmp";
  quota?: QuotaBoundary;
  eventId?: string;
  sourceId?: string;
}

export interface TurnEvidence {
  messageIds: number[];
  progress: "none" | "some" | "unknown";
}

interface TurnTrack {
  messageIds: number[];
  progressed: boolean;
  observedFromStart: boolean;
}

function freshTurn(): TurnTrack {
  return { messageIds: [], progressed: false, observedFromStart: true };
}

export interface SessionEvidence {
  beeId: string;
  generation: number;
  sessionId: string;
}

export interface UsageEvidence {
  beeId: string;
  generation: number;
  observedAt: number;
  usage?: Record<string, unknown>;
  quota?: Record<string, unknown>;
}

export interface ObservationCursorEvidence {
  beeId: string;
  generation: number;
  cursor: number;
}

interface Runtime {
  deliveryProtocol?: { authenticated: boolean; supported: boolean; legacy: boolean; pending: Set<number>; replies: Map<number, DeliveryStatus> };
  authFailureSince?: number;
  authFailures?: number;
  processIdentity?: ProcessIdentity;
  legacyBirthPending?: boolean;
  pendingStartIdentity?: ProcessIdentity;
  recoveredSessionId?: string;
  readinessRecovery?: {requestId: string; agent?: ProcessIdentity; started: boolean; refused: boolean; nextProbeAt?: number; bootstrapSent?: boolean};
  executionStart?: ExecutionStart;
  executionHost?: ExecutionProcess;
  executionAccepted?: boolean;
  beeId: string;
  generation: number;
  pid: number;
  pidStartedAt: number;
  child: ChildProcess | null;
  adapter: HarnessAdapter | null;
  degraded: boolean;
  phase: "booting" | "running" | "idle";
  sessionId: string | null;
  turnId: string | null;
  turn: TurnTrack;
  quiet: TurnQuiet | null;
  pendingDeliveries: Set<number>;
  confirmedDeliveries: Set<number>;
  reconnectReplies: Map<string, string | null>;
  stopCause: StopCause | null;
  killTimer: NodeJS.Timeout | null;
  stdoutRest: Buffer;
  exited: boolean;
  agentPid: number | null;
  socket: Socket | null;
  socketRetry: NodeJS.Timeout | null;
  socketPath: string | null;
  statusPath: string | null;
  observationPath: string | null;
  logOffset: number;
  initialObservationCursor: number;
  pendingObservationCursor: number | null;
  pendingWrites: string[];
  socketBroken: boolean;
  spawnError: string | null;
  commandResolution: SpawnCommandResolution | null;
  realEvidence: boolean;
}

interface PendingStart {
  generation: number;
  execution?: ExecutionStart | null;
  cancel?: () => void;
}

interface RecoveredAdapterContext {
  phase?: "running" | "idle";
  sessionId: string | null;
  turnId: string | null;
  confirmedDeliveries: Set<number>;
  reconnectReplies: Map<string, string | null>;
  quiet: TurnQuiet;
}

function recoverAdapterContext(
  adapter: HarnessAdapter,
  path: string,
  endOffset: number,
  providerSessionId: string | null,
): RecoveredAdapterContext {
  const quiet = new TurnQuiet(adapter.harness);
  let sessionId = providerSessionId;
  let turnId: string | null = null;
  let phase: "running" | "idle" | undefined;
  const confirmedDeliveries = new Set<number>();
  const reconnectReplies = new Map<string, string | null>();
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    let offset = 0;
    let rest = Buffer.alloc(0);
    while (offset < endOffset) {
      const wanted = Math.min(256 * 1024, endOffset - offset);
      const chunk = Buffer.alloc(wanted);
      const bytesRead = readSync(fd, chunk, 0, wanted, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
      const data = rest.length === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([rest, chunk.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        let raw = data.subarray(lineStart, newline);
        if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
        lineStart = newline + 1;
        if (raw.length === 0) continue;
        quiet.pushLine(raw.toString("utf8"), sessionId);
        for (const signal of adapter.parseLine(raw.toString("utf8"))) {
          if (signal.kind === "booted") {
            phase = "running";
            if (signal.sessionId && sessionId == null) sessionId = signal.sessionId;
            continue;
          }
          if (signal.kind === "tools_control_result") { reconnectReplies.set(signal.requestId, signal.error ?? null); continue; }
          if (signal.kind === "delivery_confirmed") {
            confirmedDeliveries.add(signal.messageId);
            continue;
          }
          if (signal.kind === "delivery_refused") {
            confirmedDeliveries.delete(signal.messageId);
            continue;
          }
          if (signal.kind !== "turn_started" && signal.kind !== "turn_ended") continue;
          if (signal.threadId && sessionId && signal.threadId !== sessionId) continue;
          if (signal.kind === "turn_started") { turnId = signal.turnId ?? null; phase = "running"; }
          else { turnId = null; quiet.end(); phase = "idle"; }
        }
      }
      rest = Buffer.from(data.subarray(lineStart));
    }
  } catch {
  } finally {
    if (fd != null) closeSync(fd);
  }
  return { sessionId, turnId, confirmedDeliveries, reconnectReplies, quiet, phase };
}

export class ReconnectToolsControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class RuntimeHost implements RuntimeDriver {
  private readonly reconnecting = new Set<string>();
  private detached = false;
  private readonly cfg: RuntimeHostConfig;
  private fallbackSocketDir: string | null = null;
  private readonly hostLaunch: HostLaunch;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly adoptTolMs: number;
  private readonly procs = new Map<string, Runtime>();
  private readonly pendingStarts = new Map<string, PendingStart>();
  private events: DriverObservation[] = [];
  private evidence: FlagEvidence[] = [];
  private sessions: SessionEvidence[] = [];
  private usage: UsageEvidence[] = [];
  private readonly consumed = new Map<number, number>();
  private readonly pointerAttempts = new Map<number, { beeId: string; generation: number; digest: string; refused?: boolean }>();
  private watcher: FSWatcher | null = null;
  private watchFailed = false;
  private readonly dirty = new Map<Runtime, boolean>();
  private drainScheduled = false;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(cfg: RuntimeHostConfig) {
    this.cfg = cfg;
    stateDirectory(cfg.sessionLogDir, "sessionLogDir");
    this.runnersDir();
    this.socketDir();
    this.hostLaunch = this.selectHostLaunch();
    this.now = cfg.now ?? Date.now;
    this.graceMs = cfg.stopKillGraceMs ?? 5000;
    this.adoptTolMs = cfg.adoptToleranceMs ?? 5000;
    mkdirSync(cfg.sessionLogDir, { recursive: true });
    mkdirSync(this.runnersDir(), { recursive: true });
    this.openWatcher();
  }

  private runnersDir(): string {
    if (this.cfg.runnersDir !== undefined) return stateDirectory(this.cfg.runnersDir, "runnersDir");
    const parent = stateDirectory(dirname(stateDirectory(this.cfg.sessionLogDir, "sessionLogDir")), "default runners parent");
    return resolvePath(parent, "runners");
  }

  private selectHostLaunch(): HostLaunch {
    const override = this.cfg.hostCommand;
    if (override) return { kind: "override", commandFor: override };
    const source = extname(PINNED_HOST_MODULE_PATH) === ".ts";
    const entry = join(PINNED_HOST_MODULE_DIR, source ? "runner-host-main.ts" : "runner-host.js");
    try {
      if (!statSync(entry).isFile()) throw new Error("not a regular file");
    } catch (cause) {
      if (source) {
        throw new Error(
          `runtime host: required runner-host source entry is unavailable at ${entry}; restore the source checkout or provide hostCommand`,
          { cause },
        );
      }
      throw new Error(
        `runtime host: required bundled runner-host artifact is unavailable at ${entry}; rebuild or reinstall Honeybee so runner-host.js is shipped beside the v2 bundle`,
        { cause },
      );
    }
    return source ? { kind: "source", entry } : { kind: "artifact", entry };
  }

  private socketDir(): string {
    if (this.cfg.socketDir !== undefined) return stateDirectory(this.cfg.socketDir, "socketDir");
    if (!this.fallbackSocketDir) {
      const sample = join(`hb-rh-${"0".repeat(16)}`, "stdin.sock");
      if (socketPathFits(join(tmpdir(), sample))) this.fallbackSocketDir = tmpdir();
      else {
        mkdirSync(this.runnersDir(), { recursive: true });
        this.fallbackSocketDir = persistentSocketDir(this.runnersDir(), sample);
      }
    }
    return stateDirectory(this.fallbackSocketDir, "socketDir");
  }

  private runnerPaths(
    beeId: string,
    generation: number,
  ): { config: string; socket: string; status: string; observations: string } {
    const base = join(this.runnersDir(), `${beeId}.${generation}`);
    const digest = createHash("sha256")
      .update(`${this.runnersDir()}\u0000${beeId}\u0000${generation}`)
      .digest("hex")
      .slice(0, 16);
    return {
      config: `${base}.json`,
      socket: existsSync(join(this.socketDir(), `hb-rh-${digest}.sock`))
        ? join(this.socketDir(), `hb-rh-${digest}.sock`)
        : join(this.socketDir(), `hb-rh-${digest}`, "stdin.sock"),
      status: `${base}.status.json`,
      observations: `${base}.observations.jsonl`,
    };
  }

  private hostCommandFor(configPath: string): { command: string; args: string[] } {
    if (this.hostLaunch.kind === "override") return this.hostLaunch.commandFor(configPath);
    if (this.hostLaunch.kind === "source") {
      return {
        command: childNodePath(),
        args: ["--experimental-strip-types", this.hostLaunch.entry, configPath],
      };
    }
    return { command: childNodePath(), args: [this.hostLaunch.entry, configPath] };
  }

  // -------------------------------------------------------------------------
  // Observation sources: runner-dir watch, child exit, host socket, one sweep
  // -------------------------------------------------------------------------

  private openWatcher(): void {
    try {
      const watcher = watch(this.runnersDir(), { persistent: false }, (_type, filename) => this.onRunnerFileChange(filename));
      watcher.on("error", () => {
        try { watcher.close(); } catch {}
        if (this.watcher === watcher) this.watcher = null;
        this.watchFailed = true;
        this.armSweep();
      });
      this.watcher = watcher;
    } catch {
      this.watchFailed = true;
    }
  }

  private onRunnerFileChange(filename: string | Buffer | null): void {
    if (this.detached || filename == null) return;
    const name = String(filename);
    const status = name.endsWith(".status.json");
    const journal = !status && name.endsWith(".observations.jsonl");
    if (!status && !journal) return;
    const base = name.slice(0, name.length - (status ? ".status.json".length : ".observations.jsonl".length));
    const dot = base.lastIndexOf(".");
    if (dot <= 0) return;
    const p = this.procs.get(base.slice(0, dot));
    if (!p || p.generation !== Number(base.slice(dot + 1)) || p.exited) return;
    this.markDirty(p, status);
  }

  private markDirty(p: Runtime, status: boolean): void {
    if (this.detached) return;
    this.dirty.set(p, status || (this.dirty.get(p) ?? false));
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    setImmediate(() => this.drainDirty());
  }

  private drainDirty(): void {
    this.drainScheduled = false;
    const entries = [...this.dirty.entries()];
    this.dirty.clear();
    for (const [p, status] of entries) {
      if (p.exited || this.procs.get(p.beeId) !== p) continue;
      if (status) this.pumpStatus(p);
      if (!p.exited) this.pumpHostTail(p);
    }
    this.notify();
  }

  private notify(): void {
    if (this.detached) return;
    if (this.events.length > 0 || this.evidence.length > 0 || this.sessions.length > 0 || this.usage.length > 0) this.cfg.wake?.();
  }

  private sweepDelay(): number | null {
    let delay: number | null = null;
    for (const p of this.procs.values()) {
      if (p.exited) continue;
      const probe = p.pendingStartIdentity !== undefined || p.degraded || p.readinessRecovery?.nextProbeAt !== undefined || (p.child == null && !p.socket);
      const wanted = this.watchFailed ? SWEEP_UNWATCHED_MS : probe ? SWEEP_PROBE_MS : SWEEP_TAIL_MS;
      delay = delay == null ? wanted : Math.min(delay, wanted);
    }
    return delay;
  }

  private armSweep(): void {
    if (this.detached || this.sweepTimer) return;
    const delay = this.sweepDelay();
    if (delay == null) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.sweep();
      this.armSweep();
    }, delay);
    this.sweepTimer.unref();
  }

  private sweep(): void {
    for (const p of [...this.procs.values()]) {
      if (p.exited) continue;
      if (p.pendingStartIdentity) { this.probe(p); continue; }
      if (p.degraded || (p.child == null && !p.socket)) this.probe(p);
      if (p.exited) continue;
      if (p.readinessRecovery?.nextProbeAt !== undefined && this.now() >= p.readinessRecovery.nextProbeAt) {
        p.readinessRecovery.nextProbeAt = undefined;
        p.readinessRecovery.started = false;
        this.recoverAdoptedReadiness(p);
      }
      if (p.agentPid == null || (!p.socket && !p.socketBroken)) this.pumpStatus(p);
      if (!p.exited) this.pumpHostTail(p);
    }
    this.notify();
  }

  private probe(p: Runtime): void {
    if (p.exited) return;
    if (p.pendingStartIdentity) {
      const value = inspectProcess(p.pid);
      if (value.kind === "gone" || value.kind === "present" && (value.state === "zombie" || !sameProcess(p.pendingStartIdentity, value))) {
        this.releasePendingStart(p, value.kind === "gone" ? "gone" : value.state === "zombie" ? "zombie" : "birth-changed");
      }
      return;
    }
    this.captureProcessIdentity(p);
    const disposition = processDisposition(p.processIdentity ?? null, inspectProcess(p.pid));
    if (disposition === "unavailable") this.cfg.runtimeIdentity?.unavailable?.(p.beeId, p.generation);
    if (disposition === "exited") this.finishHost(p);
  }

  // -------------------------------------------------------------------------
  // RuntimeDriver
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number, execution?: ExecutionStart | null): void {
    const start = execution ?? this.cfg.executionStartFor?.(beeId,generation) ?? null;
    if (start && (start.beeId !== beeId || start.runtimeGeneration !== generation)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Start intent does not bind the requested bee and runtime generation");
    if (start && !this.cfg.execution) throw new ExecutionFenceError("rpc_execution_fence_unsupported", "Fenced start requires owner hooks");
    if (start) this.cfg.execution!.check(start,"hsr_start");
    if (this.detached) return;
    const pending = this.pendingStarts.get(beeId);
    if (pending?.cancel) throw new Error(`runtime host: bee ${beeId} already has a start in preparation (generation ${pending.generation})`);
    const existing = this.procs.get(beeId);
    if (existing && existing.stopCause == null && !pending) {
      throw new Error(
        `runtime host: bee ${beeId} already has a live process (generation ${existing.generation}, pid ${existing.pid})`,
      );
    }
    const prepared = this.cfg.prepare?.(beeId, generation, start, failure => this.prepared(beeId, generation, failure)) ?? null;
    if (prepared) {
      this.pendingStarts.set(beeId, { generation, execution: start, cancel: prepared.cancel });
      return;
    }
    this.launch(beeId, generation, start);
  }

  private prepared(beeId: string, generation: number, failure?: string): void {
    const pending = this.pendingStarts.get(beeId);
    if (!pending || pending.generation !== generation || !pending.cancel) return;
    this.pendingStarts.delete(beeId);
    if (failure !== undefined) {
      this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed", detail: `cell provisioning failed: ${failure}` });
    } else {
      try {
        this.launch(beeId, generation, pending.execution ?? null);
      } catch (error) {
        this.events.push({ beeId, generation, kind: "exited", exitCause: "crashed", detail: error instanceof Error ? error.message : String(error) });
      }
    }
    this.notify();
  }

  private launch(beeId: string, generation: number, start: ExecutionStart | null): void {
    if (this.detached) return;
    const existing = this.procs.get(beeId);
    if (existing) {
      if (existing.stopCause != null || this.pendingStarts.has(beeId)) {
        this.pendingStarts.set(beeId, { generation, execution: start });
        return;
      }
      throw new Error(
        `runtime host: bee ${beeId} already has a live process (generation ${existing.generation}, pid ${existing.pid})`,
      );
    }
    if (start) this.cfg.execution!.check(start,"spawn_spec");
    const spec = this.cfg.resolve(beeId, generation);
    if (process.env.HIVE_SPAWN_TRACE) {
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, envKeys: Object.keys(spec.env ?? {}).length, at: Date.now() }) + "\n");
    }
    const paths = this.runnerPaths(beeId, generation);
    const ownerBirth = start ? exactProcessBirth(process.pid) : null;
    if (start && !ownerBirth) throw new ExecutionFenceError("rpc_execution_history_unknown", "Owner process birth is unavailable");
    if (start) this.cfg.execution!.check(start,"host_config");
    const hostConfig: RunnerHostConfig = {
      ...(start ? { executionStart: start, executionOwner: { pid: process.pid, birth: ownerBirth! } } : {}),
      beeId,
      generation,
      command: spec.command,
      args: spec.args,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      env: spec.env ?? nativeNodeEnv(),
      sessionLogPath: this.sessionLogPath(beeId),
      observationLogPath: paths.observations,
      sidecarPath: join(this.cfg.sessionLogDir, `${beeId}.stderr.log`),
      socketPath: paths.socket,
      statusPath: paths.status,
      bootLines: spec.adapter.bootLines(),
    };
    writeFileSync(paths.config, JSON.stringify(hostConfig));
    const launch = this.hostCommandFor(paths.config);
    if (start) this.cfg.execution!.dispatch(start);
    const child = spawn(launch.command, launch.args, {
      env: nativeNodeEnv(),
      detached: true,
      stdio: start ? ["ignore", "ignore", "ignore", "ipc"] : ["ignore", "ignore", "ignore"],
    });
    const hostBirth = start && child.pid ? exactProcessBirth(child.pid) : null;
    const proc: Runtime = {
      ...(start ? { executionStart: start, ...(hostBirth && child.pid ? { executionHost: { pid: child.pid, birth: hostBirth } } : {}) } : {}),
      beeId,
      generation,
      pid: child.pid ?? -1,
      pidStartedAt: this.now(),
      child,
      adapter: spec.adapter,
      quiet: new TurnQuiet(spec.adapter.harness),
      degraded: false,
      phase: "booting",
      sessionId: null,
      turnId: null,
      turn: freshTurn(),
      pendingDeliveries: new Set(),
      confirmedDeliveries: new Set(),
      reconnectReplies: new Map(),
      stopCause: null,
      killTimer: null,
      stdoutRest: Buffer.alloc(0),
      exited: false,
      spawnError: null,
      commandResolution: spec.commandResolution ?? null,
      realEvidence: false,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: paths.socket,
      statusPath: paths.status,
      observationPath: paths.observations,
      logOffset: 0,
      initialObservationCursor: 0,
      pendingObservationCursor: null,
      pendingWrites: [],
      socketBroken: false,
    };
    this.procs.set(beeId, proc);
    if (start) child.on("message", (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const frame = value as Record<string, unknown>, host = frame.host as ExecutionProcess | undefined;
      const digest = canonicalDigest(start as unknown as JsonValue);
      if (frame.intentId !== start.intentId || frame.bindingDigest !== digest || !host || !proc.executionHost || host.pid !== proc.pid || host.birth !== proc.executionHost.birth || exactProcessBirth(proc.pid) !== host.birth) return;
      try {
        if (frame.op === "execution_ready") {
          this.cfg.execution!.bindAndRelease(start,host);
          child.send({ op: "execution_release", intentId: start.intentId, bindingDigest: digest, host }, () => {});
        } else if (frame.op === "execution_started") this.acceptExecutionStarted(proc, frame.agent as ExecutionProcess);
      } catch { this.appendSidecar(beeId,"execution handshake held; owner reconciliation required\n"); }
    });
    child.on("error", (err) => {
      proc.spawnError = String(err?.message ?? err);
      this.appendSidecar(beeId, `runner host spawn error: ${proc.spawnError}\n`);
      this.finishHost(proc);
      this.notify();
    });
    child.on("exit", () => { this.finishHost(proc); this.notify(); });

    this.connectSocket(proc);

    if (!start && spec.adapter.readyAtSpawn) proc.phase = "idle";
    this.markDirty(proc, true);
    this.armSweep();
  }

  private sessionLogSize(beeId: string): number {
    try {
      return statSync(this.sessionLogPath(beeId)).size;
    } catch {
      return 0;
    }
  }

  private acceptExecutionStarted(p: Runtime, agent: ExecutionProcess): void {
    if (!p.executionStart || !p.executionHost || p.executionAccepted) return;
    if (!agent || exactProcessBirth(p.executionHost.pid) !== p.executionHost.birth || exactProcessBirth(agent.pid) !== agent.birth) throw new ExecutionFenceError("rpc_execution_history_unknown", "Agent-start identity is unavailable");
    this.cfg.execution!.started(p.executionStart,p.executionHost,agent);
    p.executionAccepted = true;
    if (p.adapter?.readyAtSpawn) p.phase = "idle";
  }

  private connectSocket(p: Runtime): void {
    if (this.detached || p.exited || p.socket || p.socketRetry || !p.socketPath) return;
    const attempt = connect(p.socketPath);
    attempt.setTimeout(2000, () => attempt.destroy());
    attempt.on("connect", () => {
      attempt.setTimeout(0);
      if (this.detached || p.exited) { attempt.destroy(); return; }
      this.captureProcessIdentity(p);
      if (p.pendingStartIdentity) {
        const status = p.statusPath ? readRunnerStatus(p.statusPath) : null;
        const value = legacyProcessCandidate(p.pid, p.pidStartedAt);
        const identity = p.pendingStartIdentity;
        const fd = (attempt as unknown as {_handle?: {fd?: number}})._handle?.fd;
        if (!value || !sameProcess(identity, value) || !status || status.beeId !== p.beeId || status.generation !== p.generation || status.hostPid !== p.pid || status.exited || fd === undefined || !authenticatedProcessPeer(fd, identity)) {
          this.rejectHostPeer(p, attempt); return;
        }
        try {
          if (p.executionStart) {
            if (status.hostBirth !== p.executionHost?.birth || status.executionIntentId !== p.executionStart.intentId || status.executionDigest !== canonicalDigest(p.executionStart as unknown as JsonValue)) throw new Error("Runner execution identity changed");
          }
          if (!this.cfg.runtimeIdentity?.bindPendingStart?.(p.beeId, p.generation, p.pidStartedAt, identity)) {
            this.rejectHostPeer(p, attempt); return;
          }
        } catch { this.rejectHostPeer(p, attempt); return; }
        p.processIdentity = identity;
        p.pendingStartIdentity = undefined;
      }
      if (p.legacyBirthPending) {
        const status = p.statusPath ? readRunnerStatus(p.statusPath) : null;
        const value = legacyProcessCandidate(p.pid, p.pidStartedAt);
        const fd = (attempt as unknown as {_handle?: {fd?: number}})._handle?.fd;
        const identity = value ? {pid: value.pid, birth: value.birth, bootId: value.bootId} : null;
        const generationProof = status
          ? status.beeId === p.beeId && status.generation === p.generation && status.hostPid === p.pid && !status.exited
          : identity && p.statusPath && legacyRunnerCommandProof(identity, p.pidStartedAt, this.runnerPaths(p.beeId, p.generation).config, p.statusPath);
        if (!identity || !generationProof || fd === undefined || !authenticatedProcessPeer(fd, identity) || !this.cfg.runtimeIdentity?.bindLegacy(p.beeId, p.generation, p.pidStartedAt, identity, "authenticated-host-generation")) {
          this.rejectHostPeer(p, attempt); return;
        }
        p.processIdentity = identity;
        p.legacyBirthPending = false;
      }
      if (!p.processIdentity || !verifyProcessIdentity(p.pid, p.processIdentity)) { this.rejectHostPeer(p, attempt); return; }
      const fd = (attempt as unknown as { _handle?: { fd?: number } })._handle?.fd;
      const authenticated = fd !== undefined && authenticatedProcessPeer(fd, p.processIdentity);
      if ((p.socketBroken || p.adapter?.confirmsDelivery) && !authenticated) { this.rejectHostPeer(p, attempt); return; }
      const status = p.statusPath ? readRunnerStatus(p.statusPath) : null;
      if (p.executionStart && !p.executionAccepted) {
        try {
          if (!authenticated || !status?.agentPid || !status.agentBirth || status.hostBirth !== p.executionHost?.birth || status.executionIntentId !== p.executionStart.intentId || status.executionDigest !== canonicalDigest(p.executionStart as unknown as JsonValue)) throw new Error("Runner execution identity unavailable");
          this.acceptExecutionStarted(p, {pid: status.agentPid, birth: status.agentBirth});
        } catch { this.rejectHostPeer(p, attempt); return; }
      }
      p.authFailureSince = undefined;
      p.authFailures = 0;
      if (p.socketBroken) {
        p.socketBroken = false;
      }
      p.socket = attempt;
      const supported = status?.beeId === p.beeId && status.generation === p.generation && status.hostPid === p.pid
        && status.capabilities?.includes(DELIVERY_STATUS_CAPABILITY) === true;
      const exactStatus = status?.beeId === p.beeId && status.generation === p.generation && status.hostPid === p.pid;
      p.deliveryProtocol = { authenticated, supported,
        legacy: exactStatus && !supported, pending: new Set(), replies: new Map() };
      for (const line of p.pendingWrites.splice(0)) {
        attempt.write(`${JSON.stringify({ op: "write", line })}\n`);
      }
      this.recoverAdoptedReadiness(p);
      this.markDirty(p, true);
      this.cfg.wake?.();
    });
    attempt.on("error", () => undefined);
    let replyBuffer = "";
    attempt.setEncoding("utf8");
    attempt.on("data", (chunk: string) => {
      if (p.socket !== attempt || !p.deliveryProtocol?.authenticated || !p.deliveryProtocol.supported) return;
      replyBuffer += chunk;
      if (replyBuffer.length > 65_536) { attempt.destroy(); return; }
      const frames = replyBuffer.split("\n");
      replyBuffer = frames.pop() ?? "";
      for (const frame of frames) {
        let value: unknown;
        try { value = JSON.parse(frame); } catch { attempt.destroy(); return; }
        if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "digest,id,state") { attempt.destroy(); return; }
        const receipt = value as DeliveryStatus;
        if (!Number.isSafeInteger(receipt.id) || typeof receipt.digest !== "string" || !/^[a-f0-9]{64}$/.test(receipt.digest)
          || !["not_written", "written", "accepted", "refused", "unknown"].includes(receipt.state)) { attempt.destroy(); return; }
        if (p.deliveryProtocol.pending.delete(receipt.id)) {
          p.deliveryProtocol.replies.set(receipt.id, receipt);
          this.cfg.wake?.();
        }
      }
    });
    attempt.on("close", () => {
      if (p.socket === attempt) {
        p.socket = null; p.deliveryProtocol = undefined;
        if (p.readinessRecovery && !p.readinessRecovery.refused) {
          p.readinessRecovery.started = false;
          p.readinessRecovery.requestId = `hive-readiness-${randomUUID()}`;
        }
      }
      if (this.detached || p.exited) return;
      if (p.child == null) {
        this.probe(p);
        this.notify();
        if (p.exited) return;
      }
      p.socketRetry = setTimeout(() => {
        p.socketRetry = null;
        this.connectSocket(p);
      }, p.authFailures ? Math.min(30_000, 200 * 2 ** Math.min(p.authFailures, 8)) * (0.75 + (this.cfg.random ?? Math.random)() * 0.25) : 200);
      p.socketRetry.unref();
    });
  }

  private rejectHostPeer(p: Runtime, socket: Socket): void {
    p.authFailureSince ??= this.now();
    p.authFailures = Math.min(8, (p.authFailures ?? 0) + 1);
    socket.destroy();
    if (p.pendingStartIdentity && p.authFailures >= 3) this.releasePendingStart(p, "peer-or-binding-rejected");
    this.cfg.wake?.();
  }

  private releasePendingStart(p: Runtime, reason: string): void {
    p.exited = true;
    if (p.socketRetry) clearTimeout(p.socketRetry);
    p.socket?.destroy();
    this.procs.delete(p.beeId);
    this.appendSidecar(p.beeId, `pending start recovery held: bee=${p.beeId} generation=${p.generation} pid=${p.pid} reason=${reason}\n`);
  }

  private finishHost(p: Runtime): void {
    if (p.exited) return;
    // Exit can beat the watcher/sweep callback under load. Preserve startup
    // evidence from the final status before deleting the runtime record.
    this.pumpStatus(p, true);
    this.pumpHostTail(p);
    const status = p.statusPath ? readRunnerStatus(p.statusPath) : null;
    if (p.executionStart) {
      let dead = p.child?.exitCode !== null && p.child?.exitCode !== undefined || p.child?.signalCode !== null && p.child?.signalCode !== undefined;
      const currentBirth = p.executionHost ? exactProcessBirth(p.pid) : null;
      if (p.executionHost && currentBirth && currentBirth !== p.executionHost.birth) dead = true;
      try { process.kill(p.pid,0); } catch(error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") dead = true; }
      try { this.cfg.execution?.hostExited(p.executionStart,dead ? p.executionHost ?? null : null); } catch {}
    }
    if (status?.spawnError && !p.spawnError) {
      p.spawnError = status.spawnError;
    }
    this.onExit(p, status?.exited ? (status.exitCode ?? null) : null, null);
  }

  deliveryReceipt(beeId: string, generation: number, messageId: number, body: string): "accepted" | "unknown" | "not_attempted" {
    const p = this.procs.get(beeId);
    const attempt = this.pointerAttempts.get(messageId);
    const matching = attempt?.beeId === beeId && attempt.generation === generation && attempt.digest === createHash("sha256").update(body).digest("hex");
    if (matching && attempt.refused) return "not_attempted";
    return matching && (this.consumed.get(messageId) === generation || p?.generation === generation && p.confirmedDeliveries.has(messageId)) ? "accepted" : "unknown";
  }

  deliveryReadiness(beeId: string, generation: number, messageId: number): string {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation) return "absent";
    return JSON.stringify([p.exited, p.degraded, p.adapter?.harness, p.phase, p.stopCause,
      p.sessionId, p.turnId, this.reconnecting.has(`${beeId}:${generation}`),
      p.pendingDeliveries.has(messageId), p.confirmedDeliveries.has(messageId),
      p.socketBroken, p.socket?.destroyed, p.socket?.writable, p.authFailureSince,
      p.deliveryProtocol?.replies.get(messageId)?.state === "written" ? null : p.deliveryProtocol?.replies.get(messageId)]);
  }

  deliveryIssue(beeId: string, generation: number, messageId: number, body?: string): "host_auth_failed" | "message_too_large" | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return null;
    if (p.authFailureSince !== undefined && this.now() - p.authFailureSince >= 30_000) return "host_auth_failed";
    if (body === undefined) return null;
    const line = p.adapter?.encodeMessage(body, { sessionId: p.sessionId, messageId, turnActive: p.phase === "running", turnId: p.turnId });
    if (line == null) return null;
    return this.deliveryFrameOversized(p, messageId, line) ? "message_too_large" : null;
  }

  private deliveryFrameOversized(p: Runtime, messageId: number, line: string): boolean {
    const delivery = p.adapter?.confirmsDelivery ? { id: messageId, digest: createHash("sha256").update(line).digest("hex"), beeId: p.beeId, generation: p.generation } : undefined;
    return Buffer.byteLength(line) > DELIVERY_CONFIRMATION_MAX_WIRE_BYTES || Buffer.byteLength(JSON.stringify({ op: "write", line, ...(delivery ? { delivery } : {}) }) + "\n") > DELIVERY_FRAME_MAX_BYTES;
  }

  deliveryLaneReady(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p?.generation === generation && !p.exited && !p.socketBroken && p.authFailureSince === undefined
      && p.deliveryProtocol?.authenticated === true && p.socket?.destroyed === false && p.socket.writable;
  }

  adoptedDeliveryUncertain(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.child !== null) return false;
    if (p.adapter) return p.adapter.confirmsDelivery === true;
    try { return this.cfg.resolve(beeId).adapter.confirmsDelivery === true; } catch { return true; }
  }

  consumeDeliveryConfirmation(beeId: string, generation: number, messageId: number): boolean {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited || !p.processIdentity || !p.confirmedDeliveries.delete(messageId)) return false;
    p.pendingDeliveries.delete(messageId);
    this.consumed.set(messageId, generation);
    return true;
  }

  private refreshDeliveryProtocol(p: Runtime): void {
    const protocol = p.deliveryProtocol;
    if (!protocol || !p.statusPath) return;
    const status = readRunnerStatus(p.statusPath);
    if (!status || status.beeId !== p.beeId || status.generation !== p.generation || status.hostPid !== p.pid || status.exited) return;
    protocol.supported = status.capabilities?.includes(DELIVERY_STATUS_CAPABILITY) === true;
    protocol.legacy = !protocol.supported;
  }

  planDeliveryConfirmation(beeId: string, generation: number, messageId: number, body: string, options?: { freshTurn?: boolean }): DeliveryConfirmationPlan | "not_ready" | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || !p.adapter?.confirmsDelivery) return null;
    if (options?.freshTurn && p.phase === "running") return "not_ready";
    this.refreshDeliveryProtocol(p);
    if (p.exited || !p.processIdentity || !p.deliveryProtocol?.authenticated || p.socketBroken
      || !p.socket || p.socket.destroyed || !p.socket.writable || !p.deliveryProtocol.supported && !p.deliveryProtocol.legacy
      || p.phase === "booting" || p.stopCause || p.phase === "running" && !p.adapter.acceptsMidTurn) return "not_ready";
    const wireLine = p.adapter.encodeMessage(body, { sessionId: p.sessionId, messageId, turnActive: p.phase === "running", turnId: p.turnId, freshTurn: options?.freshTurn });
    if (wireLine == null) return "not_ready";
    return { wireLine, digest: createHash("sha256").update(wireLine).digest("hex"), host: p.processIdentity,
      supported: p.deliveryProtocol?.authenticated === true && p.deliveryProtocol.supported,
      legacyFirstWriteSafe: p.deliveryProtocol.authenticated && p.deliveryProtocol.legacy };
  }

  reconcileDeliveryConfirmation(beeId: string, generation: number, messageId: number, plan: DeliveryConfirmationPlan): DeliveryConfirmationResult {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || !p.processIdentity || p.processIdentity.pid !== plan.host.pid
      || p.processIdentity.birth !== plan.host.birth || p.processIdentity.bootId !== plan.host.bootId) return "unknown";
    this.refreshDeliveryProtocol(p);
    if (this.consumeDeliveryConfirmation(beeId, generation, messageId)) return "accepted";
    if (!p.deliveryProtocol?.authenticated || !p.deliveryProtocol.supported) return "pending_ack";
    const reply = p.deliveryProtocol.replies.get(messageId);
    if (reply) {
      p.deliveryProtocol.replies.delete(messageId);
      if (reply.digest !== plan.digest) return "unknown";
      if (reply.state === "written") return "pending_ack";
      if (reply.state === "accepted") {
        p.pendingDeliveries.delete(messageId);
        this.consumed.set(messageId, generation);
      }
      return reply.state;
    }
    if (!p.socket || p.socket.destroyed || !p.socket.writable) return "pending_ack";
    if (!p.deliveryProtocol.pending.has(messageId)) {
      p.deliveryProtocol.pending.add(messageId);
      const delivery: TaggedDelivery = { id: messageId, digest: plan.digest, beeId, generation };
      try { p.socket.write(`${JSON.stringify({ op: "delivery_status", delivery })}\n`); }
      catch { p.socket.destroy(); }
    }
    return "pending_ack";
  }

  deliver(beeId: string, generation: number, messageId: number, body: string, options?: { freshTurn?: boolean; singleAttempt?: boolean; confirmation?: DeliveryConfirmationPlan }): DeliverOutcome {
    const refused = (reason: "no_process" | "not_ready"): DeliverOutcome => ({ accepted: false, reason, ...(options?.singleAttempt ? { detail: "delivery_not_attempted" } : {}) });
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) {
      return refused("no_process");
    }
    if (p.pendingStartIdentity || p.executionStart && !p.executionAccepted) return refused("not_ready");
    if (this.reconnecting.has(`${beeId}:${generation}`)) return refused("not_ready");
    if (p.degraded || p.adapter == null) return refused("not_ready");
    if (p.phase === "booting") return refused("not_ready");
    if (p.stopCause != null) return refused("not_ready");
    if (p.phase === "running" && !p.adapter.acceptsMidTurn) {
      return refused("not_ready");
    }
    if (p.adapter.confirmsDelivery) {
      if (p.confirmedDeliveries.delete(messageId)) {
        this.consumed.set(messageId, generation);
        return { accepted: true };
      }
      if (p.pendingDeliveries.has(messageId) && !options?.confirmation) return { accepted: false, reason: "not_ready", pendingConfirmation: true };
    }
    if (p.socketBroken || !p.socket || p.socket.destroyed || !p.socket.writable) {
      return refused("not_ready");
    }
    if (options?.freshTurn && p.phase === "running") return refused("not_ready");
    const currentEncoding = options?.confirmation && !options.freshTurn ? options.confirmation.wireLine : p.adapter.encodeMessage(body, {
      sessionId: p.sessionId,
      messageId,
      turnActive: p.phase === "running",
      turnId: p.turnId,
      freshTurn: options?.freshTurn,
    });
    if (options?.freshTurn && options.confirmation && options.confirmation.wireLine !== currentEncoding) return refused("not_ready");
    const encoded = options?.confirmation?.wireLine ?? currentEncoding;
    if (encoded == null) return refused("not_ready");
    if (this.deliveryFrameOversized(p, messageId, encoded)) return { accepted: false, reason: "not_ready", detail: "message_too_large" };
    if (options?.confirmation && (options.confirmation.host.pid !== p.pid || options.confirmation.host.birth !== p.processIdentity?.birth
      || options.confirmation.host.bootId !== p.processIdentity?.bootId || createHash("sha256").update(encoded).digest("hex") !== options.confirmation.digest)) return refused("not_ready");
    if (options?.confirmation && !p.deliveryProtocol?.authenticated) return refused("not_ready");
    const delivery = options?.confirmation && p.deliveryProtocol?.authenticated && p.deliveryProtocol.supported
      ? { id: messageId, digest: options.confirmation.digest, beeId, generation } : undefined;
    if (!this.writeLine(p, encoded, delivery, options?.confirmation !== undefined)) return { accepted: false, reason: "not_ready" };
    if (options?.singleAttempt) this.pointerAttempts.set(messageId, { beeId, generation, digest: createHash("sha256").update(body).digest("hex") });
    p.turn.messageIds.push(messageId);
    if (p.adapter.confirmsDelivery) p.pendingDeliveries.add(messageId);
    else this.consumed.set(messageId, generation);
    if (p.phase === "idle") {
      p.phase = "running";
      this.events.push({ beeId, generation, kind: "turn_started", synthetic: true, messageId });
    }
    return p.adapter.confirmsDelivery
      ? { accepted: false, reason: "not_ready", pendingConfirmation: true }
      : { accepted: true };
  }

  reconnectToolsSupport(beeId: string, generation: number): { supported: boolean; reason?: string } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { supported: false, reason: "runtime_unavailable" };
    if (!p.adapter?.encodeReconnectTools || !p.adapter?.encodeReconnectToolsNonce) return { supported: false, reason: "unsupported_harness" };
    if (p.degraded || !p.observationPath) return { supported: false, reason: "unsupported_runner_host" };
    const status = p.statusPath ? readRunnerStatus(p.statusPath) : null;
    if (!status || status.beeId !== beeId || status.generation !== generation || status.observationError) return { supported: false, reason: "unsupported_runner_host" };
    return { supported: true };
  }

  async reconnectTools(beeId: string, generation: number, commandId: number, prepare: (apply: (targets: string[]) => Promise<void>, home: string) => Promise<void>): Promise<ReconnectToolsReceipt> {
    const support = this.reconnectToolsSupport(beeId, generation);
    if (!support.supported) throw new ReconnectToolsControlError(support.reason!, support.reason!);
    const p = this.procs.get(beeId)!;
    const reloadId = `hive-reconnect-tools-${commandId}`;
    const ready = (): void => {
      if (this.detached) throw new ReconnectToolsControlError("owner_detached", "Runtime owner detached; successor will recover the command");
      this.pumpHostTail(p);
      if (this.procs.get(beeId) !== p || p.exited || p.stopCause != null) throw new ReconnectToolsControlError("runtime_unavailable", "The owning runtime is no longer available");
      if (p.phase !== "idle" || p.pendingDeliveries.size > 0 || !p.sessionId || !p.socket?.writable || p.socket.destroyed || p.socketBroken) throw new ReconnectToolsControlError("not_ready", "Waiting for the owning turn to end and its control connection to be ready");
    };
    this.pumpHostTail(p);
    if (!p.reconnectReplies.has(reloadId)) ready();
    if (this.reconnecting.has(`${beeId}:${generation}`)) throw new ReconnectToolsControlError("not_ready", "Reconnect already in progress");
    this.reconnecting.add(`${beeId}:${generation}`);
    try {
      let targetsApplied: string[] = [];
      if (!p.reconnectReplies.has(reloadId)) {
        const config = JSON.parse(readFileSync(this.runnerPaths(beeId, generation).config, "utf8")) as RunnerHostConfig;
        if (config.beeId !== beeId || config.generation !== generation) throw new ReconnectToolsControlError("unsupported_runner_host", "Native config home ownership cannot be verified");
        const home = config.env?.CODEX_HOME || (config.env?.HOME ? join(config.env.HOME, ".codex") : null);
        if (!home) throw new ReconnectToolsControlError("config_home_unavailable", "The owning runtime has no recorded native config home");
        await prepare(async targets => {
          targetsApplied = targets;
          if (targets.length === 0) throw new ReconnectToolsControlError("no_managed_gateways", "No live Honeybee-managed MCP gateways to reconnect");
          if (targets.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new ReconnectToolsControlError("unsupported_gateway_name", "Gateway name cannot be addressed safely by the native config API");
          const deadline = Date.now() + 30_000;
          const request = async (id: string, line: string): Promise<void> => {
            ready();
            p.reconnectReplies.delete(id);
            if (!this.writeLine(p, line)) throw new ReconnectToolsControlError("not_ready", "Control connection is unavailable");
            while (!p.reconnectReplies.has(id)) {
              if (this.detached) throw new ReconnectToolsControlError("owner_detached", "Runtime owner detached");
              this.pumpHostTail(p);
              if (p.exited || p.stopCause != null) throw new ReconnectToolsControlError("runtime_unavailable", "Runtime exited before MCP acknowledgement");
              if (Date.now() >= deadline) throw new ReconnectToolsControlError("reload_timeout", "No MCP acknowledgement; outcome is unknown");
              if (!p.reconnectReplies.has(id)) await new Promise<void>(resolve => setTimeout(resolve, 20));
            }
            if (p.reconnectReplies.get(id)) throw new ReconnectToolsControlError("reload_rejected", p.reconnectReplies.get(id)!);
          };
          for (const target of targets) {
            await request(`hive-reconnect-config-${commandId}-${target}`, p.adapter!.encodeReconnectToolsNonce!(commandId, target, `${beeId}-${generation}-${commandId}`));
          }
          await request(reloadId, p.adapter!.encodeReconnectTools!(commandId));
        }, home);
      }
      if (!p.reconnectReplies.has(reloadId)) throw new ReconnectToolsControlError("reload_unconfirmed", "No native reload acknowledgement was observed");
      const error = p.reconnectReplies.get(reloadId);
      if (error) throw new ReconnectToolsControlError("reload_rejected", error);
      return { outcome: "reloaded", threadId: p.sessionId, targets: targetsApplied, modelTools: "refresh_pending_next_turn" };
    } finally { this.reconnecting.delete(`${beeId}:${generation}`); }
  }

  stop(beeId: string, generation: number, cause: StopCause): { hadProcess: boolean } {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) {
      this.pendingStarts.delete(beeId);
      pending.cancel?.();
      this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
      return { hadProcess: true };
    }
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { hadProcess: false };
    this.captureProcessIdentity(p);
    if (processDisposition(p.processIdentity ?? null, inspectProcess(p.pid)) === "exited") { this.finishHost(p); return {hadProcess: false}; }
    if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) throw new ProcessIdentityUnavailableError();
    if (p.stopCause == null) p.stopCause = cause;
    this.signalGroup(p, "SIGTERM");
    if (p.killTimer == null) {
      p.killTimer = setTimeout(() => {
        if (!p.exited) this.signalGroup(p, "SIGKILL");
      }, this.graceMs);
      p.killTimer.unref();
    }
    return { hadProcess: true };
  }

  interrupt(beeId: string, generation: number, deliveryMessageId?: number): InterruptOutcome {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { interrupted: false, reason: "no_process" };
    if (p.degraded || p.adapter == null) return { interrupted: false, reason: "not_ready" };
    if (p.phase === "booting" || p.stopCause != null) return { interrupted: false, reason: "not_ready" };
    if (p.phase === "idle") return { interrupted: false, reason: "idle" };
    if (
      deliveryMessageId !== undefined
      && (p.pendingDeliveries.has(deliveryMessageId) || p.confirmedDeliveries.has(deliveryMessageId))
    ) {
      return { interrupted: false, reason: "not_ready" };
    }
    if (typeof p.adapter.encodeInterrupt !== "function") return { interrupted: false, reason: "unsupported" };
    if (p.socketBroken || !p.socket || p.socket.destroyed || !p.socket.writable) {
      return { interrupted: false, reason: "not_ready" };
    }
    const encoded = p.adapter.encodeInterrupt({ sessionId: p.sessionId, turnId: p.turnId });
    if (encoded == null) return { interrupted: false, reason: "not_ready" };
    this.writeLine(p, encoded);
    p.quiet?.invalidate();
    return { interrupted: true, ...(p.adapter.confirmsDelivery ? { closesAcceptPoint: true } : {}) };
  }

  observe(): DriverObservation[] {
    const out = this.events;
    this.events = [];
    if (this.cfg.onObserved) for (const event of out) this.cfg.onObserved(event);
    return out;
  }

  private pumpStatus(p: Runtime, finishing = false): void {
    if (p.exited || p.pendingStartIdentity || !p.statusPath) return;
    const status = readRunnerStatus(p.statusPath);
    if (!status) return;
    if (p.executionStart) {
      if (status.hostPid !== p.pid || status.hostBirth !== p.executionHost?.birth || status.executionIntentId !== p.executionStart.intentId || status.executionDigest !== canonicalDigest(p.executionStart as unknown as JsonValue)) return;
      if (!p.executionAccepted && status.agentPid && status.agentBirth) {
        try { this.acceptExecutionStarted(p,{pid:status.agentPid,birth:status.agentBirth}); } catch { return; }
      }
      if (!p.executionAccepted) return;
    }
    if (status.socketError && !p.socketBroken) {
      p.socketBroken = true;
      this.appendSidecar(p.beeId, `runner host socket failed: ${status.socketError}\n`);
    }
    if (p.agentPid == null && typeof status.agentPid === "number") {
      p.agentPid = status.agentPid;
      if (p.socketRetry) {
        clearTimeout(p.socketRetry);
        p.socketRetry = null;
        this.connectSocket(p);
      }
      if (p.adapter?.readyAtSpawn) {
        this.cfg.onRuntimeReady?.(p.beeId, p.agentPid);
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "booted",
          pid: p.pid,
          pidStartedAt: p.pidStartedAt,
          synthetic: true,
        });
        if (p.phase === "idle") {
          this.events.push({
            beeId: p.beeId,
            generation: p.generation,
            kind: "turn_ended",
            synthetic: true,
          });
        }
      }
    }
    if (status.exited && !finishing) {
      this.captureProcessIdentity(p);
      const disposition = processDisposition(p.processIdentity ?? null, inspectProcess(p.pid));
      if (disposition === "unavailable") this.cfg.runtimeIdentity?.unavailable?.(p.beeId, p.generation);
      if (disposition === "exited") this.finishHost(p);
    }
  }

  private recoveryAgentIsLive(p: Runtime): boolean {
    const recovery = p.readinessRecovery;
    if (!recovery || !p.processIdentity || !p.deliveryProtocol?.authenticated || !p.socket?.writable || p.socket.destroyed || !p.statusPath) return false;
    const host = inspectProcess(p.pid), status = readRunnerStatus(p.statusPath);
    if (!sameProcess(p.processIdentity, host) || host.kind !== "present" || host.state !== "live" || !status || status.hostPid !== p.pid || status.beeId !== p.beeId || status.generation !== p.generation || status.exited || status.agentPid !== p.agentPid || !status.agentPid) return false;
    const agent = inspectProcess(status.agentPid);
    if (agent.kind !== "present" || agent.state !== "live" || agent.ppid !== p.pid || agent.uid !== host.uid || (status.agentBirth && status.agentBirth !== agent.birth)) return false;
    if (recovery.agent && !sameProcess(recovery.agent, agent)) return false;
    recovery.agent ??= {pid: agent.pid, birth: agent.birth, bootId: agent.bootId};
    return true;
  }

  private refuseReadinessRecovery(p: Runtime): void {
    if (!p.readinessRecovery || p.readinessRecovery.refused) return;
    p.readinessRecovery.refused = true;
    this.appendSidecar(p.beeId, `readiness recovery held bee=${p.beeId} generation=${p.generation} pid=${p.pid}\n`);
  }

  private recoverAdoptedReadiness(p: Runtime): void {
    const recovery = p.readinessRecovery;
    if (!recovery || recovery.started || recovery.refused) return;
    if (!this.recoveryAgentIsLive(p)) { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
    this.pumpHostTail(p);
    if (!p.readinessRecovery || p.phase !== "booting" && !p.executionStart) return;
    recovery.started = true;
    if (p.adapter?.readyAtSpawn) {
      try {
        if (!p.observationPath || p.logOffset < statSync(p.observationPath).size || p.stdoutRest.length > 0) { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
      } catch { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
      const context = p.observationPath ? recoverAdapterContext(p.adapter, p.observationPath, p.logOffset, p.sessionId) : null;
      this.applyRecoveredReadiness(p, {kind: "ready", sessionId: context?.sessionId ?? p.sessionId ?? "", state: context?.phase ?? "idle", ...(context?.turnId ? {turnId: context.turnId} : {}), synthetic: true});
    } else {
      const line = p.adapter?.recoveryProbe?.(recovery.requestId);
      if (!line || !this.writeLine(p, line, undefined, true)) this.refuseReadinessRecovery(p);
    }
  }

  private applyRecoveredReadiness(p: Runtime, result: ReadinessRecovery): void {
    const recovery = p.readinessRecovery;
    if (!recovery || recovery.refused) return;
    if (!this.recoveryAgentIsLive(p)) { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
    if (result.kind === "refused") { this.refuseReadinessRecovery(p); return; }
    if (result.kind === "query") {
      if (!this.writeLine(p, result.line, undefined, true)) this.refuseReadinessRecovery(p);
      return;
    }
    if (result.kind === "start") {
      if (recovery.bootstrapSent) { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
      if (!this.cfg.runtimeIdentity?.claimReadinessRecovery?.(p.beeId, p.generation, p.processIdentity!, recovery.requestId)) { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
      recovery.bootstrapSent = true;
      for (const line of result.lines) if (!this.writeLine(p, line, undefined, true)) { this.refuseReadinessRecovery(p); return; }
      return;
    }
    if (result.state === "running") { recovery.nextProbeAt = this.now() + 1000; this.armSweep(); return; }
    if (p.adapter?.recoveryProbe && !this.cfg.runtimeIdentity?.recordReadinessRecovery?.(p.beeId, p.generation, p.processIdentity!, {requestId: recovery.requestId, threadId: result.sessionId, state: result.state, ...(result.threadCwd !== undefined ? {threadCwd: result.threadCwd} : {}), ...(result.adapterCwd !== undefined ? {adapterCwd: result.adapterCwd} : {})})) { this.refuseReadinessRecovery(p); return; }
    if (p.adapter?.recoveryProbe) p.recoveredSessionId = result.sessionId;
    p.readinessRecovery = undefined;
    p.phase = result.state;
    p.turnId = null;
    if (result.sessionId && p.sessionId !== result.sessionId) {
      p.sessionId = result.sessionId;
      this.sessions.push({beeId: p.beeId, generation: p.generation, sessionId: result.sessionId});
    }
    if (!result.synthetic) p.realEvidence = true;
    this.events.push({beeId: p.beeId, generation: p.generation, kind: "booted", pid: p.pid, pidStartedAt: p.pidStartedAt, synthetic: result.synthetic});
    if (result.state === "idle") this.events.push({beeId: p.beeId, generation: p.generation, kind: "turn_ended", synthetic: result.synthetic});
  }

  private pumpHostTail(p: Runtime): void {
    if (!p.adapter || !p.observationPath || p.pendingStartIdentity) return;
    if (p.adapter.recoveryProbe && !p.deliveryProtocol?.authenticated) return;
    const path = p.observationPath;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    if (size < p.logOffset) {
      p.degraded = true;
      p.adapter = null;
      p.observationPath = null;
      p.stdoutRest = Buffer.alloc(0);
      this.appendSidecar(p.beeId, `runner observation journal truncated for generation ${p.generation}\n`);
      this.armSweep();
      return;
    }
    if (size === p.logOffset) return;
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      return;
    }
    let chunk: Buffer;
    const readOffset = p.logOffset;
    try {
      const length = size - p.logOffset;
      const buffer = Buffer.alloc(Math.min(length, 4 * 1024 * 1024));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, p.logOffset);
      p.logOffset += bytesRead;
      chunk = buffer.subarray(0, bytesRead);
    } finally {
      closeSync(fd);
    }
    const dataStart = readOffset - p.stdoutRest.length;
    const data = p.stdoutRest.length === 0 ? chunk : Buffer.concat([p.stdoutRest, chunk]);
    let lineStart = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      const lineBeginCursor = dataStart + lineStart;
      let raw = data.subarray(lineStart, newline);
      if (raw.length > 0 && raw[raw.length - 1] === 0x0d) raw = raw.subarray(0, raw.length - 1);
      const line = raw.toString("utf8");
      const lineEndCursor = dataStart + newline + 1;
      lineStart = newline + 1;
      if (line.trim().length === 0) continue;
      p.quiet?.pushLine(line, p.sessionId);
      const recovery = p.readinessRecovery;
      const recovered = recovery?.started && !recovery.refused ? p.adapter.parseRecovery?.(line, recovery.requestId, p.sessionId) : null;
      if (recovered) {
        this.applyRecoveredReadiness(p, recovered);
        p.pendingObservationCursor = lineEndCursor;
        continue;
      }
      const signals = p.adapter.parseLine(line);
      const boot = signals.find(signal => signal.kind === "booted");
      if (boot?.kind === "booted" && p.adapter.recoveryProbe && (p.readinessRecovery || p.recoveredSessionId && boot.sessionId && boot.sessionId !== p.recoveredSessionId)) {
        if (p.recoveredSessionId && boot.sessionId && boot.sessionId !== p.recoveredSessionId) this.appendSidecar(p.beeId, `ignored foreign readiness bee=${p.beeId} generation=${p.generation} thread=${boot.sessionId} recoveredThread=${p.recoveredSessionId}\n`);
        p.pendingObservationCursor = lineEndCursor;
        continue;
      }
      const lateBoot = p.phase !== "booting" && signals.some((sig) => sig.kind === "booted");
      for (const signal of signals) {
        if (lateBoot && signal.kind === "turn_ended") continue;
        if (signal.kind === "respond" && signal.bootstrap && p.readinessRecovery) continue;
        if (this.onSignal(p, signal, String(lineEndCursor), line) === false) {
          p.logOffset = lineBeginCursor;
          p.stdoutRest = Buffer.alloc(0);
          return;
        }
      }
      if (signals.length > 0) p.pendingObservationCursor = lineEndCursor;
    }
    p.stdoutRest = Buffer.from(data.subarray(lineStart));
  }

  retryProcessIdentity(beeId: string, generation: number): void {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.processIdentity || p.child) return;
    this.connectSocket(p);
  }

  hasProcess(beeId: string, generation: number): boolean {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) return true;
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && !p.exited;
  }

  hasRetainedProcess(beeId: string): boolean {
    return this.pendingStarts.has(beeId) || this.procs.get(beeId)?.exited === false;
  }

  snapshotLive(): LiveProcess[] {
    return [...this.procs.values()]
      .filter((p) => !p.exited && p.pid > 0 && processDisposition(p.processIdentity ?? null, inspectProcess(p.pid)) === "live")
      .map((p) => ({
        beeId: p.beeId,
        generation: p.generation,
        pid: p.pid,
        pidStartedAt: p.pidStartedAt,
      }));
  }

  // -------------------------------------------------------------------------
  // Beyond the WP2 interface
  // -------------------------------------------------------------------------

  adopt(
    beeId: string,
    generation: number,
    pid: number,
    pidStartedAt: number,
    lastKnownState?: "booting" | "running" | "idle",
    lastAppliedObservationCursor?: number | null,
    providerSessionId?: string | null,
  ): boolean {
    if (pid <= 0) return false;
    if (this.procs.has(beeId) || this.pendingStarts.has(beeId)) return false;
    let execution: ExecutionStart | null = null, executionHost: ExecutionProcess | null = null;
    try {
      execution = this.cfg.executionStartFor?.(beeId,generation) ?? null;
      executionHost = execution ? this.cfg.executionHostFor?.(execution) ?? null : null;
      if (execution && (!this.cfg.execution || !executionHost || executionHost.pid !== pid || exactProcessBirth(pid) !== executionHost.birth)) return false;
    } catch { return false; }

    const storedIdentity = this.cfg.runtimeIdentity?.read(beeId, generation) ?? {kind: "legacy" as const};
    const pendingStart = storedIdentity.kind === "unavailable" && storedIdentity.reason === "pending-new-start";
    if (storedIdentity.kind === "unavailable" && !pendingStart) return false;
    if (storedIdentity.kind === "bound" && storedIdentity.pidStartedAt !== pidStartedAt) return false;
    const value = inspectProcess(pid);
    const pendingStartIdentity = pendingStart && value.kind === "present" ? {pid, birth: value.birth, bootId: value.bootId} : undefined;
    let processIdentity: ProcessIdentity | undefined = storedIdentity.kind === "bound" ? storedIdentity.identity : undefined;
    if (processIdentity ? !verifyProcessIdentity(pid, processIdentity) : !legacyProcessCandidate(pid, pidStartedAt, value)) return false;
    const paths = this.runnerPaths(beeId, generation);
    const status = readRunnerStatus(paths.status);
    if (execution && (!status || status.hostBirth !== executionHost?.birth || status.executionIntentId !== execution.intentId || status.executionDigest !== canonicalDigest(execution as unknown as JsonValue))) return false;
    if (status && status.hostPid === pid && !status.exited) {
      const exactGenerationIdentity = status.beeId === beeId && status.generation === generation;
      if (pendingStart && !exactGenerationIdentity) return false;
      let adapter: HarnessAdapter | null = null;
      try {
        adapter = execution ? this.cfg.resolveExecutionAdapter?.(beeId) ?? null : this.cfg.resolve(beeId).adapter;
      } catch {
        adapter = null;
      }
      if (adapter && exactGenerationIdentity) {
        let observationPath: string | null;
        let observationOffset: number;
        let recovered: RecoveredAdapterContext = {
          quiet: new TurnQuiet(adapter.harness),
          sessionId: providerSessionId ?? null,
          turnId: null,
          confirmedDeliveries: new Set(),
          reconnectReplies: new Map(),
        };
        let journalSize: number | null = null;
        try {
          journalSize = statSync(paths.observations).size;
        } catch {
          journalSize = null;
        }
        const cursor = lastAppliedObservationCursor ?? 0;
        const validCursor = Number.isSafeInteger(cursor) && cursor >= 0 && journalSize !== null && cursor <= journalSize;
        if (status.observationError || !validCursor) {
          adapter = null;
          observationPath = null;
          observationOffset = 0;
        } else {
          observationPath = paths.observations;
          observationOffset = cursor;
          if (
            recovered.sessionId == null
            || lastKnownState === "running"
            || adapter.confirmsDelivery === true
          ) {
            recovered = recoverAdapterContext(adapter, observationPath, observationOffset, recovered.sessionId);
          }
        }
        if (adapter) {
          const recoveredSessionId = adapter.recoveryProbe ? this.cfg.runtimeIdentity?.readinessSessionId?.(beeId, generation) ?? null : null;
          const proc: Runtime = {
            ...(recoveredSessionId ? {recoveredSessionId} : {}),
            ...(execution && executionHost ? { executionStart: execution, executionHost } : {}),
            processIdentity,
            pendingStartIdentity,
            ...(lastKnownState === "booting" && (pendingStart || this.cfg.runtimeIdentity?.pendingStartBoundAt?.(beeId, generation) != null) && (adapter.readyAtSpawn || adapter.recoveryProbe) ? {readinessRecovery: {requestId: `hive-readiness-${randomUUID()}`, started: false, refused: false}} : {}),
            legacyBirthPending: !processIdentity && !pendingStart,
            beeId,
            generation,
            pid,
            pidStartedAt,
            child: null,
            adapter,
            degraded: false,
            phase: lastKnownState ?? "running",
            quiet: recovered.quiet,
            sessionId: recoveredSessionId ?? recovered.sessionId,
            turnId: lastKnownState === "running" ? recovered.turnId : null,
            turn: { ...freshTurn(), observedFromStart: lastKnownState !== "running" },
            pendingDeliveries: new Set(),
            confirmedDeliveries: recovered.confirmedDeliveries,
            reconnectReplies: recovered.reconnectReplies,
            stopCause: null,
            killTimer: null,
            stdoutRest: Buffer.alloc(0),
            exited: false,
            spawnError: null,
            commandResolution: null,
            realEvidence: false,
            agentPid: typeof status.agentPid === "number" ? status.agentPid : null,
            socket: null,
            socketRetry: null,
            socketPath: paths.socket,
            statusPath: paths.status,
            observationPath,
            logOffset: observationOffset,
            initialObservationCursor: observationOffset,
            pendingObservationCursor: null,
            pendingWrites: [],
            socketBroken: false,
          };
          if (!pendingStart && execution && status.agentPid && status.agentBirth) { try { this.acceptExecutionStarted(proc,{pid:status.agentPid,birth:status.agentBirth}); } catch { return false; } }
          this.procs.set(beeId,proc);
          this.cfg.onRuntimeReady?.(beeId, proc.agentPid);
          this.connectSocket(proc);
          this.markDirty(proc, true);
          this.armSweep();
          return true;
        }
      }
    }
    if (execution || pendingStart) return false;
    const receiptHost = status ? status.hostPid === pid && status.beeId === beeId && status.generation === generation && !status.exited
      : storedIdentity.kind === "legacy" && value.kind === "present" && legacyRunnerCommandProof(value, pidStartedAt, paths.config, paths.status);
    this.procs.set(beeId, {
      processIdentity,
      legacyBirthPending: storedIdentity.kind === "legacy",
      beeId,
      generation,
      pid,
      pidStartedAt,
      child: null,
      adapter: null,
      quiet: null,
      degraded: true,
      phase: "running",
      sessionId: null,
      turnId: null,
      turn: freshTurn(),
      pendingDeliveries: new Set(),
      confirmedDeliveries: new Set(),
      reconnectReplies: new Map(),
      stopCause: null,
      killTimer: null,
      stdoutRest: Buffer.alloc(0),
      exited: false,
      spawnError: null,
      commandResolution: null,
      realEvidence: false,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: receiptHost ? paths.socket : null,
      statusPath: receiptHost ? paths.status : null,
      observationPath: null,
      logOffset: 0,
      initialObservationCursor: 0,
      pendingObservationCursor: null,
      pendingWrites: [],
      socketBroken: false,
    });
    this.cfg.onRuntimeReady?.(beeId, status?.agentPid ?? null);
    if (receiptHost) this.connectSocket(this.procs.get(beeId)!);
    this.armSweep();
    return true;
  }

  isDegraded(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && p.degraded && !p.exited;
  }

  private captureProcessIdentity(p: Runtime): void {
    if (p.processIdentity || !p.child || p.child.exitCode !== null || p.child.signalCode !== null) return;
    const value = inspectProcess(p.pid);
    if (value.kind === "present" && value.state === "live") p.processIdentity = {pid: p.pid, birth: value.birth, bootId: value.bootId};
  }

  procOf(
    beeId: string,
    generation: number,
  ): { pid: number; pidStartedAt: number; observationCursor: number; processIdentity?: ProcessIdentity } | null {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.pid <= 0) return null;
    this.captureProcessIdentity(p);
    return {
      ...(p.processIdentity ? {processIdentity: p.processIdentity} : {}),
      pid: p.pid,
      pidStartedAt: p.pidStartedAt,
      observationCursor: p.initialObservationCursor,
    };
  }

  observeEvidence(): FlagEvidence[] {
    const out = this.evidence;
    this.evidence = [];
    if (!this.cfg.extraEvidence) return out;
    const cleared = out.filter((ev) => ev.flag === "resource_blocked" && ev.action === "clear").map((ev) => ev.beeId);
    return [...out, ...this.cfg.extraEvidence(() => this.snapshotLive(), cleared)];
  }

  observeSessions(): SessionEvidence[] {
    const out = this.sessions;
    this.sessions = [];
    return out;
  }

  observeUsage(): UsageEvidence[] {
    const out = this.usage;
    this.usage = [];
    return out;
  }

  observeRecoveryCursors(): ObservationCursorEvidence[] {
    const out: ObservationCursorEvidence[] = [];
    for (const p of this.procs.values()) {
      if (p.pendingObservationCursor == null) continue;
      out.push({ beeId: p.beeId, generation: p.generation, cursor: p.pendingObservationCursor });
      p.pendingObservationCursor = null;
    }
    return out;
  }

  sessionLogPath(beeId: string): string {
    return stateFile(this.cfg.sessionLogPathFor?.(beeId) ?? join(stateDirectory(this.cfg.sessionLogDir,"sessionLogDir"), `${beeId}.jsonl`), "sessionLogPath");
  }

  observationLogPath(beeId: string, generation: number): string {
    return this.runnerPaths(beeId, generation).observations;
  }

  consumedGeneration(messageId: number): number | undefined {
    return this.consumed.get(messageId);
  }

  consumedCount(): number {
    return this.consumed.size;
  }

  liveProcesses(): LiveProcess[] {
    return this.snapshotLive();
  }

  detachAll(): void {
    this.detached = true;
    for (const pending of this.pendingStarts.values()) pending.cancel?.();
    this.pendingStarts.clear();
    this.closeObservationSources();
    for (const p of this.procs.values()) {
      if (p.killTimer) {
        clearTimeout(p.killTimer);
        p.killTimer = null;
      }
      if (p.socketRetry) {
        clearTimeout(p.socketRetry);
        p.socketRetry = null;
      }
      p.socket?.destroy();
      p.socket = null;
      if (p.executionStart && p.child?.connected) p.child.disconnect();
      p.child?.unref();
      for (const stream of [p.child?.stdin, p.child?.stdout, p.child?.stderr]) {
        (stream as unknown as { unref?: () => void } | null | undefined)?.unref?.();
      }
    }
  }

  disposeAll(): void {
    for (const pending of this.pendingStarts.values()) pending.cancel?.();
    this.pendingStarts.clear();
    this.closeObservationSources();
    for (const p of this.procs.values()) {
      if (p.killTimer) clearTimeout(p.killTimer);
      if (!p.exited) {
        if (p.stopCause == null) p.stopCause = "stopped_by_system";
        this.signalGroup(p, "SIGKILL");
      }
    }
    this.events = [];
    this.evidence = [];
    this.sessions = [];
  }

  /** Ephemeral shutdown must acknowledge exit, rather than just attempt a signal.
   * Production daemon restarts use detachAll() and preserve these runtimes. */
  async disposeAllAndWait(timeoutMs = 15_000): Promise<void> {
    const owned = [...this.procs.values()].filter(p => p.pid > 0);
    this.disposeAll();
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const pending = owned.flatMap(p => {
        const value = inspectProcess(p.pid);
        if (value.kind === "gone" || value.kind === "present" && (
          value.state === "zombie" || p.processIdentity && !sameProcess(p.processIdentity, value)
        )) return [];
        // Keep the original birth fence. A transient native observation or
        // signal failure must not permanently lose disposal of an adopted host.
        this.signalGroup(p, "SIGKILL");
        return [{ pid: p.pid, identity: p.processIdentity ?? null, observation: value }];
      });
      if (pending.length === 0) return;
      if (performance.now() >= deadline) throw new Error(`Runtime disposal timed out: ${JSON.stringify(pending)}`);
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }

  private closeObservationSources(): void {
    if (this.sweepTimer) {
      clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.dirty.clear();
    try { this.watcher?.close(); } catch {}
    this.watcher = null;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private writeLine(p: Runtime, line: string, delivery?: TaggedDelivery, confirmationWrite = false): boolean {
    if (Buffer.byteLength(JSON.stringify({ op: "write", line, ...(delivery ? { delivery } : {}) }) + "\n") > DELIVERY_FRAME_MAX_BYTES) return false;
    if (process.env.HIVE_SPAWN_TRACE) {
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ write: line.slice(0, 160), at: Date.now(), stack: new Error().stack?.split("\n").slice(2, 6).join(" | ") }) + "\n");
    }
    try {
      if (p.socket && !p.socket.destroyed && p.socket.writable) {
        p.socket.write(`${JSON.stringify({ op: "write", line, ...(delivery ? { delivery } : {}) })}\n`);
        return true;
      }
      if (confirmationWrite) return false;
      p.pendingWrites.push(line);
      this.connectSocket(p);
      return false;
    } catch {
      return false;
    }
  }

  private signalGroup(p: Runtime, signal: "SIGTERM" | "SIGKILL"): void {
    if (p.pid <= 0) return;
    this.captureProcessIdentity(p);
    if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) return;
    if (p.degraded) {
      if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) return;
      try {
        process.kill(-p.pid, signal);
      } catch {
        try {
          process.kill(p.pid, signal);
        } catch {
        }
      }
      return;
    }
    try {
      process.kill(-p.pid, signal);
    } catch {
      try {
        p.child?.kill(signal);
      } catch {
      }
    }
  }

  private onSignal(p: Runtime, signal: ReturnType<HarnessAdapter["parseLine"]>[number], sourceId: string, rawLine: string): void | boolean {
    if (
      (signal.kind === "turn_started" || signal.kind === "turn_ended")
      && signal.threadId
      && p.sessionId
      && signal.threadId !== p.sessionId
    ) {
      return;
    }
    if (!p.realEvidence) {
      p.realEvidence = true;
      if (p.phase !== "booting") {
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "booted",
          pid: p.pid,
          pidStartedAt: p.pidStartedAt,
        });
      }
    }
    switch (signal.kind) {
      case "tools_control_result":
        p.reconnectReplies.set(signal.requestId, signal.error ?? null);
        return;
      case "booted": {
        this.cfg.onRuntimeReady?.(p.beeId, p.agentPid ?? (p.statusPath ? readRunnerStatus(p.statusPath)?.agentPid : null) ?? null);
        if (signal.sessionId) {
          if (p.sessionId !== signal.sessionId) {
            this.sessions.push({ beeId: p.beeId, generation: p.generation, sessionId: signal.sessionId });
          }
          p.sessionId = signal.sessionId;
        }
        if (p.phase !== "booting") return;
        p.phase = "running";
        p.readinessRecovery = undefined;
        this.events.push({
          beeId: p.beeId,
          generation: p.generation,
          kind: "booted",
          pid: p.pid,
          pidStartedAt: p.pidStartedAt,
        });
        return;
      }
      case "turn_started": {
        if (signal.turnId) p.turnId = signal.turnId;
        if (p.phase !== "idle") return;
        p.phase = "running";
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_started" });
        return;
      }
      case "turn_progress": {
        p.turn.progressed = true;
        return;
      }
      case "turn_ended": {
        const endedQuiet = p.quiet?.end();
        p.turnId = null;
        p.turn = freshTurn();
        if (p.phase !== "running") return;
        p.phase = "idle";
        this.events.push({ beeId: p.beeId, generation: p.generation, kind: "turn_ended", ...(endedQuiet !== undefined ? { endedQuiet } : {}) });
        return;
      }
      case "delivery_confirmed": {
        p.pendingDeliveries.delete(signal.messageId);
        p.confirmedDeliveries.add(signal.messageId);
        return;
      }
      case "delivery_refused": {
        const attempt = this.pointerAttempts.get(signal.messageId);
        if (attempt?.beeId === p.beeId && attempt.generation === p.generation) attempt.refused = true;
        p.pendingDeliveries.delete(signal.messageId);
        p.confirmedDeliveries.delete(signal.messageId);
        p.turn.messageIds = p.turn.messageIds.filter((id) => id !== signal.messageId);
        if (p.phase === "running" && p.turn.messageIds.length === 0 && p.turnId === null) {
          p.phase = "idle";
          this.events.push({beeId: p.beeId, generation: p.generation, kind: "turn_ended", synthetic: true});
        }
        return;
      }
      case "flag": {
        const raw = signal.quota ? JSON.parse(rawLine) as Record<string, unknown> : null;
        const transcriptSourceId = raw && typeof raw.uuid === "string" && raw.uuid.trim().length > 0 ? raw.uuid : signal.quota ? quotaSourceId(rawLine) : undefined;
        this.evidence.push({
          beeId: p.beeId,
          generation: p.generation,
          flag: signal.flag,
          action: signal.action,
          detail: signal.detail,
          ...(signal.quota ? { quota: signal.quota, eventId: `quota:${p.beeId}:${p.generation}:${sourceId}`, sourceId: transcriptSourceId } : {}),
          ...(signal.resetsAt !== undefined ? { resetsAt: signal.resetsAt } : {}),
          ...(signal.action === "set" ? { turn: this.turnEvidence(p) } : {}),
        });
        return;
      }
      case "usage_observed": {
        this.usage.push({
          beeId: p.beeId,
          generation: p.generation,
          observedAt: this.now(),
          ...(signal.usage ? { usage: signal.usage } : {}),
          ...(signal.quota ? { quota: signal.quota } : {}),
        });
        return;
      }
      case "respond": {
        if (p.adapter?.recoveryProbe && !p.deliveryProtocol?.authenticated) return false;
        for (const line of signal.lines) if (!this.writeLine(p, line, undefined, true)) return false;
        return true;
      }
    }
  }

  private turnEvidence(p: Runtime): TurnEvidence {
    const proven = p.turn.observedFromStart && p.adapter?.reportsTurnProgress === true;
    return {
      messageIds: [...p.turn.messageIds],
      progress: p.turn.progressed ? "some" : proven ? "none" : "unknown",
    };
  }

  private onExit(p: Runtime, code: number | null, _signal: NodeJS.Signals | null): void {
    if (p.exited) return;
    p.exited = true;
    if (p.killTimer) {
      clearTimeout(p.killTimer);
      p.killTimer = null;
    }
    if (p.socketRetry) {
      clearTimeout(p.socketRetry);
      p.socketRetry = null;
    }
    p.socket?.destroy();
    p.socket = null;
    this.dirty.delete(p);
    this.procs.delete(p.beeId);
    const cause = p.stopCause ?? (code === 0 ? "clean" : "crashed");
    const notFound = p.spawnError && p.commandResolution?.source === "not_found"
      ? ` — ${executableNotFoundDetail(p.commandResolution.executable)}`
      : "";
    this.events.push({
      beeId: p.beeId,
      generation: p.generation,
      kind: "exited",
      exitCause: cause,
      ...(p.spawnError ? { detail: `spawn error: ${p.spawnError}${notFound}` } : {}),
    });
    const pending = this.pendingStarts.get(p.beeId);
    if (pending && !pending.cancel) {
      this.pendingStarts.delete(p.beeId);
      try {
        this.launch(p.beeId, pending.generation, pending.execution ?? null);
      } catch (error) {
        if (pending.execution) this.appendSidecar(p.beeId,"deferred execution start held; reconcile original binding\n");
        else throw error;
      }
    }
  }

  private appendSidecar(beeId: string, text: string): void {
    try {
      appendFileSync(join(this.cfg.sessionLogDir, `${beeId}.stderr.log`), text);
    } catch {
    }
  }
}
