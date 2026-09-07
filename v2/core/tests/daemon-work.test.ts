import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { harness } from "./helpers.ts";
import type { CoreStore, DaemonLiveRuntime, RuntimeRow } from "../src/index.ts";

function createBee(store: CoreStore, id: string) {
  return store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
}

function liveRuntime(runtime: RuntimeRow | null): DaemonLiveRuntime {
  if (!runtime || runtime.state === "stopped") throw new Error("expected current live runtime");
  return {
    beeId: runtime.beeId,
    generation: runtime.generation,
    state: runtime.state,
    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    bootEvidence: runtime.bootEvidence,
  };
}

function planDetails(db: DatabaseSync, sql: string): string[] {
  return db.prepare("EXPLAIN QUERY PLAN " + sql).all().map((row) => {
    if (typeof row.detail !== "string") throw new Error("SQLite plan detail is not text");
    return row.detail;
  });
}

test("daemon work projects only current live consumer fields and body-free pending queues", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const z = createBee(store, "z-running-archived");
  store.updateRuntimeState(z.bee.id, z.runtime.generation, "running", {
    pid: 101,
    pidStartedAt: 100,
  });
  const zFirst = store.send(z.bee.id, "z-body-marker-first", {
    sender: "peer-z",
    urgency: "idle",
  }).message;
  const delivered = store.send(z.bee.id, "z-body-marker-delivered", { urgency: "now" }).message;
  assert.deepEqual(store.markDelivered(delivered.id, z.runtime.generation), { applied: true });
  const zSecond = store.send(z.bee.id, "z-body-marker-second", { urgency: "now" }).message;
  store.archiveBee(z.bee.id);

  const a = createBee(store, "a-idle");
  store.updateRuntimeState(a.bee.id, a.runtime.generation, "running", { synthetic: true });
  store.updateRuntimeState(a.bee.id, a.runtime.generation, "idle");
  const aMessage = store.send(a.bee.id, "a-body-marker", { urgency: "next" }).message;

  const b = createBee(store, "b-booting");

  const stopped = createBee(store, "c-stopped");
  store.updateRuntimeState(stopped.bee.id, stopped.runtime.generation, "stopped", { exitCause: "clean" });
  store.send(stopped.bee.id, "stopped-body-marker");

  assert.deepEqual(store.readDaemonWork(), [
    {
      runtime: liveRuntime(store.currentRuntime(a.bee.id)),
      pending: [{ id: aMessage.id, urgency: "next", enqueuedAt: aMessage.enqueuedAt }],
    },
    {
      runtime: liveRuntime(store.currentRuntime(b.bee.id)),
      pending: [],
    },
    {
      runtime: liveRuntime(store.currentRuntime(z.bee.id)),
      pending: [
        { id: zFirst.id, urgency: "idle", enqueuedAt: zFirst.enqueuedAt },
        { id: zSecond.id, urgency: "now", enqueuedAt: zSecond.enqueuedAt },
      ],
    },
  ]);

  const projected = store.readDaemonWork()[2];
  assert.deepEqual(Object.keys(projected?.runtime ?? {}).sort(), [
    "beeId",
    "bootEvidence",
    "generation",
    "startedAt",
    "state",
    "updatedAt",
  ]);
  assert.deepEqual(Object.keys(projected?.pending[0] ?? {}).sort(), ["enqueuedAt", "id", "urgency"]);
  assert.equal(JSON.stringify(projected).includes("body-marker"), false);
  assert.equal(JSON.stringify(projected).includes("peer-z"), false);
  assert.equal(store.getMessage(zFirst.id)?.body, "z-body-marker-first");
  assert.equal(store.getMessage(zFirst.id)?.sender, "peer-z", "the existing full read remains unchanged");
});

test("daemon work ignores an old live generation when the current generation is stopped", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const stale = createBee(store, "archived-stale-live");
  store.updateRuntimeState(stale.bee.id, stale.runtime.generation, "stopped", { exitCause: "clean" });
  const current = store.reviveBee(stale.bee.id);
  store.updateRuntimeState(stale.bee.id, current.generation, "stopped", { exitCause: "clean" });
  store.send(stale.bee.id, "pending on stopped current generation");
  store.archiveBee(stale.bee.id);
  store.close();

  const fixture = new DatabaseSync(h.path);
  try {
    fixture.prepare(
      "UPDATE runtimes SET state = 'idle', exit_cause = NULL WHERE bee_id = ? AND generation = ?",
    ).run(stale.bee.id, stale.runtime.generation);
  } finally {
    fixture.close();
  }

  store = h.open();
  assert.equal(store.currentRuntime(stale.bee.id)?.generation, current.generation);
  assert.equal(store.currentRuntime(stale.bee.id)?.state, "stopped");
  assert.deepEqual(store.readDaemonWork(), []);
});

