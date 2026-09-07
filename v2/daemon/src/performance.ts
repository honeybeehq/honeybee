import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  monitorEventLoopDelay,
  performance,
  type IntervalHistogram,
} from "node:perf_hooks";
import { RPC_VERBS, type RpcVerb } from "./protocol.ts";

const STATIC_SPAN_NAMES = [
  "daemon.start.total",
  "daemon.start.storage",
  "daemon.start.services",
  "daemon.start.drivers",
  "daemon.start.reconcile",
  "daemon.start.rpc",
  "daemon.tick.total",
  "daemon.tick.core",
  "daemon.tick.accounts",
  "daemon.tick.login",
  "daemon.tick.auto_title",
  "daemon.tick.watch",
  "rpc.serialize",
  "core.step.total",
  "core.step.observe",
  "core.step.flags",
  "core.step.snapshot",
  "core.step.policies",
  "core.step.commands",
  "core.step.delivery",
  "core.step.tasks",
  "core.step.i1",
  "core.step.prune",
] as const;

type StaticSpanName = (typeof STATIC_SPAN_NAMES)[number];
export type PerformanceSpanName = StaticSpanName | `rpc.${RpcVerb}`;
export type PerformanceSpanOutcome = "ok" | "error";

export interface PerformanceSpan {
  end(outcome?: PerformanceSpanOutcome): void;
}

export interface PerformanceRecorder {
  startSpan(name: PerformanceSpanName): PerformanceSpan;
  measureSync<T>(name: PerformanceSpanName, operation: () => T): T;
}

export interface PerformanceProfiler extends PerformanceRecorder {
  start(): void;
  stop(): void;
}

export interface PerformanceLimits {
  durationMs: number;
  sampleIntervalMs: number;
  maxEvents: number;
  maxArtifactBytes: number;
}

export interface PerformanceProfilerOptions {
  env?: Readonly<Record<string, string | undefined>>;
  log: (operation: string) => void;
  limits?: Partial<PerformanceLimits>;
}

const DEFAULT_LIMITS: PerformanceLimits = {
  durationMs: 60_000,
  sampleIntervalMs: 1_000,
  maxEvents: 25_000,
  maxArtifactBytes: 8 * 1024 * 1024,
};

const LIMIT_RANGES = {
  durationMs: { min: 100, max: 60 * 60 * 1_000 },
  sampleIntervalMs: { min: 10, max: 60_000 },
  maxEvents: { min: 1, max: 1_000_000 },
  maxArtifactBytes: { min: 64 * 1024, max: 64 * 1024 * 1024 },
} satisfies Record<keyof PerformanceLimits, { min: number; max: number }>;

const HISTOGRAM_UPPER_BOUNDS_NS = [
  100_000n,
  250_000n,
  500_000n,
  1_000_000n,
  2_000_000n,
  5_000_000n,
  10_000_000n,
  25_000_000n,
  50_000_000n,
  100_000_000n,
  250_000_000n,
  500_000_000n,
  1_000_000_000n,
  2_500_000_000n,
  5_000_000_000n,
  10_000_000_000n,
  30_000_000_000n,
  60_000_000_000n,
] as const;

const TRACE_PREFIX = '{"traceEvents":[';
const TRACE_SUFFIX = '],"displayTimeUnit":"ms"}\n';

function rpcSpanName(verb: RpcVerb): `rpc.${RpcVerb}` {
  return `rpc.${verb}`;
}

export function rpcPerformanceSpanName(verb: RpcVerb): PerformanceSpanName {
  return rpcSpanName(verb);
}

const ALLOWED_SPAN_NAMES = new Set<string>([
  ...STATIC_SPAN_NAMES,
  ...RPC_VERBS.map(rpcSpanName),
]);

const NOOP_SPAN: PerformanceSpan = Object.freeze({
  end: () => undefined,
});

