const DAY_MS = 86_400_000;

export const STORE_RETENTION = {
  windowMs: 30 * DAY_MS,
  passEveryMs: DAY_MS,
  sliceAuditRows: 250,
  sliceCommandRows: 100,
  audit: {
    keptKinds: [
      "bee.created",
      "bee.deleted",
      "bee.interrupted",
      "mail.canceled",
      "mail.delivered",
      "mail.expedited",
      "mail.interrupt_requested",
      "mail.replaced",
      "quota.observed",
      "runtime.identity_unresolved",
      "runtime.pending_start_bound",
      "runtime.readiness_recovered",
      "runtime.readiness_recovery_claimed",
    ],
    keptWhileMessageUndelivered: [
      "mail.confirmation_prepared",
      "mail.confirmation_released",
      "mail.delivery_fallback_prepared",
    ],
    readOnlyInsideWindow: [
      "cell.evicted",
      "cell.retention.daily_cap",
      "cell.retention.pass",
      "mail.enqueued",
    ],
  },
} as const;

export interface StoreRetentionSlice {
  auditRows: number;
  commands: number;
  floorSeq: number;
  done: boolean;
}

const KEPT_KINDS: ReadonlySet<string> = new Set(STORE_RETENTION.audit.keptKinds);
const MESSAGE_KINDS: ReadonlySet<string> = new Set(STORE_RETENTION.audit.keptWhileMessageUndelivered);

export type AuditRetention = "kept" | "kept_while_message_undelivered" | "kept_above_mail_projection" | "window";

export function auditRetention(kind: string): AuditRetention {
  if (KEPT_KINDS.has(kind)) return "kept";
  if (MESSAGE_KINDS.has(kind)) return "kept_while_message_undelivered";
  return kind === "mail.enqueued" ? "kept_above_mail_projection" : "window";
}
