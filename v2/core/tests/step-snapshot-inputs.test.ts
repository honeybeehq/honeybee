import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";

function stringField(row: unknown, field: "detail" | "name" | "sql" | "value"): string {
  if (row === null || typeof row !== "object") throw new Error(`missing SQLite ${field} field`);
  switch (field) {
    case "detail":
      if (!("detail" in row) || typeof row.detail !== "string") throw new Error("SQLite detail field is not text");
      return row.detail;
    case "name":
      if (!("name" in row) || typeof row.name !== "string") throw new Error("SQLite name field is not text");
      return row.name;
    case "sql":
      if (!("sql" in row) || typeof row.sql !== "string") throw new Error("SQLite sql field is not text");
      return row.sql;
    case "value":
      if (!("value" in row) || typeof row.value !== "string") throw new Error("SQLite value field is not text");
      return row.value;
    default: {
      const exhaustive: never = field;
      throw new Error(`unknown SQLite field: ${exhaustive}`);
    }
  }
}

function indexColumns(db: DatabaseSync, name: string): string[] {
  return db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name)
    .map((row) => stringField(row, "name"));
}

function planDetails(db: DatabaseSync, sql: string): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    .map((row) => stringField(row, "detail"));
}

test("step snapshot inputs prove empty across stopped history and detect every live runtime state", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  assert.equal(store.hasStepSnapshotInputs(), false, "an empty store has no step input");

  const { bee, runtime } = makeBee(store, "state-probe");
  store.archiveBee(bee.id);
  assert.equal(store.currentRuntime(bee.id)?.state, "booting");
  assert.equal(store.hasStepSnapshotInputs(), true, "an archived booting runtime remains live input");

  store.unarchiveBee(bee.id);
  store.updateRuntimeState(bee.id, runtime.generation, "running", { pid: 101, pidStartedAt: 10 });
  assert.equal(store.hasStepSnapshotInputs(), true, "running is live input");
  store.updateRuntimeState(bee.id, runtime.generation, "idle");
  assert.equal(store.hasStepSnapshotInputs(), true, "idle is live input");
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  assert.equal(store.hasStepSnapshotInputs(), false, "stopped is not step input without mail");

  store.setFlag(bee.id, "auth_needed", "test flag");
  store.setBeeTitle(bee.id, "retained metadata");
  store.tagBee(bee.id, { add: ["history"] });
  assert.equal(store.hasStepSnapshotInputs(), false, "flags and retained bee metadata do not need a snapshot");

  for (let generation = 2; generation <= 21; generation++) {
    const revived = store.reviveBee(bee.id);
    assert.equal(revived.generation, generation);
    assert.equal(store.hasStepSnapshotInputs(), true, `booting generation ${generation} is visible`);
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "clean" });
    assert.equal(store.hasStepSnapshotInputs(), false, `stopped history through generation ${generation} proves empty`);
  }

  const auditBeforeRead = store.lastAuditSeq();
  assert.equal(store.hasStepSnapshotInputs(), false);
  assert.equal(store.lastAuditSeq(), auditBeforeRead, "existence probes are read-only");
});

test("step snapshot inputs detect pending mail for stopped and absent runtimes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "mail-probe");
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  assert.equal(store.hasStepSnapshotInputs(), false);

  const stoppedMail = store.send(bee.id, "pending while stopped");
  assert.ok(stoppedMail.wakeCommand);
  assert.equal(store.hasStepSnapshotInputs(), true, "mail is input even when the current runtime is stopped");
  assert.deepEqual(store.cancelMessage(bee.id, stoppedMail.message.id), { canceled: true });
  assert.equal(store.hasStepSnapshotInputs(), false, "queued wake commands are outside the snapshot predicate");

  store.close();
  const fixture = new DatabaseSync(h.path);
  try {
    fixture.prepare("DELETE FROM runtimes WHERE bee_id = ?").run(bee.id);
  } finally {
    fixture.close();
  }

  store = h.open();
  assert.equal(store.currentRuntime(bee.id), null);
  assert.equal(store.hasStepSnapshotInputs(), false, "a bee with no runtime and no mail proves empty");
  const absentRuntimeMail = store.send(bee.id, "pending without a runtime");
  assert.ok(absentRuntimeMail.wakeCommand);
  assert.equal(store.currentRuntime(bee.id), null);
  assert.equal(store.hasStepSnapshotInputs(), true, "mail remains input when no runtime row exists");
});

