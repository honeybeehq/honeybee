/**
 * Grok harness adapter (WP3) — normalizes `grok agent stdio` ACP JSON-RPC.
 *
 * Format distilled from the previous system's adapter (`src/hsr/adapters/grok.ts`
 * + `acpRpc.ts`): NDJSON JSON-RPC 2.0, handshake initialize → authenticate →
 * session/new|load, then session/prompt for each mailbox delivery. No old
 * code is imported. Re-verify against a live `grok agent stdio` in the
 * manual smoke (`v2/driver-hsr/SMOKE.md`).
 *
 *   we write : initialize {protocolVersion:1, clientCapabilities, clientInfo}
 *   server   : initialize result {authMethods, agentCapabilities} → respond:
 *                authenticate {methodId: cached_token | xai.api_key}
 *   server   : authenticate result → respond:
 *                session/new {cwd, mcpServers}  (or session/load {sessionId})
 *   server   : session/new|load result {sessionId} → booted (idle)
 *   we write : session/prompt {sessionId, prompt:[{type:"text",text}]}
 *   server   : session/prompt result → turn_ended
 *   server   : session/update agent_* chunks → turn_started (self-woken turns:
 *              background-task completions have no session/prompt result)
 *   server   : _x.ai/session_notification turn_completed
 *              / _x.ai/session/prompt_complete → turn_ended
 *   server   : session/request_permission → auto-allow (spawn uses --always-approve)
 *
 * The adapter is a factory: session/new needs cwd (and optionally a resume
 * session id). The returned object is still pure/stateless — signals derive
 * only from the input line.
 */
import {
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import { asObject } from "./types.ts";
import {
  projectorCheckpoint, checkpointRecord, checkpointEntries, checkpointJson,
  checkpointNullable, checkpointString, checkpointStrings, checkpointBoolean,
  type TranscriptFamily, type TranscriptIsoTs, type TranscriptProjectedEvent, type TranscriptProjector, type TranscriptTokenUsage,
} from "./transcript.ts";

const INITIALIZE_ID = 1;
const AUTHENTICATE_ID = 2;
const SESSION_SETUP_ID = 3;
const PROMPT_ID_BASE = 1000;
const ACP_PROTOCOL_VERSION = 1;
const METHOD_NOT_FOUND = -32601;

export interface GrokAdapterOptions {
  cwd: string;
  /** Live operator gateways supplied by the daemon through ACP session setup. */
  mcpServers?: readonly GrokMcpServerStdio[];
  /**
   * Harness-native resume (spec 07 §F): when set, the handshake sends
   * `session/load {sessionId}` instead of `session/new`. Grok has no argv
   * resume on `agent stdio` — the ACP method is the resume path.
   */
  resumeSessionId?: string;
}

/** ACP v1 stdio MCP server shape (all ACP agents must support this transport). */
export interface GrokMcpServerStdio {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

function errorSignals(message: string): AdapterSignal[] {
  if (isAuthNeededMessage(message)) {
    return [{ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) }];
  }
  if (isResourceBlockedMessage(message)) {
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) }];
  }
  return [];
}

/** ACP prompt failures: JSON-RPC -32003 is grok's quota-exhausted code (old adapter). */
function promptErrorSignals(err: Record<string, unknown> | undefined, fallback: string): AdapterSignal[] {
  const message = String(err?.message ?? fallback);
  if (err?.code === -32003) {
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) }];
  }
  return errorSignals(message);
}

function updateKind(params: unknown): string | undefined {
  const object = asObject(params);
  const update = asObject(object?.update) ?? object;
  const kind = update?.sessionUpdate ?? update?.session_update ?? update?.type;
  return typeof kind === "string" ? kind : undefined;
}

function isReplay(params: unknown): boolean {
  const meta = asObject(asObject(params)?._meta);
  return meta?.isReplay === true;
}

function isGrokTurnCompleteMethod(method: string): boolean {
  return method === "_x.ai/session/prompt_complete"
    || method === "x.ai/session/prompt_complete";
}

