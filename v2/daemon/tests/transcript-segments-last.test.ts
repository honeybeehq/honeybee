import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type TranscriptSegmentsResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

const segment = (beeId: string, ordinal: number) => ({
  beeId, ordinal, firstLine: ordinal * 3 + 5, lastLine: ordinal * 3 + 7, byteStart: ordinal * 30 + 40, byteEnd: ordinal * 30 + 70, harness: "stub",
  rawRef: "a".repeat(64), rawSize: 100, rawBytes: 60, projectedRef: "b".repeat(64), projectedSize: 200, projectedBytes: 90,
  projectionVersion: 7, digest: "c".repeat(64), closedAt: 5, epoch: null, path: "/logs/bee.jsonl", logSegmentId: null,
});

async function refusal(run: Promise<unknown>): Promise<string> {
  try { await run; }
  catch (error) {
    assert.ok(error instanceof RpcError, String(error));
    assert.equal(error.code, "invalid_request");
    return error.message;
  }
  throw new Error("request was answered");
}

test("transcript.segments: last returns the newest rows ascending, beforeOrdinal pages back, and every reply names where the history starts", { timeout: 120_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  let client: RpcClient | null = null;
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    for (const id of ["long", "empty"]) {
      store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: dir });
      store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
    }
    for (let ordinal = 0; ordinal < 7; ordinal++) {
      store.putTranscriptSegmentObject(segment("long", ordinal), { path: "/logs/bee.jsonl", lineNo: ordinal * 3 + 7, byteOffset: ordinal * 30 + 70, epoch: null, projectorCheckpoint: null });
    }
    store.close();
    daemon = await startDaemon(dir);
    client = await daemon.client();
    assert.ok(client.capabilities.includes("transcript.segments.v3"));
    const read = (params: Record<string, unknown>) => client!.request<TranscriptSegmentsResult>("transcript.segments", { beeId: "long", ...params });

    const all = await read({});
    assert.deepEqual(all.segments.map(row => row.ordinal), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(all.historyStartLine, 5);
    assert.equal(all.cursor?.lineNo, 25);

    const newest = await read({ last: 3 });
    assert.deepEqual(newest, { ...all, segments: all.segments.slice(-3) });
    assert.equal(newest.segments[0]!.firstLine, 17, "the window starts later than the history does");

    const older = await read({ last: 3, beforeOrdinal: newest.segments[0]!.ordinal });
    assert.deepEqual(older, { ...all, segments: all.segments.slice(1, 4) });
    const oldest = await read({ last: 3, beforeOrdinal: older.segments[0]!.ordinal });
    assert.deepEqual(oldest.segments.map(row => row.ordinal), [0]);
    assert.equal(oldest.segments[0]!.firstLine, oldest.historyStartLine, "a window that reaches ordinal 0 starts where the history starts");
    assert.deepEqual((await read({ last: 3, beforeOrdinal: 0 })).segments, []);
    assert.deepEqual((await read({ last: 10_000 })).segments, all.segments);
    assert.deepEqual((await read({ afterOrdinal: 4, limit: 1 })), { ...all, segments: [all.segments[5]] });

    const empty = await client.request<TranscriptSegmentsResult>("transcript.segments", { beeId: "empty", last: 5 });
    assert.deepEqual([empty.segments, empty.cursor, empty.historyStartLine], [[], null, null]);

    for (const last of [0, -1, 1.5, 10_001, "3", null]) assert.match(await refusal(read({ last })), /last must be an integer from 1 to 10000/, String(last));
    for (const beforeOrdinal of [-1, 1.5, "4", null]) assert.match(await refusal(read({ last: 2, beforeOrdinal })), /beforeOrdinal must be a non-negative integer/, String(beforeOrdinal));
    assert.match(await refusal(read({ last: 2, limit: 1 })), /last cannot be combined with afterOrdinal or limit/);
    assert.match(await refusal(read({ last: 2, afterOrdinal: 0 })), /last cannot be combined with afterOrdinal or limit/);
    assert.match(await refusal(read({ beforeOrdinal: 3 })), /beforeOrdinal requires last/);
    assert.match(await refusal(read({ beforeOrdinal: 3, limit: 2 })), /beforeOrdinal requires last/);
    assert.match(await refusal(read({ limit: 10_001 })), /limit must be an integer from 1 to 10000 when given/);
  } finally { client?.close(); await daemon?.stop(); cleanup(); }
});
