/**
 * agy ACP projection. Rows follow ACP v1 as `agy acp` 1.5.2 speaks it; the
 * `Run mcp_<server>_<tool>` title is agy's own.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointVerifiedProjector } from "./checkpoint-helpers.ts";
import { lastAssistantText } from "../src/transcript.ts";
import { createTranscriptProjector, renderTranscriptLines, restoreTranscriptProjector } from "../src/transcripts.ts";

const SESSION = "agy-session-1";
const j = (value: unknown): string => JSON.stringify(value);
const update = (payload: Record<string, unknown>): string =>
  j({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: payload } });
const prompt = (id: number, text: string): string =>
  j({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: SESSION, prompt: [{ type: "text", text }] } });
const chunk = (text: string): string => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const thought = (text: string): string => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });

const TOOL_TURN = [
  j({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientInfo: { name: "Honeybee", version: "2" } } }),
  j({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentInfo: { name: "Antigravity ACP Server", version: "1.5.2" } } }),
  j({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work", mcpServers: [] } }),
  j({ jsonrpc: "2.0", id: 2, result: { sessionId: SESSION, models: { currentModelId: "gemini-3.8-flash-low" } } }),
  prompt(1001, "send the report"),
  thought("The user wants the report"),
  thought(" sent to the parent."),
  update({ sessionUpdate: "tool_call", toolCallId: "call-1", title: "Run mcp_apiary_agent_send", kind: "other", status: "pending", rawInput: { sessionId: "parent", message: "done" } }),
  j({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: "call-1" }, options: [] } }),
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" }),
  update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "delivered" } }] }),
  chunk("The report "),
  chunk("is sent."),
  j({ jsonrpc: "2.0", id: 1001, result: { stopReason: "end_turn", usage: { inputTokens: 1200, cachedReadTokens: 200, outputTokens: 40, thoughtTokens: 12, totalTokens: 1252 } } }),
];

function project(lines: readonly string[]) {
  const projector = checkpointVerifiedProjector("agy");
  const events = lines.flatMap((line) => projector.pushLine(line));
  return [...events, ...projector.flush()];
}

test("agy projector: prompt, thoughts, an MCP tool call named by its tool, the answer, usage and the turn end", () => {
  assert.deepEqual(project(TOOL_TURN), [
    { kind: "turn_start", ts: null },
    { kind: "message", ts: null, role: "user", text: "send the report" },
    { kind: "thinking", ts: null, redacted: false, text: "The user wants the report sent to the parent." },
    { kind: "tool_call", ts: null, callId: "call-1", name: "mcp_apiary_agent_send", input: { sessionId: "parent", message: "done" } },
    { kind: "tool_result", ts: null, callId: "call-1", name: "mcp_apiary_agent_send", isError: false, output: "delivered" },
    { kind: "message", ts: null, role: "assistant", text: "The report is sent." },
    { kind: "token_usage", ts: null, usage: { input: 1000, output: 40, cacheRead: 200, reasoning: 12, total: 1252 }, scope: "turn" },
    { kind: "turn_end", ts: null, finishReason: "end_turn" },
  ]);
  const turns = renderTranscriptLines("agy", TOOL_TURN);
  assert.deepEqual(turns.map((turn) => turn.role), ["user", "tool", "tool", "assistant"]);
  assert.equal(turns[1]!.text, "[tool_use: mcp_apiary_agent_send]");
  assert.equal(lastAssistantText(turns), "The report is sent.");
});

test("agy projector: other tool titles stay as agy wrote them, and a failed tool is an error result", () => {
  const events = project([
    prompt(1002, "list files"),
    update({ sessionUpdate: "tool_call", toolCallId: "call-2", title: "Run ls -la", kind: "execute", status: "pending", rawInput: { command: "ls -la" } }),
    update({ sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "failed", rawOutput: "permission denied" }),
    update({ sessionUpdate: "tool_call", toolCallId: "call-3", title: "Run mcp_apiary_agent_send now", kind: "other", status: "pending" }),
  ]);
  assert.deepEqual(events.slice(2), [
    { kind: "tool_call", ts: null, callId: "call-2", name: "Run ls -la", input: { command: "ls -la" } },
    { kind: "tool_result", ts: null, callId: "call-2", name: "Run ls -la", isError: true, output: "permission denied" },
    { kind: "tool_call", ts: null, callId: "call-3", name: "Run mcp_apiary_agent_send now" },
  ]);
});

test("agy projector: a cancelled prompt and a failed prompt both close the turn as interrupted", () => {
  const cancelled = project([prompt(1003, "count to 200"), chunk("1\n2\n"), j({ jsonrpc: "2.0", id: 1003, result: { stopReason: "cancelled" } })]);
  assert.deepEqual(cancelled.slice(2), [
    { kind: "message", ts: null, role: "assistant", text: "1\n2\n" },
    { kind: "turn_end", ts: null, finishReason: "cancelled", interrupted: true },
  ]);
  const failed = project([prompt(1004, "hello"), j({ jsonrpc: "2.0", id: 1004, error: { code: -32603, message: "Internal error", data: { details: "Quota exceeded" } } })]);
  assert.deepEqual(failed.slice(2), [
    { kind: "interrupt", ts: null, reason: 'Internal error: {"details":"Quota exceeded"}' },
    { kind: "turn_end", ts: null, finishReason: "error", interrupted: true },
  ]);
  // Handshake and configuration responses are not turns.
  assert.deepEqual(project([j({ id: 2, result: { sessionId: SESSION } }), j({ id: "agy:model:s", result: {} }), j({ id: 3, error: { message: "x" } })]), []);
});

test("agy projector: an open answer survives a checkpoint restore, and print-mode checkpoints do not restore", () => {
  let projector = createTranscriptProjector("agy");
  projector.pushLine(prompt(1005, "hello"));
  projector.pushLine(chunk("AGY_"));
  const checkpoint = projector.checkpoint();
  assert.equal(checkpoint.harness, "agy");
  const restored = restoreTranscriptProjector("agy", JSON.parse(JSON.stringify(checkpoint)));
  if (!restored.ok) assert.fail(restored.reason);
  projector = restored.projector;
  projector.pushLine(chunk("OK"));
  const events = projector.pushLine(j({ id: 1005, result: { stopReason: "end_turn" } }));
  assert.deepEqual(events, [
    { kind: "message", ts: null, role: "assistant", text: "AGY_OK" },
    { kind: "turn_end", ts: null, finishReason: "end_turn" },
  ]);
  assert.deepEqual(projector.flush(), []);
  // The state the print-mode projector checkpointed.
  const printMode = { ...checkpoint, state: {
    threadId: null, sawAssistantText: false, previousResultUsage: null, previousNumTurns: null, previousDurationSeconds: null,
    assistantFragments: [], emittedAssistantMessages: [], emittedToolCalls: [], emittedToolResults: [],
  } };
  assert.deepEqual(restoreTranscriptProjector("agy", printMode), { ok: false, reason: "invalid_checkpoint" });
});
