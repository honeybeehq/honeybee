import { automationDeliveryClass } from "../../core/src/types.ts";
import { renderMailBatch } from "./mailBatch.ts";
import type { QuotaBoundary } from "../../core/src/quota.ts";
import { deliveryConfirmationIntentFits } from "../../core/src/deliveryConfirmationTypes.ts";
import {ProcessIdentityUnavailableError} from "../../driver-hsr/src/psutil.ts";
import { ExecutionFenceError } from "../../core/src/executionFence.ts";
import type { ReconnectToolsReceipt } from "../../core/src/reconnectTools.ts";
/**
 * DaemonCore — the daemon's loop cores (WP4 of the reset), extracted from the
 * WP2 SimDaemon so one implementation serves both worlds:
 *
 *  - the invariant harness (`v2:harness`, `v2:harness:real`) drives this exact
 *    code under a virtual clock / fault injector via the SimDaemon wrapper
 *    (v2/harness/src/daemon.ts), so every WP2 invariant keeps proving the
 *    production loops;
 *  - the real daemon (daemon.ts) drives it over wall time with the RuntimeHost.
 *
 * Responsibilities per step (spec 04 "Daemon behavior" 1, 3, 4, 5):
 *  1. drain driver observations into the store's four-state model
 *  2. flag policy: apply adapter condition-flag evidence (contrary-evidence
 *     clearing per spec 03 — every setter has a clearer); and record the
 *     harness session id a runtime reported (spec 07 §F: revive resumes it)
 *  3. boot-hang policy: stop runtimes that never produce the bounded boot
 *     readiness handshake. Running turns are unbounded: silence and elapsed
 *     time are not failure evidence.
 *  4. scale-to-zero: stop(stopped_by_system) idle runtimes past the idle
 *     window (Q4 ruling; revive-on-message undoes it)
 *  5. degraded-runtime policy: a re-adopted runtime has no event stream or
 *     stdin (pipes died with the previous daemon process); when mail arrives
 *     for one, stop it so revive-on-message hands the mailbox to a fresh
 *     generation — delivery stays bounded, I1 holds
 *  6. execute queued commands (claim → effect via driver → settle,
 *     generation-fenced, idempotent). Revive-on-message is bounded by the
 *     store's spawn-failure budget: a runtime that exits during boot counts
 *     against the BEE (not the wake command), the next wake sits on the B5
 *     backoff table, and at the budget `spawn_failed` is set and wakes stop —
 *     an explicit `revive` resets the budget and retries regardless
 *  7. delivery loop: push undelivered mailbox messages into live runtimes,
 *     honoring per-message urgency (v8, spec 01 Q2 amendment): `next` = the
 *     accept point (unchanged), `idle` = hold while the runtime is running,
 *     `now` = interrupt the turn first, then deliver. Urgency governs
 *     eligibility only; among eligible messages FIFO enqueue order wins
 *  8. I1 telemetry: record undelivered-past-deadline messages as structured
 *     violations (spec 04 behavior 5 — the 99.99% counter). An `idle`
 *     message's clock starts at eligibility (runtime left `running`), not at
 *     enqueue — long turns are not false violations
 *
 * Boot sequence (after every store reopen): reconcileAtBoot with the driver's
 * live pids, reap orphan processes the store no longer recognizes, and sweep
 * the mailbox for bees that need a send_wake. Crash anywhere is safe: the
 * mailbox and command queue are durable, and every effect is idempotent.
 */
import {
  CoreError,
  MULTILINE_UNSUPPORTED_DETAILS,
  RUNTIME_TRANSITIONS,
  actionIsActive,
  actionNudgeDueAt,
  actionPredecessor,
  buildExtractiveHandoffContext,
  handoffFencesSource,
  placementContextText,
  prefixPlacementDelivery,
  type ActionRow,
  type BeeHandoffRow,
  type BeeMoveRow,
  type BeeRow,
  type CommandRow,
  type CoreStore,
  type DaemonStepInputs,
  type DaemonWorkRow,
  type DeliveryConfirmationIntent,
  type DeliveryConfirmationReason,
  type HandoffContext,
  type HandoffContextTurn,
  type I1PendingBee,
  type MessageRow,
  type RuntimeState,
  type StoreChange,
  type TranscriptSegmentRow,
  type TurnTriggerSource,
} from "../../core/src/index.ts";
import { DeadlineHeap } from "./deadlines.ts";
import type { CaptureReport } from "../../driver-cell/src/index.ts";
import { deliveryText, isPeerSender, turnTriggerSource } from "./envelope.ts";
import { MultilineFallback, type MultilineFallbackOptions } from "./multilineFallback.ts";
import {
  NOOP_PERFORMANCE,
  type PerformanceRecorder,
} from "./performance.ts";
import { SANDBOX_TMP_FULL, type DeliveryConfirmationPlan, type DriverObservation, type RuntimeDriver, type StopCause } from "../../harness/src/driver.ts";

/** Where the (injected) executor-crash fault hits, if it does. */
export type ExecutorCrashPoint = "none" | "before_effect" | "after_effect";

export interface DaemonPolicy {
  /** Stop a runtime stuck in `booting` longer than this many steps (ms for the real daemon). */
  bootHangTimeoutSteps: number;
  /** Max commands executed per step (executor loop budget). */
  commandsPerStep: number;
  /**
   * Scale-to-zero (spec 04 behavior 3): stop(stopped_by_system) an idle
   * runtime after this window. Omitted/null = disabled (the harness default —
   * the sim proves the loops; the timer is daemon policy).
   */
  idleWindowSteps?: number | null;
  /**
   * I1 telemetry (spec 04 behavior 5): per pending mailbox position, the
   * delivery deadline in steps/ms. Omitted/null = telemetry off. The real
   * daemon computes this policy-aware (≥ boot timeout + boot + ordinary-turn
   * allowances). A breach is telemetry, never permission to stop a running
   * turn.
   */
  i1DeadlineSteps?: number | null;
  humanFirstWaitMs?: number;
}

/** Injected fault hooks (the harness's FaultInjector; absent in production). */
export interface FaultHooks {
  executorCrash(): ExecutorCrashPoint;
  driverTimeout(): boolean;
}

/**
 * Thrown when the fault injector kills the executor mid-command. The claimed
 * command row stays `running`; boot replay (B5) requeues and re-executes it.
 */
export class ExecutorCrashError extends Error {
  readonly point: ExecutorCrashPoint;

  constructor(point: ExecutorCrashPoint) {
    super(`executor crash (${point})`);
    this.name = "ExecutorCrashError";
    this.point = point;
  }
}

export interface BootReport {
  adopted: number;
  stoppedByReconcile: number;
  requeuedCommands: number;
  orphansReaped: number;
  wakesEnqueued: number;
}

/** Condition-flag evidence, structurally matching RuntimeHost's FlagEvidence. */
export interface FlagEvidenceLike {
  beeId: string;
  generation: number;
  flag: "auth_needed" | "resource_blocked" | "spawn_failed";
  action: "set" | "clear";
  detail: string;
  /** Provider-declared instant (epoch ms) the condition lifts, when stated. */
  resetsAt?: number;
  /** The turn a `set` cut off: the mail delivered into it and whether the provider served any of it. */
  turn?: { messageIds: number[]; progress: "none" | "some" | "unknown" };
  owner?: "sandbox_tmp";
  quota?: QuotaBoundary;
  eventId?: string;
  sourceId?: string;
}

/** Observed subscription usage, structurally matching RuntimeHost's UsageEvidence. */
export interface UsageEvidenceLike {
  beeId: string;
  generation: number;
  observedAt: number;
  usage?: Record<string, unknown>;
  quota?: Record<string, unknown>;
}

/** Harness session identity, structurally matching RuntimeHost's SessionEvidence. */
export interface SessionEvidenceLike {
  beeId: string;
  generation: number;
  sessionId: string;
}

/** Applied cursor candidate from a generation-scoped runner observation journal. */
export interface ObservationCursorEvidenceLike {
  beeId: string;
  generation: number;
  cursor: number;
}

/**
 * Optional driver capabilities beyond the WP2 RuntimeDriver contract. All are
 * duck-typed: the SimDriver has none of them and the loops stay byte-for-byte
 * compatible with the WP2 harness behavior when they are absent.
 */
interface ExtendedDriver {
  /** Drain adapter flag evidence (RuntimeHost.observeEvidence). */
  observeEvidence?(): FlagEvidenceLike[];
  /** Process identity captured at spawn (RuntimeHost.procOf) — the WP2 pid-at-spawn amendment. */
  procOf?(
    beeId: string,
    generation: number,
  ): { pid: number; pidStartedAt: number; observationCursor?: number; processIdentity?: import("../../core/src/runtimeProcessIdentity.ts").RuntimeProcessIdentity } | null;
  /** Whether (bee, generation) is a re-adopted degraded process (no event stream). */
  isDegraded?(beeId: string, generation: number): boolean;
  /** Drain harness session ids learned from booted signals (RuntimeHost.observeSessions). */
  observeSessions?(): SessionEvidenceLike[];
  /** Drain subscription usage runtimes observed (RuntimeHost.observeUsage). */
  observeUsage?(): UsageEvidenceLike[];
  /** Drain runner-journal cursors only after all earlier normalized effects commit. */
  observeRecoveryCursors?(): ObservationCursorEvidenceLike[];
}

/** One I1 deadline breach, shaped like the harness violation ledger. */
export interface I1ViolationEvent {
  detectedAt: number;
  beeId: string;
  messageId: number;
  enqueuedAt: number;
  deadline: number;
  detail: string;
}

export interface DaemonCoreOptions {
  multilineFallback?: MultilineFallbackOptions;
  store: CoreStore;
  driver: RuntimeDriver;
  policy: DaemonPolicy;
  now: () => number;
  random?: () => number;
  log: (op: string) => void;
  faults?: FaultHooks;
  /** Recorder for I1 deadline breaches (the real daemon's i1_violations table). */
  onI1Violation?: (violation: I1ViolationEvent) => void;
  /** Q1 (spec 01): delete removes the session log file; core does no file I/O, the daemon does. */
  removeSessionLog?: (path: string) => void;
  removeThreadArtifacts?: (operationId: string) => void;
  removeBeeTmp?: (beeId: string) => void;
  /**
   * v7 (spec 08): account policy hook — called AFTER each flag evidence is
   * applied to the store, so the daemon can enact the account-level rules
   * (auth_needed ↔ accounts.status; rate-limit resource_blocked → exhaustion
   * evidence + automatic rotation). Absent in the harness (no accounts).
   */
  onFlagEvidence?: (ev: FlagEvidenceLike) => void;
  beforeTurn?: (beeId: string, generation: number) => boolean;
  /**
   * Account limits hook for observed subscription usage (Muse usage/changed,
   * quota details). Runs inside the observation fold; absent in the harness.
   */
  onUsageEvidence?: (ev: UsageEvidenceLike) => void;
  /** Optional process-local timing recorder. It never writes durable core state. */
  performance?: PerformanceRecorder;
  /**
   * Exact source absence for Cell move placement: in-memory hasProcess is not
   * enough after a daemon restart (stopped row may still hold an unreaped pid).
   */
  sourceProcessAbsent?: (beeId: string, generation: number) => boolean;
  /** Filesystem Claude carry; throws to fail the move without a SQLite placement. */
  relocateSession?: (move: BeeMoveRow, bee: BeeRow) => "copied" | "present" | "none";
  /** Revalidate dest exists/identity/HEAD after source stop, before FS copy/placement. */
  validatePlacement?: (move: BeeMoveRow, bee: BeeRow) => void;
  /**
   * Process-local readiness gate, refreshed before every claim. All commands
   * for a blocked bee wait so later same-bee intent cannot overtake its start;
   * unrelated bees continue through the executor.
   */
  blockedRuntimeStartBeeIds?: () => ReadonlySet<string>;
  onIdentityUnresolved?: (beeId: string, generation: number) => void;
  onTranscriptQuiet?: (beeId: string, generation: number, reason: "turn_ended" | "exited") => void;
  onSpawnFailure?: (beeId: string, generation: number, flagged: boolean) => void;
  /** Throws at the start boundary to use the normal bounded command retry path. */
  assertRuntimeStartReady?: (command: CommandRow) => void;
  /**
   * v23 handoff: a bounded read of the SOURCE transcript (rendered with the
   * source harness) for the extractive context builder. Runs after the source
   * is quiesced, never on the RPC path. Absent (the harness sim): the context
   * is built from durable store facts alone.
   */
  readHandoffTranscript?: (bee: BeeRow, segments: TranscriptSegmentRow[]) => { turns: HandoffContextTurn[]; truncated: boolean };
  /**
   * v23 handoff: optional refinement of the extractive context (an LLM-backed
   * summarizer). Async; the handoff stays `summarizing` until it settles, and
   * a rejection fails the handoff at stage `context` (source recoverable).
   */
  summarizeHandoff?: (input: { handoff: BeeHandoffRow; bee: BeeRow; base: HandoffContext }) => Promise<HandoffContext>;
  /**
   * v24 actions: the Cell landing owner behind `land` actions (the daemon
   * composes it over CellService + the cells registry). Absent: `land` actions
   * wait with reason `executor` instead of pretending to run.
   */
  cellCaptureExecutor?: CellCaptureExecutor;
  reconnectTools?: (command: CommandRow) => Promise<ReconnectToolsReceipt>;
}

/** v24: what the action scheduler needs from the Cell landing owner. Read-only except `capture`. */
export interface CellCaptureExecutor {
  /** Current Cell facts for the bee, or null when it has no active provisioned Cell. */
  inspect(beeId: string): { cellId: string; originRepo: string; spaceDir: string; head: string | null; busy: boolean } | null;
  /** The real landing (driver-cell captureWork): refusals/conflicts are REPORTS, not throws. */
  capture(beeId: string, opts: { targetBranch: string; mode: "merge" | "rebase"; opId: string }): CaptureReport;
  /** Read-only recovery probe: does the origin's target branch already contain `cellHead`? */
  landed(beeId: string, opts: { targetBranch: string; cellHead: string }): { landed: boolean; targetTip: string | null } | null;
}

const LIVE: readonly RuntimeState[] = ["booting", "running", "idle"];

/** Dedup sweep cadence: at most one bounded pass per this many committed ticks. */
const DEDUP_SWEEP_CADENCE_TICKS = 256;
/** Dedup sweep growth trigger: combined-set growth since the last sweep. */
const DEDUP_SWEEP_GROWTH = 1024;
/** Membership-probe chunk bound for the I1-disabled sweep basis. */
const DEDUP_PROBE_CHUNK = 512;

const FLAGS_KEY = "core:flags";
const COMMANDS_KEY = "core:commands";
const BEE_KEY_PREFIX = "b:";
const NAMED_KEY_PREFIX = "k:";
/**
 * A head message held because the bee's detached host fails host auth waits
 * for the driver's lane to recover. Nothing in the store changes when it does,
 * so the bee is re-checked on this cadence instead of on every step.
 */
const HOST_AUTH_RECHECK_MS = 1_000;
const HELD_CONFIRMATION_POLL_MS = 30_000;

function neverWrittenAuthHold(intent: DeliveryConfirmationIntent | null, generation: number): boolean {
  return intent !== null && intent.wireLine === null && intent.state === "held" && intent.reason === "host_auth_failed" && intent.generation === generation;
}

function refusedHold(intent: DeliveryConfirmationIntent | null): boolean {
  return intent !== null && intent.wireLine !== null && intent.state === "held" && intent.reason === "refused";
}

function plainWrite(intent: DeliveryConfirmationIntent): boolean {
  return intent.wireLine !== null && !intent.settlement?.mailBatchId && !intent.settlement?.multilineFallbackId;
}

function refusedPlainWrite(intent: DeliveryConfirmationIntent): boolean {
  return refusedHold(intent) && plainWrite(intent);
}

type HoldProof = "accepted" | "refused" | "none";
type HoldLane = "live" | "ended";
type HoldSettlement = "deliver" | "release" | "recycle" | "keep";
const HOLD_SETTLEMENTS: Readonly<Record<HoldProof, Record<HoldLane, HoldSettlement>>> = {
  accepted: { live: "deliver", ended: "deliver" },
  refused: { live: "recycle", ended: "release" },
  none: { live: "keep", ended: "keep" },
};

type AcceptPoint = "open" | "interrupting";
type AcceptPointEvent = "interrupt_accepted" | "turn_ended" | "exited";
const ACCEPT_POINT_TRANSITIONS: Readonly<Record<AcceptPoint, Partial<Record<AcceptPointEvent, AcceptPoint>>>> = {
  open: { interrupt_accepted: "interrupting" },
  interrupting: { turn_ended: "open", exited: "open" },
};
const QUIET_GLOBAL_CHANGE_PREFIXES = ["account", "rpc.", "cell.retention.", "cell.pressure.", "cell.parked", "cell_op.", "node.capacity", "login_flow.", "template.", "selection_cursor.", "legacy_birth_bound", "auth_interruption.pruned", "champion"];

type StepSnapshot =
  | DaemonStepInputs
  | {
    readonly work: readonly DaemonWorkRow[];
    readonly i1: null;
  };

