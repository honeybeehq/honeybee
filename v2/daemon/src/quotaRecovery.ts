import type { CoreStore, QuotaRecoveryRow } from "../../core/src/index.ts";

export class QuotaRecovery {
  private readonly store: CoreStore;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly recover?: (row: QuotaRecoveryRow) => Promise<void>;
  private readonly attempts = new Map<string, { at: number; fingerprint: string; pending: boolean }>();

  constructor(store: CoreStore, recover?: (row: QuotaRecoveryRow) => Promise<void>) {
    this.store = store;
    this.recover = recover;
  }

  private fingerprint(row: QuotaRecoveryRow): string {
    return JSON.stringify([row.eventIds, this.store.getBee(row.beeId)?.args, this.store.getBee(row.beeId)?.tags, this.store.listAccounts({ harness: row.placement.agent }).map(account => [account.id, account.status, account.exhaustedAt, account.leasedFrom, this.store.getAccountLimits(account.id)?.fetchedAt])]);
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
        this.store.cancelQuotaRecoveries(row.beeId, "control_or_placement_changed");
        continue;
      }
      if (row.state === "rotating") this.store.resumeQuotaRecovery(row.id);
      else if (this.recover) {
        const now = Date.now();
        const fingerprint = this.fingerprint(row);
        const previous = this.attempts.get(row.id);
        const due = Math.min(row.retryAt !== null && row.retryAt > (previous?.at ?? 0) ? row.retryAt : Infinity, (previous?.at ?? 0) + 30_000);
        if (previous?.pending || previous && now < due && (previous.fingerprint === fingerprint || now - previous.at < 1000)) continue;
        const attempt = { at: now, fingerprint, pending: true };
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
