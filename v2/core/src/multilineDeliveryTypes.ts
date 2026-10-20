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
