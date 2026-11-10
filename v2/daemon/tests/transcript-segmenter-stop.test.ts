import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CoreStore } from "../../core/src/store.ts";
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
