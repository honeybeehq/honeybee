import type { QuotaBoundary } from "../../core/src/quota.ts";
import type { ContextBaselineObservation, ContextInventory, ContextSnapshot, ContextSnapshotInvalidation } from "./transcript-context.ts";
/**
 * Pane-ready transcript projection (G3).
 *
 * One stateful projector per harness consumes published session-log JSONL and
 * emits canonical events. The union is a geometry-blind payload: apiaryd stores
 * one feed row per line with the events array and synthesizes ids
 * `beeId:lineNo:idx`. Projectors MUST NOT infer lifecycle, attention, or
 * permission — no `needs_input` kind.
 *
 * Shape is a pure map onto Apiary's AgentEvent (minus id/harness/raw; threadId
 * optional here, root fallback on the Apiary side). Confirmed CL.7920 2026-08-20.
 *
 * ts is ISO-8601 or null. Epoch fields on the wire (emittedAtMs, startedAtMs,
 * completedAtMs) convert here. Unknown completed item types become `unknown`
 * with nativeType — never dropped silently, never bee state.
 */
export type TranscriptIsoTs = string | null;

export type TranscriptMessageRole = "user" | "assistant" | "system" | "developer";

export type TranscriptTokenUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  total?: number;
};

export type TranscriptFileChange = {
  path: string;
  changeKind?: string;
  oldPath?: string;
  diff?: string;
  addedLines?: number;
  removedLines?: number;
};

/** Bounded inline image bytes emitted by a harness tool result. */
export type TranscriptProjectedImage = {
  data: string;
  mimeType: string;
};

type Base = { ts: TranscriptIsoTs; threadId?: string; parentThreadId?: string };

export type TranscriptProjectedEvent =
  | (Base & { kind: "quota"; quota: QuotaBoundary; sourceId: string; raw: unknown; operational: true })
  | (Base & { kind: "turn_start"; turnId?: string })
  | (Base & { kind: "turn_end"; turnId?: string; durationMs?: number; finishReason?: string; interrupted?: boolean })
  | (Base & { kind: "interrupt"; reason?: string })
  | (Base & {
      kind: "message";
      role: TranscriptMessageRole;
      text: string;
      providerEventId?: string;
      answerPhase?: "final" | "intermediate";
      isCompactSummary?: boolean;
    })
  | (Base & { kind: "thinking"; redacted: boolean; text?: string })
  | (Base & { kind: "tool_call"; callId: string; name: string; input?: unknown })
  | (Base & {
      kind: "tool_result";
      callId: string;
      isError: boolean;
      output?: string;
      name?: string;
      images?: TranscriptProjectedImage[];
    })
  | (Base & {
      kind: "shell";
      callId: string;
      status: "started" | "completed";
      command?: string;
      cwd?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      durationMs?: number;
    })
  | (Base & { kind: "file_edit"; callId?: string; files: TranscriptFileChange[] })
  | (Base & { kind: "web_search"; itemId?: string; providerEventId?: string; query?: string })
  | (Base & {
      kind: "token_usage";
      /** `input` is UNCACHED input everywhere (OpenAI/xAI-shaped counts, which
       * fold cached reads into input, are normalized by their projectors). */
      usage: TranscriptTokenUsage;
      scope?: string;
      providerTurnId?: string;
      /** Provider model id the usage was billed against, when the log says. */
      model?: string;
      /** Provider-reported USD for this usage (claude `result` rows), when present. */
      costUsd?: number;
      contextInputTokens?: number;
      contextFirstRequest?: boolean;
      contextTurnId?: string;
      modelContextWindow?: number;
    })
  | (Base & { kind: "compaction"; trigger?: string; tokensBefore?: number; tokensAfter?: number; contextInventory?: ContextInventory; contextSnapshotInvalidation?: ContextSnapshotInvalidation })
  | (Base & {
      kind: "unknown";
      nativeType: string;
      detail?: string;
      contextBaseline?: ContextBaselineObservation;
      contextInventory?: ContextInventory;
      contextSnapshot?: ContextSnapshot;
      contextSnapshotInvalidation?: ContextSnapshotInvalidation;
    });

