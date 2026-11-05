/**
 * Muse Code harness adapter — normalizes `muse serve` (Muse Session Protocol
 * v1: newline-delimited JSON-RPC 2.0 on stdio). Wire facts captured from
 * muse 1.4.7 (schema sha256:6de32db0…7df9) on the offline echo provider:
 *
 *   we write : initialize {clientInfo:{name:"honeybee"}, capabilities:
 *                {requestedCapabilities:["sessionMcp"], userInputDialogs:false}}
 *   server   : initialize result                          → respond:
 *   we write :   initialized + session/start {commandId, workspaceRoot,
 *                approvalMode, modelId?, config:{mcpServers}}
 *                (or session/resume {sessionId, commandId, excludeItems, config})
 *   server   : session/start|resume result {session:{sessionId}} → booted (idle)
 *                (resume with a model first sends session/setModel)
 *   we write : turn/start {sessionId, commandId, input, ifBusy, reasoningEffort?}
 *   server   : turn/start result {disposition}             → delivery_confirmed
 *   server   : turn/started {sessionId, turnId}            → turn_started
 *   server   : turn/completed {sessionId, terminal, error?} → turn_ended
 *   we write : turn/interrupt {sessionId, commandId, turnId?}
 *   server   : usage/changed {tier, observedAtMs, window, weekly} → usage_observed
 *                (the host's last-observed subscription usage; also a
 *                turn/completed error.quota {limitKind, resetsAtMs})
 *
 * Every command carries a UUIDv7 `commandId`, and the host deduplicates by
 * it: a session/start retried with the same id returns the SAME session, and
 * a turn/start reusing an id with other input is `command_id_conflict`. Turn
 * ids derive from the mailbox message id so a redelivery is the same command;
 * setup and interrupt commands are minted fresh per runtime.
 *
 * Mid-turn mail is `ifBusy: "steer"` (folds into the running turn; on an
 * idle session it starts one). Session MCP servers need the `sessionMcp`
 * capability, else session/start fails `-32010 capabilityRequired`.
 */
