/**
 * agy ACP adapter. Shapes are from agy 1.5.2 (initialize and session/new
 * captured 2026-11-06, the rest from that day's live smoke) and ACP v1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agyAdapter, agyVersionRefusal, AGY_MIN_VERSION, type AgyAdapterOptions } from "../src/agy.ts";
import { agySpawnPlan } from "../src/args.ts";
import type { AdapterSignal } from "../src/types.ts";

const j = (value: unknown): string => JSON.stringify(value);
const adapter = (opts: Partial<AgyAdapterOptions> = {}) => agyAdapter({ cwd: "/work", ...opts });

/** The single request an adapter answered a line with. */
function request(signals: AdapterSignal[]): { id: unknown; method: string; params: Record<string, unknown> } {
  assert.equal(signals.length, 1);
  const signal = signals[0]!;
  if (signal.kind !== "respond") assert.fail(`expected a respond signal, got ${signal.kind}`);
  assert.equal(signal.lines.length, 1);
  return JSON.parse(signal.lines[0]!);
}

function flags(signals: AdapterSignal[]): Array<[string, string]> {
  return signals.flatMap((signal) => signal.kind === "flag" ? [[signal.flag, signal.action] as [string, string]] : []);
}

const INITIALIZED = j({ jsonrpc: "2.0", id: 1, result: {
  protocolVersion: 1,
  agentInfo: { name: "Antigravity ACP Server", version: "1.5.2" },
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} }, promptCapabilities: { image: true, embeddedContext: true } },
  authMethods: [{ id: "oauth-personal" }, { id: "oauth-business" }, { id: "gemini-api-key" }, { id: "agent-platform" }],
} });
const AUTH_REQUIRED = { code: -32000, message: "Authentication required" };

test("agy spawn plan lifts model, effort and mode off argv and keeps the rest after acp", () => {
  assert.deepEqual(agySpawnPlan(["acp"]), { argv: ["acp"], skipPermissions: false });
  assert.deepEqual(
    agySpawnPlan(["acp", "--model", "gemini-4-argon", "--effort=high", "--mode", "plan", "--dangerously-skip-permissions", "--add-dir", "/a", "--agent", "reviewer"]),
    { argv: ["acp", "--dangerously-skip-permissions", "--add-dir", "/a", "--agent", "reviewer"], model: "gemini-4-argon", effort: "high", mode: "plan", skipPermissions: true },
  );
  assert.deepEqual(agySpawnPlan(["--model=gemini-3.8-flash-low"]), { argv: ["acp"], model: "gemini-3.8-flash-low", skipPermissions: false });
  // A wrapper's own arguments stay ahead of the subcommand.
  assert.deepEqual(agySpawnPlan(["wrapper.mjs", "acp", "--effort", "low"]).argv, ["wrapper.mjs", "acp"]);
  assert.throws(() => agySpawnPlan(["--effort", "max"]), /--effort must be one of low\|medium\|high/);
  assert.throws(() => agySpawnPlan(["--mode", "yolo"]), /--mode must be one of default\|accept-edits\|plan/);
  assert.throws(() => agySpawnPlan(["--model="]), /--model requires a value/);
});

test("agy older than the ACP floor is refused by name; unreadable versions are not", () => {
  assert.equal(AGY_MIN_VERSION, "1.5.1");
  for (const old of ["1.1.24", "agy 1.4.9", "1.5.0", "0.9.0 (build 7)"]) {
    assert.match(agyVersionRefusal(old) ?? "", /is too old for Honeybee: it runs agy over ACP \(`agy acp`\), which needs agy 1\.5\.1 or newer/);
  }
  for (const fine of ["1.5.1", "1.5.2", "agy 1.6.0", "2.0.0", "10.0.0", null, "", "unknown"]) assert.equal(agyVersionRefusal(fine), null);
});

