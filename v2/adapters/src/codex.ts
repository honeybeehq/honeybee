import { codexQuotaBoundary } from "./quota.ts";
/**
 * Codex harness adapter (WP3) — normalizes the `codex app-server` JSON-RPC 2.0
 * stdio stream.
 *
 * Format derived by reading the previous system's adapter
 * (src/hsr/adapters/codex.ts + codexRpc.ts, protocol names taken there
 * verbatim from the generated app-server bindings, codex-cli 0.142.5). No old
 * code is imported; re-verify against a real app-server in the manual smoke.
 *
 * Unlike claude, codex is a bidirectional RPC peer, but every message is still
 * one JSON line on stdout/stdin — so it fits the driver's line-stream model
 * with the handshake expressed as pure `respond` signals:
 *
 *   we write : {"jsonrpc":"2.0","id":1,"method":"initialize",...}   (bootLines)
 *   server   : {"jsonrpc":"2.0","id":1,"result":{...}}              → respond:
 *   we write :   {"jsonrpc":"2.0","method":"initialized"} +
 *                {"jsonrpc":"2.0","id":2,"method":"thread/start",
 *                 params:{cwd,approvalPolicy:"never",sandbox:"danger-full-access"[,model]}}
 *   server   : {"jsonrpc":"2.0","id":2,"result":{"thread":{"id":...}}} → booted
 *   server   : {"method":"turn/started",...}                        → turn_started
 *   server   : {"method":"turn/completed",...}                      → turn_ended (only status=completed clears flags)
 *   server   : {"method":"error","params":{"error":{"message"}}}    → flag evidence
 *   server   : {"method":"account/rateLimits/updated",
 *               "params":{"rateLimits":{rateLimitReachedType,...}}} → resource_blocked
 *
 * Quota boundary (captured on Codex 0.154, CO.c614): rateLimitReachedType
 * can be null even when error.codexErrorInfo is usageLimitExceeded. Consume
 * the error notification and turn.error; never treat turn/completed alone
 * as successful recovery. The daemon uses resource_blocked evidence for
 * both the bee flag and account exhaustion/rotation policy.
 *
 * Known sharp edge (old code, codex-cli 0.144.x): the app-server acks
 * `initialize` before it can service `thread/start`; a premature thread
 * request can be silently dropped, wedging the connection. WP3 keeps the
 * simple ack-ordered handshake (thread/start is only sent after the
 * initialize RESPONSE arrives, which is later than the old code's failing
 * pipeline) and leaves boot-timeout recovery to the daemon's hang policy —
 * a wedged boot is stopped and retried. Flagged for the manual smoke.
 *
 * The adapter is a factory: thread/start needs cwd (and optionally model),
 * which is per-bee configuration, not state. The returned object is still
 * pure/stateless — signals derive only from the input line.
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
import { asObject, epochMsFromSeconds, nonEmptyString, toNumber as finiteNumber } from "./types.ts";
import { quotaSourceId } from "./quota.ts";
import {
  projectorCheckpoint, checkpointRecord, checkpointEntries, checkpointJson,
  checkpointNullable, checkpointString, checkpointStrings, checkpointBoolean,
  type TranscriptFamily, type TranscriptFileChange, type TranscriptIsoTs, type TranscriptMessageRole,
  type TranscriptProjectedEvent, type TranscriptProjector, type TranscriptTokenUsage,
} from "./transcript.ts";
import {
  contextBaselineObservation,
  contextSnapshotInvalidationMetadata,
  contextSnapshotMetadata,
  contextTextSources,
  recordedInstructionMetadata,
  type ContextBaselineObservation,
  type ContextInventory,
  type ContextSourceSize,
} from "./transcript-context.ts";

const INITIALIZE_ID = 1;
const THREAD_START_ID = 2;
/** v6 `turn/interrupt` request id (one interrupt in flight per turn; the ack response parses to []). */
const TURN_INTERRUPT_ID = 3;
/** Delivered-message request ids: offset by the mailbox message id (globally unique). */
const TURN_REQUEST_ID_BASE = 1000;

export interface CodexAdapterOptions {
  cwd: string;
  model?: string;
  /** Preserve the native source provider for deterministic thread operations. */
  modelProvider?: string;
  /**
   * Harness-native resume (spec 07 §F): when set, the handshake sends
   * `thread/resume {threadId}` instead of `thread/start`, rejoining the
   * recorded conversation (codex has no interactive/headless store split —
   * `codex resume <threadId>` and app-server `thread/resume` share rollouts).
   * The response carries the same `thread.id`, which lands as `booted`. The
   * process must run with the CODEX_HOME the rollout lives under (bee env).
   */
  resumeThreadId?: string;
  /** Honeybee-owned deterministic native fork rollout. */
  resumePath?: string;
  /**
   * v6 fork (`bee.fork`): when set (and no resumeThreadId), the handshake
   * sends `thread/fork {threadId}` — the app-server copies the source rollout
   * into a NEW thread (present in codex-cli ≥ 0.147: `thread/fork` /
   * ThreadForkParams / ThreadForkResponse{thread}) — and the response's
   * `thread.id` (the NEW id) lands as `booted`, so the daemon records the
   * fork's own thread id. Plain `thread/resume` of the source id would make
   * source and fork share one thread. An app-server without `thread/fork`
   * answers method-not-found: no booted; the daemon's boot-hang policy
   * stops it and the spawn budget makes the failure visible.
   */
  forkThreadId?: string;
  /**
   * Codex app-server `thread/start` and `thread/resume` (codex-cli ≥ 0.153.4)
   * accept `developerInstructions`. Honeybee uses this for Cell→checkout
   * placement context. Callers must compose overlays with
   * `composeDeveloperInstructions` so existing custom instructions survive.
   */
  developerInstructions?: string | null;
}

/**
 * `AccountRateLimitsUpdatedNotification.rateLimits` (a RateLimitSnapshot):
 * `rateLimitReachedType` non-null is the authoritative exhausted gate; null is
 * a benign rolling update (old bindings, codex app-server v2). The reset hint
 * comes from the primary window's `resetsAt` (unix seconds), falling back to
 * secondary.
 */
