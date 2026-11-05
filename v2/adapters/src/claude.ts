import { claudeQuotaBoundary, quotaSourceId } from "./quota.ts";
/**
 * Claude harness adapter (WP3) — normalizes the `claude -p --input-format
 * stream-json --output-format stream-json --verbose` NDJSON envelope.
 *
 * Stream format derived by reading the previous system's adapter
 * (src/hsr/adapters/claude.ts) and its live-captured fixture
 * (tests/fixtures/claude-stream-json.sample.jsonl, claude_code_version
 * 2.1.198). No code is imported from the old tree — the format knowledge is
 * re-encoded here and must be re-verified against a real stream in the manual
 * smoke (v2/driver-hsr/SMOKE.md).
 *
 * Envelope:
 *   {type:"system",subtype:"init",session_id,...}   — FIRST line; readiness + session id.
 *   {type:"system",subtype:"thinking_tokens",...}   — progress ping, no state signal.
 *   {type:"assistant",message:{content:[...]}}      — mid-turn output, no state signal.
 *   {type:"result",subtype,is_error,result,...}     — TURN END (also emitted for errors).
 *   {type:"rate_limit_event",rate_limit_info:{status,resetsAt,...}}
 *                                                   — status "allowed*" is benign/clearing;
 *                                                     anything else = out of quota.
 *   {type:"control_request",...}                    — interactive tool prompts; out of
 *                                                     WP3's four-state scope, ignored.
 *
 * State mapping (spec 03): init → booted (claude boots straight to
 * ready-for-input, so booted is followed by turn_ended — see types.ts);
 * result → turn_ended. turn_started is synthesized by the driver at the
 * moment it injects input (claude emits no explicit turn-start line).
 */
import {
  bootedToIdle,
  isAuthNeededMessage,
  isResourceBlockedMessage,
  isoFromEpochSeconds,
  parseJsonLine,
  successfulTurnClears,
  type AdapterSignal,
  type EncodeContext,
  type HarnessAdapter,
  type InterruptContext,
} from "./types.ts";
import { asObject, epochMsFromSeconds, nonEmptyString } from "./types.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  projectorCheckpoint, projectorFromTurns, restoreStateless,
  type TranscriptFamily, type TranscriptIsoTs, type TranscriptProjectedEvent, type TranscriptProjectedImage,
  type TranscriptProjector, type TranscriptTokenUsage, type TranscriptTurn, type TranscriptTurnRole,
} from "./transcript.ts";

/**
 * Map a `rate_limit_event`'s `rate_limit_info` to flag evidence. Verified
 * capture shape (old adapter): {status:"allowed"|"allowed_warning"|"rejected"|
 * "blocked"|…, resetsAt:<unix seconds>, rateLimitType, overageStatus, …}.
 * `status` is the gate: "allowed*" means quota is available (contrary
 * evidence → clear); any other status means the account is out of quota.
 */
function rateLimitSignals(rateLimitInfo: unknown): AdapterSignal[] {
  const info = asObject(rateLimitInfo);
  if (!info) return [];
  const status = typeof info.status === "string" ? info.status : undefined;
  if (!status) return [];
  if (status.startsWith("allowed")) {
    return [{ kind: "flag", flag: "resource_blocked", action: "clear", detail: `claude rate limit ${status}` }];
  }
  const reset = isoFromEpochSeconds(info.resetsAt);
  const resetsAt = epochMsFromSeconds(info.resetsAt);
  return [{
    kind: "flag",
    flag: "resource_blocked",
    action: "set",
    detail: `claude rate limit ${status}${reset ? `, resets ${reset}` : ""}`,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  }];
}

