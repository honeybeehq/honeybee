import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { agyAcpAdapter, agyPermissionAnswer, agySpawnPlan, isAgyCheckpointState } from "../src/agy.ts";
import type { AdapterSignal } from "../src/types.ts";
import type { TranscriptProjectedEvent } from "../src/transcript.ts";
import { createTranscriptProjector, restoreTranscriptProjector } from "../src/transcripts.ts";
import { checkpointVerifiedProjector } from "./checkpoint-helpers.ts";

const j = (value: unknown): string => JSON.stringify(value);
const LIVE = readFileSync(new URL("./fixtures/agy-acp-live.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);

function request(signals: AdapterSignal[]): Record<string, unknown> {
  const respond = signals.find((signal) => signal.kind === "respond");
  if (respond?.kind !== "respond") assert.fail(`expected a request, got ${j(signals)}`);
  return JSON.parse(respond.lines[0]!) as Record<string, unknown>;
}

test("agy spawn plan: acp anywhere selects ACP, lifts model/effort/mode/permissions and drops print plumbing", () => {
  assert.deepEqual(agySpawnPlan(["--print=", "--input-format", "stream-json", "--model", "gemini-4-neon"]), { acp: false });
  assert.deepEqual(agySpawnPlan([
    "--print=", "--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--print-timeout", "12h",
    "--dangerously-skip-permissions", "acp", "--model=gemini-4-neon-high", "--effort", "xhigh", "--mode", "auto", "--conversation", "old", "--agent", "acp", "--sandbox",
  ]), { acp: true, argv: ["acp", "--agent", "acp", "--sandbox"], model: "gemini-4-neon-high", effort: "xhigh", mode: "auto", allowPermissions: true });
  assert.deepEqual(agySpawnPlan(["acp"]), { acp: true, argv: ["acp"], allowPermissions: false });
  assert.deepEqual(agySpawnPlan(["--print=", "--dangerously-skip-permissions", "acp"], ["acp"]), { acp: true, argv: ["acp"], allowPermissions: false }, "permission comes from the bee's own args");
  assert.throws(() => agySpawnPlan(["acp", "--model"]), /--model requires a value/);
});

test("agy ACP handshake: initialize, session/new, model, thought_level, mode, then idle", () => {
  const adapter = agyAcpAdapter({ cwd: "/work", model: "gemini-4-argon", effort: "low", mode: "accept-edits", allowPermissions: false });
  const init = JSON.parse(adapter.bootLines()[0]!) as Record<string, unknown>;
  assert.equal(init.method, "initialize");
  assert.deepEqual((init.params as Record<string, unknown>).clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  const setup = request(adapter.parseLine(j({ jsonrpc: "2.0", id: 1, result: { authMethods: [{ id: "oauth-personal" }] } })));
  assert.deepEqual([setup.method, setup.params], ["session/new", { cwd: "/work", mcpServers: [] }]);
  let signals = adapter.parseLine(j({ jsonrpc: "2.0", id: setup.id, result: { sessionId: "s-1", configOptions: [] } }));
  for (const [configId, value] of [["model", "gemini-4-argon"], ["thought_level", "low"], ["mode", "accept-edits"]]) {
    assert.equal(signals.some((signal) => signal.kind === "booted"), false);
    const config = request(signals);
    assert.deepEqual([config.method, config.params], ["session/set_config_option", { sessionId: "s-1", configId, value }]);
    signals = adapter.parseLine(j({ jsonrpc: "2.0", id: config.id, result: { configOptions: [] } }));
  }
  assert.deepEqual(signals, [
    { kind: "booted", sessionId: "s-1" },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("agy ACP refusals: an unknown model, a missing login and an unresumable agent never boot", () => {
  const adapter = agyAcpAdapter({ cwd: "/work", model: "gemini-bogus", allowPermissions: true });
  const setup = request(adapter.parseLine(j({ jsonrpc: "2.0", id: 1, result: {} })));
  const config = request(adapter.parseLine(j({ jsonrpc: "2.0", id: setup.id, result: { sessionId: "s-2" } })));
  const rejected = adapter.parseLine(j({ jsonrpc: "2.0", id: config.id, error: { code: -32602, message: "Unknown model ID: gemini-bogus" } }));
  assert.deepEqual(rejected, [{ kind: "flag", flag: "spawn_failed", action: "set", detail: "agy rejected model gemini-bogus: Unknown model ID: gemini-bogus" }]);

  const signedOut = adapter.parseLine(j({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "Authentication required" } }));
  assert.deepEqual(signedOut, [{ kind: "flag", flag: "auth_needed", action: "set", detail: "Authentication required" }]);

  const resume = agyAcpAdapter({ cwd: "/work", allowPermissions: true, resumeSessionId: "old" });
  assert.equal(request(resume.parseLine(j({ jsonrpc: "2.0", id: 1, result: { agentCapabilities: { sessionCapabilities: { resume: {} } } } }))).method, "session/resume");
  assert.deepEqual(resume.parseLine(j({ jsonrpc: "2.0", id: 1, result: { agentCapabilities: {} } })), [
    { kind: "flag", flag: "spawn_failed", action: "set", detail: "Installed agy ACP does not advertise session/resume" },
  ]);
  assert.deepEqual(resume.parseLine(j({ jsonrpc: "2.0", id: 3, result: {} })).slice(0, 1), [{ kind: "booted", sessionId: "old" }]);
});

test("agy ACP authenticates with the named method and flags auth_needed when agy refuses it", () => {
  const adapter = agyAcpAdapter({ cwd: "/work", allowPermissions: true, authMethodId: "agent-platform" });
  const auth = request(adapter.parseLine(j({ jsonrpc: "2.0", id: 1, result: {} })));
  assert.deepEqual([auth.id, auth.method, auth.params], [2, "authenticate", { methodId: "agent-platform" }]);
  assert.equal(request(adapter.parseLine(j({ jsonrpc: "2.0", id: 2, result: {} }))).method, "session/new");
  assert.deepEqual(adapter.parseLine(j({ jsonrpc: "2.0", id: 2, error: { code: -32800, message: "ADC not found" } })), [
    { kind: "flag", flag: "auth_needed", action: "set", detail: "ADC not found" },
  ]);
});

test("agy ACP permissions follow the spawn's permission flag; other client requests are refused", () => {
  const params = { options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] };
  assert.deepEqual(agyPermissionAnswer(params, true), { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(agyPermissionAnswer(params, false), { outcome: { outcome: "selected", optionId: "deny" } });
  assert.deepEqual(agyPermissionAnswer({ options: [] }, true), { outcome: { outcome: "cancelled" } });
  const restricted = agyAcpAdapter({ cwd: "/work", allowPermissions: false });
  const answer = request(restricted.parseLine(j({ jsonrpc: "2.0", id: "7", method: "session/request_permission", params })));
  assert.deepEqual(answer, { jsonrpc: "2.0", id: "7", result: { outcome: { outcome: "selected", optionId: "deny" } } });
  const refused = request(restricted.parseLine(j({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: {} })));
  assert.equal((refused.error as Record<string, unknown>).code, -32601);
});

test("agy ACP turns: prompts and cancels are encoded for the session; results end the turn", () => {
  const adapter = agyAcpAdapter({ cwd: "/work", allowPermissions: true });
  assert.equal(adapter.encodeMessage("hi", { sessionId: null, messageId: 1, turnActive: false, turnId: null }), null);
  assert.deepEqual(JSON.parse(adapter.encodeMessage("hi", { sessionId: "s", messageId: 5, turnActive: false, turnId: null })!), {
    jsonrpc: "2.0", id: 1005, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] },
  });
  assert.deepEqual(JSON.parse(adapter.encodeInterrupt!({ sessionId: "s", turnId: null })!), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
  assert.deepEqual(adapter.parseLine(j({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "c" } } })), [{ kind: "turn_started" }]);
  assert.deepEqual(adapter.parseLine(j({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 1, size: 2 } } })), []);
  assert.deepEqual(adapter.parseLine(j({ jsonrpc: "2.0", id: 1005, result: { stopReason: "end_turn" } })).at(-1), { kind: "turn_ended" });
  assert.deepEqual(adapter.parseLine(j({ jsonrpc: "2.0", id: 1005, result: { stopReason: "cancelled" } })), [{ kind: "turn_ended" }]);
  assert.deepEqual(adapter.parseLine(j({ jsonrpc: "2.0", id: 1006, error: { code: -32000, message: "Authentication required" } })), [
    { kind: "flag", flag: "auth_needed", action: "set", detail: "Authentication required" },
    { kind: "turn_ended" },
  ]);
});

test("agy ACP projection of a real agy 1.5.18 turn: prompt, tool call, permission, reply, usage with model and context window", () => {
  const projector = checkpointVerifiedProjector("agy");
  const events: TranscriptProjectedEvent[] = [...LIVE.flatMap((line) => projector.pushLine(line)), ...projector.flush()];
  const tool = events.find((event) => event.kind === "tool_call");
  const result = events.find((event) => event.kind === "tool_result");
  const usage = events.find((event) => event.kind === "token_usage");
  assert.deepEqual(events.map((event) => event.kind), ["turn_start", "message", "tool_call", "message", "message", "tool_result", "message", "token_usage", "turn_end"]);
  assert.equal(events[1]?.kind === "message" && events[1].text, "Run the shell command `echo probe-ok > probe.txt` in the current directory, then reply with exactly: done");
  assert.deepEqual(tool?.kind === "tool_call" ? [tool.callId, tool.name, tool.input] : null, ["call_8890467796875710331", "echo probe-ok > probe.txt", {
    CommandLine: "echo probe-ok > probe.txt", WaitMsBeforeAsync: 5000, toolSummary: "Run probe echo command",
  }]);
  assert.deepEqual(events.filter((event) => event.kind === "message").map((event) => event.kind === "message" ? `${event.role}:${event.text}` : ""), [
    "user:Run the shell command `echo probe-ok > probe.txt` in the current directory, then reply with exactly: done",
    "system:Permission requested: echo probe-ok > probe.txt [allow (allow_once), deny (reject_once)]",
    "system:Permission allowed: echo probe-ok > probe.txt",
    "assistant:done",
  ]);
  assert.equal(result?.kind === "tool_result" && result.isError, false);
  assert.deepEqual(usage, {
    kind: "token_usage", ts: null, scope: "turn", model: "gemini-3.8-flash-low", modelContextWindow: 1048576,
    usage: { input: 17551, output: 44, cacheRead: 13319, cacheWrite: 0, reasoning: 0, total: 30914 },
  });
  assert.deepEqual(events.at(-1), { kind: "turn_end", ts: null, finishReason: "end_turn" });
});

test("agy ACP projection: denied and cancelled permissions, cancelled turns and prompt errors", () => {
  const projector = checkpointVerifiedProjector("agy");
  const push = (value: unknown) => projector.pushLine(j(value));
  push({ jsonrpc: "2.0", id: 1001, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "go" }] } });
  push({ jsonrpc: "2.0", id: "1", method: "session/request_permission", params: { sessionId: "s", toolCall: { toolCallId: "c", title: "rm -rf build" }, options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } });
  assert.deepEqual(push({ jsonrpc: "2.0", id: "1", result: { outcome: { outcome: "selected", optionId: "deny" } } }), [{ kind: "message", ts: null, role: "system", text: "Permission denied: rm -rf build" }]);
  push({ jsonrpc: "2.0", id: "2", method: "session/request_permission", params: { sessionId: "s", toolCall: { name: "write_file" }, options: [] } });
  assert.deepEqual(push({ jsonrpc: "2.0", id: "2", result: { outcome: { outcome: "cancelled" } } }), [{ kind: "message", ts: null, role: "system", text: "Permission cancelled: write_file" }]);
  assert.deepEqual(push({ jsonrpc: "2.0", id: 1001, result: { stopReason: "cancelled" } }), [
    { kind: "interrupt", ts: null, reason: "cancelled" },
    { kind: "turn_end", ts: null, finishReason: "cancelled", interrupted: true },
  ]);
  push({ jsonrpc: "2.0", id: 1002, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "again" }] } });
  assert.deepEqual(push({ jsonrpc: "2.0", id: 1002, error: { code: -32000, message: "Authentication required" } }), [
    { kind: "message", ts: null, role: "system", text: "agy error: Authentication required" },
    { kind: "turn_end", ts: null, finishReason: "error", interrupted: true },
  ]);
});