function isSessionUpdateMethod(method: string): boolean {
  return method === "session/update"
    || method === "_x.ai/session/update"
    || method === "x.ai/session/update"
    || method === "_x.ai/session_notification"
    || method === "x.ai/session_notification";
}

function authMethodId(initialized: Record<string, unknown> | undefined): string | undefined {
  const methods = initialized && Array.isArray(initialized.authMethods) ? initialized.authMethods : [];
  const ids = methods.flatMap((method) => {
    const id = asObject(method)?.id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  });
  if (ids.includes("cached_token")) return "cached_token";
  if (ids.includes("xai.api_key")) return "xai.api_key";
  return ids[0];
}

function sessionIdOf(value: unknown): string | undefined {
  const object = asObject(value);
  const id = object?.sessionId ?? object?.session_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Pick the allow-once / allow option from a permission request, if any. */
export function grokAllowPermissionResult(params: unknown): Record<string, unknown> {
  const options = asObject(params)?.options;
  if (Array.isArray(options)) {
    const mapped = options.flatMap((raw) => {
      const option = asObject(raw);
      const optionId = option?.optionId ?? option?.option_id;
      const kind = typeof option?.kind === "string" ? option.kind : "";
      return typeof optionId === "string" ? [{ optionId, kind }] : [];
    });
    const selected = mapped.find((option) => /allow_once/i.test(option.kind))
      ?? mapped.find((option) => /allow/i.test(option.kind) && !/reject|deny/i.test(option.kind))
      ?? mapped[0];
    if (selected) return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }
  return { outcome: { outcome: "selected", optionId: "allow-once" } };
}

export function grokAdapter(opts: GrokAdapterOptions): HarnessAdapter {
  const setupMethod = opts.resumeSessionId ? "session/load" : "session/new";
  const setupLine = JSON.stringify({
    jsonrpc: "2.0",
    id: SESSION_SETUP_ID,
    method: setupMethod,
    params: {
      cwd: opts.cwd,
      mcpServers: opts.mcpServers?.map((server) => ({
        ...server,
        args: [...server.args],
        env: server.env.map((entry) => ({ ...entry })),
      })) ?? [],
      ...(opts.resumeSessionId ? { sessionId: opts.resumeSessionId } : {}),
    },
  });

  function parseLine(line: string): AdapterSignal[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];

    if (typeof msg.method === "string") return methodSignals(msg);

    if (msg.id === INITIALIZE_ID) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        return errorSignals(String(err?.message ?? "grok initialize failed"));
      }
      const methodId = authMethodId(asObject(msg.result));
      if (!methodId) {
        return [{ kind: "flag", flag: "auth_needed", action: "set", detail: "Grok ACP advertised no auth methods" }];
      }
      return [{
        kind: "respond",
        lines: [JSON.stringify({
          jsonrpc: "2.0",
          id: AUTHENTICATE_ID,
          method: "authenticate",
          params: { methodId },
        })],
      }];
    }

    if (msg.id === AUTHENTICATE_ID) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        return errorSignals(String(err?.message ?? "grok authenticate failed"));
      }
      return [{ kind: "respond", lines: [setupLine] }];
    }

    if (msg.id === SESSION_SETUP_ID) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        return errorSignals(String(err?.message ?? `grok ${setupMethod} failed`));
      }
      const sessionId = sessionIdOf(msg.result) ?? opts.resumeSessionId;
      if (sessionId) return bootedToIdle(sessionId);
      return errorSignals(`grok ${setupMethod} returned no sessionId`);
    }

    if (typeof msg.id === "number" && msg.id >= PROMPT_ID_BASE) {
      if ("error" in msg) {
        const err = asObject(msg.error);
        const signals = promptErrorSignals(err, "grok session/prompt failed");
        signals.push({ kind: "turn_ended" });
        return signals;
      }
      return [...successfulTurnClears(), { kind: "turn_ended" }];
    }

    return [];
  }

  function methodSignals(msg: Record<string, unknown>): AdapterSignal[] {
    if (msg.id !== undefined && msg.id !== null) {
      if (msg.method === "session/request_permission") {
        return [{
          kind: "respond",
          lines: [JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: grokAllowPermissionResult(msg.params) })],
        }];
      }
      return [{
        kind: "respond",
        lines: [JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: METHOD_NOT_FOUND, message: `unsupported server request: ${String(msg.method)}` },
        })],
      }];
    }
    // Replayed historical updates must not reopen/close the live turn.
    if (isReplay(msg.params)) return [];

    // Self-woken turns (background tasks, scheduled continuations): ACP has
    // no session/prompt JSON-RPC, so agent output is the opening edge and
    // Grok's turn_completed / prompt_complete notifications are the close.
    // Hive-delivered turns also emit those notifications; duplicate
    // turn_ended is idle-idempotent in the driver.
    if (typeof msg.method === "string" && isGrokTurnCompleteMethod(msg.method)) {
      return [...successfulTurnClears(), { kind: "turn_ended" }];
    }
    if (typeof msg.method === "string" && isSessionUpdateMethod(msg.method)) {
      const kind = updateKind(msg.params);
      if (kind === "turn_completed") {
        return [...successfulTurnClears(), { kind: "turn_ended" }];
      }
      if (
        kind === "agent_message_chunk"
        || kind === "agent_message"
        || kind === "agent_thought_chunk"
        || kind === "tool_call"
        || kind === "tool_call_update"
      ) {
        return [{ kind: "turn_started" }];
      }
    }
    return [];
  }

  return {
    harness: "grok",
    acceptsMidTurn: false,
    readyAtSpawn: false,
    bootLines(): string[] {
      return [JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "Honeybee", version: "2" },
        },
      })];
    },
    parseLine,
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      if (!ctx.sessionId) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: PROMPT_ID_BASE + ctx.messageId,
        method: "session/prompt",
        params: { sessionId: ctx.sessionId, prompt: [{ type: "text", text: body }] },
      });
    },
    encodeInterrupt(ctx: InterruptContext): string | null {
      if (!ctx.sessionId) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: ctx.sessionId },
      });
    },
  };
}

