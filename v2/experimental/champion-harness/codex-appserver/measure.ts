export type Usage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function usage(value: unknown): Usage {
  const source = object(value);
  const read = (key: string): number => {
    const value = source[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Missing or invalid usage counter: ${key}`);
    }
    return value;
  };
  const result = {
    inputTokens: read("inputTokens"), cachedInputTokens: read("cachedInputTokens"),
    outputTokens: read("outputTokens"), reasoningOutputTokens: read("reasoningOutputTokens"),
    totalTokens: read("totalTokens"),
  };
  if (result.cachedInputTokens > result.inputTokens) throw new Error("Cached input exceeds input");
  return result;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0,
};

export function difference(current: Usage, previous: Usage): Usage {
  const result = { ...current };
  for (const key of Object.keys(current) as Array<keyof Usage>) {
    result[key] = current[key] - previous[key];
    if (result[key] < 0) throw new Error("Thread usage counters decreased; cannot attribute turn usage");
  }
  if (result.cachedInputTokens > result.inputTokens) throw new Error("Invalid turn cache counters");
  return result;
}

export class TurnMeasurement {
  readonly threadId: string;
  readonly startedAtMs: number;
  readonly previous: Usage;
  turnId: string | null = null;
  rpcAckMs: number | null = null;
  firstAssistantOutputMs: number | null = null;
  firstOutputSource: string | null = null;
  finishMs: number | null = null;
  status: string | null = null;
  total: Usage | null = null;
  last: Usage | null = null;
  usageNotifications = 0;
  compactionEvents: Array<{ method: string; itemId: string | null }> = [];
  output = "";

  constructor(threadId: string, startedAtMs: number, previous: Usage) {
    this.threadId = threadId;
    this.startedAtMs = startedAtMs;
    this.previous = previous;
  }

  observe(method: string, params: Record<string, unknown>, nowMs: number): void {
    if (params.threadId !== this.threadId) return;
    const nativeTurn = object(params.turn);
    const turnId = typeof params.turnId === "string" ? params.turnId : nativeTurn.id;
    if (typeof turnId === "string") {
      if (this.turnId !== null && this.turnId !== turnId) return;
      this.turnId = turnId;
    }
    const elapsed = nowMs - this.startedAtMs;
    const item = object(params.item);
    if (method === "thread/tokenUsage/updated") {
      const tokens = object(params.tokenUsage);
      this.total = usage(tokens.total);
      this.last = usage(tokens.last);
      this.usageNotifications += 1;
    }
    if (method === "item/agentMessage/delta" && typeof params.delta === "string" && params.delta.length) {
      this.firstAssistantOutputMs ??= elapsed;
      this.firstOutputSource ??= method;
    }
    if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string" && item.text.length) {
      this.firstAssistantOutputMs ??= elapsed;
      this.firstOutputSource ??= method;
      this.output = item.text;
    }
    if ((method === "item/completed" && item.type === "contextCompaction") || method === "thread/compacted") {
      this.compactionEvents.push({ method, itemId: typeof item.id === "string" ? item.id : null });
    }
    if (method === "turn/completed") {
      this.finishMs = elapsed;
      this.status = typeof nativeTurn.status === "string" ? nativeTurn.status : "unknown";
    }
  }

  result() {
    if (this.status !== "completed" || this.finishMs === null || this.total === null || this.firstAssistantOutputMs === null) {
      throw new Error("Turn did not complete with assistant output and native usage");
    }
    const tokens = difference(this.total, this.previous);
    return {
      threadId: this.threadId, turnId: this.turnId, rpcAckMs: this.rpcAckMs,
      firstAssistantOutputMs: this.firstAssistantOutputMs, firstOutputSource: this.firstOutputSource,
      finishMs: this.finishMs, status: this.status, ...tokens,
      cacheHitShare: tokens.inputTokens === 0 ? null : tokens.cachedInputTokens / tokens.inputTokens,
      usageNotifications: this.usageNotifications, nativeTotal: this.total, nativeLast: this.last,
      compactionEvents: this.compactionEvents,
    };
  }
}
