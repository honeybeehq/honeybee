import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.AGY_STUB_LOG;
const FAMILIES = {
  "gemini-4-neon": { name: "Gemini 4 Neon", levels: ["low", "medium", "high", "xhigh"] },
  "gemini-4-argon": { name: "Gemini 4 Argon", levels: ["low", "medium", "high"] },
  "gpt-oss-120b-medium": { name: "GPT-OSS 120B (Medium)", levels: [] },
};
const CONTEXT = { "gemini-4-neon": 1048576, "gemini-4-argon": 1048576, "gpt-oss-120b-medium": 131072 };
const sessions = new Map();
let nextSession = 1;
let activePrompt;
let pendingPermission;
let nextServerRequest = 1;
log({ argv: process.argv.slice(2), autoUpdateDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null, authMethodEnv: process.env.HIVE_AGY_AUTH_METHOD ?? null });

function log(value) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(value)}\n`);
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function update(sessionId, value) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
}

function availableModels() {
  return Object.entries(FAMILIES).flatMap(([family, { name, levels }]) => levels.length === 0
    ? [{ modelId: family, name }]
    : levels.map((level) => ({ modelId: `${family}-${level}`, name: `${name} (${level[0].toUpperCase()}${level.slice(1)})` })));
}

function configOptions(state) {
  const levels = FAMILIES[state.model].levels;
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: state.model, options: Object.entries(FAMILIES).map(([value, { name }]) => ({ value, name })) },
    ...(levels.length > 0 ? [{ id: "thought_level", name: "Thinking Level", category: "thought_level", type: "select", currentValue: state.level, options: levels.map((value) => ({ value, name: value })) }] : []),
    { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: state.mode, options: ["default", "accept-edits", "auto", "plan"].map((value) => ({ value, name: value })) },
  ];
}

function usage(seed) {
  return { inputTokens: seed * 100, outputTokens: seed * 10, cachedReadTokens: seed * 40, cachedWriteTokens: 0, thoughtTokens: seed * 3, totalTokens: seed * 150 };
}

function finish(stopReason = "end_turn", seed = 1) {
  const prompt = activePrompt;
  if (!prompt) return;
  activePrompt = undefined;
  const state = sessions.get(prompt.sessionId);
  update(prompt.sessionId, { sessionUpdate: "usage_update", used: seed * 1000, size: CONTEXT[state.model] });
  send({ jsonrpc: "2.0", id: prompt.id, result: { stopReason, ...(stopReason === "cancelled" ? {} : { usage: usage(seed) }) } });
}

function selectModel(state, value) {
  if (FAMILIES[value]) {
    state.model = value;
    const levels = FAMILIES[value].levels;
    state.level = levels.includes(state.level) ? state.level : levels.at(-1) ?? null;
    return true;
  }
  const dash = value.lastIndexOf("-");
  const family = value.slice(0, dash);
  const level = value.slice(dash + 1);
  if (!FAMILIES[family]?.levels.includes(level)) return false;
  state.model = family;
  state.level = level;
  return true;
}

function configure(message) {
  const { sessionId, configId, value } = message.params ?? {};
  const state = sessions.get(sessionId);
  if (!state) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown session ${sessionId}` } });
  if (configId === "model" && !selectModel(state, value)) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Unknown model ID: ${value}` } });
  if (configId === "thought_level") {
    if (!FAMILIES[state.model].levels.includes(value)) return send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Thinking level "${value}" is not offered for model "${FAMILIES[state.model].name}"` } });
    state.level = value;
  }
  if (configId === "mode") state.mode = value;
  update(sessionId, { sessionUpdate: "config_option_update", configOptions: configOptions(state) });
  update(sessionId, { sessionUpdate: "usage_update", used: 0, size: CONTEXT[state.model] });
  send({ jsonrpc: "2.0", id: message.id, result: { configOptions: configOptions(state) } });
}

