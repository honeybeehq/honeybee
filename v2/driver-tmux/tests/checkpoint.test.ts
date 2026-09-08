import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptProjector, restoreTranscriptProjector } from "../src/transcripts.ts";
import { TRANSCRIPT_CHECKPOINT_MAX_BYTES } from "../src/transcript-projection.ts";

for (const harness of ["codex", "grok", "agy", "claude", "stub", "unknown-provider"]) {
  test(`${harness}: exact checkpoint validation`, () => {
    const checkpoint = createTranscriptProjector(harness).checkpoint();
    assert.equal(restoreTranscriptProjector(harness, checkpoint).ok, true);
    for (const invalid of [null, [], {}, { ...checkpoint, extra: true },
      { ...checkpoint, state: { extra: true } }, { ...checkpoint, state: [] },
      { ...checkpoint, stateVersion: "1" }, { ...checkpoint, state: undefined }]) {
      assert.deepEqual(restoreTranscriptProjector(harness, invalid), { ok: false, reason: "invalid_checkpoint" });
    }
    for (const [field, value, reason] of [
      ["harness", "other", "harness_mismatch"],
      ["projectionVersion", 2, "projection_version_mismatch"],
      ["stateVersion", 2, "state_version_mismatch"],
    ] as const) {
      assert.deepEqual(restoreTranscriptProjector(harness, { ...checkpoint, [field]: value }), { ok: false, reason });
    }
  });
}

test("reject lossy JSON, exotic objects, cycles, and throwing accessors without throwing", () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  for (const state of [cyclic, NaN, Infinity, 1n, new Map(), new Date(), [undefined], new Array(1),
    { x: undefined }, { get x() { throw new Error("getter must not run"); } }]) {
    assert.deepEqual(restoreTranscriptProjector("claude", {
      ...createTranscriptProjector("claude").checkpoint(), state,
    }), { ok: false, reason: "invalid_checkpoint" });
  }
});

test("4 MiB UTF-8 JSON envelope boundary is inclusive", () => {
  const checkpoint = createTranscriptProjector("grok").checkpoint();
  const state = checkpoint.state as { pendingPromptMirror: string | null };
  state.pendingPromptMirror = "";
  const overhead = Buffer.byteLength(JSON.stringify(checkpoint));
  state.pendingPromptMirror = "x".repeat(TRANSCRIPT_CHECKPOINT_MAX_BYTES - overhead);
  assert.equal(restoreTranscriptProjector("grok", checkpoint).ok, true);
  state.pendingPromptMirror += "x";
  assert.deepEqual(restoreTranscriptProjector("grok", checkpoint), { ok: false, reason: "state_too_large" });
  state.pendingPromptMirror = "ø".repeat(TRANSCRIPT_CHECKPOINT_MAX_BYTES / 2);
  assert.deepEqual(restoreTranscriptProjector("grok", checkpoint), { ok: false, reason: "state_too_large" });
});

test("checkpoint and restore detach nested provider data; checkpoint never flushes chunks", () => {
  const p = createTranscriptProjector("grok");
  p.pushLine(JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: "hello " } } }));
  const snapshot = p.checkpoint();
  const restored = restoreTranscriptProjector("grok", snapshot);
  assert.ok(restored.ok);
  const state = snapshot.state as { openChunk: { text: string } };
  state.openChunk.text = "corrupted";
  const next = JSON.stringify({ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: "world" } } });
  assert.deepEqual(p.pushLine(next), []);
  assert.deepEqual(restored.projector.pushLine(next), []);
  assert.deepEqual(p.flush(), [{ kind: "message", role: "assistant", text: "hello world", ts: null }]);
  assert.deepEqual(restored.projector.flush(), [{ kind: "message", role: "assistant", text: "hello world", ts: null }]);
});

test("provider-owned nested state rejects unknown fields, bad types and duplicate map keys", () => {
  const cases: Array<[string, unknown]> = [
    ["codex", { startedItems: [["i", 2]] }],
    ["codex", { startedItems: [["i", {}], ["i", {}]] }],
    ["codex", { rolloutMessages: ["same", "same"] }],
    ["codex", { rolloutTurnOpen: 1 }],
    ["grok", { openChunk: { kind: "message", role: "assistant", text: "x", ts: null, extra: true } }],
    ["grok", { openChunk: { kind: "message", role: "tool", text: "x", ts: null } }],
    ["grok", { tools: [["t", { name: "tool", callEmitted: true, resultEmitted: false, status: 4 }]] }],
    ["grok", { tools: [["t", { name: "tool", callEmitted: true, resultEmitted: false, extra: true }]] }],
    ["agy", { previousResultUsage: { bogus: 1 } }],
    ["agy", { assistantFragments: [["m", { text: "x", extra: true }]] }],
  ];
  for (const [harness, patch] of cases) {
    const checkpoint = createTranscriptProjector(harness).checkpoint();
    checkpoint.state = { ...checkpoint.state as object, ...patch as object };
    assert.deepEqual(restoreTranscriptProjector(harness, checkpoint), { ok: false, reason: "invalid_checkpoint" });
  }
});