test("an old noncurrent live runtime is a conservative step snapshot false positive", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "old-live");
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  const current = store.reviveBee(bee.id);
  store.updateRuntimeState(bee.id, current.generation, "stopped", { exitCause: "clean" });
  store.close();

  const fixture = new DatabaseSync(h.path);
  try {
    fixture.prepare(
      "UPDATE runtimes SET state = 'booting', exit_cause = NULL WHERE bee_id = ? AND generation = ?",
    ).run(bee.id, runtime.generation);
  } finally {
    fixture.close();
  }

  store = h.open();
  assert.equal(store.currentRuntime(bee.id)?.generation, current.generation);
  assert.equal(store.currentRuntime(bee.id)?.state, "stopped");
  assert.deepEqual(store.listUndeliveredMessages(), []);
  assert.equal(
    store.hasStepSnapshotInputs(),
    true,
    "the any-generation probe may run the old fallback but must never miss current work",
  );
});

test("pending indexes migrate on reopen: covering install, old-index drop idempotency, downgrade round-trip, full-body reads", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee, runtime } = makeBee(store, "index-probe");
  const delivered = store.send(bee.id, "delivered history only").message;
  assert.deepEqual(store.markDelivered(delivered.id, runtime.generation), { applied: true });
  store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
  for (let generation = 2; generation <= 20; generation++) {
    store.reviveBee(bee.id);
    store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "clean" });
  }
  // TWO pending bees with INTERLEAVED sends: the global projection must
  // group by bee_id then id, which differs from pure send (id) order.
  const mailA = makeBee(store, "mail-a").bee;
  store.updateRuntimeState(mailA.id, 1, "stopped", { exitCause: "clean" });
  const mailB = makeBee(store, "mail-b").bee;
  store.updateRuntimeState(mailB.id, 1, "stopped", { exitCause: "clean" });
  store.send(mailA.id, "a first", { urgency: "now" });
  store.send(mailB.id, "b first");
  store.send(mailA.id, "a second");
  store.send(mailB.id, "b second", { urgency: "idle" });
  store.send(mailA.id, "a third", { urgency: "idle" });
  const publicFifoA = store.undeliveredMessages(mailA.id);
  const publicFifoB = store.undeliveredMessages(mailB.id);
  assert.equal(publicFifoA.length, 3);
  assert.equal(publicFifoB.length, 2);
  const publicGlobal = store.listUndeliveredMessages();
  assert.equal(publicGlobal.length, 5);
  store.close();

  const raw = (sql: string) => {
    const db = new DatabaseSync(h.path);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const oldIndexPresent = () => {
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_undelivered'").get() !== undefined;
    } finally {
      db.close();
    }
  };
  const schemaVersionOf = () => {
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      return stringField(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(), "value");
    } finally {
      db.close();
    }
  };
  const schemaVersionBefore = schemaVersionOf();

  // Upgrade shape: a store written by an OLD build (or after a downgrade)
  // carries mailbox_undelivered; opening through the current build must drop
  // it AFTER the covering replacement exists, and reinstall the runtime index.
  raw("DROP INDEX IF EXISTS runtimes_daemon_live");
  raw("CREATE INDEX IF NOT EXISTS mailbox_undelivered ON mailbox(bee_id, id) WHERE delivered_at IS NULL");
  assert.equal(oldIndexPresent(), true);

  // BEFORE snapshots read UNDER old+covering (raw connection — the public
  // open would drop the old index first). The per-bee plan is asserted to
  // actually use the old index here, so the baseline genuinely exercises it.
  const FIFO_SQL = "SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id";
  const GLOBAL_SQL = "SELECT * FROM mailbox WHERE delivered_at IS NULL ORDER BY bee_id, id";
  const rawReads = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        fifoPlan: planDetails(db, FIFO_SQL).join("\n"),
        fifoA: db.prepare(FIFO_SQL).all(mailA.id),
        fifoB: db.prepare(FIFO_SQL).all(mailB.id),
        global: db.prepare(GLOBAL_SQL).all(),
      };
    } finally {
      db.close();
    }
  };
  const before = rawReads(h.path);
  assert.match(before.fifoPlan, /USING INDEX mailbox_undelivered/, "the before baseline must be served by the old index");
  assert.equal(before.global.length, 5);

  store = h.open(); // upgrade: the drop runs after the covering install
  // Public full-body reads keep exact order, content, and membership.
  assert.deepEqual(store.undeliveredMessages(mailA.id), publicFifoA, "per-bee FIFO unchanged for mail-a");
  assert.deepEqual(store.undeliveredMessages(mailB.id), publicFifoB, "per-bee FIFO unchanged for mail-b");
  assert.deepEqual(store.listUndeliveredMessages(), publicGlobal, "global full rows unchanged across the drop");
  store.close();
  assert.equal(oldIndexPresent(), false, "upgrade drops the superseded index");

  // AFTER snapshots on new-only, full-row deepEqual against the old+covering
  // baseline — the old-vs-new proof the drop must pass.
  const after = rawReads(h.path);
  assert.match(after.fifoPlan, /USING INDEX mailbox_pending_metadata/, "the after reads ride the covering index");
  assert.deepEqual(after.fifoA, before.fifoA, "full per-bee rows identical old+covering vs new-only");
  assert.deepEqual(after.fifoB, before.fifoB, "full per-bee rows identical old+covering vs new-only");
  assert.deepEqual(after.global, before.global, "full global rows identical old+covering vs new-only");
  // Explicit bee_id-then-id order, and it genuinely differs from send order:
  // the interleaved sends give each bee numerically interleaved ids, so a
  // grouped-by-bee sequence cannot be globally ascending by id.
  const orderKeys = after.global.map((r) => {
    const row = r as { bee_id?: unknown; id?: unknown };
    return { beeId: String(row.bee_id), id: Number(row.id) };
  });
  const sorted = [...orderKeys].sort((x, y) => (x.beeId < y.beeId ? -1 : x.beeId > y.beeId ? 1 : x.id - y.id));
  assert.deepEqual(orderKeys, sorted, "global rows are ordered by bee_id then id");
  const globalIds = orderKeys.map((k) => k.id);
  assert.notDeepEqual(globalIds, [...globalIds].sort((a, b) => a - b), "grouping by bee reorders the interleaved sends");
  assert.deepEqual(publicGlobal.map((m) => m.id), globalIds, "the public global list rides the same bee_id-then-id order");

  // Downgrade round-trip, twice: an old build would recreate it from its own
  // SCHEMA_SQL (scanning the WHOLE mailbox to filter delivered history); the
  // next open drops it again, idempotently.
  for (let round = 0; round < 2; round++) {
    raw("CREATE INDEX IF NOT EXISTS mailbox_undelivered ON mailbox(bee_id, id) WHERE delivered_at IS NULL");
    assert.equal(oldIndexPresent(), true);
    store = h.open();
    store.close();
    assert.equal(oldIndexPresent(), false, `downgrade round ${round}: re-upgrade drops it again`);
  }
  store = h.open(); // plain reopen: DROP IF EXISTS is a no-op on the absent index
  store.close();
  assert.equal(oldIndexPresent(), false);

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    assert.deepEqual(indexColumns(check, "runtimes_daemon_live"), ["bee_id", "generation"]);
    assert.match(
      stringField(
        check.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runtimes_daemon_live'").get(),
        "sql",
      ),
      /WHERE state != 'stopped'/,
    );

    const runtimePlan = planDetails(
      check,
      "SELECT 1 FROM runtimes WHERE state != 'stopped' LIMIT 1",
    ).join("\n");
    assert.match(runtimePlan, /USING (?:COVERING )?INDEX runtimes_daemon_live/);

    // With the old index gone, every pending access shape rides the covering
    // metadata index: the absence probe, the per-bee full-body FIFO seek, and
    // the global full-body list scan.
    const mailboxPlan = planDetails(
      check,
      "SELECT 1 FROM mailbox WHERE delivered_at IS NULL LIMIT 1",
    ).join("\n");
    assert.match(mailboxPlan, /USING COVERING INDEX mailbox_pending_metadata/);
    const fifoPlan = planDetails(
      check,
      "SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id",
    ).join("\n");
    assert.match(fifoPlan, /SEARCH mailbox USING INDEX mailbox_pending_metadata \(bee_id=\?\)/);
    assert.doesNotMatch(fifoPlan, /USE TEMP B-TREE/);
    const globalPlan = planDetails(
      check,
      "SELECT * FROM mailbox WHERE delivered_at IS NULL ORDER BY bee_id, id",
    ).join("\n");
    assert.match(globalPlan, /SCAN mailbox USING INDEX mailbox_pending_metadata/);
    assert.doesNotMatch(globalPlan, /USE TEMP B-TREE/);

    assert.equal(schemaVersionOf(), schemaVersionBefore, "index migration does not change the schema format");
  } finally {
    check.close();
  }

  // Emptiness proof preserved: cancel the held mail and the guard proves empty.
  store = h.open();
  for (const target of [mailA.id, mailB.id]) {
    for (const m of store.undeliveredMessages(target)) {
      assert.deepEqual(store.cancelMessage(target, m.id), { canceled: true });
    }
  }
  assert.equal(store.hasStepSnapshotInputs(), false, "delivered-only mail and stopped history stay empty");
});
