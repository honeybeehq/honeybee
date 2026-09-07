import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { AuditRow, CoreStore } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

function sqliteString(row: unknown, field: "detail" | "name" | "sql" | "value"): string {
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
    .map((row) => sqliteString(row, "name"));
}

function planDetails(db: DatabaseSync, sql: string, ...params: Array<string | number>): string[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
    .map((row) => sqliteString(row, "detail"));
}

function expectedTail(
  rows: AuditRow[],
  afterSeq: number,
  limit: number,
  beeId?: string | null,
): AuditRow[] {
  return rows
    .filter((row) => row.seq > afterSeq && (!beeId || row.beeId === beeId))
    .slice(-limit);
}

function capturePreparedSql<T>(operation: () => T): { value: T; sql: string[] } {
  const originalPrepare = DatabaseSync.prototype.prepare;
  const sql: string[] = [];
  DatabaseSync.prototype.prepare = function capturePrepare(source: string) {
    sql.push(source);
    return originalPrepare.call(this, source);
  };
  try {
    return { value: operation(), sql };
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
}

test("per-bee audit tails exactly match filtered authority across cursors, limits, and public filter edges", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store: CoreStore | null = h.open();
  t.after(() => store?.close());

  const target = makeBee(store, "audit-target").bee;
  const other = makeBee(store, "audit-other").bee;
  store.close();
  store = null;

  const fixture = new DatabaseSync(h.path);
  try {
    const insert = fixture.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, ?, ?)");
    const rows: Array<{ beeId: string | null; label: string }> = [
      { beeId: target.id, label: "target-a" },
      { beeId: null, label: "global-a" },
      { beeId: other.id, label: "other-a" },
      { beeId: target.id, label: "target-b" },
      { beeId: null, label: "global-b" },
      { beeId: target.id, label: "target-c" },
      { beeId: other.id, label: "other-b" },
      { beeId: target.id, label: "target-d" },
    ];
    for (const [index, row] of rows.entries()) {
      insert.run(2_000_000 + index, "audit.fixture", row.beeId, JSON.stringify({ label: row.label, index }));
    }
  } finally {
    fixture.close();
  }

  store = h.open();
  const authority = store.auditRows();
  const targetSeqs = authority.filter((row) => row.beeId === target.id).map((row) => row.seq);
  assert.ok(targetSeqs.length >= 6, "fixture includes dense and interleaved target history");
  const cursors = [0, targetSeqs[1] ?? 0, (targetSeqs.at(-1) ?? 0) - 1, targetSeqs.at(-1) ?? 0, store.lastAuditSeq() + 1];
  const filters: Array<string | null | undefined> = [target.id, "missing-audit-bee", undefined, null, ""];

  for (const afterSeq of cursors) {
    for (const limit of [1, 2, 1_000]) {
      for (const beeId of filters) {
        const expected = expectedTail(authority, afterSeq, limit, beeId);
        const actual = store.auditTail(afterSeq, limit, beeId);
        assert.deepEqual(actual, expected, `after=${afterSeq} limit=${limit} bee=${String(beeId)}`);
        assert.ok(actual.every((row, index) => index === 0 || (actual[index - 1]?.seq ?? row.seq) < row.seq));
      }
    }
  }
  assert.equal(store.lastAuditSeq(), authority.at(-1)?.seq, "tail reads do not append authority events");
});

test("per-bee audit tails remain fresh across outer rollback and audit sequence reuse", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const target = makeBee(store, "rollback-target").bee;
  const other = makeBee(store, "rollback-other").bee;
  const before = store.auditTail(0, 1_000, target.id);
  const committedSeq = store.lastAuditSeq();
  let rolledBackSeq = -1;
  const rollback = new Error("rollback audit tail");

  assert.throws(
    () => store.transact(() => {
      store.renameBee(target.id, "uncommitted-target-name");
      rolledBackSeq = store.lastAuditSeq();
      assert.deepEqual(
        store.auditTail(0, 1_000, target.id),
        expectedTail(store.auditRows(), 0, 1_000, target.id),
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );

  assert.equal(store.lastAuditSeq(), committedSeq);
  assert.deepEqual(store.auditTail(0, 1_000, target.id), before);
  store.renameBee(other.id, "reuses-rolled-back-sequence");
  assert.equal(store.lastAuditSeq(), rolledBackSeq);
  assert.deepEqual(store.auditTail(0, 1_000, target.id), before, "another bee at the reused seq stays excluded");

  store.renameBee(target.id, "committed-target-name");
  assert.deepEqual(
    store.auditTail(0, 1_000, target.id),
    expectedTail(store.auditRows(), 0, 1_000, target.id),
  );
});

test("per-bee audit tails do not parse an unselected malformed payload but retain selected-row failures", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store: CoreStore | null = h.open();
  t.after(() => store?.close());
  const target = makeBee(store, "payload-target").bee;
  const other = makeBee(store, "payload-other").bee;
  const before = store.auditTail(0, 1_000, target.id);
  store.close();
  store = null;

  const fixture = new DatabaseSync(h.path);
  let selectedSeq = -1;
  try {
    fixture.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, ?, ?)")
      .run(3_000_000, "audit.fixture.malformed", other.id, "{not-json");
    const selected = fixture.prepare("INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, ?, ?)")
      .run(3_000_001, "audit.fixture.selected", target.id, JSON.stringify({ selected: true }));
    selectedSeq = Number(selected.lastInsertRowid);
  } finally {
    fixture.close();
  }

  store = h.open();
  assert.deepEqual(store.auditTail(0, 1_000, target.id), [
    ...before,
    {
      seq: selectedSeq,
      ts: 3_000_001,
      kind: "audit.fixture.selected",
      beeId: target.id,
      payload: { selected: true },
    },
  ]);
  assert.throws(() => store?.auditTail(0, 1_000, other.id), SyntaxError);
});

