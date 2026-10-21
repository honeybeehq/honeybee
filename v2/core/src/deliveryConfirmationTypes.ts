export const DELIVERY_CONFIRMATION_REASONS = ["pending_ack", "old_host", "receipt_expired", "unknown", "generation_changed", "refused", "host_auth_failed", "message_too_large", "lane_unavailable"] as const;
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
export const DELIVERY_CONFIRMATION_MAX_AUDIT_BYTES = 16 * 1024 * 1024;
export const DELIVERY_CONFIRMATION_AUDIT_RESERVE_BYTES = 32 * 1024;
export const DELIVERY_CONFIRMATION_MAX_WIRE_BYTES = DELIVERY_CONFIRMATION_MAX_AUDIT_BYTES - DELIVERY_CONFIRMATION_AUDIT_RESERVE_BYTES;
export const MAX_DELIVERY_CONFIRMATION_BYTES = DELIVERY_CONFIRMATION_MAX_AUDIT_BYTES;
export type NeverWrittenDeliveryHoldReason = "host_auth_failed" | "message_too_large";
export interface DeliveryConfirmationSettlement {
  mailBatchId?: string;
  batchMemberIds?: number[];
  multilineFallbackId?: string;
  reorderMessageIds: number[];
  placementMoveId: string | null;
  handoffId: string | null;
}
export interface PrepareDeliveryConfirmationIntent {
  settlement?: DeliveryConfirmationSettlement;
  beeId: string;
  messageId: number;
  generation: number;
  wireLine: string;
  digest: string;
  host: { pid: number; birth: string; bootId: string };
}
export interface PrepareUnknownDeliveryConfirmationIntent {
  beeId: string;
  messageId: number;
  generation: number;
}
export type KnownDeliveryConfirmationIntent = PrepareDeliveryConfirmationIntent & {
  refusalRetries?: number;
  since: number;
  state: DeliveryConfirmation["state"];
  reason: DeliveryConfirmationReason;
};
export type UnknownDeliveryConfirmationIntent = PrepareUnknownDeliveryConfirmationIntent & {
  wireLine: null;
  digest: null;
  host: null;
  since: number;
  state: "held";
  reason: DeliveryConfirmationReason;
};
export type DeliveryConfirmationIntent = KnownDeliveryConfirmationIntent | UnknownDeliveryConfirmationIntent;
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

export function deliveryConfirmationIntentFits(input: PrepareDeliveryConfirmationIntent): boolean {
  const encoder = new TextEncoder();
  if (typeof input.wireLine !== "string" || encoder.encode(input.wireLine).byteLength > DELIVERY_CONFIRMATION_MAX_WIRE_BYTES) return false;
  const row = { ...input, since: Number.MAX_SAFE_INTEGER, state: "awaiting_confirmation", reason: "pending_ack" };
  return encoder.encode(JSON.stringify({ row })).byteLength + DELIVERY_CONFIRMATION_AUDIT_RESERVE_BYTES <= DELIVERY_CONFIRMATION_MAX_AUDIT_BYTES;
}
