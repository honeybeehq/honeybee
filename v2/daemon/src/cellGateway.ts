import { createHash } from "node:crypto";
import type { LocalPeer } from "./peerCredentials.ts";
import { RpcError, type RpcVerb } from "./protocol.ts";

export interface CellGatewayIdentity {
  readonly beeId: string;
  readonly generation: number;
}

export interface CellGatewayPolicy {
  readonly identity: CellGatewayIdentity;
  current(peer: LocalPeer): boolean;
  canSend(target: string): boolean;
  ownsTranscript(operationId: string): boolean;
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
  const deny = (): never => { throw new RpcError("caller_not_trusted", "Cell gateway operation refused"); };
  if (!peer || !policy.current(peer) || context !== undefined) deny();
  const fields = FIELDS[verb];
  if (!fields || Object.keys(params).some(key => !fields.includes(key))) deny();
  const { beeId, generation } = policy.identity;
  if (verb === "send") {
    if (typeof params.beeId !== "string" || !policy.canSend(params.beeId)
      || params.sender !== undefined && params.sender !== beeId) deny();
  } else if (verb === "thread.transcript") {
    if (typeof params.operationId !== "string" || !policy.ownsTranscript(params.operationId)) deny();
  } else if (verb !== "list" && params.beeId !== undefined && params.beeId !== beeId) deny();
  const admitted = { ...params };
  if (verb === "send") {
    admitted.sender = beeId;
    if (admitted.urgency === "now") admitted.urgency = "next";
  } else if (verb !== "list" && verb !== "thread.transcript") admitted.beeId = beeId;
  if (typeof admitted.idempotencyKey === "string") {
    admitted.idempotencyKey = `cell:${createHash("sha256").update(JSON.stringify([beeId, generation, verb, admitted.idempotencyKey])).digest("hex")}`;
  }
  return admitted;
}