/**
 * Incremental contract, identical to Apiary TranscriptNormalizer push/flush:
 * pushLine returns events derivable so far; flush emits held pairing/chunks.
 */
export interface TranscriptProjector {
  /** Projection dialect. For fallback projectors this can differ from the registry key.
   * Pass the identical requested key to create/restore; checkpoint().harness retains it. */
  readonly harness: string;
  pushLine(line: string): TranscriptProjectedEvent[];
  flush(): TranscriptProjectedEvent[];
  /** Detached snapshot; does not flush or change subsequent projection. */
  checkpoint(): TranscriptProjectorCheckpoint;
}

export interface TranscriptFamily {
  readonly harness: string;
  createProjector(): TranscriptProjector;
  restoreProjector(state: unknown): TranscriptProjector | undefined;
  repair?(line: string, events: TranscriptProjectedEvent[]): TranscriptProjectedEvent[];
}

export type TranscriptTurnRole = "user" | "assistant" | "tool" | "system";

export interface TranscriptTurn {
  role: TranscriptTurnRole;
  text: string;
}

export interface TranscriptTurnStream {
  pushLine(line: string): TranscriptTurn[];
  flush(): TranscriptTurn[];
}

export function turnsFromProjectedEvent(event: TranscriptProjectedEvent): TranscriptTurn[] {
  switch (event.kind) {
    case "quota": return [];
    case "message":
      return event.role === "developer" ? [] : [{ role: event.role, text: event.text }];
    case "shell":
      if (event.status === "started") {
        return [{ role: "tool", text: `[command: ${event.command ?? "?"}]` }];
      }
      return [{
        role: "tool",
        text: `[command_result: ${event.exitCode === undefined ? "?" : `exit ${event.exitCode}`}]`,
      }];
    case "tool_call":
      return [{ role: "tool", text: `[tool_use: ${event.name}]` }];
    case "tool_result":
      return [{ role: "tool", text: `[tool_result]` }];
    case "file_edit": {
      const paths = event.files.map((file) => file.path);
      return [{ role: "tool", text: paths.length > 0 ? `[file_change: ${paths.join(", ")}]` : "[file_change]" }];
    }
    case "web_search":
      return [{ role: "tool", text: `[web_search${event.query ? `: ${event.query}` : ""}]` }];
    case "compaction":
      return [{ role: "system", text: `[compaction${event.trigger ? `: ${event.trigger}` : ""}]` }];
    case "interrupt":
      return [{ role: "system", text: `[interrupt${event.reason ? `: ${event.reason}` : ""}]` }];
    case "unknown":
      return event.nativeType === "rendered_tool" && event.detail
        ? [{ role: "tool", text: event.detail }]
        : [];
    case "thinking":
    case "token_usage":
    case "turn_start":
    case "turn_end":
      return [];
  }
}

/** The most recent assistant turn's text, or null. */
export function lastAssistantText(turns: readonly TranscriptTurn[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i] as TranscriptTurn;
    if (turn.role === "assistant") return turn.text;
  }
  return null;
}

// checkpoint-digest:start
/** Bump for event semantic changes; stored projections must then be rebuilt. */
export const TRANSCRIPT_PROJECTION_VERSION = 8;
/** Bump for checkpoint schema changes. Restore deliberately does not migrate. */
export const TRANSCRIPT_PROJECTOR_STATE_VERSION = 5;
export const TRANSCRIPT_CHECKPOINT_MAX_BYTES = 4 * 1024 * 1024;

export interface TranscriptProjectorCheckpoint {
  harness: string;
  projectionVersion: number;
  stateVersion: number;
  /** Provider-owned JSON. Consumers must not interpret this value. */
  state: unknown;
}
export type TranscriptProjectorRestoreFailure =
  | "invalid_checkpoint"
  | "harness_mismatch"
  | "projection_version_mismatch"
  | "state_version_mismatch"
  | "state_too_large";
