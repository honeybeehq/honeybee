#!/usr/bin/env node
/**
 * Fake `agy acp` for driver and daemon tests: the slice of ACP v1 the Honeybee
 * agy adapter uses, in the shapes agy 1.5.2 answers initialize and session/new
 * with. No network, no credentials, no sign-in.
 *
 *   prompt text containing "hang"  streams one chunk and waits for session/cancel
 *   prompt text containing "smoke_echo"  calls that tool on the session's first
 *                                  stdio MCP server (started from session/new)
 *                                  and answers with what it returned
 *   prompt text containing "tool"  calls an MCP tool; it asks permission unless
 *                                  argv has --dangerously-skip-permissions
 *   prompt text containing "earlier"  answers with the last tool result
 *   any other prompt               one thought, the answer `echo: <text>`, end_turn
 *
 * env FAKE_AGY_SIGNED_OUT=1  session requests fail auth-required until
 *                            authenticate {methodId:"gemini-api-key"} arrives
 *                            with GEMINI_API_KEY in the env
 * env FAKE_AGY_OUT           path: argv and the env facts a test asserts, as JSON
 * env FAKE_AGY_REQUESTS      path: every request received, one JSON line each
 */
import { spawn } from "node:child_process";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_AGY_VERSION ?? "1.5.2"}\n`);
  process.exit(0);
}
if (argv[0] !== "acp") {
  process.stderr.write("fake-agy: only `acp` is implemented\n");
  process.exit(2);
}
if (process.env.FAKE_AGY_OUT) {
  const facts = {
    argv,
    autoUpdateDisabled: process.env.AGY_CLI_DISABLE_AUTO_UPDATE === "1",
    hasApiKey: (process.env.GEMINI_API_KEY ?? "").length > 0,
    sshConnection: process.env.SSH_CONNECTION ?? null,
    home: process.env.HOME ?? null,
  };
  writeFileSync(`${process.env.FAKE_AGY_OUT}.${process.pid}.tmp`, JSON.stringify(facts));
  renameSync(`${process.env.FAKE_AGY_OUT}.${process.pid}.tmp`, process.env.FAKE_AGY_OUT);
}

const SESSION = "agy-fake-session";
const FAMILIES = ["gemini-4-argon", "gemini-3.8-flash"];
const LEVELS = ["low", "medium", "high"];
const MODES = ["default", "accept-edits", "plan"];
const CONCRETE = FAMILIES.flatMap((family) => LEVELS.map((level) => `${family}-${level}`));
const skipPermissions = argv.includes("--dangerously-skip-permissions");

let authenticated = process.env.FAKE_AGY_SIGNED_OUT !== "1";
let mcp = null;
let lastToolResult = "";
let hanging = null;
let nextCall = 0;
const permissions = new Map();

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const update = (payload) => write({ method: "session/update", params: { sessionId: SESSION, update: payload } });
const refuse = (id, code, message, data) => write({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const text = (value) => ({ type: "text", text: value });

function session() {
  return {
    models: { currentModelId: "gemini-4-argon-medium", availableModels: CONCRETE.map((modelId) => ({ modelId, name: modelId })) },
    modes: { currentModeId: "default", availableModes: MODES.map((id) => ({ id, name: id })) },
    configOptions: [
      { id: "model", name: "Model", type: "select", currentValue: "gemini-4-argon", options: FAMILIES.map((value) => ({ value, name: value })) },
      { id: "thought_level", name: "Thinking", type: "select", currentValue: "medium", options: LEVELS.map((value) => ({ value, name: value })) },
      { id: "mode", name: "Mode", type: "select", currentValue: "default", options: MODES.map((value) => ({ value, name: value })) },
    ],
  };
}

function finishTool(promptId, callId, allowed) {
  update({ sessionUpdate: "tool_call_update", toolCallId: callId, status: allowed ? "completed" : "failed", content: [{ type: "content", content: text(allowed ? "echoed" : "declined") }] });
  update({ sessionUpdate: "agent_message_chunk", content: text(allowed ? "tool ran" : "tool declined") });
  write({ id: promptId, result: { stopReason: "end_turn" } });
}

/** A stdio MCP client for the session's first server: enough to initialize and call one tool. */
function startMcp(servers) {
  const server = (servers ?? [])[0];
  if (!server) return null;
  const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])) }, stdio: ["pipe", "pipe", "ignore"] });
  // A server that cannot start leaves the session without tools, as in agy.
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  const waiting = new Map();
  let next = 0;
  createInterface({ input: child.stdout }).on("line", (raw) => {
    let reply;
    try { reply = JSON.parse(raw); } catch { return; }
    waiting.get(reply.id)?.(reply);
    waiting.delete(reply.id);
  });
  const call = (method, params) => new Promise((resolve) => {
    const id = ++next;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  process.on("exit", () => child.kill());
  return { name: server.name, ready: call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } }), call };
}

async function mcpTurn(msg, body) {
  const callId = `call-${++nextCall}`;
  const input = { text: /SMOKE_[A-Z0-9_]+/.exec(body)?.[0] ?? "hi" };
  const tool = `mcp_${mcp.name}_smoke_echo`;
  update({ sessionUpdate: "tool_call", toolCallId: callId, name: tool, title: `Run ${tool}`, kind: "other", status: "in_progress", args: input, rawInput: input });
  await mcp.ready;
  const reply = await mcp.call("tools/call", { name: "smoke_echo", arguments: input });
  lastToolResult = reply.result?.content?.[0]?.text ?? "";
  // agy 1.5.2 completes an MCP call without its output.
  update({ sessionUpdate: "tool_call_update", toolCallId: callId, name: tool, title: `Run ${tool}`, kind: "other", status: "completed", args: input, rawInput: input });
  update({ sessionUpdate: "agent_message_chunk", content: text(lastToolResult) });
  write({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 4, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 24 } } });
  update({ sessionUpdate: "session_info_update", title: "Smoke" });
}

function prompt(msg) {
  const body = (msg.params.prompt ?? []).map((block) => block.text ?? "").join("");
  if (msg.params.sessionId !== SESSION) return refuse(msg.id, -32602, "Invalid params", "unknown session");
  if (body.includes("smoke_echo") && body.includes("earlier")) {
    update({ sessionUpdate: "agent_message_chunk", content: text(process.env.FAKE_AGY_RECALL ?? lastToolResult) });
    return write({ id: msg.id, result: { stopReason: "end_turn" } });
  }
  if (body.includes("smoke_echo") && mcp) return void mcpTurn(msg, body);
  if (body.includes("Count from") ) {
    update({ sessionUpdate: "agent_message_chunk", content: text("1\n2\n") });
    hanging = msg.id;
    return;
  }
  if (body.includes("hang")) {
    update({ sessionUpdate: "agent_message_chunk", content: text("working") });
    hanging = msg.id;
    return;
  }
  if (body.includes("tool")) {
    const callId = `call-${++nextCall}`;
    update({ sessionUpdate: "tool_call", toolCallId: callId, title: "Run mcp_apiary_echo", kind: "other", status: "pending", rawInput: { text: "hi" } });
    if (skipPermissions) return finishTool(msg.id, callId, true);
    const requestId = `perm-${callId}`;
    permissions.set(requestId, { promptId: msg.id, callId });
    write({ id: requestId, method: "session/request_permission", params: { sessionId: SESSION, toolCall: { toolCallId: callId }, options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ] } });
    return;
  }
  update({ sessionUpdate: "agent_thought_chunk", content: text("thinking") });
  update({ sessionUpdate: "agent_message_chunk", content: text(`echo: ${body}`) });
  write({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } });
}

createInterface({ input: process.stdin }).on("line", (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (process.env.FAKE_AGY_REQUESTS && msg.method) appendFileSync(process.env.FAKE_AGY_REQUESTS, `${JSON.stringify({ method: msg.method, params: msg.params })}\n`);
  if (msg.method === undefined) {
    const pending = permissions.get(msg.id);
    if (!pending) return;
    permissions.delete(msg.id);
    finishTool(pending.promptId, pending.callId, msg.result?.outcome?.outcome === "selected" && msg.result.outcome.optionId === "allow");
    return;
  }
  switch (msg.method) {
    case "initialize":
      write({ id: msg.id, result: {
        protocolVersion: 1,
        agentInfo: { name: "Antigravity ACP Server", version: "1.5.2" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }, promptCapabilities: { image: true, embeddedContext: true } },
        authMethods: [{ id: "oauth-personal" }, { id: "oauth-business" }, { id: "gemini-api-key" }, { id: "agent-platform" }],
      } });
      return;
    case "authenticate":
      if (msg.params?.methodId !== "gemini-api-key" || !process.env.GEMINI_API_KEY) return refuse(msg.id, -32603, "Internal error", "GEMINI_API_KEY is not set");
      authenticated = true;
      write({ id: msg.id, result: {} });
      return;
    case "session/new":
      if (!authenticated) return refuse(msg.id, -32000, "Authentication required");
      mcp = startMcp(msg.params?.mcpServers);
      write({ id: msg.id, result: { sessionId: SESSION, ...session() } });
      return;
    case "session/resume":
      if (!authenticated) return refuse(msg.id, -32000, "Authentication required");
      if (msg.params?.sessionId !== SESSION) return refuse(msg.id, -32602, "Invalid params", "unknown session");
      write({ id: msg.id, result: session() });
      return;
    case "session/set_config_option": {
      const allowed = { model: [...FAMILIES, ...CONCRETE], thought_level: LEVELS, mode: MODES }[msg.params?.configId];
      if (!allowed?.includes(msg.params.value)) return refuse(msg.id, -32602, "Invalid params", `unknown ${msg.params?.configId} value`);
      write({ id: msg.id, result: { configOptions: session().configOptions } });
      update({ sessionUpdate: "config_option_update", configOptions: session().configOptions });
      update({ sessionUpdate: "available_commands_update", availableCommands: [] });
      return;
    }
    case "session/set_model":
      if (!CONCRETE.includes(msg.params?.modelId)) return refuse(msg.id, -32602, "Invalid params", "unknown model");
      write({ id: msg.id, result: {} });
      return;
    case "session/prompt":
      prompt(msg);
      return;
    case "session/cancel":
      if (hanging !== null) {
        write({ id: hanging, result: { stopReason: "cancelled" } });
        hanging = null;
      }
      return;
    default:
      if (msg.id !== undefined) refuse(msg.id, -32601, "Method not found");
  }
});