test("daemon work is fresh across outer rollback and audit-sequence reuse", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const target = createBee(store, "rollback-daemon-work");
  const before = store.readDaemonWork();
  const committedSeq = store.lastAuditSeq();
  let rolledBackSeq = -1;

  assert.equal(before[0]?.runtime.state, "booting");
  assert.throws(
    () => store.transact(() => {
      store.updateRuntimeState(target.bee.id, target.runtime.generation, "running", { synthetic: true });
      rolledBackSeq = store.lastAuditSeq();
      assert.equal(store.readDaemonWork()[0]?.runtime.state, "running");
      throw new Error("rollback daemon work projection");
    }),
    /rollback daemon work projection/,
  );

  assert.equal(store.lastAuditSeq(), committedSeq);
  assert.deepEqual(store.readDaemonWork(), before);
  store.renameBee(target.bee.id, "sequence-reused");
  assert.equal(store.lastAuditSeq(), rolledBackSeq);
  assert.deepEqual(store.readDaemonWork(), before);
});

test("daemon work naturally uses sparse runtime and live-driven mailbox indexes", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const live = createBee(store, "one-live");
  store.updateRuntimeState(live.bee.id, live.runtime.generation, "running", { synthetic: true });
  const stopped = createBee(store, "many-stopped-messages");
  store.updateRuntimeState(stopped.bee.id, stopped.runtime.generation, "stopped", { exitCause: "clean" });
  store.close();

  const fixture = new DatabaseSync(h.path);
  try {
    const insert = [
      "WITH RECURSIVE n(value) AS (",
      "  VALUES(1)",
      "  UNION ALL",
      "  SELECT value + 1 FROM n WHERE value < 10000",
      ")",
      "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at)",
      "SELECT ?, 'bulk-sender', printf('unselected-body-marker-%d', value), 0, 'next', value",
      "FROM n",
    ].join("\n");
    fixture.prepare(insert).run(stopped.bee.id);
    fixture.prepare(
      "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at) VALUES (?, ?, ?, 0, ?, ?)",
    ).run(live.bee.id, "live-sender", "selected-body-marker", "next", 20_000);
  } finally {
    fixture.close();
  }

  store = h.open();
  const work = store.readDaemonWork();
  assert.equal(work.length, 1);
  assert.equal(work[0]?.runtime.beeId, live.bee.id);
  assert.equal(work[0]?.pending.length, 1);
  assert.equal(JSON.stringify(work).includes("body-marker"), false);
  store.close();

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const runtimeSql = [
      "SELECT runtime.bee_id, runtime.generation, runtime.state, runtime.started_at,",
      "       runtime.updated_at, runtime.boot_evidence",
      "FROM runtimes AS runtime",
      "WHERE runtime.state != 'stopped'",
      "  AND runtime.generation = (",
      "    SELECT MAX(latest.generation) FROM runtimes AS latest",
      "    WHERE latest.bee_id = runtime.bee_id",
      "  )",
      "ORDER BY runtime.bee_id",
    ].join("\n");
    const runtimePlan = planDetails(check, runtimeSql).join("\n");
    assert.match(runtimePlan, /SCAN runtime USING INDEX runtimes_daemon_live/);
    assert.match(runtimePlan, /sqlite_autoindex_runtimes_1/);
    assert.doesNotMatch(runtimePlan, /SCAN bees\b/);

    const mailboxSql = [
      "SELECT message.id, message.bee_id, message.urgency, message.enqueued_at",
      "FROM runtimes AS runtime",
      "CROSS JOIN mailbox AS message",
      "WHERE runtime.state != 'stopped'",
      "  AND runtime.generation = (",
      "    SELECT MAX(latest.generation) FROM runtimes AS latest",
      "    WHERE latest.bee_id = runtime.bee_id",
      "  )",
      "  AND message.bee_id = runtime.bee_id",
      "  AND message.delivered_at IS NULL",
      "ORDER BY runtime.bee_id, message.id",
    ].join("\n");
    const mailboxPlan = planDetails(check, mailboxSql).join("\n");
    assert.match(mailboxPlan, /SCAN runtime USING INDEX runtimes_daemon_live/);
    assert.match(mailboxPlan, /SEARCH message USING INDEX mailbox_undelivered \(bee_id=\?\)/);
    assert.doesNotMatch(mailboxPlan, /SCAN message\b/);
  } finally {
    check.close();
  }
});