function resultSignals(msg: Record<string, unknown>): AdapterSignal[] {
  const signals: AdapterSignal[] = [];
  if (msg.is_error === true) {
    const message = String(msg.result ?? msg.api_error_status ?? "claude result error");
    if (msg.api_error_status === 401 || isAuthNeededMessage(message)) {
      signals.push({ kind: "flag", flag: "auth_needed", action: "set", detail: message.slice(0, 500) });
    } else if (isResourceBlockedMessage(message)) {
      signals.push({ kind: "flag", flag: "resource_blocked", action: "set", detail: message.slice(0, 500) });
    }
    // An errored turn still ENDS the turn (claude emits result either way),
    // but is not contrary evidence — no clears.
    signals.push({ kind: "turn_ended" });
    return signals;
  }
  signals.push(...successfulTurnClears());
  signals.push({ kind: "turn_ended" });
  return signals;
}

/**
 * Claude Code reports a failed API call as an assistant line it wrote itself
 * (`message.model: "<synthetic>"`, e.g. "Not logged in · Please run /login").
 * Only a line the provider produced is progress on the turn.
 */
function isProviderServed(msg: Record<string, unknown>): boolean {
  return asObject(msg.message)?.model !== "<synthetic>" && msg.error === undefined;
}

export function parseClaudeLine(line: string): AdapterSignal[] {
  const msg = parseJsonLine(line);
  if (!msg || typeof msg.type !== "string") return [];
  const quota = claudeQuotaBoundary(msg);
  if (quota) {
    const resetsAt = quota.resetsAt ?? (msg.type === "rate_limit_event" ? epochMsFromSeconds(asObject(msg.rate_limit_info)?.resetsAt) : undefined);
    const detail = msg.type === "rate_limit_event" ? `claude rate limit ${String(asObject(msg.rate_limit_info)?.status)}${resetsAt !== undefined ? `, resets ${new Date(resetsAt).toISOString()}` : ""}` : `claude quota exhausted: ${String(msg.result ?? "synthetic provider limit")}`;
    return [{ kind: "flag", flag: "resource_blocked", action: "set", detail, quota, ...(resetsAt !== undefined ? { resetsAt } : {}) }, ...(msg.type === "result" ? [{ kind: "turn_ended" } as const] : [])];
  }
  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return []; // thinking_tokens etc: progress pings
      const sessionId = typeof msg.session_id === "string" ? msg.session_id : undefined;
      return bootedToIdle(sessionId);
    }
    case "rate_limit_event":
      return rateLimitSignals(msg.rate_limit_info);
    case "result":
      return resultSignals(msg);
    case "assistant":
      // Usually mid-turn output — the driver dedupes by phase, so this is a
      // no-op while running. But a SELF-WOKEN turn (harness-internal wake:
      // background-task notifications, scheduled continuations) has no
      // delivery and no user message — assistant output on an idle runtime
      // is its ONLY opening edge. Without this, self-woken bees showed
      // idle/"needs your reply" while actively working (2026-08-19, observed
      // on the cutover executor itself).
      return isProviderServed(msg) ? [{ kind: "turn_started" }, { kind: "turn_progress" }] : [{ kind: "turn_started" }, ...(msg.error === "authentication_failed" ? [{ kind: "flag", flag: "auth_needed", action: "set", detail: "Claude authentication failed" } satisfies AdapterSignal] : [])];
    case "user":
    case "control_request": // interactive prompts are out of WP3 scope
    case "control_response":
      return [];
    default:
      return [];
  }
}

/** One stream-json user message line (the same shape the old system verified). */
export function encodeClaudeMessage(body: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: body }] },
  });
}

/**
 * Harness-native resume (spec 07 §F): `claude -p --resume <session_id>` rejoins
 * the headless conversation with full model context and keeps the SAME
 * session_id (the init line echoes it) — verified by the old system for
 * headless↔headless (docs/HSR_EXPLORATION.md 2026-07-03). Requires the process
 * to run with the CLAUDE_CONFIG_DIR the session was created under (the bee's
 * env carries it for imported bees). Never combined with `--session-id`.
 */
export function claudeResumeArgs(providerSessionId: string): string[] {
  return ["--resume", providerSessionId];
}

