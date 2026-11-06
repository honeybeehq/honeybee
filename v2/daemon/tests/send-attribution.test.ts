import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { renameSync } from "node:fs";
import { startDaemon } from "./helpers.ts";
import { makeRegisteredServiceDir, registerService } from "./registered-service-fixture.ts";
import { resolveSendSender } from "../../cli/src/main.ts";
import { deliveryText, BUZ_INJECTION_MARKER, AUTOMATION_INJECTION_MARKER } from "../src/envelope.ts";
import type { MessageRow } from "../../core/src/types.ts";

test("session-only CLI identity is retained outside a Cell", () => {
  assert.equal(resolveSendSender([], undefined, "/fixture", { HIVE_SESSION_ID: "session-owner" }), "session-owner");
  assert.throws(() => resolveSendSender([], undefined, "/fixture", { HIVE_SESSION_ID: "one", HIVE_BEE_ID: "two" }), /identity/);
});

test("isolated owner records agent, unattributed and authenticated UI sends distinctly", async () => {
  const { dir } = makeRegisteredServiceDir();
  const daemon = await startDaemon(dir, { platform: process.platform });
  const client = await daemon.client();
  try {
    const agent = await client.request<{ beeId: string }>("spawn", { name: "outside-cell", agent: "inbox" });
    const target = await client.request<{ beeId: string }>("spawn", { name: "recipient", agent: "inbox" });
    execFileSync(process.execPath, [fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url)), "send", target.beeId, "agent report", "--socket", join(dir, "hived.sock"), "--data-dir", dir], {
      env: { ...process.env, HIVE_BEE_ID: "", HIVE_BEE: "", HIVE_SESSION_ID: agent.beeId, HIVE_V2_DATA_DIR: dir }, encoding: "utf8",
    });
    await client.request("send", { beeId: target.beeId, body: "unattributed report", senderKind: "human" });
    const initial = await client.request<{ messages: MessageRow[] }>("mailbox", { beeId: target.beeId });
    assert.equal(initial.messages[0]!.sender, agent.beeId);
    assert.equal(initial.messages[1]!.senderKind, "automation");
    await assert.rejects(client.request("send", { beeId: target.beeId, body: "untrusted principal" }, 2000, { sessionPrincipal: { beeId: agent.beeId } }), { code: "caller_not_trusted" });
    await registerService(client, dir);
    await client.request("send", { beeId: target.beeId, body: "authenticated agent", sender: "operator" }, 2000, { sessionPrincipal: { beeId: agent.beeId } });
    const body = "human UI input";
    await client.request("send", { beeId: target.beeId, body, idempotencyKey: "human-input" }, 2000, {
      humanChat: { version: 1, authorityId: "fixture-ui", admissionId: "human-input", beeId: target.beeId, bodySha256: createHash("sha256").update(body).digest("hex"), idempotencyKey: "human-input" },
    });
    const { messages } = await client.request<{ messages: MessageRow[] }>("mailbox", { beeId: target.beeId });
    assert.equal(messages[0]!.sender, agent.beeId);
    assert.ok(deliveryText(messages[0]!, true).startsWith(BUZ_INJECTION_MARKER));
    assert.equal(messages[1]!.senderKind, "automation");
    assert.equal(messages[1]!.humanChat, undefined);
    assert.ok(deliveryText(messages[1]!, false).startsWith(AUTOMATION_INJECTION_MARKER));
    assert.equal(messages[2]!.sender, agent.beeId);
    assert.equal(messages[3]!.senderKind, "human");
    assert.ok(messages[3]!.humanChat);
    assert.equal(deliveryText(messages[3]!, false), body);
    await assert.rejects(client.request("send", { beeId: target.beeId, body, idempotencyKey: "mixed" }, 2000, {
      sessionPrincipal: { beeId: agent.beeId },
      humanChat: { version: 1, authorityId: "fixture-ui", admissionId: "mixed", beeId: target.beeId, bodySha256: createHash("sha256").update(body).digest("hex"), idempotencyKey: "mixed" },
    }), { code: "human_chat_unauthorized" });
  } finally { client.close(); await daemon.stop(); renameSync(dir, `${dir}.trash`); }
});
