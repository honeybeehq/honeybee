export const MULTILINE_UNSUPPORTED_ATTEMPTS = 3;
export const MULTILINE_UNSUPPORTED_MS = 30_000;
export const MULTILINE_UNSUPPORTED_DETAILS = ["multiline_type_mode", "multiline_bracketed_paste_disabled", "multiline_bracketed_paste_unknown", "multiline_bracketed_paste_version_unsupported"] as const;
export type MultilineStage = "waiting" | "expired" | "held" | "delivered";
export interface DeliveryFallback {
  code: "delivery_file_fallback";
  state: "preparing" | "ready" | "in_flight" | "unknown" | "held" | "delivered" | "removed";
  id: string;
  ownerStoreId: string;
  root: string;
  worktrees: string[];
  path: string | null;
  pointer: string | null;
  digest: string | null;
  bytes: number | null;
  generation: number | null;
  detail: string | null;
  senderNoticeMessageId: number | null;
  attempts?: number;
  reorderMessageIds?: unknown;
  attemptPhase?: "injecting" | "before_enter_cleared" | "before_enter_unknown" | "enter_attempted";
  paneInput?: {code: "pane_input_unknown"; since: number; reason: string; socketPath: string; paneId: string; serverIdentity: string; generation: number; clearedAt?: number};
}
export function publicDeliveryFallback(fallback: DeliveryFallback): DeliveryFallback {
  const result = {...fallback};
  delete result.reorderMessageIds;
  return result;
}
export function readDeliveryFallback(value: unknown): DeliveryFallback | undefined {
  if (value === undefined) return undefined;
  const row = value as DeliveryFallback;
  if (row && typeof row === "object" && !Array.isArray(row) && row.code === "delivery_file_fallback"
    && ["preparing", "ready", "in_flight", "unknown", "held", "delivered", "removed"].includes(row.state)
    && typeof row.id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(row.id)
    && typeof row.ownerStoreId === "string" && typeof row.root === "string" && row.root.startsWith("/")
    && Array.isArray(row.worktrees) && row.worktrees.every(path => typeof path === "string")
    && (row.path === null || typeof row.path === "string" && row.path.startsWith("/") && !/[\x00-\x1f]/.test(row.path))
    && (row.pointer === null || typeof row.pointer === "string" && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(row.pointer))
    && (row.digest === null || typeof row.digest === "string" && /^[a-f0-9]{64}$/.test(row.digest))
    && (row.bytes === null || Number.isSafeInteger(row.bytes) && row.bytes >= 0)
    && (row.generation === null || Number.isSafeInteger(row.generation) && row.generation > 0)
    && (row.detail === null || typeof row.detail === "string")
    && (row.attempts === undefined || Number.isSafeInteger(row.attempts) && row.attempts >= 0)
    && (row.attemptPhase === undefined || Number.isSafeInteger(row.attempts) && row.attempts! > 0 && (
      row.attemptPhase === "injecting" && ["in_flight", "unknown", "removed"].includes(row.state)
      || row.attemptPhase === "before_enter_cleared" && ["ready", "held", "removed"].includes(row.state)
      || row.attemptPhase === "before_enter_unknown" && ["unknown", "removed"].includes(row.state)
      || row.attemptPhase === "enter_attempted" && ["unknown", "delivered", "removed"].includes(row.state)))
    && (row.paneInput === undefined || row.paneInput && row.paneInput.code === "pane_input_unknown" && Number.isFinite(row.paneInput.since) && row.paneInput.since >= 0
      && typeof row.paneInput.reason === "string" && /^[a-z][a-z0-9_]*$/.test(row.paneInput.reason)
      && typeof row.paneInput.socketPath === "string" && row.paneInput.socketPath.startsWith("/") && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(row.paneInput.socketPath)
      && typeof row.paneInput.paneId === "string" && /^%[0-9]+$/.test(row.paneInput.paneId)
      && typeof row.paneInput.serverIdentity === "string" && /^[0-9]+:[0-9]+:[0-9]+(?:\.[0-9]+)?:[1-9][0-9]*:[0-9]+(?:\.[0-9]+)?$/.test(row.paneInput.serverIdentity)
      && Number.isSafeInteger(row.paneInput.generation) && row.paneInput.generation > 0 && row.paneInput.generation === row.generation
      && row.attemptPhase !== undefined && !["preparing"].includes(row.state)
      && (row.paneInput.clearedAt === undefined || Number.isFinite(row.paneInput.clearedAt) && row.paneInput.clearedAt >= 0))
    && (row.senderNoticeMessageId === null || Number.isSafeInteger(row.senderNoticeMessageId) && row.senderNoticeMessageId > 0)
    && (!["ready", "in_flight", "delivered"].includes(row.state) || row.path !== null && row.pointer !== null && row.digest !== null && row.bytes !== null)
    && (row.state !== "in_flight" || row.generation !== null)) return row;
  return { code: "delivery_file_fallback", state: "unknown", id: "", ownerStoreId: "", root: "", worktrees: [], path: null, pointer: null, digest: null, bytes: null, generation: null, detail: row?.detail === "delivery_hold_state_unknown" ? row.detail : "delivery_fallback_state_unknown", senderNoticeMessageId: null };
}
export interface DeliveryHoldReceipt {
  code: "delivery_unsupported_multiline";
  messageId: number;
  beeId: string;
  sender: string;
  heldSince: number;
  delivered: false;
  reason: "multiline_type_mode";
  channel: "mail" | "mail.history+audit";
  senderNoticeMessageId: number | null;
}
export interface MultilineDeliveryRow {
  messageId: number;
  beeId: string;
  attempts: number;
  unsupportedMs: number;
  lastAttemptAt: number;
  lastUnsupported: boolean;
  heldAt: number | null;
  heldSince: number | null;
  receipt: DeliveryHoldReceipt | null;
  detail: string;
  stage: MultilineStage;
  notice: string | null;
  fallback?: DeliveryFallback;
}
export interface DeliveryHold {
  code: "delivery_unsupported_multiline";
  stage: MultilineStage;
  messageId: number;
  heldAt: number;
  heldSince: number | null;
  receipt: DeliveryHoldReceipt | null;
  detail: string;
  attempts: number;
  unsupportedMs: number;
  notice: string | null;
}
export const MULTILINE_DELIVERY_SQL = `CREATE TABLE IF NOT EXISTS multiline_delivery (
  message_id INTEGER PRIMARY KEY,
  bee_id TEXT NOT NULL,
  held_at INTEGER,
  held_since INTEGER,
  sender_notice_message_id INTEGER,
  row_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS multiline_delivery_bee ON multiline_delivery(bee_id, held_at);
CREATE TABLE IF NOT EXISTS multiline_fallback_fence (
  message_id INTEGER PRIMARY KEY,
  bee_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('unattempted', 'prepared')),
  attempted INTEGER NOT NULL DEFAULT 0 CHECK(attempted IN (0, 1)),
  publication_id TEXT,
  CHECK((state = 'unattempted' AND publication_id IS NULL) OR (state = 'prepared' AND publication_id IS NOT NULL))
) STRICT;`;
export function deliveryHold(row: MultilineDeliveryRow): DeliveryHold | undefined {
  return row.heldAt === null ? undefined : { code: "delivery_unsupported_multiline", stage: row.stage, messageId: row.messageId, heldAt: row.heldAt, heldSince: row.heldSince, receipt: row.receipt, detail: row.detail, attempts: row.attempts, unsupportedMs: row.unsupportedMs, notice: row.notice };
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
    hold: unsupported && (detail === "multiline_bracketed_paste_version_unsupported" || attempts >= MULTILINE_UNSUPPORTED_ATTEMPTS || unsupportedMs >= MULTILINE_UNSUPPORTED_MS),
  };
}