export class DaemonCore {
  private readonly multilineFallback: MultilineFallback | null;
  protected readonly store: CoreStore;
  protected readonly driver: RuntimeDriver;
  protected readonly policy: DaemonPolicy;
  protected readonly now: () => number;
  private readonly random: () => number;
  protected readonly log: (op: string) => void;
  private readonly faults: FaultHooks | null;
  private readonly onI1Violation: ((violation: I1ViolationEvent) => void) | null;
  private readonly removeThreadArtifacts: ((operationId: string) => void) | null;
  private readonly removeSessionLog: ((path: string) => void) | null;
  private readonly removeBeeTmp: ((beeId: string) => void) | null;
  private readonly onFlagEvidence: ((ev: FlagEvidenceLike) => void) | null;
  private readonly beforeTurn: ((beeId: string, generation: number) => boolean) | null;
  private readonly onUsageEvidence: ((ev: UsageEvidenceLike) => void) | null;
  private readonly performance: PerformanceRecorder;
  private readonly sourceProcessAbsent: (beeId: string, generation: number) => boolean;
  private readonly relocateSession: ((move: BeeMoveRow, bee: BeeRow) => "copied" | "present" | "none") | null;
  private readonly validatePlacement: ((move: BeeMoveRow, bee: BeeRow) => void) | null;
  private readonly blockedRuntimeStartBeeIds: () => ReadonlySet<string>;
  private readonly onIdentityUnresolved: (beeId: string, generation: number) => void;
  private readonly onTranscriptQuiet: (beeId: string, generation: number, reason: "turn_ended" | "exited") => void;
  private readonly onSpawnFailure: (beeId: string, generation: number, flagged: boolean) => void;
  private readonly assertRuntimeStartReady: (command: CommandRow) => void;
  private readonly readHandoffTranscript: ((bee: BeeRow, segments: TranscriptSegmentRow[]) => { turns: HandoffContextTurn[]; truncated: boolean }) | null;
  private readonly summarizeHandoff: ((input: { handoff: BeeHandoffRow; bee: BeeRow; base: HandoffContext }) => Promise<HandoffContext>) | null;
  private readonly cellCapture: CellCaptureExecutor | null;
  private readonly reconnectTools: DaemonCoreOptions["reconnectTools"];
  private reconnectOwnerClosed = false;
  /** Handoffs whose async summarizer is in flight (process-local; a restart simply re-runs it). */
  private readonly summarizing = new Set<string>();
  /** In-memory dedup so a breach is reported once per daemon lifetime; the recorder dedups durably. */
  private readonly reportedI1 = new Set<number>();
  /** Committed ticks since the last dedup sweep (or clear). */
  private readonly unresolvedIdentity = new Map<string, number>();
  retainProcessIdentity(beeId: string, generation: number): void { this.unresolvedIdentity.set(beeId, generation); this.wakeBee(beeId); }
  resolveProcessIdentity(beeId: string, generation: number): void { if (this.unresolvedIdentity.get(beeId) === generation) this.unresolvedIdentity.delete(beeId); this.wakeBee(beeId); }
  private sweepTicks = 0;
  /** Combined dedup-set size recorded by the last sweep — growth trigger baseline. */
  private sizeAtLastSweep = 0;
  private readonly dirtyBees = new Set<string>();
  private dirtyAll = true;
  private commandsDue = true;
  private flagsDue = true;
  private readonly hot = new Set<string>();
  private multilineCleanupPending = true;
  private readonly deadlines = new DeadlineHeap();
  private readonly dueNamed = new Set<string>();
  private readonly movingBees = new Set<string>();
  private readonly handingOffBees = new Set<string>();
  private readonly actionBees = new Set<string>();
  private readonly confirmingBees = new Set<string>();
  private readonly supplyBees = new Set<string>();
  private readonly batchingBees = new Set<string>();
  private readonly humanFirstBees = new Set<string>();

  constructor(opts: DaemonCoreOptions) {
    this.store = opts.store;
    this.driver = opts.driver;
    this.multilineFallback = opts.multilineFallback ? new MultilineFallback(opts.store, opts.driver, opts.multilineFallback) : null;
    this.policy = opts.policy;
    this.now = opts.now;
    this.random = opts.random ?? Math.random;
    this.log = opts.log;
    this.faults = opts.faults ?? null;
    this.onI1Violation = opts.onI1Violation ?? null;
    this.removeSessionLog = opts.removeSessionLog ?? null;
    this.removeThreadArtifacts = opts.removeThreadArtifacts ?? null;
    this.removeBeeTmp = opts.removeBeeTmp ?? null;
    this.onFlagEvidence = opts.onFlagEvidence ?? null;
    this.beforeTurn = opts.beforeTurn ?? null;
    this.onUsageEvidence = opts.onUsageEvidence ?? null;
    this.performance = opts.performance ?? NOOP_PERFORMANCE;
    this.sourceProcessAbsent = opts.sourceProcessAbsent ?? ((beeId, generation) => !this.driver.hasProcess(beeId, generation));
    this.relocateSession = opts.relocateSession ?? null;
    this.validatePlacement = opts.validatePlacement ?? null;
    this.blockedRuntimeStartBeeIds = opts.blockedRuntimeStartBeeIds ?? (() => new Set());
    this.onIdentityUnresolved = opts.onIdentityUnresolved ?? (() => undefined);
    this.onTranscriptQuiet = opts.onTranscriptQuiet ?? (() => undefined);
    this.onSpawnFailure = opts.onSpawnFailure ?? (() => undefined);
    this.assertRuntimeStartReady = opts.assertRuntimeStartReady ?? (() => undefined);
    this.readHandoffTranscript = opts.readHandoffTranscript ?? null;
    this.summarizeHandoff = opts.summarizeHandoff ?? null;
    this.cellCapture = opts.cellCaptureExecutor ?? null;
    this.reconnectTools = opts.reconnectTools;
    this.store.onChange(change => this.noteChange(change));
  }

  private noteChange(change: StoreChange): void {
    if (change.beeId !== null) {
      this.dirtyBees.add(change.beeId);
      const kind = change.kind;
      if (kind.startsWith("command.")) this.commandsDue = true;
      else if (kind.startsWith("flag.")) this.flagsDue = true;
      else if (kind.startsWith("bee.move") || kind === "bee.placement") this.movingBees.add(change.beeId);
      else if (kind.startsWith("bee.handoff")) this.handingOffBees.add(change.beeId);
      else if (kind.startsWith("action")) this.actionBees.add(change.beeId);
      else if (kind.startsWith("mail.confirmation_")) this.confirmingBees.add(change.beeId);
      else if (kind.startsWith("task_supply.")) this.supplyBees.add(change.beeId);
      else if (kind.startsWith("mail.batching.")) this.batchingBees.add(change.beeId);
      else if (kind.startsWith("mail.human_first.")) this.humanFirstBees.add(change.beeId);
      return;
    }
    if (QUIET_GLOBAL_CHANGE_PREFIXES.some(prefix => change.kind.startsWith(prefix))) return;
    this.commandsDue = true;
    this.dirtyAll = true;
  }

  schedule(key: string, at: number): void {
    this.deadlines.schedule(`${NAMED_KEY_PREFIX}${key}`, at);
  }

  takeDue(key: string): boolean {
    return this.dueNamed.delete(`${NAMED_KEY_PREFIX}${key}`);
  }

  wakeBee(beeId: string): void {
    this.dirtyBees.add(beeId);
    this.commandsDue = true;
  }

  private scheduleBee(beeId: string, at: number): void {
    this.deadlines.schedule(`${BEE_KEY_PREFIX}${beeId}`, at);
  }

  private takeDueDeadlines(now: number): Set<string> {
    const bees = new Set<string>();
    for (const key of this.deadlines.popDue(now)) {
      if (key.startsWith(BEE_KEY_PREFIX)) bees.add(key.slice(BEE_KEY_PREFIX.length));
      else if (key === FLAGS_KEY) this.flagsDue = true;
      else if (key === COMMANDS_KEY) this.commandsDue = true;
      else this.dueNamed.add(key);
    }
    return bees;
  }

  /** Late asynchronous replies belong to the successor after shutdown. */
  detachReconnectOwner(): void { this.reconnectOwnerClosed = true; }

  private get ext(): ExtendedDriver {
    return this.driver as ExtendedDriver;
  }

  /** Boot: reconcile, reap orphans, sweep the mailbox for needed wakes (spec 04 behavior 2). */
  boot(unresolved: ReadonlyArray<{beeId: string; generation: number}> = []): BootReport {
    for (const row of unresolved) this.unresolvedIdentity.set(row.beeId, row.generation);
    this.store.recoverInFlightMultilineFallbacks();
    const live = this.driver.snapshotLive();
    const rec = this.store.reconcileAtBoot(
      live.map((p) => ({ pid: p.pid, startedAt: p.pidStartedAt })), unresolved,
    );
    for (const proc of live) {
      if (!this.driver.adoptedDeliveryUncertain?.(proc.beeId, proc.generation)) continue;
      const runtime = this.store.currentRuntime(proc.beeId);
      if (runtime?.generation !== proc.generation || runtime.state === "stopped") continue;
      for (const messageId of this.store.legacyUnconfirmedMessageIds(proc.beeId, proc.generation)) {
        this.store.prepareUnknownDeliveryConfirmationIntent({ beeId: proc.beeId, generation: proc.generation, messageId });
      }
    }
    for (const proc of live) {
      const runtime = this.store.currentRuntime(proc.beeId);
      if (runtime?.generation === proc.generation && runtime.state === "running" && this.store.interruptAwaitsTurnEnd(proc.beeId, proc.generation, runtime.updatedAt)) this.interruptAccepted(proc.beeId, proc.generation);
    }
    let orphansReaped = 0;
    for (const p of live) {
      const bee = this.store.getBee(p.beeId);
      const rt = bee ? this.store.currentRuntime(p.beeId) : null;
      const adopted = rt != null && rt.generation === p.generation && rt.state !== "stopped";
      if (!adopted) {
        // The store no longer recognizes this process (e.g. it was still booting
        // when the daemon died — no pid recorded — and reconcile stopped the row).
        this.driver.stop(p.beeId, p.generation, "stopped_by_system");
        orphansReaped += 1;
        this.log(`boot.reap bee=${p.beeId} gen=${p.generation}`);
      }
    }
    // v24: a capture that was running when the daemon died has an unknown
    // outcome; hold it as uncertain and let the scheduler reconcile it.
    const uncertain = this.store.markInFlightCaptureActionsUncertain("daemon restarted while the capture was in flight; reconciling with the Cell owner");
    for (const id of uncertain) this.log(`action.boot_uncertain action=${id}`);
    let wakesEnqueued = 0;
    for (const bee of this.store.listBees()) {
      if (this.ensureWake(bee.id)) wakesEnqueued += 1;
      // A settled stop can outlive the driver that would have reported its
      // exit. Reconciliation supplies the stopped fact; honor its durable
      // restart intent even when no mailbox message needs a wake.
      const rt = this.store.currentRuntime(bee.id);
      if (rt?.state === "stopped") this.reviveAfterStopIfRequested(bee.id, rt.generation);
    }
    const report: BootReport = {
      adopted: rec.adopted.length,
      stoppedByReconcile: rec.stopped.length,
      requeuedCommands: rec.requeuedCommandIds.length,
      orphansReaped,
      wakesEnqueued,
    };
    this.log(
      `boot adopted=${report.adopted} stopped=${report.stoppedByReconcile} requeued=${report.requeuedCommands} reaped=${orphansReaped} wakes=${wakesEnqueued}`,
    );
    return report;
  }

  /** One step of daemon work. May throw ExecutorCrashError (fault injection). */
  step(): void {
    this.performance.measureSync("core.step.total", () => this.stepPhases());
  }

  private stepPhases(): void {
    this.performance.measureSync("core.step.observe", () => this.observe());
    const now = this.now();
    const dueBees = this.takeDueDeadlines(now);
    const all = this.dirtyAll;
    const scope = all ? null : new Set([...this.dirtyBees, ...this.hot, ...dueBees]);
    this.dirtyAll = false;
    this.dirtyBees.clear();
    this.hot.clear();
    if (all || this.flagsDue) {
      this.flagsDue = false;
      this.performance.measureSync("core.step.flags", () => this.expireFlags());
      const resetAt = this.store.nextFlagResetAt();
      if (resetAt !== null) this.deadlines.schedule(FLAGS_KEY, resetAt);
    }
    this.reconcileDeliveryConfirmations(scope);
    let seq = this.store.lastAuditSeq();
    let snapshot = this.performance.measureSync("core.step.snapshot", () =>
      this.stepSnapshot(scope),
    );
    this.performance.measureSync("core.step.policies", () => {
      this.bootHangPolicy(snapshot.work);
      this.scaleToZeroPolicy(snapshot.work);
      this.degradedMailPolicy(snapshot.work);
    });
    this.releaseBatchingWakes(scope);
    if (all || this.commandsDue) {
      this.commandsDue = false;
      this.performance.measureSync("core.step.commands", () => this.executeCommands());
      const attemptAt = this.store.nextCommandAttemptAt();
      if (attemptAt !== null) {
        if (attemptAt <= this.now()) this.commandsDue = true;
        else this.deadlines.schedule(COMMANDS_KEY, attemptAt);
      }
    }
    const widened = scope === null ? null : new Set([...scope, ...this.dirtyBees]);
    this.performance.measureSync("core.step.moves", () => this.reconcileMoves(widened));
    this.performance.measureSync("core.step.handoffs", () => this.reconcileHandoffs(widened));
    this.performance.measureSync("core.step.actions", () => this.reconcileActions(widened));
    ({ snapshot, seq } = this.performance.measureSync("core.step.snapshot", () =>
      this.refreshSnapshot(snapshot, seq, widened),
    ));
    this.performance.measureSync("core.step.delivery", () =>
      this.deliveryLoop(snapshot.work, widened),
    );
    this.performance.measureSync("core.step.tasks", () => this.taskSupplyLoop(widened));
    // This step's freshest committed I1 metadata, held ONLY for the duration
    // of this step as the sweep's membership basis; never cached across ticks.
    let latestI1: readonly I1PendingBee[] | null = null;
    if (this.i1Enabled()) {
      const i1Snapshot = this.performance.measureSync("core.step.snapshot", () =>
        this.finalI1Snapshot(snapshot, seq, widened),
      );
      latestI1 = i1Snapshot;
      this.performance.measureSync("core.step.i1", () =>
        this.i1Telemetry(i1Snapshot, widened),
      );
    }
    this.performance.measureSync("core.step.prune", () => this.pruneDeliveryDedup(latestI1));
  }

  private tracked(scope: ReadonlySet<string> | null, set: Set<string>, all: () => Iterable<string>, still: (beeId: string) => boolean): string[] {
    if (scope === null) {
      set.clear();
      for (const beeId of all()) set.add(beeId);
      return [...set];
    }
    const bees: string[] = [];
    for (const beeId of scope) {
      if (!set.has(beeId)) continue;
      if (still(beeId)) bees.push(beeId);
      else set.delete(beeId);
    }
    return bees;
  }

  private releaseBatchingWakes(scope: ReadonlySet<string> | null): void {
    const bees = this.tracked(scope, this.batchingBees,
      () => this.store.listMailBatchingPolicies().filter(policy => policy.enabled).map(policy => policy.beeId),
      beeId => this.store.mailBatchingPolicy(beeId).enabled);
    if (bees.length === 0) return;
    this.store.transact(() => {
      for (const beeId of bees) this.store.enqueueWake(beeId);
    });
    for (const beeId of bees) {
      const at = this.store.mailBatchingWakeDueAt(beeId);
      if (at !== null) this.scheduleBee(beeId, at);
    }
  }

  /** Fold pending driver facts before an RPC makes a working-state decision. */
  observe(): void {
    // One crash-consistent observation fold. The journal cursor is written
    // last inside the SAME SQLite transaction as lifecycle, flag, session,
    // and last-output projections. A daemon death therefore leaves either
    // all effects plus the cursor, or neither; there is no durable
    // "completion applied, cursor stale" ambiguity to replay.
    const observations = this.driver.observe();
    const sessions = typeof this.ext.observeSessions === "function" ? this.ext.observeSessions() : [];
    const evidence = typeof this.ext.observeEvidence === "function" ? this.ext.observeEvidence() : [];
    const usage = typeof this.ext.observeUsage === "function" ? this.ext.observeUsage() : [];
    const cursors = typeof this.ext.observeRecoveryCursors === "function" ? this.ext.observeRecoveryCursors() : [];
    if (observations.length === 0 && sessions.length === 0 && evidence.length === 0 && usage.length === 0 && cursors.length === 0) return;
    this.store.transact(() => {
      for (const obs of observations) this.applyObservation(obs);
      this.applySessionIds(sessions);
      this.applyEvidence(evidence);
      this.applyUsage(usage);
      this.applyObservationCursors(cursors);
    });
  }

  /**
   * Re-read the step snapshot only when the store changed since it was taken.
   * Every store mutation writes an audit row, so the audit seq is the store's
   * change version; on a quiet tick this keeps ONE roster materialization per
   * tick instead of three (2026-09-01: three full listBeeViewRows reads per
   * 200ms tick were a third of the daemon's CPU on a 268-bee hive).
   */
  private refreshSnapshot(current: StepSnapshot, takenAtSeq: number, scope: ReadonlySet<string> | null): { snapshot: StepSnapshot; seq: number } {
    const seq = this.store.lastAuditSeq();
    if (seq === takenAtSeq) return { snapshot: current, seq };
    return { snapshot: this.stepSnapshot(scope), seq };
  }

  private i1Enabled(): boolean {
    return this.policy.i1DeadlineSteps != null && this.onI1Violation != null;
  }

  /** Reuse only within this step, after proving delivery and task supply made no durable change. */
  private finalI1Snapshot(snapshot: StepSnapshot, takenAtSeq: number, scope: ReadonlySet<string> | null): readonly I1PendingBee[] {
    const seq = this.store.lastAuditSeq();
    if (snapshot.i1 !== null && seq === takenAtSeq) return snapshot.i1;
    if (scope !== null && scope.size === 0) return [];
    return this.store.readI1PendingSnapshot(scope === null ? null : [...scope]);
  }

