/** A new conversation identity; unrelated to the v23 same-bee harness handoff. */
export type ThreadOperationPhase = "copying" | "compacting" | "starting" | "ready" | "failed";
export type ThreadFailureCode = "history_unavailable" | "history_changed" | "copy_failed" | "compaction_failed" | "compaction_unsupported" | "worker_unreachable" | "attempts_exhausted" | "startup_failed" | "successor_deleted";
export interface ThreadOperationView {
  id: string;
  kind: "fork" | "handoff";
  sourceBeeId: string;
  sourceProviderSessionId: string;
  successorBeeId: string;
  successorProviderSessionId: string;
  commandId: number;
  continuationMessageId: number | null;
  phase: ThreadOperationPhase;
  transcriptReady: boolean;
  compacted: boolean;
  attempt: number;
  createdAt: number;
  updatedAt: number;
  failure: { stage: Exclude<ThreadOperationPhase, "ready" | "failed">; code: ThreadFailureCode; detail: string; retryable: boolean } | null;
}
export interface ThreadOperationRow extends ThreadOperationView {
  idempotencyKey: string;
  requestHash: string;
  instruction: string | null;
  /** Append-only native rollout prefix, pinned at admission without reading its body. */
  source: { path: string; bytes: number; dev: number; ino: number; modelProvider: string };
  historyPath: string;
  sessionPath: string;
  worker: { pid: number; startedAt: number } | null;
}
export function threadOperationView(row: ThreadOperationRow): ThreadOperationView {
  const { idempotencyKey: _key, requestHash: _hash, instruction: _instruction, source: _source,
    historyPath: _history, sessionPath: _session, worker: _worker, ...view } = row;
  return view;
}
