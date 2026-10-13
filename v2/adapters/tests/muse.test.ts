/**
 * muse adapter unit tests using trimmed `muse serve` 1.4.7 lines captured on
 * 2026-10-13 (echo provider, plus the default provider without credentials
 * for the authRequired turn). sourceRange/viewCursor members are omitted;
 * method names, ids, terminals and error shapes are unchanged.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  museAdapter,
  museFreshCommandId,
  museMessageCommandId,
  type AdapterSignal,
} from "../src/index.ts";

const SESSION_ID = "01a133e2-6725-7481-a1f9-1b611f7748be";
const TURN_ID = "00000000-0000-7000-8000-000000000005";
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const INITIALIZE_RESULT = `{"id":1,"jsonrpc":"2.0","result":{"experimentalApi":false,"grantedCapabilities":["sessionMcp"],"museHome":"/tmp/muse-h1/data/muse","platformFamily":"unix","platformOs":"linux","sandboxAvailability":"available","schema":{"fingerprint":"sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9","version":1},"serverInfo":{"name":"muse","version":"1.4.7"},"sessionDurability":"durable"}}`;
const SESSION_START_RESULT = `{"id":2,"jsonrpc":"2.0","result":{"session":{"activeTurnId":null,"kind":"root","modelId":null,"providerId":"echo","sessionId":"${SESSION_ID}","status":"idle","turnCount":0,"workspaceRoot":"/tmp/muse-h1/ws"},"viewCursor":"v:${SESSION_ID}:0"}}`;
const TURN_START_ACK = `{"id":1005,"jsonrpc":"2.0","result":{"commandId":"${TURN_ID}","disposition":"started","startedNewTurn":true,"status":"accepted","turnId":"${TURN_ID}"}}`;
const TURN_STARTED = `{"jsonrpc":"2.0","method":"turn/started","params":{"commandId":"${TURN_ID}","sessionId":"${SESSION_ID}","turnId":"${TURN_ID}"}}`;
const USER_ITEM = `{"jsonrpc":"2.0","method":"item/completed","params":{"item":{"commandId":"${TURN_ID}","kind":"userMessage","status":"completed","text":"after resume","turnId":"${TURN_ID}"},"sessionId":"${SESSION_ID}"}}`;
const AGENT_ITEM = `{"jsonrpc":"2.0","method":"item/started","params":{"item":{"kind":"agentMessage","revision":1,"status":"inProgress","text":"","turnId":"${TURN_ID}"},"sessionId":"${SESSION_ID}"}}`;
const TOKEN_USAGE = `{"jsonrpc":"2.0","method":"session/tokenUsage","params":{"cumulative":{"outputTokens":0,"promptTokens":0,"totalTokens":0},"modelId":null,"promptTokens":0,"sessionId":"${SESSION_ID}","totalTokens":0}}`;
const TURN_COMPLETED = `{"jsonrpc":"2.0","method":"turn/completed","params":{"durationMs":42,"sessionId":"${SESSION_ID}","terminal":"completed","timeToFirstTokenMs":10,"turnId":"${TURN_ID}"}}`;
const TURN_CANCELLED = `{"jsonrpc":"2.0","method":"turn/completed","params":{"durationMs":0,"reason":"cancelled before model step","sessionId":"${SESSION_ID}","terminal":"cancelled","turnId":"${TURN_ID}"}}`;
const TURN_AUTH_FAILED = `{"jsonrpc":"2.0","method":"turn/completed","params":{"durationMs":8,"error":{"kind":"authRequired","message":"not logged in: run /login to add an API key","retryable":false},"reason":"not logged in: run /login to add an API key","sessionId":"${SESSION_ID}","terminal":"failed","turnId":"${TURN_ID}"}}`;
const TURN_QUOTA_FAILED = `{"jsonrpc":"2.0","method":"turn/completed","params":{"error":{"kind":"modelError","message":"usage limit reached","quota":{"limitKind":"tierLimit","resetsAtMs":1791900000000},"retryable":false},"sessionId":"${SESSION_ID}","terminal":"failed","turnId":"${TURN_ID}"}}`;
const RESUME_NOT_FOUND = `{"error":{"code":-32020,"data":{"kind":"sessionNotFound","retryable":false,"sessionId":"${SESSION_ID}"},"message":"session ${SESSION_ID} not found"},"id":2,"jsonrpc":"2.0"}`;
const COMMAND_CONFLICT = `{"error":{"code":-32030,"data":{"commandId":"${TURN_ID}","kind":"commandRejected","reason":"command_id_conflict","retryable":false},"message":"turn/start command ${TURN_ID} rejected: command_id_conflict"},"id":1003,"jsonrpc":"2.0"}`;

const GATEWAY = { name: "apiary", command: "/usr/bin/node", args: ["shim.mjs"], env: [{ name: "HONEYBEE_GATEWAY", value: "apiary" }] };

function respondLines(signals: AdapterSignal[]): Array<Record<string, unknown>> {
  assert.equal(signals.length, 1);
  const [signal] = signals;
  if (signal?.kind !== "respond") assert.fail(`expected respond, got ${JSON.stringify(signals)}`);
  return signal.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("muse: initialize names a valid MSP client and requests session MCP without input dialogs", () => {
  const adapter = museAdapter({ cwd: "/work" });
  const [init] = adapter.bootLines().map((line) => JSON.parse(line));
  assert.equal(init.method, "initialize");
  assert.match(init.params.clientInfo.name, /^[a-z0-9_]+$/);
  assert.deepEqual(init.params.capabilities, { requestedCapabilities: ["sessionMcp"], userInputDialogs: false });
  assert.equal(adapter.readyAtSpawn, false);
  assert.equal(adapter.acceptsMidTurn, true);
  assert.equal(adapter.confirmsDelivery, true);
  assert.equal(adapter.reportsTurnProgress, true);
});

test("muse: handshake sends initialized then session/start with gateways, model and approval mode, and boots idle", () => {
  const adapter = museAdapter({ cwd: "/work", model: "muse-spark-1.3", approvalMode: "allowAll", mcpServers: [GATEWAY], setupCommandId: "01a133e2-0000-7000-8000-00000000000a" });
  const [initialized, start] = (() => {
    const signals = adapter.parseLine(INITIALIZE_RESULT);
    if (signals[0]?.kind !== "respond") assert.fail();
    return signals[0].lines.map((line) => JSON.parse(line));
  })();
  assert.deepEqual(initialized, { jsonrpc: "2.0", method: "initialized" });
  assert.equal(start.method, "session/start");
  assert.deepEqual(start.params, {
    commandId: "01a133e2-0000-7000-8000-00000000000a",
    workspaceRoot: "/work",
    approvalMode: "allowAll",
    modelId: "muse-spark-1.3",
    config: { mcpServers: { apiary: { transport: "stdio", command: "/usr/bin/node", args: ["shim.mjs"], env: { HONEYBEE_GATEWAY: "apiary" }, mode: "optional" } } },
  });
  assert.deepEqual(adapter.parseLine(SESSION_START_RESULT), [
    { kind: "booted", sessionId: SESSION_ID },
    { kind: "flag", flag: "spawn_failed", action: "clear", detail: "runtime booted" },
    { kind: "turn_ended" },
  ]);
});

test("muse: each runtime mints its own session/start command id (the host dedups by it)", () => {
  const first = respondLines(museAdapter({ cwd: "/work" }).parseLine(INITIALIZE_RESULT))[1]!;
  const second = respondLines(museAdapter({ cwd: "/work" }).parseLine(INITIALIZE_RESULT))[1]!;
  const a = (first.params as { commandId: string }).commandId;
  const b = (second.params as { commandId: string }).commandId;
  assert.match(a, UUID_V7);
  assert.match(b, UUID_V7);
  assert.notEqual(a, b);
});

test("muse: resume loads the recorded session with gateways and never boots on failure", () => {
  const adapter = museAdapter({ cwd: "/work", resumeSessionId: SESSION_ID, mcpServers: [GATEWAY] });
  const resume = respondLines(adapter.parseLine(INITIALIZE_RESULT))[1]!;
  assert.equal(resume.method, "session/resume");
  const params = resume.params as Record<string, unknown>;
  assert.equal(params.sessionId, SESSION_ID);
  assert.equal(params.excludeItems, true);
  assert.deepEqual(Object.keys((params.config as { mcpServers: object }).mcpServers), ["apiary"]);
  assert.match(String(params.commandId), UUID_V7);
  assert.ok(adapter.parseLine(SESSION_START_RESULT).some((s) => s.kind === "booted" && s.sessionId === SESSION_ID));

  const failed = adapter.parseLine(RESUME_NOT_FOUND);
  assert.deepEqual(failed, [{ kind: "flag", flag: "spawn_failed", action: "set", detail: `session ${SESSION_ID} not found` }]);
});

test("muse: resume with a different model applies session/setModel before booting", () => {
  const adapter = museAdapter({ cwd: "/work", resumeSessionId: SESSION_ID, model: "muse-spark-1.2" });
  const setModel = respondLines(adapter.parseLine(SESSION_START_RESULT))[0]!;
  assert.equal(setModel.method, "session/setModel");
  assert.deepEqual((setModel.params as Record<string, unknown>).model, { modelId: "muse-spark-1.2" });
  assert.equal((setModel.params as Record<string, unknown>).sessionId, SESSION_ID);
  assert.ok(adapter.parseLine(JSON.stringify({ id: setModel.id, jsonrpc: "2.0", result: { status: "accepted" } }))
    .some((s) => s.kind === "booted" && s.sessionId === SESSION_ID));
  assert.ok(adapter.parseLine(JSON.stringify({ id: setModel.id, jsonrpc: "2.0", error: { code: -32602, message: "unknown model" } }))
    .some((s) => s.kind === "flag" && s.flag === "spawn_failed"));
});

test("muse: an initialize failure is spawn evidence, an auth failure at setup is auth evidence", () => {
  const adapter = museAdapter({ cwd: "/work" });
  assert.deepEqual(adapter.parseLine('{"id":1,"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid clientInfo.name"}}'),
    [{ kind: "flag", flag: "spawn_failed", action: "set", detail: "invalid clientInfo.name" }]);
  assert.deepEqual(adapter.parseLine('{"id":2,"jsonrpc":"2.0","error":{"code":-32000,"message":"not logged in"}}'),
    [{ kind: "flag", flag: "auth_needed", action: "set", detail: "not logged in" }]);
});

test("muse: mail is turn/start with a stable UUIDv7 command id; steer while a turn runs", () => {
  const adapter = museAdapter({ cwd: "/work", effort: "xhigh" });
  assert.equal(adapter.encodeMessage("hi", { sessionId: null, messageId: 5, turnActive: false, turnId: null }), null);
  const idle = JSON.parse(adapter.encodeMessage("hi", { sessionId: SESSION_ID, messageId: 5, turnActive: false, turnId: null })!);
  assert.equal(idle.id, 1005);
  assert.equal(idle.method, "turn/start");
  assert.deepEqual(idle.params, {
    sessionId: SESSION_ID,
    commandId: museMessageCommandId(5),
    input: [{ type: "text", text: "hi" }],
    ifBusy: "queue",
    reasoningEffort: "xhigh",
  });
  const busy = JSON.parse(adapter.encodeMessage("more", { sessionId: SESSION_ID, messageId: 6, turnActive: true, turnId: TURN_ID })!);
  assert.equal(busy.params.ifBusy, "steer");
  assert.equal(museMessageCommandId(5), "00000000-0000-7000-8000-000000000005");
  assert.match(museMessageCommandId(2 ** 53 - 1), UUID_V7);
  assert.notEqual(museMessageCommandId(5), museMessageCommandId(6));
  assert.equal(JSON.parse(museAdapter({ cwd: "/work" }).encodeMessage("x", { sessionId: SESSION_ID, messageId: 1, turnActive: false, turnId: null })!).params.reasoningEffort, undefined);
});

test("muse: the turn/start ack confirms delivery; a rejected command is refused for retry", () => {
  const adapter = museAdapter({ cwd: "/work" });
  assert.deepEqual(adapter.parseLine(TURN_START_ACK), [{ kind: "delivery_confirmed", messageId: 5 }]);
  assert.deepEqual(adapter.parseLine(COMMAND_CONFLICT), [{ kind: "delivery_refused", messageId: 3 }]);
});

test("muse: recorded turn maps to session-scoped edges with progress and success clears", () => {
  const adapter = museAdapter({ cwd: "/work" });
  const signals = [TURN_STARTED, USER_ITEM, AGENT_ITEM, TOKEN_USAGE, TURN_COMPLETED].flatMap((line) => adapter.parseLine(line));
  assert.deepEqual(signals, [
    { kind: "turn_started", turnId: TURN_ID, threadId: SESSION_ID },
    { kind: "turn_progress" },
    { kind: "turn_progress" },
    { kind: "flag", flag: "auth_needed", action: "clear", detail: "successful authenticated turn" },
    { kind: "flag", flag: "resource_blocked", action: "clear", detail: "successful turn served" },
    { kind: "turn_ended", threadId: SESSION_ID },
  ]);
});

test("muse: cancelled turns close without evidence; authRequired and quota failures set flags first", () => {
  const adapter = museAdapter({ cwd: "/work" });
  assert.deepEqual(adapter.parseLine(TURN_CANCELLED), [{ kind: "turn_ended", threadId: SESSION_ID }]);
  assert.deepEqual(adapter.parseLine(TURN_AUTH_FAILED), [
    { kind: "flag", flag: "auth_needed", action: "set", detail: "not logged in: run /login to add an API key" },
    { kind: "turn_ended", threadId: SESSION_ID },
  ]);
  assert.deepEqual(adapter.parseLine(TURN_QUOTA_FAILED), [
    { kind: "flag", flag: "resource_blocked", action: "set", detail: "muse quota exhausted (tierLimit): usage limit reached", resetsAt: 1791900000000 },
    { kind: "turn_ended", threadId: SESSION_ID },
  ]);
});

test("muse: interrupt targets the known turn with a fresh UUIDv7 command id", () => {
  const adapter = museAdapter({ cwd: "/work" });
  assert.equal(adapter.encodeInterrupt?.({ sessionId: null, turnId: null }), null);
  const first = JSON.parse(adapter.encodeInterrupt!({ sessionId: SESSION_ID, turnId: TURN_ID })!);
  const second = JSON.parse(adapter.encodeInterrupt!({ sessionId: SESSION_ID, turnId: null })!);
  assert.equal(first.method, "turn/interrupt");
  assert.equal(first.params.sessionId, SESSION_ID);
  assert.equal(first.params.turnId, TURN_ID);
  assert.match(first.params.commandId, UUID_V7);
  assert.equal("turnId" in second.params, false);
  assert.notEqual(first.params.commandId, second.params.commandId);
  assert.deepEqual(adapter.parseLine(`{"id":"${first.id}","jsonrpc":"2.0","result":{"commandId":"${first.params.commandId}","status":"accepted","turnId":"${TURN_ID}"}}`), []);
});

test("muse: server requests are refused so the host never waits on Honeybee", () => {
  const adapter = museAdapter({ cwd: "/work" });
  const [reply] = respondLines(adapter.parseLine('{"id":7,"jsonrpc":"2.0","method":"approval/request","params":{"sessionId":"s"}}'));
  assert.deepEqual(reply, { jsonrpc: "2.0", id: 7, error: { code: -32601, message: "unsupported server request: approval/request" } });
  assert.deepEqual(adapter.parseLine("not json"), []);
});

test("muse: fresh command ids are RFC 9562 version 7 with the time prefix", () => {
  const id = museFreshCommandId(0x01a133e26725);
  assert.match(id, UUID_V7);
  assert.ok(id.startsWith("01a133e2-6725-7"));
});
