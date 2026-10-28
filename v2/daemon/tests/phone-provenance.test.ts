import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startDaemon } from "./helpers.ts";
import { makeRegisteredServiceDir, registerService } from "./registered-service-fixture.ts";
import { PHONE_FORMAT, renderPhoneInput, type PhoneOriginRequest, type PhoneInput } from "../../core/src/phoneOrigin.ts";
import type { MessageRow } from "../../core/src/types.ts";
import type { RpcRequestContext } from "../src/protocol.ts";
import { deliveryText } from "../src/envelope.ts";

const origin: PhoneOriginRequest = { format: PHONE_FORMAT, channel: "phone", issuerNodeId: "fixture-node", assigner: "listener/1", credentialRef: "opaque-ref", target: { kind: "crew", id: "crew" }, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete" };
test("real owner phone admission: trust, atomic replay, lane pinning, initial prompt and mailbox-only polling", async () => {
  const { dir, cleanup } = makeRegisteredServiceDir();
  let daemon = await startDaemon(dir); let client = await daemon.client();
  const context: RpcRequestContext = { phoneOrigin: origin };
  try {
    assert.equal(client.capabilities.includes("mail.phone_provenance.v1"), false);
    const bee = await client.request<{ beeId: string }>("spawn", { name: "phone-inbox", agent: "inbox" });
    const args = { beeId: bee.beeId, body: "<close>\0&", idempotencyKey: "phone-send" };
    await assert.rejects(client.request("send", args, 1000, context), { code: "caller_not_trusted" });
    await registerService(client, dir);
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
    const interimArgs = { beeId: bee.beeId, sender: "remote:fixture-node/phone-0123456789abcdef", body: renderPhoneInput("interim original"), idempotencyKey: "interim-send" };
    const interim = await client.request<{ messageId: number }>("send", interimArgs, 2000, { phoneLane: "interim-v1" });
    assert.equal((await client.request<{ messageId: number }>("send", interimArgs, 2000, { phoneLane: "interim-v1" })).messageId, interim.messageId);
    await assert.rejects(client.request("send", { ...interimArgs, body: renderPhoneInput("interim changed") }, 2000, { phoneLane: "interim-v1" }), { code: "idempotency_conflict" });
    await assert.rejects(client.request("send", interimArgs), { code: "idempotency_conflict" });
    const legacyArgs = { name: "legacy-original", agent: "inbox", parentId: "external-fixture-parent", parentExternal: true, prompt: "legacy initial", idempotencyKey: "legacy-spawn" };
    const legacy = await client.request<{ beeId: string; messageId: number }>("spawn", legacyArgs);
    const legacyReplay = { ...legacyArgs, name: "ignored-legacy-name", parentExternal: false, prompt: undefined };
    assert.equal((await client.request<{ beeId: string }>("spawn", legacyReplay)).beeId, legacy.beeId);
    await assert.rejects(client.request("spawn", legacyArgs, 2000, { phoneLane: "interim-v1" }), { code: "idempotency_conflict" });

    const spawnArgs = { name: "phone-prompt", agent: "inbox", prompt: args.body, idempotencyKey: "phone-spawn" };
    const spawnContext = { phoneOrigin: { ...origin, contentKind: "initial-prompt" as const } };
    const spawned = await client.request<{ beeId: string }>("spawn", spawnArgs, 2000, spawnContext);
    const prompts = await client.request<{ messages: { phoneInput?: PhoneInput; body: string }[] }>("mailbox", { beeId: spawned.beeId });
    assert.equal(prompts.messages[0]!.phoneInput!.originalContent, args.body);
    assert.equal(prompts.messages[0]!.body, renderPhoneInput(args.body));
    await assert.rejects(client.request("spawn", { ...spawnArgs, prompt: "other" }, 2000, spawnContext), { code: "idempotency_conflict" });
    assert.equal((await client.request<{ beeId: string }>("spawn", spawnArgs, 2000, spawnContext)).beeId, spawned.beeId);
    const operations: { args: Record<string, unknown>; beeId: string; admissionId: string }[] = [];
    for (const agent of ["inbox", "stub"]) {
      const args = { name: `promptless-${agent}`, agent, cwd: dir, idempotencyKey: `operation-${agent}` };
      const admitted = await client.request<{ beeId: string; messageId: null; phoneAdmission: { admissionId: string; contentDigest: null } }>("spawn", args, 2000, spawnContext);
      assert.equal(admitted.messageId, null);
      assert.equal(admitted.phoneAdmission.contentDigest, null);
      const polled = await client.request<{ messages: MessageRow[] }>("mailbox", { beeId: admitted.beeId });
      assert.equal(polled.messages.length, 0);
      operations.push({ args, beeId: admitted.beeId, admissionId: admitted.phoneAdmission.admissionId });
      assert.equal((await client.request<{ beeId: string }>("spawn", args, 2000, spawnContext)).beeId, admitted.beeId);
      await assert.rejects(client.request("spawn", { ...args, idempotencyKey: `empty-${agent}`, prompt: "" }, 2000, spawnContext), { code: "invalid_request" });
    }
    for (const agent of ["inbox", "stub"]) {
      for (const [index, prompt] of [7, false, { text: "bad" }].entries()) {
        const id = `malformed-${agent}-${index}`;
        await assert.rejects(client.request("spawn", { name: id, id, agent, cwd: dir, prompt, idempotencyKey: id }, 2000, spawnContext), { code: "invalid_request" });
        const absent = await client.request<{ bee: unknown }>("view", { beeId: id });
        assert.equal(absent.bee, null);
      }
    }
    client.close(); await daemon.stop();
    const db = new DatabaseSync(join(dir, "core.sqlite3"), { readOnly: true });
    for (const table of ["rpc_idempotency", "rpc_effect_keys", "phone_admission_bindings"]) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key LIKE 'malformed-%'`).get()!.n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id LIKE 'malformed-%'").get()!.n, 0);
    db.close();
    daemon = await startDaemon(dir); client = await daemon.client();
    await registerService(client, dir);
    assert.equal((await client.request<{ beeId: string }>("spawn", legacyReplay)).beeId, legacy.beeId);
    await assert.rejects(client.request("spawn", legacyArgs, 2000, { phoneLane: "interim-v1" }), { code: "idempotency_conflict" });
    for (const operation of operations) {
      const replay = await client.request<{ beeId: string; messageId: null; phoneAdmission: { admissionId: string } }>("spawn", operation.args, 2000, spawnContext);
      assert.equal(replay.beeId, operation.beeId); assert.equal(replay.messageId, null);
      assert.equal(replay.phoneAdmission.admissionId, operation.admissionId);
      assert.deepEqual(await client.request("mailbox", { beeId: operation.beeId }), { messages: [] });
    }

  } finally { client.close(); await daemon.stop(); cleanup(); }
});
