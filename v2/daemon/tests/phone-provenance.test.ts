import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDaemonDir, startDaemon } from "./helpers.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { PHONE_FORMAT, renderPhoneInput, type PhoneOriginRequest, type PhoneInput } from "../../core/src/phoneOrigin.ts";
import type { MessageRow } from "../../core/src/types.ts";
import type { RpcRequestContext } from "../src/protocol.ts";
import { deliveryText } from "../src/envelope.ts";

const origin: PhoneOriginRequest = { format: PHONE_FORMAT, channel: "phone", issuerNodeId: "fixture-node", assigner: "listener/1", credentialRef: "opaque-ref", target: { kind: "crew", id: "crew" }, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete" };
test("real owner phone admission: trust, atomic replay, lane pinning, initial prompt and mailbox-only polling", async () => {
  const { dir, cleanup } = makeDaemonDir({ rpcLocalTrust: { requireObservationCaller: true } });
  const daemon = await startDaemon(dir); const client = await daemon.client();
  const context: RpcRequestContext = { phoneOrigin: origin };
  try {
    assert.equal(client.capabilities.includes("mail.phone_provenance.v1"), false);
    const bee = await client.request<{ beeId: string }>("spawn", { name: "phone-inbox", agent: "inbox" });
    const args = { beeId: bee.beeId, body: "<close>\0&", idempotencyKey: "phone-send" };
    await assert.rejects(client.request("send", args, 1000, context), { code: "caller_not_trusted" });
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(join(dir, "rpc-private", "registration.key"));
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    const accepted = await client.request<{ messageId: number; phoneAdmission: { admissionId: string } }>("send", args, 2000, context);
    const retry = await client.request<{ messageId: number; deduped: boolean }>("send", args, 2000, context);
    assert.equal(retry.messageId, accepted.messageId); assert.equal(retry.deduped, true);
    for (const changed of [{ ...args, body: "changed" }, { ...args, beeId: "changed" }]) await assert.rejects(client.request("send", changed, 2000, context), { code: "idempotency_conflict" });
    await assert.rejects(client.request("send", args, 2000, { phoneLane: "interim-v1" }), { code: "idempotency_conflict" });
    await assert.rejects(client.request("send", { ...args, idempotencyKey: "bad-args", phoneOrigin: origin }), { code: "invalid_request" });
    const mailbox = await client.request<{ messages: MessageRow[] }>("mailbox", { beeId: bee.beeId });
    const message = mailbox.messages[0]!;
    assert.equal(message.phoneInput!.envelope.admissionId, accepted.phoneAdmission.admissionId);
    assert.equal(message.body, renderPhoneInput(args.body));
    assert.equal(message.renderedBody, message.body);
    assert.equal(deliveryText(message, true), message.body);
    await client.request("mail.ack", { beeId: bee.beeId, all: true });
    const spawnArgs = { name: "phone-prompt", agent: "inbox", prompt: args.body, idempotencyKey: "phone-spawn" };
    const spawnContext = { phoneOrigin: { ...origin, contentKind: "initial-prompt" as const } };
    const spawned = await client.request<{ beeId: string }>("spawn", spawnArgs, 2000, spawnContext);
    const prompts = await client.request<{ messages: { phoneInput?: PhoneInput; body: string }[] }>("mailbox", { beeId: spawned.beeId });
    assert.equal(prompts.messages[0]!.phoneInput!.originalContent, args.body);
    assert.equal(prompts.messages[0]!.body, renderPhoneInput(args.body));
    await assert.rejects(client.request("spawn", { ...spawnArgs, prompt: "other" }, 2000, spawnContext), { code: "idempotency_conflict" });
    assert.equal((await client.request<{ beeId: string }>("spawn", spawnArgs, 2000, spawnContext)).beeId, spawned.beeId);
  } finally { client.close(); await daemon.stop(); cleanup(); }
});
