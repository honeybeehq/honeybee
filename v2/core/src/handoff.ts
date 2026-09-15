/**
 * Session handoff helpers (schema v23). Pure: keys, hashing, phase graph,
 * view projection, the extractive context builder and the seed text the
 * fresh provider thread is opened with. Durable rows live in the core store;
 * the daemon reads the transcript and drives the phases.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "./registry.ts";
import {
  BEE_HANDOFF_TRANSITIONS,
  type BeeHandoffPhase,
  type BeeHandoffRow,
  type BeeHandoffStopAt,
  type BeeHandoffView,
  type HandoffContext,
  type HandoffContextTurn,
  type MessageRow,
  type QuestionRow,
  type SealRow,
  type TaskRow,
  type TranscriptSegmentRow,
} from "./types.ts";

export const HANDOFF_SEED_MARKER =
  "[Hive handoff context. This bee continues earlier work under a fresh provider thread; the summary below is workspace context, not a user task.]";

/** The sender the seed mailbox row is attributed to (delivered bare, never enveloped as peer mail). */
export const HANDOFF_SEED_SENDER = "hive:handoff";

/** Bounded artifact sizes: the artifact rides the mailbox and the mirror. */
export const HANDOFF_MAX_RECENT_TURNS = 24;
export const HANDOFF_MAX_TURN_CHARS = 2_000;
export const HANDOFF_MAX_LIST_ITEMS = 16;
export const HANDOFF_MAX_ITEM_CHARS = 600;
export const HANDOFF_TRANSCRIPT_TAIL_BYTES = 512 * 1024;

export function beeHandoffStopKey(handoffId: string, generation: number): string {
  return `handoff:${handoffId}:stop:g${generation}`;
}

export function beeHandoffReviveKey(handoffId: string): string {
  return `handoff:${handoffId}:revive`;
}

export interface HandoffRequestShape {
  beeId: string;
  expected: { generation: number; agent?: string };
  target: { agent: string; args: string[] | null; account: string | null };
  instruction: string | null;
  stopAt: BeeHandoffStopAt;
}

export function hashBeeHandoffRequest(input: HandoffRequestShape): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function beeHandoffTransitionLegal(from: BeeHandoffPhase, to: BeeHandoffPhase): boolean {
  return from === to || (BEE_HANDOFF_TRANSITIONS[from] as readonly string[]).includes(to);
}

/** A handoff that still owns the bee's execution boundary (fences wakes/starts/delivery). */
export function handoffFencesSource(phase: BeeHandoffPhase): boolean {
  return phase === "stopping" || phase === "summarizing";
}

