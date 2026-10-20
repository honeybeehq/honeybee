import type { CoreStore } from "../../core/src/index.ts";

export class QuotaRecovery {
  private readonly store: CoreStore;
  private reconciledSeq = -1;

  constructor(store: CoreStore) {
    this.store = store;
  }

  reconcile(): void {
    if (this.store.lastAuditSeq() === this.reconciledSeq) return;
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
    }
    this.reconciledSeq = this.store.lastAuditSeq();
  }
}
