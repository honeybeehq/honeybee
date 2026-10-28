import { createHash } from "node:crypto";
import type { LocalPeer } from "./peerCredentials.ts";
import { RpcError, type RpcVerb } from "./protocol.ts";

export interface CellGatewayIdentity {
  readonly beeId: string;
  readonly generation: number;
}

export interface CellGatewayPolicy {
  readonly identity: CellGatewayIdentity;
  readonly limits: CellGatewayLimits;
  current(peer: LocalPeer): boolean;
  canSend(target: string): boolean;
  ownsTranscript(operationId: string): boolean;
}

export const CELL_GATEWAY_LIMITS = Object.freeze({ windowMs: 60_000, send: 60, question: 12, seal: 12, bodyBytes: 65_536, textBytes: 8192, titleBytes: 512, options: 32, optionBytes: 256, refs: 32, refBytes: 1024, frameBytes: 1_048_576 });

export class CellGatewayLimits {
  private readonly buckets = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) { this.now = now; }
  admit(verb: RpcVerb, params: Record<string, unknown>): void {
    const tooLarge = (): never => { throw new RpcError("cell_gateway_payload_too_large", "Cell gateway payload exceeds its limits"); };
    for (const [key, maximum] of [["body", CELL_GATEWAY_LIMITS.bodyBytes], ["text", CELL_GATEWAY_LIMITS.textBytes], ["title", CELL_GATEWAY_LIMITS.titleBytes], ["id", 128], ["idempotencyKey", 256]] as const) {
      if (typeof params[key] === "string" && Buffer.byteLength(params[key] as string) > maximum) tooLarge();
    }
    for (const [key, count, bytes] of [["options", CELL_GATEWAY_LIMITS.options, CELL_GATEWAY_LIMITS.optionBytes], ["refs", CELL_GATEWAY_LIMITS.refs, CELL_GATEWAY_LIMITS.refBytes]] as const) {
      const values = params[key];
      if (values !== undefined && (!Array.isArray(values) || values.length > count || values.some(value => typeof value !== "string" || Buffer.byteLength(value) > bytes))) tooLarge();
    }
    const maximum = verb === "send" ? CELL_GATEWAY_LIMITS.send : verb === "question.ask" ? CELL_GATEWAY_LIMITS.question : verb === "seal.create" ? CELL_GATEWAY_LIMITS.seal : null;
    if (maximum === null) return;
    const at = this.now();
    let bucket = this.buckets.get(verb);
    if (!bucket || at - bucket.start >= CELL_GATEWAY_LIMITS.windowMs) {
      bucket = { start: at, count: 0 };
      this.buckets.set(verb, bucket);
    }
    if (bucket.count >= maximum) throw new RpcError("cell_gateway_rate_limited", "Cell gateway mutation rate exceeded", { retryAfterMs: Math.max(0, CELL_GATEWAY_LIMITS.windowMs - (at - bucket.start)) });
    bucket.count++;
  }
}

const FIELDS: Partial<Record<RpcVerb, readonly string[]>> = {
  view: ["beeId"],
  "bee.transcript": ["beeId", "offset", "limitBytes"],
  list: [],
  "question.ask": ["beeId", "text", "options", "id", "idempotencyKey"],
  "seal.create": ["beeId", "title", "body", "refs", "idempotencyKey"],
  "thread.transcript": ["operationId", "offset", "limitBytes"],
  send: ["beeId", "body", "sender", "urgency", "idempotencyKey"],
};

export function authorizeCellGateway(
  policy: CellGatewayPolicy,
  peer: LocalPeer | undefined,
  verb: RpcVerb,
  params: Record<string, unknown>,
  context: unknown,
): Record<string, unknown> {
  const deny = (reason: "identity" | "context" | "verb" | "arguments" | "send_target_or_sender" | "transcript_owner" | "self"): never => { throw new RpcError("caller_not_trusted", "Cell gateway operation refused", { reason }); };
  if (!peer || !policy.current(peer)) deny("identity");
  if (context !== undefined) deny("context");
  const fields = FIELDS[verb];
  if (!fields) deny("verb");
  if (Object.keys(params).some(key => !fields!.includes(key))) deny("arguments");
  const { beeId } = policy.identity;
  if (verb === "send") {
    if (typeof params.beeId !== "string" || !policy.canSend(params.beeId)
      || params.sender !== undefined && params.sender !== beeId) deny("send_target_or_sender");
  } else if (verb === "thread.transcript") {
    if (typeof params.operationId !== "string" || !policy.ownsTranscript(params.operationId)) deny("transcript_owner");
  } else if (verb !== "list" && params.beeId !== undefined && params.beeId !== beeId) deny("self");
  policy.limits.admit(verb, params);
  const admitted = { ...params };
  if (verb === "send") {
    admitted.sender = beeId;
    if (admitted.urgency === "now") admitted.urgency = "next";
  } else if (verb !== "list" && verb !== "thread.transcript") admitted.beeId = beeId;
  if (typeof admitted.idempotencyKey === "string") {
    admitted.idempotencyKey = `cell:${createHash("sha256").update(JSON.stringify([beeId, verb, admitted.idempotencyKey])).digest("hex")}`;
  }
  return admitted;
}