/**
 * v6 fork: `--resume <source> --fork-session` — claude rejoins the source
 * conversation with full context but mints a NEW session id for the child
 * (the init line reports it; the daemon records it on the fork). Without
 * `--fork-session` the resumed process keeps the SAME id and source + fork
 * would write one transcript (the old system's drivers.ts: "--fork-session
 * forks the resumed transcript"; claude refuses `--resume <id> --session-id
 * <new>` without it). Never combined with `--session-id` here — claude
 * mints; the adapter records.
 */
export function claudeForkArgs(sourceSessionId: string): string[] {
  return ["--resume", sourceSessionId, "--fork-session"];
}

/**
 * v6 interrupt — the stream-json control protocol (the OLD system's verified
 * shape, src/hsr/adapters/claude.ts encodeClaudeInterrupt): claude ends the
 * current turn (emitting its `result` line → turn_ended) and keeps the
 * session alive — unlike SIGINT, which kills the headless child. The
 * `control_response` ack parses to [] (unknown type) in parseClaudeLine.
 */
let interruptCounter = 0;
export function encodeClaudeInterrupt(): string {
  interruptCounter += 1;
  return JSON.stringify({
    type: "control_request",
    request_id: `hive-interrupt-${interruptCounter}`,
    request: { subtype: "interrupt" },
  });
}

export const claudeAdapter: HarnessAdapter = {
  harness: "claude",
  // Claude Code accepts additional stream-json user messages mid-turn and
  // queues them at its own safe boundary (verified by the old system's
  // nativeSteering path).
  acceptsMidTurn: true,
  reportsTurnProgress: true,
  readyAtSpawn: true,
  bootLines(): string[] {
    return [];
  },
  parseLine: parseClaudeLine,
  encodeMessage(body: string, ctx: EncodeContext): string | null {
    if (ctx.freshTurn && ctx.turnActive) return null;
    return encodeClaudeMessage(body);
  },
  resumeArgs: claudeResumeArgs,
  forkArgs: claudeForkArgs,
  encodeInterrupt(_ctx: InterruptContext): string | null {
    return encodeClaudeInterrupt();
  },
};

/**
 * Canonical cwd for cwd-derived transcript locator paths: resolved AND
 * realpathed. Harness CLIs key their transcript dirs off `process.cwd()`,
 * which the OS reports symlink-free — on macOS a `/var/...` spawn cwd
 * becomes `/private/var/...` inside the CLI (verified live 2026-08-17:
 * claude wrote `projects/-private-var-folders-...` while our raw-path key
 * bound nothing). Falls back to the resolved raw path when realpath throws
 * (path not created yet).
 */
export function canonicalCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** The v1 project-key derivation for a claude transcript dir (realpathed cwd). */
export function claudeProjectKey(cwd: string): string {
  return canonicalCwd(cwd).normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-");
}

type JsonObject = Record<string, unknown>;

/**
 * Content blocks (claude message.content and friends) → readable turns.
 * Text blocks join into one turn of `role`; tool blocks become one-liners.
 */
function turnsFromBlocks(role: TranscriptTurnRole, content: unknown): TranscriptTurn[] {
  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ role, text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const turns: TranscriptTurn[] = [];
  const texts: string[] = [];
  for (const b of content) {
    if (b == null || typeof b !== "object") continue;
    const block = b as Record<string, unknown>;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim().length > 0) texts.push(block.text);
        break;
      case "input_text":
      case "output_text":
        if (typeof block.text === "string" && block.text.trim().length > 0) texts.push(block.text);
        break;
      case "tool_use":
        turns.push({ role: "tool", text: `[tool_use: ${typeof block.name === "string" ? block.name : "?"}]` });
        break;
      case "tool_result":
        turns.push({ role: "tool", text: "[tool_result]" });
        break;
      case "thinking":
      case "redacted_thinking":
        break; // elided
      default:
        break;
    }
  }
  if (texts.length > 0) turns.unshift({ role, text: texts.join("\n") });
  return turns;
}

