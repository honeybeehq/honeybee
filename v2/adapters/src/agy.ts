/**
 * agy print-mode adapter. agy emits NDJSON on stdout and accepts one NDJSON
 * user envelope per turn on stdin. The protocol was captured from agy 1.1.24
 * on 2026-09-02; unknown events remain replayable log noise.
 */
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
} from "./types.ts";
import {
  projectorCheckpoint, checkpointRecord, checkpointEntries, checkpointNullable,
  checkpointString, checkpointStrings, checkpointBoolean, checkpointNumber,
  type TranscriptFamily, type TranscriptProjectedEvent, type TranscriptProjector, type TranscriptTokenUsage,
} from "./transcript.ts";

function resultSignals(resultValue: unknown): AdapterSignal[] {
  const result = asObject(resultValue);
  if (!result || typeof result.status !== "string") return [];

  if (result.status === "SUCCESS") {
    return [...successfulTurnClears(), { kind: "turn_ended" }];
  }

  if (result.status === "ERROR") {
    const message = typeof result.error === "string"
      ? result.error
      : typeof result.response === "string" && result.response.length > 0
        ? result.response
        : "agy result error";
    const signals: AdapterSignal[] = [];
    if (isAuthNeededMessage(message)) {
      signals.push({ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) });
    } else if (isResourceBlockedMessage(message)) {
      signals.push({ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) });
    }
    signals.push({ kind: "turn_ended" });
    return signals;
  }

  // CANCELED is a normal terminal result. In request-review mode, a queued
  // next message can cancel a tool approval without crashing the process.
  return [{ kind: "turn_ended" }];
}

export function parseAgyLine(line: string): AdapterSignal[] {
  const message = parseJsonLine(line);
  if (!message || typeof message.event !== "string") return [];

  switch (message.event) {
    case "init": {
      const sessionId = typeof message.conversation_id === "string" && message.conversation_id.length > 0
        ? message.conversation_id
        : undefined;
      return bootedToIdle(sessionId);
    }
    case "step_update": {
      const update = asObject(message.step_update);
      return update?.step_type === "agent_response" ? [{ kind: "turn_started" }] : [];
    }
    case "result":
      return resultSignals(message.result);
    default:
      return [];
  }
}

/** One stream-json input line in the shape accepted by agy 1.1.24. */
export function encodeAgyMessage(body: string): string {
  return JSON.stringify({
    event: "user",
    message: { content: [{ type: "text", text: body }] },
  });
}

export function agyResumeArgs(providerSessionId: string): string[] {
  return ["--conversation", providerSessionId];
}

export const agyAdapter: HarnessAdapter = {
  harness: "agy",
  acceptsMidTurn: false,
  confirmsDelivery: false,
  readyAtSpawn: false,
  bootLines(): string[] {
    return [];
  },
  parseLine: parseAgyLine,
  encodeMessage(body: string, _ctx: EncodeContext): string | null {
    return encodeAgyMessage(body);
  },
  resumeArgs: agyResumeArgs,
};

/**
 * agy stream-json projection, captured from agy 1.1.24 on 2026-09-02.
 * HSR logs both the user envelopes written to stdin and agy's stdout lines.
 */
type JsonObject = Record<string, unknown>;
interface AssistantFragment {
  text: string;
  providerEventId?: string;
}

const TERMINAL_TOOL_STATES = new Set(["DONE", "ERROR", "FAILED", "CANCELED"]);
const ERROR_TOOL_STATES = new Set(["ERROR", "FAILED", "CANCELED"]);
const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total"] as const;

/** Each emitted-identity set retains its most recent distinct emissions in FIFO order. */
export const AGY_DEDUPE_LIMIT = 1024;

function rememberEmission(identities: Set<string>, id: string): void {
  identities.add(id);
  if (identities.size > AGY_DEDUPE_LIMIT) {
    const oldest = identities.values().next();
    if (!oldest.done) identities.delete(oldest.value);
  }
}

