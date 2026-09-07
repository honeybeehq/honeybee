import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  openCoreStore,
  type CommittedMailboxMembership,
  type CoreStore,
  type MailboxMembership,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const MEMBERSHIP_SQL = `SELECT SUM(row_count) AS message_count, MAX(max_id) AS max_message_id
       FROM (
         SELECT COUNT(*) AS row_count, MAX(id) AS max_id
         FROM mailbox
         WHERE bee_id = ? AND delivered_at IS NULL
         UNION ALL
         SELECT COUNT(*) AS row_count, MAX(id) AS max_id
         FROM mailbox
         WHERE bee_id = ? AND delivered_at IS NOT NULL
       )`;

function committed(value: MailboxMembership): CommittedMailboxMembership {
  if (value.kind !== "committed") assert.fail("expected committed mailbox membership");
  return value;
}

function expected(messageCount: number, maxMessageId: number | null): CommittedMailboxMembership {
  return { kind: "committed", messageCount, maxMessageId };
}

function sqliteTextField(row: unknown, field: string): string {
  if (row === null || typeof row !== "object") throw new Error(`missing SQLite ${field}`);
  const value: unknown = Reflect.get(row, field);
  if (typeof value !== "string") throw new Error(`SQLite ${field} is not text`);
  return value;
}

function createExplicitBee(store: CoreStore, id: string, name: string) {
  return store.createBee({
    id,
    name,
    agent: "claude",
    substrate: "tmux",
    cwd: "/tmp/w",
    handle: "CL.cafe",
  });
}

test("mailbox membership is exact for empty, missing, mixed, and isolated Bees without writes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const empty = makeBee(store, "empty").bee;
  const target = makeBee(store, "mixed-target").bee;
  const other = makeBee(store, "mixed-other").bee;

  const delivered = store.send(target.id, "target delivered").message;
  store.send(other.id, "foreign pending one");
  const pending = store.send(target.id, "target pending").message;
  const foreignHighest = store.send(other.id, "foreign pending highest").message;
  assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: true });
  assert.ok(foreignHighest.id > pending.id, "foreign ids must not affect the target global max");

  const stateBefore = store.dumpState();
  const auditBefore = store.auditRows();
  const auditSeqBefore = store.lastAuditSeq();

  assert.deepEqual(store.readMailboxMembership(empty.id), expected(0, null));
  assert.deepEqual(store.readMailboxMembership("missing-membership-bee"), expected(0, null));
  assert.deepEqual(store.readMailboxMembership(target.id), expected(2, pending.id));
  assert.deepEqual(store.readMailboxMembership(other.id), expected(2, foreignHighest.id));
  assert.deepEqual(store.readMailboxMembership(target.id), expected(2, pending.id), "cached statement repeats exactly");

  assert.deepEqual(store.dumpState(), stateBefore, "membership reads do not change authoritative state");
  assert.deepEqual(store.auditRows(), auditBefore, "membership reads append no audit rows");
  assert.equal(store.lastAuditSeq(), auditSeqBefore, "membership reads preserve the audit head");
});

test("delivery and urgency changes preserve combined membership", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "delivery-silence");
  const first = store.send(bee.id, "first").message;
  const second = store.send(bee.id, "second", { urgency: "idle" }).message;
  const baseline = committed(store.readMailboxMembership(bee.id));
  assert.deepEqual(baseline, expected(2, second.id));

  assert.deepEqual(store.expediteMessage(bee.id, second.id, "now"), { applied: true });
  assert.deepEqual(store.readMailboxMembership(bee.id), baseline, "urgency is outside membership");
  assert.deepEqual(store.markDelivered(second.id, runtime.generation), { applied: true });
  assert.deepEqual(
    store.readMailboxMembership(bee.id),
    baseline,
    "the global maximum stays exact when the highest id is delivered and a lower id remains pending",
  );
  assert.deepEqual(store.markDelivered(first.id, runtime.generation), { applied: true });
  assert.deepEqual(store.readMailboxMembership(bee.id), baseline, "an all-delivered mailbox is identical");
});