export function codexRateLimitSignals(rateLimits: unknown): AdapterSignal[] {
  const snapshot = asObject(rateLimits);
  if (!snapshot) return [];
  const quota = codexQuotaBoundary({ method: "account/rateLimits/updated", params: { rateLimits: snapshot } });
  const reached = snapshot.rateLimitReachedType;
  if (reached === null || reached === undefined) return [];
  const resetsAt = quota?.resetsAt
    ?? epochMsFromSeconds(asObject(snapshot.primary)?.resetsAt)
    ?? epochMsFromSeconds(asObject(snapshot.secondary)?.resetsAt);
  const reset = resetsAt !== undefined ? new Date(resetsAt).toISOString() : undefined;
  return [{
    kind: "flag",
    flag: "resource_blocked",
    action: "set",
    detail: `codex rate limit reached (${String(reached)})${reset ? `, resets ${reset}` : ""}`,
    ...(quota ? { quota } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }];
}

function errorSignals(message: string, codexErrorInfo?: unknown): AdapterSignal[] {
  // Prefer the native discriminant: provider wording is not a protocol.
  // Keep a recognizable cause in detail for the daemon's exhaustion policy.
  const quota = codexQuotaBoundary({ method: "error", params: { error: { message, codexErrorInfo } } });
  if (quota) {
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: (quota.providerCategory === "text_fallback" ? message : `codex usage limit exceeded: ${message}`).slice(0, 500), quota }];
  }
  if (isAuthNeededMessage(message)) {
    return [{ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) }];
  }
  if (isResourceBlockedMessage(message) || /usage limit/i.test(message)) {
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) }];
  }
  return [];
}

// Server→client request methods that expect a response; with
// approvalPolicy:"never" these should not fire, but a hanging server request
// wedges the peer, so refuse them explicitly (JSON-RPC method-not-found).
const SERVER_REQUEST_REFUSAL_CODE = -32601;

/** The thread request params (shape taken from the old adapter's buildCodexThreadRequestParams). */
export function codexThreadRequest(opts: CodexAdapterOptions): { method: "thread/start" | "thread/resume" | "thread/fork"; params: Record<string, unknown> } {
  const developerInstructions = opts.developerInstructions?.trim() ? opts.developerInstructions : undefined;
  const base = {
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.modelProvider ? { modelProvider: opts.modelProvider } : {}),
    cwd: opts.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(developerInstructions ? { developerInstructions } : {}),
  };
  // Codex keeps turn history in the rollout; readiness only needs thread metadata.
  if (opts.resumeThreadId) return { method: "thread/resume", params: { threadId: opts.resumeThreadId, ...(opts.resumePath ? { path: opts.resumePath } : {}), ...base, excludeTurns: true } };
  if (opts.forkThreadId) return { method: "thread/fork", params: { threadId: opts.forkThreadId, ...base } };
  return { method: "thread/start", params: base };
}

