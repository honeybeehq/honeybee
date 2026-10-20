import type { DatabaseSync } from "node:sqlite";
export const DELIVERY_CONFIRMATION_REASONS = ["pending_ack", "old_host", "receipt_expired", "unknown", "generation_changed", "refused"] as const;
export type DeliveryConfirmationReason = (typeof DELIVERY_CONFIRMATION_REASONS)[number];
export interface DeliveryConfirmation {
  code: "delivery_confirmation_pending";
  messageId: number;
  generation: number;
  since: number;
  state: "awaiting_confirmation" | "held";
  reason: DeliveryConfirmationReason;
  delivered: false;
}
export interface PrepareDeliveryConfirmationIntent {
  beeId: string;
  messageId: number;
  generation: number;
  wireLine: string;
  digest: string;
  host: { pid: number; birth: string; bootId: string };
}
export interface DeliveryConfirmationIntent extends PrepareDeliveryConfirmationIntent {
  since: number;
  state: DeliveryConfirmation["state"];
  reason: DeliveryConfirmationReason;
}
export interface ResolveDeliveryConfirmation {
  action: "resend_anyway" | "drop";
  beeId: string;
  messageId: number;
  generation: number;
  idempotencyKey: string;
}
export interface DeliveryConfirmationResolution {
  action: ResolveDeliveryConfirmation["action"];
  beeId: string;
  messageId: number;
  generation: number;
  replacementMessageId: number | null;
  deduped?: true;
}
export interface DeliveryConfirmationDecision {
  idempotencyKey: string;
  generation: number;
  receipt: DeliveryConfirmationResolution;
}
export function publicDeliveryConfirmation(row: DeliveryConfirmationIntent): DeliveryConfirmation {
  return { code: "delivery_confirmation_pending", messageId: row.messageId, generation: row.generation, since: row.since, state: row.state, reason: row.reason, delivered: false };
}
export const DELIVERY_CONFIRMATION_SQL = `
CREATE TABLE IF NOT EXISTS delivery_confirmation_intents (
  message_id INTEGER PRIMARY KEY REFERENCES mailbox(id) ON DELETE CASCADE,
  bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
  row_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS delivery_confirmation_by_bee ON delivery_confirmation_intents(bee_id, message_id);
CREATE TABLE IF NOT EXISTS delivery_confirmation_decisions (
  idempotency_key TEXT PRIMARY KEY,
  bee_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('resend_anyway','drop')),
  row_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS delivery_confirmation_decision_message ON delivery_confirmation_decisions(bee_id, message_id, action);
`;

export function readDeliveryConfirmations(db: DatabaseSync, beeId: string, generation: number | null): DeliveryConfirmation[] {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'delivery_confirmation_intents'").get()) return [];
  return db.prepare("SELECT row_json FROM delivery_confirmation_intents WHERE bee_id = ? ORDER BY message_id").all(beeId).map(raw => {
    const row = JSON.parse(String(raw.row_json)) as DeliveryConfirmationIntent;
    return publicDeliveryConfirmation(generation !== null && generation !== row.generation ? { ...row, state: "held", reason: "generation_changed" } : row);
  });
}
