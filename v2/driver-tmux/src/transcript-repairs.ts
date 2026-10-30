import type { TranscriptProjectedEvent, TranscriptProjector } from "./transcript-projection.ts";
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

type JsonObject = Record<string, unknown>;

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function preserveContextUsage(harness: string, row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  let contextInputTokens: number | undefined;
  let modelContextWindow: number | undefined;
  let contextTurnId: string | undefined;
  let contextFirstRequest: boolean | undefined;
  if (harness === "codex") {
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
  } else if (harness === "claude" && row.type === "assistant" && row.isSidechain !== true) {
    const usage = asObject(asObject(row.message)?.usage);
    const input = tokenCount(usage?.input_tokens);
    const read = tokenCount(usage?.cache_read_input_tokens);
    const write = tokenCount(usage?.cache_creation_input_tokens);
    if (input !== undefined) contextInputTokens = tokenCount(input + (read ?? 0) + (write ?? 0));
  }
  if (contextInputTokens === undefined) return events;
  return events.map((event) => event.kind === "token_usage" ? {
    ...event, contextInputTokens,
    ...(contextFirstRequest !== undefined ? { contextFirstRequest } : {}),
    ...(contextTurnId ? { contextTurnId } : {}),
    ...(modelContextWindow !== undefined && modelContextWindow > 0 ? { modelContextWindow } : {}),
  } : event);
}

