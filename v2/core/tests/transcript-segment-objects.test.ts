import { test } from "node:test";
import assert from "node:assert/strict";
import { TranscriptSegmentOrdinalError, replayAudit } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const segment = (beeId: string, ordinal: number, firstLine: number, lastLine: number) => ({
  beeId, ordinal, firstLine, lastLine, byteStart: (firstLine - 1) * 10, byteEnd: lastLine * 10, harness: "stub",
  rawRef: "a".repeat(64), rawSize: 100, rawBytes: 60, projectedRef: "b".repeat(64), projectedSize: 200, projectedBytes: 90,
  projectionVersion: 7, digest: "c".repeat(64), closedAt: 5, epoch: null, path: "/logs/bee.jsonl", logSegmentId: null,
});

test("segment objects: pointer rows are dense per bee, land with their cursor, replay as informational deltas and cascade with the bee", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "writer");
    assert.equal(store.getTranscriptSegmentCursor(bee.id), null);
    const first = store.putTranscriptSegmentObject(segment(bee.id, 0, 1, 3), { path: "/logs/bee.jsonl", lineNo: 3, byteOffset: 30, epoch: null, projectorCheckpoint: { harness: "stub", state: 1 } });
    assert.equal(first.id, `${bee.id}:seg:0`);
    assert.throws(() => store.putTranscriptSegmentObject(segment(bee.id, 2, 4, 6), { path: "/logs/bee.jsonl", lineNo: 6, byteOffset: 60, epoch: null, projectorCheckpoint: null }), TranscriptSegmentOrdinalError);
    assert.equal(store.getTranscriptSegmentCursor(bee.id)?.lineNo, 3, "a refused row leaves the cursor alone");
    store.putTranscriptSegmentObject(segment(bee.id, 1, 4, 6), { path: "/logs/bee.jsonl", lineNo: 6, byteOffset: 60, epoch: "e1", projectorCheckpoint: null });
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id).map((r) => [r.ordinal, r.firstLine, r.lastLine]), [[0, 1, 3], [1, 4, 6]]);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { afterOrdinal: 0 }).map((r) => r.ordinal), [1]);
    assert.equal(store.lastTranscriptSegmentObject(bee.id)?.ordinal, 1);
    const cursor = store.getTranscriptSegmentCursor(bee.id);
    assert.deepEqual([cursor?.path, cursor?.lineNo, cursor?.byteOffset, cursor?.epoch, cursor?.projectorCheckpoint], ["/logs/bee.jsonl", 6, 60, "e1", null]);
    const deltas = store.auditRows().filter((r) => r.kind === "transcript_segment_object.put");
    assert.equal(deltas.length, 2);
    assert.equal((deltas[1]!.payload.segment as { ordinal: number }).ordinal, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState(), "pointer deltas are informational in replay");
    store.deleteBee(bee.id);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id), []);
    assert.equal(store.getTranscriptSegmentCursor(bee.id), null);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("segment objects: the newest rows read in ascending order without listing the rest, and the history start is one lookup", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "long");
    const { bee: other } = makeBee(store, "other");
    assert.equal(store.transcriptSegmentHistoryStartLine(bee.id), null);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 3 }), []);
    for (let ordinal = 0; ordinal < 7; ordinal++) {
      store.putTranscriptSegmentObject(segment(bee.id, ordinal, ordinal * 3 + 5, ordinal * 3 + 7), { path: "/logs/bee.jsonl", lineNo: ordinal * 3 + 7, byteOffset: ordinal * 30 + 70, epoch: null, projectorCheckpoint: null });
    }
    store.putTranscriptSegmentObject(segment(other.id, 0, 1, 3), { path: "/logs/bee.jsonl", lineNo: 3, byteOffset: 30, epoch: null, projectorCheckpoint: null });
    const all = store.listTranscriptSegmentObjects(bee.id);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 3 }), all.slice(-3));
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 3 }).map((r) => r.ordinal), [4, 5, 6]);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 1 }), [store.lastTranscriptSegmentObject(bee.id)]);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 50 }), all);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 3, beforeOrdinal: 4 }).map((r) => r.ordinal), [1, 2, 3]);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 3, beforeOrdinal: 2 }).map((r) => r.ordinal), [0, 1]);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 3, beforeOrdinal: 0 }), []);
    assert.deepEqual(store.listTranscriptSegmentObjects(bee.id, { last: 2, beforeOrdinal: 99 }).map((r) => r.ordinal), [5, 6]);
    assert.deepEqual(store.listTranscriptSegmentObjects(other.id, { last: 2 }).map((r) => r.ordinal), [0]);
    assert.equal(store.transcriptSegmentHistoryStartLine(bee.id), 5);
    assert.equal(store.transcriptSegmentHistoryStartLine(other.id), 1);
    assert.equal(store.transcriptSegmentHistoryStartLine("nobody"), null);
    const db = (store as unknown as { db: { prepare: (sql: string) => { all: (...args: Array<string | number>) => Array<{ detail: string }> } } }).db;
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM transcript_segment_objects WHERE bee_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT ?").all(bee.id, 4, 3).map((row) => row.detail).join("\n");
    assert.match(plan, /SEARCH transcript_segment_objects USING INDEX/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
    store.close();
  } finally {
    h.cleanup();
  }
});
