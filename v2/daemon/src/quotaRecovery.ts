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
        this.store.cancelQuotaRecoveries(row.beeId, "control_or_placement_changed");
        continue;
      }
      if (row.state === "rotating") this.store.resumeQuotaRecovery(row.id);
    }
    this.reconciledSeq = this.store.lastAuditSeq();
  }
}
