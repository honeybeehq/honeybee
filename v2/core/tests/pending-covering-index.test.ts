import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { CoreStore, I1PendingBee } from "../src/index.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import { harness, makeBee } from "./helpers.ts";

// Verbatim production texts (asserted against store.ts so pins cannot drift).
const I1_MESSAGES_SQL = `SELECT id, bee_id, urgency, enqueued_at
       FROM mailbox
       WHERE delivered_at IS NULL
       ORDER BY bee_id, id`;
const WORK_MESSAGES_SQL = `SELECT message.id,
              message.bee_id,
              message.urgency,
              message.enqueued_at
       FROM runtimes AS runtime
       CROSS JOIN mailbox AS message
       WHERE runtime.state != 'stopped'
         AND runtime.generation = (
           SELECT MAX(latest.generation)
           FROM runtimes AS latest
           WHERE latest.bee_id = runtime.bee_id
         )
         AND message.bee_id = runtime.bee_id
         AND message.delivered_at IS NULL
       ORDER BY runtime.bee_id, message.id`;
const PENDING_BEES_CTE_SQL = `SELECT DISTINCT bee_id
         FROM mailbox
         WHERE delivered_at IS NULL`;

interface PendingMeta {
  id: number;
  urgency: string;
  enqueuedAt: number;
}

function i1Shape(store: CoreStore): Array<{
  beeId: string;
  runtimeState: string | null;
  bootEvidence: string | null;
  hasActiveFlag: boolean;
  pending: PendingMeta[];
}> {
  return store.readI1PendingSnapshot().map((group: I1PendingBee) => ({
    beeId: group.beeId,
    runtimeState: group.runtime?.state ?? null,
    bootEvidence: group.runtime?.bootEvidence ?? null,
    hasActiveFlag: group.hasActiveFlag,
    pending: group.pending.map((m) => ({ id: m.id, urgency: m.urgency, enqueuedAt: m.enqueuedAt })),
  }));
}

function workShape(store: CoreStore): Map<string, PendingMeta[]> {
  return new Map(store.readDaemonWork().map((row) => [
    row.runtime.beeId,
    row.pending.map((m) => ({ id: m.id, urgency: m.urgency, enqueuedAt: m.enqueuedAt })),
  ]));
}

