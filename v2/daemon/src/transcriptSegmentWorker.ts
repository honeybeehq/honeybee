import { parentPort, workerData } from "node:worker_threads";
import { open, stat } from "node:fs/promises";
import type { TranscriptSegmentCursorRow, TranscriptSegmentObjectRow } from "../../core/src/types.ts";
import { createTranscriptProjector, restoreTranscriptProjector } from "../../driver-tmux/src/transcripts.ts";
import { TRANSCRIPT_PROJECTION_VERSION, type TranscriptProjector } from "../../driver-tmux/src/transcript-projection.ts";
import { compressSegment, encodeProjectedSegment, scanLogLines, segmentDigest, type ProjectedLine, type ScannedLine } from "../../driver-tmux/src/transcript-segment-format.ts";
import { createDirectoryTranscriptObjectStore } from "./transcriptObjectStore.ts";

export type SegmentCursor = Omit<TranscriptSegmentCursorRow, "beeId" | "updatedAt">;
export type CutSegment = Omit<TranscriptSegmentObjectRow, "id" | "ordinal">;

export interface TranscriptCutRequest {
  beeId: string;
  cursor: SegmentCursor;
  harness: string;
  logSegmentId: string | null;
  storeRoot: string;
  maxLines: number;
  maxRawBytes: number;
  chunkBytes: number;
  maxChunkBytes: number;
  replayLimitBytes: number;
  observedAt: number;
}

export interface TranscriptCutResult {
  segments: Array<{ segment: CutSegment; cursor: SegmentCursor }>;
  cursor: SegmentCursor;
  written: { objects: number; bytes: number };
  shrunk: boolean;
  missing: boolean;
  checkpointRejected: string | null;
  projectorReset: boolean;
  error: string | null;
}

export function transcriptSegmentWorkerUrl(): URL {
  return import.meta.url.endsWith(".ts")
    ? new URL("./transcriptSegmentWorker.ts", import.meta.url)
    : new URL("./transcript-segment-worker.js", import.meta.url);
}

