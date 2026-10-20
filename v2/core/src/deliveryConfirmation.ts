import type { DatabaseSync } from "node:sqlite";
import type { DeliveryConfirmation, DeliveryConfirmationIntent } from "./deliveryConfirmationTypes.ts";
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