function preserveMetadata(harness: string, line: string, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  let row: JsonObject | null;
  try { row = asObject(JSON.parse(line)); } catch { return events; }
  if (!row) return events;
  if (harness === "codex" && row.method === "item/completed") {
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
  if (harness === "codex" && row.method === "thread/contextSnapshot/updated") {
    const params = asObject(row.params);
    const contextSnapshot = contextSnapshotMetadata(params?.contextSnapshot, { allowUnboundOwner: true });
    if (!contextSnapshot || (typeof params?.threadId === "string" && params.threadId !== contextSnapshot.identity.providerThreadId)) return [];
    return [{ kind: "unknown", nativeType: "native_context_snapshot", ts: new Date(contextSnapshot.measuredAt).toISOString(),
      threadId: contextSnapshot.identity.providerThreadId, contextSnapshot }];
  }
  if (harness === "codex" && row.method === "thread/contextSnapshot/invalidated") {
    const params = asObject(row.params);
    const contextSnapshotInvalidation = contextSnapshotInvalidationMetadata(params?.contextSnapshotInvalidation);
    if (!contextSnapshotInvalidation || (typeof params?.threadId === "string" && params.threadId !== contextSnapshotInvalidation.providerThreadId)) return [];
    return [{ kind: "unknown", nativeType: "context_snapshot_invalidated", ts: new Date(contextSnapshotInvalidation.observedAt).toISOString(),
      threadId: contextSnapshotInvalidation.providerThreadId, contextSnapshotInvalidation }];
  }
  if (harness === "codex" && row.type === "honeybee_context_snapshot") {
    const contextSnapshot = contextSnapshotMetadata(row.contextSnapshot);
    if (!contextSnapshot) return [];
    return [{ kind: "unknown", nativeType: "context_snapshot", ts: new Date(contextSnapshot.measuredAt).toISOString(),
      threadId: contextSnapshot.identity.providerThreadId, contextSnapshot }];
  }
  if (harness === "codex" && row.type === "honeybee_context_snapshot_invalidated") {
    const contextSnapshotInvalidation = contextSnapshotInvalidationMetadata(row.contextSnapshotInvalidation);
    if (!contextSnapshotInvalidation) return [];
    return [{ kind: "unknown", nativeType: "context_snapshot_invalidated", ts: new Date(contextSnapshotInvalidation.observedAt).toISOString(),
      threadId: contextSnapshotInvalidation.providerThreadId, contextSnapshotInvalidation }];
  }
  if (harness === "codex" && row.type === "honeybee_context_inventory") {
    const contextInventory = recordedInstructionMetadata(row.contextInventory);
    if (!contextInventory) return [];
    return [{ kind: "unknown", nativeType: "context_inventory",
      ts: typeof row.timestamp === "string" ? row.timestamp : null,
      threadId: contextInventory.identity.providerThreadId, contextInventory }];
  }
  events = preserveContextUsage(harness, row, events);
  if (harness === "codex") {
    events = preserveCodexContext(row, events);
    const observation = baselineObservation(row);
    if (observation) events = [{ kind: "unknown", nativeType: "context_baseline", ts: null, contextBaseline: observation }, ...events];
  }
  if (harness === "claude") events = preserveClaudeCompaction(row, events);
  if (harness === "claude" && row.isSidechain === true) {
    const agentId = nonEmptyString(row.agentId) ?? "unattributed";
    return events.map((event) => event.kind === "unknown" ? event : ({ ...event,
      threadId: `sidechain:${agentId}`, parentThreadId: "root" }));
  }
  let phase: "final" | "intermediate" | undefined;
  if (harness === "codex") {
    const params = asObject(row.params);
    const item = row.method === "item/completed"
      ? asObject(params?.item)
      : row.type === "response_item" || row.type === "event_msg" ? asObject(row.payload) : null;
    const nativePhase = item?.phase ?? item?.channel;
    if (nativePhase === "final") phase = "final";
    if (nativePhase === "commentary" || nativePhase === "analysis") phase = "intermediate";
  }
  if (harness === "claude" && row.type === "assistant") {
    const message = asObject(row.message);
    const content = message?.content;
    const hasTools = Array.isArray(content) && content.some((part) => {
      const block = asObject(part);
      return block?.type === "tool_use" || block?.type === "server_tool_use";
    });
    if (message?.stop_reason === "end_turn" && !hasTools) phase = "final";
    if (hasTools || message?.stop_reason === "tool_use") phase = "intermediate";
  }
  return events.map((event) => {
    if (phase && event.kind === "message" && event.role === "assistant") {
      return { ...event, answerPhase: phase };
    }
    if (harness === "claude" && row.type === "result" && event.kind === "turn_end") {
      return { ...event, finishReason: event.finishReason ?? "result",
        ...(row.is_error === true ? { interrupted: true } : {}) };
    }
    return event;
  });
}

const CLAUDE_COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";

function preserveClaudeCompaction(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  if (row.type === "system" && row.subtype === "compact_boundary") {
    const meta = asObject(row.compact_metadata) ?? asObject(row.compactMetadata);
    const trigger = nonEmptyString(meta?.trigger);
    const tokensBefore = tokenCount(meta?.pre_tokens ?? meta?.preTokens);
    const tokensAfter = tokenCount(meta?.post_tokens ?? meta?.postTokens);
    return [{
      kind: "compaction",
      ts: typeof row.timestamp === "string" ? row.timestamp : null,
      ...(trigger ? { trigger } : {}),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {}),
    }];
  }
  if (row.type !== "user") return events;
  const summary = row.isCompactSummary === true || (row.isSynthetic === true && events.some((event) =>
    event.kind === "message" && event.role === "user" && event.text.trimStart().startsWith(CLAUDE_COMPACT_SUMMARY_PREFIX)));
  if (!summary) return events;
  return events.flatMap((event): TranscriptProjectedEvent[] => {
    if (event.kind === "turn_start") return [];
    return event.kind === "message" && event.role === "user" ? [{ ...event, isCompactSummary: true }] : [event];
  });
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function queuedCommandMessage(line: string, ts: string | null): TranscriptProjectedEvent | null {
  let row: JsonObject | null;
  try {
    row = asObject(JSON.parse(line));
  } catch {
    return null;
  }
  if (
    !row ||
    row.type !== "attachment" ||
    row.isSidechain === true ||
    row.isMeta === true
  ) return null;

  const attachment = asObject(row.attachment);
  if (
    attachment?.type !== "queued_command" ||
    (attachment.commandMode !== undefined && attachment.commandMode !== "prompt") ||
    !Array.isArray(attachment.prompt)
  ) return null;

  const text = attachment.prompt.flatMap((part) => {
    const block = asObject(part);
    if (block?.type !== "text") return [];
    const value = nonEmptyString(block.text);
    return value === undefined ? [] : [value];
  }).join("");
  if (text.length === 0) return null;

  const providerEventId = nonEmptyString(row.uuid);
  return {
    kind: "message",
    ts,
    role: "user",
    text,
    ...(providerEventId ? { providerEventId } : {}),
  };
}

function repairQueuedCommand(harness: string, line: string, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  if (harness !== "claude") return events;
  if (events.some((event) => event.kind === "message" && event.role === "user")) {
    return events;
  }
  const unknownIndex = events.findIndex(
    (event) => event.kind === "unknown" && event.nativeType === "attachment",
  );
  if (unknownIndex < 0) return events;

  const replacement = queuedCommandMessage(line, events[unknownIndex]!.ts);
  if (!replacement) return events;
  return events.map((event, index) => index === unknownIndex ? replacement : event);
}

export function repairProjectedLine(harness: string, line: string, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  return repairQueuedCommand(harness, line, preserveMetadata(harness, line, events));
}

export function withTranscriptRepairs(harness: string, upstream: TranscriptProjector): TranscriptProjector {
  return {
    harness: upstream.harness,
    pushLine: (line) => repairProjectedLine(harness, line, upstream.pushLine(line)),
    flush: () => upstream.flush(),
    checkpoint: () => upstream.checkpoint(),
  };
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
