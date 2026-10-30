import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutTranscript, type TranscriptCutRequest } from "../src/transcriptSegmentWorker.ts";
import { createDirectoryTranscriptObjectStore } from "../src/transcriptObjectStore.ts";
import { decodeProjectedSegment, decompressSegment } from "../../driver-tmux/src/transcript-segment-format.ts";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "hb-h4-cut-"));
  const path = join(root, "bee.jsonl");
  const line = (i: number, pad = 0) => JSON.stringify({ event: "output", i, text: "x".repeat(pad) });
  const request = (cursor: TranscriptCutRequest["cursor"], extra: Partial<TranscriptCutRequest> = {}): TranscriptCutRequest => ({
    beeId: "bee-1", cursor, harness: "stub", logSegmentId: null, storeRoot: join(root, "objects"),
    maxLines: 4, maxRawBytes: 10_000, chunkBytes: 64, maxChunkBytes: 4096, replayLimitBytes: 1024 * 1024, observedAt: 1_000, ...extra,
  });
  return { root, path, line, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("cut: small chunks stream a log into dense byte-exact segments, a torn tail waits, and the cursor resumes without re-reading", async () => {
  const r = rig();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => r.line(i + 1));
    writeFileSync(r.path, `${lines.join("\n")}\n{"torn":`);
    const first = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null }));
    assert.equal(first.error, null);
    assert.deepEqual(first.segments.map((s) => [s.segment.firstLine, s.segment.lastLine]), [[1, 4], [5, 8], [9, 10]]);
    const log = readFileSync(r.path);
    const store = createDirectoryTranscriptObjectStore(join(r.root, "objects"));
    for (const { segment } of first.segments) {
      const raw = decompressSegment(store.read(segment.rawRef)!);
      assert.ok(raw.equals(log.subarray(segment.byteStart, segment.byteEnd)));
      assert.equal(createHash("sha256").update(store.read(segment.rawRef)!).digest("hex"), segment.rawRef);
      const projected = decodeProjectedSegment(decompressSegment(store.read(segment.projectedRef)!));
      assert.equal(projected.lines.length, segment.lastLine - segment.firstLine + 1);
      assert.equal(projected.lines[0]!.observed_at, 1_000);
    }
    const lastEnd = first.segments[2]!.segment.byteEnd;
    assert.equal(first.cursor.byteOffset, lastEnd, "the torn tail is not consumed");
    assert.equal(first.cursor.lineNo, 10);
    assert.ok(first.cursor.projectorCheckpoint, "the projector state travels with the cursor");

    appendFileSync(r.path, `1}\n${r.line(12)}\n`);
    const second = await cutTranscript(r.request(first.cursor));
    assert.deepEqual(second.segments.map((s) => [s.segment.firstLine, s.segment.lastLine, s.segment.byteStart]), [[11, 12, lastEnd]]);
    assert.equal(second.segments[0]!.cursor.byteOffset, readFileSync(r.path).length);
    assert.equal(second.checkpointRejected, null);
  } finally {
    r.cleanup();
  }
});

test("cut: a line longer than the chunk grows the read window up to the cap; one longer than the cap is left for a later cut", async () => {
  const r = rig();
  try {
    writeFileSync(r.path, `${r.line(1, 500)}\n${r.line(2)}\n${r.line(3, 10_000)}\n`);
    const result = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null }));
    assert.equal(result.error, null);
    assert.deepEqual(result.segments.map((s) => [s.segment.firstLine, s.segment.lastLine]), [[1, 2]]);
    assert.ok(result.cursor.byteOffset < readFileSync(r.path).length, "the oversized line stays uncut");
    const again = await cutTranscript(r.request(result.cursor, { maxChunkBytes: 1024 * 1024 }));
    assert.deepEqual(again.segments.map((s) => [s.segment.firstLine, s.segment.lastLine]), [[3, 3]]);
  } finally {
    r.cleanup();
  }
});

test("cut: a shrunk log starts a new epoch at byte 0 while line numbers keep climbing; a missing log cuts nothing", async () => {
  const r = rig();
  try {
    writeFileSync(r.path, `${r.line(1)}\n${r.line(2)}\n`);
    const first = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null }));
    assert.equal(first.cursor.lineNo, 2);
    truncateSync(r.path, 0);
    writeFileSync(r.path, `${r.line(3)}\n`);
    const second = await cutTranscript(r.request(first.cursor));
    assert.equal(second.shrunk, true);
    assert.ok(second.cursor.epoch, "a shrink mints an epoch");
    assert.deepEqual(second.segments.map((s) => [s.segment.firstLine, s.segment.lastLine, s.segment.byteStart, s.segment.epoch]), [[3, 3, 0, second.cursor.epoch]]);
    rmSync(r.path);
    const missing = await cutTranscript(r.request(second.cursor));
    assert.equal(missing.missing, true);
    assert.deepEqual(missing.segments, []);
  } finally {
    r.cleanup();
  }
});

test("cut: a rejected checkpoint replays the prefix in chunks and projects the same events as an uninterrupted projector", async () => {
  const r = rig();
  try {
    const lines = Array.from({ length: 9 }, (_, i) => r.line(i + 1, 40));
    writeFileSync(r.path, `${lines.join("\n")}\n`);
    const whole = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null }, { maxLines: 100 }));
    const resumedAt = whole.segments[0]!.segment.byteEnd;
    const partial = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null }, { maxLines: 5 }));
    const second = partial.segments[1]!;
    const resumed = await cutTranscript(r.request({ ...partial.segments[0]!.cursor, projectorCheckpoint: { bogus: true } }, { maxLines: 5 }));
    assert.equal(resumed.checkpointRejected, "invalid_checkpoint");
    assert.equal(resumed.projectorReset, false);
    assert.deepEqual(resumed.segments.map((s) => s.segment.digest), [second.segment.digest], "replaying the prefix reproduces the same projection");
    void resumedAt;
  } finally {
    r.cleanup();
  }
});
