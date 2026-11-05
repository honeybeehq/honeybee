import { statSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { CoreStore, TranscriptSegmentReadyReason } from "../../core/src/index.ts";
import { SEGMENT_MAX_LINES, SEGMENT_MAX_RAW_BYTES } from "../../core/src/transcriptSegment.ts";
import type { TranscriptObjectStore } from "./transcriptObjectStore.ts";
import { transcriptSegmentWorkerUrl, type SegmentCursor, type TranscriptCutRequest, type TranscriptCutResult, type TranscriptSweepRequest, type TranscriptSweepResult, type WorkerServerReply, type WorkerServerRequest } from "./transcriptSegmentWorker.ts";

export type TranscriptCutReason = TranscriptSegmentReadyReason;

export interface TranscriptCutOutcome {
  status: "cut" | "nothing" | "no_log" | "no_bee" | "failed";
  segments: number;
  lines: number;
}

export interface TranscriptObjectsStatus {
  root: string;
  objects: number;
  bytes: number;
  orphansSwept: number;
  measuredAt: number;
}

export interface TranscriptSegmenterDeps {
  store: () => CoreStore;
  objectStore: TranscriptObjectStore;
  now: () => number;
  log: (op: string) => void;
  maxLines?: number;
  maxRawBytes?: number;
  maxWorkers?: number;
  pacingMs?: number;
  chunkBytes?: number;
  maxChunkBytes?: number;
  replayLimitBytes?: number;
  orphanGraceMs?: number;
  workerUrl?: URL;
}

const DEFAULT_CHUNK = 1024 * 1024;
const DEFAULT_MAX_CHUNK = 64 * 1024 * 1024;
const DEFAULT_REPLAY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_PACING_MS = 25;
const DEFAULT_ORPHAN_GRACE_MS = 60 * 60_000;
const ROW_BATCH = 100;

function logSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface Pending {
  beeId: string;
  reason: TranscriptCutReason;
  settle: Array<(outcome: TranscriptCutOutcome) => void>;
}

interface Seat {
  worker: Worker;
  inFlight: { id: number; resolve: (reply: unknown) => void; reject: (err: Error) => void } | null;
}

export class TranscriptSegmenter {
  private readonly deps: TranscriptSegmenterDeps;
  private readonly queue: Pending[] = [];
  private readonly queued = new Map<string, Pending>();
  private readonly running = new Map<string, Pending>();
  private readonly seats: Seat[] = [];
  private readonly idle: Seat[] = [];
  private readonly waiting: Array<(seat: Seat) => void> = [];
  private nextRequestId = 1;
  private stopping = false;
  private objectsStatus: TranscriptObjectsStatus | null = null;
  private sweepInFlight: Promise<TranscriptObjectsStatus> | null = null;
  private writtenDuringSweep: { objects: number; bytes: number } | null = null;
  readonly diagnostics = { cuts: 0, segments: 0, lines: 0, failures: 0 };

  constructor(deps: TranscriptSegmenterDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.stopping = true;
    for (const seat of [...this.seats]) this.retire(seat, new Error("transcript segmenter stopped"));
    for (const pending of [...this.queue, ...this.running.values()]) for (const settle of pending.settle) settle({ status: "nothing", segments: 0, lines: 0 });
    this.queue.length = 0;
    this.queued.clear();
  }

  requestCut(beeId: string, reason: TranscriptCutReason): Promise<TranscriptCutOutcome> {
    if (this.stopping) return Promise.resolve({ status: "nothing", segments: 0, lines: 0 });
    return new Promise((settle) => {
      const pending = this.queued.get(beeId);
      if (pending) {
        if (reason !== "boot") pending.reason = reason;
        pending.settle.push(settle);
        return;
      }
      const entry: Pending = { beeId, reason, settle: [settle] };
      this.queued.set(beeId, entry);
      this.queue.push(entry);
      this.pump();
    });
  }

  backlog(): number {
    return this.queue.length + this.running.size;
  }

  catchUp(): number {
    const store = this.deps.store();
    let scheduled = 0;
    for (const bee of store.listBees()) {
      if (bee.lifecycle === "deleted" || !bee.sessionLogPath) continue;
      const runtime = store.currentRuntime(bee.id);
      if (runtime && runtime.state !== "stopped") continue;
      const cursor = store.getTranscriptSegmentCursor(bee.id);
      if (cursor && cursor.path === bee.sessionLogPath) {
        const size = logSize(cursor.path);
        if (size === null || size === cursor.byteOffset) continue;
      }
      void this.requestCut(bee.id, "boot");
      scheduled += 1;
    }
    return scheduled;
  }

  private pump(): void {
    if (this.stopping) return;
    const max = this.deps.maxWorkers ?? 1;
    while (this.running.size < max) {
      const index = this.queue.findIndex((p) => !this.running.has(p.beeId));
      if (index < 0) return;
      const pending = this.queue.splice(index, 1)[0]!;
      this.queued.delete(pending.beeId);
      this.running.set(pending.beeId, pending);
      void this.cut(pending)
        .catch((err): TranscriptCutOutcome => {
          if (this.stopping) return { status: "nothing", segments: 0, lines: 0 };
          this.diagnostics.failures += 1;
          this.deps.log(`transcripts.segment.cut_failed bee=${pending.beeId} reason=${pending.reason} err=${JSON.stringify(err instanceof Error ? err.message : String(err))}`);
          return { status: "failed", segments: 0, lines: 0 };
        })
        .then((outcome) => {
          for (const settle of pending.settle) settle(outcome);
        })
        .finally(() => {
          this.running.delete(pending.beeId);
          if (this.queue.length === 0) return;
          setTimeout(() => this.pump(), this.deps.pacingMs ?? DEFAULT_PACING_MS).unref();
        });
    }
  }

  private async cut(pending: Pending): Promise<TranscriptCutOutcome> {
    const store = this.deps.store();
    const bee = store.getBee(pending.beeId);
    if (!bee || bee.lifecycle === "deleted") return { status: "no_bee", segments: 0, lines: 0 };
    const path = bee.sessionLogPath;
    if (!path) return { status: "no_log", segments: 0, lines: 0 };
    let cursor: SegmentCursor = store.getTranscriptSegmentCursor(bee.id) ?? { path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null };
    let total = { segments: 0, lines: 0 };
    if (cursor.path !== path) {
      const finished = await this.cutFile(bee.id, cursor, pending.reason);
      total = { segments: finished.segments, lines: finished.lines };
      cursor = { path, lineNo: finished.cursor.lineNo, byteOffset: 0, epoch: finished.cursor.epoch, projectorCheckpoint: null };
      store.putTranscriptSegmentCursor(bee.id, cursor);
      this.deps.log(`transcripts.segment.rotated bee=${bee.id} from=${finished.cursor.path} to=${path} line=${cursor.lineNo}`);
    }
    const current = await this.cutFile(bee.id, cursor, pending.reason);
    total = { segments: total.segments + current.segments, lines: total.lines + current.lines };
    if (total.segments > 0) {
      this.diagnostics.cuts += 1;
      this.diagnostics.segments += total.segments;
      this.diagnostics.lines += total.lines;
      this.deps.log(`transcripts.segment.cut bee=${bee.id} reason=${pending.reason} segments=${total.segments} lines=${total.lines} through=${current.cursor.lineNo}`);
    }
    return { status: total.segments > 0 ? "cut" : "nothing", ...total };
  }

  private harnessFor(store: CoreStore, beeId: string, agent: string, path: string): { harness: string; logSegmentId: string | null } {
    const segment = store.listTranscriptSegments(beeId).find((s) => s.path === path) ?? store.currentTranscriptSegment(beeId);
    return { harness: segment?.harness ?? agent, logSegmentId: segment?.id ?? null };
  }

  private async cutFile(beeId: string, cursor: SegmentCursor, reason: TranscriptCutReason): Promise<{ segments: number; lines: number; cursor: SegmentCursor }> {
    const store = this.deps.store();
    const bee = store.getBee(beeId);
    if (!bee) return { segments: 0, lines: 0, cursor };
    const source = this.harnessFor(store, beeId, bee.agent, cursor.path);
    const request: TranscriptCutRequest = {
      beeId,
      cursor,
      harness: source.harness,
      logSegmentId: source.logSegmentId,
      storeRoot: this.deps.objectStore.locator.root,
      maxLines: this.deps.maxLines ?? SEGMENT_MAX_LINES,
      maxRawBytes: this.deps.maxRawBytes ?? SEGMENT_MAX_RAW_BYTES,
      chunkBytes: this.deps.chunkBytes ?? DEFAULT_CHUNK,
      maxChunkBytes: this.deps.maxChunkBytes ?? DEFAULT_MAX_CHUNK,
      replayLimitBytes: this.deps.replayLimitBytes ?? DEFAULT_REPLAY_LIMIT,
      observedAt: this.deps.now(),
    };
    const result = await this.runWorker<TranscriptCutResult>(request);
    if (result.error != null) throw new Error(result.error);
    this.countWritten(result.written);
    if (result.missing) return { segments: 0, lines: 0, cursor };
    if (result.shrunk) {
      this.deps.log(`transcripts.segment.log_shrunk bee=${beeId} path=${cursor.path} cursor=${cursor.byteOffset}`);
      if (result.segments.length === 0) store.putTranscriptSegmentCursor(beeId, result.cursor);
    }
    if (result.checkpointRejected) this.deps.log(`transcripts.segment.checkpoint_rejected bee=${beeId} reason=${result.checkpointRejected}`);
    if (result.projectorReset) this.deps.log(`transcripts.segment.projector_reset bee=${beeId} prefix=${cursor.byteOffset}`);
    let lines = 0;
    let inserted = 0;
    for (let at = 0; at < result.segments.length && !this.stopping; at += ROW_BATCH) {
      const batch = result.segments.slice(at, at + ROW_BATCH);
      store.putTranscriptSegmentObjects(batch, { reason, rowAudit: reason !== "boot" });
      inserted += batch.length;
      for (const entry of batch) lines += entry.segment.lastLine - entry.segment.firstLine + 1;
      if (at + ROW_BATCH < result.segments.length) await new Promise<void>((r) => setImmediate(r));
    }
    return { segments: inserted, lines, cursor: inserted > 0 ? result.segments[inserted - 1]!.cursor : result.cursor };
  }

  private seat(): Seat {
    const worker = new Worker(this.deps.workerUrl ?? transcriptSegmentWorkerUrl(), { execArgv: [], workerData: { kind: "server" } });
    worker.unref();
    const seat: Seat = { worker, inFlight: null };
    this.seats.push(seat);
    worker.on("message", (message: WorkerServerReply) => {
      const inFlight = seat.inFlight;
      if (!inFlight || inFlight.id !== message.id) return;
      seat.inFlight = null;
      inFlight.resolve(message.result);
      this.release(seat);
    });
    worker.once("error", (err: Error) => this.retire(seat, err));
    worker.once("exit", (code) => this.retire(seat, new Error(`transcript segment worker exited with code ${code}`)));
    return seat;
  }

  private retire(seat: Seat, err: Error): void {
    const at = this.seats.indexOf(seat);
    if (at < 0) return;
    this.seats.splice(at, 1);
    const idleAt = this.idle.indexOf(seat);
    if (idleAt >= 0) this.idle.splice(idleAt, 1);
    seat.worker.removeAllListeners();
    void seat.worker.terminate();
    const inFlight = seat.inFlight;
    seat.inFlight = null;
    inFlight?.reject(err);
    if (this.stopping) return;
    const next = this.waiting.shift();
    if (next) next(this.seat());
  }

  private release(seat: Seat): void {
    const next = this.waiting.shift();
    if (next) next(seat);
    else this.idle.push(seat);
  }

  private acquire(): Promise<Seat> {
    const idle = this.idle.pop();
    if (idle) return Promise.resolve(idle);
    if (this.seats.length < (this.deps.maxWorkers ?? 1)) return Promise.resolve(this.seat());
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private async runWorker<T>(request: TranscriptCutRequest | TranscriptSweepRequest): Promise<T> {
    if (this.stopping) throw new Error("transcript segmenter stopped");
    const seat = await this.acquire();
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      seat.inFlight = { id, resolve: (reply) => resolve(reply as T), reject };
      seat.worker.postMessage({ id, request } satisfies WorkerServerRequest);
    });
  }

  objects(): TranscriptObjectsStatus | null {
    return this.objectsStatus ? { ...this.objectsStatus } : null;
  }

  private countWritten(written: { objects: number; bytes: number }): void {
    if (written.objects === 0) return;
    if (this.writtenDuringSweep) {
      this.writtenDuringSweep.objects += written.objects;
      this.writtenDuringSweep.bytes += written.bytes;
    }
    if (!this.objectsStatus) return;
    this.objectsStatus = { ...this.objectsStatus, objects: this.objectsStatus.objects + written.objects, bytes: this.objectsStatus.bytes + written.bytes };
  }

  sweepOrphans(): Promise<TranscriptObjectsStatus> {
    if (this.sweepInFlight) return this.sweepInFlight;
    this.sweepInFlight = this.sweepNow().finally(() => {
      this.sweepInFlight = null;
    });
    return this.sweepInFlight;
  }

  private async sweepNow(): Promise<TranscriptObjectsStatus> {
    const root = this.deps.objectStore.locator.root;
    const now = this.deps.now();
    this.writtenDuringSweep = { objects: 0, bytes: 0 };
    const result = await this.runWorker<TranscriptSweepResult>({
      kind: "sweep",
      storeRoot: root,
      referenced: [...this.deps.store().listTranscriptSegmentObjectRefs()],
      graceMs: this.deps.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
      now,
    } satisfies TranscriptSweepRequest);
    if (result.error != null) throw new Error(result.error);
    const late = this.writtenDuringSweep ?? { objects: 0, bytes: 0 };
    this.writtenDuringSweep = null;
    this.objectsStatus = { root, objects: result.objects + late.objects, bytes: result.bytes + late.bytes, orphansSwept: result.swept, measuredAt: now };
    this.deps.log(`transcripts.objects root=${root} objects=${result.objects} bytes=${result.bytes} orphans_swept=${result.swept}`);
    return this.objectsStatus;
  }
}
