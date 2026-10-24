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
import { canonicalDigest, type JsonValue } from "../../../src/comb/canonical.ts";
import { TurnQuiet } from "../../driver-tmux/src/turn-quiet.ts";
import { childNodePath, nativeNodeEnv } from "../../../src/nodeRuntime.ts";
import type { ReconnectToolsReceipt } from "../../core/src/reconnectTools.ts";
/**
 * HsrDriver — the first real substrate driver (WP3 of the reset).
 *
 * Implements the RuntimeDriver interface EXACTLY as fixed by WP2
 * (v2/harness/src/driver.ts): the WP2 SimDaemon drives this driver unmodified.
 * Spec: docs/design/specs/reset-03-hsr-driver.md.
 *
 * Behavior mapping to the spec:
 *  1. Parenthood — `start` spawns a detached runner host in its OWN process
 *     group; that host owns the agent child and its pipes. The driver captures
 *     host pid + start-time AT SPAWN (`procOf`), so core can record and exactly
 *     re-adopt the durable runtime across daemon restarts.
 *  2. Truth = structured events — the driver consumes the child's stdout as an
 *     NDJSON line stream; no screen scraping. Every raw line is appended
 *     VERBATIM to the bee's session log (Q1: the log is the native stream;
 *     adapters re-derive observations); the harness adapter distills lines
 *     into DriverObservations and condition-flag evidence.
 *  3. Deliver — writes the adapter-encoded message to the child's stdin at its
 *     accept point. Deterministic: accepted, or refused with `no_process` /
 *     `not_ready` (Q2: a booting runtime refuses; the daemon's delivery loop
 *     retries — no hidden driver-side queue). Delivery doubt cannot exist.
 *  4. Stop — signals the exact spawned process: TERM to its process group,
 *     escalate to KILL after a bounded wait. A dead-already process is
 *     `hadProcess:false`, never an error.
 *  5. Exact identity everywhere — signal targets are only ever the pid the
 *     driver itself spawned and still holds the live ChildProcess handle for
 *     (parenthood: the pid cannot be recycled before the exit event fires,
 *     because the unreaped child holds it). pid + start-time are the durable
 *     identity handed to core for cross-restart re-adoption. No name, alias
 *     or pane is ever a signal target (the CO.a8d2 lesson).
 *  6. observe() never blocks — events drain from an internal buffer fed by
 *     the runner's output-only, generation-scoped journal and host-exit facts.
 *     The core checkpoints parsed journal bytes only after their effects, so
 *     undrained evidence survives daemon death without transcript guessing.
 *
 * WP4 addition — cross-restart re-adoption (contract §3.2): when the daemon
 * PROCESS restarts, ChildProcess handles are gone but the detached host and
 * agent survive. `adopt(...)` verifies exact pid/start-time, reconnects the
 * host socket, and resumes the exact generation journal at core's committed
 * cursor. Missing/corrupt proof falls back to a conservative degraded exact-
 * pid adoption; silence never manufactures idle.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { connect, type Socket } from "node:net";
import { dirname, extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { readRunnerStatus, type RunnerHostConfig } from "./runner-host.ts";
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

// Pin the module's physical deployment before an immutable runtime's
// `current` symlink can move. Node normally realpaths imported modules, but
// --preserve-symlinks deliberately does not; doing it explicitly keeps a
// daemon loaded from release A paired with release A's runner host in both
// modes. This resolves only our own file, never the optional sibling.
const PINNED_HSR_MODULE_PATH = realpathSync(fileURLToPath(import.meta.url));
const PINNED_HSR_MODULE_DIR = dirname(PINNED_HSR_MODULE_PATH);

/** What `start` needs to know per bee: which agent, how to spawn it. */
export interface SpawnSpec {
  adapter: HarnessAdapter;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * How `command` was resolved (core resolveSpawnCommand — the one rule,
   * F8). `not_found` means the resolver searched PATH + fallbacks and found
   * nothing: the spawn proceeds with the bare name (honest ENOENT) and the
   * exit detail names the missing executable for the operator.
   */
  commandResolution?: SpawnCommandResolution;
}

export interface HsrDriverConfig {
  runtimeIdentity?: RuntimeIdentityHooks;
  execution?: ExecutionRuntimeHooks;
  executionStartFor?(beeId: string, generation: number): ExecutionStart | null;
  executionHostFor?(start: ExecutionStart): ExecutionProcess | null;
  resolveExecutionAdapter?(beeId: string): HarnessAdapter;
  /** Resolve the spawn spec for a bee (agent binary + adapter). */
  resolve(beeId: string, generation?: number): SpawnSpec;
  /** Directory for session logs; one `<beeId>.jsonl` per bee, verbatim native stream. */
  sessionLogDir: string;
  /**
   * v23: the bee's CURRENT session log file when the store has moved it (a
   * handoff opens a new transcript segment with its own file so the target
   * harness never appends to a log the source harness wrote). Null/absent =
   * the default `<sessionLogDir>/<beeId>.jsonl`.
   */
  sessionLogPathFor?: (beeId: string) => string | null;
  /** Bounded wait between TERM and KILL escalation (spec point 4). Default 5000ms. */
  stopKillGraceMs?: number;
  /** Start-time tolerance for cross-restart re-adoption identity checks. Default 5000ms. */
  adoptToleranceMs?: number;
  now?: () => number;
  random?: () => number;
  /**
   * Directory for runner-host artifacts (config/socket/status per runtime
   * generation). Default: `<sessionLogDir>/../runners`.
   */
  runnersDir?: string;
  socketDir?: string;
  /**
   * How to launch the runner host for a written config file. The default
   * invokes the sibling TS entry under --experimental-strip-types in source
   * checkouts and the dedicated sibling runner-host.js artifact from builds.
   */
  hostCommand?: (configPath: string) => { command: string; args: string[] };
  /** A runner write lane connected; mail refused `not_ready` can go now. */
  onWriteLaneReady?: () => void;
}

type HostLaunch =
  | { kind: "override"; commandFor: NonNullable<HsrDriverConfig["hostCommand"]> }
  | { kind: "source"; entry: string }
  | { kind: "artifact"; entry: string };

/** Condition-flag evidence surfaced by adapters, stamped with process identity. */
export interface FlagEvidence {
  beeId: string;
  generation: number;
  flag: "auth_needed" | "resource_blocked" | "spawn_failed";
  action: "set" | "clear";
  detail: string;
  /** Provider-declared instant (epoch ms) the condition lifts, when stated. */
  resetsAt?: number;
  /** The turn a `set` cut off: the mail delivered into it and whether the provider served any of it. */
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
  /** False while the turn began before this daemon adopted the process. */
  observedFromStart: boolean;
}

function freshTurn(): TurnTrack {
  return { messageIds: [], progressed: false, observedFromStart: true };
}

/**
 * Harness-native session identity reported by a runtime's booted signal
 * (claude system/init session_id, codex thread id). The daemon records it on
 * the bee so revive can resume the conversation (spec 07 §F).
 */
export interface SessionEvidence {
  beeId: string;
  generation: number;
  sessionId: string;
}