async function readAt(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(data, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return data.subarray(0, read);
}

async function replayPrefix(path: string, upTo: number, projector: TranscriptProjector, chunkBytes: number): Promise<void> {
  const handle = await open(path, "r");
  try {
    let position = 0;
    let carry = Buffer.alloc(0);
    while (position < upTo) {
      const data = await readAt(handle, position, Math.min(chunkBytes, upTo - position));
      if (data.length === 0) break;
      position += data.length;
      const joined = carry.length > 0 ? Buffer.concat([carry, data]) : data;
      const scanned = scanLogLines(joined, 0, 0);
      for (const line of scanned.lines) projector.pushLine(line.text);
      carry = Buffer.from(joined.subarray(scanned.consumedBytes));
    }
  } finally {
    await handle.close();
  }
}

async function projectorFor(request: TranscriptCutRequest, cursor: SegmentCursor, result: TranscriptCutResult): Promise<TranscriptProjector> {
  if (cursor.byteOffset === 0) return createTranscriptProjector(request.harness);
  if (cursor.projectorCheckpoint != null) {
    const restored = restoreTranscriptProjector(request.harness, cursor.projectorCheckpoint);
    if (restored.ok) return restored.projector;
    result.checkpointRejected = restored.reason;
  }
  const projector = createTranscriptProjector(request.harness);
  if (cursor.byteOffset > request.replayLimitBytes) {
    result.projectorReset = true;
    return projector;
  }
  await replayPrefix(cursor.path, cursor.byteOffset, projector, request.chunkBytes);
  return projector;
}

export async function cutTranscript(request: TranscriptCutRequest): Promise<TranscriptCutResult> {
  const result: TranscriptCutResult = { segments: [], cursor: request.cursor, written: { objects: 0, bytes: 0 }, shrunk: false, missing: false, checkpointRejected: null, projectorReset: false, error: null };
  let cursor = request.cursor;
  let size: number;
  try {
    size = (await stat(cursor.path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...result, missing: true };
    throw error;
  }
  if (size < cursor.byteOffset) {
    result.shrunk = true;
    cursor = { ...cursor, byteOffset: 0, epoch: crypto.randomUUID(), projectorCheckpoint: null };
    result.cursor = cursor;
  }
  if (size === cursor.byteOffset) return result;
  const projector = await projectorFor(request, cursor, result);
  const store = createDirectoryTranscriptObjectStore(request.storeRoot);
  const handle = await open(cursor.path, "r");
  const pending: Array<{ line: ScannedLine; raw: Buffer; projected: ProjectedLine }> = [];
  let pendingBytes = 0;
  const emit = (): void => {
    const first = pending[0]!.line;
    const last = pending[pending.length - 1]!.line;
    const raw = Buffer.concat(pending.map((p) => p.raw));
    const projectedLines = pending.map((p) => p.projected);
    const encoded = encodeProjectedSegment(projectedLines, { beeId: request.beeId, harness: request.harness, projectionVersion: TRANSCRIPT_PROJECTION_VERSION });
    const rawObject = store.putBytes(compressSegment(raw));
    const projectedObject = store.putBytes(compressSegment(encoded));
    for (const object of [rawObject, projectedObject]) {
      if (!object.created) continue;
      result.written.objects += 1;
      result.written.bytes += object.bytes;
    }
    const next: SegmentCursor = { path: cursor.path, lineNo: last.lineNo, byteOffset: last.nextByteOffset, epoch: cursor.epoch, projectorCheckpoint: projector.checkpoint() };
    result.segments.push({
      segment: {
        beeId: request.beeId, firstLine: first.lineNo, lastLine: last.lineNo, byteStart: first.byteOffset, byteEnd: last.nextByteOffset, harness: request.harness,
        rawRef: rawObject.ref, rawSize: raw.length, rawBytes: rawObject.bytes, projectedRef: projectedObject.ref, projectedSize: encoded.length, projectedBytes: projectedObject.bytes,
        projectionVersion: TRANSCRIPT_PROJECTION_VERSION, digest: segmentDigest(projectedLines), closedAt: request.observedAt, epoch: cursor.epoch, path: cursor.path, logSegmentId: request.logSegmentId,
      },
      cursor: next,
    });
    cursor = next;
    pending.length = 0;
    pendingBytes = 0;
  };
  try {
    let chunk = request.chunkBytes;
    let readPos = cursor.byteOffset;
    let lineNo = cursor.lineNo;
    while (readPos < size) {
      const data = await readAt(handle, readPos, Math.min(chunk, size - readPos));
      const scanned = scanLogLines(data, lineNo, readPos);
      if (scanned.lines.length === 0) {
        if (readPos + data.length >= size || chunk >= request.maxChunkBytes) break;
        chunk = Math.min(chunk * 2, request.maxChunkBytes);
        continue;
      }
      for (const line of scanned.lines) {
        const projected: ProjectedLine = {
          line_no: line.lineNo, byte_offset: line.byteOffset, raw_bytes: line.rawBytes, raw_sha256: line.rawSha256, observed_at: request.observedAt, harness: request.harness,
          events: JSON.stringify(projector.pushLine(line.text)),
        };
        pending.push({ line, raw: Buffer.from(data.subarray(line.byteOffset - readPos, line.nextByteOffset - readPos)), projected });
        pendingBytes += line.nextByteOffset - line.byteOffset;
        lineNo = line.lineNo;
        if (pending.length >= request.maxLines || pendingBytes >= request.maxRawBytes) emit();
      }
      readPos += scanned.consumedBytes;
      if (readPos + (data.length - scanned.consumedBytes) >= size) break;
    }
    if (pending.length > 0) emit();
  } finally {
    await handle.close();
  }
  result.cursor = cursor;
  return result;
}

if (parentPort && workerData && typeof (workerData as { beeId?: unknown }).beeId === "string") {
  cutTranscript(workerData as TranscriptCutRequest)
    .then((result) => parentPort!.postMessage(result))
    .catch((error: unknown) => parentPort!.postMessage({ segments: [], cursor: (workerData as TranscriptCutRequest).cursor, written: { objects: 0, bytes: 0 }, shrunk: false, missing: false, checkpointRejected: null, projectorReset: false, error: error instanceof Error ? error.message : String(error) } satisfies TranscriptCutResult));
}