import { randomBytes } from "node:crypto";
import {
  asObject,
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  nonEmptyString,
  parseJsonLine,
  successfulTurnClears,
  toNumber as finiteNumber,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import type { GrokMcpServerStdio } from "./grok.ts";
import {
  projectorCheckpoint, checkpointRecord, checkpointEntries, checkpointNumber,
  checkpointNullable, checkpointString, checkpointStrings,
  type TranscriptFamily, type TranscriptFileChange, type TranscriptIsoTs, type TranscriptProjectedEvent,
  type TranscriptProjector, type TranscriptTokenUsage,
} from "./transcript.ts";

export type MuseApprovalMode = "allowAll" | "promptUnmatched" | "onRequest" | "denyUnmatched";
export const MUSE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type MuseEffort = (typeof MUSE_EFFORTS)[number];

export interface MuseAdapterOptions {
  cwd: string;
  model?: string;
  effort?: MuseEffort;
  /** Wire approval mode; Honeybee has no approval bridge, so the default is allowAll. */
  approvalMode?: MuseApprovalMode;
  /** Live operator gateways, passed as this session's native MCP servers. */
  mcpServers?: readonly GrokMcpServerStdio[];
  resumeSessionId?: string;
  /** session/start|resume idempotency handle; minted per runtime when absent. */
  setupCommandId?: string;
}

const INITIALIZE_ID = 1;
const SESSION_SETUP_ID = 2;
const SET_MODEL_PREFIX = "muse:model:";
const INTERRUPT_ID = "muse:interrupt";
const TURN_REQUEST_ID_BASE = 1000;
const METHOD_NOT_FOUND = -32601;
const PROGRESS_ITEM_KINDS = new Set(["agentMessage", "reasoning", "toolCall", "webSearch", "subagent", "workflow"]);

function formatUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A fresh RFC 9562 UUIDv7 (MSP rejects other command id versions). */
export function museFreshCommandId(nowMs: number = Date.now()): string {
  const rand = randomBytes(10).toString("hex");
  const variant = ((parseInt(rand[3]!, 16) & 0x3) | 0x8).toString(16);
  return formatUuid(`${nowMs.toString(16).padStart(12, "0").slice(-12)}7${rand.slice(0, 3)}${variant}${rand.slice(4, 19)}`);
}

/** The turn/start command id for a mailbox message: stable across redelivery. */
export function museMessageCommandId(messageId: number): string {
  const hex = messageId.toString(16).padStart(18, "0");
  return formatUuid(`0000000000007${hex.slice(0, 3)}8${hex.slice(3)}`);
}

export function museSessionMcpServers(servers: readonly GrokMcpServerStdio[]): Record<string, unknown> {
  return Object.fromEntries(servers.map((server) => [server.name, {
    transport: "stdio",
    command: server.command,
    args: [...server.args],
    env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
    mode: "optional",
  }]));
}

function line(message: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", ...message });
}

function failureSignals(error: Record<string, unknown> | undefined, fallback: string, startup: boolean): AdapterSignal[] {
  const message = String(error?.message ?? fallback);
  const detail = message.slice(0, 500);
  const quota = asObject(error?.quota);
  if (quota) {
    const resetsAt = typeof quota.resetsAtMs === "number" && quota.resetsAtMs > 0 ? quota.resetsAtMs : undefined;
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail: `muse quota exhausted (${String(quota.limitKind ?? "unknown")}): ${message}`.slice(0, 500), ...(resetsAt ? { resetsAt } : {}) }];
  }
  if (error?.kind === "authRequired" || isAuthNeededMessage(message)) return [{ kind: "flag", flag: "auth_needed", action: "set", detail }];
  if (isResourceBlockedMessage(message)) return [{ kind: "flag", flag: "resource_blocked", action: "set", detail }];
  return startup ? [{ kind: "flag", flag: "spawn_failed", action: "set", detail }] : [];
}

