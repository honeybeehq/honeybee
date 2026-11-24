import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutTranscript, type TranscriptCutRequest } from "../src/transcriptSegmentWorker.ts";
import { beeTokenTotals, startTokenTally } from "../../core/src/tokenTally.ts";

/** One claude turn as stream-json lines: two lines of one API message, a second message, and the result. */
function claudeTurn(n: number): string {
  const rows = [
    { type: "user", uuid: `u${n}`, message: { role: "user", content: `do ${n}` } },
    { type: "assistant", uuid: `a${n}a`, message: { id: `msg_${n}_1`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "thinking", thinking: "hm" }], usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } } },
    { type: "assistant", uuid: `a${n}b`, message: { id: `msg_${n}_1`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: `t${n}`, name: "Bash", input: {} }], usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } } },
    { type: "user", uuid: `r${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${n}`, content: "ok" }] } },
    { type: "assistant", uuid: `a${n}c`, message: { id: `msg_${n}_2`, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "done" }], usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0 } } },
    // The turn total: per-message rows saw 12/45/2100/100, the true output was 50.
    { type: "result", subtype: "success", stop_reason: "end_turn", duration_ms: 10, usage: { input_tokens: 12, output_tokens: 50, cache_read_input_tokens: 2100, cache_creation_input_tokens: 100 } },
  ];
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}
const perTurn = { input: 12, output: 50, cacheRead: 2100, cacheWrite: 100 };
const times = (k: number) => ({ input: perTurn.input * k, output: perTurn.output * k, cacheRead: perTurn.cacheRead * k, cacheWrite: perTurn.cacheWrite * k });

function rig() {
  const root = mkdtempSync(join(tmpdir(), "hb-cut-tokens-"));
  const path = join(root, "bee.jsonl");
  const request = (cursor: TranscriptCutRequest["cursor"], extra: Partial<TranscriptCutRequest> = {}): TranscriptCutRequest => ({
    beeId: "bee-1", cursor, harness: "claude", logSegmentId: null, storeRoot: join(root, "objects"),
    maxLines: 4, maxRawBytes: 1_000_000, chunkBytes: 256, maxChunkBytes: 1 << 20, replayLimitBytes: 1 << 20, observedAt: 1_000, ...extra,
  });
  return { root, path, request, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("cut tokens: the projection's usage sums into the cursor tally, per segment, and a later cut counts only new lines", async () => {
  const r = rig();
  try {
    writeFileSync(r.path, claudeTurn(1) + claudeTurn(2));
    const first = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null, tokenTally: startTokenTally() }));
    assert.equal(first.error, null);
    assert.equal(first.segments.length, 3, "12 lines in segments of 4");
    // Each segment's cursor carries the tally through its last line (the store commits it per batch).
    assert.deepEqual(first.segments.map((s) => s.cursor.tokenTally!.turns), [0, 1, 2]);
    assert.deepEqual(beeTokenTotals(first.cursor.tokenTally!), { tokens: times(2), turns: 2, lastModel: "claude-opus-5-5" });

    appendFileSync(r.path, claudeTurn(3));
    const second = await cutTranscript(r.request(first.cursor));
    assert.deepEqual(beeTokenTotals(second.cursor.tokenTally!), { tokens: times(3), turns: 3, lastModel: "claude-opus-5-5" });

    // No new bytes: nothing projected, nothing counted.
    const idle = await cutTranscript(r.request(second.cursor));
    assert.equal(idle.segments.length, 0);
    assert.deepEqual(idle.cursor.tokenTally, second.cursor.tokenTally);
  } finally {
    r.cleanup();
  }
});

test("cut tokens: an unknown tally stays unknown; the projection is unchanged", async () => {
  const r = rig();
  try {
    writeFileSync(r.path, claudeTurn(1));
    const counted = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null, tokenTally: startTokenTally() }));
    const unknown = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null, tokenTally: null }));
    assert.equal(unknown.cursor.tokenTally, null);
    assert.ok(unknown.segments.every((s) => s.cursor.tokenTally === null));
    assert.deepEqual(unknown.segments.map((s) => s.segment.digest), counted.segments.map((s) => s.segment.digest), "the tally never changes projected output");
  } finally {
    r.cleanup();
  }
});

test("cut tokens: a shrunk log does not count its re-read prefix again; lines past the old end count", async () => {
  const r = rig();
  try {
    writeFileSync(r.path, claudeTurn(1) + claudeTurn(2));
    const first = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null, tokenTally: startTokenTally() }));
    writeFileSync(r.path, claudeTurn(1));
    const shrunk = await cutTranscript(r.request(first.cursor));
    assert.equal(shrunk.shrunk, true);
    assert.deepEqual(beeTokenTotals(shrunk.cursor.tokenTally!).tokens, times(2), "never backwards, never twice");
    appendFileSync(r.path, claudeTurn(2) + claudeTurn(3));
    const grown = await cutTranscript(r.request(shrunk.cursor));
    assert.deepEqual(beeTokenTotals(grown.cursor.tokenTally!), { tokens: times(3), turns: 3, lastModel: "claude-opus-5-5" });
    assert.equal(grown.cursor.tokenTally!.skipThrough, null);
  } finally {
    r.cleanup();
  }
});

test("cut tokens: a projector rebuilt by replaying the prefix does not count the prefix again", async () => {
  const r = rig();
  try {
    writeFileSync(r.path, claudeTurn(1));
    const first = await cutTranscript(r.request({ path: r.path, lineNo: 0, byteOffset: 0, epoch: null, projectorCheckpoint: null, tokenTally: startTokenTally() }));
    appendFileSync(r.path, claudeTurn(2));
    const replayed = await cutTranscript(r.request({ ...first.cursor, projectorCheckpoint: { harness: "claude", projectionVersion: -1, stateVersion: -1, state: {} } }));
    assert.equal(replayed.checkpointRejected, "projection_version_mismatch");
    assert.deepEqual(beeTokenTotals(replayed.cursor.tokenTally!).tokens, times(2));
  } finally {
    r.cleanup();
  }
});
