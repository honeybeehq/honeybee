import { test } from "node:test";
import assert from "node:assert/strict";
import { MIRROR_BEE_RECORD_KEYS, MIRROR_BEE_RECORD_OPTIONAL_KEYS, mirrorBeeRow, replayAudit, startTokenTally, tallyEvents, type TokenTally } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const segment = (beeId: string, ordinal: number, firstLine: number, lastLine: number) => ({
  beeId, ordinal, firstLine, lastLine, byteStart: (firstLine - 1) * 10, byteEnd: lastLine * 10, harness: "claude",
  rawRef: "a".repeat(64), rawSize: 100, rawBytes: 60, projectedRef: "b".repeat(64), projectedSize: 200, projectedBytes: 90,
  projectionVersion: 8, digest: "c".repeat(64), closedAt: 5, epoch: null, path: "/logs/bee.jsonl", logSegmentId: null,
});
const cursor = (lineNo: number, tokenTally: TokenTally | null) => ({ path: "/logs/bee.jsonl", lineNo, byteOffset: lineNo * 10, epoch: null, projectorCheckpoint: null, tokenTally });
const turn = (tally: TokenTally, input: number, output: number, model: string) =>
  tallyEvents(tally, [{ kind: "token_usage", scope: "turn", usage: { input, output, cacheRead: 100, cacheWrite: 10 }, model }, { kind: "turn_end" }], { rootThreadId: null });

test("token totals: absent until known; a cut writes them on the bee row and on its existing segment.ready delta; replay agrees; a reopen keeps them", () => {
  const h = harness();
  try {
    let store = h.open();
    const { bee } = makeBee(store);
    const fresh = mirrorBeeRow(store.getBee(bee.id))!;
    for (const key of MIRROR_BEE_RECORD_OPTIONAL_KEYS) assert.equal(key in fresh, false, `${key} is absent while unknown`);

    const one = turn(startTokenTally(), 10, 20, "claude-opus-5-5");
    const two = turn(one, 5, 7, "claude-sonnet-5-5");
    const before = store.auditRows().length;
    store.putTranscriptSegmentObjects([
      { segment: segment(bee.id, 0, 1, 3), cursor: cursor(3, one) },
      { segment: segment(bee.id, 1, 4, 6), cursor: cursor(6, two) },
    ], { reason: "turn_ended" });
    const kinds = store.auditRows().slice(before).map((r) => r.kind);
    assert.deepEqual(kinds, ["transcript_segment_object.put", "transcript_segment_object.put", "transcript.segment.ready"], "no delta is added for the totals");

    const expected = { tokens: { input: 15, output: 27, cacheRead: 200, cacheWrite: 20 }, turns: 2, lastModel: "claude-sonnet-5-5" };
    const row = mirrorBeeRow(store.getBee(bee.id))!;
    assert.deepEqual({ tokens: row.tokens, turns: row.turns, lastModel: row.lastModel }, expected);
    assert.deepEqual(Object.keys(row).sort(), [...MIRROR_BEE_RECORD_KEYS, ...MIRROR_BEE_RECORD_OPTIONAL_KEYS].sort());
    assert.deepEqual(store.listBees().find((b) => b.id === bee.id)!.tokens, expected.tokens);
    const ready = store.auditRows().at(-1)!;
    assert.deepEqual({ tokens: ready.payload.tokens, turns: ready.payload.turns, lastModel: ready.payload.lastModel }, expected);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState(), "replay applies segment.ready totals to the bee");
    assert.deepEqual(store.getTranscriptSegmentCursor(bee.id)!.tokenTally, two, "the tally state travels with the cursor");

    store.close();
    store = h.open();
    const reopened = store.getBee(bee.id)!;
    assert.deepEqual({ tokens: reopened.tokens, turns: reopened.turns, lastModel: reopened.lastModel }, expected);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("token totals: an unknown tally leaves the row unknown, and leaves known totals as they are", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    store.putTranscriptSegmentObjects([{ segment: segment(bee.id, 0, 1, 3), cursor: cursor(3, null) }], { reason: "turn_ended" });
    assert.equal("tokens" in store.getBee(bee.id)!, false);
    const ready = store.auditRows().at(-1)!;
    assert.equal(ready.kind, "transcript.segment.ready");
    assert.equal("tokens" in ready.payload, false, "the delta carries no stand-in zeros");

    const other = makeBee(store, "other").bee;
    const known = turn(startTokenTally(), 1, 1, "m");
    store.putTranscriptSegmentObjects([{ segment: segment(other.id, 0, 1, 3), cursor: cursor(3, known) }], { reason: "turn_ended" });
    store.putTranscriptSegmentCursor(other.id, cursor(3, null));
    assert.equal(store.getBee(other.id)!.turns, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});