export type TranscriptProjectorRestoreResult =
  | { ok: true; projector: TranscriptProjector }
  | { ok: false; reason: TranscriptProjectorRestoreFailure };

export function projectorCheckpoint(harness: string, state: unknown): TranscriptProjectorCheckpoint {
  return {
    harness,
    projectionVersion: TRANSCRIPT_PROJECTION_VERSION,
    stateVersion: TRANSCRIPT_PROJECTOR_STATE_VERSION,
    state: structuredClone(state),
  };
}

export type CheckpointValidator = (value: unknown) => boolean;
export const checkpointString: CheckpointValidator = (value) => typeof value === "string";
export const checkpointBoolean: CheckpointValidator = (value) => typeof value === "boolean";
export const checkpointNumber: CheckpointValidator = (value) => typeof value === "number" && Number.isFinite(value);
export const checkpointNullable = (validate: CheckpointValidator): CheckpointValidator =>
  (value) => value === null || validate(value);
export const checkpointStrings: CheckpointValidator = (value) =>
  Array.isArray(value) && value.every(checkpointString) && new Set(value).size === value.length;

/** Exact owned records. Arbitrary provider payloads use checkpointJson instead. */
export function checkpointRecord(value: unknown, fields: Record<string, CheckpointValidator>): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length === Object.keys(fields).length
    && entries.every(([key, entry]) => Object.hasOwn(fields, key) && fields[key]!(entry));
}
export const checkpointEntries = (validate: CheckpointValidator): CheckpointValidator => (value) =>
  Array.isArray(value)
  && value.every((entry) => Array.isArray(entry) && entry.length === 2
    && typeof entry[0] === "string" && validate(entry[1]))
  && new Set(value.map((entry) => entry[0])).size === value.length;

/** Reject lossy/non-JSON values, cycles, accessors and exotic object instances. */
export function checkpointJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  ancestors.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    if (Array.isArray(value) && (keys.length !== value.length + 1
      || keys.some((key, index) => index < value.length ? key !== String(index) : key !== "length"))) return false;
    return keys.every((key) => {
      if (Array.isArray(value) && key === "length") return true;
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable === true && "value" in descriptor
        && checkpointJson(descriptor.value, ancestors);
    });
  } finally {
    ancestors.delete(value);
  }
}

export type TranscriptCheckpointSerializationResult =
  | { ok: true; json: string; bytes: number }
  | { ok: false; reason: "invalid_checkpoint" | "state_too_large" };

/** Serialize verbatim for persistence, with the same JSON/byte checks as restore. */
export function serializeTranscriptCheckpoint(checkpoint: unknown): TranscriptCheckpointSerializationResult {
  try {
    if (!checkpointJson(checkpoint)) return { ok: false, reason: "invalid_checkpoint" };
    const json = JSON.stringify(checkpoint);
    const bytes = Buffer.byteLength(json, "utf8");
    return bytes > TRANSCRIPT_CHECKPOINT_MAX_BYTES
      ? { ok: false, reason: "state_too_large" }
      : { ok: true, json, bytes };
  } catch {
    return { ok: false, reason: "invalid_checkpoint" };
  }
}

export function projectorFromTurns(harness: string, renderLine: (line: string) => TranscriptTurn[], checkpointHarness = harness): TranscriptProjector {
  return {
    harness,
    checkpoint: () => projectorCheckpoint(checkpointHarness, {}),
    pushLine(line: string): TranscriptProjectedEvent[] {
      return renderLine(line).map((turn): TranscriptProjectedEvent => {
        if (turn.role === "tool") {
          return { kind: "unknown", ts: null, nativeType: "rendered_tool", detail: turn.text };
        }
        return { kind: "message", ts: null, role: turn.role, text: turn.text };
      });
    },
    flush(): TranscriptProjectedEvent[] {
      return [];
    },
  };
}

export function restoreStateless(state: unknown, create: () => TranscriptProjector): TranscriptProjector | undefined {
  return checkpointRecord(state, {}) ? create() : undefined;
}
// checkpoint-digest:end
