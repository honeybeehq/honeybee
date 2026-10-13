import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createTranscriptProjector,
  museTranscriptRenderer,
  renderTranscriptLines,
  restoreTranscriptProjector,
  TRANSCRIPT_RENDERERS,
} from "../src/transcripts.ts";
import { MUSE_STATE_LIMIT } from "../src/muse-projection.ts";
import type { TranscriptProjectedEvent, TranscriptProjector } from "../src/transcript-projection.ts";

const SESSION = "01a133f0-0000-7000-8000-000000000001";
const TURN = "01a133f0-0000-7000-8000-0000000000a1";

/** Recorded from `muse serve --provider echo` 1.4.7: three turns, the third interrupted. */
function echoLines(): string[] {
  return readFileSync(new URL("./fixtures/muse-echo-serve.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
}

/** Built from the exported MSP schema; tool, usage and compaction shapes need a real meta-provider recheck. */
function schemaLines(): string[] {
  return readFileSync(new URL("./fixtures/muse-schema-tools.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
}

function metaLines(): string[] {
  return readFileSync(new URL("./fixtures/muse-meta-v1a.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
}

function projectAll(lines: readonly string[], projector: TranscriptProjector = createTranscriptProjector("muse")): TranscriptProjectedEvent[] {
  return [...lines.flatMap((line) => projector.pushLine(line)), ...projector.flush()];
}

function note(method: string, params: Record<string, unknown>, emittedAtMs = 1791872000000): string {
  return JSON.stringify({ emittedAtMs, jsonrpc: "2.0", method, params: { sessionId: SESSION, ...params } });
}

function toolItem(method: "item/started" | "item/completed", extra: Record<string, unknown> = {}): string {
  return note(method, {
    item: {
      itemId: "t1", kind: "toolCall", tool: "read_file", callId: "call_1", args: "{\"path\":\"a.ts\"}",
      revision: method === "item/started" ? 1 : 2, status: method === "item/started" ? "inProgress" : "completed",
      turnId: TURN, ...extra,
    },
  });
}

test("real echo session projects turns, messages, usage and cancellation, and skips reminder children", () => {
  const events = projectAll(echoLines());
  assert.deepEqual(events.map((event) => event.kind), [
    "turn_start", "message", "message", "token_usage", "turn_end",
    "turn_start", "message", "message", "token_usage", "turn_end",
    "interrupt", "turn_start", "message", "message", "token_usage", "turn_end",
  ]);
  const messages = events.flatMap((event) => event.kind === "message" ? [[event.role, event.text]] : []);
  assert.deepEqual(messages, [
    ["user", "hello muse"], ["assistant", "echo: hello muse"],
    ["user", "second turn"], ["assistant", "echo: second turn"],
    ["user", "interrupt me"], ["assistant", "echo: interrupt me"],
  ]);
  const ends = events.filter((event) => event.kind === "turn_end");
  assert.deepEqual(ends.map((event) => [event.finishReason, event.interrupted ?? false]), [
    ["completed", false], ["completed", false], ["cancelled", true],
  ]);
  assert.deepEqual(ends[0], {
    kind: "turn_end",
    ts: "2026-10-13T06:10:25.995Z",
    threadId: "01a133e2-3612-71c1-823b-6a3d8af3d3fd",
    turnId: "01a133e2-36f5-7c2f-85c7-0161a9959d72",
    durationMs: 321,
    finishReason: "completed",
  });
  assert.ok(events.every((event) => event.threadId === "01a133e2-3612-71c1-823b-6a3d8af3d3fd"));
});

test("real meta session projects the bash result envelope as a shell event and counts cached usage per turn", () => {
  const events = projectAll(metaLines());
  const thread = "01a13665-33ef-7e22-80df-f8357cacf4ad";
  assert.ok(events.every((event) => event.threadId === thread));
  assert.deepEqual(events.map((event) => event.kind), [
    "turn_start", "message", "thinking", "shell", "shell", "message", "token_usage", "turn_end",
    "turn_start", "message", "message", "token_usage", "turn_end",
  ]);
  const shells = events.filter((event) => event.kind === "shell");
  assert.deepEqual(shells, [
    { kind: "shell", ts: "2026-10-13T17:53:29.131Z", threadId: thread, callId: "call_01a13665e035705f8c9bc206c642a5f2", status: "started", command: "ls -la" },
    {
      kind: "shell", ts: "2026-10-13T17:53:29.221Z", threadId: thread, callId: "call_01a13665e035705f8c9bc206c642a5f2", status: "completed",
      command: "ls -la",
      stdout: "total 8\ndrwxr-xr-x@    3 trmd  wheel      96 Oct 13 19:52 .\ndrwxrwxrwt  8633 root  wheel  276256 Oct 13 19:52 ..\n-rw-r--r--@    1 trmd  wheel      15 Oct 13 19:52 README.txt\n",
      exitCode: 0,
    },
  ]);
  assert.deepEqual(events.find((event) => event.kind === "thinking"), {
    kind: "thinking", ts: "2026-10-13T17:53:28.622Z", threadId: thread, redacted: false,
    text: "Evaluating tool use to list files in the current directory while following the one-sentence format constraint.\n\nAssessing a low-risk file-listing request against prompt-injection and tool-use policy.",
  });
  const usage = events.filter((event) => event.kind === "token_usage");
  assert.deepEqual(usage.map((event) => event.kind === "token_usage" && [event.providerTurnId, event.model, event.usage]), [
    ["00000000-0000-7000-8000-000000009580", "muse-spark-1.3", { input: 35750, output: 942, cacheRead: 36209, cacheWrite: 0, reasoning: 793, total: 72901 }],
    ["00000000-0000-7000-8000-00000000958d", "muse-spark-1.3", { input: 470, output: 56, cacheRead: 36209, cacheWrite: 0, reasoning: 43, total: 36735 }],
  ]);
  assert.deepEqual(events.filter((event) => event.kind === "turn_end").map((event) => event.kind === "turn_end" && [event.ts, event.durationMs, event.finishReason]), [
    ["2026-10-13T17:54:08.368Z", 81230, "completed"],
    ["2026-10-13T17:54:52.735Z", 13867, "completed"],
  ]);
  assert.deepEqual(events.filter((event) => event.kind === "message").map((event) => event.kind === "message" && event.role), ["user", "assistant", "user", "assistant"]);
});

test("context usage, foreground completion, partial tool output, status and plan usage notifications from the real session project nothing", () => {
  const p = createTranscriptProjector("muse");
  const skipped = metaLines().filter((line) => [
    "session/contextUsage", "turn/foregroundCompleted", "item/updated", "item/delta",
    "session/statusChanged", "session/approvalModeChanged", "session/started", "usage/changed",
  ].includes(JSON.parse(line).method));
  assert.equal(skipped.length, 14);
  assert.deepEqual(skipped.flatMap((line) => p.pushLine(line)), []);
});

test("bash results without the JSON envelope keep the raw text as stdout", () => {
  const p = createTranscriptProjector("muse");
  const bash = (visibleOutput: string) => note("item/completed", {
    item: { itemId: "b1", kind: "toolCall", tool: "bash", callId: "call_b", args: "{\"command\":\"false\"}", status: "completed", visibleOutput, revision: 2 },
  });
  const completed = (line: string) => p.pushLine(line).filter((event) => event.kind === "shell" && event.status === "completed");
  assert.deepEqual(completed(bash("plain text")).map((event) => event.kind === "shell" && [event.stdout, event.exitCode]), [["plain text", undefined]]);
  assert.deepEqual(completed(bash("{\"note\":1}")).map((event) => event.kind === "shell" && [event.stdout, event.exitCode]), [["{\"note\":1}", undefined]]);
  assert.deepEqual(completed(bash(JSON.stringify({ command: "false", exit_code: 1, terminal_status: "completed", output: "" })))
    .map((event) => event.kind === "shell" && [event.stdout, event.exitCode]), [["", 1]]);
});

test("schema-derived tool session maps shell, tools, edits, subagents, reasoning, compaction and usage", () => {
  const events = projectAll(schemaLines());
  const base = { threadId: SESSION };
  const pick = (kind: TranscriptProjectedEvent["kind"]) => events.filter((event) => event.kind === kind)
    .map(({ ts: _ts, ...rest }) => rest);
  assert.deepEqual(pick("shell"), [
    { kind: "shell", ...base, callId: "call_bash", status: "started", command: "npm test" },
    { kind: "shell", ...base, callId: "call_bash", status: "completed", command: "npm test", stdout: "1 failing" },
  ]);
  assert.deepEqual(pick("tool_call"), [
    { kind: "tool_call", ...base, callId: "call_edit", name: "edit_file", input: { path: "src/a.ts", old_string: "x", new_string: "y" } },
    {
      kind: "tool_call", ...base, callId: "call_patch", name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-a\n+b\n*** Add File: src/c.ts\n+c\n*** End Patch",
    },
    { kind: "tool_call", ...base, callId: "call_read", name: "read_file", input: { path: "missing.ts" } },
    {
      kind: "tool_call", ...base, callId: "s1", name: "subagent",
      input: { role: "explorer", objective: "find callers", subagentId: "sa1", childSessionId: "child-1" },
    },
  ]);
  assert.deepEqual(pick("tool_result"), [
    { kind: "tool_result", ...base, callId: "call_edit", name: "edit_file", isError: false, output: "edited src/a.ts" },
    { kind: "tool_result", ...base, callId: "call_patch", name: "apply_patch", isError: false },
    { kind: "tool_result", ...base, callId: "call_read", name: "read_file", isError: true, output: "no such file" },
    { kind: "tool_result", ...base, callId: "s1", name: "subagent", isError: false, output: "2 callers" },
  ]);
  assert.deepEqual(pick("file_edit"), [
    { kind: "file_edit", ...base, callId: "call_edit", files: [{ path: "src/a.ts", addedLines: 1, removedLines: 1 }] },
    { kind: "file_edit", ...base, callId: "call_patch", files: [{ path: "src/b.ts" }, { path: "src/c.ts" }] },
  ]);
  assert.deepEqual(pick("thinking"), [
    { kind: "thinking", ...base, redacted: false, text: "Look at the failing test.\n\nThen patch it." },
  ]);
  assert.deepEqual(pick("compaction"), [
    { kind: "compaction", ...base, trigger: "auto", tokensBefore: 900000, tokensAfter: 40000 },
  ]);
  assert.deepEqual(pick("web_search"), [
    { kind: "web_search", ...base, itemId: "w1", providerEventId: "w1", query: "muse msp schema" },
  ]);
  assert.deepEqual(pick("unknown"), [{ kind: "unknown", ...base, nativeType: "hookRun", detail: "pre-tool hook ran" }]);
  assert.deepEqual(pick("token_usage"), [{
    kind: "token_usage", ...base, scope: "turn", providerTurnId: TURN, model: "muse-spark-1.3",
    usage: { input: 400, output: 150, cacheRead: 2300, reasoning: 40, total: 2850 },
  }]);
  assert.deepEqual(pick("message").slice(-1), [
    { kind: "message", ...base, role: "system", text: "Muse error (authRequired): missing meta credentials" },
  ]);
  assert.deepEqual(pick("turn_end").map((event) => event.kind === "turn_end" && [event.finishReason, event.interrupted]), [
    ["completed", undefined], ["failed", true],
  ]);
});

test("client requests, responses and deltas are not transcript events; interrupts are", () => {
  const p = createTranscriptProjector("muse");
  assert.deepEqual(p.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { sessionId: SESSION, input: [{ type: "text", text: "hi" }] } })), []);
  assert.deepEqual(p.pushLine(JSON.stringify({
    id: 9, jsonrpc: "2.0",
    result: { session: { sessionId: SESSION }, items: [{ itemId: "old", kind: "agentMessage", status: "completed", text: "replayed", revision: 2 }] },
  })), []);
  assert.deepEqual(p.pushLine(note("item/delta", { itemId: "a1", field: "text", delta: "partial" })), []);
  assert.deepEqual(p.pushLine(note("item/updated", { item: { itemId: "u1", kind: "userMessage", status: "completed", retracted: true, revision: 2 } })), []);
  assert.deepEqual(p.pushLine("not json"), []);
  for (const method of ["turn/interrupt", "turn/cancel"]) {
    assert.deepEqual(p.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 10, method, params: { sessionId: SESSION, commandId: "c" } })), [
      { kind: "interrupt", ts: null, threadId: SESSION },
    ]);
  }
});

