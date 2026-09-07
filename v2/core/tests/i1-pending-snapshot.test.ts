import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness } from "./helpers.ts";
import type { CoreStore, I1RuntimeFact, RuntimeRow } from "../src/index.ts";

function createBee(store: CoreStore, id: string) {
  return store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
}

function i1Runtime(runtime: RuntimeRow | null): I1RuntimeFact {
  if (!runtime) throw new Error("expected current runtime");
  return {
    state: runtime.state,
    bootEvidence: runtime.bootEvidence,
    updatedAt: runtime.updatedAt,
  };
}

function planDetails(db: DatabaseSync, sql: string): string[] {
  return db.prepare("EXPLAIN QUERY PLAN " + sql).all().map((row) => {
    if (typeof row.detail !== "string") throw new Error("SQLite plan detail is not text");
    return row.detail;
  });
}

test("I1 pending snapshot preserves bee/FIFO order with current runtime and flag facts", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const z = createBee(store, "z-live");
  store.updateRuntimeState(z.bee.id, z.runtime.generation, "running", { synthetic: true });
  const a = createBee(store, "a-stopped");
  store.updateRuntimeState(a.bee.id, a.runtime.generation, "stopped", { exitCause: "clean" });

  const zFirst = store.send(z.bee.id, "z first", { sender: "peer-z", urgency: "idle" }).message;
  const aFirst = store.send(a.bee.id, "a first", { sender: "peer-a", urgency: "next" }).message;
  const delivered = store.send(z.bee.id, "already delivered", { urgency: "now" }).message;
  assert.deepEqual(store.markDelivered(delivered.id, z.runtime.generation), { applied: true });
  const zSecond = store.send(z.bee.id, "z second", { urgency: "now" }).message;
  const canceled = store.send(a.bee.id, "already canceled", { urgency: "idle" }).message;
  assert.deepEqual(store.cancelMessage(a.bee.id, canceled.id), { canceled: true });
  const aSecond = store.send(a.bee.id, "a second", { urgency: "idle" }).message;
  store.setFlag(a.bee.id, "resource_blocked", "declared boundary");
  store.archiveBee(z.bee.id);

  const aRuntime = store.currentRuntime(a.bee.id);
  const zRuntime = store.currentRuntime(z.bee.id);
  assert.equal(store.getBee(z.bee.id)?.lifecycle, "archived");
  assert.deepEqual(store.readI1PendingSnapshot(), [
    {
      beeId: a.bee.id,
      runtime: i1Runtime(aRuntime),
      hasActiveFlag: true,
      pending: [
        { id: aFirst.id, urgency: "next", enqueuedAt: aFirst.enqueuedAt },
        { id: aSecond.id, urgency: "idle", enqueuedAt: aSecond.enqueuedAt },
      ],
    },
    {
      beeId: z.bee.id,
      runtime: i1Runtime(zRuntime),
      hasActiveFlag: false,
      pending: [
        { id: zFirst.id, urgency: "idle", enqueuedAt: zFirst.enqueuedAt },
        { id: zSecond.id, urgency: "now", enqueuedAt: zSecond.enqueuedAt },
      ],
    },
  ]);

  const projected = store.readI1PendingSnapshot()[0]?.pending[0];
  assert.deepEqual(Object.keys(projected ?? {}).sort(), ["enqueuedAt", "id", "urgency"]);
  assert.equal(store.getMessage(aFirst.id)?.body, "a first", "the existing full read remains unchanged");
  assert.equal(store.getMessage(aFirst.id)?.sender, "peer-a");
});

test("I1 pending snapshot includes absent runtimes and ignores an old noncurrent live row", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const absent = createBee(store, "a-absent-runtime");
  store.updateRuntimeState(absent.bee.id, absent.runtime.generation, "stopped", { exitCause: "clean" });
  const absentMessage = store.send(absent.bee.id, "no runtime").message;

  const stale = createBee(store, "z-stale-live");
  store.updateRuntimeState(stale.bee.id, stale.runtime.generation, "stopped", { exitCause: "clean" });
  const current = store.reviveBee(stale.bee.id);
  store.updateRuntimeState(stale.bee.id, current.generation, "stopped", { exitCause: "clean" });
  const staleMessage = store.send(stale.bee.id, "current generation is stopped").message;
  store.archiveBee(stale.bee.id);
  store.close();

  const fixture = new DatabaseSync(h.path);
  try {
    fixture.prepare("DELETE FROM runtimes WHERE bee_id = ?").run(absent.bee.id);
    fixture.prepare(
      "UPDATE runtimes SET state = 'booting', exit_cause = NULL WHERE bee_id = ? AND generation = ?",
    ).run(stale.bee.id, stale.runtime.generation);
  } finally {
    fixture.close();
  }

  store = h.open();
  const staleCurrent = store.currentRuntime(stale.bee.id);
  assert.equal(staleCurrent?.generation, current.generation);
  assert.equal(staleCurrent?.state, "stopped");
  assert.deepEqual(store.readI1PendingSnapshot(), [
    {
      beeId: absent.bee.id,
      runtime: null,
      hasActiveFlag: false,
      pending: [{ id: absentMessage.id, urgency: "next", enqueuedAt: absentMessage.enqueuedAt }],
    },
    {
      beeId: stale.bee.id,
      runtime: i1Runtime(staleCurrent),
      hasActiveFlag: false,
      pending: [{ id: staleMessage.id, urgency: "next", enqueuedAt: staleMessage.enqueuedAt }],
    },
  ]);
});