/**
 * Subscription usage a runtime observed on its own provider responses
 * (adapter `usage_observed`), stamped with process identity. `observedAt` is
 * the driver clock when the line was parsed; a usage payload that carries its
 * own observation time wins.
 */
export interface UsageEvidence {
  beeId: string;
  generation: number;
  observedAt: number;
  usage?: Record<string, unknown>;
  quota?: Record<string, unknown>;
}

/**
 * Highest fully parsed runner-journal byte for one generation. The daemon
 * commits this only after every normalized effect emitted before it has
 * settled in the core store.
 */
export interface ObservationCursorEvidence {
  beeId: string;
  generation: number;
  cursor: number;
}

interface ManagedProcess {
  deliveryProtocol?: { authenticated: boolean; supported: boolean; legacy: boolean; pending: Set<number>; replies: Map<number, DeliveryStatus> };
  authFailureSince?: number;
  authFailures?: number;
  processIdentity?: ProcessIdentity;
  legacyBirthPending?: boolean;
  pendingStartIdentity?: ProcessIdentity;
  readinessRecovery?: {requestId: string; agent?: ProcessIdentity; started: boolean; refused: boolean; nextProbeAt?: number; bootstrapSent?: boolean};
  executionStart?: ExecutionStart;
  executionHost?: ExecutionProcess;
  executionAccepted?: boolean;
  beeId: string;
  generation: number;
  pid: number;
  pidStartedAt: number;
  /** Null for a re-adopted (degraded) process — the handle died with the previous daemon. */
  child: ChildProcess | null;
  /** Null for a re-adopted (degraded) process — there is no event stream to normalize. */
  adapter: HarnessAdapter | null;
  /** True when this process was re-adopted across a daemon restart (no pipes). */
  degraded: boolean;
  /** Driver-side accept-point phase; the store's state is derived downstream. */
  phase: "booting" | "running" | "idle";
  sessionId: string | null;
  /** v6: the harness-native id of the turn in flight (codex turn/started), for turn/interrupt. */
  turnId: string | null;
  /** Mail and provider progress of the turn in flight, for auth-interruption evidence. */
  turn: TurnTrack;
  quiet: TurnQuiet | null;
  /** RPC deliveries written but not yet accepted by the harness. */
  pendingDeliveries: Set<number>;
  /** Durable protocol acknowledgements waiting for the daemon to mark mailbox truth. */
  confirmedDeliveries: Set<number>;
  reconnectReplies: Map<string, string | null>;
  /** First requested stop cause; fixes the exit cause of a signaled process. */
  stopCause: StopCause | null;
  killTimer: NodeJS.Timeout | null;
  /** Incomplete final line from the output-only observation journal. */
  stdoutRest: Buffer;
  exited: boolean;
  /**
   * Runner-host runtime (WP5): `child` is the detached HOST process; the
   * agent is the host's child in the same process group. The host owns the
   * agent's pipes and writes the session log, so the runtime survives daemon
   * restarts; the driver observes by tailing the log and delivers over the
   * host's unix socket. False only for legacy degraded adoptions (runtimes
   * spawned by a pre-host daemon).
   */
  hostStyle: boolean;
  /** Agent pid learned from the host's status file (host pid is `pid`). */
  agentPid: number | null;
  socket: Socket | null;
  socketRetry: NodeJS.Timeout | null;
  socketPath: string | null;
  statusPath: string | null;
  /** Output-only journal (v15+) or the legacy shared transcript fallback. */
  observationPath: string | null;
  /** Byte offset consumed from observationPath by the observation tail. */
  logOffset: number;
  /** Cursor exposed at spawn so core can durably establish the generation baseline. */
  initialObservationCursor: number;
  /** Highest signal-bearing line parsed since the daemon last checkpointed. */
  pendingObservationCursor: number | null;
  /** Legacy hosts only: their observation source is the bidirectional session log. */
  legacySharedObservation: boolean;
  /**
   * Outbound lines the driver sent through the host (deliver/interrupt/
   * respond/boot). The host appends them to the session log in write order;
   * the tail matches-and-skips them so adapters only parse agent output.
   */
  outboundPending: string[];
  /**
   * Adapter-generated non-mail protocol lines awaiting a reconnect. Mail
   * delivery and interrupts never enter this daemon-local queue: they refuse
   * `not_ready` until the runner connection can accept them.
   */
  pendingWrites: string[];
  /** The host reported its stdin lane could not be established: refuse
   * deliveries instead of queueing into a black hole. */
  socketBroken: boolean;
  /** The OS spawn/process error message, when the child emitted `error` (e.g. ENOENT). */
  spawnError: string | null;
  /** Resolution fact for the spawned command (own spawns only; null on adoption). */
  commandResolution: SpawnCommandResolution | null;
  /**
   * v9: whether the adapter has parsed at least one signal from this
   * process's actual output. A readyAtSpawn runtime opens its accept point on
   * a driver-minted synthetic booted; only real output upgrades it — the
   * first parsed signal pushes a real `booted` observation so the daemon
   * learns, in stream order, that the process demonstrably runs (the
   * spawn-failure budget resets on that, never on the synthetic booted).
   */
  realEvidence: boolean;
}

interface RecoveredAdapterContext {
  phase?: "running" | "idle";
  sessionId: string | null;
  turnId: string | null;
  confirmedDeliveries: Set<number>;
  reconnectReplies: Map<string, string | null>;
  quiet: TurnQuiet;
}

/**
 * Rebuild adapter-local delivery context from the exact generation journal
 * prefix already committed by core. This is not lifecycle inference from a
 * rendered transcript: every line is the native output-only protocol stream
 * and is normalized by the same pure adapter used live.
 */
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
    // Supplemental context recovery fails closed: durable phase/session truth
    // still adopts, while turn-addressed delivery refuses until new evidence.
  } finally {
    if (fd != null) closeSync(fd);
  }
  return { sessionId, turnId, confirmedDeliveries, reconnectReplies, quiet, phase };
}

export class ReconnectToolsControlError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export class HsrDriver implements RuntimeDriver {
  private readonly reconnecting = new Set<string>();
  private detached = false;
  private readonly cfg: HsrDriverConfig;
  private fallbackSocketDir: string | null = null;
  private readonly hostLaunch: HostLaunch;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly adoptTolMs: number;
  /** Keyed by beeId — at most one live process per bee (driver-level invariant). */
  private readonly procs = new Map<string, ManagedProcess>();
  /**
   * Real-process asynchrony the SimDriver never had: a stop() leaves the old
   * process *dying* (TERM sent, exit event pending) while the daemon may
   * already start the next generation. `start` for a bee whose process is
   * dying is deferred here and spawned from the old process's exit callback —
   * still "returns immediately; boot progress arrives as observations".
   */
  private readonly pendingStarts = new Map<string, { generation: number; execution?: ExecutionStart | null }>();
  private events: DriverObservation[] = [];
  private evidence: FlagEvidence[] = [];
  private sessions: SessionEvidence[] = [];
  private usage: UsageEvidence[] = [];
  /** Delivery ground truth for the invariant checker: messageId → generation. */
  private readonly consumed = new Map<number, number>();
  private readonly pointerAttempts = new Map<number, { beeId: string; generation: number; digest: string; refused?: boolean }>();