test("pending projections keep exact order, grouping, identity, and membership through every public transition", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store: CoreStore | null = h.open();
  t.after(() => store?.close());

  const live = makeBee(store, "live").bee;
  store.updateRuntimeState(live.id, 1, "running", { pid: 101, pidStartedAt: 10 });
  const parked = makeBee(store, "parked").bee;
  store.updateRuntimeState(parked.id, 1, "stopped", { exitCause: "clean" });
  const flagged = makeBee(store, "flagged").bee;
  store.updateRuntimeState(flagged.id, 1, "stopped", { exitCause: "clean" });
  store.setFlag(flagged.id, "auth_needed", "fixture flag");
  const historic = makeBee(store, "historic").bee;
  store.updateRuntimeState(historic.id, 1, "running", { pid: 102, pidStartedAt: 10 });

  // Interleaved sends across bees: per-bee FIFO must equal send order while
  // the global mailbox-id order interleaves. Delivered history via public
  // markDelivered keeps `historic` live with ZERO pending.
  const sent = new Map<string, PendingMeta[]>([[live.id, []], [parked.id, []], [flagged.id, []]]);
  const record = (beeId: string, body: string, urgency?: "now" | "next" | "idle") => {
    const message = store!.send(beeId, body, urgency ? { urgency } : {}).message;
    sent.get(beeId)!.push({ id: message.id, urgency: message.urgency, enqueuedAt: message.enqueuedAt });
    return message.id;
  };
  record(live.id, "a1");
  record(parked.id, "b1");
  const liveNow = record(live.id, "a2", "now");
  const flaggedFirst = record(flagged.id, "c1", "idle");
  const parkedSecond = record(parked.id, "b2", "next");
  record(live.id, "a3", "idle");
  const deliveredOne = store.send(historic.id, "d1").message;
  store.send(historic.id, "d2");
  for (const m of store.undeliveredMessages(historic.id)) {
    assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
  }

  const expectI1 = () => [...sent.entries()]
    .filter(([, pending]) => pending.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([beeId, pending]) => ({
      beeId,
      runtimeState: store!.currentRuntime(beeId)?.state ?? null,
      bootEvidence: store!.currentRuntime(beeId)?.bootEvidence ?? null,
      hasActiveFlag: store!.activeFlags(beeId).length > 0,
      pending,
    }));
  const verify = (label: string) => {
    assert.deepEqual(i1Shape(store!), expectI1(), `${label}: I1 grouping/order/identity`);
    const work = workShape(store!);
    assert.deepEqual([...work.keys()].sort(), [live.id, historic.id].sort(), `${label}: work covers exactly the live runtimes`);
    assert.deepEqual(work.get(live.id), sent.get(live.id), `${label}: live pending metadata`);
    assert.deepEqual(work.get(historic.id), [], `${label}: delivered history contributes no pending`);
  };
  verify("baseline");
  assert.equal(deliveredOne.id > 0, true);

  // delivered: the live bee's now-message leaves both projections.
  assert.deepEqual(store.markDelivered(liveNow, 1), { applied: true });
  sent.set(live.id, sent.get(live.id)!.filter((m) => m.id !== liveNow));
  verify("after delivery");

  // cancel: a parked bee's message leaves while its sibling stays.
  assert.deepEqual(store.cancelMessage(parked.id, parkedSecond), { canceled: true });
  sent.set(parked.id, sent.get(parked.id)!.filter((m) => m.id !== parkedSecond));
  verify("after cancel");

  // expedite: membership and position retained, urgency identity updated.
  assert.deepEqual(store.expediteMessage(flagged.id, flaggedFirst, "now"), { applied: true });
  sent.get(flagged.id)!.find((m) => m.id === flaggedFirst)!.urgency = "now";
  verify("after expedite");

  // rollback: an uncommitted send + cancel must leave projections untouched.
  assert.throws(
    () => store!.transact(() => {
      store!.send(live.id, "uncommitted");
      store!.cancelMessage(flagged.id, flaggedFirst);
      throw new Error("outer rollback");
    }),
    /outer rollback/,
  );
  verify("after rollback");

  // delete: the whole parked group disappears.
  store.deleteBee(parked.id);
  sent.delete(parked.id);
  verify("after delete");

  // reopen with delivered history present: drop the index offline, reopen —
  // the post-migration install recreates it and projections are identical.
  const before = { i1: i1Shape(store), work: [...workShape(store).entries()] };
  store.close();
  store = null;
  const fixture = new DatabaseSync(h.path);
  try {
    fixture.exec("DROP INDEX IF EXISTS mailbox_pending_metadata");
  } finally {
    fixture.close();
  }
  store = h.open();
  assert.deepEqual({ i1: i1Shape(store), work: [...workShape(store).entries()] }, before, "reopen preserves projections exactly");
});

test("pending-metadata index is covering for the actual projection SQL and stays body/JSON-free", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const storeSource = readFileSync(fileURLToPath(new URL("../src/store.ts", import.meta.url)), "utf8");
  for (const sql of [I1_MESSAGES_SQL, WORK_MESSAGES_SQL, PENDING_BEES_CTE_SQL]) {
    assert.ok(storeSource.includes(sql), "literal statement drifted from store.ts");
    assert.doesNotMatch(sql, /INDEXED BY/, "production SQL must not need hints");
  }
  const { bee } = makeBee(store, "planner");
  store.updateRuntimeState(bee.id, 1, "running", { pid: 7, pidStartedAt: 1 });
  const first = store.send(bee.id, "pending body").message;
  store.send(bee.id, "delivered body");
  for (const m of store.undeliveredMessages(bee.id)) {
    if (m.id !== first.id) assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
  }
  store.close(); // EXCLUSIVE locking: release before the read-only inspection

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const columns = check.prepare("SELECT name FROM pragma_index_info('mailbox_pending_metadata') ORDER BY seqno")
      .all().map((row) => (row as { name?: unknown }).name);
    assert.deepEqual(columns, ["bee_id", "id", "urgency", "enqueued_at", "delivered_at"],
      "delivered_at must sit in the key — the covering plan requires it");
    const indexSql = check.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_pending_metadata'",
    ).get() as { sql?: unknown };
    assert.ok(typeof indexSql.sql === "string");
    assert.match(indexSql.sql, /WHERE delivered_at IS NULL/);
    assert.doesNotMatch(indexSql.sql, /body|json/i, "no body column and no JSON expression in the index");

    const plan = (sql: string) => check.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
      .map((row) => String((row as { detail?: unknown }).detail)).join("\n");
    for (const [name, sql, access] of [
      ["i1-messages", I1_MESSAGES_SQL, /mailbox USING COVERING INDEX mailbox_pending_metadata/],
      // The work query aliases mailbox as `message`; its outer runtimes scan
      // may sort the LAST ORDER BY term (per-bee id micro-sort) — only a
      // full-ORDER-BY temp b-tree would betray a non-index order source.
      ["work-messages", WORK_MESSAGES_SQL, /message USING COVERING INDEX mailbox_pending_metadata/],
      ["pending-bees-cte", PENDING_BEES_CTE_SQL, /mailbox USING COVERING INDEX mailbox_pending_metadata/],
    ] as const) {
      const details = plan(sql);
      assert.match(details, access, `${name} must be covering:\n${details}`);
      assert.doesNotMatch(details, /USE TEMP B-TREE FOR ORDER BY$/m, `${name} order must come from the index:\n${details}`);
    }
  } finally {
    check.close();
  }
});

