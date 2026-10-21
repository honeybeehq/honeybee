import type { TurnTrigger } from "./types.ts";
import type { PhoneInput } from "./phoneOriginTypes.ts";

export type HumanOutputMode = "legacy" | "explicit";
export interface UnansweredHumanMessage {
  messageId: number;
  generation: number;
  humanAt: number;
  triggerKind: "human" | "answer";
  phoneOrigin?: PhoneInput["envelope"];
}
export interface HumanOutputFacts {
  humanOutputMode: HumanOutputMode;
  humanAcknowledgementTrackingSince: number | null;
  lastHumanAcknowledgementAt: number | null;
  unansweredHumanMessage: UnansweredHumanMessage | null;
}
export interface OutputProvenance {
  id: string;
  beeId: string;
  generation: number | null;
  turnTrigger: TurnTrigger | null;
  at: number;
  idempotencyKey: string;
}
export interface BeeTellRow extends OutputProvenance {
  text: string;
  replyTo: number | null;
  acknowledgedDeliveryRange: { afterSeq: number; throughSeq: number } | null;
  acknowledgedMessageIds: number[];
  acknowledgedOverflow: number;
}
export interface BeeReactionRow extends OutputProvenance {
  messageId: number;
  emoji: string;
}
export interface BeeTellParams { beeId: string; text: string; replyTo?: number; idempotencyKey: string }
export interface BeeReactParams { beeId: string; messageId: number; emoji: string; idempotencyKey: string }
export interface SetHumanOutputModeParams { beeId: string; mode: HumanOutputMode; idempotencyKey: string }
export interface BeeTellResult { tell: BeeTellRow; deduped?: true }
export interface BeeReactResult { reaction: BeeReactionRow; deduped?: true }
export interface SetHumanOutputModeResult extends HumanOutputFacts { beeId: string; deduped?: true }
export type HumanOutputErrorCode = "human_output_mode_legacy" | "human_output_target_invalid" | "tell_text_invalid" | "react_emoji_invalid" | "invalid_request";