export function codexAdapter(opts: CodexAdapterOptions): HarnessAdapter {
  const threadRequest = codexThreadRequest(opts);
  const threadStartLine = JSON.stringify({
    jsonrpc: "2.0",
    id: THREAD_START_ID,
    method: threadRequest.method,
    params: threadRequest.params,
  });

  function parseLine(line: string): AdapterSignal[] {
    const msg = parseJsonLine(line);
    if (!msg) return [];
    if (typeof msg.id === "string" && /^hive-reconnect-(?:tools-[1-9][0-9]*|config-[1-9][0-9]*-[A-Za-z0-9_-]+)$/.test(msg.id)) {
      if (msg.error) return [{ kind: "tools_control_result", requestId: msg.id, error: "Codex rejected MCP control request" }];
      if (Object.prototype.hasOwnProperty.call(msg, "result")) return [{ kind: "tools_control_result", requestId: msg.id }];
      return [];
    }

    // A `method` marks a notification or a server→client request; a message
    // without one is a response to something we sent. Classify method-bearing
    // messages first so a server request can never be misread as our response.
    if (typeof msg.method === "string") return methodSignals(msg);

    // --- responses to our requests -------------------------------------
    if (msg.id === INITIALIZE_ID && "result" in msg) {
      return [{
        kind: "respond",
        bootstrap: true,
        lines: [JSON.stringify({ jsonrpc: "2.0", method: "initialized" }), threadStartLine],
      }];
    }
    if (msg.id === THREAD_START_ID) {
      const threadId = asObject(asObject(msg.result)?.thread)?.id;
      if (typeof threadId === "string" && threadId.length > 0) {
        // codex boots to ready-for-input: booted lands on idle (types.ts).
        return bootedToIdle(threadId);
      }
      if ("result" in msg && opts.resumeThreadId) {
        // thread/resume acknowledged without echoing the thread: the old
        // adapter fell back to the requested id (threadIdFromResponse ?? sessionId).
        return bootedToIdle(opts.resumeThreadId);
      }
      const err = asObject(msg.error);
      if (err) return errorSignals(String(err.message ?? `codex ${threadRequest.method} failed`));
      return [];
    }
    // A delivered-message request response (turn/start or turn/steer). The
    // JSON-RPC acknowledgement is the application-level accept point: socket
    // write alone cannot prove a stale expectedTurnId was accepted.
    if (typeof msg.id === "number" && msg.id >= TURN_REQUEST_ID_BASE) {
      const messageId = msg.id - TURN_REQUEST_ID_BASE;
      if (!Number.isSafeInteger(messageId) || messageId < 0) return [];
      if ("error" in msg) {
        const err = asObject(msg.error);
        return [
          { kind: "delivery_refused", messageId },
          ...errorSignals(String(err?.message ?? "codex turn delivery failed")),
        ];
      }
      if ("result" in msg) return [{ kind: "delivery_confirmed", messageId }];
    }
    return [];
  }

  function methodSignals(msg: Record<string, unknown>): AdapterSignal[] {
    const params = asObject(msg.params) ?? {};
    const threadId = typeof params.threadId === "string" && params.threadId.length > 0
      ? params.threadId
      : undefined;

    // A server REQUEST (has an id): refuse rather than leave the peer hanging.
    if (msg.id !== undefined && msg.id !== null) {
      return [{
        kind: "respond",
        lines: [JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: SERVER_REQUEST_REFUSAL_CODE, message: `unsupported server request: ${String(msg.method)}` },
        })],
      }];
    }

    switch (msg.method) {
      case "turn/started": {
        // `turn.id` is what turn/interrupt needs (v6 bee.interrupt).
        const turnId = asObject(params.turn)?.id;
        return [{
          kind: "turn_started",
          ...(typeof turnId === "string" && turnId.length > 0 ? { turnId } : {}),
          ...(threadId ? { threadId } : {}),
        }];
      }
      case "turn/completed": {
        const turn = asObject(params.turn);
        const err = asObject(turn?.error);
        // Completion is a lifecycle edge, not proof that the provider served
        // the turn. Failed/interrupted/unknown outcomes preserve boundaries.
        const evidence = err
          ? errorSignals(String(err.message ?? "codex turn failed"), err.codexErrorInfo)
          : turn?.status === "completed" ? successfulTurnClears() : [];
        return [...evidence, { kind: "turn_ended", ...(threadId ? { threadId } : {}) }];
      }
      case "error": {
        const err = asObject(params.error);
        return errorSignals(String(err?.message ?? params.message ?? "codex error"), err?.codexErrorInfo);
      }
      case "account/rateLimits/updated":
        return codexRateLimitSignals(params.rateLimits);
      default:
        // item/agentMessage/delta, item/reasoning/*, thread/tokenUsage/updated,
        // … — mid-turn activity/usage, no state edge in the four-state model.
        return [];
    }
  }

  return {
    harness: "codex",
    // Codex has a native active-turn accept point: turn/steer with the exact
    // turn id reported by turn/started.
    acceptsMidTurn: true,
    midTurnMessageNeedsTurnId: true,
    confirmsDelivery: true,
    carriesDeliveryId: true,
    readyAtSpawn: false,
    recoveryProbe(requestId): string {
      return JSON.stringify({jsonrpc: "2.0", id: `${requestId}:list`, method: "thread/loaded/list", params: {}});
    },
    parseRecovery(line, requestId, sessionId) {
      const msg = parseJsonLine(line);
      if (!msg || typeof msg.id !== "string" || !msg.id.startsWith(`${requestId}:`) || "method" in msg) return null;
      if (msg.error || !("result" in msg)) return {kind: "refused"};
      const result = asObject(msg.result);
      if (msg.id === `${requestId}:list`) {
        const ids = result?.data;
        if (!Array.isArray(ids) || result?.nextCursor != null || ids.some(id => typeof id !== "string" || !id) || ids.length > 1) return {kind: "refused"};
        if (ids.length === 0) {
          if (sessionId || opts.resumeThreadId || opts.forkThreadId) return {kind: "refused"};
          return {kind: "start", lines: [JSON.stringify({jsonrpc: "2.0", method: "initialized"}), JSON.stringify({jsonrpc: "2.0", id: `${requestId}:start`, method: threadRequest.method, params: threadRequest.params})]};
        }
        if (sessionId && sessionId !== ids[0]) return {kind: "refused"};
        return {kind: "query", line: JSON.stringify({jsonrpc: "2.0", id: `${requestId}:read:${ids[0]}`, method: "thread/read", params: {threadId: ids[0], includeTurns: false}})};
      }
      const thread = asObject(result?.thread);
      const id = thread?.id;
      const expected = msg.id.startsWith(`${requestId}:read:`) ? msg.id.slice(`${requestId}:read:`.length) : null;
      if (typeof id !== "string" || !id || (expected && id !== expected) || (sessionId && id !== sessionId)) return {kind: "refused"};
      if (msg.id !== `${requestId}:start` && !expected) return {kind: "refused"};
      const status = asObject(thread?.status)?.type;
      if (status !== "idle" && status !== "active") return {kind: "refused"};
      const activeTurn = Array.isArray(thread?.turns) ? thread.turns.map(asObject).find(turn => turn?.status === "inProgress") : null;
      return {kind: "ready", sessionId: id, state: status === "idle" ? "idle" : "running", ...(typeof activeTurn?.id === "string" ? {turnId: activeTurn.id} : {}), synthetic: false, ...(typeof thread?.cwd === "string" ? {threadCwd: thread.cwd} : {}), adapterCwd: opts.cwd};
    },
    bootLines(): string[] {
      return [JSON.stringify({
        jsonrpc: "2.0",
        id: INITIALIZE_ID,
        method: "initialize",
        params: { clientInfo: { name: "hive-hsr", title: null, version: "0" }, capabilities: null },
      })];
    },
    parseLine,
    encodeReconnectToolsNonce(commandId: number, gateway: string, nonce: string): string {
      // Restricted to the Honeybee-owned marker on a validated gateway name.
      return JSON.stringify({ jsonrpc: "2.0", id: `hive-reconnect-config-${commandId}-${gateway}`, method: "config/value/write", params: {
        keyPath: `mcp_servers.${gateway}.env.HONEYBEE_MCP_RECONNECT_NONCE`, value: nonce, mergeStrategy: "replace",
      } });
    },
    encodeReconnectTools(commandId: number): string {
      return JSON.stringify({ jsonrpc: "2.0", id: `hive-reconnect-tools-${commandId}`, method: "config/mcpServer/reload" });
    },
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      if (ctx.freshTurn && ctx.turnActive) return null;
      if (!ctx.sessionId) return null; // thread id not learned yet → not_ready
      if (ctx.turnActive && !ctx.turnId) return null; // cannot safely steer without the native precondition
      return JSON.stringify({
        jsonrpc: "2.0",
        id: TURN_REQUEST_ID_BASE + ctx.messageId,
        method: ctx.turnActive ? "turn/steer" : "turn/start",
        params: {
          threadId: ctx.sessionId,
          ...(ctx.deliveryId ? { clientUserMessageId: ctx.deliveryId } : {}),
          input: [{ type: "text", text: body, text_elements: [] }],
          ...(ctx.turnActive ? { expectedTurnId: ctx.turnId } : {}),
        },
      });
    },
    // v6 interrupt: `turn/interrupt {threadId, turnId}` (the OLD adapter's
    // verified call, src/hsr/adapters/codex.ts). Needs the turn id from
    // turn/started; before that there is nothing to interrupt yet.
    deliveryResponseMarker(messageId: number): string {
      return String(TURN_REQUEST_ID_BASE + messageId);
    },
    encodeInterrupt(ctx: InterruptContext): string | null {
      if (!ctx.sessionId || !ctx.turnId) return null;
      return JSON.stringify({
        jsonrpc: "2.0",
        id: TURN_INTERRUPT_ID,
        method: "turn/interrupt",
        params: { threadId: ctx.sessionId, turnId: ctx.turnId },
      });
    },
  };
}

type JsonObject = Record<string, unknown>;

