import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriptProjector, restoreTranscriptProjector } from "../src/transcripts.ts";

test("Kimi ACP prompt, streamed answer and result survive checkpoint restore", () => {
  let p = createTranscriptProjector("kimi");
  const prompt = p.pushLine(JSON.stringify({ id: 1001, method: "session/prompt", params: { sessionId: "native", prompt: [{ type: "text", text: "hello" }] } }));
  assert.ok(prompt.some(e => e.kind === "message" && e.role === "user" && e.text === "hello"));
  p.pushLine(JSON.stringify({ method: "session/update", params: { sessionId: "native", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "KIMI_OK" } } } }));
  const restored = restoreTranscriptProjector("kimi", p.checkpoint());
  assert.equal(restored.ok, true);
  if (!restored.ok) assert.fail();
  p = restored.projector;
  const events = p.pushLine(JSON.stringify({ id: 1001, result: { stopReason: "end_turn" } }));
  assert.ok(events.some(e => e.kind === "message" && e.role === "assistant" && e.text === "KIMI_OK"));
  assert.ok(events.some(e => e.kind === "turn_end"));
  assert.deepEqual(p.flush(), []);
});
