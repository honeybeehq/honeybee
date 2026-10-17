export const MULTILINE_UNSUPPORTED_ATTEMPTS = 3;
export const MULTILINE_UNSUPPORTED_MS = 30_000;
export const MULTILINE_UNSUPPORTED_DETAILS = ["multiline_type_mode", "multiline_bracketed_paste_disabled"] as const;
export type MultilineStage = "waiting" | "expired" | "delivered";
export interface MultilineDeliveryRow {
  messageId: number;
  beeId: string;
  attempts: number;
  unsupportedMs: number;
  lastAttemptAt: number;
  lastUnsupported: boolean;
  heldAt: number | null;
  detail: string;
  stage: MultilineStage;
  notice: string | null;
}
export interface DeliveryHold {
  code: "delivery_unsupported_multiline";
  stage: MultilineStage;
  messageId: number;
  heldAt: number;
  detail: string;
  attempts: number;
  unsupportedMs: number;
  notice: string | null;
}
export const MULTILINE_DELIVERY_SQL = `CREATE TABLE IF NOT EXISTS multiline_delivery (
  message_id INTEGER PRIMARY KEY,
  bee_id TEXT NOT NULL,
  held_at INTEGER,
  row_json TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES mail_history_enqueues(message_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS multiline_delivery_bee ON multiline_delivery(bee_id, held_at);`;
export function deliveryHold(row: MultilineDeliveryRow): DeliveryHold | undefined {
  return row.heldAt === null ? undefined : { code: "delivery_unsupported_multiline", stage: row.stage, messageId: row.messageId, heldAt: row.heldAt, detail: row.detail, attempts: row.attempts, unsupportedMs: row.unsupportedMs, notice: row.notice };
}

export interface MultilineUnsupportedProgress {
  attempts: number;
  unsupportedMs: number;
  lastAttemptAt: number;
  lastUnsupported: boolean;
}
export function advanceMultilineUnsupported(previous: MultilineUnsupportedProgress | null, detail: string | undefined, now: number): MultilineUnsupportedProgress & { hold: boolean } {
  const unsupported = MULTILINE_UNSUPPORTED_DETAILS.some(value => value === detail);
  const elapsed = previous?.lastUnsupported && unsupported ? Math.max(0, now - previous.lastAttemptAt) : 0;
  const attempts = (previous?.attempts ?? 0) + (unsupported ? 1 : 0);
  const unsupportedMs = (previous?.unsupportedMs ?? 0) + elapsed;
  return {
    attempts, unsupportedMs, lastAttemptAt: now, lastUnsupported: unsupported,
    hold: unsupported && (attempts >= MULTILINE_UNSUPPORTED_ATTEMPTS || unsupportedMs >= MULTILINE_UNSUPPORTED_MS),
  };
}

export function readMultilineDelivery(json: string, messageId: number, beeId: string, heldAt: number | null): MultilineDeliveryRow {
  try {
    const row = JSON.parse(json) as MultilineDeliveryRow;
    if (row && typeof row === "object" && !Array.isArray(row) && row.messageId === messageId && row.beeId === beeId && row.heldAt === heldAt
      && ["waiting", "expired", "delivered"].includes(row.stage)
      && Number.isSafeInteger(row.attempts) && row.attempts >= 0 && Number.isFinite(row.unsupportedMs) && row.unsupportedMs >= 0
      && Number.isFinite(row.lastAttemptAt) && typeof row.lastUnsupported === "boolean"
      && typeof row.detail === "string" && (row.notice === null || typeof row.notice === "string")) return row;
  } catch {}
  return { messageId, beeId, heldAt: heldAt ?? 0, stage: "expired", attempts: 0, unsupportedMs: 0, lastAttemptAt: 0, lastUnsupported: false, detail: "delivery_hold_state_unknown", notice: null };
}