export const NOOP_PERFORMANCE: PerformanceProfiler = Object.freeze({
  start: () => undefined,
  startSpan: () => NOOP_SPAN,
  measureSync: <T>(_name: PerformanceSpanName, operation: () => T): T => operation(),
  stop: () => undefined,
});

interface MutableSpanStats {
  count: number;
  errors: number;
  totalNanoseconds: bigint;
  maxNanoseconds: bigint;
  bucketCounts: number[];
}

interface SpanSummary {
  count: number;
  errors: number;
  totalNanoseconds: string;
  maxNanoseconds: string;
  bucketCounts: number[];
}

interface ResourceSummary {
  samples: number;
  cpuUserMicroseconds: number;
  cpuSystemMicroseconds: number;
  rssBytesMax: number;
  heapTotalBytesMax: number;
  heapUsedBytesMax: number;
  externalBytesMax: number;
  arrayBuffersBytesMax: number;
  eventLoopUtilizationMax: number;
  eventLoopDelayMaxNanoseconds: number;
}

type TimerState =
  | { kind: "idle" }
  | {
      kind: "running";
      sampleTimer: NodeJS.Timeout;
      durationTimer: NodeJS.Timeout;
      loopDelay: IntervalHistogram;
    }
  | { kind: "stopped" };

interface RecordingSession {
  directory: string;
  stem: string;
  limits: PerformanceLimits;
  startedAtEpochMs: number;
  startedAtNanoseconds: bigint;
  recordingEndedAtNanoseconds: bigint | null;
  lastSampleAtNanoseconds: bigint;
  lastCpuUsage: NodeJS.CpuUsage;
  lastEventLoopUtilization: ReturnType<typeof performance.eventLoopUtilization>;
  events: string[];
  eventBytes: number;
  droppedEvents: number;
  artifactTrimmedEvents: number;
  spans: Map<PerformanceSpanName, MutableSpanStats>;
  resources: ResourceSummary;
  timers: TimerState;
}

type StopReason =
  | "shutdown"
  | "duration_limit"
  | "event_limit"
  | "artifact_byte_limit"
  | "internal_failure";

type ProfilerState =
  | { kind: "ready"; directory: string; limits: PerformanceLimits }
  | { kind: "recording"; session: RecordingSession }
  | { kind: "capped"; session: RecordingSession; reason: StopReason }
  | { kind: "disabled" }
  | { kind: "stopped" };

function boundedInteger(
  value: number | string | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : fallback;
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, parsed));
}

function limitsFrom(
  env: Readonly<Record<string, string | undefined>>,
  overrides: Partial<PerformanceLimits>,
): PerformanceLimits {
  const durationMs = boundedInteger(
    overrides.durationMs ?? env.HIVE_PERF_DURATION_MS,
    DEFAULT_LIMITS.durationMs,
    LIMIT_RANGES.durationMs,
  );
  const sampleIntervalMs = Math.min(
    durationMs,
    boundedInteger(
      overrides.sampleIntervalMs ?? env.HIVE_PERF_SAMPLE_MS,
      DEFAULT_LIMITS.sampleIntervalMs,
      LIMIT_RANGES.sampleIntervalMs,
    ),
  );
  return {
    durationMs,
    sampleIntervalMs,
    maxEvents: boundedInteger(
      overrides.maxEvents ?? env.HIVE_PERF_MAX_EVENTS,
      DEFAULT_LIMITS.maxEvents,
      LIMIT_RANGES.maxEvents,
    ),
    maxArtifactBytes: boundedInteger(
      overrides.maxArtifactBytes ?? env.HIVE_PERF_MAX_BYTES,
      DEFAULT_LIMITS.maxArtifactBytes,
      LIMIT_RANGES.maxArtifactBytes,
    ),
  };
}

function emptyResourceSummary(): ResourceSummary {
  return {
    samples: 0,
    cpuUserMicroseconds: 0,
    cpuSystemMicroseconds: 0,
    rssBytesMax: 0,
    heapTotalBytesMax: 0,
    heapUsedBytesMax: 0,
    externalBytesMax: 0,
    arrayBuffersBytesMax: 0,
    eventLoopUtilizationMax: 0,
    eventLoopDelayMaxNanoseconds: 0,
  };
}