test("repeated item/started does not duplicate a tool call and a lone item/completed pairs itself", () => {
  const p = createTranscriptProjector("muse");
  assert.equal(p.pushLine(toolItem("item/started")).length, 1);
  assert.deepEqual(p.pushLine(toolItem("item/started")), []);
  assert.deepEqual(p.pushLine(toolItem("item/completed")).map((event) => event.kind), ["tool_result"]);
  assert.deepEqual(p.pushLine(toolItem("item/completed", { itemId: "t2", callId: "call_2" })).map((event) => event.kind), ["tool_call", "tool_result"]);
});

test("checkpoint restore keeps open tool items and per-turn usage", () => {
  const p = createTranscriptProjector("muse");
  p.pushLine(toolItem("item/started"));
  p.pushLine(note("session/tokenUsage", {
    turnId: TURN, modelId: "muse-spark-1.3", promptTokens: 10, totalTokens: 15,
    usage: { inputTokens: 10, cachedTokens: 4, outputTokens: 5, reasoningTokens: 1 },
  }));
  const restored = restoreTranscriptProjector("muse", JSON.parse(JSON.stringify(p.checkpoint())));
  assert.equal(restored.ok, true);
  if (!restored.ok) assert.fail();
  const q = restored.projector;
  assert.deepEqual(q.pushLine(toolItem("item/completed")).map((event) => event.kind), ["tool_result"]);
  q.pushLine(note("session/tokenUsage", {
    turnId: TURN, modelId: null, promptTokens: 20, totalTokens: 22,
    usage: { inputTokens: 20, cachedTokens: 0, cacheReadTokens: 6, cacheWriteTokens: 2, outputTokens: 2, reasoningTokens: 0 },
  }));
  const end = q.pushLine(note("turn/completed", { turnId: TURN, terminal: "completed" }));
  assert.deepEqual(end.find((event) => event.kind === "token_usage"), {
    kind: "token_usage", ts: "2026-10-13T06:13:20.000Z", threadId: SESSION, scope: "turn", providerTurnId: TURN,
    model: "muse-spark-1.3", usage: { input: 18, output: 7, cacheRead: 10, cacheWrite: 2, reasoning: 1, total: 37 },
  });
  assert.deepEqual(q.checkpoint().state, { openItems: [], turnUsage: [] });
});