/** Locked RPC/mirror projection. Drops operational store fields. */
export function toBeeHandoffView(row: BeeHandoffRow): BeeHandoffView {
  return {
    id: row.id,
    beeId: row.beeId,
    phase: row.phase,
    sourceGeneration: row.sourceGeneration,
    targetGeneration: row.targetGeneration,
    from: row.from,
    to: row.to,
    instruction: row.instruction,
    stopAt: row.stopAt,
    seedMessageId: row.seedMessageId,
    context: row.context,
    failure: row.failure,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Session log file for a segment > 0: `<dir>/<beeId>.s<ordinal>.jsonl` (segment 0 keeps `<beeId>.jsonl`). */
export function segmentSessionLogPath(basePath: string | null, ordinal: number): string | null {
  if (basePath == null) return null;
  if (ordinal === 0) return basePath;
  const stripped = basePath.replace(/\.s\d+\.jsonl$/, ".jsonl");
  return stripped.endsWith(".jsonl")
    ? `${stripped.slice(0, -".jsonl".length)}.s${ordinal}.jsonl`
    : `${stripped}.s${ordinal}`;
}

function clip(text: string, max: number): string {
  // Consume each multi-character whitespace run once; retrying a newline match at every
  // space can stall the daemon on a long line without a newline.
  const normalized = text.includes("\n")
    ? text.replace(/\s{2,}/g, (run) => {
        const newline = run.lastIndexOf("\n");
        return newline < 0 ? run : run.slice(newline);
      })
    : text;
  const t = normalized.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function uniqueBounded(items: string[], max = HANDOFF_MAX_LIST_ITEMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = clip(raw, HANDOFF_MAX_ITEM_CHARS);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

const DECISION_RE = /\b(decid(ed|ing)|chose|choosing|going with|settled on|instead of|opted (for|to)|will use|switch(ed|ing) to)\b/i;
const CONSTRAINT_RE = /\b(must|never|do not|don't|should not|only|avoid|require[sd]?|constraint|keep (changes|it) within)\b/i;

export interface ExtractiveHandoffInput {
  bee: { id: string; name: string; title: string | null; cwd: string; substrate: string; agent: string; args: string[] | null; cellId: string | null };
  target: { agent: string; args: string[] | null };
  instruction: string | null;
  /** Readable turns of the source transcript (rendered by the SOURCE harness), oldest first. */
  turns: HandoffContextTurn[];
  transcriptTruncated: boolean;
  segments: TranscriptSegmentRow[];
  messages: MessageRow[];
  seals: SealRow[];
  tasks: TaskRow[];
  questions: QuestionRow[];
  now: number;
}

/**
 * Deterministic, dependency-free context builder. Heuristic by design and
 * labeled `extractive`; an LLM-backed summarizer can replace it through the
 * daemon's `summarizeHandoff` hook and label itself accordingly.
 */
export function buildExtractiveHandoffContext(input: ExtractiveHandoffInput): HandoffContext {
  const delivered = input.messages.filter((m) => m.deliveredAt != null);
  const queued = input.messages.filter((m) => m.deliveredAt == null);
  const firstOperator = delivered.find((m) => m.sender === "operator" || m.sender.startsWith("human:"))
    ?? delivered[0];
  const firstUserTurn = input.turns.find((t) => t.role === "user");
  const task = firstOperator?.body ?? firstUserTurn?.text ?? input.bee.title ?? null;

  const constraints: string[] = [];
  if (input.instruction) constraints.push(`Operator instruction: ${input.instruction}`);
  constraints.push(`Working directory: ${input.bee.cwd}${input.bee.substrate === "cell" ? " (an isolated Cell checkout; keep changes inside it)" : ""}`);
  if (input.bee.agent !== input.target.agent) {
    constraints.push(`Harness changed from ${input.bee.agent} to ${input.target.agent}; earlier harness-specific tool names or commands may not apply.`);
  }
  for (const m of delivered) {
    for (const line of m.body.split("\n")) {
      if (CONSTRAINT_RE.test(line) && line.trim().length > 12) constraints.push(line);
    }
  }

  const decisions: string[] = [];
  for (const t of input.turns) {
    if (t.role !== "assistant") continue;
    for (const sentence of t.text.split(/(?<=[.!?])\s+|\n+/)) {
      if (DECISION_RE.test(sentence) && sentence.trim().length > 12) decisions.push(sentence);
    }
  }

  const completed: string[] = [];
  for (const seal of input.seals) {
    completed.push(`Seal "${seal.title}": ${seal.body}${seal.refs.length > 0 ? ` (refs: ${seal.refs.join(", ")})` : ""}`);
  }
  for (const t of input.tasks) if (t.status === "done") completed.push(`Task done: ${t.title}`);
  const lastAssistant = [...input.turns].reverse().find((t) => t.role === "assistant");
  if (lastAssistant) completed.push(`Last assistant message: ${lastAssistant.text}`);

  const outstanding: string[] = [];
  for (const t of input.tasks) {
    if (t.status === "pending" || t.status === "queued" || t.status === "in-progress" || t.status === "blocked") {
      outstanding.push(`Task ${t.status}: ${t.title}${t.blockedReason ? ` (blocked: ${t.blockedReason})` : ""}`);
    }
  }
  for (const q of input.questions) if (q.status === "open") outstanding.push(`Open question to the operator: ${q.text}`);
  if (queued.length > 0) outstanding.push(`${queued.length} queued mailbox message(s) follow this context and must be handled in order.`);

  const recent = input.turns.slice(-HANDOFF_MAX_RECENT_TURNS).map((t) => ({ role: t.role, text: clip(t.text, HANDOFF_MAX_TURN_CHARS) }));
  return {
    version: 1,
    summarizer: "extractive",
    generatedAt: input.now,
    task: task == null ? null : clip(task, HANDOFF_MAX_TURN_CHARS),
    instruction: input.instruction,
    constraints: uniqueBounded(constraints),
    decisions: uniqueBounded(decisions),
    completedWork: uniqueBounded(completed),
    outstandingWork: uniqueBounded(outstanding),
    recentTurns: recent,
    transcript: {
      segments: input.segments.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        harness: s.harness,
        providerSessionId: s.providerSessionId,
        path: s.path,
        fromGeneration: s.fromGeneration,
        toGeneration: s.toGeneration,
      })),
      truncated: input.transcriptTruncated,
    },
    mailbox: {
      summarizedMessageIds: delivered.map((m) => m.id),
      queuedMessageIds: queued.map((m) => m.id),
    },
  };
}

/** The first turn the fresh provider thread receives: the artifact, rendered. */
export function renderHandoffSeed(context: HandoffContext, opts: { beeName: string; fromAgent: string; toAgent: string }): string {
  const lines: string[] = [HANDOFF_SEED_MARKER, ""];
  lines.push(`You are continuing bee "${opts.beeName}" (previously run by ${opts.fromAgent}, now ${opts.toAgent}).`);
  if (context.instruction) lines.push("", "## Operator instruction", context.instruction);
  lines.push("", "## Task", context.task ?? "(no recorded task; see recent turns)");
  const section = (title: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push("", `## ${title}`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section("Constraints", context.constraints);
  section("Decisions so far", context.decisions);
  section("Completed work", context.completedWork);
  section("Outstanding work", context.outstandingWork);
  if (context.recentTurns.length > 0) {
    lines.push("", `## Recent transcript${context.transcript.truncated ? " (tail; earlier history truncated)" : ""}`);
    for (const t of context.recentTurns) lines.push(`[${t.role}] ${t.text}`);
  }
  if (context.transcript.segments.length > 0) {
    lines.push("", "## Transcript references");
    for (const s of context.transcript.segments) {
      lines.push(`- segment ${s.ordinal} (${s.harness}${s.providerSessionId ? `, thread ${s.providerSessionId}` : ""}, generations ${s.fromGeneration}–${s.toGeneration ?? "open"})${s.path ? `: ${s.path}` : ""}`);
    }
  }
  if (context.mailbox.queuedMessageIds.length > 0) {
    lines.push("", `Queued messages ${context.mailbox.queuedMessageIds.join(", ")} follow this context in order; treat them as the next instructions.`);
  }
  return lines.join("\n");
}
