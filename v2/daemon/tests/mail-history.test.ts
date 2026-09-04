import assert from "node:assert/strict";
import { test } from "node:test";
import { openCoreStore } from "../../core/src/index.ts";
import {
  RpcError,
  type DeployInfoResult,
  type MailHistoryResult,
} from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, type DaemonHandle } from "./helpers.ts";

test("rpc.mail.history exposes capped, snapshot-stable backward pages and canceled mail", async () => {
  const rig = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(`${rig.dir}/core.sqlite3`, { ephemeral: true });
    const created = store.createBee({
      name: "rpc-history",
      agent: "stub",
      substrate: "hsr",
      cwd: rig.dir,
    });
    const sentIds: number[] = [];
    for (let i = 0; i < 251; i += 1) {
      sentIds.push(store.send(created.bee.id, `history ${i}`).message.id);
    }
    assert.deepEqual(store.cancelMessage(sentIds[0]!), { canceled: true });
    store.close();

    daemon = await startDaemon(rig.dir);
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("mail.history.v1"));

    const first = await client.request<MailHistoryResult>("mail.history", { limit: 1_000 });
    assert.equal(first.messages.length, 250, "RPC clamps one page to the wire maximum");
    assert.equal(first.total, 251);
    assert.equal(first.messages[0]?.messageId, sentIds[250]);
    assert.equal(first.messages[249]?.messageId, sentIds[1]);
    assert.equal(first.truncated, true);
    assert.ok(first.nextBeforeSeq);

    const second = await client.request<MailHistoryResult>("mail.history", {
      beforeSeq: first.nextBeforeSeq,
      snapshotSeq: first.snapshotSeq,
    });
    assert.equal(second.snapshotSeq, first.snapshotSeq);
    assert.equal(second.total, 251);
    assert.equal(second.truncated, false);
    assert.deepEqual(second.messages.map((message) => message.messageId), [sentIds[0]]);
    assert.equal(second.messages[0]?.lifecycle.state, "canceled");

    await assert.rejects(
      client.request("mail.history", { beforeSeq: -1 }),
      (error: unknown) => error instanceof RpcError && error.code === "invalid_request",
    );
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    rig.cleanup();
  }
});
