import assert from "node:assert/strict";
import { test } from "node:test";
import type { SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import type { RpcClient } from "../../cli/src/client.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

async function turnFor(client: RpcClient, beeId: string, messageId: number) {
  let view: ViewResult | null = null;
  await waitFor(async () => {
    view = await client.request<ViewResult>("view", { beeId });
    const trigger = view.bee?.lastTurnTrigger;
    return trigger?.messageId === messageId && trigger.endedAt !== null;
  }, `turn for message ${messageId} ended`, 20_000);
  return view!.bee!;
}

test("turn-trigger.rpc: send senderKind automation opens an other turn, operator stays human, bad kinds are refused", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const champion = await client.request<SpawnResult>("spawn", { name: "champion", agent: "stub", cwd: "/tmp" });
    const worker = await client.request<SpawnResult>("spawn", { name: "worker", agent: "stub", cwd: "/tmp" });

    const prompt = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "hello" });
    const human = await turnFor(client, champion.beeId, prompt.messageId);
    assert.deepEqual([human.lastTurnTrigger!.kind, human.lastTurnTrigger!.from], ["human", "operator"]);
    assert.equal(human.lastHumanOutputAt, human.lastOutputAt);

    const notice = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "proof landed", senderKind: "automation" });
    const automated = await turnFor(client, champion.beeId, notice.messageId);
    assert.deepEqual([automated.lastTurnTrigger!.kind, automated.lastTurnTrigger!.from, automated.lastTurnTrigger!.humanAt], ["other", "operator", null]);
    assert.equal(automated.lastHumanOutputAt, human.lastHumanOutputAt, "automated notices never count as human output");

    const typed = await client.request<SendRpcResult>("send", { beeId: champion.beeId, body: "typed in the composer", senderKind: "human" });
    const composer = await turnFor(client, champion.beeId, typed.messageId);
    assert.equal(composer.lastTurnTrigger!.kind, "human");
    assert.equal(composer.lastHumanOutputAt, composer.lastOutputAt);

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