  constructor(cfg: HsrDriverConfig) {
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
  }

  private runnersDir(): string {
    if (this.cfg.runnersDir !== undefined) return stateDirectory(this.cfg.runnersDir, "runnersDir");
    const parent = stateDirectory(dirname(stateDirectory(this.cfg.sessionLogDir, "sessionLogDir")), "default runners parent");
    return resolvePath(parent, "runners");
  }

  private selectHostLaunch(): HostLaunch {
    // Overrides are a complete caller-owned launch policy. In particular,
    // embedding/tests may intentionally provide one without packaging our
    // default sibling, so do not even inspect the sibling on this branch.
    const override = this.cfg.hostCommand;
    if (override) return { kind: "override", commandFor: override };

    const source = extname(PINNED_HSR_MODULE_PATH) === ".ts";
    const entry = join(PINNED_HSR_MODULE_DIR, source ? "runner-host-main.ts" : "runner-host.js");
    try {
      if (!statSync(entry).isFile()) throw new Error("not a regular file");
    } catch (cause) {
      if (source) {
        throw new Error(
          `hsr driver: required runner-host source entry is unavailable at ${entry}; restore the source checkout or provide hostCommand`,
          { cause },
        );
      }
      throw new Error(
        `hsr driver: required bundled runner-host artifact is unavailable at ${entry}; rebuild or reinstall Honeybee so runner-host.js is shipped beside the v2 bundle`,
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
    // The unix socket CANNOT live beside the other artifacts: sun_path is
    // capped (104 bytes on macOS) and runnersDir under a test tmpdir already
    // blows it — listen fails silently and every delivery would black-hole.
    // A short deterministic tmpdir name keeps the path tiny and derivable at
    // adoption from the same identity inputs.
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
  // RuntimeDriver — the fixed WP2 contract
  // -------------------------------------------------------------------------

  start(beeId: string, generation: number, execution?: ExecutionStart | null): void {
    const start = execution ?? this.cfg.executionStartFor?.(beeId,generation) ?? null;
    if (start && (start.beeId !== beeId || start.runtimeGeneration !== generation)) throw new ExecutionFenceError("rpc_execution_history_unknown", "Start intent does not bind the requested bee and runtime generation");
    if (start && !this.cfg.execution) throw new ExecutionFenceError("rpc_execution_fence_unsupported", "Fenced HSR start requires owner hooks");
    if (start) this.cfg.execution!.check(start,"hsr_start");
    if (this.detached) return;
    const existing = this.procs.get(beeId);
    if (existing) {
      if (existing.stopCause != null || this.pendingStarts.has(beeId)) {
        // The previous generation is dying (exit event pending). Defer the
        // spawn to its exit callback — one live process per bee, always.
        this.pendingStarts.set(beeId, { generation, execution: start });
        return;
      }
      throw new Error(
        `hsr driver: bee ${beeId} already has a live process (generation ${existing.generation}, pid ${existing.pid})`,
      );
    }
    if (start) this.cfg.execution!.check(start,"spawn_spec");
    const spec = this.cfg.resolve(beeId, generation);
    if (process.env.HIVE_SPAWN_TRACE) {
      // Diagnostics only: exact spawn shape for post-mortem replay.
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ command: spec.command, args: spec.args, cwd: spec.cwd, envKeys: Object.keys(spec.env ?? {}).length, at: Date.now() }) + "\n");
    }
    // WP5: spawn the runner HOST, not the agent. The host is detached in its
    // own process group (spec point 1 — group signals reach host + agent and
    // never a sibling of ours) and spawns the agent as ITS child in that same
    // group, holding the agent's pipes. A daemon restart therefore takes no
    // pipe down: the runtime survives, and boot re-adoption reconnects with
    // full capability instead of the old degraded stop-on-mail rotation.
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
    const proc: ManagedProcess = {
      ...(start ? { executionStart: start, ...(hostBirth && child.pid ? { executionHost: { pid: child.pid, birth: hostBirth } } : {}) } : {}),
      beeId,
      generation,
      // pid captured AT SPAWN (WP2 amendment) — the HOST's pid: host liveness
      // IS runtime liveness (the host exits when the agent exits), so the
      // stored proc identity adopts across daemon restarts unchanged.
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
      hostStyle: true,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: paths.socket,
      statusPath: paths.status,
      observationPath: paths.observations,
      // One output-only journal per generation starts at byte zero. Core
      // persists this baseline with the pid identity before any fold.
      logOffset: 0,
      initialObservationCursor: 0,
      pendingObservationCursor: null,
      legacySharedObservation: false,
      outboundPending: [],
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


    // Host spawn failure (missing node/CLI — configuration, not the agent):
    // surface as exited(crashed) through the daemon's spawn-retry path.
    child.on("error", (err) => {
      proc.spawnError = String(err?.message ?? err);
      this.appendSidecar(beeId, `runner host spawn error: ${proc.spawnError}\n`);
      this.finishHost(proc);
    });
    // Host exit = runtime exit (the host outlives the agent by milliseconds
    // to record the exit facts). Drain the tail before the exit observation
    // so trailing output lands in stream order.
    child.on("exit", () => this.finishHost(proc));

    this.connectSocket(proc);

    if (!start && spec.adapter.readyAtSpawn) {
      // claude stream-json emits nothing until the first stdin message: the
      // harness accept point opens now. Delivery still waits for the runner
      // socket, leaving startup mail durable instead of buffering it in the
      // daemon. The synthetic `booted` OBSERVATION waits for the host's
      // status file to confirm the AGENT process exists — the same
      // "OS confirmed the spawn" semantics the direct child's `spawn` event
      // carried (v9: synthetic,
      // never boot evidence; an agent that fails to spawn reports spawnError
      // and exits while still booting, counting against the spawn budget).
      // The phase accept point is open immediately, but deliver() still
      // refuses until the runner socket is connected: daemon-local buffering
      // cannot justify a durable mailbox delivered mark across SIGKILL.
      // The driver's phase is idle from here; the synthetic booted below is
      // paired with a synthetic turn_ended so the store lands on the same
      // idle (see pollHost) instead of a `running` no output will ever close.
      proc.phase = "idle";
    }
  }

  /** Current session-log size — the tail baseline for a new generation. */
  private sessionLogSize(beeId: string): number {
    try {
      return statSync(this.sessionLogPath(beeId)).size;
    } catch {
      return 0;
    }
  }

  /**
   * Connect (and keep reconnecting) the write lane to the runner host. The
   * socket is fire-and-forget outbound only; deliver() refuses `not_ready`
   * until it is connected and the daemon's delivery loop retries — the same
   * bounded-refusal contract a booting runtime already has.
   */
  private acceptExecutionStarted(p: ManagedProcess, agent: ExecutionProcess): void {
    if (!p.executionStart || !p.executionHost || p.executionAccepted) return;
    if (!agent || exactProcessBirth(p.executionHost.pid) !== p.executionHost.birth || exactProcessBirth(agent.pid) !== agent.birth) throw new ExecutionFenceError("rpc_execution_history_unknown", "Agent-start identity is unavailable");
    this.cfg.execution!.started(p.executionStart,p.executionHost,agent);
    p.executionAccepted = true;
    if (p.adapter?.readyAtSpawn) p.phase = "idle";
  }

  private connectSocket(p: ManagedProcess): void {
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
        if (!identity || !status || status.beeId !== p.beeId || status.generation !== p.generation || status.hostPid !== p.pid || status.exited || fd === undefined || !authenticatedProcessPeer(fd, identity) || !this.cfg.runtimeIdentity?.bindLegacy(p.beeId, p.generation, p.pidStartedAt, identity, "authenticated-host-generation")) {
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
      this.cfg.onWriteLaneReady?.();
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
          this.cfg.onWriteLaneReady?.();
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
      p.socketRetry = setTimeout(() => {
        p.socketRetry = null;
        this.connectSocket(p);
      }, p.authFailures ? Math.min(30_000, 200 * 2 ** Math.min(p.authFailures, 8)) * (0.75 + (this.cfg.random ?? Math.random)() * 0.25) : 200);
      p.socketRetry.unref();
    });
  }