test("a pre-v8 store migrates urgency before the pending index installs and old mail projects unchanged", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  // Real pre-v8 fixture (accounts.test.ts v6→v7 pattern): stamp 7, old-shape
  // tables, and a mailbox WITHOUT the urgency column — plus live pending,
  // parked pending, and delivered-history rows written by the "old" build.
  const fixture = new DatabaseSync(h.path);
  fixture.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    INSERT INTO meta(key, value) VALUES('schema_version', '7');
    CREATE TABLE bees (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
      title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
      created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
      provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
      spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT, fork_seed TEXT
    ) STRICT;
    INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at)
      VALUES('old-live','old-live','claude','hsr','/tmp','active',5),
            ('old-parked','old-parked','claude','hsr','/tmp','active',5);
    CREATE TABLE runtimes (
      bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
      state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
      exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (bee_id, generation)
    ) STRICT;
    INSERT INTO runtimes(bee_id, generation, state, exit_cause, pid, pid_started_at, started_at, updated_at)
      VALUES('old-live', 1, 'running', NULL, 42, 5, 5, 6),
            ('old-parked', 1, 'stopped', 'clean', NULL, NULL, 5, 6);
    CREATE TABLE mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
      sender TEXT NOT NULL, body TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      enqueued_at INTEGER NOT NULL, delivered_at INTEGER, delivered_generation INTEGER
    ) STRICT;
    INSERT INTO mailbox(bee_id, sender, body, enqueued_at, delivered_at, delivered_generation)
      VALUES('old-live', 'operator', 'pending live', 8, NULL, NULL),
            ('old-parked', 'operator', 'pending parked', 9, NULL, NULL),
            ('old-live', 'operator', 'delivered history', 7, 10, 1);
  `);
  fixture.close();

  // Opening must not throw: the urgency ALTER runs BEFORE the index exec —
  // an index referencing a missing column would fail this open loudly.
  const store = h.open();
  assert.deepEqual(i1Shape(store), [
    { beeId: "old-live", runtimeState: "running", bootEvidence: null, hasActiveFlag: false,
      pending: [{ id: 1, urgency: "next", enqueuedAt: 8 }] },
    { beeId: "old-parked", runtimeState: "stopped", bootEvidence: null, hasActiveFlag: false,
      pending: [{ id: 2, urgency: "next", enqueuedAt: 9 }] },
  ], "old mail projects with the migrated default urgency and exact identity");
  assert.deepEqual([...workShape(store).entries()], [
    ["old-live", [{ id: 1, urgency: "next", enqueuedAt: 8 }]],
  ], "only the live pre-v8 runtime carries pending work; delivered history is excluded");
  store.close();

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const mailboxColumns = check.prepare("SELECT name FROM pragma_table_info('mailbox')").all()
      .map((row) => (row as { name?: unknown }).name);
    assert.ok(mailboxColumns.includes("urgency"), "urgency column migrated");
    const indexColumns = check.prepare("SELECT name FROM pragma_index_info('mailbox_pending_metadata') ORDER BY seqno")
      .all().map((row) => (row as { name?: unknown }).name);
    assert.deepEqual(indexColumns, ["bee_id", "id", "urgency", "enqueued_at", "delivered_at"],
      "pending-metadata index installed after the migration");
    const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown };
    assert.equal(Number(version.value), SCHEMA_VERSION, "stamp bumped to the current format");
  } finally {
    check.close();
  }
});
