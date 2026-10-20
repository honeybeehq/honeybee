import type { CoreStore, QuotaRecoveryRow } from "../../core/src/index.ts";

export class QuotaRecovery {
  private readonly store: CoreStore;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly recover?: (row: QuotaRecoveryRow) => Promise<void>;
  private readonly attempts = new Map<string, { at: number; startedAt: number; fingerprint: string; pending: boolean }>();

  constructor(store: CoreStore, recover?: (row: QuotaRecoveryRow) => Promise<void>) {
    this.store = store;
    this.recover = recover;
  }

  private fingerprint(row: QuotaRecoveryRow): string {
    return JSON.stringify([row.eventIds, this.store.getBee(row.beeId)?.args, this.store.getBee(row.beeId)?.tags, this.store.listAccounts({ harness: row.placement.agent }).map(account => [account.id, account.status, account.exhaustedAt, account.leasedFrom, (() => { const limits = this.store.getAccountLimits(account.id); return limits ? [limits.readable, limits.fiveHourPct, limits.weeklyPct, limits.fableWeeklyPct, limits.fiveHourResetsAt, limits.weeklyResetsAt, limits.fableResetsAt] : null; })()])]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled(this.pending);
  }

  reconcile(): void {
    if (this.stopped) return;
    for (const row of this.store.listQuotaRecoveries()) {
      if (row.state !== "waiting" && row.state !== "rotating") continue;
      if (!this.store.quotaRecoveryValid(row)) {
        this.store.cancelQuotaRecovery(row.id, "control_or_placement_changed");
        continue;
      }
      if (row.state === "rotating") {
        const runtime = this.store.currentRuntime(row.beeId);
        if (runtime && runtime.generation > row.sourceGeneration && runtime.state === "stopped" && !this.store.activeFlags(row.beeId).some(flag => flag.flag === "spawn_failed")) this.store.enqueueBootRetry(row.beeId);
        this.store.resumeQuotaRecovery(row.id);
      }
      else if (this.recover) {
        const now = Date.now();
        const fingerprint = this.fingerprint(row);
        const previous = this.attempts.get(row.id);
        const deadlines = [row.retryAt, ...Object.values(row.resetHints)].filter((at): at is number => at != null && at > (previous?.startedAt ?? 0));
        const due = Math.min(...deadlines, (previous?.at ?? 0) + 30_000);
        if (previous?.pending || previous && now < due && (previous.fingerprint === fingerprint || now - previous.at < 1000)) continue;
        const attempt = { at: now, startedAt: now, fingerprint, pending: true };
        this.attempts.set(row.id, attempt);
        const pending = this.recover(row).catch(() => undefined).finally(() => {
          attempt.at = Date.now();
          attempt.pending = false;
          const current = this.store.getQuotaRecovery(row.id);
          if (current) attempt.fingerprint = this.fingerprint(current);
          this.pending.delete(pending);
        });
        this.pending.add(pending);
      }
    }
    for (const id of this.attempts.keys()) if (this.store.getQuotaRecovery(id)?.state !== "waiting") this.attempts.delete(id);
  }
}