  private rejectHostPeer(p: ManagedProcess, socket: Socket): void {
    p.authFailureSince ??= this.now();
    p.authFailures = Math.min(8, (p.authFailures ?? 0) + 1);
    socket.destroy();
    if (p.pendingStartIdentity && p.authFailures >= 3) this.releasePendingStart(p, "peer-or-binding-rejected");
    this.cfg.onWriteLaneReady?.();
  }

  private releasePendingStart(p: ManagedProcess, reason: string): void {
    p.exited = true;
    if (p.socketRetry) clearTimeout(p.socketRetry);
    p.socket?.destroy();
    this.procs.delete(p.beeId);
    this.appendSidecar(p.beeId, `pending start recovery held: bee=${p.beeId} generation=${p.generation} pid=${p.pid} reason=${reason}\n`);
  }

  /** Host-style runtime finished (host exit observed or pid gone): drain the
   * observation tail, fold the host's recorded exit facts, emit exited. */
  private finishHost(p: ManagedProcess): void {
    if (p.exited) return;
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

  deliveryPane(_beeId: string, _generation: number): null { return null; }

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
      p.child?.stdin?.destroyed, p.child?.stdin?.writable,
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

  private deliveryFrameOversized(p: ManagedProcess, messageId: number, line: string): boolean {
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

  private refreshDeliveryProtocol(p: ManagedProcess): void {
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
    if (p.exited || !p.hostStyle || !p.processIdentity || !p.deliveryProtocol?.authenticated || p.socketBroken
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
    // A re-adopted process has no stdin (pipes died with the previous daemon).
    // Refuse deterministically; the daemon's degraded-runtime policy rotates
    // the generation so the mailbox record reaches a fresh runtime.
    if (p.degraded || p.adapter == null) return refused("not_ready");
    // Q2 resolution: a booting runtime refuses; the daemon retries.
    if (p.phase === "booting") return refused("not_ready");
    // A dying (TERM'd) process has no accept point: it might still read stdin
    // but will never work the turn — accepting would mark the mailbox row
    // delivered and doom the message. Refuse; the exit observation follows
    // and the next generation consumes it (delivery doubt cannot exist).
    if (p.stopCause != null) return refused("not_ready");
    // A harness without a mid-turn accept point refuses until idle.
    if (p.phase === "running" && !p.adapter.acceptsMidTurn) {
      return refused("not_ready");
    }
    if (p.adapter.confirmsDelivery) {
      if (p.confirmedDeliveries.delete(messageId)) {
        this.consumed.set(messageId, generation);
        return { accepted: true };
      }
      if (p.pendingDeliveries.has(messageId) && !options?.confirmation) return { accepted: false, reason: "not_ready", ...(options?.singleAttempt ? {pendingConfirmation: true} : {}) };
    }
    if (p.hostStyle && (p.socketBroken || !p.socket || p.socket.destroyed || !p.socket.writable)) {
      // pendingWrites dies with this daemon. Refuse until the runner's socket
      // is connected so the mailbox row remains durable and retries next tick.
      return refused("not_ready");
    }
    if (!p.hostStyle && (!p.child?.stdin || p.child.stdin.destroyed || !p.child.stdin.writable)) {
      // stdin gone means the process is dying; its exit observation follows.
      return refused("no_process");
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
    // Host-style reaches here only with a connected write lane. Node's
    // socket.write(false) means accepted with backpressure, not rejected; the
    // write remains one delivery and must never trigger a duplicate retry.
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
      // The driver owns the turn_started edge: input was injected into an
      // idle runtime (claude emits no explicit turn-start line; adapters that
      // do emit one are deduplicated by phase in onSignal). v9: synthetic —
      // writing to stdin proves nothing about the process; only parsed
      // output is boot evidence for the spawn-failure budget.
      p.phase = "running";
      this.events.push({ beeId, generation, kind: "turn_started", synthetic: true, messageId });
    }
    return p.adapter.confirmsDelivery
      ? { accepted: false, reason: "not_ready", ...(options?.singleAttempt ? {pendingConfirmation: true} : {}) }
      : { accepted: true };
  }

  /** Existing v15+ hosts already support the fixed adapter request and durable reply evidence. */
  reconnectToolsSupport(beeId: string, generation: number): { supported: boolean; reason?: string } {
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { supported: false, reason: "runtime_unavailable" };
    if (!p.adapter?.encodeReconnectTools || !p.adapter?.encodeReconnectToolsNonce) return { supported: false, reason: "unsupported_harness" };
    if (p.degraded || !p.hostStyle || p.legacySharedObservation || !p.observationPath) return { supported: false, reason: "unsupported_runner_host" };
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
    // A durable acknowledgement is sufficient for recovery even before the
    // adopted socket reconnects. Readiness is required only for a new effect.
    if (!p.reconnectReplies.has(reloadId)) ready();
    if (this.reconnecting.has(`${beeId}:${generation}`)) throw new ReconnectToolsControlError("not_ready", "Reconnect already in progress");
    this.reconnecting.add(`${beeId}:${generation}`);
    try {
      // Replies before the committed cursor are recovered on adoption, so a
      // daemon crash after the effect never requires another reload.
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
      // A deferred spawn that never happened: cancel it and report the stop
      // as an immediate exit fact (there is nothing to signal).
      this.pendingStarts.delete(beeId);
      this.events.push({ beeId, generation, kind: "exited", exitCause: cause });
      return { hadProcess: true };
    }
    const p = this.procs.get(beeId);
    if (!p || p.generation !== generation || p.exited) return { hadProcess: false };
    this.captureProcessIdentity(p);
    if (processDisposition(p.processIdentity ?? null, inspectProcess(p.pid)) === "exited") { this.finishHost(p); return {hadProcess: false}; }
    if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) throw new ProcessIdentityUnavailableError();
    if (p.stopCause == null) p.stopCause = cause;
    // Exact identity (spec points 4–5): we signal only the pid we spawned and
    // still hold the un-exited handle for — parenthood guarantees the pid has
    // not been recycled (the child is unreaped until the exit event fires).
    this.signalGroup(p, "SIGTERM");
    if (p.killTimer == null) {
      p.killTimer = setTimeout(() => {
        if (!p.exited) this.signalGroup(p, "SIGKILL");
      }, this.graceMs);
      p.killTimer.unref();
    }
    return { hadProcess: true };
  }

  /**
   * v6 interrupt: hand the harness's in-band "stop the current turn" line to
   * a live, mid-turn runtime's stdin (claude control_request interrupt, codex
   * turn/interrupt, stub {"type":"interrupt"}). The turn_ended that follows
   * is observed like any other; the process stays live. Idle / booting /
   * dying / degraded / no channel: a reasoned no-op, never an error. SIGINT
   * is never used — it kills a headless child outright.
   */
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
    if (p.hostStyle && (p.socketBroken || !p.socket || p.socket.destroyed || !p.socket.writable)) {
      return { interrupted: false, reason: "not_ready" };
    }
    const encoded = p.adapter.encodeInterrupt({ sessionId: p.sessionId, turnId: p.turnId });
    if (encoded == null) return { interrupted: false, reason: "not_ready" };
    if (!p.hostStyle && (!p.child?.stdin || p.child.stdin.destroyed || !p.child.stdin.writable)) {
      return { interrupted: false, reason: "no_process" };
    }
    this.writeLine(p, encoded);
    p.quiet?.invalidate();
    return { interrupted: true };
  }

  observe(): DriverObservation[] {
    this.pumpAll();
    const out = this.events;
    this.events = [];
    return out;
  }

  /**
   * Parse everything new before any drain: host-style runtimes are observed
   * by files (status facts + session-log tail), so observations, flag
   * evidence, and session evidence all materialize HERE — every observe*()
   * surface pumps first, keeping the pipe-era semantics where evidence
   * accumulated without an observe() call.
   */
  private lastPumpAt = 0;

  private pumpAll(): void {
    // The daemon drains all three observe surfaces inside one step(); pumping
    // per surface tripled the per-tick stat/read pass over every runtime
    // (2026-08-21 telemetry: step 200-480ms with a large fleet). One pump per
    // 50ms keeps observation latency under any real tick while making the
    // extra drains free.
    const now = this.now();
    if (now - this.lastPumpAt < 50) return;
    this.lastPumpAt = now;
    for (const p of [...this.procs.values()]) {
      if (!p.hostStyle || p.exited) continue;
      this.pumpHost(p);
    }
    // Adopted (degraded) processes have no exit callback — their death is a
    // fact recovered by polling the exact pid (cheap signal-0 probe).
    this.pollDegraded();
  }

  /** One observation pass over a host-style runtime: status facts, log tail,
   * and (for adopted hosts with no exit callback) pid-liveness. */
  private pumpHost(p: ManagedProcess): void {
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
    // Read the status file only while it can still teach us something: the
    // agent pid / spawnError before the OS confirms the spawn, and the
    // socketError witness until the write lane is proven (connected). After
    // that, exits arrive via the child callback (own spawns) or the pid probe
    // + finishHost's status read (adopted hosts) — no per-tick read needed.
    if (p.statusPath && (p.agentPid == null || (!p.socket && !p.socketBroken))) {
      const status = readRunnerStatus(p.statusPath);
      if (status) {
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
          // The host has progressed since the initial connection failed. Wake
          // its pending retry once, instead of sleeping through the rest of
          // the 200ms backoff. Delivery still requires a connected socket;
          // reconnect failures retain the normal bounded retry cadence.
          if (p.socketRetry) {
            clearTimeout(p.socketRetry);
            p.socketRetry = null;
            this.connectSocket(p);
          }
          if (p.adapter?.readyAtSpawn) {
            // The OS confirmed the AGENT spawn (v9: synthetic, never boot
            // evidence) — the same edge the direct child's `spawn` event was.
            this.events.push({
              beeId: p.beeId,
              generation: p.generation,
              kind: "booted",
              pid: p.pid,
              pidStartedAt: p.pidStartedAt,
              synthetic: true,
            });
            if (p.phase === "idle") {
              // Nothing has been injected yet: the agent sits at its prompt
              // (claude emits no line until the first stdin message). booted
              // alone leaves the store `running` — a turn no output will ever
              // close, since the driver's own phase is idle and drops the
              // late init/result edges. Field finding 2026-09-02: a swap of an
              // idle bee (stop → revive, empty mailbox) showed "working" for
              // hours (CL.60c9, CL.e72f). Mint the "boots straight to ready"
              // turn_ended the adapter would have parsed — synthetic: never
              // boot evidence, never an output fact. A delivery that already
              // opened the turn (phase running) suppresses it: the real
              // result closes that turn.
              this.events.push({
                beeId: p.beeId,
                generation: p.generation,
                kind: "turn_ended",
                synthetic: true,
              });
            }
          }
        }
        if (status.exited && disposition === "exited") {
          this.finishHost(p);
          return;
        }
      }
    }
    if (p.readinessRecovery?.nextProbeAt !== undefined && this.now() >= p.readinessRecovery.nextProbeAt) {
      p.readinessRecovery.nextProbeAt = undefined;
      p.readinessRecovery.started = false;
      this.recoverAdoptedReadiness(p);
    }
    this.pumpHostTail(p);
    // An adopted host has no ChildProcess exit callback; recover its death by
    // polling the exact identity, then fold the recorded exit facts.
    if (p.child == null && disposition === "exited") this.finishHost(p);
  }

