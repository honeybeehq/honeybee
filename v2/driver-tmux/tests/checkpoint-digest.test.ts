import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { TRANSCRIPT_PROJECTION_VERSION, TRANSCRIPT_PROJECTOR_STATE_VERSION } from "../src/transcript-projection.ts";

const files = ["transcripts", "transcript-projection", "codex-projection", "grok-projection", "agy-projection", "claude-projection"];
const fixture = new URL("./fixtures/checkpoint-digest.json", import.meta.url);

test("projector source changes require checkpoint version review", () => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file}.ts\0`);
    hash.update(readFileSync(new URL(`../src/${file}.ts`, import.meta.url)));
    hash.update("\0");
  }
  const current = {
    projectionVersion: TRANSCRIPT_PROJECTION_VERSION,
    stateVersion: TRANSCRIPT_PROJECTOR_STATE_VERSION,
    digest: hash.digest("hex"),
  };
  const previous = existsSync(fixture) ? JSON.parse(readFileSync(fixture, "utf8")) : undefined;
  if (process.env.UPDATE_TRANSCRIPT_CHECKPOINT_DIGEST === "1") {
    assert.ok(!previous || previous.digest === current.digest
      || previous.projectionVersion !== current.projectionVersion || previous.stateVersion !== current.stateVersion,
    "Bump projectionVersion or stateVersion before refreshing the projector digest");
    writeFileSync(fixture, `${JSON.stringify(current, null, 2)}\n`);
  } else {
    assert.deepEqual(current, previous,
      "Projector source changed: bump projectionVersion for event semantics or stateVersion for state compatibility, then refresh digest with UPDATE_TRANSCRIPT_CHECKPOINT_DIGEST=1 node --test v2/driver-tmux/tests/checkpoint-digest.test.ts");
  }
});
