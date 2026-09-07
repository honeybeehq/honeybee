/**
 * Cell→checkout move helpers (schema v22). Pure: hashing, command keys,
 * placement-context text. Durable rows live in the core store.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "./registry.ts";
import type { BeeMovePhase, BeeMoveRow, BeeMoveView, LocalRepoIdentity } from "./types.ts";
import { BEE_MOVE_TRANSITIONS } from "./types.ts";

export const CELL_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
export const CELL_EXEC_MAX_TIMEOUT_MS = 300_000;
export const CELL_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;

export const PLACEMENT_PREFIX_MARKER =
  "[Hive placement context. This is workspace metadata, not a user task.]";

export const MOVE_CONTINUATION_AGENTS = ["claude", "codex"] as const;

export function beeMoveStopKey(moveId: string, generation: number): string {
  return `move:${moveId}:stop:g${generation}`;
}

export function beeMoveReviveKey(moveId: string): string {
  return `move:${moveId}:revive`;
}

export function hashBeeMoveRequest(input: {
  beeId: string;
  expected: { placementVersion: number; cellId: string };
  destination: {
    kind: "local_checkout";
    cwd: string;
    repository: LocalRepoIdentity;
    observedHead: string;
  };
}): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function hashCellOpRequest(input: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function placementContextText(input: {
  placementVersion: number;
  cwd: string;
  cellId: string;
}): string {
  return (
    `Workspace placement changed (version ${input.placementVersion}). ` +
    `Your active workspace is now the regular checkout at ${input.cwd}. ` +
    `This supersedes earlier Cell-workspace instructions. ` +
    `Cell ${input.cellId} is retained but is not your cwd; ` +
    `access it only through authenticated Cell tools. ` +
    `No changes were copied, merged, or applied. Pending messages follow this instruction.`
  );
}

/** Delivery-time prefix. The durable mailbox body is unchanged. */
export function prefixPlacementDelivery(body: string, context: string): string {
  return `${PLACEMENT_PREFIX_MARKER}\n${context}\n\n${body}`;
}

/**
 * Compose Codex `developerInstructions` for a dest-gen handshake.
 * Existing custom instructions are kept; the placement overlay is appended
 * unless it is already present. Never replaces unrelated text.
 */
export function composeDeveloperInstructions(
  existing: string | null | undefined,
  overlay: string | null | undefined,
): string | undefined {
  const have = existing?.trim() ?? "";
  const add = overlay?.trim() ?? "";
  if (!add) return have.length > 0 ? have : undefined;
  if (!have) return add;
  if (have.includes(add)) return have;
  return `${have}\n\n${add}`;
}

export function isMoveOwnedStopKey(key: string | null | undefined, move: Pick<BeeMoveView, "id" | "sourceGeneration">): boolean {
  return key === beeMoveStopKey(move.id, move.sourceGeneration);
}

/** Locked RPC/mirror projection. Drops operational store fields. */
export function toBeeMoveView(row: BeeMoveRow): BeeMoveView {
  return {
    id: row.id,
    beeId: row.beeId,
    phase: row.phase,
    sourceGeneration: row.sourceGeneration,
    from: row.from,
    to: row.to,
    retainedCellId: row.retainedCellId,
    failure: row.failure,
  };
}

export function clampCellExecTimeout(timeoutMs: number | undefined): number {
  const n = timeoutMs ?? CELL_EXEC_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(n) || n <= 0) return CELL_EXEC_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(n), CELL_EXEC_MAX_TIMEOUT_MS);
}

export function beeMoveTransitionLegal(from: BeeMovePhase, to: BeeMovePhase): boolean {
  return from === to || (BEE_MOVE_TRANSITIONS[from] as readonly string[]).includes(to);
}