type JsonObject = Record<string, unknown>;
type MessageRole = "user" | "assistant";

type OpenChunk =
  | { kind: "message"; role: MessageRole; text: string; ts: TranscriptIsoTs }
  | { kind: "thinking"; redacted: boolean; text?: string; ts: TranscriptIsoTs };

interface ToolState {
  name: string;
  input?: unknown;
  status?: string;
  callEmitted: boolean;
  resultEmitted: boolean;
}

const UPDATE_METHODS = new Set([
  "session/update",
  "_x.ai/session/update",
  "x.ai/session/update",
  "_x.ai/session_notification",
  "x.ai/session_notification",
]);

const PROMPT_COMPLETE_METHODS = new Set([
  "session/prompt_complete",
  "_x.ai/session/prompt_complete",
  "x.ai/session/prompt_complete",
]);

const TURN_END_METHODS = new Set([
  ...PROMPT_COMPLETE_METHODS,
  "session/turn_completed",
  "_x.ai/session/turn_completed",
  "x.ai/session/turn_completed",
  "_x.ai/turn_completed",
  "x.ai/turn_completed",
]);

const TURN_END_UPDATE_KINDS = new Set([
  "turn_completed",
  "turn_complete",
  "prompt_complete",
]);

function stringField(value: JsonObject, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string") return value[key];
  }
  return undefined;
}