function prompt(message) {
  const sessionId = message.params?.sessionId;
  const text = message.params?.prompt?.[0]?.text ?? "";
  activePrompt = { id: message.id, sessionId, text };
  if (text.includes("TOOL-PROBE")) {
    const tool = { toolCallId: "call_1", name: "run_command", kind: "execute", title: "echo stub > stub.txt", rawInput: { CommandLine: "echo stub > stub.txt" } };
    update(sessionId, { sessionUpdate: "tool_call", ...tool, status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", ...tool, status: "pending" });
    pendingPermission = { id: String(nextServerRequest++), sessionId, tool };
    send({
      jsonrpc: "2.0",
      id: pendingPermission.id,
      method: "session/request_permission",
      params: { sessionId, toolCall: { sessionUpdate: "tool_call", ...tool, status: "pending" }, options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] },
    });
    return;
  }
  if (text.includes("WAIT-FOR-CANCEL")) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
    return;
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply:" } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text } });
  setTimeout(() => finish("end_turn", 1), 10);
}

function permissionAnswered(message) {
  const pending = pendingPermission;
  pendingPermission = undefined;
  const allowed = message.result?.outcome?.outcome === "selected" && message.result.outcome.optionId === "allow";
  if (allowed) {
    update(pending.sessionId, { sessionUpdate: "tool_call_update", ...pending.tool, status: "in_progress" });
    update(pending.sessionId, { sessionUpdate: "tool_call_update", ...pending.tool, status: "completed", rawOutput: { output: "Command exited with code 0.", exit_code: 0 } });
  } else {
    update(pending.sessionId, { sessionUpdate: "tool_call_update", ...pending.tool, status: "failed", rawOutput: { output: "Permission denied" } });
  }
  update(pending.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: allowed ? "ran the command" : "was not allowed" } });
  finish("end_turn", 2);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log(message);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { resume: {}, load: {}, close: {} }, auth: { logout: {} } },
      agentInfo: { name: "Antigravity ACP Stub", version: "1.5.18" },
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google" },
        { id: "oauth-business", name: "Log in with Gemini Enterprise" },
        { id: "gemini-api-key", name: "Gemini API key" },
        { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
      ],
    } });
    return;
  }
  if (message.method === "authenticate") {
    if (message.params?.methodId === "gemini-api-key" && !process.env.GEMINI_API_KEY) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "GEMINI_API_KEY is not set; pass an API key in _meta.apiKey or set the GEMINI_API_KEY environment variable." } });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/new" || message.method === "session/resume") {
    if (process.env.AGY_STUB_SIGNED_OUT === "1") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Authentication required" } });
      return;
    }
    const resumed = message.method === "session/resume";
    const sessionId = resumed ? message.params?.sessionId : `agy-session-${process.pid}-${nextSession++}`;
    if (resumed && typeof sessionId !== "string") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "session/resume needs a sessionId" } });
      return;
    }
    const state = { model: "gemini-4-neon", level: "high", mode: "default" };
    sessions.set(sessionId, state);
    update(sessionId, { sessionUpdate: "available_commands_update", availableCommands: [] });
    update(sessionId, { sessionUpdate: "usage_update", used: 0, size: CONTEXT[state.model] });
    send({ jsonrpc: "2.0", id: message.id, result: {
      ...(resumed ? {} : { sessionId }),
      models: { availableModels: availableModels(), currentModelId: `${state.model}-${state.level}` },
      configOptions: configOptions(state),
    } });
    return;
  }
  if (message.method === "session/set_config_option") return configure(message);
  if (message.method === "session/prompt") return prompt(message);
  if (message.method === "session/cancel") {
    if (pendingPermission) pendingPermission = undefined;
    finish("cancelled");
    return;
  }
  if (pendingPermission && message.id === pendingPermission.id && "result" in message) return permissionAnswered(message);
  if (message.id !== undefined && message.method) send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
});