/**
 * claude — handles BOTH the native stream-json envelope the HSR driver logs
 * verbatim ({type:"assistant"|"user"|"result"|"system", message:{content}})
 * and the transcript-file rows (~/.claude/projects/…): the two shapes agree
 * on type + message.content. `result` rows duplicate the final assistant
 * text and are skipped; system/thinking rows are elided.
 */
function renderClaudeLine(line: string): TranscriptTurn[] {
  const row = parseJsonLine(line);
  if (!row) return [];
  if (row.isSidechain === true || row.isMeta === true || claudeQuotaBoundary(row)) return [];
  const message = row.message as { content?: unknown } | undefined;
  if (row.type === "user") return turnsFromBlocks("user", message?.content);
  if (row.type === "assistant") return turnsFromBlocks("assistant", message?.content);
  return [];
}

/**
 * An unknown harness falls back to the claude-shaped projector (the most
 * common envelope) — callers can always reach the verbatim lines with `--raw`.
 */
export function claudeShapedProjector(harness: string): TranscriptProjector {
  return projectorFromTurns("claude", renderClaudeLine, harness);
}

/**
 * Claude stream-json pane projection (G3 completion, 2026-08-21).
 *
 * The codex and grok G3 slices shipped rich stateful projectors while claude
 * kept the text-only renderer fallback — which maps every tool block to
 * `unknown`, so panes on the typed feed showed messages but LOST tool calls
 * (the post-cutover "transcripts aren't showing, especially tool calls"
 * regression). This projector restores parity from the same published
 * session-log lines.
 *
 * Line shapes (HSR stream-json, both directions in one log):
 *  - user     {message.content: string | blocks} — plain text is the operator
 *    prompt (turn boundary); tool_result blocks are tool completions.
 *  - assistant {message.content: blocks} — text / thinking / tool_use. Each
 *    line repeats the API response's `message.usage`; interactive sessions
 *    never write a `result` row, so this is the only usage source there. One
 *    API message spans several assistant lines (one per block) with the SAME
 *    `message.id` and identical usage — the projection carries that id as
 *    `providerTurnId` so consumers deduplicate instead of over-counting.
 *  - result   {subtype, usage, stop_reason, duration_ms} — the turn boundary
 *    close, with turn-scoped usage (`claude -p` runs only). `is_error: true`
 *    rows also project an `interrupt` carrying the CLI's `errors`/`result`
 *    text, so a halted turn (failed resume, auth, provider wall) is visible.
 *
 * Stateless per line (claude lines are complete messages); the projector
 * interface stays stateful-shaped for uniformity with codex/grok.
 */

/**
 * HSR stream-json lines carry no wall-clock timestamp (the feed orders by
 * line); native session-file lines carry an ISO `timestamp`. Each line's
 * events take the line's stamp when it has one.
 */
const NO_TS: TranscriptIsoTs = null;

/**
 * The readable reason of an errored `result` row (`is_error: true`): the
 * CLI's `errors` list (e.g. "No conversation found with session ID: …" on a
 * failed --resume), else its `result` text, else the subtype.
 */
function resultErrorReason(row: JsonObject): string | undefined {
  if (row.is_error !== true) return undefined;
  const errors = Array.isArray(row.errors)
    ? row.errors.filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    : [];
  if (errors.length > 0) return errors.join("; ");
  return nonEmptyString(row.result) ?? nonEmptyString(row.subtype) ?? "claude result error";
}

function lineTimestamp(row: JsonObject): TranscriptIsoTs {
  const raw = row.timestamp;
  if (typeof raw === "string" && !Number.isNaN(Date.parse(raw))) return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return NO_TS;
}