function firstDefined(value: JsonObject, ...keys: string[]): unknown {
  for (const key of keys) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function hasField(value: JsonObject, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isoTimestamp(...values: Array<JsonObject | undefined>): TranscriptIsoTs {
  for (const value of values) {
    if (!value) continue;
    const meta = asObject(value._meta);
    const direct = firstDefined(value, "timestamp", "ts");
    const epochMs = firstDefined(
      value,
      "agentTimestampMs",
      "timestampMs",
      "emittedAtMs",
      "startedAtMs",
      "completedAtMs",
    ) ?? (meta && firstDefined(
      meta,
      "agentTimestampMs",
      "timestampMs",
      "emittedAtMs",
      "startedAtMs",
      "completedAtMs",
    ));
    const candidate = direct ?? epochMs;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      const date = new Date(candidate);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
  }
  return null;
}

/** Extract text without trimming chunk whitespace, which is semantically significant. */
function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const texts = value.flatMap((block) => {
      const text = textContent(block);
      return text != null && text.trim().length > 0 ? [text] : [];
    });
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  const object = asObject(value);
  if (!object) return undefined;
  if (typeof object.text === "string") return object.text;
  if (object.content !== value) return textContent(object.content);
  return undefined;
}

function sessionUpdateKind(update: JsonObject): string | undefined {
  return stringField(update, "sessionUpdate", "session_update", "type");
}

function isRedactedThinking(update: JsonObject): boolean {
  const content = asObject(update.content);
  return update.redacted === true
    || content?.redacted === true
    || content?.type === "redacted"
    || content?.type === "redacted_thinking";
}

function updatePayload(row: JsonObject): { params?: JsonObject; update?: JsonObject } {
  const params = asObject(row.params);
  return { params, update: asObject(params?.update) ?? params };
}

function promptText(params: JsonObject | undefined): string | undefined {
  const text = textContent(params?.prompt);
  return text != null && text.trim().length > 0 ? text : undefined;
}

function toolOutput(update: JsonObject): unknown {
  return firstDefined(update, "rawOutput", "raw_output", "output", "result");
}

function printableOutput(value: unknown): string | undefined {
  const text = textContent(value);
  if (text !== undefined) return text;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isTerminalToolStatus(status: string | undefined): boolean {
  return status != null && [
    "complete",
    "completed",
    "success",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
  ].includes(status.toLowerCase());
}

function isErrorToolStatus(status: string | undefined): boolean {
  return status != null && ["failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

const GROK_COMPACTION_SUMMARY_PREFIX =
  "This session is being continued from a previous conversation that ran out of context. "
  + "The summary below covers the earlier portion of the conversation.";

/**
 * Grok persists its generated continuation summary as an otherwise-unmarked
 * user chat-history row. Match the full provider scaffold, including the
 * Summary heading, so quoted prose and ordinary user messages stay visible.
 */
export function isGrokCompactionSummary(text: string): boolean {
  const normalized = text.trimStart().replace(/\r\n/g, "\n");
  return normalized.startsWith(`${GROK_COMPACTION_SUMMARY_PREFIX}\n\nSummary:`);
}

/**
 * ACP turn_completed usage (camelCase). xAI counts cached reads inside
 * inputTokens (totalTokens = inputTokens + outputTokens); the projection's
 * `input` is uncached input, so subtract.
 */
function turnUsageFrom(usage: JsonObject | undefined): TranscriptTokenUsage | undefined {
  if (!usage) return undefined;
  const inputInclusive = finiteNumberField(usage, "inputTokens", "input_tokens");
  const cacheRead = finiteNumberField(usage, "cachedReadTokens", "cache_read_input_tokens");
  const input =
    inputInclusive !== undefined && cacheRead !== undefined
      ? Math.max(0, inputInclusive - cacheRead)
      : inputInclusive;
  const output = finiteNumberField(usage, "outputTokens", "output_tokens");
  const cacheWrite = finiteNumberField(usage, "cacheCreationTokens", "cache_creation_input_tokens");
  const reasoning = finiteNumberField(usage, "reasoningTokens", "reasoning_tokens");
  const total = finiteNumberField(usage, "totalTokens", "total_tokens");
  const out: TranscriptTokenUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The `modelUsage` entry with the most tokens — the model the turn billed against. */
function dominantModel(modelUsage: JsonObject | undefined): string | undefined {
  if (!modelUsage) return undefined;
  let best: { model: string; tokens: number } | undefined;
  for (const [model, value] of Object.entries(modelUsage)) {
    const entry = asObject(value);
    const tokens = (entry ? finiteNumberField(entry, "totalTokens", "total_tokens") : undefined) ?? 0;
    if (!best || tokens > best.tokens) best = { model, tokens };
  }
  return best?.model;
}

function finiteNumberField(value: JsonObject, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

// checkpoint-digest:start
export interface GrokCheckpointState {
  openChunk: OpenChunk | null;
  pendingPromptMirror: string | null;
  tools: Array<[string, ToolState]>;
  seenCompactions: string[];
}
function isOpenChunk(value: unknown): boolean {
  const v = asObject(value);
  if (!v) return false;
  const ts = checkpointNullable(checkpointString);
  if (v.kind === "message") return checkpointRecord(v, {
    kind: (x) => x === "message", role: (x) => x === "user" || x === "assistant", text: checkpointString, ts,
  });
  return checkpointRecord(v, { kind: (x) => x === "thinking", redacted: checkpointBoolean, ts,
    ...(Object.hasOwn(v, "text") ? { text: checkpointString } : {}),
  });
}
function isToolState(value: unknown): boolean {
  const v = asObject(value);
  return !!v && checkpointRecord(v, {
    name: checkpointString, callEmitted: checkpointBoolean, resultEmitted: checkpointBoolean,
    ...(Object.hasOwn(v, "input") ? { input: checkpointJson } : {}),
    ...(Object.hasOwn(v, "status") ? { status: checkpointString } : {}),
  });
}

export function isGrokCheckpointState(value: unknown): value is GrokCheckpointState {
  return checkpointRecord(value, {
    openChunk: checkpointNullable(isOpenChunk),
    pendingPromptMirror: checkpointNullable(checkpointString),
    tools: checkpointEntries(isToolState),
    seenCompactions: checkpointStrings,
  });
}
/**
 * Project Grok's published ACP session log and native chat_history rows.
 *
 * ACP message and thought updates are deltas, not message boundaries. The
 * projector therefore owns a single open chunk buffer and only publishes it
 * when the stream changes shape or the caller explicitly flushes at EOF.
 */
export function createGrokProjector(restored?: GrokCheckpointState): TranscriptProjector {
  let openChunk: OpenChunk | undefined = restored?.openChunk ?? undefined;
  let pendingPromptMirror: string | undefined = restored?.pendingPromptMirror ?? undefined;
  const tools = new Map<string, ToolState>(restored?.tools);
  const seenCompactions = new Set<string>(restored?.seenCompactions);

  function flushOpenChunk(): TranscriptProjectedEvent[] {
    const chunk = openChunk;
    openChunk = undefined;
    if (!chunk) return [];
    if (chunk.kind === "thinking") {
      if (chunk.redacted) return [{ kind: "thinking", ts: chunk.ts, redacted: true }];
      return chunk.text != null && chunk.text.trim().length > 0
        ? [{ kind: "thinking", ts: chunk.ts, redacted: false, text: chunk.text }]
        : [];
    }
    return chunk.text.trim().length > 0
      ? [{ kind: "message", ts: chunk.ts, role: chunk.role, text: chunk.text }]
      : [];
  }

  function appendMessageChunk(role: MessageRole, text: string, ts: TranscriptIsoTs): TranscriptProjectedEvent[] {
    if (openChunk?.kind === "message" && openChunk.role === role) {
      openChunk.text += text;
      return [];
    }
    const events = flushOpenChunk();
    openChunk = { kind: "message", role, text, ts };
    return events;
  }

  function withoutPromptMirror(text: string): string | undefined {
    if (pendingPromptMirror === undefined) return text;
    if (pendingPromptMirror.startsWith(text)) {
      pendingPromptMirror = pendingPromptMirror.slice(text.length);
      if (pendingPromptMirror.length === 0) pendingPromptMirror = undefined;
      return undefined;
    }
    if (text.startsWith(pendingPromptMirror)) {
      const remainder = text.slice(pendingPromptMirror.length);
      pendingPromptMirror = undefined;
      return remainder.length > 0 ? remainder : undefined;
    }
    pendingPromptMirror = undefined;
    return text;
  }

  function appendThinkingChunk(
    text: string | undefined,
    redacted: boolean,
    ts: TranscriptIsoTs,
  ): TranscriptProjectedEvent[] {
    if (openChunk?.kind === "thinking" && openChunk.redacted === redacted) {
      if (!redacted && text !== undefined) openChunk.text = `${openChunk.text ?? ""}${text}`;
      return [];
    }
    const events = flushOpenChunk();
    openChunk = { kind: "thinking", redacted, ...(redacted || text === undefined ? {} : { text }), ts };
    return events;
  }

  function projectTool(update: JsonObject, ts: TranscriptIsoTs): TranscriptProjectedEvent[] {
    const callId = stringField(update, "toolCallId", "tool_call_id", "callId", "call_id", "id");
    if (!callId) {
      return [{ kind: "unknown", ts, nativeType: sessionUpdateKind(update) ?? "tool_call", detail: "missing tool call id" }];
    }

    const previous = tools.get(callId);
    const name = stringField(update, "title", "name", "kind") ?? previous?.name ?? "tool";
    const nextInput = firstDefined(update, "rawInput", "raw_input", "input");
    const input = nextInput !== undefined ? nextInput : previous?.input;
    const status = stringField(update, "status") ?? previous?.status;
    const state: ToolState = {
      name,
      ...(status ? { status } : {}),
      callEmitted: previous?.callEmitted ?? false,
      resultEmitted: previous?.resultEmitted ?? false,
    };
    tools.set(callId, state);

    const events: TranscriptProjectedEvent[] = [];
    if (!state.callEmitted) {
      events.push({
        kind: "tool_call",
        ts,
        callId,
        name: state.name,
        ...(input !== undefined ? { input } : {}),
      });
      state.callEmitted = true;
    }

    const terminal = isTerminalToolStatus(state.status);
    const hasOutput = hasField(update, "rawOutput", "raw_output", "output", "result");
    const outputValue = hasOutput ? toolOutput(update) : terminal ? update.content : undefined;
    if (!state.resultEmitted && (hasOutput || terminal)) {
      const output = printableOutput(outputValue);
      events.push({
        kind: "tool_result",
        ts,
        callId,
        name: state.name,
        isError: isErrorToolStatus(state.status) || update.isError === true || update.is_error === true,
        ...(output !== undefined ? { output } : {}),
      });
      state.resultEmitted = true;
    }
    return events;
  }

  function projectUpdate(row: JsonObject): TranscriptProjectedEvent[] {
    const { params, update } = updatePayload(row);
    if (!update) return [];
    const kind = sessionUpdateKind(update);
    const ts = isoTimestamp(update, params, row);
    const text = textContent(update.content) ?? textContent(update.text);

    if (kind === "auto_compact_completed") {
      const tokensBefore = finiteNumberField(update, "tokens_before", "tokensBefore");
      const tokensAfter = finiteNumberField(update, "tokens_after", "tokensAfter");
      const meta = asObject(params?._meta);
      const eventId = stringField(update, "eventId", "event_id")
        ?? (meta ? stringField(meta, "eventId", "event_id") : undefined);
      const compactionKey = eventId ?? `${ts ?? "none"}:${tokensBefore ?? "?"}:${tokensAfter ?? "?"}`;
      if (seenCompactions.has(compactionKey)) return [];
      seenCompactions.add(compactionKey);
      const events = flushOpenChunk();
      events.push({
        kind: "compaction",
        ts,
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {}),
      });
      return events;
    }

    if (kind === "agent_message_chunk") {
      pendingPromptMirror = undefined;
      return text !== undefined ? appendMessageChunk("assistant", text, ts) : [];
    }
    if (kind === "user_message_chunk") {
      const projectedText = text !== undefined ? withoutPromptMirror(text) : undefined;
      return projectedText !== undefined ? appendMessageChunk("user", projectedText, ts) : [];
    }
    if (kind === "agent_thought_chunk") {
      pendingPromptMirror = undefined;
      const redacted = isRedactedThinking(update);
      return redacted || text !== undefined ? appendThinkingChunk(text, redacted, ts) : [];
    }

    if (kind && TURN_END_UPDATE_KINDS.has(kind)) {
      pendingPromptMirror = undefined;
      const events = flushOpenChunk();
      // turn_completed carries the turn's billed usage (the per-call
      // response_completed rows are its components and are not projected).
      const usage = turnUsageFrom(asObject(update.usage));
      if (usage) {
        const promptId = stringField(update, "prompt_id", "promptId");
        const model = dominantModel(asObject(asObject(update.usage)?.modelUsage));
        events.push({
          kind: "token_usage",
          ts,
          usage: usage,
          scope: "turn",
          ...(promptId ? { providerTurnId: promptId } : {}),
          ...(model ? { model } : {}),
        });
      }
      events.push({ kind: "turn_end", ts });
      return events;
    }

    if ((kind === "agent_message" || kind === "user_message") && text != null && text.trim().length > 0) {
      const projectedText = kind === "user_message" ? withoutPromptMirror(text) : text;
      if (kind === "agent_message") pendingPromptMirror = undefined;
      if (projectedText === undefined) return [];
      const events = flushOpenChunk();
      events.push({
        kind: "message",
        ts,
        role: kind === "agent_message" ? "assistant" : "user",
        text: projectedText,
      });
      return events;
    }
    if (kind === "agent_thought") {
      pendingPromptMirror = undefined;
      const events = flushOpenChunk();
      const redacted = isRedactedThinking(update);
      if (redacted) events.push({ kind: "thinking", ts, redacted: true });
      else if (text != null && text.trim().length > 0) {
        events.push({ kind: "thinking", ts, redacted: false, text });
      }
      return events;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      pendingPromptMirror = undefined;
      const events = flushOpenChunk();
      events.push(...projectTool(update, ts));
      return events;
    }
    // available_commands_update, plan, session_info_update, … — not boundaries.
    return [];
  }

  function projectNativeRow(row: JsonObject): TranscriptProjectedEvent[] {
    const events = flushOpenChunk();
    if (row.synthetic_reason != null) return events;
    const message = asObject(row.message);
    const roleValue = typeof message?.role === "string" ? message.role : row.type;
    const role = roleValue === "user" || roleValue === "assistant" ? roleValue : undefined;
    const text = textContent(message?.content ?? row.content);
    if (!role || text == null || text.trim().length === 0) return events;
    if (role === "user" && isGrokCompactionSummary(text)) {
      events.push({ kind: "compaction", ts: isoTimestamp(row, message) });
      return events;
    }
    const providerEventId = stringField(row, "id", "uuid", "messageId", "message_id");
    events.push({
      kind: "message",
      ts: isoTimestamp(row, message),
      role,
      text,
      ...(providerEventId ? { providerEventId } : {}),
    });
    return events;
  }

  return {
    harness: "grok",
    checkpoint() {
      return projectorCheckpoint("grok", {
        openChunk: openChunk ?? null,
        pendingPromptMirror: pendingPromptMirror ?? null,
        tools: [...tools],
        seenCompactions: [...seenCompactions],
      } satisfies GrokCheckpointState);
    },

    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = parseJsonLine(line);
      if (!row) return [];
      const method = typeof row.method === "string" ? row.method : undefined;
      if (!method) return projectNativeRow(row);
      if (UPDATE_METHODS.has(method)) return projectUpdate(row);
      if (method === "session/prompt") {
        const events = flushOpenChunk();
        const params = asObject(row.params);
        const ts = isoTimestamp(params, row);
        events.push({ kind: "turn_start", ts });
        const text = promptText(params);
        if (text !== undefined) {
          pendingPromptMirror = text;
          events.push({ kind: "message", ts, role: "user", text });
        }
        return events;
      }
      if (TURN_END_METHODS.has(method)) {
        pendingPromptMirror = undefined;
        const events = flushOpenChunk();
        events.push({ kind: "turn_end", ts: isoTimestamp(asObject(row.params), row) });
        return events;
      }
      // Client requests (fs/read_text_file, permissions, initialize, …) sit
      // between message chunks and must not fragment the open assistant turn.
      return [];
    },
    flush(): TranscriptProjectedEvent[] {
      return flushOpenChunk();
    },
  };
}
// checkpoint-digest:end

export const grokTranscripts: TranscriptFamily = {
  harness: "grok",
  createProjector: () => createGrokProjector(),
  restoreProjector: (state) => isGrokCheckpointState(state) ? createGrokProjector(state) : undefined,
};