test("open item and usage retention is bounded", () => {
  const p = createTranscriptProjector("muse");
  for (let i = 0; i <= MUSE_STATE_LIMIT; i += 1) {
    p.pushLine(toolItem("item/started", { itemId: `t${i}`, callId: `c${i}` }));
    p.pushLine(note("session/tokenUsage", { turnId: `turn${i}`, promptTokens: 1, totalTokens: 1, usage: {} }));
  }
  const state = p.checkpoint().state as { openItems: string[]; turnUsage: unknown[] };
  assert.equal(state.openItems.length, MUSE_STATE_LIMIT);
  assert.equal(state.openItems[0], "t1");
  assert.equal(state.turnUsage.length, MUSE_STATE_LIMIT);
  assert.equal(restoreTranscriptProjector("muse", p.checkpoint()).ok, true);
});

test("compaction that did not compact is visible but not a compaction", () => {
  const p = createTranscriptProjector("muse");
  assert.deepEqual(p.pushLine(note("item/completed", {
    item: { itemId: "c1", kind: "compaction", status: "completed", outcome: "noop", reason: "no_compactable_history", revision: 2 },
  })), [{
    kind: "unknown", ts: "2026-10-13T06:13:20.000Z", threadId: SESSION, nativeType: "compaction:noop", detail: "no_compactable_history",
  }]);
});

test("muse renderer and turn stream read the real echo session", () => {
  assert.equal(TRANSCRIPT_RENDERERS.muse, museTranscriptRenderer);
  const lines = echoLines();
  const rendered = lines.flatMap((line) => museTranscriptRenderer.renderLine(line));
  const streamed = renderTranscriptLines("muse", lines);
  const expected = [
    { role: "user", text: "hello muse" }, { role: "assistant", text: "echo: hello muse" },
    { role: "user", text: "second turn" }, { role: "assistant", text: "echo: second turn" },
    { role: "user", text: "interrupt me" }, { role: "assistant", text: "echo: interrupt me" },
  ];
  assert.deepEqual(rendered, expected);
  assert.deepEqual(streamed.filter((turn) => turn.role !== "system"), expected);
  assert.deepEqual(museTranscriptRenderer.renderLine(toolItem("item/started")), [{ role: "tool", text: "[tool_use: read_file]" }]);
});