const NOISE_TYPES = new Set(["rate_limit_event", "tool_progress", "stream_event"]);
const IMAGE_META_RE = /^\[Image:\s*original\s+\d+x\d+(?:,[^\]]*)?\]\s*$/i;
const IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_PROJECTED_IMAGES = 8;
/** Keeps one canonical event comfortably below Apiary's 32 MiB peer frame. */
const MAX_PROJECTED_IMAGE_DATA_CHARS = 24 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const value of content) {
    if (typeof value === "string") {
      parts.push(value);
      continue;
    }
    const block = asObject(value);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function imagesFromContent(content: unknown): TranscriptProjectedImage[] {
  if (!Array.isArray(content)) return [];
  const images: TranscriptProjectedImage[] = [];
  let retainedChars = 0;
  for (const value of content) {
    if (images.length >= MAX_PROJECTED_IMAGES) break;
    const block = asObject(value);
    if (block?.type !== "image") continue;
    const source = asObject(block.source);
    const mimeType = nonEmptyString(source?.media_type);
    const data = nonEmptyString(source?.data);
    if (
      source?.type !== "base64" ||
      !mimeType ||
      !IMAGE_MIME_TYPES.has(mimeType) ||
      !data ||
      data.length % 4 !== 0 ||
      !BASE64_RE.test(data) ||
      retainedChars + data.length > MAX_PROJECTED_IMAGE_DATA_CHARS
    ) {
      continue;
    }
    images.push({ data, mimeType });
    retainedChars += data.length;
  }
  return images;
}

function usageFrom(raw: unknown): TranscriptTokenUsage | null {
  const usage = asObject(raw);
  if (!usage) return null;
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const out: TranscriptTokenUsage = {
    ...(num(usage.input_tokens) !== undefined ? { input: num(usage.input_tokens) } : {}),
    ...(num(usage.output_tokens) !== undefined ? { output: num(usage.output_tokens) } : {}),
    ...(num(usage.cache_read_input_tokens) !== undefined
      ? { cacheRead: num(usage.cache_read_input_tokens) }
      : {}),
    ...(num(usage.cache_creation_input_tokens) !== undefined
      ? { cacheWrite: num(usage.cache_creation_input_tokens) }
      : {}),
  };
  return Object.keys(out).length > 0 ? out : null;
}

/** The `modelUsage` entry that cost the most (haiku side-calls ride along). */
function dominantModel(modelUsage: JsonObject | undefined): string | undefined {
  if (!modelUsage) return undefined;
  let best: { model: string; cost: number } | undefined;
  for (const [key, value] of Object.entries(modelUsage)) {
    const entry = asObject(value);
    const cost = typeof entry?.costUSD === "number" && Number.isFinite(entry.costUSD) ? entry.costUSD : 0;
    const model = nonEmptyString(entry?.canonicalModel) ?? key;
    if (!best || cost > best.cost) best = { model, cost };
  }
  return best?.model;
}

export function createClaudeProjector(): TranscriptProjector {
  return {
    harness: "claude",
    checkpoint: () => projectorCheckpoint("claude", {}),
    pushLine(line: string): TranscriptProjectedEvent[] {
      const row = parseJsonLine(line);
      if (!row) return [];
      const type = nonEmptyString(row.type);
      const quota = claudeQuotaBoundary(row);
      const quotaEvents: TranscriptProjectedEvent[] = quota
        ? [{ kind: "quota", ts: lineTimestamp(row), quota, sourceId: nonEmptyString(row.uuid) ?? quotaSourceId(line), raw: row, operational: true }]
        : [];
      if (quota && type !== "result") return quotaEvents;
      if (!type || NOISE_TYPES.has(type)) return [];
      const providerEventId = nonEmptyString(row.uuid);
      const ts = lineTimestamp(row);

      if (type === "user") {
        const message = asObject(row.message);
        const content = message?.content;
        const events: TranscriptProjectedEvent[] = [];
        // Tool completions ride user-role lines as tool_result blocks.
        if (Array.isArray(content)) {
          for (const value of content) {
            const block = asObject(value);
            if (block?.type !== "tool_result") continue;
            // Real claude blocks always carry ids; a missing one (synthetic
            // or truncated logs) must not vanish — same fallback discipline
            // as the codex projector's itemCallId.
            const callId = nonEmptyString(block.tool_use_id) ?? "claude:tool_result:unknown";
            const output = textFromContent(block.content);
            const images = imagesFromContent(block.content);
            events.push({
              kind: "tool_result",
              ts,
              callId,
              isError: block.is_error === true,
              ...(output.trim().length > 0 ? { output } : {}),
              ...(images.length > 0 ? { images } : {}),
            });
          }
        }
        if (events.length > 0) return events;
        const text = textFromContent(content);
        // A meta row is never an operator prompt. Current Claude versions mark
        // the dimensions echo after an image result as `isSynthetic` instead
        // of `isMeta`; suppress that exact provider-owned shape as well.
        if (
          row.isMeta === true ||
          (row.isSynthetic === true && IMAGE_META_RE.test(text.trim()))
        ) return [];
        if (text.trim().length === 0) return [];
        return [
          { kind: "turn_start", ts },
          {
            kind: "message",
            ts,
            role: "user",
            text,
            ...(providerEventId ? { providerEventId } : {}),
          },
        ];
      }

      if (type === "assistant") {
        const message = asObject(row.message);
        const content = message?.content;
        // Assistant lines repeat the API response usage; providerTurnId is
        // the API message id shared by every line of that message (dedupe key).
        const usage = usageFrom(message?.usage);
        const messageId = nonEmptyString(message?.id);
        const model = nonEmptyString(message?.model);
        const usageEvents: TranscriptProjectedEvent[] = usage
          ? [{
              kind: "token_usage",
              ts,
              usage,
              scope: "turn",
              ...(messageId ? { providerTurnId: messageId } : {}),
              ...(model ? { model } : {}),
            }]
          : [];
        // String-content assistant messages are legitimate API shape.
        if (typeof content === "string") {
          const text = nonEmptyString(content);
          return text
            ? [{
                kind: "message",
                ts,
                role: "assistant",
                text,
                ...(providerEventId ? { providerEventId } : {}),
              }, ...usageEvents]
            : usageEvents;
        }
        if (!Array.isArray(content)) return usageEvents;
        const events: TranscriptProjectedEvent[] = [];
        for (const value of content) {
          const block = asObject(value);
          if (!block) continue;
          switch (block.type) {
            case "text": {
              const text = nonEmptyString(block.text);
              if (text) {
                events.push({
                  kind: "message",
                  ts,
                  role: "assistant",
                  text,
                  ...(providerEventId ? { providerEventId } : {}),
                });
              }
              break;
            }
            case "thinking": {
              const text = nonEmptyString(block.thinking);
              // Signature-only blocks are encrypted reasoning: present, but
              // its text is unavailable — the load-bearing redacted shape.
              events.push(
                text
                  ? { kind: "thinking", ts, redacted: false, text }
                  : { kind: "thinking", ts, redacted: true },
              );
              break;
            }
            case "redacted_thinking":
              events.push({ kind: "thinking", ts, redacted: true });
              break;
            case "tool_use": {
              events.push({
                kind: "tool_call",
                ts,
                callId: nonEmptyString(block.id) ?? "claude:tool_use:unknown",
                name: nonEmptyString(block.name) ?? "tool",
                ...(block.input !== undefined ? { input: block.input } : {}),
              });
              break;
            }
            default:
              break; // image/document blocks etc: no pane row yet
          }
        }
        events.push(...usageEvents);
        return events;
      }

      if (type === "result") {
        const events: TranscriptProjectedEvent[] = [...quotaEvents];
        const usage = usageFrom(row.usage);
        if (usage) {
          // The turn total (sum of the assistant lines above it) plus the
          // harness's own dollar figure and dominant billed model — a
          // consumer holding the per-message rows treats this as superseding.
          const costUsd =
            typeof row.total_cost_usd === "number" && Number.isFinite(row.total_cost_usd)
              ? row.total_cost_usd
              : undefined;
          const model = dominantModel(asObject(row.modelUsage));
          events.push({
            kind: "token_usage",
            ts,
            usage,
            scope: "turn",
            ...(model ? { model } : {}),
            ...(costUsd !== undefined ? { costUsd } : {}),
          });
        }
        const durationMs =
          typeof row.duration_ms === "number" && Number.isFinite(row.duration_ms)
            ? row.duration_ms
            : undefined;
        // An errored result is the harness halting the turn — resume/fork of
        // a conversation the config dir does not hold, auth, provider walls.
        // Its reason is otherwise dropped (turn_end carries no error), so the
        // pane showed an empty turn and a crashed bee with no explanation.
        const halt = resultErrorReason(row);
        if (halt && !quota) events.push({ kind: "interrupt", ts, reason: halt });
        events.push({
          kind: "turn_end",
          ts,
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(nonEmptyString(row.stop_reason) ? { finishReason: nonEmptyString(row.stop_reason) } : {}),
        });
        return events;
      }

      // system init/subtypes are lifecycle + progress chatter, not pane rows.
      if (type === "system") return [];

      return [{ kind: "unknown", ts, nativeType: type }];
    },
    flush(): TranscriptProjectedEvent[] {
      return [];
    },
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function preserveContextUsage(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  let contextInputTokens: number | undefined;
  if (row.type === "assistant" && row.isSidechain !== true) {
    const usage = asObject(asObject(row.message)?.usage);
    const input = tokenCount(usage?.input_tokens);
    const read = tokenCount(usage?.cache_read_input_tokens);
    const write = tokenCount(usage?.cache_creation_input_tokens);
    if (input !== undefined) contextInputTokens = tokenCount(input + (read ?? 0) + (write ?? 0));
  }
  if (contextInputTokens === undefined) return events;
  return events.map((event) => event.kind === "token_usage" ? { ...event, contextInputTokens } : event);
}

const CLAUDE_COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";

function preserveCompaction(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
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

function preserveMetadata(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  events = preserveContextUsage(row, events);
  events = preserveCompaction(row, events);
  if (row.isSidechain === true) {
    const agentId = nonEmptyString(row.agentId) ?? "unattributed";
    return events.map((event) => event.kind === "unknown" ? event : ({ ...event,
      threadId: `sidechain:${agentId}`, parentThreadId: "root" }));
  }
  let phase: "final" | "intermediate" | undefined;
  if (row.type === "assistant") {
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
    if (row.type === "result" && event.kind === "turn_end") {
      return { ...event, finishReason: event.finishReason ?? "result",
        ...(row.is_error === true ? { interrupted: true } : {}) };
    }
    return event;
  });
}

function queuedCommandMessage(row: JsonObject, ts: string | null): TranscriptProjectedEvent | null {
  if (
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

function repairQueuedCommand(row: JsonObject, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  if (events.some((event) => event.kind === "message" && event.role === "user")) {
    return events;
  }
  const unknownIndex = events.findIndex(
    (event) => event.kind === "unknown" && event.nativeType === "attachment",
  );
  if (unknownIndex < 0) return events;

  const replacement = queuedCommandMessage(row, events[unknownIndex]!.ts);
  if (!replacement) return events;
  return events.map((event, index) => index === unknownIndex ? replacement : event);
}

export function repairClaudeLine(line: string, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[] {
  const row = parseJsonLine(line);
  if (!row) return events;
  return repairQueuedCommand(row, preserveMetadata(row, events));
}

export const claudeTranscripts: TranscriptFamily = {
  harness: "claude",
  createProjector: createClaudeProjector,
  restoreProjector: (state) => restoreStateless(state, createClaudeProjector),
  repair: repairClaudeLine,
};
