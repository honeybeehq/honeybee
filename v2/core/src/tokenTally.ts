/**
 * Per-bee running token totals, summed from the transcript events the segment
 * worker already projects (no log is read for this alone).
 *
 * The tally starts only when a bee's segmentation starts at its first byte, so a
 * bee whose earlier lines were cut before the tally existed stays unknown (null)
 * instead of reporting a partial count. It is carried on the segment cursor and
 * committed in the same transaction as the cursor, so each projected line is
 * counted exactly once across restarts and the totals never go backwards.
 *
 * Harnesses report usage in three shapes (see the adapters' token_usage events):
 * - `scope: "cumulative"` — a thread's running total (codex). Counted as the
 *   increase over the previous total of that thread; a total below the previous
 *   one is a counter reset and counts in full.
 * - turn-scoped with `providerTurnId` — repeated per API message or per turn
 *   (claude assistant lines repeat their message's usage). Counted as the
 *   increase over what that id already counted.
 * - turn-scoped without an id — a turn total that supersedes the id-keyed rows
 *   of the same turn (claude `result`). Counted as the part not yet counted
 *   since the last turn end.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** What a bee row shows: present only when known. */
export interface BeeTokenTotals {
  tokens: TokenCounts;
  turns: number;
  lastModel: string | null;
}

export interface TokenTally extends BeeTokenTotals {
  version: 1;
  /** Latest cumulative total per thread ("" = no thread id), oldest first. */
  cumulative: Array<[string, TokenCounts]>;
  /** Usage already counted per provider id, oldest first. */
  seen: Array<[string, TokenCounts]>;
  /** Id-keyed usage counted since the last root turn end. */
  turn: TokenCounts;
  /** After a log shrank: lines of `path` ending at or before `byteOffset` were already counted. */
  skipThrough: { path: string; byteOffset: number } | null;
}

/** The fields of a projected event the tally reads (structurally a TranscriptProjectedEvent). */
export interface TallyEvent {
  kind: string;
  threadId?: string;
  parentThreadId?: string;
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  scope?: string;
  providerTurnId?: string;
  model?: string;
}

export interface TallyContext {
  /** When set, a turn_end on another thread (a sub-agent) is not a bee turn. */
  rootThreadId: string | null;
}

const SEEN_MAX = 512;
const THREADS_MAX = 64;
const FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function startTokenTally(): TokenTally {
  return { version: 1, tokens: zero(), turns: 0, lastModel: null, cumulative: [], seen: [], turn: zero(), skipThrough: null };
}

export function beeTokenTotals(tally: TokenTally): BeeTokenTotals {
  return { tokens: { ...tally.tokens }, turns: tally.turns, lastModel: tally.lastModel };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function countsOf(usage: TallyEvent["usage"]): TokenCounts {
  return { input: count(usage?.input), output: count(usage?.output), cacheRead: count(usage?.cacheRead), cacheWrite: count(usage?.cacheWrite) };
}

function minus(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: Math.max(0, a.input - b.input), output: Math.max(0, a.output - b.output), cacheRead: Math.max(0, a.cacheRead - b.cacheRead), cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite) };
}

function max(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: Math.max(a.input, b.input), output: Math.max(a.output, b.output), cacheRead: Math.max(a.cacheRead, b.cacheRead), cacheWrite: Math.max(a.cacheWrite, b.cacheWrite) };
}

function addInto(into: TokenCounts, delta: TokenCounts): void {
  for (const field of FIELDS) into[field] += delta[field];
}

function bounded(map: Map<string, TokenCounts>, key: string, value: TokenCounts, bound: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > bound) map.delete(map.keys().next().value as string);
}

/**
 * The working form of a tally during one cut: Maps for O(1) dedupe, serialized
 * back to a plain TokenTally (the persisted shape) at each segment boundary.
 */
export class TokenTallyCounter {
  private readonly tally: TokenTally;
  private readonly cumulative: Map<string, TokenCounts>;
  private readonly seen: Map<string, TokenCounts>;

  constructor(tally: TokenTally) {
    this.tally = structuredClone(tally);
    this.cumulative = new Map(this.tally.cumulative);
    this.seen = new Map(this.tally.seen);
  }

