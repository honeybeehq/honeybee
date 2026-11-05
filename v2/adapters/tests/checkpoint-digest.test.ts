import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { TRANSCRIPT_PROJECTION_VERSION, TRANSCRIPT_PROJECTOR_STATE_VERSION } from "../src/transcript.ts";

const statefulFiles = ["codex", "grok", "agy", "kimi", "muse"];
const sharedFiles = ["transcript", "transcripts"];
const fixture = new URL("./fixtures/checkpoint-digest.json", import.meta.url);

function source(file: string): string {
  return readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
}

function checkpointRegion(text: string): string {
  const parts = text.split(/\/\/ checkpoint-digest:(?:start|end)/);
  assert.equal(parts.length, 3, "A family module must have exactly one checkpoint digest region");
  assert.ok(text.indexOf("// checkpoint-digest:start") < text.indexOf("// checkpoint-digest:end"));
  return parts[1]!;
}

function digest(readSource = source): string {
  const hash = createHash("sha256");
  for (const file of [...statefulFiles, ...sharedFiles]) {
    hash.update(`${file}.ts\0`);
    hash.update(checkpointRegion(readSource(file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

test("projector source changes require checkpoint version review", () => {
  const current = {
    projectionVersion: TRANSCRIPT_PROJECTION_VERSION,
    stateVersion: TRANSCRIPT_PROJECTOR_STATE_VERSION,
    digest: digest(),
  };
  const previous = existsSync(fixture) ? JSON.parse(readFileSync(fixture, "utf8")) : undefined;
  if (process.env.UPDATE_TRANSCRIPT_CHECKPOINT_DIGEST === "1") {
    assert.ok(!previous || previous.digest === current.digest
      || previous.projectionVersion !== current.projectionVersion || previous.stateVersion !== current.stateVersion,
    "Bump projectionVersion or stateVersion before refreshing the projector digest");
    writeFileSync(fixture, `${JSON.stringify(current, null, 2)}\n`);
  } else {
    assert.deepEqual(current, previous,
      "Projector source changed: bump projectionVersion for event semantics or stateVersion for state compatibility, then refresh digest with UPDATE_TRANSCRIPT_CHECKPOINT_DIGEST=1 node --test v2/adapters/tests/checkpoint-digest.test.ts");
  }
});

test("checkpoint digest excludes stateless projectors, adapters and unrelated shared-module code", () => {
  assert.equal(digest((file) => {
    assert.notEqual(file, "claude");
    assert.notEqual(file, "stub");
    return `// adapter or observer edit\n${source(file)}\n// renderer edit`;
  }), digest());
});

test("checkpoint digest guards stateful projectors, registry and shared validators", () => {
  for (const changed of [...statefulFiles, ...sharedFiles]) {
    assert.notEqual(digest((file) => {
      const text = source(file);
      if (file !== changed) return text;
      return text.replace("// checkpoint-digest:start", "// checkpoint-digest:start\n// compatibility edit");
    }), digest(), changed);
  }
  assert.throws(() => checkpointRegion("no markers"));
  assert.throws(() => checkpointRegion("// checkpoint-digest:end\n// checkpoint-digest:start"));
});
