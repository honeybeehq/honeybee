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
 * Echo-provider runs verified messages, turns, cancellation, reminderChild and
 * session/tokenUsage. Tool names and argument keys, patchSummary, reasoning,
 * compaction, webSearch and non-zero usage come from the MSP schema and binary
 * strings only; re-check them against a real meta-provider session.
 */
import {
  projectorCheckpoint, checkpointRecord, checkpointEntries, checkpointNumber,
  checkpointNullable, checkpointString, checkpointStrings,
} from "./transcript-projection.ts";
import type {
  TranscriptFileChange,
  TranscriptIsoTs,
  TranscriptProjectedEvent,
  TranscriptProjector,
  TranscriptTokenUsage,
} from "./transcript-projection.ts";

type JsonObject = Record<string, unknown>;

/** Open tool items and per-turn usage accumulators retain their most recent entries in FIFO order. */
export const MUSE_STATE_LIMIT = 1024;

const SHELL_TOOLS = new Set(["bash", "shell", "exec_command"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;

interface MuseTurnUsage {
  usage: TranscriptTokenUsage;
  model: string | null;
}

interface MuseCheckpointState {
  openItems: string[];
  turnUsage: Array<[string, MuseTurnUsage]>;
}

function asObject(value: unknown): JsonObject | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

export function isMuseCheckpointState(value: unknown): value is MuseCheckpointState {
  return checkpointRecord(value, {
    openItems: (v) => Array.isArray(v) && v.length <= MUSE_STATE_LIMIT && checkpointStrings(v),
    turnUsage: (v) => Array.isArray(v) && v.length <= MUSE_STATE_LIMIT && checkpointEntries(isTurnUsage)(v),
  });
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

function subagentInput(item: JsonObject): JsonObject {
  const input: JsonObject = {};
  for (const key of ["role", "objective", "agentPath", "subagentId", "childSessionId"]) {
    if (nonEmptyString(item[key])) input[key] = item[key];
  }
  return input;
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
            ...(typeof item.visibleOutput === "string" ? { stdout: item.visibleOutput } : {}),
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
    pushLine(line: string): TranscriptProjectedEvent[] {
      let row: JsonObject | undefined;
      try {
        row = asObject(JSON.parse(line));
      } catch {
        return [];
      }
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
