import { test } from "node:test";
import assert from "node:assert/strict";
import { createNativeTranscriptProjector, createTranscriptProjector, restoreTranscriptProjector } from "../src/transcripts.ts";
import { TRANSCRIPT_PROJECTION_VERSION } from "../src/transcript-projection.ts";

const claudeAttachment = JSON.stringify({ type: "attachment", uuid: "u-1", timestamp: "2026-10-30T10:00:00.000Z", attachment: { type: "queued_command", commandMode: "prompt", prompt: [{ type: "text", text: "steer: stop and report" }] } });
const claudeResult = JSON.stringify({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: null, result: "done" });
const claudeAssistant = JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "final answer" }], usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 } } });
const claudeCompact = JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-10-30T10:01:00.000Z", compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 20000 } });
const codexStart = JSON.stringify({ id: 2, method: "thread/start", params: { baseInstructions: "You are Codex." } });

test("repairs: the registry projector carries Apiary's compat repairs so both sides project the same events", () => {
  assert.equal(TRANSCRIPT_PROJECTION_VERSION, 8);
  const native = createNativeTranscriptProjector("claude");
  const repaired = createTranscriptProjector("claude");
  const nativeAttachment = native.pushLine(claudeAttachment);
  assert.ok(nativeAttachment.some((e) => e.kind === "unknown" && e.nativeType === "attachment"), "the native projector sees an unknown attachment");
  const repairedAttachment = repaired.pushLine(claudeAttachment);
  assert.deepEqual(repairedAttachment.filter((e) => e.kind === "message"), [{ kind: "message", ts: nativeAttachment[0]!.ts, role: "user", text: "steer: stop and report", providerEventId: "u-1" }]);
  const assistant = repaired.pushLine(claudeAssistant);
  assert.ok(assistant.some((e) => e.kind === "message" && e.role === "assistant" && e.answerPhase === "final"), JSON.stringify(assistant));
  assert.ok(assistant.some((e) => e.kind === "token_usage" && e.contextInputTokens === 125), JSON.stringify(assistant));
  const result = repaired.pushLine(claudeResult);
  assert.ok(result.some((e) => e.kind === "turn_end" && e.finishReason === "result"), JSON.stringify(result));
  assert.deepEqual(repaired.pushLine(claudeCompact), [{ kind: "compaction", ts: "2026-10-30T10:01:00.000Z", trigger: "auto", tokensBefore: 150000, tokensAfter: 20000 }]);
  const codex = createTranscriptProjector("codex");
  assert.deepEqual(codex.pushLine(codexStart)[0], { kind: "unknown", nativeType: "context_baseline", ts: null, contextBaseline: { kind: "start", requestId: "2" } });
  assert.ok(codex.pushLine(codexStart).some((e) => e.kind === "unknown" && e.nativeType === "context_inventory"));
  const restored = restoreTranscriptProjector("claude", createTranscriptProjector("claude").checkpoint());
  assert.ok(restored.ok);
  if (restored.ok) assert.ok(restored.projector.pushLine(claudeAttachment).some((e) => e.kind === "message" && e.role === "user"), "restored projectors carry the repairs too");
});