test("agy initializes as Honeybee and opens the session with the operator's MCP servers", () => {
  const mcpServers = [{ name: "apiary", command: "/bin/shim", args: ["--gateway"], env: [{ name: "TOKEN_FILE", value: "/run/t" }] }];
  const a = adapter({ mcpServers });
  assert.equal(a.harness, "agy");
  assert.equal(a.readyAtSpawn, false);
  assert.equal(a.acceptsMidTurn, false);
  assert.equal(a.resumeArgs, undefined);
  const boot = a.bootLines().map((l) => JSON.parse(l));
  assert.deepEqual(boot, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "Honeybee", version: "2" },
  } }]);
  assert.deepEqual(request(a.parseLine(INITIALIZED)), { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/work", mcpServers } });
  // Nothing requested: the session result is readiness.
  assert.deepEqual(a.parseLine(j({ id: 2, result: { sessionId: "s-1", models: { currentModelId: "gemini-4-argon-medium" } } })), [
    { kind: "booted", sessionId: "s-1" },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("agy resumes through session/resume and refuses an agy that does not advertise it", () => {
  const a = adapter({ resumeSessionId: "s-old" });
  assert.deepEqual(request(a.parseLine(INITIALIZED)), { jsonrpc: "2.0", id: 2, method: "session/resume", params: { cwd: "/work", mcpServers: [], sessionId: "s-old" } });
  // session/resume answers without a session id; the recorded one stands.
  assert.deepEqual(a.parseLine(j({ id: 2, result: {} }))[0], { kind: "booted", sessionId: "s-old" });
  const listed = j({ id: 1, result: { agentCapabilities: { sessionCapabilities: ["load", "resume"] } } });
  assert.equal(request(a.parseLine(listed)).method, "session/resume");
  const without = a.parseLine(j({ id: 1, result: { agentCapabilities: { loadSession: true, sessionCapabilities: { load: {} } } } }));
  assert.deepEqual(flags(without), [["spawn_failed", "set"]]);
  assert.match(without[0]!.kind === "flag" ? without[0]!.detail : "", /does not advertise session\/resume/);
});

test("agy applies model, effort and mode through configuration options before it is ready", () => {
  const a = adapter({ model: "gemini-4-argon", effort: "high", mode: "plan" });
  const model = request(a.parseLine(j({ id: 2, result: { sessionId: "s-1" } })));
  assert.deepEqual(model, { jsonrpc: "2.0", id: "agy:model:s-1", method: "session/set_config_option", params: { sessionId: "s-1", configId: "model", value: "gemini-4-argon" } });
  const effort = request(a.parseLine(j({ id: model.id, result: {} })));
  assert.deepEqual(effort, { jsonrpc: "2.0", id: "agy:effort:s-1", method: "session/set_config_option", params: { sessionId: "s-1", configId: "thought_level", value: "high" } });
  const mode = request(a.parseLine(j({ id: effort.id, result: {} })));
  assert.deepEqual(mode, { jsonrpc: "2.0", id: "agy:mode:s-1", method: "session/set_config_option", params: { sessionId: "s-1", configId: "mode", value: "plan" } });
  assert.deepEqual(a.parseLine(j({ id: mode.id, result: {} }))[0], { kind: "booted", sessionId: "s-1" });

  // Only what was requested is sent, in the same order.
  assert.equal(request(adapter({ effort: "low" }).parseLine(j({ id: 2, result: { sessionId: "s-2" } }))).id, "agy:effort:s-2");
  assert.equal(request(adapter({ mode: "accept-edits" }).parseLine(j({ id: 2, result: { sessionId: "s-2" } }))).id, "agy:mode:s-2");
  assert.deepEqual(adapter({ model: "m" }).parseLine(j({ id: "agy:model:s-3", result: {} }))[0], { kind: "booted", sessionId: "s-3" });
});

test("agy retries a model the option refuses through session/set_model", () => {
  const a = adapter({ model: "gemini-4-argon-high", effort: "low" });
  const refused = j({ id: "agy:model:s-1", error: { code: -32602, message: "Invalid params", data: "unknown model value" } });
  const fallback = request(a.parseLine(refused));
  assert.deepEqual(fallback, { jsonrpc: "2.0", id: "agy:set_model:s-1", method: "session/set_model", params: { sessionId: "s-1", modelId: "gemini-4-argon-high" } });
  assert.equal(request(a.parseLine(j({ id: fallback.id, result: {} }))).id, "agy:effort:s-1");
  const failed = a.parseLine(j({ id: fallback.id, error: { code: -32602, message: "unknown model" } }));
  assert.deepEqual(failed, [{ kind: "flag", flag: "spawn_failed", action: "set", detail: "agy refused model gemini-4-argon-high: unknown model" }]);
  // Mode has the same second route; effort has one.
  assert.equal(request(adapter({ mode: "plan" }).parseLine(j({ id: "agy:mode:s-1", error: { message: "no such option" } }))).method, "session/set_mode");
  assert.deepEqual(flags(adapter({ mode: "plan" }).parseLine(j({ id: "agy:set_mode:s-1", error: { message: "no such mode" } }))), [["spawn_failed", "set"]]);
  assert.deepEqual(adapter({ effort: "high" }).parseLine(j({ id: "agy:effort:s-1", error: { message: "no thought_level" } })),
    [{ kind: "flag", flag: "spawn_failed", action: "set", detail: "agy refused effort high: no thought_level" }]);
});

test("agy startup failures never acknowledge readiness and replay is deterministic", () => {
  const a = adapter({ model: "m", effort: "low", mode: "plan" });
  for (const id of [1, 2, 3, "agy:auth", "agy:set_model:s", "agy:effort:s", "agy:set_mode:s"]) {
    const row = j({ id, error: { code: -32603, message: "Internal error" } });
    const result = a.parseLine(row);
    assert.deepEqual(result, a.parseLine(row), String(id));
    assert.equal(result.some((signal) => signal.kind === "booted"), false, String(id));
    assert.equal(result.length, 1, String(id));
    assert.equal(result[0]!.kind, "flag", String(id));
  }
  assert.deepEqual(flags(a.parseLine(j({ id: 2, result: {} }))), [["spawn_failed", "set"]], "a new session without an id is not a session");
  assert.deepEqual(a.parseLine("not json"), []);
  assert.deepEqual(a.parseLine(j({ id: 77, result: {} })), []);
});

test("agy without a sign-in is auth_needed and names agy's own sign-in", () => {
  const signals = adapter().parseLine(j({ id: 2, error: AUTH_REQUIRED }));
  assert.deepEqual(flags(signals), [["auth_needed", "set"]]);
  const detail = signals[0]!.kind === "flag" ? signals[0]!.detail : "";
  assert.match(detail, /^Authentication required\. Sign in with agy on this computer \(run `agy`, or `agy acp --login` on a headless host\), or set GEMINI_API_KEY\.$/);
});

test("agy authenticates with the user's GEMINI_API_KEY only when agy asks, and only once", () => {
  const a = adapter({ apiKeyAuth: true });
  // A signed-in agy never sees an authenticate call.
  assert.equal(request(a.parseLine(INITIALIZED)).method, "session/new");
  const authenticate = request(a.parseLine(j({ id: 2, error: AUTH_REQUIRED })));
  assert.deepEqual(authenticate, { jsonrpc: "2.0", id: "agy:auth", method: "authenticate", params: { methodId: "gemini-api-key" } });
  const again = request(a.parseLine(j({ id: "agy:auth", result: {} })));
  assert.deepEqual(again, { jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: "/work", mcpServers: [] } });
  assert.deepEqual(a.parseLine(j({ id: 3, result: { sessionId: "s-key" } }))[0], { kind: "booted", sessionId: "s-key" });
  // A second refusal is final: no authenticate loop.
  assert.deepEqual(flags(a.parseLine(j({ id: 3, error: AUTH_REQUIRED }))), [["auth_needed", "set"]]);
  const refused = a.parseLine(j({ id: "agy:auth", error: { code: -32603, message: "API key not valid" } }));
  assert.deepEqual(flags(refused), [["auth_needed", "set"]]);
  assert.match(refused[0]!.kind === "flag" ? refused[0]!.detail : "", /^agy refused GEMINI_API_KEY: API key not valid\./);
  // Other session failures do not authenticate.
  assert.deepEqual(flags(a.parseLine(j({ id: 2, error: { code: -32603, message: "Internal error" } }))), [["spawn_failed", "set"]]);
});

test("agy turns: prompt, provider flags from the error and its data, clears on a served turn, cancel", () => {
  const a = adapter();
  const ctx = { sessionId: "s-1", messageId: 42, turnActive: false, turnId: null };
  assert.equal(a.encodeMessage("hi", { ...ctx, sessionId: null }), null);
  assert.deepEqual(JSON.parse(a.encodeMessage("hi", ctx)!), { jsonrpc: "2.0", id: 1042, method: "session/prompt", params: { sessionId: "s-1", prompt: [{ type: "text", text: "hi" }] } });
  assert.deepEqual(JSON.parse(a.encodeInterrupt!(ctx)!), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } });
  assert.equal(a.encodeInterrupt!({ sessionId: null, turnId: null }), null);

  const served = a.parseLine(j({ id: 1042, result: { stopReason: "end_turn" } }));
  assert.deepEqual(flags(served), [["auth_needed", "clear"], ["resource_blocked", "clear"]]);
  assert.equal(served.at(-1)?.kind, "turn_ended");
  assert.deepEqual(a.parseLine(j({ id: 1042, result: { stopReason: "cancelled" } })), [{ kind: "turn_ended" }]);

  const quota = a.parseLine(j({ id: 1042, error: { code: -32603, message: "Internal error", data: { details: "Quota exceeded for this model" } } }));
  assert.deepEqual(flags(quota), [["resource_blocked", "set"]]);
  assert.equal(quota.at(-1)?.kind, "turn_ended");
  const signedOut = a.parseLine(j({ id: 1042, error: AUTH_REQUIRED }));
  assert.deepEqual(flags(signedOut), [["auth_needed", "set"]]);
  assert.equal(signedOut.at(-1)?.kind, "turn_ended");
  assert.deepEqual(a.parseLine(j({ id: 1042, error: { code: -32603, message: "tool crashed" } })), [{ kind: "turn_ended" }]);
});

test("agy output opens a turn; replayed and unrelated updates do not", () => {
  const a = adapter();
  const update = (sessionUpdate: string, meta?: Record<string, unknown>) =>
    j({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s-1", update: { sessionUpdate }, ...(meta ? { _meta: meta } : {}) } });
  for (const kind of ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]) {
    assert.deepEqual(a.parseLine(update(kind)), [{ kind: "turn_started" }], kind);
  }
  // agy 1.5.2 sends the first three of these outside prompts, at boot and after a turn.
  for (const kind of ["config_option_update", "available_commands_update", "session_info_update", "user_message_chunk", "current_mode_update", "plan"]) {
    assert.deepEqual(a.parseLine(update(kind)), [], kind);
  }
  assert.deepEqual(a.parseLine(update("agent_message_chunk", { isReplay: true })), []);
});

test("agy permission requests are declined unless the spawn skips permissions", () => {
  const options = [
    { optionId: "always", name: "Always allow", kind: "allow_always" },
    { optionId: "once", name: "Allow", kind: "allow_once" },
    { optionId: "no", name: "Reject", kind: "reject_once" },
  ];
  const ask = (opts: unknown[]) => j({ jsonrpc: "2.0", id: "perm-1", method: "session/request_permission", params: { sessionId: "s-1", toolCall: { toolCallId: "t-1" }, options: opts } });
  const outcome = (a: ReturnType<typeof adapter>, opts: unknown[] = options) => {
    const signal = a.parseLine(ask(opts))[0];
    if (signal?.kind !== "respond") assert.fail();
    const reply = JSON.parse(signal.lines[0]!);
    assert.equal(reply.id, "perm-1");
    return reply.result.outcome;
  };
  assert.deepEqual(outcome(adapter()), { outcome: "selected", optionId: "no" });
  assert.deepEqual(outcome(adapter({ mode: "accept-edits" })), { outcome: "selected", optionId: "no" });
  assert.deepEqual(outcome(adapter(), options.slice(0, 2)), { outcome: "cancelled" });
  assert.deepEqual(outcome(adapter({ skipPermissions: true })), { outcome: "selected", optionId: "once" });
  assert.deepEqual(outcome(adapter({ skipPermissions: true }), [options[0], options[2]]), { outcome: "selected", optionId: "always" });
  assert.deepEqual(outcome(adapter({ skipPermissions: true }), [options[2]]), { outcome: "cancelled" });

  const unsupported = adapter().parseLine(j({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: { path: "/etc/hosts" } }))[0];
  if (unsupported?.kind !== "respond") assert.fail();
  assert.deepEqual(JSON.parse(unsupported.lines[0]!), { jsonrpc: "2.0", id: 9, error: { code: -32601, message: "unsupported client method: fs/read_text_file" } });
});
