import type { BeeRow, QuotaRecoveryRow, RuntimeRow } from "./types.ts";

export type QuotaBoundary = {
  harness: "claude" | "codex";
  window: "five_hour" | "weekly" | "other";
  resetsAt: number | null;
  providerCategory: "rate_limit_event" | "synthetic_limit" | "errored_result_limit" | "rateLimitReachedType" | "usageLimitExceeded" | "text_fallback";
};

export type QuotaObservedEvent = {
  eventId: string;
  sourceId?: string;
  beeId: string;
  generation: number;
  quota: QuotaBoundary;
  turn: { messageIds: number[]; progress: "none" | "some" | "unknown" };
};

export function quotaRecoveryMatches(row: QuotaRecoveryRow, bee: BeeRow | null, runtime: RuntimeRow | null): boolean {
  return !!bee && bee.lifecycle === "active" && (bee.authControlFence ?? 0) === row.controlFence
    && bee.agent === row.placement.agent && bee.cwd === row.placement.cwd && (bee.cellId ?? null) === row.placement.cellId
    && !bee.activeMoveId && !bee.activeHandoffId
    && bee.account === (row.state === "rotating" ? row.targetAccount : row.sourceAccount)
    && !!runtime && (runtime.generation === row.sourceGeneration || row.state === "rotating" && row.successorGeneration !== null && runtime.generation >= row.successorGeneration);
}

export function automaticQuotaRecovery(bee: BeeRow | null, runtime: RuntimeRow | null, recoveries: readonly QuotaRecoveryRow[]): boolean {
  if (!bee || autoswapDisabled(bee)) return false;
  return recoveries.some(row => quotaRecoveryMatches(row, bee, runtime) && (row.state === "rotating" || row.state === "waiting"
    && (row.reason === "account_wait" || row.reason === "completion_reserve" || row.reason === "allocation_owner_required"
      || row.reason === "account_unavailable" && row.reasonDetail === "operation_in_progress")));
}

export function autoswapDisabled(bee: { tags: string[]; args: string[] | null }): boolean {
  const spelled = (value: string) => /^-{0,2}autoswap=false$/i.test(value.trim());
  return bee.tags.some(spelled) || (bee.args ?? []).some(spelled);
}
