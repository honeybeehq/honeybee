import assert from "node:assert/strict";
import { createTranscriptProjector, restoreTranscriptProjector } from "../src/transcripts.ts";
import type { TranscriptProjector } from "../src/transcript-projection.ts";

/** Run every fixture through uninterrupted and JSON-restored streams at every boundary. */
export function checkpointVerifiedProjector(harness: string): TranscriptProjector {
  const uninterrupted = createTranscriptProjector(harness);
  let resumed = createTranscriptProjector(harness);
  const roundTrip = () => {
    const before = resumed.checkpoint();
    assert.deepEqual(resumed.checkpoint(), before, "checkpoint must be observational");
    const result = restoreTranscriptProjector(harness, JSON.parse(JSON.stringify(before)));
    assert.equal(result.ok, true);
    resumed = result.projector;
    assert.deepEqual(resumed.checkpoint(), before, "restore must preserve complete state");
  };
  roundTrip();
  return {
    harness: uninterrupted.harness,
    checkpoint: () => uninterrupted.checkpoint(),
    pushLine(line) {
      const expected = uninterrupted.pushLine(line);
      assert.deepEqual(resumed.pushLine(line), expected, `restored events: ${line}`);
      roundTrip();
      return expected;
    },
    flush() {
      const expected = uninterrupted.flush();
      assert.deepEqual(resumed.flush(), expected);
      roundTrip();
      return expected;
    },
  };
}