export function museAdapter(opts: MuseAdapterOptions): HarnessAdapter {
  const setupCommandId = opts.setupCommandId ?? museFreshCommandId();
  const setModelCommandId = museFreshCommandId();
  const config = { mcpServers: museSessionMcpServers(opts.mcpServers ?? []) };
  const setupLine = opts.resumeSessionId
    ? line({ id: SESSION_SETUP_ID, method: "session/resume", params: { sessionId: opts.resumeSessionId, commandId: setupCommandId, excludeItems: true, config } })
    : line({ id: SESSION_SETUP_ID, method: "session/start", params: {
      commandId: setupCommandId,
      workspaceRoot: opts.cwd,
      approvalMode: opts.approvalMode ?? "allowAll",
      ...(opts.model ? { modelId: opts.model } : {}),
      config,
    } });

  function responseSignals(msg: Record<string, unknown>): AdapterSignal[] {
    const error = asObject(msg.error);
    if (msg.id === INITIALIZE_ID) {
      if (error) return failureSignals(error, "muse initialize failed", true);
      return [{ kind: "respond", lines: [line({ method: "initialized" }), setupLine] }];
    }
    if (msg.id === SESSION_SETUP_ID) {
      if (error) return failureSignals(error, "muse session setup failed", true);
      const session = asObject(asObject(msg.result)?.session);
      const sessionId = typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : undefined;
      if (!sessionId) return failureSignals(undefined, "muse session setup returned no sessionId", true);
      if (opts.resumeSessionId && opts.model && session?.modelId !== opts.model) {
        return [{ kind: "respond", lines: [line({ id: `${SET_MODEL_PREFIX}${sessionId}`, method: "session/setModel", params: {
          sessionId, commandId: setModelCommandId, model: { modelId: opts.model },
        } })] }];
      }
      return bootedToIdle(sessionId);
    }
    if (typeof msg.id === "string" && msg.id.startsWith(SET_MODEL_PREFIX)) {
      if (error) return failureSignals(error, "muse session/setModel failed", true);
      return bootedToIdle(msg.id.slice(SET_MODEL_PREFIX.length));
    }
    if (typeof msg.id === "number" && msg.id >= TURN_REQUEST_ID_BASE) {
      const messageId = msg.id - TURN_REQUEST_ID_BASE;
      if (!Number.isSafeInteger(messageId)) return [];
      if (error) return [{ kind: "delivery_refused", messageId }, ...failureSignals(error, "muse turn/start failed", false)];
      if ("result" in msg) return [{ kind: "delivery_confirmed", messageId }];
    }
    return [];
  }

  function notificationSignals(method: string, params: Record<string, unknown>): AdapterSignal[] {
    const threadId = typeof params.sessionId === "string" && params.sessionId ? params.sessionId : undefined;
    const scope = threadId ? { threadId } : {};
    switch (method) {
      case "turn/started": {
        const turnId = typeof params.turnId === "string" && params.turnId ? params.turnId : undefined;
        return [{ kind: "turn_started", ...(turnId ? { turnId } : {}), ...scope }];
      }
      case "turn/completed": {
        const error = asObject(params.error);
        const quota = params.terminal === "failed" ? asObject(error?.quota) : undefined;
        const evidence = params.terminal === "completed"
          ? successfulTurnClears()
          : params.terminal === "failed"
            ? failureSignals(error, String(params.reason ?? "muse turn failed"), false)
            : [];
        return [...evidence, ...(quota ? [{ kind: "usage_observed" as const, quota }] : []), { kind: "turn_ended", ...scope }];
      }
      case "usage/changed":
        return [{ kind: "usage_observed", usage: params }];
      case "item/started": {
        const kind = asObject(params.item)?.kind;
        return typeof kind === "string" && PROGRESS_ITEM_KINDS.has(kind) ? [{ kind: "turn_progress" }] : [];
      }
      case "session/tokenUsage":
        return [{ kind: "turn_progress" }];
      default:
        return [];
    }
  }

  return {
    harness: "muse",
    acceptsMidTurn: true,
    confirmsDelivery: true,
    reportsTurnProgress: true,
    readyAtSpawn: false,
    bootLines: () => [line({ id: INITIALIZE_ID, method: "initialize", params: {
      clientInfo: { name: "honeybee", title: "Honeybee", version: "2" },
      capabilities: { requestedCapabilities: ["sessionMcp"], userInputDialogs: false },
    } })],
    parseLine(raw) {
      const msg = parseJsonLine(raw);
      if (!msg) return [];
      if (typeof msg.method !== "string") return responseSignals(msg);
      if (msg.id !== undefined && msg.id !== null) {
        return [{ kind: "respond", lines: [line({ id: msg.id, error: { code: METHOD_NOT_FOUND, message: `unsupported server request: ${msg.method}` } })] }];
      }
      return notificationSignals(msg.method, asObject(msg.params) ?? {});
    },
    encodeMessage(body: string, ctx: EncodeContext): string | null {
      if (!ctx.sessionId) return null;
      return line({ id: TURN_REQUEST_ID_BASE + ctx.messageId, method: "turn/start", params: {
        sessionId: ctx.sessionId,
        commandId: museMessageCommandId(ctx.messageId),
        input: [{ type: "text", text: body }],
        ifBusy: ctx.turnActive ? "steer" : "queue",
        ...(opts.effort ? { reasoningEffort: opts.effort } : {}),
      } });
    },
    encodeInterrupt(ctx: InterruptContext): string | null {
      if (!ctx.sessionId) return null;
      return line({ id: INTERRUPT_ID, method: "turn/interrupt", params: {
        sessionId: ctx.sessionId,
        commandId: museFreshCommandId(),
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      } });
    },
  };
}

