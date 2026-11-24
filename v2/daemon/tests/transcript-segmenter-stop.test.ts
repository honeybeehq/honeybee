import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { CoreStore } from "../../core/src/store.ts";
import { createDirectoryTranscriptObjectStore, TRANSCRIPT_OBJECT_DIR } from "../src/transcriptObjectStore.ts";
import { TranscriptSegmenter, type TranscriptSegmenterDeps } from "../src/transcriptSegmenter.ts";

const WORKER_LOAD_FAILURE_WAIT_MS = 400;

function blockEventLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
}

test("segmenter.stop: a worker whose load failure is still queued when it is retired does not end the process", async () => {
  const root = mkdtempSync(join(tmpdir(), "segmenter-stop-"));
  const logged: string[] = [];
  const segmenter = new TranscriptSegmenter({
    store: () => ({ listTranscriptSegmentObjectRefs: () => [] }) as unknown as CoreStore,
    objectStore: { locator: { root } } as unknown as TranscriptSegmenterDeps["objectStore"],
    now: () => 1000,
    log: (op) => logged.push(op),
    workerUrl: new URL("./no-such-transcript-segment-worker.js", import.meta.url),
  });
  const uncaught: unknown[] = [];
  const recordUncaught = (error: unknown): void => { uncaught.push(error); };
  process.on("uncaughtException", recordUncaught);
  try {
    const sweep = assert.rejects(segmenter.sweepOrphans(), /transcript segmenter stopped/);
    for (let turn = 0; turn < 8; turn++) await null;
    blockEventLoop(WORKER_LOAD_FAILURE_WAIT_MS);
    const stopped = segmenter.stop();
    await sweep;
    await stopped;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", recordUncaught);
  }
});

test("segmenter.stop: a worker stopped mid-cut exits on its own instead of being terminated inside a zstd call (HON-39)", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "segmenter-stop-mid-cut-"));
  const logPath = join(root, "session.jsonl");
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(2_000) }] } });
  writeFileSync(logPath, `${line}\n`.repeat(4_000));
  const bee = { id: "bee-1", lifecycle: "active", agent: "claude", sessionLogPath: logPath };
  const store = {
    getBee: () => bee,
    getTranscriptSegmentCursor: () => null,
    putTranscriptSegmentCursor: () => undefined,
    putTranscriptSegmentObjects: () => undefined,
    listTranscriptSegments: () => [],
    currentTranscriptSegment: () => null,
  } as unknown as CoreStore;
  const objectRoot = join(root, "objects");
  const segmenter = new TranscriptSegmenter({
    store: () => store,
    objectStore: createDirectoryTranscriptObjectStore(objectRoot),
    now: () => 1000,
    log: () => undefined,
    maxLines: 1,
    chunkBytes: 64 * 1024,
  });
  const liveTerminations: number[] = [];
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = function (this: Worker) {
    if (this.threadId >= 0) liveTerminations.push(this.threadId);
    return terminate.call(this);
  };
  try {
    const cut = segmenter.requestCut(bee.id, "turn_ended");
    const objects = join(objectRoot, TRANSCRIPT_OBJECT_DIR);
    const started = Date.now();
    while (!(existsSync(objects) && readdirSync(objects).length > 0)) {
      assert.ok(Date.now() - started < 30_000, "the cut never started writing objects");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await segmenter.stop();
    assert.deepEqual(await cut, { status: "nothing", segments: 0, lines: 0 });
    assert.deepEqual(liveTerminations, [], "stop() terminated a worker that was still cutting");
  } finally {
    Worker.prototype.terminate = terminate;
    rmSync(root, { recursive: true, force: true });
  }
});