export function readMultilineDelivery(json: string, messageId: number, beeId: string, heldAt: number | null, heldSince: number | null): MultilineDeliveryRow {
  try {
    const row = JSON.parse(json) as MultilineDeliveryRow;
    if (row && typeof row === "object" && !Array.isArray(row) && row.messageId === messageId && row.beeId === beeId && row.heldAt === heldAt && row.heldSince === heldSince
      && ["waiting", "expired", "held", "delivered"].includes(row.stage)
      && (heldSince === null || Number.isFinite(heldSince))
      && (row.stage !== "held" || heldSince !== null)
      && (heldSince === null || row.stage === "held" || row.stage === "delivered")
      && (row.receipt === null || row.receipt && typeof row.receipt === "object" && !Array.isArray(row.receipt)
        && row.receipt.code === "delivery_unsupported_multiline" && row.receipt.delivered === false && row.receipt.reason === "multiline_type_mode"
        && row.receipt.messageId === messageId && row.receipt.beeId === beeId && row.receipt.heldSince === heldSince && typeof row.receipt.sender === "string"
        && ["mail", "mail.history+audit"].includes(row.receipt.channel)
        && (row.receipt.senderNoticeMessageId === null || Number.isSafeInteger(row.receipt.senderNoticeMessageId) && row.receipt.senderNoticeMessageId > 0))
      && Number.isSafeInteger(row.attempts) && row.attempts >= 0 && Number.isFinite(row.unsupportedMs) && row.unsupportedMs >= 0
      && Number.isFinite(row.lastAttemptAt) && typeof row.lastUnsupported === "boolean"
      && typeof row.detail === "string" && (row.notice === null || typeof row.notice === "string")) {
      const fallback = readDeliveryFallback(row.fallback);
      return {
        messageId, beeId, heldAt, heldSince, stage: row.stage, attempts: row.attempts, unsupportedMs: row.unsupportedMs, lastAttemptAt: row.lastAttemptAt,
        lastUnsupported: row.lastUnsupported, detail: fallback?.id === "" ? "delivery_hold_state_unknown" : row.detail, notice: row.notice,
        ...(fallback === undefined ? {} : { fallback }),
        receipt: row.receipt === null ? null : { code: "delivery_unsupported_multiline", messageId, beeId, sender: row.receipt.sender, heldSince: row.receipt.heldSince,
          delivered: false, reason: "multiline_type_mode", channel: row.receipt.channel, senderNoticeMessageId: row.receipt.senderNoticeMessageId },
      };
    }
  } catch {}
  return { messageId, beeId, heldAt: heldAt ?? 0, heldSince, receipt: null, stage: heldSince === null ? "expired" : "held", attempts: 0, unsupportedMs: 0, lastAttemptAt: 0, lastUnsupported: false, detail: "delivery_hold_state_unknown", notice: null, fallback: { ...readDeliveryFallback(null)!, detail: "delivery_hold_state_unknown" } };
}