/**
 * Muse Code MSP projection (`muse serve`, MSP v1, Muse Code 1.4.7, 2026-10-13).
 *
 * HSR logs the MSP JSON-RPC stream in both directions. Server notifications
 * carry the transcript: `turn/started`, `item/started|completed`,
 * `session/tokenUsage` and `turn/completed`. `item/completed` is the
 * authoritative item, so `item/delta` and `item/updated` are not projected.
 * Responses are ignored: a `session/resume` result re-lists items that the same
 * bee log already projected.
 *
 * Item kinds: userMessage/agentMessage are messages, reasoning is thinking,
 * shell-family toolCalls are `shell`, other toolCalls are tool_call/tool_result
 * plus `file_edit` when Muse reports a patch summary, userShell is `shell`,
 * subagent is a `subagent` tool_call/tool_result, compaction and webSearch map
 * directly. reminderChild items are Muse's internal reminder agents and are not
 * projected. workflow, hookRun, sideChat and future kinds become `unknown`.
 *
 * A real meta-provider session (muse-spark-1.3) verified turns, messages,
 * reasoning summaries, the `bash` toolCall with its JSON result envelope,
 * reminderChild and cached usage. Edit tools, patchSummary, compaction,
 * webSearch and subagents still come from the MSP schema only.
 */
type JsonObject = Record<string, unknown>;

/** Open tool items and per-turn usage accumulators retain their most recent entries in FIFO order. */
export const MUSE_STATE_LIMIT = 1024;

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;

interface MuseTurnUsage {
  usage: TranscriptTokenUsage;
  model: string | null;
}