test("agy ACP projection: the reported model follows config updates, including models without a thinking level", () => {
  const projector = checkpointVerifiedProjector("agy");
  const push = (value: unknown) => projector.pushLine(j(value));
  const options = (model: string, level?: string) => [{ id: "model", currentValue: model }, ...(level ? [{ id: "thought_level", currentValue: level }] : []), { id: "mode", currentValue: "default" }];
  push({ jsonrpc: "2.0", id: 3, result: { sessionId: "s", models: { currentModelId: "gemini-4-neon-high" }, configOptions: options("gemini-4-neon", "high") } });
  push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", configOptions: options("gpt-oss-120b-medium") } } });
  push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 10, size: 131072 } } });
  push({ jsonrpc: "2.0", id: 1001, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "go" }] } });
  const ended = push({ jsonrpc: "2.0", id: 1001, result: { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } });
  assert.deepEqual(ended.find((event) => event.kind === "token_usage"), { kind: "token_usage", ts: null, scope: "turn", model: "gpt-oss-120b-medium", modelContextWindow: 131072, usage: { input: 5, output: 1, total: 6 } });
});

test("agy checkpoints: print-mode checkpoints restore unchanged and a log may switch from print mode to ACP", () => {
  const printOnly = createTranscriptProjector("agy");
  printOnly.pushLine(j({ event: "init", conversation_id: "conv" }));
  const legacy = printOnly.checkpoint();
  assert.equal(Object.hasOwn(legacy.state as object, "acp"), false, "print-only state keeps its old shape");
  assert.equal(isAgyCheckpointState(legacy.state), true);
  const restored = restoreTranscriptProjector("agy", JSON.parse(j(legacy)));
  assert.equal(restored.ok, true);
  if (!restored.ok) return;
  const events = LIVE.flatMap((line) => restored.projector.pushLine(line));
  assert.ok(events.some((event) => event.kind === "token_usage"));
  assert.equal(isAgyCheckpointState(restored.projector.checkpoint().state), true);
  assert.equal(isAgyCheckpointState({ ...(legacy.state as object), acp: { stream: {}, model: null, effort: null, contextWindow: null, permissions: [] } }), false);
});
