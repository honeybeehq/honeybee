/**
 * Consumer drift fixture copied from Apiary packages/core/src/cellMove.ts
 * at efbd4e47 (2026-09-06). Constants and types below are verbatim.
 * Refresh from the consumer when its contract changes, not to silence a test.
 */

export const HIVE_CAPABILITY_CELL_MOVE_LOCAL = 'cell.move.local.v1'
export const HIVE_CAPABILITY_CELL_RETAINED_EXEC = 'cell.retained.exec.v1'

/** Harnesses Honeybee will continue in a new cwd for v1. Others refuse before fence. */
export const CELL_MOVE_CONTINUATION_AGENTS = ['claude', 'codex', 'stub'] as const
export type CellMoveContinuationAgent = (typeof CELL_MOVE_CONTINUATION_AGENTS)[number]

export const BEE_MOVE_PHASES = ['stopping', 'placing', 'starting', 'complete', 'failed'] as const
export type BeeMovePhase = (typeof BEE_MOVE_PHASES)[number]

export const CELL_STATES = ['active', 'retained', 'removing', 'removed'] as const
export type CellState = (typeof CELL_STATES)[number]

export const CELL_OP_STATUSES = ['queued', 'running', 'done', 'failed', 'outcome_unknown'] as const
export type CellOpStatus = (typeof CELL_OP_STATUSES)[number]

export const BEE_MOVE_FAILURE_STAGES = ['validate', 'stop', 'start', 'context'] as const
export type BeeMoveFailureStage = (typeof BEE_MOVE_FAILURE_STAGES)[number]

export const CELL_MOVE_ERROR_CODES = [
  'remote_move_unsupported',
  'stale_placement',
  'repo_mismatch',
  'move_in_progress',
  'idempotency_conflict',
  'continuation_unsupported',
  'cell_not_found',
] as const
export type CellMoveErrorCode = (typeof CELL_MOVE_ERROR_CODES)[number]

export type LocalRepoIdentity = {
  version: 1
  gitCommonDirRealpath: string
  objectFormat: 'sha1' | 'sha256'
}

export type BeePlacement = {
  version: number
  mode: 'cell' | 'checkout'
  substrate: 'cell' | 'hsr'
  cwd: string
}

export type BeeMoveFailure = {
  stage: BeeMoveFailureStage
  code: string
  detail: string
}

export type BeeMoveView = {
  id: string
  beeId: string
  phase: BeeMovePhase
  sourceGeneration: number
  from: BeePlacement
  to: BeePlacement
  retainedCellId: string
  failure: BeeMoveFailure | null
}

export type BeeMoveResult = BeeMoveView & { deduped?: boolean }

export type BeeMoveDestination = {
  kind: 'local_checkout'
  cwd: string
  repository: LocalRepoIdentity
  observedHead: string
}

export type BeeMoveParams = {
  beeId: string
  idempotencyKey: string
  expected: { placementVersion: number; cellId: string }
  destination: BeeMoveDestination
}

export type CellRow = {
  id: string
  sourceBeeId: string
  state: CellState
  repository: LocalRepoIdentity
  originRepo: string
  sha: string
  wrapper: string
  spaceName: string
  spaceDir: string
  sandbox: boolean | null
  createdAt: number
  retainedAt: number | null
  removedAt: number | null
}

export type CellExecParams = {
  cellId: string
  idempotencyKey: string
  argv: string[]
  cwd?: string
  timeoutMs?: number
}

export type CellExecResult = {
  id: string
  cellId: string
  status: CellOpStatus
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timeoutMs: number
  reason: 'no_cell' | 'cell_runtime_live' | 'busy' | 'argv_invalid' | 'containment' | null
  deduped?: boolean
}

export type CellRetainedRemoveParams = {
  cellId: string
  idempotencyKey: string
  force?: boolean
}