function traceBytes(eventCount: number, eventBytes: number): number {
  const commas = Math.max(0, eventCount - 1);
  return Buffer.byteLength(TRACE_PREFIX) + eventBytes + commas + Buffer.byteLength(TRACE_SUFFIX);
}

function nanosecondsToMicroseconds(value: bigint): number {
  return Number(value) / 1_000;
}

class ActivePerformanceProfiler implements PerformanceProfiler {
  private state: ProfilerState;
  private diagnosticLogged = false;
  private readonly log: (operation: string) => void;

  constructor(directory: string, limits: PerformanceLimits, log: (operation: string) => void) {
    this.state = { kind: "ready", directory, limits };
    this.log = log;
  }

  start(): void {
    if (this.state.kind !== "ready") return;
    const { directory, limits } = this.state;
    let loopDelay: IntervalHistogram | null = null;
    let sampleTimer: NodeJS.Timeout | null = null;
    let durationTimer: NodeJS.Timeout | null = null;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const startedAtNanoseconds = process.hrtime.bigint();
      const session: RecordingSession = {
        directory,
        stem: `hive-perf-${Date.now()}-${process.pid}-${randomUUID()}`,
        limits,
        startedAtEpochMs: Date.now(),
        startedAtNanoseconds,
        recordingEndedAtNanoseconds: null,
        lastSampleAtNanoseconds: startedAtNanoseconds,
        lastCpuUsage: process.cpuUsage(),
        lastEventLoopUtilization: performance.eventLoopUtilization(),
        events: [],
        eventBytes: 0,
        droppedEvents: 0,
        artifactTrimmedEvents: 0,
        spans: new Map(),
        resources: emptyResourceSummary(),
        timers: { kind: "idle" },
      };
      loopDelay = monitorEventLoopDelay({ resolution: 20 });
      loopDelay.enable();
      sampleTimer = setInterval(() => this.sample(session), limits.sampleIntervalMs);
      durationTimer = setTimeout(
        () => this.cap(session, "duration_limit"),
        limits.durationMs,
      );
      sampleTimer.unref();
      durationTimer.unref();
      session.timers = { kind: "running", sampleTimer, durationTimer, loopDelay };
      this.state = { kind: "recording", session };
    } catch {
      if (sampleTimer) clearInterval(sampleTimer);
      if (durationTimer) clearTimeout(durationTimer);
      loopDelay?.disable();
      this.state = { kind: "disabled" };
      this.diagnoseOnce("performance.disabled reason=io_or_setup_failure");
    }
  }

  startSpan(name: PerformanceSpanName): PerformanceSpan {
    const state = this.state;
    if (state.kind === "capped") {
      state.session.droppedEvents += 1;
      return NOOP_SPAN;
    }
    if (state.kind !== "recording") return NOOP_SPAN;
    if (!ALLOWED_SPAN_NAMES.has(name)) {
      state.session.droppedEvents += 1;
      return NOOP_SPAN;
    }
    const startedAtNanoseconds = process.hrtime.bigint();
    let ended = false;
    return {
      end: (outcome: PerformanceSpanOutcome = "ok") => {
        if (ended) return;
        ended = true;
        this.finishSpan(state.session, name, startedAtNanoseconds, outcome);
      },
    };
  }

  measureSync<T>(name: PerformanceSpanName, operation: () => T): T {
    const span = this.startSpan(name);
    try {
      const result = operation();
      span.end();
      return result;
    } catch (error) {
      span.end("error");
      throw error;
    }
  }

  stop(): void {
    const initialState = this.state;
    if (initialState.kind === "disabled" || initialState.kind === "stopped") {
      this.state = { kind: "stopped" };
      return;
    }
    if (initialState.kind === "ready") {
      this.state = { kind: "stopped" };
      return;
    }

    let reason: StopReason;
    let session: RecordingSession;
    if (initialState.kind === "recording") {
      session = initialState.session;
      this.sample(session);
      const sampledState = this.state;
      if (sampledState.kind === "capped" && sampledState.session === session) {
        reason = sampledState.reason;
      } else {
        reason = "shutdown";
        session.recordingEndedAtNanoseconds = process.hrtime.bigint();
        this.stopTimers(session);
      }
    } else {
      session = initialState.session;
      reason = initialState.reason;
    }

    this.state = { kind: "stopped" };
    try {
      this.writeArtifacts(session, reason);
    } catch {
      this.diagnoseOnce("performance.disabled reason=artifact_write_failure");
    }
  }

  private finishSpan(
    session: RecordingSession,
    name: PerformanceSpanName,
    startedAtNanoseconds: bigint,
    outcome: PerformanceSpanOutcome,
  ): void {
    const state = this.state;
    if (state.kind !== "recording" || state.session !== session) {
      session.droppedEvents += 1;
      return;
    }
    try {
      const endedAtNanoseconds = process.hrtime.bigint();
      const durationNanoseconds = endedAtNanoseconds - startedAtNanoseconds;
      const event = JSON.stringify({
        name,
        cat: "hive",
        ph: "X",
        ts: nanosecondsToMicroseconds(
          startedAtNanoseconds - session.startedAtNanoseconds,
        ),
        dur: nanosecondsToMicroseconds(durationNanoseconds),
        pid: 1,
        tid: 0,
        args: { error: outcome === "error" },
      });
      if (!this.appendEvent(session, event)) return;
      this.recordSpanStats(session, name, durationNanoseconds, outcome);
    } catch {
      this.cap(session, "internal_failure");
      this.diagnoseOnce("performance.disabled reason=internal_failure");
    }
  }

  private recordSpanStats(
    session: RecordingSession,
    name: PerformanceSpanName,
    durationNanoseconds: bigint,
    outcome: PerformanceSpanOutcome,
  ): void {
    let stats = session.spans.get(name);
    if (!stats) {
      stats = {
        count: 0,
        errors: 0,
        totalNanoseconds: 0n,
        maxNanoseconds: 0n,
        bucketCounts: Array.from(
          { length: HISTOGRAM_UPPER_BOUNDS_NS.length + 1 },
          () => 0,
        ),
      };
      session.spans.set(name, stats);
    }
    stats.count += 1;
    if (outcome === "error") stats.errors += 1;
    stats.totalNanoseconds += durationNanoseconds;
    if (durationNanoseconds > stats.maxNanoseconds) {
      stats.maxNanoseconds = durationNanoseconds;
    }
    const bucket = HISTOGRAM_UPPER_BOUNDS_NS.findIndex(
      (upperBound) => durationNanoseconds <= upperBound,
    );
    const bucketIndex = bucket < 0 ? HISTOGRAM_UPPER_BOUNDS_NS.length : bucket;
    stats.bucketCounts[bucketIndex] = (stats.bucketCounts[bucketIndex] ?? 0) + 1;
  }

  private appendEvent(session: RecordingSession, event: string): boolean {
    if (session.events.length >= session.limits.maxEvents) {
      session.droppedEvents += 1;
      this.cap(session, "event_limit");
      return false;
    }
    const eventBytes = Buffer.byteLength(event);
    const summaryReserve = Math.min(
      256 * 1024,
      Math.floor(session.limits.maxArtifactBytes / 2),
    );
    const traceBudget = session.limits.maxArtifactBytes - summaryReserve;
    const projectedBytes = traceBytes(
      session.events.length + 1,
      session.eventBytes + eventBytes,
    );
    if (projectedBytes > traceBudget) {
      session.droppedEvents += 1;
      this.cap(session, "artifact_byte_limit");
      return false;
    }
    session.events.push(event);
    session.eventBytes += eventBytes;
    return true;
  }

  private sample(session: RecordingSession): void {
    const state = this.state;
    if (state.kind !== "recording" || state.session !== session) return;
    const timers = session.timers;
    if (timers.kind !== "running") return;
    try {
      const sampledAtNanoseconds = process.hrtime.bigint();
      const cpuUsage = process.cpuUsage();
      const cpuUserMicroseconds = cpuUsage.user - session.lastCpuUsage.user;
      const cpuSystemMicroseconds = cpuUsage.system - session.lastCpuUsage.system;
      const eventLoopUtilization = performance.eventLoopUtilization(
        session.lastEventLoopUtilization,
      );
      const memory = process.memoryUsage();
      const delayMeanNanoseconds = Number.isFinite(timers.loopDelay.mean)
        ? Math.round(timers.loopDelay.mean)
        : 0;
      const delayMaxNanoseconds = Number.isFinite(timers.loopDelay.max)
        ? Math.round(timers.loopDelay.max)
        : 0;
      const delayP99Nanoseconds = Number.isFinite(timers.loopDelay.percentile(99))
        ? Math.round(timers.loopDelay.percentile(99))
        : 0;
      const elapsedMicroseconds = nanosecondsToMicroseconds(
        sampledAtNanoseconds - session.lastSampleAtNanoseconds,
      );
      const event = JSON.stringify({
        name: "process.resources",
        cat: "hive.resources",
        ph: "C",
        ts: nanosecondsToMicroseconds(
          sampledAtNanoseconds - session.startedAtNanoseconds,
        ),
        pid: 1,
        tid: 0,
        args: {
          intervalMicroseconds: elapsedMicroseconds,
          cpuUserMicroseconds,
          cpuSystemMicroseconds,
          rssBytes: memory.rss,
          heapTotalBytes: memory.heapTotal,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          arrayBuffersBytes: memory.arrayBuffers,
          eventLoopUtilization: eventLoopUtilization.utilization,
          eventLoopActiveMilliseconds: eventLoopUtilization.active,
          eventLoopIdleMilliseconds: eventLoopUtilization.idle,
          eventLoopDelayMeanNanoseconds: delayMeanNanoseconds,
          eventLoopDelayMaxNanoseconds: delayMaxNanoseconds,
          eventLoopDelayP99Nanoseconds: delayP99Nanoseconds,
        },
      });
      session.lastCpuUsage = cpuUsage;
      session.lastEventLoopUtilization = performance.eventLoopUtilization();
      session.lastSampleAtNanoseconds = sampledAtNanoseconds;
      timers.loopDelay.reset();
      if (!this.appendEvent(session, event)) return;
      const resources = session.resources;
      resources.samples += 1;
      resources.cpuUserMicroseconds += cpuUserMicroseconds;
      resources.cpuSystemMicroseconds += cpuSystemMicroseconds;
      resources.rssBytesMax = Math.max(resources.rssBytesMax, memory.rss);
      resources.heapTotalBytesMax = Math.max(
        resources.heapTotalBytesMax,
        memory.heapTotal,
      );
      resources.heapUsedBytesMax = Math.max(
        resources.heapUsedBytesMax,
        memory.heapUsed,
      );
      resources.externalBytesMax = Math.max(
        resources.externalBytesMax,
        memory.external,
      );
      resources.arrayBuffersBytesMax = Math.max(
        resources.arrayBuffersBytesMax,
        memory.arrayBuffers,
      );
      resources.eventLoopUtilizationMax = Math.max(
        resources.eventLoopUtilizationMax,
        eventLoopUtilization.utilization,
      );
      resources.eventLoopDelayMaxNanoseconds = Math.max(
        resources.eventLoopDelayMaxNanoseconds,
        delayMaxNanoseconds,
      );
    } catch {
      this.cap(session, "internal_failure");
      this.diagnoseOnce("performance.disabled reason=internal_failure");
    }
  }

  private cap(session: RecordingSession, reason: StopReason): void {
    const state = this.state;
    if (state.kind !== "recording" || state.session !== session) return;
    session.recordingEndedAtNanoseconds = process.hrtime.bigint();
    this.stopTimers(session);
    this.state = { kind: "capped", session, reason };
  }

  private stopTimers(session: RecordingSession): void {
    const timers = session.timers;
    if (timers.kind !== "running") return;
    clearInterval(timers.sampleTimer);
    clearTimeout(timers.durationTimer);
    timers.loopDelay.disable();
    session.timers = { kind: "stopped" };
  }

  private writeArtifacts(session: RecordingSession, reason: StopReason): void {
    const endedAtNanoseconds =
      session.recordingEndedAtNanoseconds ?? process.hrtime.bigint();
    let summaryText = this.summaryText(session, reason, endedAtNanoseconds);
    let traceText = `${TRACE_PREFIX}${session.events.join(",")}${TRACE_SUFFIX}`;
    while (
      Buffer.byteLength(traceText) + Buffer.byteLength(summaryText) >
        session.limits.maxArtifactBytes &&
      session.events.length > 0
    ) {
      const removed = session.events.pop();
      if (removed) session.eventBytes -= Buffer.byteLength(removed);
      session.droppedEvents += 1;
      session.artifactTrimmedEvents += 1;
      summaryText = this.summaryText(session, reason, endedAtNanoseconds);
      traceText = `${TRACE_PREFIX}${session.events.join(",")}${TRACE_SUFFIX}`;
    }
    if (
      Buffer.byteLength(traceText) + Buffer.byteLength(summaryText) >
      session.limits.maxArtifactBytes
    ) {
      this.diagnoseOnce("performance.disabled reason=summary_exceeds_artifact_limit");
      return;
    }
    writeFileSync(join(session.directory, `${session.stem}.trace.json`), traceText, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    writeFileSync(
      join(session.directory, `${session.stem}.summary.json`),
      summaryText,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  }

  private summaryText(
    session: RecordingSession,
    reason: StopReason,
    endedAtNanoseconds: bigint,
  ): string {
    const spans: Record<string, SpanSummary> = {};
    const orderedSpans = [...session.spans.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [name, stats] of orderedSpans) {
      spans[name] = {
        count: stats.count,
        errors: stats.errors,
        totalNanoseconds: stats.totalNanoseconds.toString(),
        maxNanoseconds: stats.maxNanoseconds.toString(),
        bucketCounts: stats.bucketCounts,
      };
    }
    return `${JSON.stringify(
      {
        schemaVersion: 1,
        format: "honeybee.performance.summary",
        clock: "process.hrtime.bigint",
        startedAt: new Date(session.startedAtEpochMs).toISOString(),
        durationNanoseconds: (
          endedAtNanoseconds - session.startedAtNanoseconds
        ).toString(),
        stopReason: reason,
        limits: session.limits,
        traceEvents: session.events.length,
        droppedEvents: session.droppedEvents,
        artifactTrimmedEvents: session.artifactTrimmedEvents,
        histogram: {
          kind: "fixed_upper_bounds",
          unit: "nanoseconds",
          upperBounds: HISTOGRAM_UPPER_BOUNDS_NS.map((value) => value.toString()),
          overflowBucket: true,
        },
        spans,
        resources: session.resources,
      },
      null,
      2,
    )}\n`;
  }

  private diagnoseOnce(operation: string): void {
    if (this.diagnosticLogged) return;
    this.diagnosticLogged = true;
    try {
      this.log(operation);
    } catch {
      // Profiling diagnostics cannot affect daemon behavior.
    }
  }
}

export function createPerformanceProfiler(
  options: PerformanceProfilerOptions,
): PerformanceProfiler {
  const env = options.env ?? process.env;
  const directory = env.HIVE_PERF_DIR;
  if (directory === undefined || directory.length === 0) return NOOP_PERFORMANCE;
  return new ActivePerformanceProfiler(
    directory,
    limitsFrom(env, options.limits ?? {}),
    options.log,
  );
}