  private recoveryAgentIsLive(p: ManagedProcess): boolean {
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

  private refuseReadinessRecovery(p: ManagedProcess): void {
    if (!p.readinessRecovery || p.readinessRecovery.refused) return;
    p.readinessRecovery.refused = true;
    this.appendSidecar(p.beeId, `readiness recovery held bee=${p.beeId} generation=${p.generation} pid=${p.pid}\n`);
  }

  private recoverAdoptedReadiness(p: ManagedProcess): void {
    const recovery = p.readinessRecovery;
    if (!recovery || recovery.started || recovery.refused) return;
    if (!this.recoveryAgentIsLive(p)) { this.refuseReadinessRecovery(p); return; }
    this.pumpHostTail(p);
    if (!p.readinessRecovery || p.phase !== "booting" && !p.executionStart) return;
    recovery.started = true;
    if (p.adapter?.readyAtSpawn) {
      const context = p.observationPath ? recoverAdapterContext(p.adapter, p.observationPath, p.logOffset, p.sessionId) : null;
      this.applyRecoveredReadiness(p, {kind: "ready", sessionId: context?.sessionId ?? p.sessionId ?? "", state: context?.phase ?? "idle", ...(context?.turnId ? {turnId: context.turnId} : {}), synthetic: true});
    } else {
      const line = p.adapter?.recoveryProbe?.(recovery.requestId);
      if (!line || !this.writeLine(p, line, undefined, true)) this.refuseReadinessRecovery(p);
    }
  }

  private applyRecoveredReadiness(p: ManagedProcess, result: ReadinessRecovery): void {
    const recovery = p.readinessRecovery;
    if (!recovery || recovery.refused || !this.recoveryAgentIsLive(p)) { this.refuseReadinessRecovery(p); return; }
    if (result.kind === "refused") { this.refuseReadinessRecovery(p); return; }
    if (result.kind === "query") {
      if (!this.writeLine(p, result.line, undefined, true)) this.refuseReadinessRecovery(p);
      return;
    }
    if (result.kind === "start") {
      if (recovery.bootstrapSent) { recovery.nextProbeAt = this.now() + 1000; return; }
      if (!this.cfg.runtimeIdentity?.claimReadinessRecovery?.(p.beeId, p.generation, p.processIdentity!, recovery.requestId)) { recovery.nextProbeAt = this.now() + 1000; return; }
      recovery.bootstrapSent = true;
      for (const line of result.lines) if (!this.writeLine(p, line, undefined, true)) { this.refuseReadinessRecovery(p); return; }
      return;
    }
    if (result.state === "running") { recovery.nextProbeAt = this.now() + 1000; return; }
    if (p.adapter?.recoveryProbe && !this.cfg.runtimeIdentity?.recordReadinessRecovery?.(p.beeId, p.generation, p.processIdentity!, {requestId: recovery.requestId, threadId: result.sessionId, state: result.state, ...(result.threadCwd !== undefined ? {threadCwd: result.threadCwd} : {}), ...(result.adapterCwd !== undefined ? {adapterCwd: result.adapterCwd} : {})})) { this.refuseReadinessRecovery(p); return; }
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

  /** Read new output-only journal bytes and normalize complete agent lines. */
  private pumpHostTail(p: ManagedProcess): void {
    if (!p.adapter || !p.observationPath) return;
    if (p.adapter.recoveryProbe && !p.deliveryProtocol?.authenticated) return;
    const path = p.observationPath;
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // no log yet
    }
    if (size < p.logOffset) {
      // A generation journal is append-only. Truncation destroys the replay
      // proof; fail closed and let degraded-mail policy rotate this exact live
      // process when work arrives. Never rewind and synthesize lifecycle edges.
      p.degraded = true;
      p.adapter = null;
      p.observationPath = null;
      p.stdoutRest = Buffer.alloc(0);
      this.appendSidecar(p.beeId, `runner observation journal truncated for generation ${p.generation}\n`);
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
      // v15 journals contain runner output only. Legacy adopted hosts tail the
      // shared bidirectional transcript from their adoption EOF and still need
      // exact-match suppression for commands sent by THIS daemon generation.
      if (p.outboundPending.length > 0 && p.outboundPending[0] === line) {
        p.outboundPending.shift();
        continue;
      }
      p.quiet?.pushLine(line, p.sessionId);
      const recovery = p.readinessRecovery;
      const recovered = recovery?.started && !recovery.refused ? p.adapter.parseRecovery?.(line, recovery.requestId, p.sessionId) : null;
      if (recovered) {
        this.applyRecoveredReadiness(p, recovered);
        p.pendingObservationCursor = lineEndCursor;
        continue;
      }
      const signals = p.adapter.parseLine(line);
      const lateBoot = p.phase !== "booting" && signals.some((sig) => sig.kind === "booted");
      for (const signal of signals) {
        if (lateBoot && signal.kind === "turn_ended") continue;
        if (signal.kind === "respond" && p.readinessRecovery && p.adapter.recoveryProbe) continue;
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
    if (p.hostStyle) { this.connectSocket(p); return; }
    this.procs.delete(beeId);
    this.adopt(beeId, generation, p.pid, p.pidStartedAt, p.phase);
  }

  hasProcess(beeId: string, generation: number): boolean {
    const pending = this.pendingStarts.get(beeId);
    if (pending && pending.generation === generation) return true; // spawn in flight
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
  // Beyond the WP2 interface — what the real daemon needs
  // -------------------------------------------------------------------------

  /**
   * Cross-restart re-adoption (contract §3.2, spec 04 boot sequence): claim a
   * surviving process from a previous daemon generation by exact identity.
   * Returns false — never throws — when the pid is gone, unreadable, recycled
   * (start-time mismatch) or the bee already has a live process.
   */
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
    // WP5: a runtime with runner-host artifacts for this exact (pid ==
    // host pid) re-adopts at FULL capability — reconnect the write socket,
    // resume the log tail, keep delivering. The degraded stop-on-mail
    // rotation below remains only for runtimes spawned by a pre-host daemon.
    const paths = this.runnerPaths(beeId, generation);
    const status = readRunnerStatus(paths.status);
    if (execution && (!status || status.hostBirth !== executionHost?.birth || status.executionIntentId !== execution.intentId || status.executionDigest !== canonicalDigest(execution as unknown as JsonValue))) return false;
    if (status && status.hostPid === pid && !status.exited) {
      const hasGenerationIdentity = status.beeId !== undefined || status.generation !== undefined;
      const exactGenerationIdentity = status.beeId === beeId && status.generation === generation;
      if (pendingStart && !exactGenerationIdentity) return false;
      let adapter: HarnessAdapter | null = null;
      try {
        adapter = execution ? this.cfg.resolveExecutionAdapter?.(beeId) ?? null : this.cfg.resolve(beeId).adapter;
      } catch {
        adapter = null; // unresolvable harness: fall through to degraded
      }
      // A v15 host proves its output-only journal belongs to this exact
      // generation. A pre-v15 host has neither identity field: keep the old
      // full-capability EOF behavior for NEW bytes, but do not replay its
      // bidirectional transcript. A mismatched/partial identity is corrupt
      // recovery evidence and falls through to conservative degraded adoption.
      if (adapter && (!hasGenerationIdentity || exactGenerationIdentity)) {
        let observationPath: string | null;
        let observationOffset: number;
        let legacySharedObservation: boolean;
        let recovered: RecoveredAdapterContext = {
          quiet: new TurnQuiet(adapter.harness),
          sessionId: providerSessionId ?? null,
          turnId: null,
          confirmedDeliveries: new Set(),
          reconnectReplies: new Map(),
        };
        if (exactGenerationIdentity) {
          let journalSize: number | null = null;
          try {
            journalSize = statSync(paths.observations).size;
          } catch {
            journalSize = null;
          }
          const cursor = lastAppliedObservationCursor ?? 0;
          const validCursor = Number.isSafeInteger(cursor) && cursor >= 0 && journalSize !== null && cursor <= journalSize;
          if (status.observationError || !validCursor) {
            adapter = null; // fail closed below: never guess an idle edge
            observationPath = null;
            observationOffset = 0;
            legacySharedObservation = false;
          } else {
            observationPath = paths.observations;
            observationOffset = cursor;
            legacySharedObservation = false;
            if (
              recovered.sessionId == null
              || lastKnownState === "running"
              || adapter.confirmsDelivery === true
            ) {
              recovered = recoverAdapterContext(adapter, observationPath, observationOffset, recovered.sessionId);
            }
          }
        } else {
          observationPath = this.sessionLogPath(beeId);
          observationOffset = this.sessionLogSize(beeId);
          legacySharedObservation = true;
        }
        if (!adapter) {
          // The exact process is still adopted below, but without a trustworthy
          // evidence/delivery lane. Pending mail rotates it through the normal
          // degraded-runtime policy; silence never changes its phase.
        } else {
          const proc: ManagedProcess = {
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
            // The store's persisted runtime state is the phase truth at the
            // moment the old daemon stopped (rows-are-truth): an idle runtime
            // adopts with its accept point OPEN. The 2026-08-21 deploy soak
            // showed why the blanket "running" claim was wrong for known-idle
            // bees: it promised a turn_ended that could never come. Without a
            // hint, "running" remains the conservative claim; the next tailed
            // edge corrects it, and elapsed time alone never changes it.
            // Preserve booting too: otherwise pumpHostOutput treats the first
            // completed handshake as late boot and discards its idle edge.
            phase: lastKnownState ?? "running",
            // The durable provider thread is a bee fact. Adapter-local active
            // turn and accepted-request evidence are replayed from the exact
            // generation journal so a daemon deploy cannot strand either a
            // mid-turn steer or an acknowledgement in the crash gap.
            quiet: recovered.quiet,
            sessionId: recovered.sessionId,
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
            hostStyle: true,
            agentPid: typeof status.agentPid === "number" ? status.agentPid : null,
            socket: null,
            socketRetry: null,
            socketPath: paths.socket,
            statusPath: paths.status,
            observationPath,
            // v15 resumes at the core's generation-scoped applied cursor. Legacy
            // hosts have no separated journal, so only their post-adoption bytes
            // are observable; history is never rewound heuristically.
            logOffset: observationOffset,
            initialObservationCursor: observationOffset,
            pendingObservationCursor: null,
            legacySharedObservation,
            outboundPending: [],
            pendingWrites: [],
            socketBroken: false,
          };
          if (!pendingStart && execution && status.agentPid && status.agentBirth) { try { this.acceptExecutionStarted(proc,{pid:status.agentPid,birth:status.agentBirth}); } catch { return false; } }
          this.procs.set(beeId,proc);
          this.connectSocket(proc);
          return true;
        }
      }
    }
    if (execution || pendingStart) return false;
    const receiptHost = status ? status.hostPid === pid && status.beeId === beeId && status.generation === generation && !status.exited
      : (() => { try { return statSync(paths.status).isFile(); } catch { return false; } })();
    this.procs.set(beeId, {
      processIdentity,
      beeId,
      generation,
      pid,
      pidStartedAt,
      child: null,
      adapter: null,
      quiet: null,
      degraded: true,
      // Unknown phase — the event stream died with the old daemon. "running"
      // is the conservative claim. Mail-driven degraded-runtime rotation
      // replaces it when work arrives; silence alone never authorizes a stop.
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
      // Degraded: no event stream, so no evidence can ever be parsed. The
      // store's persisted boot_evidence for the row (from before the daemon
      // restart) governs its exit accounting; this field is driver-local.
      realEvidence: false,
      hostStyle: receiptHost,
      agentPid: null,
      socket: null,
      socketRetry: null,
      socketPath: receiptHost ? paths.socket : null,
      statusPath: receiptHost ? paths.status : null,
      observationPath: null,
      logOffset: 0,
      initialObservationCursor: 0,
      pendingObservationCursor: null,
      legacySharedObservation: false,
      outboundPending: [],
      pendingWrites: [],
      socketBroken: false,
    });
    if (receiptHost) this.connectSocket(this.procs.get(beeId)!);
    return true;
  }

  /** Whether (bee, generation) is a live re-adopted process with no event stream. */
  isDegraded(beeId: string, generation: number): boolean {
    const p = this.procs.get(beeId);
    return p !== undefined && p.generation === generation && p.degraded && !p.exited;
  }

  private pollDegraded(): void {
    for (const p of [...this.procs.values()]) {
      if (!p.degraded || p.exited) continue;
      const disposition = processDisposition(p.processIdentity ?? null, inspectProcess(p.pid));
      if (disposition === "exited") this.onExit(p, null, null);
      else if (disposition === "unavailable") this.cfg.runtimeIdentity?.unavailable?.(p.beeId, p.generation);
    }
  }

  /**
   * Process identity captured at spawn, for core's createBee/reviveBee `proc`
   * (the WP2 amendment). Available immediately after start() returns.
   */
  private captureProcessIdentity(p: ManagedProcess): void {
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

  /** Drain condition-flag evidence (adapters report; the daemon acts). */
  observeEvidence(): FlagEvidence[] {
    this.pumpAll();
    const out = this.evidence;
    this.evidence = [];
    return out;
  }

  /**
   * Drain harness session ids learned from booted signals (including the late
   * init a readyAtSpawn harness emits after its first message). The daemon
   * records them on the bee row (spec 07 §F continuity).
   */
  observeSessions(): SessionEvidence[] {
    this.pumpAll();
    const out = this.sessions;
    this.sessions = [];
    return out;
  }

  /** Drain observed subscription usage (the daemon folds it into account limits). */
  observeUsage(): UsageEvidence[] {
    this.pumpAll();
    const out = this.usage;
    this.usage = [];
    return out;
  }

  /**
   * Drain the latest signal-bearing journal cursor per live generation. The
   * daemon calls this after applying observations/evidence/session ids; if it
   * crashes before the core-store checkpoint, the successor replays from the
   * previous cursor and the idempotent projections settle again.
   */
  observeRecoveryCursors(): ObservationCursorEvidence[] {
    this.pumpAll();
    const out: ObservationCursorEvidence[] = [];
    for (const p of this.procs.values()) {
      if (p.pendingObservationCursor == null) continue;
      out.push({ beeId: p.beeId, generation: p.generation, cursor: p.pendingObservationCursor });
      p.pendingObservationCursor = null;
    }
    return out;
  }

  /** Verbatim native-stream session log path for a bee (Q1; v23: the current transcript segment's file). */
  sessionLogPath(beeId: string): string {
    return stateFile(this.cfg.sessionLogPathFor?.(beeId) ?? join(stateDirectory(this.cfg.sessionLogDir,"sessionLogDir"), `${beeId}.jsonl`), "sessionLogPath");
  }

  /** Output-only recovery journal for exactly one runtime generation. */
  observationLogPath(beeId: string, generation: number): string {
    return this.runnerPaths(beeId, generation).observations;
  }

  // --- DeliveryGroundTruth (invariant checker, spec test tier 3) -----------

  consumedGeneration(messageId: number): number | undefined {
    return this.consumed.get(messageId);
  }

  consumedCount(): number {
    return this.consumed.size;
  }

  liveProcesses(): LiveProcess[] {
    return this.snapshotLive();
  }

  /**
   * Daemon shutdown: release every event-loop reference to the children
   * WITHOUT signaling them — runtimes deliberately survive a daemon stop and
   * the next boot re-adopts them (contract §3.2). The OS closes our pipe ends
   * when the process exits; agents that exit on stdin EOF stop then, agents
   * that survive it stay adoptable.
   */
  detachAll(): void {
    this.detached = true;
    this.pendingStarts.clear();
    for (const p of this.procs.values()) {
      if (p.killTimer) {
        clearTimeout(p.killTimer);
        p.killTimer = null;
      }
      if (p.socketRetry) {
        clearTimeout(p.socketRetry);
        p.socketRetry = null;
      }
      // The write lane belongs to THIS daemon process; the next daemon
      // reconnects its own. Destroying it never touches the agent.
      p.socket?.destroy();
      p.socket = null;
      if (p.executionStart && p.child?.connected) p.child.disconnect();
      p.child?.unref();
      // stdio pipes are net.Socket instances (unref exists at runtime).
      for (const stream of [p.child?.stdin, p.child?.stdout, p.child?.stderr]) {
        (stream as unknown as { unref?: () => void } | null | undefined)?.unref?.();
      }
    }
  }

  /** Test/teardown only: SIGKILL every child group and drop pending events. */
  disposeAll(): void {
    this.pendingStarts.clear();
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

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private writeLine(p: ManagedProcess, line: string, delivery?: TaggedDelivery, confirmationWrite = false): boolean {
    if (Buffer.byteLength(JSON.stringify({ op: "write", line, ...(delivery ? { delivery } : {}) }) + "\n") > DELIVERY_FRAME_MAX_BYTES) return false;
    if (process.env.HIVE_SPAWN_TRACE) {
      appendFileSync(process.env.HIVE_SPAWN_TRACE, JSON.stringify({ write: line.slice(0, 160), at: Date.now(), stack: new Error().stack?.split("\n").slice(2, 6).join(" | ") }) + "\n");
    }
    // Bidirectional JSON-RPC (codex/grok ACP) and claude stream-json user
    // lines live on stdin; the session log is the verbatim native stream in
    // BOTH directions so panes can render the operator's prompt.
    if (p.hostStyle) {
      // The HOST is the transcript's single writer. v15 observation journals
      // are output-only, so outbound suppression is needed only while talking
      // to an adopted legacy host that still tails the shared transcript.
      const outboundLength = p.outboundPending.length;
      try {
        if (p.legacySharedObservation) p.outboundPending.push(line);
        if (p.socket && !p.socket.destroyed && p.socket.writable) {
          // Ignore the boolean result: false reports backpressure after Node
          // accepted the bytes into its write buffer, not a rejected write.
          p.socket.write(`${JSON.stringify({ op: "write", line, ...(delivery ? { delivery } : {}) })}\n`);
          return true;
        } else {
          if (confirmationWrite) return false;
          p.pendingWrites.push(line);
          this.connectSocket(p);
          return false;
        }
      } catch {
        // A write race against a dying host; its exit observation follows.
        p.outboundPending.length = outboundLength;
        return false;
      }
    }
    this.appendSessionLog(p.beeId, line);
    try {
      p.child?.stdin?.write(`${line}\n`);
      return true;
    } catch {
      // A write race against a dying child; its exit observation follows.
      return false;
    }
  }

  private signalGroup(p: ManagedProcess, signal: "SIGTERM" | "SIGKILL"): void {
    if (p.pid <= 0) return;
    this.captureProcessIdentity(p);
    if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) return;
    if (p.degraded) {
      // Adopted pid: parenthood does not protect it from recycling, so the
      // exact identity (pid + start-time) is re-verified immediately before
      // every signal. A failed check means the process is gone; the poll in
      // observe() owns the exit bookkeeping.
      if (!verifyProcessIdentity(p.pid, p.processIdentity ?? null)) return;
      try {
        process.kill(-p.pid, signal);
      } catch {
        try {
          process.kill(p.pid, signal);
        } catch {
          // Already gone.
        }
      }
      return;
    }
    try {
      // Negative pid = the child's own process group (created by detached).
      process.kill(-p.pid, signal);
    } catch {
      try {
        p.child?.kill(signal);
      } catch {
        // Already gone; the exit callback owns the bookkeeping.
      }
    }
  }


  private onSignal(p: ManagedProcess, signal: ReturnType<HarnessAdapter["parseLine"]>[number], sourceId: string, rawLine: string): void | boolean {
    if (
      (signal.kind === "turn_started" || signal.kind === "turn_ended")
      && signal.threadId
      && p.sessionId
      && signal.threadId !== p.sessionId
    ) {
      // codex app-server multiplexes the root thread and native subagent
      // threads onto one stdout stream. Only the provider session learned at
      // boot owns this bee's lifecycle: a child completion must not idle the
      // root, and a child start must not replace the root turn id used by
      // interrupt. Unscoped signals remain valid for older/non-codex adapters.
      return;
    }
    if (!p.realEvidence) {
      p.realEvidence = true;
      // v9: the first ADAPTER-PARSED signal from a process whose phase left
      // "booting" without real output (the readyAtSpawn synthetic path) is
      // the proof the agent actually runs. Push a real `booted` observation
      // so the daemon learns it in stream order — downstream it is a state
      // no-op (the store is already past booting) but it carries the boot
      // evidence that resets the spawn-failure budget. While the phase is
      // still "booting" the signal below drives the real booted itself, and
      // an exit before that stays an ordinary boot failure.
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
        if (signal.sessionId) {
          // Late init still carries it (claude emits system/init only after the
          // first user message); the id is a bee fact whenever it is learned.
          if (p.sessionId !== signal.sessionId) {
            this.sessions.push({ beeId: p.beeId, generation: p.generation, sessionId: signal.sessionId });
          }
          p.sessionId = signal.sessionId;
        }
        if (p.phase !== "booting") return; // duplicate readiness — normalize away
        // booted = "live and working its initial turn" (running). The adapter
        // follows with turn_ended when the harness boots straight to ready.
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
        // The harness-native turn id (codex) is learned even when the driver
        // already opened the turn at deliver() — interrupt needs it.
        if (signal.turnId) p.turnId = signal.turnId;
        if (p.phase !== "idle") return; // driver already opened this turn (deliver)
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

  private turnEvidence(p: ManagedProcess): TurnEvidence {
    const proven = p.turn.observedFromStart && p.adapter?.reportsTurnProgress === true;
    return {
      messageIds: [...p.turn.messageIds],
      progress: p.turn.progressed ? "some" : proven ? "none" : "unknown",
    };
  }

  private onExit(p: ManagedProcess, code: number | null, _signal: NodeJS.Signals | null): void {
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
    this.procs.delete(p.beeId);
    // Cause: a requested stop fixes its cause; otherwise exit code 0 is clean
    // and anything else (non-zero, signal, spawn error) is a crash — death is
    // a fact reported to the parent, never a hypothesis (contract §3.2).
    const cause = p.stopCause ?? (code === 0 ? "clean" : "crashed");
    // F8: when the spawn config already knew the executable resolved nowhere,
    // the exit detail names it — this text reaches the operator through the
    // mirror. The crashed/spawn_failed mechanics themselves are untouched.
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
    // A start deferred behind this death can now actually spawn.
    const pending = this.pendingStarts.get(p.beeId);
    if (pending) {
      this.pendingStarts.delete(p.beeId);
      if (pending.execution) { try { this.start(p.beeId,pending.generation,pending.execution); } catch { this.appendSidecar(p.beeId,"deferred execution start held; reconcile original binding\n"); } }
      else this.start(p.beeId, pending.generation);
    }
  }

  private appendSessionLog(beeId: string, line: string): void {
    appendFileSync(this.sessionLogPath(beeId), `${line}\n`);
  }

  private appendSidecar(beeId: string, text: string): void {
    try {
      appendFileSync(join(this.cfg.sessionLogDir, `${beeId}.stderr.log`), text);
    } catch {
      // Diagnostics only; never let stderr plumbing break the driver.
    }
  }
}
