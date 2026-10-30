import { randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { BeeRow, CoreStore, TranscriptSegmentCursorRow } from "../../core/src/index.ts";
import { createTranscriptProjector, restoreTranscriptProjector } from "../../driver-tmux/src/transcripts.ts";
import { TRANSCRIPT_PROJECTION_VERSION, type TranscriptProjector } from "../../driver-tmux/src/transcript-projection.ts";
import {
  SEGMENT_MAX_LINES,
  SEGMENT_MAX_RAW_BYTES,
  compressSegment,
  encodeProjectedSegment,
  scanLogLines,
  segmentDigest,
  type ProjectedLine,
  type ScannedLine,
} from "../../driver-tmux/src/transcript-segment-format.ts";
import type { TranscriptObjectStore } from "./transcriptObjectStore.ts";

export type TranscriptCutReason = "turn_ended" | "exited" | "boot" | "manual";

export interface TranscriptCutOutcome {
  status: "cut" | "nothing" | "no_log" | "no_bee";
  segments: number;
  lines: number;
}

export interface TranscriptSegmenterDeps {
  store: () => CoreStore;
  objectStore: TranscriptObjectStore;
  now: () => number;
  log: (op: string) => void;
  maxLines?: number;
  maxRawBytes?: number;
  readChunkBytes?: number;
  projectorReplayLimitBytes?: number;
}

const DEFAULT_READ_CHUNK = 8 * 1024 * 1024;
const DEFAULT_PROJECTOR_REPLAY_LIMIT = 64 * 1024 * 1024;

type Cursor = Omit<TranscriptSegmentCursorRow, "beeId" | "updatedAt">;

export class TranscriptSegmenter {
  private readonly deps: TranscriptSegmenterDeps;
  private readonly inFlight = new Map<string, Promise<TranscriptCutOutcome>>();
  private readonly again = new Map<string, TranscriptCutReason>();
  private stopping = false;
  readonly diagnostics = { cuts: 0, segments: 0, lines: 0, failures: 0 };

  constructor(deps: TranscriptSegmenterDeps) {
    this.deps = deps;
  }

  stop(): void {
    this.stopping = true;
  }

  requestCut(beeId: string, reason: TranscriptCutReason): Promise<TranscriptCutOutcome> {
    if (this.stopping) return Promise.resolve({ status: "nothing", segments: 0, lines: 0 });
    const running = this.inFlight.get(beeId);
    if (running) {
      this.again.set(beeId, reason);
      return running;
    }
    const run = this.cut(beeId, reason)
      .catch((err) => {
        this.diagnostics.failures += 1;
        this.deps.log(`transcripts.segment.cut_failed bee=${beeId} reason=${reason} err=${JSON.stringify(err instanceof Error ? err.message : String(err))}`);
        return { status: "nothing", segments: 0, lines: 0 } as TranscriptCutOutcome;
      })
      .finally(() => {
        this.inFlight.delete(beeId);
        const next = this.again.get(beeId);
        if (next !== undefined) {
          this.again.delete(beeId);
          void this.requestCut(beeId, next);
        }
      });
    this.inFlight.set(beeId, run);
    return run;
  }

  catchUp(): number {
    const store = this.deps.store();
    let scheduled = 0;
    for (const bee of store.listBees()) {
      if (bee.lifecycle === "deleted" || !bee.sessionLogPath) continue;
      const runtime = store.currentRuntime(bee.id);
      if (runtime && runtime.state !== "stopped") continue;
      void this.requestCut(bee.id, "boot");
      scheduled += 1;
    }
    return scheduled;
  }

  private async cut(beeId: string, reason: TranscriptCutReason): Promise<TranscriptCutOutcome> {
    const store = this.deps.store();
    const bee = store.getBee(beeId);
    if (!bee || bee.lifecycle === "deleted") return { status: "no_bee", segments: 0, lines: 0 };
    const path = bee.sessionLogPath;
    if (!path) return { status: "no_log", segments: 0, lines: 0 };
    let cursor: Cursor = store.getTranscriptSegmentCursor(beeId) ?? { path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null };
    let total = { segments: 0, lines: 0 };
    if (cursor.path !== path) {
      const finished = await this.cutFile(bee, cursor, this.harnessFor(store, bee, cursor.path));
      total = { segments: finished.segments, lines: finished.lines };
      cursor = { path, lineNo: finished.cursor.lineNo, byteOffset: 0, epoch: finished.cursor.epoch, projectorCheckpoint: null };
      store.putTranscriptSegmentCursor(beeId, cursor);
      this.deps.log(`transcripts.segment.rotated bee=${beeId} from=${finished.cursor.path} to=${path} line=${cursor.lineNo}`);
    }
    const current = await this.cutFile(bee, cursor, this.harnessFor(store, bee, path));
    total = { segments: total.segments + current.segments, lines: total.lines + current.lines };
    if (total.segments > 0) {
      this.diagnostics.cuts += 1;
      this.diagnostics.segments += total.segments;
      this.diagnostics.lines += total.lines;
      this.deps.log(`transcripts.segment.cut bee=${beeId} reason=${reason} segments=${total.segments} lines=${total.lines} through=${current.cursor.lineNo}`);
    }
    return { status: total.segments > 0 ? "cut" : "nothing", ...total };
  }

  private harnessFor(store: CoreStore, bee: BeeRow, path: string): { harness: string; logSegmentId: string | null } {
    const segment = store.listTranscriptSegments(bee.id).find((s) => s.path === path) ?? store.currentTranscriptSegment(bee.id);
    return { harness: segment?.harness ?? bee.agent, logSegmentId: segment?.id ?? null };
  }

  private async cutFile(bee: BeeRow, start: Cursor, source: { harness: string; logSegmentId: string | null }): Promise<{ segments: number; lines: number; cursor: Cursor }> {
    const store = this.deps.store();
    let cursor = start;
    let size: number;
    try {
      size = (await stat(cursor.path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { segments: 0, lines: 0, cursor };
      throw error;
    }
    if (size < cursor.byteOffset) {
      this.deps.log(`transcripts.segment.log_shrunk bee=${bee.id} path=${cursor.path} size=${size} cursor=${cursor.byteOffset}`);
      cursor = { ...cursor, byteOffset: 0, epoch: randomUUID(), projectorCheckpoint: null };
      store.putTranscriptSegmentCursor(bee.id, cursor);
    }
    if (size === cursor.byteOffset) return { segments: 0, lines: 0, cursor };
    const projector = await this.projectorFor(bee, cursor, source.harness);
    const handle = await open(cursor.path, "r");
    let segments = 0;
    let lines = 0;
    try {
      let chunk = this.deps.readChunkBytes ?? DEFAULT_READ_CHUNK;
      while (cursor.byteOffset < size) {
        const chunkStart = cursor.byteOffset;
        const want = Math.min(chunk, size - chunkStart);
        const data = Buffer.alloc(want);
        let read = 0;
        while (read < want) {
          const { bytesRead } = await handle.read(data, read, want - read, chunkStart + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        const scanned = scanLogLines(data.subarray(0, read), cursor.lineNo, chunkStart);
        if (scanned.lines.length === 0) {
          if (read < want || chunkStart + read >= size) break;
          chunk *= 2;
          continue;
        }
        const observedAt = this.deps.now();
        const projected: ProjectedLine[] = scanned.lines.map((line) => ({
          line_no: line.lineNo, byte_offset: line.byteOffset, raw_bytes: line.rawBytes, raw_sha256: line.rawSha256, observed_at: observedAt, harness: source.harness,
          events: JSON.stringify(projector.pushLine(line.text)),
        }));
        for (const group of this.groups(scanned.lines)) {
          if (this.stopping) return { segments, lines, cursor };
          const first = scanned.lines[group.from]!;
          const last = scanned.lines[group.to]!;
          const rawSlice = Buffer.from(data.subarray(first.byteOffset - chunkStart, last.nextByteOffset - chunkStart));
          const projectedLines = projected.slice(group.from, group.to + 1);
          const encoded = encodeProjectedSegment(projectedLines, { beeId: bee.id, harness: source.harness, projectionVersion: TRANSCRIPT_PROJECTION_VERSION });
          const rawObject = this.deps.objectStore.putBytes(compressSegment(rawSlice));
          const projectedObject = this.deps.objectStore.putBytes(compressSegment(encoded));
          const next: Cursor = { path: cursor.path, lineNo: last.lineNo, byteOffset: last.nextByteOffset, epoch: cursor.epoch, projectorCheckpoint: projector.checkpoint() };
          store.putTranscriptSegmentObject({
            beeId: bee.id,
            ordinal: (store.lastTranscriptSegmentObject(bee.id)?.ordinal ?? -1) + 1,
            firstLine: first.lineNo,
            lastLine: last.lineNo,
            byteStart: first.byteOffset,
            byteEnd: last.nextByteOffset,
            harness: source.harness,
            rawRef: rawObject.ref,
            rawSize: rawSlice.length,
            rawBytes: rawObject.bytes,
            projectedRef: projectedObject.ref,
            projectedSize: encoded.length,
            projectedBytes: projectedObject.bytes,
            projectionVersion: TRANSCRIPT_PROJECTION_VERSION,
            digest: segmentDigest(projectedLines),
            closedAt: this.deps.now(),
            epoch: cursor.epoch,
            path: cursor.path,
            logSegmentId: source.logSegmentId,
          }, next);
          cursor = next;
          segments += 1;
          lines += projectedLines.length;
        }
        if (read < want) break;
      }
    } finally {
      await handle.close();
    }
    return { segments, lines, cursor };
  }

  private groups(lines: ScannedLine[]): Array<{ from: number; to: number }> {
    const maxLines = this.deps.maxLines ?? SEGMENT_MAX_LINES;
    const maxBytes = this.deps.maxRawBytes ?? SEGMENT_MAX_RAW_BYTES;
    const out: Array<{ from: number; to: number }> = [];
    let from = 0;
    let bytes = 0;
    for (let i = 0; i < lines.length; i += 1) {
      bytes += lines[i]!.nextByteOffset - lines[i]!.byteOffset;
      const count = i - from + 1;
      if (count >= maxLines || bytes >= maxBytes) {
        out.push({ from, to: i });
        from = i + 1;
        bytes = 0;
      }
    }
    if (from < lines.length) out.push({ from, to: lines.length - 1 });
    return out;
  }

  private async projectorFor(bee: BeeRow, cursor: Cursor, harness: string): Promise<TranscriptProjector> {
    if (cursor.byteOffset === 0) return createTranscriptProjector(harness);
    if (cursor.projectorCheckpoint != null) {
      const restored = restoreTranscriptProjector(harness, cursor.projectorCheckpoint);
      if (restored.ok) return restored.projector;
      this.deps.log(`transcripts.segment.checkpoint_rejected bee=${bee.id} reason=${restored.reason}`);
    }
    const projector = createTranscriptProjector(harness);
    const limit = this.deps.projectorReplayLimitBytes ?? DEFAULT_PROJECTOR_REPLAY_LIMIT;
    if (cursor.byteOffset > limit) {
      this.deps.log(`transcripts.segment.projector_reset bee=${bee.id} prefix=${cursor.byteOffset} limit=${limit}`);
      return projector;
    }
    const handle = await open(cursor.path, "r");
    try {
      const data = Buffer.alloc(cursor.byteOffset);
      let read = 0;
      while (read < cursor.byteOffset) {
        const { bytesRead } = await handle.read(data, read, cursor.byteOffset - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      for (const line of scanLogLines(data.subarray(0, read), 0, 0).lines) projector.pushLine(line.text);
    } finally {
      await handle.close();
    }
    return projector;
  }
}