function isEmittedIdentities(value: unknown): boolean {
  return Array.isArray(value) && value.length <= AGY_DEDUPE_LIMIT && checkpointStrings(value);
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((entry) => {
    const block = asObject(entry);
    return block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0
      ? [block.text]
      : [];
  });
  return text.length > 0 ? text.join("\n") : undefined;
}

function usageFrom(value: unknown): TranscriptTokenUsage | undefined {
  const usage = asObject(value);
  if (!usage) return undefined;
  const input = finiteNumber(usage.input_tokens);
  const output = finiteNumber(usage.output_tokens);
  const cacheRead = finiteNumber(usage.cache_read_tokens);
  const cacheWrite = finiteNumber(usage.cache_write_tokens);
  const reasoning = finiteNumber(usage.thinking_tokens);
  const total = finiteNumber(usage.total_tokens);
  const projected: TranscriptTokenUsage = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(total !== undefined ? { total } : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function usageDelta(
  current: TranscriptTokenUsage,
  previous: TranscriptTokenUsage | undefined,
  subtractPrevious: boolean,
): TranscriptTokenUsage {
  const projected: TranscriptTokenUsage = {};
  for (const key of USAGE_KEYS) {
    const value = current[key];
    if (value === undefined) continue;
    const before = previous?.[key];
    projected[key] = subtractPrevious && before !== undefined && value >= before
      ? value - before
      : value;
  }
  return projected;
}

function printableOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// checkpoint-digest:start
interface AgyCheckpointState {
  threadId: string | null;
  sawAssistantText: boolean;
  previousResultUsage: TranscriptTokenUsage | null;
  previousNumTurns: number | null;
  previousDurationSeconds: number | null;
  assistantFragments: Array<[string, AssistantFragment]>;
  emittedAssistantMessages: string[];
  emittedToolCalls: string[];
  emittedToolResults: string[];
}
function isUsage(value: unknown): boolean {
  const v = asObject(value);
  return !!v && Object.keys(v).every((key) => USAGE_KEYS.some((allowed) => allowed === key) && checkpointNumber(v[key]));
}
function isFragment(value: unknown): boolean {
  const v = asObject(value);
  return !!v && checkpointRecord(v, { text: checkpointString,
    ...(Object.hasOwn(v, "providerEventId") ? { providerEventId: checkpointString } : {}),
  });
}

export function isAgyCheckpointState(value: unknown): value is AgyCheckpointState {
  return checkpointRecord(value, {
    threadId: checkpointNullable(checkpointString),
    sawAssistantText: checkpointBoolean,
    previousResultUsage: checkpointNullable(isUsage),
    previousNumTurns: checkpointNullable(checkpointNumber),
    previousDurationSeconds: checkpointNullable(checkpointNumber),
    assistantFragments: checkpointEntries(isFragment),
    emittedAssistantMessages: isEmittedIdentities,
    emittedToolCalls: isEmittedIdentities,
    emittedToolResults: isEmittedIdentities,
  });
}
export function createAgyProjector(restored?: AgyCheckpointState): TranscriptProjector {
  let threadId: string | undefined = restored?.threadId ?? undefined;
  let sawAssistantText = restored?.sawAssistantText ?? false;
  let previousResultUsage: TranscriptTokenUsage | undefined = restored?.previousResultUsage ?? undefined;
  let previousNumTurns: number | undefined = restored?.previousNumTurns ?? undefined;
  let previousDurationSeconds: number | undefined = restored?.previousDurationSeconds ?? undefined;
  const assistantFragments = new Map<string, AssistantFragment>(restored?.assistantFragments);
  const emittedAssistantMessages = new Set<string>(restored?.emittedAssistantMessages);
  const emittedToolCalls = new Set<string>(restored?.emittedToolCalls);
  const emittedToolResults = new Set<string>(restored?.emittedToolResults);

  function rememberThread(value: unknown): void {
    const next = nonEmptyString(value);
    if (!next) return;
    if (threadId !== undefined && threadId !== next) {
      previousResultUsage = undefined;
      previousNumTurns = undefined;
      previousDurationSeconds = undefined;
      assistantFragments.clear();
      emittedAssistantMessages.clear();
      emittedToolCalls.clear();
      emittedToolResults.clear();
    }
    threadId = next;
  }

  function thread(): { threadId?: string } {
    return threadId ? { threadId } : {};
  }

  function toolCallId(update: JsonObject): string {
    const stepIndex = finiteNumber(update.step_index);
    return `agy:${threadId ?? "unknown"}:${stepIndex ?? "unknown"}`;
  }

  function assistantMessage(fragment: AssistantFragment): TranscriptProjectedEvent {
    return {
      kind: "message",
      ts: null,
      ...thread(),
      role: "assistant",
      text: fragment.text,
      ...(fragment.providerEventId ? { providerEventId: fragment.providerEventId } : {}),
    };
  }

  function projectStep(update: JsonObject): TranscriptProjectedEvent[] {
    rememberThread(update.conversation_id);
    const stepType = nonEmptyString(update.step_type);
    if (stepType === "user_input") return [];

    if (stepType === "agent_response") {
      const stepIndex = finiteNumber(update.step_index);
      const eventId = `agy:${threadId ?? "unknown"}:${stepIndex ?? "unknown"}`;
      const delta = typeof update.text_delta === "string" ? update.text_delta : "";
      if (!emittedAssistantMessages.has(eventId) && delta.length > 0) {
        const held = assistantFragments.get(eventId);
        assistantFragments.set(eventId, {
          text: `${held?.text ?? ""}${delta}`,
          ...(stepIndex !== undefined ? { providerEventId: eventId } : {}),
        });
      }
      const state = nonEmptyString(update.state)?.toUpperCase();
      if (state !== "DONE" || emittedAssistantMessages.has(eventId)) return [];
      const fragment = assistantFragments.get(eventId);
      assistantFragments.delete(eventId);
      if (!fragment || fragment.text.trim().length === 0) return [];
      rememberEmission(emittedAssistantMessages, eventId);
      sawAssistantText = true;
      return [assistantMessage(fragment)];
    }

    if (stepType !== "tool") return [];
    const state = nonEmptyString(update.state)?.toUpperCase();
    const info = asObject(update.tool_info);
    const name = nonEmptyString(update.tool_name) ?? nonEmptyString(info?.name) ?? "tool";
    const callId = toolCallId(update);
    if (state === "ACTIVE" && !emittedToolCalls.has(callId)) {
      rememberEmission(emittedToolCalls, callId);
      return [{
        kind: "tool_call",
        ts: null,
        ...thread(),
        callId,
        name,
        ...(info?.parameters !== undefined ? { input: info.parameters } : {}),
      }];
    }
    if (state && TERMINAL_TOOL_STATES.has(state) && !emittedToolResults.has(callId)) {
      rememberEmission(emittedToolResults, callId);
      const output = printableOutput(info?.output) ?? printableOutput(info?.error);
      return [{
        kind: "tool_result",
        ts: null,
        ...thread(),
        callId,
        name,
        isError: ERROR_TOOL_STATES.has(state),
        ...(output !== undefined ? { output } : {}),
      }];
    }
    return [];
  }

  function projectResult(result: JsonObject): TranscriptProjectedEvent[] {
    rememberThread(result.conversation_id);
    const events: TranscriptProjectedEvent[] = [];
    const response = nonEmptyString(result.response);
    const numTurns = finiteNumber(result.num_turns);
    const turnId = threadId && numTurns !== undefined ? `${threadId}:${numTurns}` : undefined;
    if (response && !sawAssistantText) {
      events.push({ kind: "message", ts: null, ...thread(), role: "assistant", text: response });
    }

    const cumulativeUsage = usageFrom(result.usage);
    if (cumulativeUsage) {
      const canSubtract = previousResultUsage !== undefined
        && previousNumTurns !== undefined
        && numTurns !== undefined
        && numTurns > previousNumTurns;
      events.push({
        kind: "token_usage",
        ts: null,
        ...thread(),
        usage: usageDelta(cumulativeUsage, previousResultUsage, canSubtract),
        scope: "turn",
        ...(turnId ? { providerTurnId: turnId } : {}),
      });
    }

    const status = nonEmptyString(result.status);
    if (status === "ERROR") {
      const reason = nonEmptyString(result.error) ?? response ?? "agy result error";
      events.push({ kind: "interrupt", ts: null, ...thread(), reason });
    }
    const durationSeconds = finiteNumber(result.duration_seconds);
    let turnDurationSeconds: number | undefined;
    if (previousNumTurns === undefined && numTurns === 1) {
      turnDurationSeconds = durationSeconds;
    } else if (
      durationSeconds !== undefined
      && previousDurationSeconds !== undefined
      && previousNumTurns !== undefined
      && numTurns !== undefined
      && numTurns > previousNumTurns
      && durationSeconds >= previousDurationSeconds
    ) {
      turnDurationSeconds = durationSeconds - previousDurationSeconds;
    }
    events.push({
      kind: "turn_end",
      ts: null,
      ...thread(),
      ...(turnId ? { turnId } : {}),
      ...(turnDurationSeconds !== undefined
        ? { durationMs: Math.round(turnDurationSeconds * 1_000_000) / 1_000 }
        : {}),
      ...(status ? { finishReason: status } : {}),
      ...((status === "CANCELED" || status === "ERROR") ? { interrupted: true } : {}),
    });
    if (durationSeconds !== undefined) previousDurationSeconds = durationSeconds;
    previousResultUsage = cumulativeUsage;
    previousNumTurns = numTurns;
    assistantFragments.clear();
    sawAssistantText = false;
    return events;
  }

  return {
    harness: "agy",
    checkpoint() {
      return projectorCheckpoint("agy", {
        threadId: threadId ?? null,
        sawAssistantText: sawAssistantText,
        previousResultUsage: previousResultUsage ?? null,
        previousNumTurns: previousNumTurns ?? null,
        previousDurationSeconds: previousDurationSeconds ?? null,
        assistantFragments: [...assistantFragments],
        emittedAssistantMessages: [...emittedAssistantMessages],
        emittedToolCalls: [...emittedToolCalls],
        emittedToolResults: [...emittedToolResults],
      } satisfies AgyCheckpointState);
    },

    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = parseJsonLine(line);
      if (!row) return [];
      const event = nonEmptyString(row.event);
      if (!event) return [];

      if (event === "init") {
        rememberThread(row.conversation_id);
        sawAssistantText = false;
        return [];
      }
      if (event === "user") {
        const message = asObject(row.message);
        const text = textFromContent(message?.content);
        if (!text) return [];
        sawAssistantText = false;
        return [
          { kind: "turn_start", ts: null, ...thread() },
          { kind: "message", ts: null, ...thread(), role: "user", text },
        ];
      }
      if (event === "step_update") {
        const update = asObject(row.step_update);
        return update ? projectStep(update) : [];
      }
      if (event === "result") {
        const result = asObject(row.result);
        return result ? projectResult(result) : [];
      }
      return [{ kind: "unknown", ts: null, ...thread(), nativeType: event }];
    },
    flush(): TranscriptProjectedEvent[] {
      const events: TranscriptProjectedEvent[] = [];
      for (const [eventId, fragment] of assistantFragments) {
        if (fragment.text.trim().length === 0) continue;
        rememberEmission(emittedAssistantMessages, eventId);
        events.push(assistantMessage(fragment));
      }
      assistantFragments.clear();
      if (events.length > 0) sawAssistantText = true;
      return events;
    },
  };
}
// checkpoint-digest:end

export const agyTranscripts: TranscriptFamily = {
  harness: "agy",
  createProjector: () => createAgyProjector(),
  restoreProjector: (state) => isAgyCheckpointState(state) ? createAgyProjector(state) : undefined,
};