test("pending cancellation updates interior and highest ids while send-cancel can be net equal", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "cancel-membership");
  const first = store.send(bee.id, "retained delivered").message;
  const interior = store.send(bee.id, "interior pending").message;
  const highest = store.send(bee.id, "highest pending").message;
  assert.deepEqual(store.markDelivered(first.id, runtime.generation), { applied: true });
  assert.deepEqual(store.readMailboxMembership(bee.id), expected(3, highest.id));

  assert.deepEqual(store.cancelMessage(bee.id, interior.id), { canceled: true });
  assert.deepEqual(
    store.readMailboxMembership(bee.id),
    expected(2, highest.id),
    "canceling an interior row preserves max",
  );
  assert.deepEqual(store.cancelMessage(bee.id, highest.id), { canceled: true });
  const retained = expected(1, first.id);
  assert.deepEqual(store.readMailboxMembership(bee.id), retained, "canceling the highest row lowers max");

  const transient = store.send(bee.id, "net-zero pending").message;
  assert.deepEqual(store.readMailboxMembership(bee.id), expected(2, transient.id));
  assert.deepEqual(store.cancelMessage(bee.id, transient.id), { canceled: true });
  assert.deepEqual(store.readMailboxMembership(bee.id), retained, "send then cancel restores the exact pair");
});

test("open transactions are uncacheable and rolled-back message ids may be reused", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const bee = makeBee(store, "rollback-id-reuse").bee;
  const baseline = committed(store.readMailboxMembership(bee.id));
  assert.deepEqual(baseline, expected(0, null));
  const boom = new Error("membership rollback");
  let speculativeId: number | null = null;

  assert.throws(
    () => store.transact(() => {
      const speculative = store.send(bee.id, "speculative body").message;
      speculativeId = speculative.id;
      assert.deepEqual(store.readMailboxMembership(bee.id), { kind: "transaction_open" });
      assert.deepEqual(store.listMessages(bee.id).map((message) => message.body), ["speculative body"]);
      throw boom;
    }),
    (error: unknown) => error === boom,
  );

  assert.deepEqual(store.listMessages(bee.id), []);
  assert.deepEqual(store.readMailboxMembership(bee.id), baseline, "rollback restores committed membership");
  if (speculativeId === null) assert.fail("speculative send did not run");

  const durable = store.send(bee.id, "durable different body").message;
  assert.equal(durable.id, speculativeId, "SQLite may reuse the rolled-back AUTOINCREMENT id");
  assert.deepEqual(store.readMailboxMembership(bee.id), expected(1, durable.id));
  assert.deepEqual(store.listMessages(bee.id).map((message) => message.body), ["durable different body"]);
});

test("a caught post-insert audit failure still yields the committed membership", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let remaining = -1;
  const clockError = new Error("controlled clock failure after mailbox insert");
  const store = openCoreStore(h.path, {
    ephemeral: true,
    now: () => {
      if (remaining === 0) throw clockError;
      if (remaining > 0) remaining -= 1;
      return 1_000;
    },
  });
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "caught-write");
  store.updateRuntimeState(bee.id, runtime.generation, "running");
  const baseline = committed(store.readMailboxMembership(bee.id));
  const auditCountBefore = store.auditRows().length;
  let caught = false;

  store.transact(() => {
    remaining = 1;
    try {
      store.send(bee.id, "inserted before nested audit throws", { urgency: "idle" });
    } catch (error) {
      assert.equal(error, clockError);
      caught = true;
    } finally {
      remaining = -1;
    }
    assert.equal(store.inTransaction, true);
    assert.deepEqual(store.readMailboxMembership(bee.id), { kind: "transaction_open" });
    assert.deepEqual(store.listMessages(bee.id).map((message) => message.body), [
      "inserted before nested audit throws",
    ]);
  });

  assert.equal(caught, true);
  const messages = store.listMessages(bee.id);
  assert.equal(messages.length, 1);
  assert.equal(store.auditRows().length, auditCountBefore, "the failing audit itself did not commit");
  assert.deepEqual(
    store.readMailboxMembership(bee.id),
    expected(baseline.messageCount + 1, messages[0]!.id),
    "the aggregate derives the SQL row committed by the outer transaction",
  );
});