test("audit_by_bee installs on populated reopen and naturally serves only the filtered tail", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store: CoreStore | null = h.open();
  t.after(() => store?.close());
  const target = makeBee(store, "index-target").bee;
  const other = makeBee(store, "index-other").bee;
  for (let index = 0; index < 20; index += 1) {
    store.renameBee(index % 4 === 0 ? target.id : other.id, `indexed-history-${index}`);
  }
  const stateBefore = store.dumpState();
  const auditBefore = store.auditRows();
  store.close();
  store = null;

  const beforeReopen = new DatabaseSync(h.path);
  let schemaVersionBefore: string;
  let baselinePlan: string[];
  try {
    schemaVersionBefore = sqliteString(
      beforeReopen.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
      "value",
    );
    beforeReopen.exec("DROP INDEX audit_by_bee");
    baselinePlan = planDetails(
      beforeReopen,
      "SELECT * FROM audit WHERE seq > ? AND bee_id = ? ORDER BY seq DESC LIMIT ?",
      0,
      target.id,
      100,
    );
    assert.doesNotMatch(baselinePlan.join("\n"), /audit_by_bee/);
  } finally {
    beforeReopen.close();
  }

  store = h.open();
  assert.deepEqual(store.dumpState(), stateBefore);
  assert.deepEqual(store.auditRows(), auditBefore, "index installation is not an authority event");
  assert.deepEqual(
    store.auditTail(0, 100, target.id),
    expectedTail(auditBefore, 0, 100, target.id),
  );
  store.close();
  store = null;

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    assert.deepEqual(indexColumns(check, "audit_by_bee"), ["bee_id"]);
    assert.match(
      sqliteString(
        check.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = 'audit_by_bee'").get(),
        "sql",
      ),
      /ON audit\(bee_id\) WHERE bee_id IS NOT NULL/,
    );
    assert.ok(
      check.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'audit_bee_deleted_bee_seq'").get(),
      "the specialized deletion index remains installed",
    );

    const filteredPlan = planDetails(
      check,
      "SELECT * FROM audit WHERE seq > ? AND bee_id = ? ORDER BY seq DESC LIMIT ?",
      0,
      target.id,
      100,
    ).join("\n");
    assert.match(filteredPlan, /USING INDEX audit_by_bee \(bee_id=\? AND rowid>\?\)/);
    assert.doesNotMatch(filteredPlan, /USE TEMP B-TREE/);

    const globalPlan = planDetails(
      check,
      "SELECT * FROM audit WHERE seq > ? ORDER BY seq DESC LIMIT ?",
      0,
      100,
    ).join("\n");
    assert.match(globalPlan, /USING INTEGER PRIMARY KEY \(rowid>\?\)/);
    assert.doesNotMatch(globalPlan, /audit_by_bee|USE TEMP B-TREE/);

    const schemaVersionAfter = sqliteString(
      check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(),
      "value",
    );
    assert.equal(schemaVersionAfter, schemaVersionBefore, "the additive index does not change schema format");
  } finally {
    check.close();
  }

  store = h.open();
  assert.deepEqual(store.auditRows(), auditBefore, "idempotent second installation remains silent");
});

test("deleted-bee history uses the specialized deletion index and preserves snapshot semantics", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const bee = makeBee(store, "deleted-history").bee;
  const sent = store.send(bee.id, "queued before deletion").message;
  for (let index = 0; index < 30; index += 1) store.renameBee(bee.id, `deleted-history-${index}`);
  const beforeDeletionSeq = store.lastAuditSeq();
  store.deleteBee(bee.id);
  const deletion = store.auditTail(0, 1_000, bee.id).find((row) => row.kind === "bee.deleted");
  assert.ok(deletion);

  const captured = capturePreparedSql(() => store.mailHistory({ snapshotSeq: beforeDeletionSeq, limit: 10 }));
  const historical = captured.value.messages.find((message) => message.messageId === sent.id);
  assert.equal(historical?.lifecycle.state, "queued");
  const deletionSql = captured.sql.find((sql) => sql.includes("kind = 'bee.deleted'"));
  assert.ok(deletionSql, "mailHistory prepared the production deletion lookup");
  assert.match(deletionSql, /FROM audit INDEXED BY audit_bee_deleted_bee_seq/);

  const current = store.mailHistory({ snapshotSeq: store.lastAuditSeq(), limit: 10 });
  assert.deepEqual(current.messages.find((message) => message.messageId === sent.id)?.lifecycle, {
    state: "canceled",
    reason: "bee_deleted",
    canceledAt: deletion.ts,
  });
  assert.equal(store.getBee(bee.id), null);
  assert.ok(store.auditTail(0, 1_000, bee.id).some((row) => row.seq === deletion.seq));
  store.close();

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const plan = planDetails(check, deletionSql, bee.id, beforeDeletionSeq).join("\n");
    assert.match(plan, /USING INDEX audit_bee_deleted_bee_seq \(bee_id=\? AND seq<\?\)/);
    assert.doesNotMatch(plan, /audit_by_bee|USE TEMP B-TREE/);
  } finally {
    check.close();
  }
});