  get skipThrough(): TokenTally["skipThrough"] {
    return this.tally.skipThrough;
  }

  set skipThrough(value: TokenTally["skipThrough"]) {
    this.tally.skipThrough = value;
  }

  snapshot(): TokenTally {
    return {
      ...this.tally,
      tokens: { ...this.tally.tokens },
      turn: { ...this.tally.turn },
      cumulative: [...this.cumulative].map(([key, value]) => [key, { ...value }]),
      seen: [...this.seen].map(([key, value]) => [key, { ...value }]),
      skipThrough: this.tally.skipThrough ? { ...this.tally.skipThrough } : null,
    };
  }

  /** Fold one line's projected events in. */
  push(events: readonly TallyEvent[], context: TallyContext): void {
    const tally = this.tally;
    for (const event of events) {
      if (event.kind === "turn_end") {
        if (event.parentThreadId !== undefined) continue;
        if (context.rootThreadId !== null && event.threadId !== undefined && event.threadId !== context.rootThreadId) continue;
        tally.turns += 1;
        tally.turn = zero();
        continue;
      }
      if (event.kind !== "token_usage") continue;
      if (typeof event.model === "string" && event.model.length > 0) tally.lastModel = event.model;
      const usage = countsOf(event.usage);
      const thread = event.threadId ?? "";
      if (event.scope === "cumulative") {
        const previous = this.cumulative.get(thread);
        const reset = previous === undefined || FIELDS.some((field) => usage[field] < previous[field]);
        addInto(tally.tokens, reset ? usage : minus(usage, previous));
        bounded(this.cumulative, thread, usage, THREADS_MAX);
        continue;
      }
      // A thread with a cumulative stream is fully counted by it.
      if (this.cumulative.has(thread)) continue;
      if (event.providerTurnId !== undefined) {
        const previous = this.seen.get(event.providerTurnId) ?? zero();
        const delta = minus(usage, previous);
        bounded(this.seen, event.providerTurnId, max(previous, usage), SEEN_MAX);
        addInto(tally.tokens, delta);
        addInto(tally.turn, delta);
        continue;
      }
      addInto(tally.tokens, minus(usage, tally.turn));
      tally.turn = max(tally.turn, usage);
    }
  }
}

/** Fold events into a persisted tally (convenience for one-shot use and tests). */
export function tallyEvents(tally: TokenTally, events: readonly TallyEvent[], context: TallyContext): TokenTally {
  const counter = new TokenTallyCounter(tally);
  counter.push(events, context);
  return counter.snapshot();
}

const isCounts = (value: unknown): value is TokenCounts => {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return FIELDS.every((field) => typeof record[field] === "number" && Number.isSafeInteger(record[field]) && (record[field] as number) >= 0);
};

const isEntries = (value: unknown): value is Array<[string, TokenCounts]> =>
  Array.isArray(value) && value.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isCounts(entry[1]));

/** Parse a persisted tally; anything malformed is unknown (null), never zeros. */
export function parseTokenTally(value: unknown): TokenTally | null {
  if (value === null || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (t.version !== 1 || !isCounts(t.tokens) || !isCounts(t.turn) || !isEntries(t.cumulative) || !isEntries(t.seen)) return null;
  if (typeof t.turns !== "number" || !Number.isSafeInteger(t.turns) || t.turns < 0) return null;
  if (t.lastModel !== null && typeof t.lastModel !== "string") return null;
  const skip = t.skipThrough as { path?: unknown; byteOffset?: unknown } | null;
  if (skip !== null && (typeof skip !== "object" || typeof skip.path !== "string" || typeof skip.byteOffset !== "number")) return null;
  return value as TokenTally;
}

/** Parse the totals stored on a bee row; malformed is unknown. */
export function parseBeeTokenTotals(value: unknown): BeeTokenTotals | null {
  if (value === null || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (!isCounts(t.tokens) || typeof t.turns !== "number" || !Number.isSafeInteger(t.turns) || t.turns < 0) return null;
  if (t.lastModel !== null && typeof t.lastModel !== "string") return null;
  return { tokens: { input: t.tokens.input, output: t.tokens.output, cacheRead: t.tokens.cacheRead, cacheWrite: t.tokens.cacheWrite }, turns: t.turns, lastModel: t.lastModel as string | null };
}