function idString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isoFrom(value: unknown): TranscriptIsoTs {
  let ms: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    ms = value;
  } else if (typeof value === "string" && value.trim().length > 0) {
    const numeric = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : Number.NaN;
    ms = Number.isFinite(numeric) ? numeric : Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function firstIso(...values: unknown[]): TranscriptIsoTs {
  for (const value of values) {
    const iso = isoFrom(value);
    if (iso != null) return iso;
  }
  return null;
}

/** Thread snapshots use epoch seconds while live notifications use `*AtMs`. */
function snapshotIso(value: unknown): TranscriptIsoTs {
  const numeric = finiteNumber(value);
  if (numeric !== undefined && Math.abs(numeric) < 100_000_000_000) {
    return isoFrom(numeric * 1_000);
  }
  return isoFrom(value);
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return nonEmptyString(content);
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const value of content) {
    if (typeof value === "string") {
      const text = nonEmptyString(value);
      if (text) texts.push(text);
      continue;
    }
    const block = asObject(value);
    if (!block) continue;
    if (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text" && block.type !== "summary_text") {
      continue;
    }
    const text = nonEmptyString(block.text);
    if (text) texts.push(text);
  }
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function serialized(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageIdentity(role: "user" | "assistant", text: string): string {
  return `${role}:${text.trim().replace(/\s+/g, " ")}`;
}

function fileChanges(item: JsonObject): TranscriptFileChange[] {
  if (!Array.isArray(item.changes)) return [];
  const files: TranscriptFileChange[] = [];
  for (const value of item.changes) {
    const change = asObject(value);
    if (!change) continue;
    const path = nonEmptyString(change.path);
    if (!path) continue;
    const kind = asObject(change.kind);
    const changeKind = nonEmptyString(kind?.type) ?? nonEmptyString(change.kind);
    const move = asObject(change.move);
    const oldPath = nonEmptyString(change.oldPath)
      ?? nonEmptyString(change.move)
      ?? nonEmptyString(move?.path)
      ?? nonEmptyString(move?.from)
      ?? nonEmptyString(move?.to)
      ?? nonEmptyString(move?.toPath);
    files.push({
      path,
      ...(changeKind ? { changeKind } : {}),
      ...(typeof change.diff === "string" ? { diff: change.diff } : {}),
      ...(oldPath ? { oldPath } : {}),
      ...(finiteNumber(change.addedLines) !== undefined ? { addedLines: finiteNumber(change.addedLines) } : {}),
      ...(finiteNumber(change.removedLines) !== undefined ? { removedLines: finiteNumber(change.removedLines) } : {}),
    });
  }
  return files;
}

function mergeItems(started: JsonObject | undefined, completed: JsonObject): JsonObject {
  if (!started) return completed;
  const merged: JsonObject = { ...started, ...completed };
  const startedInvocation = asObject(started.invocation);
  const completedInvocation = asObject(completed.invocation);
  if (startedInvocation || completedInvocation) {
    merged.invocation = { ...startedInvocation, ...completedInvocation };
  }
  return merged;
}

function mcpName(item: JsonObject): string {
  const invocation = asObject(item.invocation);
  return nonEmptyString(item.name)
    ?? nonEmptyString(item.tool)
    ?? nonEmptyString(invocation?.tool)
    ?? nonEmptyString(invocation?.name)
    ?? "mcp";
}

function mcpInput(item: JsonObject): unknown {
  const invocation = asObject(item.invocation);
  return item.arguments ?? item.input ?? invocation?.arguments ?? invocation?.input;
}

function mcpOutput(item: JsonObject): string | undefined {
  const error = asObject(item.error);
  return serialized(item.result ?? item.output ?? item.content ?? error?.message ?? item.error);
}

function itemCallId(item: JsonObject, nativeType: string): string {
  return idString(item.id) ?? idString(item.callId) ?? `codex:${nativeType}:unknown`;
}

function withThreadId(events: TranscriptProjectedEvent[], threadId: string | undefined): TranscriptProjectedEvent[] {
  return threadId ? events.map((event) => ({ ...event, threadId })) : events;
}

function tokenUsageFrom(source: JsonObject | null | undefined): TranscriptTokenUsage | undefined {
  if (!source) return undefined;
  const container = asObject(source.usage)
    ?? asObject(source.tokenUsage)
    ?? asObject(source.tokens)
    ?? asObject(source.total_token_usage)
    ?? asObject(source.last_token_usage)
    ?? source;
  // The app-server `thread/tokenUsage/updated` shape nests the thread total
  // under `total` (with `last` = the latest turn); the rollout shape is flat.
  const raw = asObject(container.total) ?? container;
  const inputInclusive = finiteNumber(raw.input ?? raw.input_tokens ?? raw.inputTokens);
  const cacheRead = finiteNumber(
    raw.cacheRead ?? raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.cache_read,
  );
  // OpenAI counts cached reads INSIDE input_tokens; the projection's `input`
  // is uncached input everywhere, so subtract.
  const input =
    inputInclusive !== undefined && cacheRead !== undefined
      ? Math.max(0, inputInclusive - cacheRead)
      : inputInclusive;
  const output = finiteNumber(raw.output ?? raw.output_tokens ?? raw.outputTokens);
  const cacheWrite = finiteNumber(raw.cacheWrite ?? raw.cache_write ?? raw.cacheWriteInputTokens);
  const reasoning = finiteNumber(
    raw.reasoning ?? raw.reasoning_output_tokens ?? raw.reasoningOutputTokens,
  );
  const total = finiteNumber(
    typeof raw.total === "number" ? raw.total : raw.total_tokens ?? raw.totalTokens,
  );
  const usage: TranscriptTokenUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function messageRole(item: JsonObject, fallback: TranscriptMessageRole): TranscriptMessageRole {
  const role = item.role;
  if (role === "user" || role === "assistant" || role === "system" || role === "developer") return role;
  return fallback;
}

function completedItemEvent(
  item: JsonObject,
  ts: TranscriptIsoTs,
  startSeen: boolean,
): TranscriptProjectedEvent[] {
  const nativeType = nonEmptyString(item.type);
  if (!nativeType) return [];
  const itemId = idString(item.id);
  switch (nativeType) {
    case "agentMessage": {
      const text = nonEmptyString(item.text);
      return text
        ? [{
          kind: "message",
          ts,
          role: messageRole(item, "assistant"),
          text,
          ...(itemId ? { providerEventId: itemId } : {}),
        }]
        : [];
    }
    case "userMessage": {
      const text = textFromContent(item.content) ?? nonEmptyString(item.text);
      const deliveryId = nonEmptyString(item.clientId);
      return text
        ? [{
          kind: "message",
          ts,
          role: messageRole(item, "user"),
          text,
          ...(itemId ? { providerEventId: itemId } : {}),
          ...(deliveryId ? { deliveryId } : {}),
        }]
        : [];
    }
    case "commandExecution":
      return [{
        kind: "shell",
        ts,
        callId: itemCallId(item, nativeType),
        ...(nonEmptyString(item.command) ? { command: nonEmptyString(item.command) } : {}),
        ...(nonEmptyString(item.cwd) ? { cwd: nonEmptyString(item.cwd) } : {}),
        ...(typeof item.aggregatedOutput === "string" ? { stdout: item.aggregatedOutput } : {}),
        ...(typeof item.stderr === "string" ? { stderr: item.stderr } : {}),
        ...(finiteNumber(item.exitCode) !== undefined ? { exitCode: finiteNumber(item.exitCode) } : {}),
        ...(finiteNumber(item.durationMs) !== undefined ? { durationMs: finiteNumber(item.durationMs) } : {}),
        status: "completed",
      }];
    case "mcpToolCall": {
      const status = nonEmptyString(item.status);
      const isError = item.error != null || status === "failed" || status === "error";
      const output = mcpOutput(item);
      const callId = itemCallId(item, nativeType);
      const result: TranscriptProjectedEvent = {
        kind: "tool_result",
        ts,
        callId,
        isError,
        ...(output !== undefined ? { output } : {}),
      };
      // History windows can start at a completed item with no matching
      // item/started. The pane cannot pair an orphan result — emit the call
      // from the merged completed item in that case.
      if (startSeen) return [result];
      const input = mcpInput(item);
      return [
        {
          kind: "tool_call",
          ts,
          callId,
          name: mcpName(item),
          ...(input !== undefined ? { input } : {}),
        },
        result,
      ];
    }
    case "reasoning": {
      const text = textFromContent(item.summary) ?? nonEmptyString(item.summary);
      return text
        ? [{ kind: "thinking", ts, redacted: false, text }]
        : [{ kind: "thinking", ts, redacted: true }];
    }
    case "fileChange":
      return [{ kind: "file_edit", ts, ...(itemId ? { callId: itemId } : {}), files: fileChanges(item) }];
    case "contextCompaction": {
      const trigger = nonEmptyString(item.trigger) ?? nonEmptyString(item.reason);
      return [{ kind: "compaction", ts, ...(trigger ? { trigger } : {}) }];
    }
    case "webSearch": {
      const action = asObject(item.action);
      const query = nonEmptyString(item.query) ?? nonEmptyString(action?.query);
      return [{
        kind: "web_search",
        ts,
        ...(itemId ? { itemId, providerEventId: itemId } : {}),
        ...(query ? { query } : {}),
      }];
    }
    default:
      return [{ kind: "unknown", ts, nativeType }];
  }
}

/**
 * A successful `thread/fork` response is the forked bee's only authoritative
 * copy of the turns inherited before its fresh session log began. Project the
 * response snapshot once; later live notifications append the child's turns.
 */
function forkSnapshotEvents(result: JsonObject): TranscriptProjectedEvent[] {
  const thread = asObject(result.thread);
  if (!thread || !Array.isArray(thread.turns)) return [];
  const threadId = idString(thread.id) ?? idString(thread.threadId);
  const events: TranscriptProjectedEvent[] = [];
  for (const value of thread.turns) {
    const turn = asObject(value);
    if (!turn) continue;
    const turnId = idString(turn.id);
    const startedAt = snapshotIso(turn.startedAt ?? turn.startedAtMs);
    const completedAt = snapshotIso(turn.completedAt ?? turn.completedAtMs);
    events.push({
      kind: "turn_start",
      ts: startedAt,
      ...(turnId ? { turnId } : {}),
      ...(threadId ? { threadId } : {}),
    });
    if (Array.isArray(turn.items)) {
      for (const itemValue of turn.items) {
        const item = asObject(itemValue);
        if (!item) continue;
        const itemTs = firstIso(item.completedAtMs, item.startedAtMs) ?? completedAt ?? startedAt;
        events.push(...withThreadId(completedItemEvent(item, itemTs, false), threadId));
      }
    }
    const durationMs = finiteNumber(turn.durationMs);
    const finishReason = nonEmptyString(turn.status);
    events.push({
      kind: "turn_end",
      ts: completedAt,
      ...(turnId ? { turnId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(finishReason === "interrupted" ? { interrupted: true } : {}),
    });
  }
  return events;
}

// checkpoint-digest:start
interface CodexCheckpointState {
  startedItems: Array<[string, JsonObject]>;
  currentModel: string | null;
  rolloutMessages: string[];
  forkRequestIds: string[];
  rolloutTurnOpen: boolean;
}

export function isCodexCheckpointState(value: unknown): value is CodexCheckpointState {
  return checkpointRecord(value, {
    startedItems: checkpointEntries((v) => v !== null && typeof v === "object" && !Array.isArray(v) && checkpointJson(v)),
    currentModel: checkpointNullable(checkpointString),
    rolloutMessages: checkpointStrings,
    forkRequestIds: checkpointStrings,
    rolloutTurnOpen: checkpointBoolean,
  });
}
/**
 * Stateful projection of Codex app-server session logs plus native rollout
 * rows. App-server request/notification envelopes are authoritative for HSR;
 * nested turn items are intentionally never replayed from turn/completed.
 */
export function createCodexProjector(restored?: CodexCheckpointState): TranscriptProjector {
  const startedItems = new Map<string, JsonObject>(restored?.startedItems);
  /** Model named on the client's thread/start or turn/start — usage attribution. */
  let currentModel: string | undefined = restored?.currentModel ?? undefined;
  const rolloutMessages = new Set<string>(restored?.rolloutMessages);
  const forkRequestIds = new Set<string>(restored?.forkRequestIds);
  let rolloutTurnOpen = restored?.rolloutTurnOpen ?? false;

  const emitRolloutMessage = (
    role: "user" | "assistant",
    text: string,
    ts: TranscriptIsoTs,
    itemId?: string,
  ): TranscriptProjectedEvent[] => {
    const identity = normalizeMessageIdentity(role, text);
    if (rolloutMessages.has(identity)) return [];
    rolloutMessages.add(identity);
    return [{ kind: "message", ts, role, text, ...(itemId ? { providerEventId: itemId } : {}) }];
  };

  const pushRollout = (row: JsonObject): TranscriptProjectedEvent[] => {
    const ts = firstIso(row.timestamp, row.emittedAtMs);
    if (row.type === "turn_context") {
      if (rolloutTurnOpen) return [];
      rolloutTurnOpen = true;
      rolloutMessages.clear();
      return [{ kind: "turn_start", ts }];
    }
    const payload = asObject(row.payload);
    if (!payload) return [];
    if (row.type === "event_msg") {
      switch (payload.type) {
        case "task_started":
          if (rolloutTurnOpen) return [];
          rolloutTurnOpen = true;
          rolloutMessages.clear();
          return [{ kind: "turn_start", ts }];
        case "task_complete": {
          rolloutTurnOpen = false;
          const turnId = idString(payload.turn_id) ?? idString(payload.turnId);
          return [{ kind: "turn_end", ts, ...(turnId ? { turnId } : {}) }];
        }
        case "agent_message": {
          const text = nonEmptyString(payload.message);
          return text ? emitRolloutMessage("assistant", text, ts, idString(payload.id)) : [];
        }
        case "user_message": {
          const text = nonEmptyString(payload.message);
          return text ? emitRolloutMessage("user", text, ts, idString(payload.id)) : [];
        }
        case "context_compacted":
          return [{ kind: "compaction", ts }];
        default:
          return [];
      }
    }
    if (row.type !== "response_item") return [];
    switch (payload.type) {
      case "message": {
        const role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : null;
        const text = textFromContent(payload.content);
        return role && text ? emitRolloutMessage(role, text, ts, idString(payload.id)) : [];
      }
      case "function_call":
      case "custom_tool_call": {
        const callId = idString(payload.call_id) ?? idString(payload.callId) ?? idString(payload.id);
        if (!callId) return [];
        return [{
          kind: "tool_call",
          ts,
          callId,
          name: nonEmptyString(payload.name) ?? "tool",
          ...((payload.arguments ?? payload.input) !== undefined ? { input: payload.arguments ?? payload.input } : {}),
        }];
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const callId = idString(payload.call_id) ?? idString(payload.callId) ?? idString(payload.id);
        if (!callId) return [];
        const output = serialized(payload.output);
        return [{ kind: "tool_result", ts, callId, isError: false, ...(output !== undefined ? { output } : {}) }];
      }
      case "reasoning": {
        const text = textFromContent(payload.summary) ?? nonEmptyString(payload.summary);
        return text ? [{ kind: "thinking", ts, redacted: false, text }] : [{ kind: "thinking", ts, redacted: true }];
      }
      default:
        return [];
    }
  };

  return {
    harness: "codex",
    checkpoint() {
      return projectorCheckpoint("codex", {
        startedItems: [...startedItems],
        currentModel: currentModel ?? null,
        rolloutMessages: [...rolloutMessages],
        forkRequestIds: [...forkRequestIds],
        rolloutTurnOpen: rolloutTurnOpen,
      } satisfies CodexCheckpointState);
    },

    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = parseJsonLine(line);
      if (!row) return [];
      const quota = codexQuotaBoundary(row);
      const quotaEvents: TranscriptProjectedEvent[] = quota
        ? [{ kind: "quota", ts: firstIso(row.emittedAtMs), quota, sourceId: quotaSourceId(line), raw: row, operational: true }]
        : [];
      if (quota && row.method !== "turn/completed") return withThreadId(quotaEvents, idString(asObject(row.params)?.threadId));
      const method = nonEmptyString(row.method);
      const requestId = idString(row.id);
      if (!method) {
        if (requestId && forkRequestIds.delete(requestId)) {
          const result = asObject(row.result);
          return result ? forkSnapshotEvents(result) : [];
        }
        return pushRollout(row);
      }
      if (method === "thread/fork" && requestId) forkRequestIds.add(requestId);
      const params = asObject(row.params) ?? {};
      if ((method === "thread/start" || method === "turn/start") && nonEmptyString(params.model)) {
        currentModel = nonEmptyString(params.model);
      }
      switch (method) {
        // Client request: no native turn id exists yet. Only turn/started is
        // the app-server's explicit turn boundary.
        case "turn/start":
          return [];
        case "turn/started": {
          const turn = asObject(params.turn);
          const turnId = idString(turn?.id);
          const threadId = idString(params.threadId);
          return [{
            kind: "turn_start",
            ts: firstIso(row.emittedAtMs),
            ...(turnId ? { turnId } : {}),
            ...(threadId ? { threadId } : {}),
          }];
        }
        case "turn/completed": {
          const turn = asObject(params.turn);
          const turnId = idString(turn?.id);
          const threadId = idString(params.threadId);
          const durationMs = finiteNumber(turn?.durationMs);
          const finishReason = nonEmptyString(turn?.status);
          const interrupted = turn?.status === "interrupted";
          const usage = tokenUsageFrom(turn);
          const ts = firstIso(row.emittedAtMs);
          const events: TranscriptProjectedEvent[] = [...withThreadId(quotaEvents, threadId), {
            kind: "turn_end",
            ts,
            ...(turnId ? { turnId } : {}),
            ...(threadId ? { threadId } : {}),
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(finishReason ? { finishReason } : {}),
            ...(interrupted ? { interrupted: true } : {}),
          }];
          if (usage) {
            events.push({
              kind: "token_usage",
              ts,
              usage,
              scope: "turn",
              ...(turnId ? { providerTurnId: turnId } : {}),
              ...(threadId ? { threadId } : {}),
              ...(currentModel ? { model: currentModel } : {}),
            });
          }
          return events;
        }
        case "turn/interrupt": {
          const threadId = idString(params.threadId);
          return [{
            kind: "interrupt",
            ts: firstIso(row.emittedAtMs),
            ...(nonEmptyString(params.reason) ? { reason: nonEmptyString(params.reason) } : {}),
            ...(threadId ? { threadId } : {}),
          }];
        }
        case "item/started": {
          const item = asObject(params.item);
          if (!item) return [];
          const itemId = idString(item.id);
          if (itemId) startedItems.set(itemId, item);
          const threadId = idString(params.threadId);
          const ts = firstIso(params.startedAtMs, row.emittedAtMs);
          if (item.type === "commandExecution") {
            return withThreadId([{
              kind: "shell",
              ts,
              callId: itemCallId(item, "commandExecution"),
              ...(nonEmptyString(item.command) ? { command: nonEmptyString(item.command) } : {}),
              ...(nonEmptyString(item.cwd) ? { cwd: nonEmptyString(item.cwd) } : {}),
              status: "started",
            }], threadId);
          }
          if (item.type === "mcpToolCall") {
            const input = mcpInput(item);
            return withThreadId([{
              kind: "tool_call",
              ts,
              callId: itemCallId(item, "mcpToolCall"),
              name: mcpName(item),
              ...(input !== undefined ? { input } : {}),
            }], threadId);
          }
          return [];
        }
        case "item/completed": {
          const completed = asObject(params.item);
          if (!completed) return [];
          const itemId = idString(completed.id);
          const startSeen = itemId != null && startedItems.has(itemId);
          const item = mergeItems(itemId ? startedItems.get(itemId) : undefined, completed);
          if (itemId) startedItems.delete(itemId);
          return withThreadId(
            completedItemEvent(item, firstIso(params.completedAtMs, row.emittedAtMs), startSeen),
            idString(params.threadId),
          );
        }
        case "thread/tokenUsage/updated": {
          const usage = tokenUsageFrom(params) ?? tokenUsageFrom(asObject(params.rateLimits) ?? params);
          if (!usage) return [];
          const threadId = idString(params.threadId);
          return [{
            kind: "token_usage",
            ts: firstIso(row.emittedAtMs),
            usage,
            scope: nonEmptyString(params.scope) ?? "cumulative",
            ...(threadId ? { threadId } : {}),
            ...(currentModel ? { model: currentModel } : {}),
          }];
        }
        default:
          // Deltas, usage/account notifications, and server protocol chatter
          // are not pane events. Lifecycle stays owned by the adapter/core.
          return [];
      }
    },
    flush(): TranscriptProjectedEvent[] {
      startedItems.clear();
      forkRequestIds.clear();
      return [];
    },
  };
}
// checkpoint-digest:end

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function preserveContextUsage(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  let contextInputTokens: number | undefined;
  let modelContextWindow: number | undefined;
  let contextTurnId: string | undefined;
  let contextFirstRequest: boolean | undefined;
  const params = asObject(row.params);
  if (row.method === "thread/tokenUsage/updated") contextTurnId = nonEmptyString(params?.turnId);
  const payload = asObject(row.payload);
  const usage = row.method === "thread/tokenUsage/updated" ? asObject(params?.tokenUsage)
    : row.type === "event_msg" && payload?.type === "token_count" ? asObject(payload.info) : null;
  const last = asObject(usage?.last) ?? asObject(usage?.last_token_usage);
  contextInputTokens = tokenCount(last?.inputTokens ?? last?.input_tokens);
  if (row.method === "thread/tokenUsage/updated" && contextInputTokens !== undefined && contextInputTokens > 0) {
    const total = asObject(usage?.total);
    const output = tokenCount(last?.outputTokens);
    contextFirstRequest = tokenCount(total?.inputTokens) === contextInputTokens && output !== undefined && tokenCount(total?.outputTokens) === output;
  }
  modelContextWindow = tokenCount(usage?.modelContextWindow ?? usage?.model_context_window);
  if (usage && !events.some((event) => event.kind === "token_usage")) {
    const total = asObject(usage.total_token_usage);
    const input = tokenCount(total?.input_tokens);
    const cacheRead = tokenCount(total?.cached_input_tokens);
    if (input !== undefined) events = [...events, {
      kind: "token_usage", ts: typeof row.timestamp === "string" ? row.timestamp : null,
      scope: "cumulative", usage: {
        input: Math.max(0, input - (cacheRead ?? 0)), cacheRead,
        output: tokenCount(total?.output_tokens), reasoning: tokenCount(total?.reasoning_output_tokens),
        total: tokenCount(total?.total_tokens),
      },
    }];
  }
  if (contextInputTokens === undefined) return events;
  return events.map((event) => event.kind === "token_usage" ? {
    ...event, contextInputTokens,
    ...(contextFirstRequest !== undefined ? { contextFirstRequest } : {}),
    ...(contextTurnId ? { contextTurnId } : {}),
    ...(modelContextWindow !== undefined && modelContextWindow > 0 ? { modelContextWindow } : {}),
  } : event);
}

function preserveMetadata(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  if (row.method === "item/completed") {
    const params = asObject(row.params);
    if (asObject(params?.item)?.type === "contextCompaction") {
      const contextSnapshotInvalidation = contextSnapshotInvalidationMetadata({
        version: 1, providerThreadId: params?.threadId, observedAt: params?.completedAtMs,
        reason: "uncaptured-compaction",
      });
      if (contextSnapshotInvalidation) events = events.map((event) => event.kind === "compaction"
        ? { ...event, contextSnapshotInvalidation } : event);
    }
  }
  if (row.method === "thread/contextSnapshot/updated") {
    const params = asObject(row.params);
    const contextSnapshot = contextSnapshotMetadata(params?.contextSnapshot, { allowUnboundOwner: true });
    if (!contextSnapshot || (typeof params?.threadId === "string" && params.threadId !== contextSnapshot.identity.providerThreadId)) return [];
    return [{ kind: "unknown", nativeType: "native_context_snapshot", ts: new Date(contextSnapshot.measuredAt).toISOString(),
      threadId: contextSnapshot.identity.providerThreadId, contextSnapshot }];
  }
  if (row.method === "thread/contextSnapshot/invalidated") {
    const params = asObject(row.params);
    const contextSnapshotInvalidation = contextSnapshotInvalidationMetadata(params?.contextSnapshotInvalidation);
    if (!contextSnapshotInvalidation || (typeof params?.threadId === "string" && params.threadId !== contextSnapshotInvalidation.providerThreadId)) return [];
    return [{ kind: "unknown", nativeType: "context_snapshot_invalidated", ts: new Date(contextSnapshotInvalidation.observedAt).toISOString(),
      threadId: contextSnapshotInvalidation.providerThreadId, contextSnapshotInvalidation }];
  }
  if (row.type === "honeybee_context_snapshot") {
    const contextSnapshot = contextSnapshotMetadata(row.contextSnapshot);
    if (!contextSnapshot) return [];
    return [{ kind: "unknown", nativeType: "context_snapshot", ts: new Date(contextSnapshot.measuredAt).toISOString(),
      threadId: contextSnapshot.identity.providerThreadId, contextSnapshot }];
  }
  if (row.type === "honeybee_context_snapshot_invalidated") {
    const contextSnapshotInvalidation = contextSnapshotInvalidationMetadata(row.contextSnapshotInvalidation);
    if (!contextSnapshotInvalidation) return [];
    return [{ kind: "unknown", nativeType: "context_snapshot_invalidated", ts: new Date(contextSnapshotInvalidation.observedAt).toISOString(),
      threadId: contextSnapshotInvalidation.providerThreadId, contextSnapshotInvalidation }];
  }
  if (row.type === "honeybee_context_inventory") {
    const contextInventory = recordedInstructionMetadata(row.contextInventory);
    if (!contextInventory) return [];
    return [{ kind: "unknown", nativeType: "context_inventory",
      ts: typeof row.timestamp === "string" ? row.timestamp : null,
      threadId: contextInventory.identity.providerThreadId, contextInventory }];
  }
  events = preserveContextUsage(row, events);
  events = preserveCodexContext(row, events);
  const observation = baselineObservation(row);
  if (observation) events = [{ kind: "unknown", nativeType: "context_baseline", ts: null, contextBaseline: observation }, ...events];
  let phase: "final" | "intermediate" | undefined;
  const params = asObject(row.params);
  const item = row.method === "item/completed"
    ? asObject(params?.item)
    : row.type === "response_item" || row.type === "event_msg" ? asObject(row.payload) : null;
  const nativePhase = item?.phase ?? item?.channel;
  if (nativePhase === "final") phase = "final";
  if (nativePhase === "commentary" || nativePhase === "analysis") phase = "intermediate";
  return events.map((event) => {
    if (phase && event.kind === "message" && event.role === "assistant") {
      return { ...event, answerPhase: phase };
    }
    return event;
  });
}

function preserveCodexContext(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  const payload = asObject(row.payload);
  const params = asObject(row.params);
  const sources: ContextSourceSize[] = [];
  const add = (category: ContextSourceSize["category"], label: string, value: unknown): void => {
    if (typeof value === "string" && value) sources.push({ category, label, characters: value.length });
  };
  if (row.type === "session_meta") add("system", "Base instructions", asObject(payload?.base_instructions)?.text);
  if (row.method === "thread/start" || row.method === "thread/resume") {
    add("system", "Base instructions", params?.baseInstructions);
    if (typeof params?.developerInstructions === "string") sources.push(...contextTextSources("developer", params.developerInstructions));
    if (Array.isArray(params?.dynamicTools) && params.dynamicTools.length) add("definitions", "Dynamic tool definitions", JSON.stringify(params.dynamicTools));
  }
  if (row.type === "response_item" && payload?.type === "message" && (payload.role === "system" || payload.role === "developer")) {
    sources.push(...contextTextSources(payload.role, contentText(payload.content)));
  }
  if (row.type === "compacted" && payload) {
    const replacement: ContextSourceSize[] = [];
    if (Array.isArray(payload.replacement_history)) for (const value of payload.replacement_history) {
      const item = asObject(value);
      if (!item) continue;
      if (item.type === "message" && typeof item.role === "string") replacement.push(...contextTextSources(item.role, contentText(item.content)));
      else if (item.type === "compaction" && typeof item.summary === "string") replacement.push({ category: "summary", label: "Provider summary", characters: item.summary.length });
      else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        if (typeof item.output === "string") replacement.push({ category: "tools", label: "Retained tool output", characters: item.output.length });
      }
    }
    if (typeof payload.message === "string" && payload.message) replacement.push({ category: "summary", label: "Provider summary", characters: payload.message.length });
    const contextInventory: ContextInventory | undefined = Array.isArray(payload.replacement_history) || replacement.length
      ? { scope: "replacement", sources: aggregateSources(replacement) } : undefined;
    const ts = typeof row.timestamp === "string" ? row.timestamp : null;
    return [{ kind: "compaction", ts, ...(contextInventory ? { contextInventory } : {}) }];
  }
  if (!sources.length) return events;
  const contextInventory: ContextInventory = { scope: "instructions", sources: aggregateSources(sources) };
  return [...events, { kind: "unknown", nativeType: "context_inventory", ts: typeof row.timestamp === "string" ? row.timestamp : null, contextInventory }];
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  return Array.isArray(value) ? value.map((v) => {
    const b = asObject(v);
    return typeof b?.text === "string" ? b.text : "";
  }).join("") : "";
}

function aggregateSources(sources: ContextSourceSize[]): ContextSourceSize[] {
  const grouped = new Map<string, ContextSourceSize>();
  for (const source of sources) {
    const key = `${source.category}:${source.label}`;
    const prior = grouped.get(key);
    grouped.set(key, { ...source, characters: source.characters + (prior?.characters ?? 0) });
  }
  return [...grouped.values()];
}

function baselineObservation(row: JsonObject): ContextBaselineObservation | undefined {
  const params = asObject(row.params);
  const requestId = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : undefined;
  if (row.method === "thread/start" && requestId) return contextBaselineObservation({ kind: "start", requestId });
  if (row.method === "thread/fork") return { kind: "invalidate" };
  if (row.method === "thread/resume" || row.method === "turn/steer") return contextBaselineObservation({ kind: "invalidate", providerThreadId: params?.threadId });
  if (!row.method && requestId) {
    const thread = asObject(asObject(row.result)?.thread);
    if (thread) return contextBaselineObservation({ kind: "thread", requestId, providerThreadId: thread.id });
  }
  if (row.method === "turn/start") {
    const input = params?.input;
    let characters = 0;
    let complete = Array.isArray(input) && input.length > 0;
    if (Array.isArray(input)) for (const value of input) {
      const item = asObject(value);
      if (item?.type !== "text" || typeof item.text !== "string") { complete = false; continue; }
      characters += contextTextSources("user", item.text).filter((s) => s.category === "messages" || s.category === "project" || s.category === "skills").reduce((sum, s) => sum + s.characters, 0);
    }
    return contextBaselineObservation({ kind: "input", providerThreadId: params?.threadId, characters, complete });
  }
  return undefined;
}

export function repairCodexLine(line: string, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  const row = parseJsonLine(line);
  if (!row) return events;
  return preserveMetadata(row, events);
}

export const codexTranscripts: TranscriptFamily = {
  harness: "codex",
  createProjector: () => createCodexProjector(),
  restoreProjector: (state) => isCodexCheckpointState(state) ? createCodexProjector(state) : undefined,
  repair: repairCodexLine,
};
