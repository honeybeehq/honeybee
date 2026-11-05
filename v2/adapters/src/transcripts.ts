import { agyTranscripts } from "./agy.ts";
import { claudeShapedProjector, claudeTranscripts } from "./claude.ts";
import { codexTranscripts } from "./codex.ts";
import { grokTranscripts } from "./grok.ts";
import { kimiTranscripts } from "./kimi.ts";
import { museTranscripts } from "./muse.ts";
import { stubTranscripts } from "./stub.ts";
import {
  checkpointRecord, restoreStateless, serializeTranscriptCheckpoint, turnsFromProjectedEvent,
  TRANSCRIPT_PROJECTION_VERSION, TRANSCRIPT_PROJECTOR_STATE_VERSION,
  type TranscriptFamily, type TranscriptProjector, type TranscriptProjectorRestoreResult,
  type TranscriptTurn, type TranscriptTurnStream,
} from "./transcript.ts";

// checkpoint-digest:start
const FAMILIES: Record<string, TranscriptFamily> = {
  agy: agyTranscripts,
  claude: claudeTranscripts,
  codex: codexTranscripts,
  grok: grokTranscripts,
  kimi: kimiTranscripts,
  muse: museTranscripts,
  stub: stubTranscripts,
};

function familyOf(harness: string): TranscriptFamily {
  const known = FAMILIES[harness];
  if (known) return known;
  const createProjector = (): TranscriptProjector => claudeShapedProjector(harness);
  return { harness, createProjector, restoreProjector: (state) => restoreStateless(state, createProjector) };
}

function withRepairs(family: TranscriptFamily, upstream: TranscriptProjector): TranscriptProjector {
  const repair = family.repair;
  if (!repair) return upstream;
  return {
    harness: upstream.harness,
    pushLine: (line) => repair(line, upstream.pushLine(line)),
    flush: () => upstream.flush(),
    checkpoint: () => upstream.checkpoint(),
  };
}

/** The single harness registry for pane and CLI transcript projection. */
export function createTranscriptProjector(harness: string): TranscriptProjector {
  const family = familyOf(harness);
  return withRepairs(family, family.createProjector());
}

export function createNativeTranscriptProjector(harness: string): TranscriptProjector {
  return familyOf(harness).createProjector();
}

/** Restore only exact compatible, bounded JSON checkpoints. Rebuild from source on failure. */
export function restoreTranscriptProjector(harness: string, checkpoint: unknown): TranscriptProjectorRestoreResult {
  try {
    const serialized = serializeTranscriptCheckpoint(checkpoint);
    if (!serialized.ok) return serialized;
    if (!checkpointRecord(checkpoint, {
      harness: (v) => typeof v === "string",
      projectionVersion: (v) => typeof v === "number" && Number.isInteger(v),
      stateVersion: (v) => typeof v === "number" && Number.isInteger(v),
      state: () => true,
    })) return { ok: false, reason: "invalid_checkpoint" };
    // JSON validation and exact envelope validation above establish this shape.
    const envelope = checkpoint as { harness: string; projectionVersion: number; stateVersion: number; state: unknown };
    if (envelope.harness !== harness) return { ok: false, reason: "harness_mismatch" };
    if (envelope.projectionVersion !== TRANSCRIPT_PROJECTION_VERSION) return { ok: false, reason: "projection_version_mismatch" };
    if (envelope.stateVersion !== TRANSCRIPT_PROJECTOR_STATE_VERSION) return { ok: false, reason: "state_version_mismatch" };
    // Detach before constructing maps so later consumer mutations cannot affect projection.
    const state: unknown = structuredClone(envelope.state);
    const family = familyOf(harness);
    const projector = family.restoreProjector(state);
    return projector ? { ok: true, projector: withRepairs(family, projector) } : { ok: false, reason: "invalid_checkpoint" };
  } catch {
    return { ok: false, reason: "invalid_checkpoint" };
  }
}
// checkpoint-digest:end

/** Stateful raw-line to readable-turn projection for incremental consumers. */
export function createTranscriptTurnStream(harness: string): TranscriptTurnStream {
  const projector = createTranscriptProjector(harness);
  return {
    pushLine(line: string): TranscriptTurn[] {
      return projector.pushLine(line).flatMap(turnsFromProjectedEvent);
    },
    flush(): TranscriptTurn[] {
      return projector.flush().flatMap(turnsFromProjectedEvent);
    },
  };
}

export function renderTranscriptLines(harness: string, lines: readonly string[]): TranscriptTurn[] {
  const stream = createTranscriptTurnStream(harness);
  const turns = lines.flatMap((line) => stream.pushLine(line));
  turns.push(...stream.flush());
  return turns;
}