test("cascade deletion, explicit-id recreation, and reopen preserve committed membership", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const id = "membership-recreated-bee";
  const original = createExplicitBee(store, id, "original");
  const delivered = store.send(id, "old delivered").message;
  const oldHighest = store.send(id, "old pending").message;
  assert.deepEqual(store.markDelivered(delivered.id, original.runtime.generation), { applied: true });
  assert.deepEqual(store.readMailboxMembership(id), expected(2, oldHighest.id));

  store.deleteBee(id);
  assert.equal(store.getBee(id), null);
  assert.deepEqual(store.readMailboxMembership(id), expected(0, null), "missing Bee has empty membership");

  createExplicitBee(store, id, "recreated");
  assert.deepEqual(store.readMailboxMembership(id), expected(0, null));
  const replacement = store.send(id, "new incarnation").message;
  assert.ok(replacement.id > oldHighest.id, "committed AUTOINCREMENT ids are not reused after cascade delete");
  const beforeClose = expected(1, replacement.id);
  assert.deepEqual(store.readMailboxMembership(id), beforeClose);

  store.close();
  store = h.open();
  assert.deepEqual(store.readMailboxMembership(id), beforeClose, "membership is derived afresh on reopen");
  assert.deepEqual(store.listMessages(id).map((message) => message.body), ["new incarnation"]);
});

test("production aggregate uses both partial indexes and validates SQLite scalars", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const bee = makeBee(store, "membership-plan").bee;
  const malformedBee = makeBee(store, "malformed-membership").bee;
  const unsafeIntegerBee = makeBee(store, "unsafe-integer-membership").bee;
  const delivered = store.send(bee.id, "delivered plan row").message;
  const pending = store.send(bee.id, "pending plan row").message;
  assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: true });
  assert.deepEqual(store.readMailboxMembership(bee.id), expected(2, pending.id));
  store.close();

  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  assert.ok(normalize(source).includes(normalize(MEMBERSHIP_SQL)), "test exercises the exact production SQL");
  assert.equal(Array.from(MEMBERSHIP_SQL.matchAll(/\?/g)).length, 2, "the statement has exactly two Bee bindings");

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const plan = check.prepare(`EXPLAIN QUERY PLAN ${MEMBERSHIP_SQL}`).all(bee.id, bee.id)
      .map((row) => sqliteTextField(row, "detail"))
      .join("\n");
    assert.match(plan, /SEARCH mailbox USING COVERING INDEX mailbox_pending_metadata \(bee_id=\?\)/);
    assert.match(plan, /SEARCH mailbox USING (?:COVERING )?INDEX mailbox_delivered_by_bee \(bee_id=\?\)/);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
    assert.doesNotMatch(plan, /SCAN mailbox(?:\s|$)/, "neither arm may scan the whole mailbox");
  } finally {
    check.close();
  }

  const corrupt = new DatabaseSync(h.path);
  try {
    const insert = corrupt.prepare(
      `INSERT INTO mailbox(id, bee_id, sender, body, priority, urgency, enqueued_at)
       VALUES(?, ?, 'fixture', ?, 0, 'next', 1)`,
    );
    insert.run(-1, malformedBee.id, "invalid negative id");
    insert.run(9_007_199_254_740_993n, unsafeIntegerBee.id, "unsafe integer id");
  } finally {
    corrupt.close();
  }
  store = h.open();
  store.transact(() => {
    assert.deepEqual(
      store.readMailboxMembership(malformedBee.id),
      { kind: "transaction_open" },
      "an outer transaction returns before reading a malformed aggregate",
    );
    store.transact(() => {
      assert.deepEqual(
        store.readMailboxMembership(malformedBee.id),
        { kind: "transaction_open" },
        "a nested transaction returns before reading a malformed aggregate",
      );
    });
  });
  assert.throws(
    () => store.readMailboxMembership(malformedBee.id),
    /readMailboxMembership: malformed max_message_id/,
  );
  assert.throws(
    () => store.readMailboxMembership(unsafeIntegerBee.id),
    (error: unknown) => {
      assert.ok(error instanceof RangeError, "node:sqlite reports an unsafe integer as RangeError");
      assert.equal(Reflect.get(error, "code"), "ERR_OUT_OF_RANGE");
      assert.match(error.message, /too large to be represented as a JavaScript number/);
      return true;
    },
  );
});
