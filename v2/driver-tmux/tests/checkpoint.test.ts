import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranscriptProjector, restoreTranscriptProjector } from "../src/transcripts.ts";
import { serializeTranscriptCheckpoint, TRANSCRIPT_CHECKPOINT_MAX_BYTES } from "../src/transcript-projection.ts";

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
      ["projectionVersion", checkpoint.projectionVersion + 1, "projection_version_mismatch"],
      ["projectionVersion", checkpoint.projectionVersion - 1, "projection_version_mismatch"],
      ["stateVersion", checkpoint.stateVersion + 1, "state_version_mismatch"],
      ["stateVersion", checkpoint.stateVersion - 1, "state_version_mismatch"],
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


test("fallback dialect differs from the exact checkpoint registry key", () => {
  const projector = createTranscriptProjector("future-provider");
  assert.equal(projector.harness, "claude");
  assert.equal(projector.checkpoint().harness, "future-provider");
  assert.ok(restoreTranscriptProjector("future-provider", projector.checkpoint()).ok);
  assert.deepEqual(restoreTranscriptProjector(projector.harness, projector.checkpoint()), {
    ok: false, reason: "harness_mismatch",
  });
});

test("Grok retains tool dedupe without retaining already emitted large inputs", () => {
  let projector = createTranscriptProjector("grok");
  const input = { content: "x".repeat(100_000) };
  const update = (payload: unknown) => JSON.stringify({ method: "session/update", params: { update: payload } });
  for (let index = 0; index < 50; index++) {
    const toolCallId = `tool-${index}`;
    assert.deepEqual(projector.pushLine(update({ sessionUpdate: "tool_call", toolCallId, title: "write", rawInput: input })), [
      { kind: "tool_call", ts: null, callId: toolCallId, name: "write", input },
    ]);
    const checkpoint = projector.checkpoint();
    assert.ok(Buffer.byteLength(JSON.stringify(checkpoint)) < 10_000);
    const restored = restoreTranscriptProjector("grok", JSON.parse(JSON.stringify(checkpoint)));
    assert.ok(restored.ok);
    projector = restored.projector;
    const completion = update({ sessionUpdate: "tool_call_update", toolCallId, rawInput: input, status: "completed", rawOutput: "written" });
    assert.deepEqual(projector.pushLine(completion), [
      { kind: "tool_result", ts: null, callId: toolCallId, name: "write", isError: false, output: "written" },
    ]);
    assert.deepEqual(projector.pushLine(completion), []);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(projector.checkpoint())) < 10_000);
});

test("shared serialization preserves lone surrogates through UTF-8 JSON storage", () => {
  const projector = createTranscriptProjector("grok");
  projector.pushLine(JSON.stringify({ method: "session/update", params: { update: {
    sessionUpdate: "agent_message_chunk", content: "\ud800",
  } } }));
  const serialized = serializeTranscriptCheckpoint(projector.checkpoint());
  assert.ok(serialized.ok);
  assert.equal(serialized.bytes, Buffer.byteLength(serialized.json, "utf8"));
  const restored = restoreTranscriptProjector("grok", JSON.parse(Buffer.from(serialized.json, "utf8").toString("utf8")));
  assert.ok(restored.ok);
  assert.deepEqual(restored.projector.flush(), projector.flush());
  assert.deepEqual(serializeTranscriptCheckpoint({ value: "x".repeat(TRANSCRIPT_CHECKPOINT_MAX_BYTES) }), {
    ok: false, reason: "state_too_large",
  });
});


test("Grok restored tool inputs remain available only to an un-emitted call", () => {
  for (const callEmitted of [false, true]) {
    for (const replacement of [undefined, null, { text: "replacement" }]) {
      const checkpoint = createTranscriptProjector("grok").checkpoint();
      const priorInput = { text: "restored" };
      checkpoint.state = {
        openChunk: null, pendingPromptMirror: null, seenCompactions: [],
        tools: [["restored-tool", { name: "write", input: priorInput, callEmitted, resultEmitted: false }]],
      };
      const restored = restoreTranscriptProjector("grok", checkpoint);
      assert.ok(restored.ok);
      const update = JSON.stringify({ method: "session/update", params: { update: {
        sessionUpdate: "tool_call_update", toolCallId: "restored-tool", status: "completed", rawOutput: "done",
        ...(replacement !== undefined ? { rawInput: replacement } : {}),
      } } });
      const result = { kind: "tool_result", ts: null, callId: "restored-tool", name: "write", isError: false, output: "done" };
      assert.deepEqual(restored.projector.pushLine(update), callEmitted ? [result] : [
        { kind: "tool_call", ts: null, callId: "restored-tool", name: "write", input: replacement === undefined ? priorInput : replacement }, result,
      ]);
      assert.deepEqual(restored.projector.checkpoint().state, {
        openChunk: null, pendingPromptMirror: null, seenCompactions: [],
        tools: [["restored-tool", { name: "write", status: "completed", callEmitted: true, resultEmitted: true }]],
      });
      assert.deepEqual(restored.projector.pushLine(update), []);
    }
  }
});
