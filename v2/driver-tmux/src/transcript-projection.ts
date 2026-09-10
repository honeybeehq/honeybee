/**
 * Pane-ready transcript projection (G3).
 *
 * One stateful projector per harness consumes published session-log JSONL and
 * emits canonical events. The union is a geometry-blind payload: apiaryd stores
 * one feed row per line with the events array and synthesizes ids
 * `beeId:lineNo:idx`. Observation parsers in transcripts.ts stay three-kind
 * (turn_started / output / turn_ended) and MUST NOT infer lifecycle, attention,
 * or permission — no `needs_input` kind.
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

type Base = { ts: TranscriptIsoTs; threadId?: string };

export type TranscriptProjectedEvent =
  | (Base & { kind: "turn_start"; turnId?: string })
  | (Base & { kind: "turn_end"; turnId?: string; durationMs?: number; finishReason?: string; interrupted?: boolean })
  | (Base & { kind: "interrupt"; reason?: string })
  | (Base & {
      kind: "message";
      role: TranscriptMessageRole;
      text: string;
      providerEventId?: string;
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
    })
  | (Base & { kind: "compaction"; trigger?: string; tokensBefore?: number; tokensAfter?: number })
  | (Base & { kind: "unknown"; nativeType: string; detail?: string });

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

export type TranscriptProjectorFactory = () => TranscriptProjector;

// checkpoint-digest:start
/** Bump for event semantic changes; stored projections must then be rebuilt. */
export const TRANSCRIPT_PROJECTION_VERSION = 3;
/** Bump for checkpoint schema changes. Restore deliberately does not migrate. */
export const TRANSCRIPT_PROJECTOR_STATE_VERSION = 4;
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

// checkpoint-digest:end
