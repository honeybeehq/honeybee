import assert from "node:assert/strict";
import { test } from "node:test";
import type { SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";
import { makeRegisteredServiceDir, registerService, sendHumanChat } from "./registered-service-fixture.ts";

async function turnFor(client: RpcClient, beeId: string, messageId: number) {
  let view: ViewResult | null = null;
  await waitFor(async () => {
    view = await client.request<ViewResult>("view", { beeId });
    const trigger = view.bee?.lastTurnTrigger;
    return trigger?.messageId === messageId && trigger.endedAt !== null;
  }, `turn for message ${messageId} ended`, 20_000);
  return view!.bee!;
}

test("turn-trigger.rpc: bare, labelled and automation operator sends open other turns; only admitted human chat opens a human turn; bad kinds are refused", async () => {
  const { dir, cleanup } = makeRegisteredServiceDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const champion = await client.request<SpawnResult>("spawn", { name: "champion", agent: "stub", cwd: "/tmp" });
    const worker = await client.request<SpawnResult>("spawn", { name: "worker", agent: "stub", cwd: "/tmp" });

    const prompt = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "hello" });
    const bare = await turnFor(client, champion.beeId, prompt.messageId);
    assert.deepEqual([bare.lastTurnTrigger!.kind, bare.lastTurnTrigger!.from, bare.lastTurnTrigger!.humanAt], ["other", "operator", null]);
    assert.equal(bare.lastHumanOutputAt, null, "a bare operator send is automation, never human output");

    const labelled = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "labelled human", senderKind: "human" });
    const unadmitted = await turnFor(client, champion.beeId, labelled.messageId);
    assert.deepEqual([unadmitted.lastTurnTrigger!.kind, unadmitted.lastTurnTrigger!.from, unadmitted.lastTurnTrigger!.humanAt], ["other", "operator", null]);
    assert.equal(unadmitted.lastHumanOutputAt, null, "a senderKind label without admission never establishes human provenance");

    const notice = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "proof landed", senderKind: "automation" });
    const automated = await turnFor(client, champion.beeId, notice.messageId);
    assert.deepEqual([automated.lastTurnTrigger!.kind, automated.lastTurnTrigger!.from, automated.lastTurnTrigger!.humanAt], ["other", "operator", null]);
    assert.equal(automated.lastHumanOutputAt, null, "automated notices never count as human output");

    await registerService(client, dir);
    const typed = await sendHumanChat(client, champion.beeId, "typed in the composer", "composer");
    const composer = await turnFor(client, champion.beeId, typed.messageId);
    assert.deepEqual([composer.lastTurnTrigger!.kind, composer.lastTurnTrigger!.from], ["human", "operator"]);
    assert.ok(composer.lastTurnTrigger!.humanAt !== null);
    assert.equal(composer.lastHumanOutputAt, composer.lastOutputAt, "admitted human chat opens a human turn whose output is human output");

    const later = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "follow-up notice" });
    const afterHuman = await turnFor(client, champion.beeId, later.messageId);
    assert.equal(afterHuman.lastTurnTrigger!.kind, "other");
    assert.equal(afterHuman.lastHumanOutputAt, composer.lastHumanOutputAt, "the human cursor stays where the admitted turn left it");

    const bad = await client.request("send", { beeId: champion.beeId, body: "x", senderKind: "robot" }).then(() => null, (e: Error) => e);
    assert.match(String(bad), /senderKind must be one of human\|automation/);
    for (const senderKind of ["human", "automation"]) {
      const fromAgent = await client.request("send", { beeId: champion.beeId, body: "x", sender: worker.beeId, senderKind }).then(() => null, (e: Error) => e);
      assert.match(String(fromAgent), /senderKind is only for operator and human senders/, senderKind);
    }
    client.close();
  } finally {
    await daemon?.stop().catch(() => {});
    cleanup();
  }
});
