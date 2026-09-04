import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("mail history pages by sends and folds delivered, expedited, and canceled audit events", () => {
  const store = openCoreStore(":memory:", { ephemeral: true });
  try {
    const firstBee = makeBee(store, "history-first").bee;
    const secondBee = makeBee(store, "history-second").bee;
    const noiseBee = makeBee(store, "history-noise").bee;
    bootToRunning(store, firstBee.id, 101, 1_001);

    const delivered = store.send(firstBee.id, "old delivered", { urgency: "idle" }).message;
    assert.deepEqual(store.expediteMessage(delivered.id, "now"), { applied: true });
    assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: true });
    assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: false });

    const canceled = store.send(secondBee.id, "canceled but retained", { urgency: "idle" }).message;
    assert.deepEqual(store.cancelMessage(canceled.id), { canceled: true });
    assert.equal(store.getMessage(canceled.id), null, "cancel still deletes the mailbox row");

    const queued = store.send(firstBee.id, "new queued").message;

    const audit = store.auditRows();
    const enqueueSeq = new Map(
      audit
        .filter((row) => row.kind === "mail.enqueued")
        .map((row) => [(row.payload.message as { id: number }).id, row.seq]),
    );
    const expeditedAt = audit.find(
      (row) => row.kind === "mail.expedited" && row.payload.messageId === delivered.id,
    )?.ts;
    const canceledAt = audit.find(
      (row) => row.kind === "mail.canceled" && row.payload.messageId === canceled.id,
    )?.ts;
    assert.ok(expeditedAt);
    assert.ok(canceledAt);

    for (let i = 0; i < 1_005; i += 1) store.recordOutput(noiseBee.id);

    const firstPage = store.mailHistory({ limit: 2 });
    assert.deepEqual(firstPage.messages.map((message) => message.messageId), [queued.id, canceled.id]);
    assert.equal(firstPage.total, 3);
    assert.equal(firstPage.truncated, true);
    assert.equal(firstPage.nextBeforeSeq, enqueueSeq.get(canceled.id));
    assert.ok(firstPage.snapshotSeq > (enqueueSeq.get(queued.id) ?? 0));
    assert.deepEqual(firstPage.messages[0], {
      seq: enqueueSeq.get(queued.id),
      messageId: queued.id,
      beeId: firstBee.id,
      sender: "operator",
      body: "new queued",
      priority: 0,
      urgency: "next",
      enqueuedAt: queued.enqueuedAt,
      expeditedAt: null,
      lifecycle: { state: "queued" },
    });
    assert.deepEqual(firstPage.messages[1]?.lifecycle, { state: "canceled", canceledAt });

    store.recordOutput(noiseBee.id);
    const secondPage = store.mailHistory({
      limit: 2,
      beforeSeq: firstPage.nextBeforeSeq ?? undefined,
      snapshotSeq: firstPage.snapshotSeq,
    });
    assert.equal(secondPage.snapshotSeq, firstPage.snapshotSeq);
    assert.equal(secondPage.total, 3);
    assert.equal(secondPage.truncated, false);
    assert.equal(secondPage.nextBeforeSeq, null);
    assert.deepEqual(secondPage.messages, [
      {
        seq: enqueueSeq.get(delivered.id),
        messageId: delivered.id,
        beeId: firstBee.id,
        sender: "operator",
        body: "old delivered",
        priority: 0,
        urgency: "now",
        enqueuedAt: delivered.enqueuedAt,
        expeditedAt,
        lifecycle: {
          state: "delivered",
          deliveredAt: store.getMessage(delivered.id)?.deliveredAt,
          deliveredGeneration: 1,
        },
      },
    ]);
  } finally {
    store.close();
  }
});

test("mail history audit indexes are installed on disk", () => {
  const rig = harness();
  try {
    const store = rig.open();
    store.close();
    const db = new DatabaseSync(rig.path, { readOnly: true });
    try {
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>).map((row) => row.name);
      assert.ok(names.includes("audit_mail_enqueued_seq"));
      assert.ok(names.includes("audit_mail_lifecycle_message_seq"));
    } finally {
      db.close();
    }
  } finally {
    rig.cleanup();
  }
});