  /**
   * One sparse read-model snapshot replaces the old per-policy N+1 store
   * walks. Work is refreshed across the command boundary where the step
   * itself may have changed runtime or mailbox truth.
   */
  private stepSnapshot(scope: ReadonlySet<string> | null): StepSnapshot {
    if ((scope !== null && scope.size === 0) || !this.store.hasStepSnapshotInputs()) {
      if (this.i1Enabled()) return { work: [], i1: [] };
      return { work: [], i1: null };
    }
    const beeIds = scope === null ? null : [...scope];
    if (this.i1Enabled()) return this.store.readDaemonStepInputs(beeIds);
    return { work: this.store.readDaemonWork(beeIds), i1: null };
  }

  /**
   * After mailbox drain: if a bee's supply is on, the queue is empty, and the
   * six-condition gate fires, feed one pending auto task as an idle mailbox
   * message. A fed task that sits through an idle tick without being closed
   * is stamped stalled.
   */
  private taskSupplyLoop(scope: ReadonlySet<string> | null): void {
    const bees = this.tracked(scope, this.supplyBees,
      () => this.store.listTaskSupply({ on: true }).map(row => row.beeId),
      beeId => this.store.getTaskSupply(beeId).on);
    for (const row of bees.map(beeId => this.store.getTaskSupply(beeId))) {
      try {
        this.store.tryFeedTaskSupply(row.beeId);
        this.store.maybeStallFedTask(row.beeId);
      } catch (err) {
        this.log(`task.supply.err bee=${row.beeId} ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // observations → store state
  // -------------------------------------------------------------------------

  private applyObservation(obs: DriverObservation): void {
    if (obs.kind === "turn_ended" || obs.kind === "exited") this.moveAcceptPoint(obs.beeId, obs.generation, obs.kind);
    if (!this.store.getBee(obs.beeId)) {
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind} reason=no_bee`);
      return;
    }
    const rt = this.store.currentRuntime(obs.beeId);
    if (!rt) return;
    const target: RuntimeState =
      obs.kind === "exited" ? "stopped" : obs.kind === "turn_ended" ? "idle" : "running";
    if (obs.generation !== rt.generation) {
      // Stale-generation update: the store records the no-op (audit trail, B2).
      this.store.updateRuntimeState(
        obs.beeId,
        obs.generation,
        target,
        target === "stopped" ? { exitCause: obs.exitCause ?? "crashed" } : {},
      );
      return;
    }
    this.deliveryRetries.delete(obs.beeId);
    for (const [id, poll] of this.confirmationPolls) if (poll.beeId === obs.beeId) this.confirmationPolls.delete(id);
    // v9 synthetic-boot budget: a non-synthetic booted/turn observation was
    // parsed by the adapter from REAL process output — the boot evidence that
    // resets the bee's spawn-failure budget and clears spawn_failed. Driver-
    // minted observations (synthetic: the readyAtSpawn booted, the deliver-
    // opened turn_started) prove nothing and never touch the budget.
    if (obs.kind !== "exited" && obs.synthetic !== true && rt.bootEvidence !== "real") {
      const { applied } = this.store.recordBootEvidence(obs.beeId, obs.generation);
      if (applied) this.log(`spawn.evidence bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind}`);
    }
    if (obs.kind === "booted" && rt.state !== "booting") {
      // booted only ever moves booting → running. A late/duplicate booted
      // (readyAtSpawn harnesses emit their real init after the first message)
      // is evidence — recorded above — never a state edge (an idle runtime
      // must not phantom-start a turn from it).
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=booted reason=already_${rt.state}`);
      return;
    }
    if (obs.kind === "turn_ended" && obs.synthetic === true && this.store.undeliveredMessages(obs.beeId).length > 0) {
      // The readyAtSpawn boot-to-ready edge with mail already waiting: the
      // delivery loop opens a real turn this same step (synthetic-boot
      // `running` is provisional — every urgency is eligible there), so
      // folding idle here would publish a one-step "waiting for you" under
      // a turn about to start. Keep `running`; the real result idles it.
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=turn_ended reason=mail_pending`);
      return;
    }
    if (rt.state === target) {
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind} reason=already_${target}`);
      return;
    }
    if (!RUNTIME_TRANSITIONS[rt.state].includes(target)) {
      // Duplicate re-drain after a crash, or an event for a state the store has
      // already moved past. The extraction layer normalizes; skipping is safe.
      this.log(`obs.skip bee=${obs.beeId} gen=${obs.generation} kind=${obs.kind} reason=${rt.state}->${target}`);
      return;
    }
    if (target === "stopped") {
      // A generation with no real boot evidence remains countable whether it
      // exits on its own or the executed boot-hang policy stops it.
      const countable = rt.state === "booting" || rt.bootEvidence === "synthetic";
      const failuresBefore = countable ? (this.store.getBee(obs.beeId)?.spawnFailures ?? 0) : null;
      let bootRetryNeeded = false;
      this.store.updateRuntimeState(obs.beeId, obs.generation, "stopped", {
        exitCause: obs.exitCause ?? "crashed",
        exitDetail: obs.detail,
      });
      this.log(
        `obs.exited bee=${obs.beeId} gen=${obs.generation} cause=${obs.exitCause}${obs.detail ? ` detail=${obs.detail}` : ""}`,
      );
      if (failuresBefore != null) {
        // The store counts natural crashed/clean exits and executed hang-policy
        // stops on one per-bee budget across wake-driven revives.
        const failures = this.store.getBee(obs.beeId)?.spawnFailures ?? 0;
        if (failures > failuresBefore) {
          const flagged = this.store.activeFlags(obs.beeId).some((f) => f.flag === "spawn_failed");
          this.log(`spawn.failure bee=${obs.beeId} gen=${obs.generation} failures=${failures} flagged=${flagged}`);
          try {
            this.onSpawnFailure(obs.beeId, obs.generation, flagged);
          } catch (err) {
            this.log(`spawn.failure_hook_error bee=${obs.beeId} ${err instanceof Error ? err.message : String(err)}`);
          }
          bootRetryNeeded = !flagged;
        }
      }
      // A dead runtime with pending mail must be revived — no user intervention
      // (I1) — on the boot-failure backoff table, and never while spawn_failed
      // is set (visibly blocked; the operator's revive is the way back).
      this.ensureWake(obs.beeId);
      if (bootRetryNeeded) this.ensureBootRetry(obs.beeId);
      this.reviveAfterStopIfRequested(obs.beeId, obs.generation);
      this.releaseBeeTmp(obs.beeId);
    } else if (obs.kind === "booted") {
      this.recordProcAtSpawn(obs.beeId, obs.generation);
      this.store.updateRuntimeState(obs.beeId, obs.generation, "running", {
        pid: obs.pid,
        pidStartedAt: obs.pidStartedAt,
        // Provisional when driver-minted: the budget resets only on REAL
        // evidence (recordBootEvidence above), never on the synthetic booted.
        synthetic: obs.synthetic === true,
      });
      this.log(`obs.booted bee=${obs.beeId} gen=${obs.generation} pid=${obs.pid}${obs.synthetic ? " synthetic" : ""}`);
    } else {
      this.store.updateRuntimeState(
        obs.beeId,
        obs.generation,
        target,
        // The output/turn-completion fact and running→idle phase are one core
        // transaction. A crash can replay the journal line, but can never
        // persist idle without its corresponding last-output fact. A SYNTHETIC
        // turn_ended (the readyAtSpawn boot-to-ready edge) is a phase fact
        // only: the agent produced nothing, so lastOutputAt must not move.
        obs.kind === "turn_ended" && obs.synthetic !== true ? { recordOutput: true, endedQuiet: obs.endedQuiet } : this.turnOpenerOf(obs),
      );
      this.log(`obs.${obs.kind} bee=${obs.beeId} gen=${obs.generation}${obs.synthetic ? " synthetic" : ""}`);
      if ((obs.kind === "turn_ended" && obs.synthetic !== true) || obs.kind === "exited") this.onTranscriptQuiet(obs.beeId, obs.generation, obs.kind);
    }
  }

  private turnTriggerSourceOf(msg: MessageRow, peer: boolean): TurnTriggerSource {
    if (this.store.answeredQuestionId(msg.id) !== null) return { kind: "answer", from: msg.sender };
    return turnTriggerSource(msg, this.store.mailOrigin(msg.id), peer, this.store.getBee(msg.beeId)?.parentId ?? null);
  }

  private turnOpenerOf(obs: DriverObservation): { turnOpener?: TurnTriggerSource & { messageId: number } } {
    if (obs.kind !== "turn_started" || obs.messageId === undefined) return {};
    const msg = this.store.getMessage(obs.messageId);
    if (!msg || msg.beeId !== obs.beeId) return {};
    const peer = isPeerSender(msg.sender, (id) => this.store.getBee(id) != null);
    return { turnOpener: { ...this.turnTriggerSourceOf(msg, peer), messageId: msg.id } };
  }

  /**
   * Enqueue a send_wake iff the bee has undelivered mail, no live runtime and
   * no pending wake. The store owns the rule (send() shares it): a wake is
   * deferred on the B5 backoff table after boot failures and suppressed while
   * `spawn_failed` is set. Returns true iff a NEW wake was enqueued now.
   */
  private ensureWake(beeId: string): boolean {
    const { command, outcome } = this.store.enqueueWake(beeId);
    if (outcome === "suppressed") {
      this.log(`wake.suppressed bee=${beeId} flag=spawn_failed`);
      return false;
    }
    if (outcome !== "enqueued" || !command) return false;
    this.log(
      `wake.enqueued bee=${beeId} gen=${command.targetGeneration ?? 0}` +
        (command.nextAttemptAt > command.enqueuedAt ? ` notBefore=${command.nextAttemptAt}` : ""),
    );
    return true;
  }

  /** A failed boot is retried on B5's budget even for a prompt-less spawn. */
  private ensureBootRetry(beeId: string): boolean {
    const { command, outcome } = this.store.enqueueBootRetry(beeId);
    if (outcome === "suppressed") return false;
    if (outcome !== "enqueued" || !command) return false;
    this.log(
      `boot_retry.enqueued bee=${beeId} gen=${command.targetGeneration ?? 0}` +
        (command.nextAttemptAt > command.enqueuedAt ? ` notBefore=${command.nextAttemptAt}` : ""),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // flag policy — adapters report evidence, the daemon enacts it (spec 03/04)
  // -------------------------------------------------------------------------

  /**
   * Provider-declared expiry (contract §4.2 provider-boundary flags): a
   * rate-limit wall carries the instant it lifts. Once the clock passes it,
   * the block is over by the provider's own statement — clear it, so a bee
   * that never ran another turn (parked, or stopped by the idle window) does
   * not read as blocked forever. Silence still clears nothing: a flag with no
   * declared reset waits for contrary evidence from a served turn.
   */
  private expireFlags(): void {
    for (const row of this.store.expireFlags(this.now())) {
      this.log(
        `flag.expire bee=${row.beeId} flag=${row.flag} resetsAt=${new Date(row.resetsAt as number).toISOString()}`,
      );
    }
  }

  private applySandboxTmpEvidence(ev: FlagEvidenceLike): void {
    const open = this.store.activeFlags(ev.beeId).find((f) => f.flag === ev.flag);
    const ours = open !== undefined && open.detail.startsWith(SANDBOX_TMP_FULL);
    if (ev.action === "set") {
      if (open !== undefined && !ours) return;
      if (ours && open.detail === ev.detail) return;
      this.store.setFlag(ev.beeId, ev.flag, ev.detail, { resetsAt: null });
      this.log(`flag.set bee=${ev.beeId} flag=${ev.flag} gen=${ev.generation} by=sandbox_tmp`);
      return;
    }
    if (!ours) return;
    const { applied } = this.store.clearFlag(ev.beeId, ev.flag, ev.detail);
    if (applied) this.log(`flag.clear bee=${ev.beeId} flag=${ev.flag} gen=${ev.generation} by=sandbox_tmp`);
  }

  private applyEvidence(evidence: readonly FlagEvidenceLike[]): void {
    for (const ev of evidence) {
      if (!this.store.getBee(ev.beeId)) {
        this.log(`flag.skip bee=${ev.beeId} flag=${ev.flag} reason=no_bee`);
        continue;
      }
      const runtime = this.store.currentRuntime(ev.beeId);
      if (!runtime || runtime.generation !== ev.generation) {
        this.log(`flag.skip bee=${ev.beeId} gen=${ev.generation} reason=stale_generation`);
        continue;
      }
      if (ev.owner === "sandbox_tmp") {
        this.applySandboxTmpEvidence(ev);
        continue;
      }
      const rebound = this.store.listQuotaRecoveries(ev.beeId).some(row => row.sourceGeneration === ev.generation
        && row.targetAccount !== null && row.sourceAccount !== row.targetAccount && (row.state === "rotating" || row.state === "resumed"));
      if (rebound) {
        if (ev.quota && ev.eventId) this.store.recordQuotaEvidence({ eventId: ev.eventId, ...(ev.sourceId ? { sourceId: ev.sourceId } : {}), beeId: ev.beeId, generation: ev.generation, quota: ev.quota, turn: ev.turn ?? { messageIds: [], progress: "unknown" } });
        this.log(`flag.skip bee=${ev.beeId} gen=${ev.generation} reason=rebound_generation`);
        continue;
      }
      this.store.transact(() => {
        if (ev.quota && ev.eventId) this.store.recordQuotaEvidence({ eventId: ev.eventId, ...(ev.sourceId ? { sourceId: ev.sourceId } : {}), beeId: ev.beeId, generation: ev.generation, quota: ev.quota, turn: ev.turn ?? { messageIds: [], progress: "unknown" } });
        if (ev.action === "set") {
          this.store.setFlag(ev.beeId, ev.flag, ev.detail, { resetsAt: ev.resetsAt ?? null });
          this.log(
            `flag.set bee=${ev.beeId} flag=${ev.flag} gen=${ev.generation}${ev.resetsAt != null ? ` resetsAt=${new Date(ev.resetsAt).toISOString()}` : ""}`,
          );
        } else {
          // Every clean turn re-emits contrary evidence; clearing an unset flag
          // is a store no-op — logging it too was pure noise (soak day-2).
          const { applied } = this.store.clearFlag(ev.beeId, ev.flag, ev.detail);
          if (applied) this.log(`flag.clear bee=${ev.beeId} flag=${ev.flag} gen=${ev.generation}`);
        }
      });
      // v7: account policy (spec 08) rides the same evidence — never throws
      // into the loop (a policy bug must not stall observation drain).
      if (this.onFlagEvidence) {
        try {
          this.onFlagEvidence(ev);
        } catch (err) {
          this.log(`account.policy_error bee=${ev.beeId} flag=${ev.flag} err=${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  /**
   * v7 (bee.swapAccount): a `stop` command may carry `thenRevive: true` —
   * "stop this generation, then start the next one" — the durable form of
   * stop → revive that a swap needs (a plain revive enqueued alongside the
   * stop would be claimed while the old process is still dying). When the
   * runtime is observed or reconciled stopped, the pending intent is honored ONCE by
   * enqueueing a `revive` (which mints generation N+1 with the new account's
   * env). Idempotent: an existing queued/running revive/wake is enough.
   */
  private reviveAfterStopIfRequested(beeId: string, generation: number): void {
    const bee = this.store.getBee(beeId);
    if (bee?.activeMoveId || bee?.activeHandoffId) return;
    if (!this.store.hasStopThenReviveRequest(beeId, generation)) return;
    if (this.store.hasPendingReviveOrWakeCommand(beeId, generation)) return;
    // Only the generation the stop targeted; a later generation means the
    // revive already happened (or the operator moved on).
    const rt = this.store.currentRuntime(beeId);
    if (!rt || rt.generation !== generation || rt.state !== "stopped") return;
    const cmd = this.store.enqueueCommand("revive", beeId, { reason: "after_stop" });
    this.log(`revive.after_stop bee=${beeId} gen=${generation} cmd=${cmd.id}`);
  }

  /**
   * Continuity (spec 07 §F): the harness session/thread id a runtime reports
   * on boot is a fact about the BEE's conversation — record it so the next
   * generation resumes it. Only the current generation may write it: a stale
   * generation's late init describes a conversation the bee has moved past.
   */
  private applySessionIds(sessions: readonly SessionEvidenceLike[]): void {
    for (const ev of sessions) {
      const rt = this.store.getBee(ev.beeId) ? this.store.currentRuntime(ev.beeId) : null;
      if (!rt || rt.generation !== ev.generation) {
        // v23: a stale generation that belongs to a CLOSED transcript segment
        // (the source side of a handoff) still gets its thread id recorded on
        // that segment — transcript reconstruction evidence only; the store
        // never lets it touch the bee's live thread pointer.
        const segment = rt ? this.store.transcriptSegmentForGeneration(ev.beeId, ev.generation) : null;
        if (segment && segment.toGeneration !== null) {
          this.store.recordProviderSessionId(ev.beeId, ev.sessionId, ev.generation);
          this.log(`session.fenced bee=${ev.beeId} gen=${ev.generation} segment=${segment.id} id=${ev.sessionId}`);
          continue;
        }
        this.log(`session.skip bee=${ev.beeId} gen=${ev.generation} reason=${rt ? "stale_generation" : "no_bee"}`);
        continue;
      }
      // v23: the generation rides along so a late init from a handed-off
      // source generation lands on its closed transcript segment, never on
      // the bee's live thread pointer (the target harness must not resume
      // another provider's conversation).
      const { applied } = this.store.recordProviderSessionId(ev.beeId, ev.sessionId, ev.generation);
      if (applied) this.log(`session.recorded bee=${ev.beeId} gen=${ev.generation} id=${ev.sessionId}`);
    }
  }

  /**
   * Observed subscription usage is account evidence, not bee state: the
   * account hook records it (a stale generation still describes the account
   * it ran with). Never throws into the loop.
   */
  private applyUsage(usage: readonly UsageEvidenceLike[]): void {
    for (const ev of usage) {
      if (!this.onUsageEvidence) continue;
      try {
        this.onUsageEvidence(ev);
      } catch (err) {
        this.log(`account.usage_error bee=${ev.beeId} gen=${ev.generation} err=${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * Commit the runner journal cursor last in the observation-fold transaction.
   * Every projection before this point is generation-fenced and idempotent; a
   * crash rolls back both effects and cursor, while a committed cursor can
   * never outrun core state.
   */
  private applyObservationCursors(cursors: readonly ObservationCursorEvidenceLike[]): void {
    for (const ev of cursors) {
      const { applied } = this.store.advanceRuntimeObservationCursor(
        ev.beeId,
        ev.generation,
        ev.cursor,
      );
      if (applied) {
        this.log(`obs.checkpoint bee=${ev.beeId} gen=${ev.generation} cursor=${ev.cursor}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // boot-hang policy — bounded recovery for a missing readiness handshake
  // -------------------------------------------------------------------------

  private bootHangPolicy(work: readonly DaemonWorkRow[]): void {
    const now = this.now();
    for (const { runtime: rt } of work) {
      if (rt.state !== "booting" || this.unresolvedIdentity.get(rt.beeId) === rt.generation) continue;
      const deadline = this.bootHangDeadline(rt);
      if (now <= deadline) { this.scheduleBee(rt.beeId, deadline + 1); continue; }
      if (this.store.hasPendingStopCommand(rt.beeId, rt.generation)) continue;
      if (this.store.hasBootHangStopCommand(rt.beeId, rt.generation)) continue;
      this.store.enqueueCommand("stop", rt.beeId, { cause: "stopped_by_system", reason: "hang_policy" });
      this.log(`policy.hang_stop bee=${rt.beeId} gen=${rt.generation} state=${rt.state}`);
    }
  }

  private bootHangDeadline(rt: {beeId: string; generation: number; startedAt: number}): number {
    return Math.max(rt.startedAt, this.store.runtimePendingStartBoundAt(rt.beeId, rt.generation) ?? rt.startedAt) + this.policy.bootHangTimeoutSteps;
  }

  // -------------------------------------------------------------------------
  // scale-to-zero — idle → stop(stopped_by_system) after the idle window
  // -------------------------------------------------------------------------

  private scaleToZeroPolicy(work: readonly DaemonWorkRow[]): void {
    const window = this.policy.idleWindowSteps;
    if (window == null) return;
    const now = this.now();
    for (const { runtime: rt, pending } of work) {
      if (rt.state !== "idle") continue;
      if (now - rt.updatedAt <= window) { this.scheduleBee(rt.beeId, rt.updatedAt + window + 1); continue; }
      // Pending mail means the delivery loop is about to use this runtime —
      // stopping it now would only bounce through revive-on-message.
      if (pending.length > 0) continue;
      if (this.store.hasPendingReconnect(rt.beeId, rt.generation)) continue;
      if (this.store.activeMoveOf(rt.beeId)) continue;
      if (this.store.activeHandoffOf(rt.beeId)) continue;
      if (this.store.hasPendingStopCommand(rt.beeId, rt.generation)) continue;
      this.store.enqueueCommand("stop", rt.beeId, { cause: "stopped_by_system", reason: "idle_window" });
      this.log(`policy.idle_stop bee=${rt.beeId} gen=${rt.generation} idleFor=${now - rt.updatedAt}`);
    }
  }

  // -------------------------------------------------------------------------
  // degraded-runtime policy — re-adopted processes cannot accept deliveries
  // -------------------------------------------------------------------------

  private degradedMailPolicy(work: readonly DaemonWorkRow[]): void {
    if (typeof this.ext.isDegraded !== "function") return;
    for (const { runtime: rt, pending } of work) {
      if (!this.ext.isDegraded(rt.beeId, rt.generation)) continue;
      if (pending.length === 0) continue;
      if (this.store.listDeliveryConfirmationIntents(rt.beeId).some(row => row.generation === rt.generation)) continue;
      if (this.store.hasPendingStopCommand(rt.beeId, rt.generation)) continue;
      this.store.enqueueCommand("stop", rt.beeId, { cause: "stopped_by_system", reason: "degraded_runtime" });
      this.log(`policy.degraded_stop bee=${rt.beeId} gen=${rt.generation}`);
    }
  }

  // -------------------------------------------------------------------------
  // executor loop
  // -------------------------------------------------------------------------

  private executeCommands(): void {
    for (let i = 0; i < this.policy.commandsPerStep; i++) {
      const cmd = this.store.claimNextCommand({
        blockedRuntimeStartBeeIds: this.blockedRuntimeStartBeeIds(),
        blockedIdentityBeeIds: new Set(this.unresolvedIdentity.keys()),
      });
      if (!cmd) return;
      const crash = this.faults?.executorCrash() ?? "none";
      if (crash === "before_effect") {
        this.log(`cmd.crash id=${cmd.id} verb=${cmd.verb} point=before_effect`);
        throw new ExecutorCrashError(crash);
      }
      let settled: boolean;
      try {
        settled = this.execute(cmd);
      } catch (err) {
        if (err instanceof ProcessIdentityUnavailableError) {
          const runtime = this.store.currentRuntime(cmd.beeId);
          if (runtime) { this.retainProcessIdentity(cmd.beeId, runtime.generation); this.onIdentityUnresolved(cmd.beeId, runtime.generation); }
          this.store.holdIdentityCommand(cmd.id); return;
        }
        if (err instanceof ExecutionFenceError) { this.store.holdExecutionCommand(cmd.id,err.code); return; }
        if (!(err instanceof CoreError)) throw err;
        // A contract rejection means the intent is moot (bee deleted, state moved
        // on, …) — settle done, mirroring B6's no-op philosophy.
        this.log(`cmd.moot id=${cmd.id} verb=${cmd.verb} err=${err.name}`);
        settled = true;
      }
      if (crash === "after_effect") {
        this.log(`cmd.crash id=${cmd.id} verb=${cmd.verb} point=after_effect`);
        throw new ExecutorCrashError(crash);
      }
      if (settled) this.store.completeCommand(cmd.id);
    }
  }

  /**
   * driver.start for a claimed spawn-shaped command. A driver that throws
   * BEFORE it owns a process (a cell whose provisioning failed: origin gone,
   * git/CoW error; a harness whose spawn spec cannot be resolved) is a
   * spawn failure on the B5 retry table — `spawn_failed` at the budget,
   * visibly — never a wedged `running` command or a tick error. Returns
   * false when the command was reported failed (the caller does not settle).
   */
  private startRuntime(cmd: CommandRow, generation: number): boolean {
    try {
      this.assertRuntimeStartReady(cmd);
      const execution = this.store.prepareExecutionStart(cmd.beeId,generation);
      this.driver.start(cmd.beeId, generation, execution);
      return true;
    } catch (err) {
      if (err instanceof CoreError) throw err; // contract rejections keep their moot path
      const detail = err instanceof Error ? err.message : String(err);
      const res = this.store.reportCommandFailure(cmd.id, "spawn_failed", `driver start failed: ${detail}`);
      this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} gen=${generation} start_failed status=${res.status} attempts=${res.attempts} err=${JSON.stringify(detail)}`);
      return false;
    }
  }

  private releaseBeeTmp(beeId: string): void {
    if (!this.removeBeeTmp) return;
    const bee = this.store.getBee(beeId);
    if (bee && bee.lifecycle !== "archived") return;
    const rt = this.store.currentRuntime(beeId);
    if (rt && rt.state !== "stopped") return;
    this.removeBeeTmp(beeId);
  }

  /** Record pid + start-time at spawn (the WP2 amendment) when the driver can report it. */
  private recordProcAtSpawn(beeId: string, generation: number): void {
    if (typeof this.ext.procOf !== "function") return;
    const proc = this.ext.procOf(beeId, generation);
    if (proc) this.store.recordRuntimeProc(beeId, generation, proc);
  }

  /** Execute one claimed command. Returns true when the caller should settle it done. */
  private execute(cmd: CommandRow): boolean {
    switch (cmd.verb) {
      case "reconnect_tools": {
        const rt = this.store.currentRuntime(cmd.beeId);
        if (!rt || rt.state === "stopped") {
          this.store.settleReconnect(cmd.id, null, { code: "runtime_unavailable", message: "The owning runtime has stopped" });
          return false;
        }
        const execute = this.reconnectTools;
        if (!execute) {
          this.store.settleReconnect(cmd.id, null, { code: "unsupported_harness", message: "No reconnect executor" });
          return false;
        }
        void Promise.resolve().then(() => execute(cmd)).then(
          receipt => { if (!this.reconnectOwnerClosed) this.store.settleReconnect(cmd.id, receipt, null); },
          (error: unknown) => {
            if (this.reconnectOwnerClosed) return;
            const code = (error as { code?: string })?.code ?? "reconnect_failed";
            if (code === "owner_detached") return;
            if (code === "not_ready") this.store.deferReconnect(cmd.id);
            else this.store.settleReconnect(cmd.id, null, { code, message: error instanceof Error ? error.message : "Reconnect failed" });
          },
        );
        return false;
      }
      case "archive": {
        if (!this.store.executeArchiveCommand(cmd.id)) return true;
        this.releaseBeeTmp(cmd.beeId);
        this.log(`cmd.archive id=${cmd.id} bee=${cmd.beeId}`);
        return true;
      }
      case "unarchive": {
        const bee = this.store.getBee(cmd.beeId);
        if (bee?.lifecycle === "archived") this.store.unarchiveBee(cmd.beeId);
        this.log(`cmd.unarchive id=${cmd.id} bee=${cmd.beeId}`);
        return true;
      }
      case "delete": {
        const rt = this.store.currentRuntime(cmd.beeId);
        const threadOperation = this.store.threadOperationForSuccessor(cmd.beeId);
        const result = this.store.deleteBee(cmd.beeId); // settles this command too (pending → done)
        this.multilineFallback?.cleanupDeleted();
        if (rt && LIVE.includes(rt.state)) {
          this.driver.stop(cmd.beeId, rt.generation, "stopped_by_system");
        }
        if (result.sessionLogPath && this.removeSessionLog) {
          this.removeSessionLog(result.sessionLogPath);
        }
        if (threadOperation) this.removeThreadArtifacts?.(threadOperation.id);
        this.removeBeeTmp?.(cmd.beeId);
        this.log(`cmd.delete id=${cmd.id} bee=${cmd.beeId}`);
        return true;
      }
      case "stop": {
        const gen = cmd.targetGeneration;
        const cause: StopCause =
          cmd.args.cause === "stopped_by_user" ? "stopped_by_user" : "stopped_by_system";
        const rt = this.store.currentRuntime(cmd.beeId);
        if (gen == null || !rt || rt.generation !== gen) return true;
        // claimNextCommand only admits replacement args when this generation
        // is idle/stopped. Claim, args update and driver.stop share one
        // synchronous executor turn with no mailbox admission between them.
        if (cmd.args.replacementArgs !== undefined) {
          // Changes admitted before args were recorded at admission apply them here.
          if (cmd.args.argsApplied !== true) {
            this.store.updateBeeArgs(cmd.beeId, cmd.args.replacementArgs as string[] | null);
          }
          if (rt.state === "stopped") {
            // Recovery can observe the exit before replaying this command.
            this.reviveAfterStopIfRequested(cmd.beeId, gen);
            return true;
          }
        }
        if (rt.state === "stopped") return true;
        if (cmd.args.cause === "stopped_by_system" && cmd.args.reason === "hang_policy") {
          if (rt.state !== "booting") { this.store.skipBootHangStop(cmd.id); return false; }
          const deadline = this.bootHangDeadline(rt);
          if (this.now() <= deadline) { this.store.deferBootHangStop(cmd.id, deadline + 1); return false; }
        }
        const { hadProcess } = this.driver.stop(cmd.beeId, gen, cause);
        if (!hadProcess) {
          // Parenthood certainty: no process exists, so the stop is a fact now.
          this.store.updateRuntimeState(cmd.beeId, gen, "stopped", { exitCause: cause });
          this.ensureWake(cmd.beeId);
          // thenRevive: this stop command is still `running` here (settled by the caller).
          this.reviveAfterStopIfRequested(cmd.beeId, gen);
        }
        this.log(`cmd.stop id=${cmd.id} bee=${cmd.beeId} gen=${gen} cause=${cause} hadProcess=${hadProcess}`);
        return true;
      }
      case "spawn":
      case "revive":
      case "send_wake": {
        const interruption = typeof cmd.args.authDeathRecoveryId === "number" ? this.store.getAuthInterruption(cmd.args.authDeathRecoveryId) : null;
        const authRecovery = interruption?.beeId === cmd.beeId && interruption.deathRecovery?.commandId === cmd.id && interruption.deathRecovery.claimedAt !== null;
        if (cmd.verb === "revive" && !authRecovery) {
          // Operator action (explicit verb): a fresh spawn-failure budget and
          // the spawn_failed flag cleared — the attempt below runs regardless
          // of the flag. spawn_failed clears otherwise only on contrary
          // evidence (a successful boot), never on the mere act of starting.
          const { applied } = this.store.resetSpawnFailures(cmd.beeId, `operator revive (command ${cmd.id})`);
          if (applied) this.log(`spawn.budget_reset bee=${cmd.beeId} by=revive cmd=${cmd.id}`);
        }
        // revive may carry replacement per-bee args (schema v5): applied
        // before the driver resolves the spawn (same transaction as the new
        // generation on the mint path), so the started runtime sees them.
        const reviveArgs = cmd.verb === "revive" && cmd.args.args !== undefined ? (cmd.args.args as string[] | null) : undefined;
        const rt = this.store.currentRuntime(cmd.beeId);
        if (rt && LIVE.includes(rt.state)) {
          if (this.driver.hasProcess(cmd.beeId, rt.generation)) {
            // Idempotent replay: the runtime is already up. Nothing to do.
            this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} noop=live`);
            return true;
          }
          if (this.faults?.driverTimeout() ?? false) {
            this.store.reportCommandFailure(cmd.id, "spawn_failed", "sim: driver start timeout");
            this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} timeout gen=${rt.generation}`);
            return false;
          }
          if (reviveArgs !== undefined) this.store.updateBeeArgs(cmd.beeId, reviveArgs);
          if (!this.startRuntime(cmd, rt.generation)) return false;
          this.recordProcAtSpawn(cmd.beeId, rt.generation);
          this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} start gen=${rt.generation}`);
          return true;
        }
        if (this.faults?.driverTimeout() ?? false) {
          this.store.reportCommandFailure(cmd.id, "spawn_failed", "sim: driver start timeout");
          this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} timeout`);
          return false;
        }
        this.store.prepareExecutionStart(cmd.beeId,(rt?.generation ?? 0)+1);
        const next = this.store.reviveBee(cmd.beeId, reviveArgs === undefined ? {} : { args: reviveArgs });
        if (!this.startRuntime(cmd, next.generation)) return false;
        this.recordProcAtSpawn(cmd.beeId, next.generation);
        this.log(`cmd.${cmd.verb} id=${cmd.id} bee=${cmd.beeId} revive gen=${next.generation}`);
        return true;
      }
      default:
        return true;
    }
  }

  private sourceGone(beeId: string, generation: number): boolean {
    if (this.unresolvedIdentity.get(beeId) === generation) return false;
    return this.sourceProcessAbsent(beeId, generation);
  }

  private reconcileMoves(scope: ReadonlySet<string> | null): void {
    let moves: BeeMoveRow[];
    if (scope === null) {
      moves = this.store.listActiveBeeMoves();
      this.movingBees.clear();
      for (const move of moves) this.movingBees.add(move.beeId);
    } else {
      moves = [];
      for (const beeId of scope) {
        if (!this.movingBees.has(beeId)) continue;
        const move = this.store.activeMoveOf(beeId);
        if (move) moves.push(move);
        else this.movingBees.delete(beeId);
      }
    }
    for (const move of moves) {
      const bee = this.store.getBee(move.beeId);
      if (!bee) continue;
      this.hot.add(bee.id);
      const rt = this.store.currentRuntime(bee.id);
      try {
        if (move.phase === "stopping") {
          if (rt?.state === "stopped" && rt.generation === move.sourceGeneration && this.sourceGone(bee.id, move.sourceGeneration)) {
            this.store.setBeeMovePhase(move.id, "placing");
          }
        }
        const current = this.store.getBeeMove(move.id);
        if (current?.phase === "placing") {
          if (!(rt?.state === "stopped" && rt.generation === move.sourceGeneration && this.sourceGone(bee.id, move.sourceGeneration))) {
            continue;
          }
          if (this.validatePlacement) this.validatePlacement(current, bee);
          if (this.relocateSession) {
            this.relocateSession(current, bee);
          }
          this.store.commitBeePlacement(move.id);
        }
        const after = this.store.getBeeMove(move.id);
        if (after?.phase === "starting") {
          const dest = this.store.currentRuntime(bee.id);
          if (this.store.activeFlags(bee.id).some((f) => f.flag === "spawn_failed")) {
            this.store.failBeeMove(move.id, { stage: "start", code: "spawn_failed", detail: "destination runtime failed to boot" });
            continue;
          }
          if (dest && dest.generation !== move.sourceGeneration && dest.state === "stopped") {
            const retry = this.store.enqueueBootRetry(bee.id);
            this.log(`move.dest_retry bee=${bee.id} move=${move.id} outcome=${retry.outcome}`);
            continue;
          }
          if (dest && dest.generation !== move.sourceGeneration && (dest.state === "running" || dest.state === "idle")) {
            // Native startup overlay evidence: Claude argv was in the spawned
            // process; Codex thread/start|resume developerInstructions was
            // acknowledged by the handshake that left booting. Never mark at
            // resolveSpawnSpec — that is before account activation and spawn.
            // Pending mail still owes the delivery-time prefix, and a dest
            // crash before that accept point must retry with the overlay
            // still pending on resolveSpawnSpec.
            const pending = this.store.undeliveredMessages(bee.id);
            if (
              pending.length === 0
              && (bee.agent === "claude" || bee.agent === "codex")
              && !after.instructionsApplied
            ) {
              this.store.markMoveInstructionsApplied(move.id);
            }
            if (pending.length === 0 && this.store.getBeeMove(move.id)?.instructionsApplied) {
              this.store.completeBeeMove(move.id);
            }
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const continuation = err instanceof Error && err.name === "ContinuationUnsupportedError";
        const stage = continuation || /transcript/i.test(detail) ? "context" : /repo_mismatch|no longer exists|HEAD/.test(detail) ? "validate" : "start";
        const code = continuation
          ? "continuation_unsupported"
          : stage === "context"
            ? "transcript_unavailable"
            : stage === "validate"
              ? "repo_mismatch"
              : "move_failed";
        this.log(`move.fail bee=${bee.id} move=${move.id} ${detail}`);
        try {
          this.store.failBeeMove(move.id, { stage, code, detail });
        } catch (failErr) {
          this.log(`move.fail_error bee=${bee.id} ${failErr instanceof Error ? failErr.message : String(failErr)}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // v23 — session handoff reconciliation
  // -------------------------------------------------------------------------

  /**
   * Drive each admitted handoff through its durable phases. Every step reads
   * committed state and is idempotent, so a daemon death anywhere resumes on
   * the next boot: stopping → (source stopped AND process gone) → summarizing
   * → (context built) → switch tx → starting → (seed delivered) → complete.
   */
  private reconcileHandoffs(scope: ReadonlySet<string> | null): void {
    let handoffs: BeeHandoffRow[];
    if (scope === null) {
      handoffs = this.store.listActiveBeeHandoffs();
      this.handingOffBees.clear();
      for (const handoff of handoffs) this.handingOffBees.add(handoff.beeId);
    } else {
      handoffs = [];
      for (const beeId of scope) {
        if (!this.handingOffBees.has(beeId)) continue;
        const handoff = this.store.activeHandoffOf(beeId);
        if (handoff) handoffs.push(handoff);
        else this.handingOffBees.delete(beeId);
      }
    }
    for (const handoff of handoffs) {
      const bee = this.store.getBee(handoff.beeId);
      if (!bee) continue;
      this.hot.add(bee.id);
      const rt = this.store.currentRuntime(bee.id);
      try {
        if (handoff.phase === "stopping") {
          if (rt?.state === "stopped" && rt.generation === handoff.sourceGeneration && this.sourceGone(bee.id, handoff.sourceGeneration)) {
            this.store.setBeeHandoffPhase(handoff.id, "summarizing");
          }
        }
        const current = this.store.getBeeHandoff(handoff.id);
        if (current?.phase === "summarizing") {
          if (!(rt?.state === "stopped" && rt.generation === handoff.sourceGeneration && this.sourceGone(bee.id, handoff.sourceGeneration))) {
            continue;
          }
          this.buildHandoffContext(current, bee);
        }
        const after = this.store.getBeeHandoff(handoff.id);
        if (after?.phase === "starting") {
          const dest = this.store.currentRuntime(bee.id);
          if (this.store.activeFlags(bee.id).some((f) => f.flag === "spawn_failed")) {
            this.store.failBeeHandoff(handoff.id, { stage: "start", code: "spawn_failed", detail: "target runtime failed to boot" });
            continue;
          }
          if (dest && dest.generation !== handoff.sourceGeneration && dest.state === "stopped") {
            const retry = this.store.enqueueBootRetry(bee.id);
            this.log(`handoff.dest_retry bee=${bee.id} handoff=${handoff.id} outcome=${retry.outcome}`);
            continue;
          }
          const seed = after.seedMessageId == null ? null : this.store.getMessage(after.seedMessageId);
          if (seed && seed.deliveredAt != null) this.store.completeBeeHandoff(handoff.id);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const phase = this.store.getBeeHandoff(handoff.id)?.phase ?? handoff.phase;
        const stage = phase === "summarizing" ? "context" : phase === "starting" ? "start" : "stop";
        this.log(`handoff.fail bee=${bee.id} handoff=${handoff.id} stage=${stage} ${detail}`);
        try {
          this.store.failBeeHandoff(handoff.id, { stage, code: "handoff_failed", detail });
        } catch (failErr) {
          this.log(`handoff.fail_error bee=${bee.id} ${failErr instanceof Error ? failErr.message : String(failErr)}`);
        }
      }
    }
  }

  /** The extractive artifact from durable facts + the (optional) transcript read, then the switch tx. */
  private buildHandoffContext(handoff: BeeHandoffRow, bee: BeeRow): void {
    if (this.summarizing.has(handoff.id)) return;
    const segments = this.store.listTranscriptSegments(bee.id).filter((s) => s.ordinal <= (this.store.currentTranscriptSegment(bee.id)?.ordinal ?? 0));
    let transcript: { turns: HandoffContextTurn[]; truncated: boolean } = { turns: [], truncated: false };
    if (this.readHandoffTranscript) {
      try {
        transcript = this.readHandoffTranscript(bee, segments);
      } catch (err) {
        throw new Error(`transcript read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const base = buildExtractiveHandoffContext({
      bee: { id: bee.id, name: bee.name, title: bee.title, cwd: bee.cwd, substrate: bee.substrate, agent: bee.agent, args: bee.args, cellId: bee.cellId },
      target: { agent: handoff.to.agent, args: handoff.to.args },
      instruction: handoff.instruction,
      turns: transcript.turns,
      transcriptTruncated: transcript.truncated,
      segments,
      messages: this.store.listMessages(bee.id),
      seals: this.store.listSeals({ beeId: bee.id }),
      tasks: this.store.listTasks({ beeId: bee.id }),
      questions: this.store.listQuestions({ beeId: bee.id }),
      now: this.now(),
    });
    if (!this.summarizeHandoff) {
      this.switchHandoff(handoff.id, base);
      return;
    }
    this.summarizing.add(handoff.id);
    this.summarizeHandoff({ handoff, bee, base })
      .then((context) => {
        this.summarizing.delete(handoff.id);
        try {
          this.switchHandoff(handoff.id, context);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.log(`handoff.switch_error bee=${bee.id} handoff=${handoff.id} ${detail}`);
          this.failHandoffQuietly(handoff.id, { stage: "switch", code: "handoff_failed", detail });
        }
      })
      .catch((err: unknown) => {
        this.summarizing.delete(handoff.id);
        const detail = err instanceof Error ? err.message : String(err);
        this.log(`handoff.summarize_error bee=${bee.id} handoff=${handoff.id} ${detail}`);
        this.failHandoffQuietly(handoff.id, { stage: "context", code: "summarizer_failed", detail });
      });
  }

  private switchHandoff(handoffId: string, context: HandoffContext): void {
    // Re-read: an operator supersede (or a restart) may have moved on meanwhile.
    const current = this.store.getBeeHandoff(handoffId);
    if (!current || current.phase !== "summarizing") return;
    const switched = this.store.switchBeeHandoff(handoffId, context);
    this.log(
      `handoff.switched bee=${switched.beeId} handoff=${handoffId} ${switched.from.agent}→${switched.to.agent} seed=${switched.seedMessageId ?? "-"} segment=${switched.to.segmentId ?? "-"}`,
    );
  }

  private failHandoffQuietly(handoffId: string, failure: { stage: "context" | "switch"; code: string; detail: string }): void {
    try {
      const current = this.store.getBeeHandoff(handoffId);
      if (!current || current.phase === "complete" || current.phase === "failed") return;
      this.store.failBeeHandoff(handoffId, failure);
    } catch (err) {
      this.log(`handoff.fail_error handoff=${handoffId} ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // delivery loop (v8: urgency-aware — spec 01 Q2 amendment 2026-08-18)
  // -------------------------------------------------------------------------

  /**
   * `now` messages whose turn-interrupt has already been issued (per message
   * id), so a slow-to-land turn_ended is not re-interrupted every step.
   * In-memory on purpose: after a daemon restart a still-undelivered `now`
   * message earns at most one fresh interrupt — idempotent and correct
   * (the message IS still urgent).
   */
  // -------------------------------------------------------------------------
  // v24 — action queue scheduling (one execution lane per bee)
  // -------------------------------------------------------------------------

  /**
   * Drive every bee with open actions: settle the active action from its
   * owner's receipt (archive command, capture report, recovery probe) or,
   * when the lane is free and unpaused, release the head of the queue iff its
   * positional predecessor succeeded. Agent instructions ride the mailbox
   * (default urgency `next`: the next accept point, never an interrupt).
   */
  private reconcileActions(scope: ReadonlySet<string> | null): void {
    const bees = this.tracked(scope, this.actionBees, () => this.store.listOpenActionBeeIds(), () => true);
    for (const beeId of bees) {
      try {
        this.reconcileActionLane(beeId);
      } catch (err) {
        if (err instanceof CoreError) {
          this.log(`action.lane_error bee=${beeId} ${err.name}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }

  private reconcileActionLane(beeId: string): void {
    if (!this.store.getBee(beeId)) { this.actionBees.delete(beeId); return; }
    const lane = this.store.listActionsOf(beeId);
    if (!lane.some(a => actionIsActive(a) || a.status === "queued")) this.actionBees.delete(beeId);
    const active = lane.find((a) => actionIsActive(a));
    if (active) {
      if (active.executor === "lifecycle.archive" && active.status === "running") {
        const res = this.store.reconcileArchiveAction(active.id);
        if (res.settled) this.log(`action.settled bee=${beeId} action=${active.id} kind=${active.kind} status=${res.action.status}`);
      } else if (active.executor === "cell.capture") {
        this.hot.add(beeId);
        if (active.status === "waiting" && active.waitingReason === "uncertain") this.reconcileUncertainCapture(active);
        else if (active.status === "waiting" && active.waitingReason === "executor") this.runCellCapture(active);
        else if (active.status === "running") {
          // Captures run synchronously inside one step; a `running` capture
          // seen by a later step lost its receipt (an executor throw between
          // begin and settle). Never guess: hold it as uncertain.
          this.store.settleAction(active.id, active.attempt, { kind: "uncertain", detail: "capture attempt has no receipt; reconciling with the Cell owner" });
        }
      } else if (active.executor === "agent" && active.status === "running") {
        this.nudgeSilentAgentAction(active);
      }
      return;
    }
    const queue = this.store.getActionQueue(beeId);
    if (queue?.paused) return;
    const head = lane.filter((a) => a.status === "queued").sort((a, b) => a.position - b.position)[0];
    if (!head) return;
    const predecessor = actionPredecessor(head, lane);
    if (predecessor && predecessor.status !== "succeeded") return;
    this.dispatchAction(head);
  }

  /**
   * bee.actions.complete.v1 — one reminder per attempt for a delivered agent action whose kind has
   * a silence threshold (ACTION_NUDGE_AFTER_MS) and that has shown no sign of
   * life (delivery, progress, an answered question) for that long. The store
   * records `dispatch.nudgedAt` with the mail, so a restart never repeats it.
   * The reminder is never completion.
   */
  private nudgeSilentAgentAction(row: ActionRow): void {
    // Question answers can postpone a reminder, never make an ineligible attempt eligible.
    if (actionNudgeDueAt(row) === null) return;
    const answeredAt = row.questionId ? this.store.getQuestion(row.questionId)?.answeredAt ?? null : null;
    const dueAt = actionNudgeDueAt(row, answeredAt === null ? [] : [answeredAt]);
    if (dueAt === null) return;
    if (this.now() < dueAt) { this.scheduleBee(row.beeId, dueAt); return; }
    const res = this.store.nudgeAgentAction(row.id, row.attempt);
    if (res) this.log(`action.nudge bee=${row.beeId} action=${row.id} attempt=${row.attempt} msg=${res.messageId}`);
  }

  private dispatchAction(head: ActionRow): void {
    switch (head.executor) {
      case "agent": {
        const res = this.store.dispatchAgentAction(head.id);
        this.log(`action.dispatch bee=${head.beeId} action=${head.id} kind=${head.kind} attempt=${res.action.attempt} status=${res.action.status} msg=${res.messageId ?? "-"}`);
        return;
      }
      case "lifecycle.archive": {
        const res = this.store.dispatchArchiveAction(head.id);
        this.log(`action.dispatch bee=${head.beeId} action=${head.id} kind=${head.kind} attempt=${res.action.attempt} status=${res.action.status} cmd=${res.commandId ?? "-"}`);
        return;
      }
      case "cell.capture":
        this.runCellCapture(head);
        return;
      case "external": {
        const res = this.store.holdActionForExecutor(head.id, `no external executor has claimed kind '${head.kind}' yet (claim through action.claim)`);
        this.log(`action.offer bee=${head.beeId} action=${head.id} kind=${head.kind} attempt=${res.action.attempt} status=${res.action.status}`);
        return;
      }
      default:
        throw new CoreError(`action ${head.id}: unknown executor ${String(head.executor)}`);
    }
  }

  private captureInputs(resolved: Record<string, unknown>): { targetBranch: string; mode: "merge" | "rebase"; commit: string | null } | { error: string } {
    const targetBranch = resolved.targetBranch;
    if (typeof targetBranch !== "string" || targetBranch.trim().length === 0) return { error: "targetBranch must be a non-empty string" };
    const mode = resolved.mode === undefined || resolved.mode === null ? "merge" : resolved.mode;
    if (mode !== "merge" && mode !== "rebase") return { error: "mode must be merge|rebase" };
    const commit = resolved.commit === undefined || resolved.commit === null ? null : resolved.commit;
    if (commit !== null && typeof commit !== "string") return { error: "commit must be a string" };
    return { targetBranch: targetBranch.trim(), mode, commit };
  }

  /**
   * cell.capture: preconditions are revalidated against the bee's CURRENT
   * placement and Cell HEAD right before the effect (never against
   * acceptance-time assumptions); the attempt is opened before the capture
   * so a crash mid-effect recovers as `uncertain`, not as a silent repeat.
   */
  private runCellCapture(row: ActionRow): void {
    const exec = this.cellCapture;
    if (!exec) {
      this.store.holdActionForExecutor(row.id, "the cell.capture executor is not available on this daemon");
      return;
    }
    const bee = this.store.getBee(row.beeId);
    if (!bee) return;
    const facts = exec.inspect(row.beeId);
    if (facts && facts.busy) {
      this.store.holdActionForExecutor(row.id, "the Cell has an in-flight operation; the capture waits for it");
      return;
    }
    const begun = this.store.beginCellCaptureAttempt(row.id, { expectedHead: facts?.head ?? null });
    const attempt = begun.action.attempt;
    if (!begun.resolved) return;
    // Placement is the Cell owner's call (`inspect` consults the registry + driver); the substrate is the bee's.
    if (bee.substrate !== "cell" || !facts) {
      this.store.settleAction(row.id, attempt, { kind: "failed", code: "placement_changed", detail: `bee ${row.beeId} is not on an active Cell (substrate ${bee.substrate}, cell ${bee.cellId ?? "none"}); land applies to Cell work only`, retryable: false });
      return;
    }
    const inputs = this.captureInputs(begun.resolved);
    if ("error" in inputs) {
      this.store.settleAction(row.id, attempt, { kind: "failed", code: "invalid_input", detail: inputs.error, retryable: false });
      return;
    }
    if (facts.head === null) {
      this.store.settleAction(row.id, attempt, { kind: "failed", code: "no_cell_head", detail: "the Cell checkout has no HEAD commit", retryable: true });
      return;
    }
    if (inputs.commit !== null && !facts.head.startsWith(inputs.commit) && !inputs.commit.startsWith(facts.head)) {
      this.store.settleAction(row.id, attempt, { kind: "failed", code: "precondition_failed", detail: `Cell HEAD is ${facts.head}, not the intended commit ${inputs.commit}; the work moved after it was committed`, retryable: true });
      return;
    }
    this.executeCapture(row, attempt, facts.head, inputs);
  }

  private executeCapture(row: ActionRow, attempt: number, cellHead: string, inputs: { targetBranch: string; mode: "merge" | "rebase" }): void {
    const exec = this.cellCapture as CellCaptureExecutor;
    let report: CaptureReport;
    try {
      report = exec.capture(row.beeId, { targetBranch: inputs.targetBranch, mode: inputs.mode, opId: `action-${row.id}-a${attempt}` });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log(`action.capture_error bee=${row.beeId} action=${row.id} ${detail}`);
      this.store.settleAction(row.id, attempt, { kind: "failed", code: "capture_error", detail, retryable: true });
      return;
    }
    const receipt = { ...report } as unknown as Record<string, unknown>;
    switch (report.status) {
      case "landed":
        this.store.settleAction(row.id, attempt, {
          kind: "succeeded",
          outputs: { resultSha: report.resultSha, targetBranch: report.targetBranch, cellHead: report.cellHead ?? cellHead, alreadyLanded: false, baseTarget: report.baseTarget },
          receipt,
        });
        break;
      case "nothing_to_capture":
        this.store.settleAction(row.id, attempt, {
          kind: "succeeded",
          outputs: { resultSha: report.baseTarget, targetBranch: report.targetBranch, cellHead: report.cellHead ?? cellHead, alreadyLanded: true, baseTarget: report.baseTarget },
          receipt,
          detail: "the target branch already contained the Cell HEAD",
        });
        break;
      case "conflict":
        this.store.settleAction(row.id, attempt, { kind: "failed", code: "conflict", detail: `conflicts in ${report.conflicts.join(", ")}`, retryable: true, receipt });
        break;
      case "refused":
        this.store.settleAction(row.id, attempt, { kind: "failed", code: `refused_${report.reason ?? "unknown"}`, detail: `capture refused: ${report.reason ?? "unknown"}`, retryable: true, receipt });
        break;
      default:
        throw new CoreError(`action ${row.id}: unknown capture status ${String((report as { status: unknown }).status)}`);
    }
    this.log(`action.capture bee=${row.beeId} action=${row.id} attempt=${attempt} status=${report.status}${report.resultSha ? ` result=${report.resultSha}` : ""}`);
  }

  /**
   * Recovery after a lost capture receipt: ask the Cell owner whether the
   * target branch already contains the HEAD the attempt captured. Yes → the
   * effect happened; settle succeeded (`reconciled`). No → the origin is
   * bit-identical by the capture's A1 guarantee, so the same attempt runs
   * again after re-checking its preconditions. Never a blind repeat.
   */
  private reconcileUncertainCapture(row: ActionRow): void {
    const exec = this.cellCapture;
    if (!exec) return;
    const expectedHead = row.dispatch?.expectedHead ?? null;
    const resolved = row.resolvedInputs ?? null;
    if (!expectedHead || !resolved) {
      this.log(`action.uncertain_unreconcilable bee=${row.beeId} action=${row.id} reason=no_expected_head`);
      return;
    }
    const inputs = this.captureInputs(resolved);
    if ("error" in inputs) return;
    const probe = exec.landed(row.beeId, { targetBranch: inputs.targetBranch, cellHead: expectedHead });
    if (!probe) return;
    if (probe.landed) {
      this.store.settleAction(row.id, row.attempt, {
        kind: "succeeded",
        outputs: { resultSha: probe.targetTip, targetBranch: inputs.targetBranch, cellHead: expectedHead, alreadyLanded: true, baseTarget: null },
        receipt: { probe: "landed", targetTip: probe.targetTip },
        detail: "reconciled after a lost receipt: the target branch contains the captured HEAD",
        reconciled: true,
      });
      this.log(`action.reconciled bee=${row.beeId} action=${row.id} attempt=${row.attempt} landed=true tip=${probe.targetTip ?? "-"}`);
      return;
    }
    const facts = exec.inspect(row.beeId);
    if (!facts || facts.busy) return;
    if (facts.head !== expectedHead) {
      this.store.settleAction(row.id, row.attempt, { kind: "failed", code: "precondition_failed", detail: `Cell HEAD is ${facts.head ?? "absent"}, not the captured ${expectedHead}; the capture did not land and the work moved`, retryable: true });
      return;
    }
    this.log(`action.reconcile_rerun bee=${row.beeId} action=${row.id} attempt=${row.attempt}`);
    this.executeCapture(row, row.attempt, expectedHead, inputs);
  }

  private readonly interruptRequested = new Set<number>();
  private readonly interruptingGeneration = new Map<string, number>();
  private readonly journalExamined = new Map<number, { beeId: string; key: string }>();
  private readonly refusedHeadRecycles = new Map<number, { beeId: string; generation: number }>();
  private readonly deliveryRetries = new Map<string, { key: string; attempts: number; nextAt: number }>();
  private readonly confirmationReady = new Map<number, string>();
  private readonly confirmationPolls = new Map<number, { beeId: string; key: string; attempts: number; nextAt: number; answerConsumed: boolean }>();

  private acceptPoint(beeId: string, generation: number): AcceptPoint {
    return this.interruptingGeneration.get(beeId) === generation ? "interrupting" : "open";
  }

  private moveAcceptPoint(beeId: string, generation: number, event: AcceptPointEvent): void {
    const next = ACCEPT_POINT_TRANSITIONS[this.acceptPoint(beeId, generation)][event];
    if (next === "interrupting") this.interruptingGeneration.set(beeId, generation);
    else if (next === "open") this.interruptingGeneration.delete(beeId);
  }

  interruptAccepted(beeId: string, generation: number): void {
    this.moveAcceptPoint(beeId, generation, "interrupt_accepted");
  }

  private holdConfirmation(intent: DeliveryConfirmationIntent, reason: DeliveryConfirmationReason): void {
    if (intent.state === "held" && intent.reason === reason) return;
    if (this.store.holdDeliveryConfirmation(intent.messageId, reason)) this.log(`deliver.held bee=${intent.beeId} msg=${intent.messageId} gen=${intent.generation} reason=${reason}`);
  }

  private releaseRefusedPlainWrite(intent: DeliveryConfirmationIntent): boolean {
    if (intent.digest === null || !refusedPlainWrite(intent) || !this.store.releaseRefusedDeliveryConfirmation(intent.messageId, intent.digest)) return false;
    this.log(`deliver.released bee=${intent.beeId} msg=${intent.messageId} gen=${intent.generation} reason=refused`);
    return true;
  }

  private holdProof(intent: DeliveryConfirmationIntent): HoldProof {
    const evidence = this.driver.deliveryEvidence?.(intent.beeId, intent.generation, intent.messageId) ?? null;
    if (evidence === null) return "none";
    if (evidence.accepted > 0) return "accepted";
    if (!plainWrite(intent)) return "none";
    const writes = this.store.deliveryWritesAuthorized(intent.beeId, intent.messageId, intent.generation);
    return writes > 0 && evidence.refused >= writes ? "refused" : "none";
  }

  private settleByJournal(intent: DeliveryConfirmationIntent, lane: HoldLane): boolean {
    const key = `${lane}:${intent.generation}:${intent.digest ?? ""}`;
    if (this.journalExamined.get(intent.messageId)?.key === key) return false;
    this.journalExamined.set(intent.messageId, { beeId: intent.beeId, key });
    const proof = this.holdProof(intent);
    const settlement = HOLD_SETTLEMENTS[proof][lane];
    if (settlement === "deliver") return this.settleAccepted(intent, true);
    if (settlement === "release") {
      if (intent.digest === null || !this.store.releaseRefusedDeliveryConfirmation(intent.messageId, intent.digest, "journal")) return false;
      this.log(`deliver.released bee=${intent.beeId} msg=${intent.messageId} gen=${intent.generation} reason=refused proof=journal`);
      return true;
    }
    if (settlement === "recycle") this.refusedHeadRecycles.set(intent.messageId, { beeId: intent.beeId, generation: intent.generation });
    return false;
  }

  private recycleForRefusedHead(intent: DeliveryConfirmationIntent, runtime: { state: RuntimeState; generation: number }): void {
    if (this.refusedHeadRecycles.get(intent.messageId)?.generation !== runtime.generation || runtime.state !== "idle") return;
    if (this.store.getBee(intent.beeId)?.lifecycle !== "active") return;
    if (this.store.hasPendingReconnect(intent.beeId, runtime.generation) || this.store.activeMoveOf(intent.beeId) || this.store.activeHandoffOf(intent.beeId) || this.store.hasPendingStopCommand(intent.beeId, runtime.generation)) return;
    this.store.enqueueCommand("stop", intent.beeId, { cause: "stopped_by_system", reason: "refused_head" });
    this.log(`policy.refused_head_stop bee=${intent.beeId} gen=${runtime.generation} msg=${intent.messageId}`);
  }

  private settleAccepted(intent: DeliveryConfirmationIntent, journalProof: boolean): boolean {
    const message = this.store.getMessage(intent.messageId);
    if (!message) return false;
    const source = this.turnTriggerSourceOf(message, isPeerSender(message.sender, id => this.store.getBee(id) != null));
    const settlement = intent.wireLine === null ? undefined : intent.settlement;
    const fallback = this.store.multilineDelivery(intent.messageId)?.fallback;
    const pointer = settlement?.multilineFallbackId
      ? fallback?.id === settlement.multilineFallbackId
      : journalProof && intent.wireLine === null && fallback != null && (fallback.state === "in_flight" || fallback.state === "unknown") && fallback.generation === intent.generation;
    const applied = settlement?.mailBatchId
      ? this.store.markMailBatchDelivered(settlement.mailBatchId, intent.generation, settlement.reorderMessageIds).applied
      : pointer
      ? this.store.completeMultilineFallback(intent.messageId, intent.generation, source, true).applied
      : journalProof
      ? this.store.markDeliveredByJournal(intent.messageId, intent.generation, source, settlement?.reorderMessageIds ?? []).applied
      : this.store.markDelivered(intent.messageId, intent.generation, source, settlement?.reorderMessageIds ?? []).applied;
    if (!applied) return false;
    this.interruptRequested.delete(intent.messageId);
    const instruction = settlement?.placementMoveId ? this.store.getBeeMove(settlement.placementMoveId) : null;
    if (instruction && intent.generation !== instruction.sourceGeneration) {
      this.store.markMoveInstructionsApplied(instruction.id);
      if (this.store.activeMoveOf(intent.beeId)?.phase === "starting") this.store.completeBeeMove(instruction.id);
    }
    const handoff = settlement?.handoffId ? this.store.getBeeHandoff(settlement.handoffId) : null;
    if (handoff?.phase === "starting" && handoff.seedMessageId === intent.messageId) this.store.completeBeeHandoff(handoff.id);
    this.log(`deliver.confirmed bee=${intent.beeId} msg=${intent.messageId} gen=${intent.generation}${journalProof ? " proof=journal" : ""}`);
    return true;
  }

  private reconcileDeliveryConfirmations(scope: ReadonlySet<string> | null): void {
    if (this.store.inTransaction) return;
    let intents: DeliveryConfirmationIntent[];
    if (scope === null) {
      intents = this.store.listDeliveryConfirmationIntents();
      this.confirmingBees.clear();
      for (const intent of intents) this.confirmingBees.add(intent.beeId);
    } else {
      intents = [];
      for (const beeId of scope) {
        if (!this.confirmingBees.has(beeId)) continue;
        const rows = this.store.listDeliveryConfirmationIntents(beeId);
        if (rows.length === 0) this.confirmingBees.delete(beeId);
        intents.push(...rows);
      }
    }
    const ids = new Set(intents.map(row => row.messageId));
    const evaluated = (beeId: string): boolean => scope === null || scope.has(beeId);
    for (const [id, poll] of this.confirmationPolls) if (evaluated(poll.beeId) && !ids.has(id)) this.confirmationPolls.delete(id);
    for (const [id, beeId] of this.confirmationReady) if (evaluated(beeId) && !ids.has(id)) this.confirmationReady.delete(id);
    for (const [id, examined] of this.journalExamined) if (evaluated(examined.beeId) && !ids.has(id)) this.journalExamined.delete(id);
    for (const [id, recycle] of this.refusedHeadRecycles) if (evaluated(recycle.beeId) && !ids.has(id)) this.refusedHeadRecycles.delete(id);
    for (const intent of intents) {
      const runtime = this.store.currentRuntime(intent.beeId);
      if (!runtime || runtime.generation !== intent.generation || runtime.state === "stopped") {
        if (!this.releaseRefusedPlainWrite(intent) && !this.settleByJournal(intent, "ended")) this.holdConfirmation(intent, "generation_changed");
        this.confirmationReady.delete(intent.messageId);
        continue;
      }
      if (intent.wireLine === null && intent.reason === "host_auth_failed" && this.driver.deliveryLaneReady?.(intent.beeId, intent.generation)) {
        this.hot.add(intent.beeId);
        this.store.releaseNeverWrittenDeliveryHold(intent.messageId, intent.generation, "host_auth_failed");
        this.confirmationPolls.delete(intent.messageId);
        this.deliveryRetries.delete(intent.beeId);
        continue;
      }
      // A never-written auth hold is not open work: it waits for the host's
      // lane, which no store change announces. Re-check it on a cadence.
      if (neverWrittenAuthHold(intent, runtime.generation)) this.scheduleBee(intent.beeId, this.now() + HOST_AUTH_RECHECK_MS);
      else this.hot.add(intent.beeId);
      if (refusedHold(intent)) continue;
      if (intent.state === "held" && intent.reason === "unknown") {
        if (this.settleByJournal(intent, "live")) {
          this.confirmationPolls.delete(intent.messageId);
          this.deliveryRetries.delete(intent.beeId);
          continue;
        }
        this.recycleForRefusedHead(intent, runtime);
      }
      if (this.confirmationReady.has(intent.messageId)) {
        if (this.now() - intent.since >= 30_000) {
          this.holdConfirmation(intent, "lane_unavailable");
          this.confirmationReady.delete(intent.messageId);
          this.confirmationPolls.delete(intent.messageId);
        }
        continue;
      }
      if (intent.state === "held" && intent.reason === "lane_unavailable") {
        const plan = this.driver.planDeliveryConfirmation?.(intent.beeId, intent.generation, intent.messageId, "");
        if (!plan || plan === "not_ready") continue;
      }
      const held = intent.state === "held";
      const key = `${intent.state}:${this.driver.deliveryReadiness?.(intent.beeId, intent.generation, intent.messageId, !held) ?? ""}`;
      const poll = this.confirmationPolls.get(intent.messageId);
      if (poll?.key === key && this.now() < poll.nextAt) {
        if (!held || poll.answerConsumed || !this.driver.deliveryStatusAnswered?.(intent.beeId, intent.generation, intent.messageId)) continue;
        poll.answerConsumed = true;
      } else {
        const attempts = poll?.key === key ? poll.attempts + 1 : 1;
        this.confirmationPolls.set(intent.messageId, { beeId: intent.beeId, key, attempts, answerConsumed: false,
          nextAt: this.now() + (held ? HELD_CONFIRMATION_POLL_MS : Math.min(30_000, 200 * 2 ** Math.min(attempts, 8)) * (0.75 + this.random() * 0.25)) });
      }
      const result = intent.wireLine === null
        ? this.driver.consumeDeliveryConfirmation?.(intent.beeId, intent.generation, intent.messageId) ? "accepted" : "pending_ack"
        : this.driver.reconcileDeliveryConfirmation?.(intent.beeId, intent.generation, intent.messageId, intent) ?? "unknown";
      if (result === "accepted") {
        if (!this.store.getMessage(intent.messageId)) continue;
        this.settleAccepted(intent, false);
        this.confirmationReady.delete(intent.messageId);
        this.confirmationPolls.delete(intent.messageId);
        this.deliveryRetries.delete(intent.beeId);
      } else if (intent.state === "held" && intent.reason === "message_too_large") {
        continue;
      } else if (result === "not_written") {
        if (intent.wireLine === null) continue;
        if (this.ext.isDegraded?.(intent.beeId, intent.generation)) {
          this.store.replanDeliveryConfirmationIntent(intent, intent.digest);
          this.store.releaseUnwrittenDeliveryConfirmation(intent.messageId, intent.generation, intent.digest);
          this.confirmationPolls.delete(intent.messageId);
          this.confirmationReady.delete(intent.messageId);
        } else {
          this.store.replanDeliveryConfirmationIntent(intent, intent.digest);
          this.confirmationReady.set(intent.messageId, intent.beeId);
        }
      } else if (result === "refused") {
        if (intent.wireLine === null) continue;
        if (this.store.retryRefusedDeliveryConfirmation(intent.messageId, intent.generation, intent.digest)) this.confirmationReady.set(intent.messageId, intent.beeId);
        else {
          this.confirmationReady.delete(intent.messageId);
          if (refusedHold(this.store.getDeliveryConfirmationIntent(intent.messageId))) this.log(`deliver.held bee=${intent.beeId} msg=${intent.messageId} gen=${intent.generation} reason=refused`);
        }
      } else if (result !== "pending_ack") {
        this.confirmationReady.delete(intent.messageId);
        this.holdConfirmation(intent, result);
      } else if (intent.state === "awaiting_confirmation" && this.now() - intent.since >= 30_000) {
        this.holdConfirmation(intent, "unknown");
      }
    }
  }

  /**
   * Eligibility/ordering rule (Q2 amendment): urgency governs WHEN a message
   * becomes eligible for delivery —
   *   next — always eligible (today's behavior: the harness's accept point);
   *   now  — always eligible; mid-turn it additionally asks the driver to
   *          interrupt the current turn (once), then delivers at the
   *          resulting accept point;
   *   idle — eligible unless a REAL turn is running: `running` on synthetic
   *          boot evidence alone is provisional (open accept point, nothing
   *          to disturb) and does not gate idle mail (a running turn
   *          is never disturbed; revive-on-message for stopped bees is
   *          unchanged and urgency never affects wakes).
   * Among ELIGIBLE messages, enqueue order (per-bee FIFO, Q2) wins: an `idle`
   * message waiting out a turn does not block a later `next`/`now` message
   * from delivering at the next accept point.
   */
  private deliveryLoop(work: readonly DaemonWorkRow[], scope: ReadonlySet<string> | null): void {
    const unsupportedAttempts = new Set<number>();
    const retryBees = new Set(work.map(row => row.runtime.beeId));
    for (const beeId of this.deliveryRetries.keys()) if ((scope === null || scope.has(beeId)) && !retryBees.has(beeId)) this.deliveryRetries.delete(beeId);
    if (scope !== null && scope.size === 0 && !this.multilineCleanupPending) return;
    if (this.multilineFallback) this.multilineCleanupPending = this.multilineFallback.cleanupDeleted() > 0;
    const quarantines = this.multilineFallback ? this.store.multilinePaneQuarantines() : [];
    const heldMail = this.multilineFallback ? this.store.heldMultilineMail() : null;
    if (heldMail) for (const [beeId, pending] of heldMail) {
      if (pending.some(row => row.fallback?.id === "" || row.fallback && ["in_flight", "unknown"].includes(row.fallback.state))) this.hot.add(beeId);
      heldMail.set(beeId, pending.filter(row => {
        if (row.fallback?.id === "") this.store.reconcileUnknownMultilineHold(row.id);
        if (!row.fallback || !["in_flight", "unknown"].includes(row.fallback.state)) return true;
        const message = this.store.getMessage(row.id);
        if (!message) return false;
        const peer = isPeerSender(message.sender, id => this.store.getBee(id) != null);
        return !this.multilineFallback!.reconcile(message, this.turnTriggerSourceOf(message, peer));
      }));
    }
    for (const row of quarantines) this.hot.add(row.beeId);
    try {
      for (const { runtime: rt, pending: ordinaryPending } of work) {
        const hotBeforeDelivery = this.hot.has(rt.beeId);
        if (ordinaryPending.length > 0 || (heldMail?.get(rt.beeId)?.length ?? 0) > 0) this.hot.add(rt.beeId);
        let quarantined = false;
        for (const row of quarantines) {
          if (row.beeId !== rt.beeId) continue;
          this.hot.add(rt.beeId);
          const pane = row.fallback!.paneInput!;
          if (pane.generation !== rt.generation) {this.store.clearMultilinePaneQuarantine(row.messageId, rt.generation); continue;}
          quarantined = true;
        }
        if (quarantined) continue;
        const quotaGate = this.store.quotaDeliveryGate(rt.beeId);
        if (quotaGate.held) { this.deliveryRetries.delete(rt.beeId); continue; }
        const allPending = this.multilineFallback
          ? [...new Map([...ordinaryPending, ...(heldMail!.get(rt.beeId) ?? []).filter(message => this.multilineFallback!.eligible(rt.beeId, message.id, message.fallback))].map(message => [message.id,message])).values()].sort((a, b) => (a.queueOrder ?? a.id) - (b.queueOrder ?? b.id) || a.id - b.id)
          : ordinaryPending;
        const pending = quotaGate.messageIds.length > 0 ? allPending.filter(message => quotaGate.messageIds.includes(message.id)) : allPending;
        const authHead = pending[0];
        const authFallback = authHead ? this.store.multilineDelivery(authHead.id)?.fallback : null;
        if (authHead && !authFallback && !this.store.inTransaction && this.driver.deliveryIssue?.(rt.beeId, rt.generation, authHead.id) === "host_auth_failed") {
          const prior = this.store.getDeliveryConfirmationIntent(authHead.id);
          if (!prior) {
            this.store.prepareUnknownDeliveryConfirmationIntent({ beeId: rt.beeId, messageId: authHead.id, generation: rt.generation }, "host_auth_failed");
            this.log(`deliver.held bee=${rt.beeId} msg=${authHead.id} reason=host_auth_failed`);
          }
          // The FIFO head stays held and nothing behind it may overtake, so
          // there is nothing to deliver until the host's auth recovers.
          if (!prior || neverWrittenAuthHold(prior, rt.generation)) {
            if (!hotBeforeDelivery) this.hot.delete(rt.beeId);
            this.scheduleBee(rt.beeId, this.now() + HOST_AUTH_RECHECK_MS);
            continue;
          }
        }
        if (rt.state === "booting") continue;
        if (this.acceptPoint(rt.beeId, rt.generation) === "interrupting") continue;
        if (rt.state === "idle" && this.store.hasPendingReconnect(rt.beeId, rt.generation)) continue;
        const threadOperation = this.store.threadOperationForSuccessor(rt.beeId);
        if (threadOperation && threadOperation.phase !== "ready") continue;
        if (pending.length === 0) { this.deliveryRetries.delete(rt.beeId); continue; }
        // `running` on nothing but a SYNTHETIC boot is provisional (v9): the
        // driver's accept point is open and no real turn exists to disturb, so
        // `idle` mail is eligible. Without this, idle mail sent to a stopped
        // readyAtSpawn bee revives a runtime it can then never deliver to —
        // hang-stop → wake → revive, churning generations (found 2026-08-19 by
        // budget.11's race; real claude would end mis-flagged spawn_failed).
        // Any real parsed output upgrades bootEvidence and re-engages the gate.
        const trulyMidTurn = rt.state === "running" && rt.bootEvidence === "real";
        const humanState = this.humanFirstState(rt.beeId, rt.generation);
        const humanFirst = humanState.enabled;
        const batching = this.store.mailBatchingPolicy(rt.beeId).enabled;
        const humanHead = humanState.head;
        const humanPending = humanHead !== null;
        const eligible = quotaGate.messageIds.length > 0
          ? pending.filter(message => !trulyMidTurn || message.urgency !== "idle")
          : pending.filter(message => this.humanFirstEligible(message, trulyMidTurn, humanState));
        const urgentHuman = humanFirst ? pending.find(message => message.humanChat !== undefined && message.urgency === "now" && !this.interruptRequested.has(message.id) && !this.store.getDeliveryConfirmationIntent(message.id)) : undefined;

        if (!humanFirst && eligible.length === 0) continue;
        const move = this.store.activeMoveOf(rt.beeId);
        if (move && move.phase !== "starting") continue;
        // v23: a quiescing source takes no new turn; the target runtime receives
        // the context seed before any queued user mail (FIFO among user mail
        // is untouched — the seed is Honeybee-owned context, not a message
        // that jumped the queue).
        const handoff = this.store.activeHandoffOf(rt.beeId);
        if (handoff && handoffFencesSource(handoff.phase)) continue;
        const handoffSeedId = this.store.pendingHandoffSeedMessageId(rt.beeId);
        const seedId = handoffSeedId ?? humanState.seed;
        const seedCandidate = seedId == null ? null : pending.find((m) => m.id === seedId) ?? null;
        const seed = seedCandidate && (handoffSeedId !== null || this.humanFirstEligible(seedCandidate, trulyMidTurn, humanState)) ? seedCandidate : null;
        if (eligible.length === 0 && !seed && !urgentHuman) continue;
        let admission: boolean | undefined;
        const turnAdmitted = (): boolean => trulyMidTurn || !this.beforeTurn || (admission ??= this.beforeTurn(rt.beeId, rt.generation));
        if (rt.state === "running") {
          // Mid-turn `now`: interrupt first (the v6 verb), then deliver. One
          // interrupt per message; an eligible `now` behind an undelivered
          // `next` still interrupts — the accept point it creates serves the
          // whole FIFO, which keeps delivering in enqueue order.
          const urgent = urgentHuman ?? eligible.find((m) => !batching && m.urgency === "now" && !this.interruptRequested.has(m.id) && !this.store.getDeliveryConfirmationIntent(m.id));
          if (urgent) {
            if (!turnAdmitted()) { this.deliveryRetries.delete(rt.beeId); continue; }
            // Give the driver the triggering mailbox id so an asynchronously
            // confirmed delivery cannot interrupt the turn it just opened.
            const res = this.driver.interrupt(rt.beeId, rt.generation, urgent.id);
            // no_process / not_ready resolve on later steps (exit observation,
            // driver-side boot skew) — retry then. interrupted / idle /
            // unsupported are final: the accept point exists or never will.
            if (res.interrupted || res.reason === "idle" || res.reason === "unsupported") {
              this.interruptRequested.add(urgent.id);
            }
            this.log(
              `deliver.interrupt bee=${rt.beeId} msg=${urgent.id} gen=${rt.generation} interrupted=${res.interrupted}` +
                (res.reason ? ` reason=${res.reason}` : ""),
            );
            // A successful interrupt closes the current accept point
            // asynchronously. Do not race an immediate delivery (Codex would
            // reject turn/steer after turn/interrupt; tmux could type before
            // the TUI settles). The observed turn_ended opens the next point.
            if (res.interrupted) {
              if (res.closesAcceptPoint) this.interruptAccepted(rt.beeId, rt.generation);
              this.store.recordDeliveryInterrupt(rt.beeId, urgent.id, rt.generation, res.closesAcceptPoint === true);
              continue;
            }
          }
        }
        let selected = seed ?? eligible.find(message => !batching || this.batchingEligible(rt.beeId,message.id,trulyMidTurn));
        if (batching && !seed && !trulyMidTurn && !humanState.active && humanState.head === null && quotaGate.messageIds.length === 0) {
          const priority = eligible.find(message => this.store.getMessage(message.id)?.humanChat || this.store.mailBatchControl(message.id) || automationDeliveryClass(this.store.getMessage(message.id)?.automationKind) !== "ordinary");
          selected = priority ?? selected;
        }
        let batch = selected && quotaGate.messageIds.length === 0 ? this.store.mailBatchForMessage(selected.id) : null;
        if (batching && selected && quotaGate.messageIds.length === 0 && !seed && !this.store.getMessage(selected.id)?.humanChat && !this.store.mailBatchControl(selected.id) && automationDeliveryClass(this.store.getMessage(selected.id)?.automationKind) === "ordinary") {
          if (!batch && !turnAdmitted()) { this.deliveryRetries.delete(rt.beeId); continue; }
          batch = this.store.freezeMailBatch(rt.beeId);
          if (!batch || batch.memberIds[0] !== selected.id) continue;
        }
        if (batch && batch.memberIds[0] !== selected?.id) continue;
        if (batch) batch = this.store.noteMailBatchRelease(batch.id,this.confirmationReady.has(batch.memberIds[0]!));
        if (!selected || humanFirst && humanPending && selected.humanChat !== undefined && selected.id !== humanHead && !seed && quotaGate.messageIds.length === 0) continue;
        if (humanFirst && this.store.listDeliveryConfirmationIntents(rt.beeId).some(intent => intent.messageId !== selected.id && intent.wireLine !== null && intent.state === "awaiting_confirmation" && intent.generation === rt.generation && !this.confirmationReady.has(intent.messageId))) continue;
        const msg = this.store.getMessage(selected.id);
        if (
          !msg ||
          msg.beeId !== rt.beeId ||
          msg.deliveredAt !== null ||
          msg.urgency !== selected.urgency ||
          msg.enqueuedAt !== selected.enqueuedAt
        ) {
          throw new CoreError(`daemon projection: selected message ${selected.id} changed before delivery`);
        }
        // Peer-sent mail carries the sender-attribution envelope (envelope.ts);
        // question answers and automation (by sender kind or automation sender)
        // carry their own markers; other operator/human mail is delivered bare.
        // The mailbox row stays the durable truth — the envelope is
        // delivery-time rendering only.
        if (msg.deliveryHold?.detail === "delivery_hold_state_unknown") {this.store.reconcileUnknownMultilineHold(msg.id); continue;}
        const freshTurn = (humanFirst || batching) && msg.humanChat !== undefined && msg.urgency !== "now" || batch !== null || batching && (msg.automationKind !== undefined || this.store.mailBatchControl(msg.id));
        const peer = isPeerSender(msg.sender, (id) => this.store.getBee(id) != null);
        const interruptedTurn = msg.urgency === "now" && this.store.deliveryInterruptedTurn(rt.beeId, msg.id, rt.generation);
        const reorderNotice = this.store.multilineReorderNotice(rt.beeId, msg.id);
        const instruction = this.store.placementInstructionMove(rt.beeId);
        const prefixBody = (text: string): string => {
          const reordered = (reorderNotice.text ?? "") + text;
          return instruction && rt.generation !== instruction.sourceGeneration
            ? prefixPlacementDelivery(reordered,placementContextText({placementVersion:instruction.to.version,cwd:instruction.to.cwd,cellId:instruction.retainedCellId}))
            : reordered;
        };
        let body = deliveryText(msg, peer, interruptedTurn, this.store.answeredQuestionId(msg.id), this.store.dismissedQuestionId(msg.id));
        if (batch) {
          const members = batch.memberIds.map(id => this.store.getMessage(id));
          if (members.some(member => !member || member.mailBatchId !== batch.id || member.deliveredAt !== null)) {
            if (this.store.getDeliveryConfirmationIntent(msg.id)) this.store.holdDeliveryConfirmation(msg.id,"unknown");
            this.log(`deliver.held bee=${rt.beeId} batch=${batch.id} reason=batch_membership_changed`);
            continue;
          }
          const rendered = renderMailBatch(batch,members as MessageRow[],32768 - Buffer.byteLength(prefixBody("")));
          if (rendered === null) {
            if (!this.store.getDeliveryConfirmationIntent(msg.id)) this.store.prepareUnknownDeliveryConfirmationIntent({beeId:rt.beeId,messageId:msg.id,generation:rt.generation},"message_too_large");
            continue;
          }
          body = rendered;
        }
        if (!batch && !msg.phoneInput && msg.sender === "automation:delivery" && msg.senderKind === "automation" && this.store.multilineSenderNotice(msg.id)) body = msg.body;
        body = prefixBody(body);
        const readiness = this.driver.deliveryReadiness?.(rt.beeId, rt.generation, msg.id) ?? "";
        const retryKey = JSON.stringify([msg.id, msg.urgency, rt.generation, rt.state, rt.updatedAt, readiness, msg.deliveryHold?.stage, this.store.inTransaction]);
        const retry = this.deliveryRetries.get(rt.beeId);
        if (retry && retry.key === retryKey && this.now() < retry.nextAt) continue;
        const backOff = (): void => {
          const attempts = retry?.key === retryKey ? retry.attempts + 1 : 1;
          const delay = Math.min(30_000, 200 * 2 ** Math.min(attempts, 8)) * (0.75 + this.random() * 0.25);
          this.deliveryRetries.set(rt.beeId, { key: retryKey, attempts, nextAt: this.now() + delay });
        };
        const refusePlan = (): void => {
          if (this.store.inTransaction) return;
          backOff();
          this.log(`deliver.refused bee=${rt.beeId} msg=${msg.id} reason=not_ready detail=confirmation_plan_not_ready`);
        };
        const fallbackHold = this.store.multilineDelivery(msg.id);
        const holdIssue = (issue: "host_auth_failed" | "message_too_large"): void => {
          const prior = this.store.getDeliveryConfirmationIntent(msg.id);
          const alreadyHeld = prior?.state === "held" && prior.reason === issue;
          if (prior?.wireLine != null) this.store.holdDeliveryConfirmation(msg.id, issue);
          else this.store.prepareUnknownDeliveryConfirmationIntent({ beeId: rt.beeId, messageId: msg.id, generation: rt.generation }, issue);
          this.confirmationReady.delete(msg.id);
          if (!alreadyHeld) this.log(`deliver.held bee=${rt.beeId} msg=${msg.id} reason=${issue}`);
        };
        const usesFallback = fallbackHold && (fallbackHold.fallback || ["held", "expired"].includes(fallbackHold.stage));
        const initialIssue = usesFallback ? null : this.driver.deliveryIssue?.(rt.beeId, rt.generation, msg.id, body);
        if (initialIssue && !this.store.inTransaction) {
          holdIssue(initialIssue);
          continue;
        }
        const fallback = batch ? undefined : this.multilineFallback?.deliver(msg, body, rt.generation, peer, this.store.answeredQuestionId(msg.id), this.turnTriggerSourceOf(msg, peer), reorderNotice.messageIds, turnAdmitted);
        if (fallback?.turnRefused) { this.deliveryRetries.delete(rt.beeId); continue; }
        if (fallback?.confirmationBody) body = fallback.confirmationBody;
        const issue = fallback?.confirmationBody ? this.driver.deliveryIssue?.(rt.beeId, rt.generation, msg.id, body) : null;
        if (issue && !this.store.inTransaction) {
          holdIssue(issue);
          continue;
        }
        let confirmation: DeliveryConfirmationPlan | undefined;
        let writeIntent: (() => DeliveryConfirmationPlan) | null = null;
        const settlement = { ...(batch ? { mailBatchId: batch.id, batchMemberIds: batch.memberIds } : {}), reorderMessageIds: reorderNotice.messageIds, placementMoveId: instruction?.id ?? null,
          handoffId: handoff?.id ?? null, ...(fallback?.confirmationBody ? { multilineFallbackId: this.store.multilineDelivery(msg.id)?.fallback?.id } : {}) };
        const recordPointerAttempt = (): void => {
          let pointer = fallback?.confirmationBody ? this.store.multilineDelivery(msg.id)?.fallback : null;
          if (pointer?.state === "in_flight" || pointer?.state === "unknown") pointer = this.store.transitionMultilineFallback(msg.id, pointer.state, "ready", { detail: "delivery_not_attempted", attemptPhase: "before_enter_cleared" });
          if (pointer?.state === "ready") this.store.transitionMultilineFallback(msg.id, "ready", "in_flight", { generation: rt.generation, attempts: (pointer.attempts ?? 0) + 1, attemptPhase: "injecting" });
        };
        if (!fallback?.handled) {
          const existing = this.store.getDeliveryConfirmationIntent(msg.id);
          if (existing) {
            const refused = refusedHold(existing);
            if (existing.generation !== rt.generation || existing.wireLine === null || !refused && (existing.state !== "awaiting_confirmation" || !this.confirmationReady.has(msg.id))) continue;
            const plan = this.driver.planDeliveryConfirmation?.(rt.beeId, rt.generation, msg.id, body, { freshTurn });
            if (refused && (!plan || plan === "not_ready" || plan.digest === existing.digest)) { if (!this.store.inTransaction) backOff(); continue; }
            if (!plan || plan === "not_ready") { refusePlan(); continue; }
            if (this.store.inTransaction) continue;
            const input = { beeId: rt.beeId, messageId: msg.id, generation: rt.generation, wireLine: plan.wireLine, digest: plan.digest, host: plan.host, settlement };
            if (!deliveryConfirmationIntentFits(input)) { holdIssue("message_too_large"); continue; }
            writeIntent = () => {
              const row = this.store.transact(() => { const row = this.store.replanDeliveryConfirmationIntent(input, existing.digest); recordPointerAttempt(); return row; });
              this.confirmationReady.delete(msg.id);
              if (refused) this.log(`deliver.replanned bee=${rt.beeId} msg=${msg.id} gen=${rt.generation} after=refused`);
              return row;
            };
          } else {
            const plan = this.driver.planDeliveryConfirmation?.(rt.beeId, rt.generation, msg.id, body, { freshTurn });
            if (plan === "not_ready") { refusePlan(); continue; }
            if (plan) {
              if (this.store.inTransaction) continue;
              const input = { beeId: rt.beeId, messageId: msg.id, generation: rt.generation, wireLine: plan.wireLine, digest: plan.digest, host: plan.host, settlement };
              if (!deliveryConfirmationIntentFits(input)) {
                this.store.prepareUnknownDeliveryConfirmationIntent({ beeId: rt.beeId, messageId: msg.id, generation: rt.generation }, "message_too_large");
                continue;
              }
              const prepareIntent = (): DeliveryConfirmationPlan => this.store.transact(() => { const row = this.store.prepareDeliveryConfirmationIntent(input); recordPointerAttempt(); return row; });
              if (!plan.supported && !plan.legacyFirstWriteSafe) {
                prepareIntent();
                this.store.holdDeliveryConfirmation(msg.id, "old_host");
                continue;
              }
              writeIntent = prepareIntent;
            }
          }
          if (!turnAdmitted()) { this.deliveryRetries.delete(rt.beeId); continue; }
          confirmation = writeIntent?.();
        }
        const outcome = fallback?.handled ? { accepted: fallback.accepted, reason: "not_ready" as const, detail: undefined }
          : this.driver.deliver(rt.beeId, rt.generation, msg.id, body, { confirmation, freshTurn, multilineWaitExpired: msg.deliveryHold?.stage === "expired" });
        if (outcome.accepted) {
          this.deliveryRetries.delete(rt.beeId);
          if (fallback?.confirmationBody) this.store.completeMultilineFallback(msg.id, rt.generation, this.turnTriggerSourceOf(msg, peer), true);
          else if (!fallback?.handled) {
            if (batch) this.store.markMailBatchDelivered(batch.id,rt.generation,reorderNotice.messageIds);
            else this.store.markDelivered(msg.id, rt.generation, this.turnTriggerSourceOf(msg, peer), reorderNotice.messageIds);
          }
          const deliveredGeneration = fallback?.generation ?? rt.generation;
          this.interruptRequested.delete(msg.id);
          if (instruction && deliveredGeneration === rt.generation && rt.generation !== instruction.sourceGeneration) {
            this.store.markMoveInstructionsApplied(instruction.id);
            if (this.store.activeMoveOf(rt.beeId)?.phase === "starting") {
              this.store.completeBeeMove(instruction.id);
            }
          }
          if (seed && msg.id === seed.id && deliveredGeneration === rt.generation) {
            const active = this.store.activeHandoffOf(rt.beeId);
            if (active?.phase === "starting" && active.seedMessageId === msg.id) {
              this.store.completeBeeHandoff(active.id);
              this.log(`handoff.complete bee=${rt.beeId} handoff=${active.id} gen=${rt.generation}`);
            }
          }
          this.log(`deliver bee=${rt.beeId} msg=${msg.id} gen=${deliveredGeneration} urgency=${msg.urgency}`);
        } else {
          if (!fallback?.handled && body.includes("\n")) {
            if (outcome.reason === "not_ready" && outcome.detail !== undefined && MULTILINE_UNSUPPORTED_DETAILS.some(detail => detail === outcome.detail)) {
              this.store.recordMultilineDeliveryRefusal(msg.id, rt.generation, outcome.detail);
              unsupportedAttempts.add(msg.id);
            }
            else this.store.pauseMultilineDeliveryWait(msg.id);
          }
          if (outcome.reason === "not_ready" && !unsupportedAttempts.has(msg.id) && !this.store.inTransaction) backOff();
          else this.deliveryRetries.delete(rt.beeId);
          this.log(outcome.pendingConfirmation
            ? `deliver.pending bee=${rt.beeId} msg=${msg.id} gen=${rt.generation} urgency=${msg.urgency}`
            : `deliver.refused bee=${rt.beeId} msg=${msg.id} reason=${outcome.reason}` + (outcome.detail ? ` detail=${outcome.detail}` : ""));
        }
      }
    } finally { this.store.retainMultilineDeliveryWaits(unsupportedAttempts); }
  }

  // -------------------------------------------------------------------------
  // I1 telemetry — the 99.99% counter (spec 04 behavior 5)
  // -------------------------------------------------------------------------

  /**
   * Mirrors the harness checker's I1 shape: per-bee pending queue, position-
   * aware deadlines, and a suspended clock while a closed-list flag is active
   * (a visibly blocked bee is at an external boundary — I3/I6 territory).
   */
  private readonly reportedHumanWait = new Map<number, string>();

  private readonly humanEligibilitySince = new Map<number, { beeId: string; at: number }>();

  private humanFirstState(beeId: string, generation = this.store.currentRuntime(beeId)?.generation ?? -1) {
    const policy = this.store.humanFirstPolicy(beeId);
    const enabled = policy.enabled || this.store.mailBatchingPolicy(beeId).enabled;
    return { enabled, seed: enabled ? this.store.pendingHumanFirstSeedMessageId(beeId) : null, head: enabled ? this.store.pendingHumanChatId(beeId) : null, active: enabled && (this.store.humanTurnActive(beeId, generation) || this.store.mailBatchingPolicy(beeId).enabled && this.batchingTurnActive(beeId,generation)) };
  }

  private humanFirstEligible(message: Pick<MessageRow, "id" | "urgency" | "humanChat">, midTurn: boolean, state: ReturnType<DaemonCore["humanFirstState"]>): boolean {
    if (state.enabled && state.seed !== null) return message.id === state.seed && !midTurn && !state.active;
    if (state.enabled && (state.head !== null || state.active)) {
      if (message.id !== state.head) return false;
      return !(midTurn || state.active) || message.urgency === "now";
    }
    return !midTurn || message.urgency !== "idle";
  }

  private batchingTurnActive(beeId: string, generation: number): boolean {
    const trigger = this.store.getBee(beeId)?.lastTurnTrigger;
    if (!trigger || trigger.generation !== generation || trigger.endedAt !== null || trigger.messageId === null) return false;
    const message = this.store.getMessage(trigger.messageId);
    return message?.mailBatchId !== undefined || message?.automationKind !== undefined || message != null && this.store.mailBatchControl(message.id);
  }

  private batchingEligible(beeId: string, messageId: number, midTurn: boolean): boolean {
    if (!this.store.mailBatchingPolicy(beeId).enabled) return true;
    const message = this.store.getMessage(messageId);
    if (!message) return false;
    if (message.humanChat) return true;
    if (this.store.pendingHumanFirstSeedMessageId(beeId) === messageId || this.store.pendingHandoffSeedMessageId(beeId) === messageId) return true;
    if (midTurn) return false;
    if (this.store.mailBatchControl(messageId) || automationDeliveryClass(message.automationKind) !== "ordinary") return true;
    const batch = this.store.mailBatchForMessage(messageId);
    return this.store.mailBatchReleaseReason(beeId) !== null && (batch ? batch.memberIds[0] === messageId : this.store.mailBatchCandidate(messageId));
  }

  private recoverOverdue(beeId: string): void {
    this.deliveryRetries.delete(beeId);
    for (const intent of this.store.listDeliveryConfirmationIntents(beeId)) this.confirmationPolls.delete(intent.messageId);
    this.hot.add(beeId);
    const runtime = this.store.currentRuntime(beeId);
    const wake = !runtime || runtime.state === "stopped" ? this.store.enqueueWake(beeId) : null;
    this.log(`i1.recover bee=${beeId} runtime=${runtime?.state ?? "none"}` + (wake ? ` wake=${wake.outcome}` : ""));
  }

  private i1Telemetry(rows: readonly I1PendingBee[], scope: ReadonlySet<string> | null): void {
    const bound = this.policy.i1DeadlineSteps as number;
    const record = this.onI1Violation as (violation: I1ViolationEvent) => void;
    const now = this.now();
    const seenPolicyMessages = new Set<number>();
    const seenHumanWait = new Set<number>();
    const monitored = [...rows];
    const present = new Set(rows.map(row => row.beeId));
    const humanFirstBees = this.tracked(scope, this.humanFirstBees,
      () => this.store.listHumanFirstPolicies().filter(policy => policy.enabled).map(policy => policy.beeId),
      beeId => this.store.humanFirstPolicy(beeId).enabled);
    const batchingBees = scope === null ? [...this.batchingBees] : [...scope].filter(beeId => this.batchingBees.has(beeId));
    const policyBees = [...new Set([...humanFirstBees, ...batchingBees])];
    for (const beeId of policyBees) {
      if (present.has(beeId)) continue;
      const runtime = this.store.currentRuntime(beeId);
      if (runtime && runtime.state !== "stopped" && this.store.humanTurnActive(beeId,runtime.generation)) { monitored.push({beeId,runtime,hasActiveFlag:this.store.activeFlags(beeId).length > 0,pending:[]}); present.add(beeId); }
    }
    for (const { beeId, runtime: rt, hasActiveFlag, pending } of monitored) {
      let nextAt: number | null = null;
      const wakeAt = (at: number): void => { if (nextAt === null || at < nextAt) nextAt = at; };
      const humanState = this.humanFirstState(beeId);
      const midTurn = rt?.state === "running" && rt.bootEvidence === "real";
      const seedId = humanState.enabled ? this.store.pendingHandoffSeedMessageId(beeId) : null;
      const quotaGate = humanState.enabled ? this.store.quotaDeliveryGate(beeId) : null;
      if (hasActiveFlag) {
        for (const message of pending) this.humanEligibilitySince.delete(message.id);
        continue;
      }
      if (humanState.enabled && !quotaGate?.held) {
        const trigger = this.store.getBee(beeId)?.lastTurnTrigger;
        const waiting = humanState.head === null ? null : this.store.getMessage(humanState.head);
        const active = humanState.active && trigger?.messageId !== null && trigger?.messageId !== undefined ? this.store.getMessage(trigger.messageId) : null;
        const heldHuman = waiting && !this.humanFirstEligible(waiting,midTurn,humanState) ? waiting : active;
        if (heldHuman) {
          seenHumanWait.add(heldHuman.id);
          const base = heldHuman.id === active?.id && trigger ? trigger.startedAt : heldHuman.enqueuedAt;
          const deadline = base + (this.policy.humanFirstWaitMs ?? 600_000);
          if (now <= deadline && !this.reportedHumanWait.has(heldHuman.id)) wakeAt(deadline + 1);
          if (now > deadline && !this.reportedHumanWait.has(heldHuman.id)) {
            this.reportedHumanWait.set(heldHuman.id, beeId);
            const detail = `human_first_wait message=${heldHuman.id} deadline=${deadline} now=${now}; turn end is unobserved or the human turn remains open`;
            record({detectedAt:now,beeId,messageId:heldHuman.id,enqueuedAt:heldHuman.enqueuedAt,deadline,detail});
            this.log(`i1.human_first_wait bee=${beeId} msg=${heldHuman.id} deadline=${deadline}`);
          }
        }
      }
      pending.forEach((m, pos) => {
        // v8 (Q2 amendment): an `idle` message's deadline clock starts when it
        // becomes ELIGIBLE (the runtime not `running`), not at enqueue — a
        // long turn is exactly what `idle` opted into waiting for, never an
        // I1 violation. While the runtime is running the clock is suspended;
        // once out of `running`, the base is that transition (rt.updatedAt).
        let base = m.enqueuedAt;
        if (humanState.enabled) {
          seenPolicyMessages.add(m.id);
          const quotaContinuation = quotaGate?.messageIds.includes(m.id) === true;
          const heldByQuota = quotaGate?.held || quotaGate && quotaGate.messageIds.length > 0 && !quotaContinuation;
          const heldByHuman = m.id !== seedId && !quotaContinuation && (!this.humanFirstEligible(m, midTurn, humanState) || !this.batchingEligible(beeId,m.id,midTurn));
          if (heldByQuota || heldByHuman) { this.humanEligibilitySince.delete(m.id); return; }
          const eligibleAt = this.humanEligibilitySince.get(m.id)?.at ?? now;
          this.humanEligibilitySince.set(m.id, { beeId, at: eligibleAt });
          base = Math.max(base, eligibleAt);
        }
        if (m.urgency === "idle") {
          // Mirrors the delivery rule: synthetic-boot `running` is provisional
          // — idle mail is ELIGIBLE there, so its clock runs (else the churn
          // this rule prevents would also be invisible to I1).
          if (rt?.state === "running" && rt.bootEvidence === "real") return;
          base = Math.max(base, rt?.updatedAt ?? m.enqueuedAt);
        }
        const deadline = base + (pos + 1) * bound;
        if (this.reportedI1.has(m.id)) return;
        if (now <= deadline) { wakeAt(deadline + 1); return; }
        this.reportedI1.add(m.id);
        const detail = `message ${m.id} undelivered past deadline (enqueued=${m.enqueuedAt} urgency=${m.urgency} pos=${pos} deadline=${deadline} now=${now})`;
        record({ detectedAt: now, beeId, messageId: m.id, enqueuedAt: m.enqueuedAt, deadline, detail });
        this.log(`i1.violation bee=${beeId} msg=${m.id} deadline=${deadline}`);
        this.recoverOverdue(beeId);
      });
      if (nextAt !== null) this.scheduleBee(beeId, nextAt);
    }
    const evaluated = (beeId: string): boolean => scope === null || scope.has(beeId);
    for (const [id, entry] of this.humanEligibilitySince) if (evaluated(entry.beeId) && !seenPolicyMessages.has(id)) this.humanEligibilitySince.delete(id);
    for (const [id, beeId] of this.reportedHumanWait) if (evaluated(beeId) && !seenHumanWait.has(id)) this.reportedHumanWait.delete(id);
  }

  /**
   * Committed zero-pending clear of the delivery dedup sets. Once no
   * undelivered mail exists in COMMITTED state, every retained message id is
   * terminal (delivered_at never unsets; canceled/bee-deleted rows are gone)
   * and can never be interrupt-eligible or overdue again. Never prunes
   * inside an open transaction: a step under public store.transact reads
   * uncommitted delivery/cancel/delete facts, and clearing on those before
   * an outer rollback would resurrect messages without their dedup entries
   * (duplicate interrupts and I1 reports). The mail-only probe is deliberate
   * — live runtimes must not block the clear, and sparse work rows omit
   * stopped-target mail. Under a standing backlog, pending ids are always
   * retained and terminal ids leave via the bounded sweep below.
   */
  private pruneDeliveryDedup(latestI1: readonly I1PendingBee[] | null): void {
    if (this.reportedI1.size === 0 && this.interruptRequested.size === 0) {
      this.resetSweepState(0);
      return;
    }
    if (this.store.inTransaction) return;
    if (!this.store.hasUndeliveredMessages()) {
      this.reportedI1.clear();
      this.interruptRequested.clear();
      this.resetSweepState(0);
      return;
    }
    // Bounded nonempty sweep. Trigger: combined-size GROWTH since the last
    // sweep or the step cadence, both reset after every sweep regardless of
    // how much was pruned. A STABLE retained backlog can never re-fire the
    // growth term, so it sweeps at most once per cadence window; sustained
    // ≥threshold growth sweeps as often as it grows, bounded by that growth.
    this.sweepTicks += 1;
    const size = this.reportedI1.size + this.interruptRequested.size;
    if (this.sweepTicks < DEDUP_SWEEP_CADENCE_TICKS && size - this.sizeAtLastSweep < DEDUP_SWEEP_GROWTH) return;
    // Scratch scales with the TRACKED ids, never the pending backlog: start
    // from the tracked union, subtract every id the step's I1 basis proves
    // pending (early stop once none remain), then re-verify the remainder
    // against committed state before deleting. The re-verify is the reentry
    // guard: the public onI1Violation callback may have re-entered
    // core.step() after the basis was read, so basis absence alone never
    // deletes. Probes are chunked and sized to the surviving candidates.
    const candidates = new Set<number>();
    for (const set of [this.reportedI1, this.interruptRequested]) {
      for (const id of set) candidates.add(id);
    }
    if (latestI1 !== null) {
      subtract: for (const bee of latestI1) {
        for (const m of bee.pending) {
          candidates.delete(m.id);
          if (candidates.size === 0) break subtract;
        }
      }
    }
    // I1-disabled shares the same machinery: with no basis to subtract, every
    // tracked id goes straight to the committed membership probes (fresh by
    // construction — probed here, after any reentrant step returned).
    const recheck = [...candidates];
    for (let at = 0; at < recheck.length; at += DEDUP_PROBE_CHUNK) {
      for (const id of this.store.undeliveredMessageIdsAmong(recheck.slice(at, at + DEDUP_PROBE_CHUNK))) {
        candidates.delete(id);
      }
    }
    for (const id of candidates) {
      this.reportedI1.delete(id);
      this.interruptRequested.delete(id);
    }
    this.resetSweepState(this.reportedI1.size + this.interruptRequested.size);
  }

  private resetSweepState(size: number): void {
    this.sweepTicks = 0;
    this.sizeAtLastSweep = size;
  }
}
