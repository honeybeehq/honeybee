import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";

const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;
for (const enabled of [false, true]) test(`human provenance requires registered direct Apiary authority: trust=${enabled}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "human-rpc-"));
  const keyFile = join(root, "private", "key");
  const seen: unknown[] = [];
  const server = new RpcServer({ socketPath: join(root, "rpc.sock"), dataDir: root,
    localTrust: { requireObservationCaller: enabled, registrationKeyFile: keyFile }, log: () => {},
    dispatch: (verb, params, conn) => { const result = { verb, params, humanChat: conn.humanChat ?? null, authority: conn.humanPolicyAuthority ?? false }; seen.push(result); return result; } });
  const clients: RpcClient[] = [];
  try {
    await server.listen();
    const c = await RpcClient.connect(join(root, "rpc.sock")); clients.push(c);
    assert.equal(c.capabilities.includes("mail.humanFirst.v1"), enabled);
    const params = { beeId: "fixture", body: "hello", idempotencyKey: "key" };
    const humanChat = { version: 1 as const, authorityId: "paired-workstation", admissionId: "admission", beeId: params.beeId, bodySha256: createHash("sha256").update(params.body).digest("hex"), idempotencyKey: params.idempotencyKey, humanFirst: true };
    await assert.rejects(c.request("send", params, 1000, { humanChat }), code("human_chat_unauthorized"));
    await assert.rejects(c.request("mail.humanFirst.set", { beeId: "fixture", enabled: true }), code("human_chat_unauthorized"));
    await assert.rejects(c.request("send", { ...params, humanChat }), code("human_chat_unauthorized"));
    if (!enabled) return;
    const challenge = await c.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await c.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    const result = await c.request<{ humanChat: unknown }>("send", params, 1000, { humanChat });
    assert.deepEqual(result.humanChat, humanChat);
    for (const change of [{ body: "tampered" }, { beeId: "other" }, { idempotencyKey: "other" }]) await assert.rejects(c.request("send", { ...params, ...change }, 1000, { humanChat }), code("human_chat_invalid"));
    for (const sender of ["bee-fixture", "automation:notice", "remote:node/bee", "human: "]) await assert.rejects(c.request("send",{...params,sender},1000,{humanChat}),code("human_chat_invalid"));
    await assert.rejects(c.request("send",{...params,senderKind:"automation"},1000,{humanChat}),code("human_chat_invalid"));
    const policy = await c.request<{ authority: boolean }>("mail.humanFirst.set", { beeId: "fixture", enabled: true });
    assert.equal(policy.authority, true);
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(join(root, "rpc.sock"), 1000, lane); clients.push(relay);
      await assert.rejects(relay.request("send", params, 1000, { humanChat }), code("human_chat_unauthorized"));
    }
    const ordinary = await c.request<{ humanChat: unknown }>("send", { ...params, senderKind: "human" });
    assert.equal(ordinary.humanChat, null);
    assert.equal(seen.length, 3);
  } finally { for (const c of clients) c.close(); await server.close(); }
});