test("I1 pending snapshot is fresh across outer rollback and audit-sequence reuse", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const target = createBee(store, "rollback-i1");
  const message = store.send(target.bee.id, "committed pending").message;
  const before = store.readI1PendingSnapshot();
  const committedSeq = store.lastAuditSeq();
  let rolledBackSeq = -1;

  assert.throws(
    () => store.transact(() => {
      store.setFlag(target.bee.id, "auth_needed", "uncommitted flag");
      rolledBackSeq = store.lastAuditSeq();
      assert.equal(store.readI1PendingSnapshot()[0]?.hasActiveFlag, true);
      throw new Error("rollback I1 projection");
    }),
    /rollback I1 projection/,
  );

  assert.equal(store.lastAuditSeq(), committedSeq);
  assert.deepEqual(store.readI1PendingSnapshot(), before);
  store.renameBee(target.bee.id, "sequence-reused");
  assert.equal(store.lastAuditSeq(), rolledBackSeq);
  assert.deepEqual(store.readI1PendingSnapshot(), before);
  assert.equal(store.getMessage(message.id)?.body, "committed pending");
});

test("I1 pending snapshot stays complete and index-backed for a large body-free queue", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const target = createBee(store, "bulk-i1");
  store.updateRuntimeState(target.bee.id, target.runtime.generation, "stopped", { exitCause: "clean" });
  store.close();

  const fixture = new DatabaseSync(h.path);
  try {
    const insertSql = [
      "WITH RECURSIVE n(value) AS (",
      "  VALUES(1)",
      "  UNION ALL",
      "  SELECT value + 1 FROM n WHERE value < 10000",
      ")",
      "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at)",
      "SELECT ?, 'bulk-sender', printf('large-body-marker-%d', value), 0,",
      "       CASE value % 3 WHEN 0 THEN 'now' WHEN 1 THEN 'next' ELSE 'idle' END,",
      "       20000 - value",
      "FROM n",
    ].join("\n");
    fixture.prepare(insertSql).run(target.bee.id);
  } finally {
    fixture.close();
  }

  store = h.open();
  const snapshot = store.readI1PendingSnapshot();
  assert.equal(snapshot.length, 1);
  const pending = snapshot[0]?.pending ?? [];
  assert.equal(pending.length, 10_000);
  assert.deepEqual(pending[0], { id: 1, urgency: "next", enqueuedAt: 19_999 });
  assert.deepEqual(pending[4_999], { id: 5_000, urgency: "idle", enqueuedAt: 15_000 });
  assert.deepEqual(pending[9_999], { id: 10_000, urgency: "next", enqueuedAt: 10_000 });
  assert.equal(JSON.stringify(snapshot).includes("large-body-marker"), false);
  assert.equal(JSON.stringify(snapshot).includes("bulk-sender"), false);
  store.close();

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const pendingSql = [
      "SELECT id, bee_id, urgency, enqueued_at",
      "FROM mailbox",
      "WHERE delivered_at IS NULL",
      "ORDER BY bee_id, id",
    ].join("\n");
    const pendingPlan = planDetails(check, pendingSql).join("\n");
    // Intended adoption: the covering pending-metadata index serves the
    // body-free projection without row fetches.
    assert.match(pendingPlan, /USING COVERING INDEX mailbox_pending_metadata/);
    assert.doesNotMatch(pendingPlan, /USE TEMP B-TREE/);

    const factsSql = [
      "WITH pending_bees AS (",
      "  SELECT DISTINCT bee_id FROM mailbox WHERE delivered_at IS NULL",
      ")",
      "SELECT target.bee_id, runtime.state, runtime.boot_evidence, runtime.updated_at,",
      "       EXISTS (",
      "         SELECT 1 FROM flags AS flag",
      "         WHERE flag.bee_id = target.bee_id AND flag.cleared_at IS NULL",
      "       ) AS has_active_flag",
      "FROM pending_bees AS target",
      "LEFT JOIN runtimes AS runtime",
      "  ON runtime.bee_id = target.bee_id",
      " AND runtime.generation = (",
      "   SELECT MAX(latest.generation) FROM runtimes AS latest",
      "   WHERE latest.bee_id = target.bee_id",
      " )",
      "ORDER BY target.bee_id",
    ].join("\n");
    const factsPlan = planDetails(check, factsSql).join("\n");
    // Intended adoption: the pending_bees CTE scans the covering metadata index.
    assert.match(factsPlan, /USING COVERING INDEX mailbox_pending_metadata/);
    assert.match(factsPlan, /sqlite_autoindex_runtimes_1/);
    assert.match(factsPlan, /USING (?:COVERING )?INDEX flags_active/);
    assert.doesNotMatch(factsPlan, /SCAN (?:runtime|flag)\b/);
  } finally {
    check.close();
  }
});
