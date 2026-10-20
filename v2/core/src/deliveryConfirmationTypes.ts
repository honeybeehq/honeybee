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
export interface PrepareUnknownDeliveryConfirmationIntent {
  beeId: string;
  messageId: number;
  generation: number;
}
export type DeliveryConfirmationIntent = (PrepareDeliveryConfirmationIntent | (PrepareUnknownDeliveryConfirmationIntent & {
  wireLine: null;
  digest: null;
  host: null;
  state: "held";
})) & {
  since: number;
  state: DeliveryConfirmation["state"];
  reason: DeliveryConfirmationReason;
};
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