function isoFrom(value: unknown): TranscriptIsoTs {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function isUsage(value: unknown): boolean {
  const usage = asObject(value);
  return !!usage && Object.keys(usage).every((key) =>
    USAGE_KEYS.some((allowed) => allowed === key) && checkpointNumber(usage[key]));
}

function isTurnUsage(value: unknown): boolean {
  return checkpointRecord(value, { usage: isUsage, model: checkpointNullable(checkpointString) });
}

/**
 * One model call's usage. `promptTokens` counts the prompt once under the
 * provider's cache convention, so uncached input is the prompt minus cache
 * reads and writes, whichever side of `inputTokens` the provider puts them.
 */
function callUsage(params: JsonObject): TranscriptTokenUsage | undefined {
  const raw = asObject(params.usage);
  const prompt = finiteNumber(params.promptTokens);
  const total = finiteNumber(params.totalTokens);
  if (!raw && prompt === undefined && total === undefined) return undefined;
  const cacheRead = finiteNumber(raw?.cacheReadTokens) ?? finiteNumber(raw?.cachedTokens);
  const cacheWrite = finiteNumber(raw?.cacheWriteTokens);
  const input = prompt !== undefined
    ? Math.max(0, prompt - (cacheRead ?? 0) - (cacheWrite ?? 0))
    : finiteNumber(raw?.inputTokens);
  const output = finiteNumber(raw?.outputTokens);
  const reasoning = finiteNumber(raw?.reasoningTokens);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
}

function addUsage(a: TranscriptTokenUsage, b: TranscriptTokenUsage): TranscriptTokenUsage {
  const sum: TranscriptTokenUsage = {};
  for (const key of USAGE_KEYS) {
    if (a[key] === undefined && b[key] === undefined) continue;
    sum[key] = (a[key] ?? 0) + (b[key] ?? 0);
  }
  return sum;
}

/** `apply_patch` envelopes name each file on a `*** <Op> File: <path>` line. */
function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const path = match[1]!.trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function editedFiles(input: unknown, summary: JsonObject): TranscriptFileChange[] {
  const args = asObject(input);
  const direct = nonEmptyString(args?.path) ?? nonEmptyString(args?.file_path);
  const patch = typeof input === "string" ? input : nonEmptyString(args?.patch) ?? nonEmptyString(args?.input);
  const paths = direct ? [direct] : patch ? patchPaths(patch) : [];
  const added = finiteNumber(summary.added);
  const removed = finiteNumber(summary.removed);
  if (paths.length !== 1) return paths.map((path) => ({ path }));
  return [{
    path: paths[0]!,
    ...(added !== undefined ? { addedLines: added } : {}),
    ...(removed !== undefined ? { removedLines: removed } : {}),
  }];
}

function shellCommand(input: unknown): string | undefined {
  const args = asObject(input);
  const command = args?.command ?? args?.cmd;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ");
  return nonEmptyString(command);
}

function shellResult(visibleOutput: unknown): { stdout?: string; exitCode?: number } {
  if (typeof visibleOutput !== "string") return {};
  const envelope = asObject(parseArgs(visibleOutput));
  if (!envelope || typeof envelope.output !== "string") return { stdout: visibleOutput };
  const exitCode = finiteNumber(envelope.exit_code);
  return { stdout: envelope.output, ...(exitCode !== undefined ? { exitCode } : {}) };
}

function subagentInput(item: JsonObject): JsonObject {
  const input: JsonObject = {};
  for (const key of ["role", "objective", "agentPath", "subagentId", "childSessionId"]) {
    if (nonEmptyString(item[key])) input[key] = item[key];
  }
  return input;
}

// checkpoint-digest:start
interface MuseCheckpointState {
  openItems: string[];
  turnUsage: Array<[string, MuseTurnUsage]>;
}

export function isMuseCheckpointState(value: unknown): value is MuseCheckpointState {
  return checkpointRecord(value, {
    openItems: (v) => Array.isArray(v) && v.length <= MUSE_STATE_LIMIT && checkpointStrings(v),
    turnUsage: (v) => Array.isArray(v) && v.length <= MUSE_STATE_LIMIT && checkpointEntries(isTurnUsage)(v),
  });
}

export function createMuseProjector(restored?: MuseCheckpointState): TranscriptProjector {
  const openItems = new Set<string>(restored?.openItems);
  const turnUsage = new Map<string, MuseTurnUsage>(restored?.turnUsage);

  function remember<T>(collection: Set<string> | Map<string, T>, key: string, value?: T): void {
    if (collection instanceof Set) collection.add(key);
    else collection.set(key, value as T);
    if (collection.size > MUSE_STATE_LIMIT) {
      const oldest = collection.keys().next();
      if (!oldest.done) collection.delete(oldest.value);
    }
  }

  function startedEvents(item: JsonObject, base: { ts: TranscriptIsoTs; threadId?: string }): TranscriptProjectedEvent[] {
    const itemId = nonEmptyString(item.itemId);
    const kind = item.kind;
    if (kind === "toolCall") {
      const name = nonEmptyString(item.tool) ?? "tool";
      const callId = nonEmptyString(item.callId) ?? itemId ?? "muse:unknown";
      const input = parseArgs(item.args);
      if (SHELL_TOOLS.has(name)) {
        const command = shellCommand(input);
        return [{ kind: "shell", ...base, callId, status: "started", ...(command ? { command } : {}) }];
      }
      return [{ kind: "tool_call", ...base, callId, name, ...(input !== undefined ? { input } : {}) }];
    }
    if (kind === "userShell") {
      const command = nonEmptyString(item.commandText);
      return [{ kind: "shell", ...base, callId: itemId ?? "muse:unknown", status: "started", ...(command ? { command } : {}) }];
    }
    if (kind === "subagent") {
      return [{ kind: "tool_call", ...base, callId: itemId ?? "muse:unknown", name: "subagent", input: subagentInput(item) }];
    }
    return [];
  }

  function completedEvents(item: JsonObject, base: { ts: TranscriptIsoTs; threadId?: string }): TranscriptProjectedEvent[] {
    const itemId = nonEmptyString(item.itemId);
    const status = nonEmptyString(item.status);
    const failed = status !== "completed";
    const failure = nonEmptyString(item.failureReason);
    switch (item.kind) {
      case "userMessage":
      case "agentMessage": {
        const text = nonEmptyString(item.text);
        if (!text) return [];
        return [{
          kind: "message",
          ...base,
          role: item.kind === "userMessage" ? "user" : "assistant",
          text,
          ...(itemId ? { providerEventId: itemId } : {}),
        }];
      }
      case "reasoning": {
        const summary = Array.isArray(item.summary)
          ? item.summary.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
          : [];
        const text = nonEmptyString(item.text) ?? (summary.length > 0 ? summary.join("\n\n") : undefined);
        return [text ? { kind: "thinking", ...base, redacted: false, text } : { kind: "thinking", ...base, redacted: true }];
      }
      case "toolCall": {
        const name = nonEmptyString(item.tool) ?? "tool";
        const callId = nonEmptyString(item.callId) ?? itemId ?? "muse:unknown";
        const input = parseArgs(item.args);
        const output = typeof item.visibleOutput === "string" ? item.visibleOutput : failure;
        if (SHELL_TOOLS.has(name)) {
          const command = shellCommand(input);
          return [{
            kind: "shell",
            ...base,
            callId,
            status: "completed",
            ...(command ? { command } : {}),
            ...shellResult(item.visibleOutput),
            ...(failed && failure ? { stderr: failure } : {}),
          }];
        }
        const events: TranscriptProjectedEvent[] = [{
          kind: "tool_result",
          ...base,
          callId,
          name,
          isError: failed,
          ...(output !== undefined ? { output } : {}),
        }];
        const summary = asObject(item.patchSummary);
        if (summary && !failed) events.push({ kind: "file_edit", ...base, callId, files: editedFiles(input, summary) });
        return events;
      }
      case "userShell": {
        const exitCode = finiteNumber(item.exitCode);
        const durationMs = finiteNumber(item.durationMs);
        const command = nonEmptyString(item.commandText);
        return [{
          kind: "shell",
          ...base,
          callId: itemId ?? "muse:unknown",
          status: "completed",
          ...(command ? { command } : {}),
          ...(typeof item.visibleOutput === "string" ? { stdout: item.visibleOutput } : {}),
          ...(failed && failure ? { stderr: failure } : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        }];
      }
      case "subagent": {
        const result = asObject(item.result);
        const output = nonEmptyString(result?.text) ?? nonEmptyString(result?.summary) ?? failure;
        return [{
          kind: "tool_result",
          ...base,
          callId: itemId ?? "muse:unknown",
          name: "subagent",
          isError: failed || nonEmptyString(result?.errorKind) !== undefined,
          ...(output ? { output } : {}),
        }];
      }
      case "compaction": {
        const outcome = nonEmptyString(item.outcome);
        if (outcome && outcome !== "compacted") {
          return [{ kind: "unknown", ...base, nativeType: `compaction:${outcome}`, ...(nonEmptyString(item.reason) ? { detail: nonEmptyString(item.reason) } : {}) }];
        }
        const trigger = nonEmptyString(item.trigger);
        const tokensBefore = finiteNumber(item.tokensBefore);
        const tokensAfter = finiteNumber(item.tokensAfter);
        return [{
          kind: "compaction",
          ...base,
          ...(trigger ? { trigger } : {}),
          ...(tokensBefore !== undefined ? { tokensBefore } : {}),
          ...(tokensAfter !== undefined ? { tokensAfter } : {}),
        }];
      }
      case "webSearch": {
        const query = nonEmptyString(item.query) ?? nonEmptyString(item.fallbackText);
        return [{
          kind: "web_search",
          ...base,
          ...(itemId ? { itemId, providerEventId: itemId } : {}),
          ...(query ? { query } : {}),
        }];
      }
      case "reminderChild":
        return [];
      default: {
        const nativeType = nonEmptyString(item.kind) ?? "item";
        const detail = nonEmptyString(item.fallbackText);
        return [{ kind: "unknown", ...base, nativeType, ...(detail ? { detail } : {}) }];
      }
    }
  }

  function projectNotification(method: string, params: JsonObject, emittedAt: TranscriptIsoTs): TranscriptProjectedEvent[] {
    const threadId = nonEmptyString(params.sessionId);
    const thread = threadId ? { threadId } : {};
    switch (method) {
      case "turn/started": {
        const turnId = nonEmptyString(params.turnId);
        return [{ kind: "turn_start", ts: emittedAt, ...thread, ...(turnId ? { turnId } : {}) }];
      }
      case "item/started":
      case "item/completed": {
        const item = asObject(params.item);
        if (!item) return [];
        const itemId = nonEmptyString(item.itemId);
        const base = { ts: emittedAt ?? isoFrom(item.recordedAt), ...thread };
        const opens = item.kind === "toolCall" || item.kind === "userShell" || item.kind === "subagent";
        if (method === "item/started") {
          if (!opens || !itemId || openItems.has(itemId)) return [];
          remember(openItems, itemId);
          return startedEvents(item, base);
        }
        if (!opens) return completedEvents(item, base);
        const startSeen = itemId !== undefined && openItems.delete(itemId);
        return [...(startSeen ? [] : startedEvents(item, base)), ...completedEvents(item, base)];
      }
      case "session/tokenUsage": {
        const turnId = nonEmptyString(params.turnId);
        const usage = callUsage(params);
        if (!turnId || !usage) return [];
        const held = turnUsage.get(turnId);
        turnUsage.delete(turnId);
        remember(turnUsage, turnId, {
          usage: held ? addUsage(held.usage, usage) : usage,
          model: nonEmptyString(params.modelId) ?? held?.model ?? null,
        });
        return [];
      }
      case "turn/completed": {
        const turnId = nonEmptyString(params.turnId);
        const terminal = nonEmptyString(params.terminal);
        const durationMs = finiteNumber(params.durationMs);
        const error = asObject(params.error);
        const events: TranscriptProjectedEvent[] = [];
        const errorText = nonEmptyString(error?.message) ?? (terminal === "failed" ? nonEmptyString(params.reason) : undefined);
        if (terminal === "failed" && errorText) {
          const errorKind = nonEmptyString(error?.kind);
          events.push({ kind: "message", ts: emittedAt, ...thread, role: "system", text: `Muse error${errorKind ? ` (${errorKind})` : ""}: ${errorText}` });
        }
        const held = turnId ? turnUsage.get(turnId) : undefined;
        if (turnId && held) {
          turnUsage.delete(turnId);
          events.push({
            kind: "token_usage",
            ts: emittedAt,
            ...thread,
            usage: held.usage,
            scope: "turn",
            providerTurnId: turnId,
            ...(held.model ? { model: held.model } : {}),
          });
        }
        events.push({
          kind: "turn_end",
          ts: emittedAt,
          ...thread,
          ...(turnId ? { turnId } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(terminal ? { finishReason: terminal } : {}),
          ...(terminal === "cancelled" || terminal === "failed" ? { interrupted: true } : {}),
        });
        return events;
      }
      default:
        return [];
    }
  }

  return {
    harness: "muse",
    checkpoint() {
      return projectorCheckpoint("muse", {
        openItems: [...openItems],
        turnUsage: [...turnUsage],
      } satisfies MuseCheckpointState);
    },
    pushLine(raw: string): TranscriptProjectedEvent[] {
      const row = parseJsonLine(raw);
      const method = nonEmptyString(row?.method);
      if (!row || !method) return [];
      const params = asObject(row.params) ?? {};
      if (row.id !== undefined) {
        if (method !== "turn/interrupt" && method !== "turn/cancel") return [];
        const threadId = nonEmptyString(params.sessionId);
        return [{ kind: "interrupt", ts: null, ...(threadId ? { threadId } : {}) }];
      }
      return projectNotification(method, params, isoFrom(row.emittedAtMs));
    },
    flush(): TranscriptProjectedEvent[] {
      return [];
    },
  };
}
// checkpoint-digest:end

export const museTranscripts: TranscriptFamily = {
  harness: "muse",
  createProjector: () => createMuseProjector(),
  restoreProjector: (state) => isMuseCheckpointState(state) ? createMuseProjector(state) : undefined,
};
