import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { TRANSCRIPT_SEGMENTS_MAX_ROWS } from "../../daemon/src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli } from "../src/main.ts";

const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
};

test("hive transcript --segments and --from-objects read every segment row of a long transcript, live and stale", { timeout: 120_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  const rows = TRANSCRIPT_SEGMENTS_MAX_ROWS + 37;
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    store.createBee({ id: "long", name: "long", agent: "stub", substrate: "hsr", cwd: dir });
    store.updateRuntimeState("long", 1, "stopped", { exitCause: "clean" });
    store.transact(() => {
      for (let ordinal = 0; ordinal < rows; ordinal++) {
        store.putTranscriptSegmentObject({
          beeId: "long", ordinal, firstLine: ordinal * 2 + 1, lastLine: ordinal * 2 + 2, byteStart: ordinal * 20, byteEnd: ordinal * 20 + 20, harness: "stub",
          rawRef: "a".repeat(64), rawSize: 100, rawBytes: 60, projectedRef: "b".repeat(64), projectedSize: 200, projectedBytes: 90,
          projectionVersion: 7, digest: "c".repeat(64), closedAt: 5, epoch: null, path: "/logs/bee.jsonl", logSegmentId: null,
        }, { path: "/logs/bee.jsonl", lineNo: ordinal * 2 + 2, byteOffset: ordinal * 20 + 20, epoch: null, projectorCheckpoint: null });
      }
    });
    store.close();

    const listed = async (): Promise<{ stale?: boolean; segments: Array<{ ordinal: number }>; cursor: { lineNo: number } | null }> => {
      const io = capture();
      assert.equal(await runV2Cli(["transcript", "long", "--segments", "--data-dir", dir, "--json"], io.io), 0, io.err.join("\n"));
      return JSON.parse(io.out[0]!);
    };
    const rendered = async (): Promise<{ segments: number; missing: number }> => {
      const io = capture();
      assert.equal(await runV2Cli(["transcript", "long", "--from-objects", "--data-dir", dir, "--json"], io.io), 2, io.err.join("\n"));
      return JSON.parse(io.out[0]!);
    };

    daemon = await startDaemon(dir);
    const live = await listed();
    assert.equal(live.stale, undefined);
    assert.equal(live.segments.length, rows);
    assert.deepEqual(live.segments.map(row => row.ordinal), Array.from({ length: rows }, (_, ordinal) => ordinal));
    assert.equal(live.cursor?.lineNo, rows * 2);
    const fromObjects = await rendered();
    assert.deepEqual([fromObjects.segments, fromObjects.missing], [rows, rows], "every row is visited; this fixture stores no objects");

    await daemon.stop();
    daemon = null;
    const stale = await listed();
    assert.equal(stale.stale, true);
    assert.equal(stale.segments.length, rows);
  } finally { await daemon?.stop(); cleanup(); }
});
