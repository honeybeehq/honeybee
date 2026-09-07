import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";
import { SCHEMA_VERSION } from "../src/schema.ts";
import type { CoreStore, MessageRow } from "../src/index.ts";

// The candidate statement, verbatim (normalized-contains asserted against
// store.ts below): one compound read over two disjoint, exhaustive
// partitions, merged in id order by each partial index's implicit rowid.
const UNION_SQL = `SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL
         UNION ALL
         SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL
         ORDER BY id`;

// The pre-candidate single-scan read: the identity oracle for raw-vs-raw
// row comparison (NOT production SQL anymore; used only as the oracle).
const LEGACY_SQL = "SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id";

// Every production mailbox statement (13) for the no-theft matrix. All but
// the dump-state read are asserted verbatim-in-source; the delivered-only
// index must appear in NO plan except the union's delivered arm.
const MATRIX: Array<{ name: string; sql: string; pin: RegExp }> = [
  {
    name: "listMessages (union)",
    sql: UNION_SQL,
    pin: /MERGE \(UNION ALL\)/,
  },
  {
    name: "undeliveredMessages",
    sql: "SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id",
    pin: /SEARCH mailbox USING INDEX mailbox_pending_metadata \(bee_id=\?\)/,
  },
  {
    name: "per-bee pending probe",
    sql: "SELECT 1 FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL LIMIT 1",
    pin: /SEARCH mailbox USING COVERING INDEX mailbox_pending_metadata \(bee_id=\?\)/,
  },
  {
    name: "listUndeliveredMessages",
    sql: "SELECT * FROM mailbox WHERE delivered_at IS NULL ORDER BY bee_id, id",
    pin: /SCAN mailbox USING INDEX mailbox_pending_metadata/,
  },
  {
    name: "pendingMail join",
    sql: `SELECT h.*
       FROM mailbox m
       JOIN mail_history_enqueues h ON h.message_id = m.id
       WHERE m.bee_id = ? AND m.delivered_at IS NULL
       ORDER BY m.id
       LIMIT ?`,
    pin: /SEARCH m USING COVERING INDEX mailbox_pending_metadata \(bee_id=\?\)/,
  },
  {
    name: "getMessage",
    sql: "SELECT * FROM mailbox WHERE id = ?",
    pin: /SEARCH mailbox USING INTEGER PRIMARY KEY \(rowid=\?\)/,
  },
  {
    name: "work messages",
    sql: `SELECT message.id,
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
       ORDER BY runtime.bee_id, message.id`,
    pin: /SEARCH message USING COVERING INDEX mailbox_pending_metadata \(bee_id=\?\)/,
  },
  {
    name: "i1 facts",
    sql: `WITH pending_bees AS (
         SELECT DISTINCT bee_id
         FROM mailbox
         WHERE delivered_at IS NULL
       )
       SELECT target.bee_id,
              runtime.state AS runtime_state,
              runtime.boot_evidence AS runtime_boot_evidence,
              runtime.updated_at AS runtime_updated_at,
              EXISTS (
                SELECT 1
                FROM flags AS flag
                WHERE flag.bee_id = target.bee_id
                  AND flag.cleared_at IS NULL
              ) AS has_active_flag
       FROM pending_bees AS target
       LEFT JOIN runtimes AS runtime
         ON runtime.bee_id = target.bee_id
        AND runtime.generation = (
          SELECT MAX(latest.generation)
          FROM runtimes AS latest
          WHERE latest.bee_id = target.bee_id
        )
       ORDER BY target.bee_id`,
    pin: /COVERING INDEX mailbox_pending_metadata/,
  },
  {
    name: "i1 messages",
    sql: `SELECT id, bee_id, urgency, enqueued_at
       FROM mailbox
       WHERE delivered_at IS NULL
       ORDER BY bee_id, id`,
    pin: /SCAN mailbox USING COVERING INDEX mailbox_pending_metadata/,
  },
  {
    name: "global pending probe",
    sql: "SELECT 1 FROM mailbox WHERE delivered_at IS NULL LIMIT 1",
    pin: /SCAN mailbox USING COVERING INDEX mailbox_pending_metadata/,
  },
  {
    name: "ids among",
    sql: "SELECT id FROM mailbox WHERE delivered_at IS NULL AND id IN (SELECT value FROM json_each(?))",
    pin: /SEARCH mailbox USING INTEGER PRIMARY KEY \(rowid=\?\)/,
  },
  {
    name: "dump state (all rows)",
    sql: "SELECT * FROM mailbox ORDER BY id",
    pin: /SCAN mailbox\b/,
  },
  {
    // Not COVERING: a partial index's WHERE clause does not satisfy the
    // query's delivered_at column reference (the pending-metadata lesson),
    // so the row is fetched — but only delivered entries are ever visited.
    name: "delivered-arm content read (test-pinned)",
    sql: "SELECT id FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL ORDER BY id",
    pin: /SEARCH mailbox USING INDEX mailbox_delivered_by_bee \(bee_id=\?\)/,
  },
];

function planOf(db: DatabaseSync, sql: string): string {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
    .map((row) => {
      if (row === null || typeof row !== "object" || !("detail" in row) || typeof row.detail !== "string") {
        throw new Error("SQLite detail field is not text");
      }
      return row.detail;
    })
    .join("\n");
}

/** Public-API identity oracle: every known id's PK read, ascending. */
function oracleRows(store: CoreStore, ids: number[]): MessageRow[] {
  return [...ids].sort((a, b) => a - b).flatMap((id) => {
    const row = store.getMessage(id);
    return row ? [row] : [];
  });
}

test("listMessages union returns identical rows across mailbox states and never mixes bees", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  // Interleaved sends across two bees; alternating deliveries on one.
  const alpha = makeBee(store, "alpha").bee;
  const beta = makeBee(store, "beta").bee;
  const ids = new Map<string, number[]>([[alpha.id, []], [beta.id, []]]);
  for (let i = 0; i < 10; i++) {
    const a = store.send(alpha.id, `alpha ${i}`, { urgency: i % 3 === 0 ? "now" : "next" }).message;
    ids.get(alpha.id)!.push(a.id);
    if (i % 2 === 0) assert.deepEqual(store.markDelivered(a.id, 1), { applied: true });
    const b = store.send(beta.id, `beta ${i}`).message;
    ids.get(beta.id)!.push(b.id);
    if (i % 3 === 0) assert.deepEqual(store.markDelivered(b.id, 1), { applied: true });
  }
  // The binding trap: one all-pending bee and one all-delivered bee of the
  // same size. If the two placeholders ever bound different bees, this pair
  // would cross-contaminate arms and the oracle below would catch it.
  const pendingOnly = makeBee(store, "pending-only").bee;
  const deliveredOnly = makeBee(store, "delivered-only").bee;
  ids.set(pendingOnly.id, []);
  ids.set(deliveredOnly.id, []);
  for (let i = 0; i < 4; i++) {
    ids.get(pendingOnly.id)!.push(store.send(pendingOnly.id, `pending ${i}`).message.id);
    const d = store.send(deliveredOnly.id, `delivered ${i}`).message;
    assert.deepEqual(store.markDelivered(d.id, 1), { applied: true });
    ids.get(deliveredOnly.id)!.push(d.id);
  }
  const single = makeBee(store, "single").bee;
  ids.set(single.id, [store.send(single.id, "only message").message.id]);
  const empty = makeBee(store, "empty").bee;
  ids.set(empty.id, []);

  for (const [beeId, beeIds] of ids) {
    const rows = store.listMessages(beeId);
    assert.deepEqual(rows, oracleRows(store, beeIds), `full-row identity for ${beeId}`);
    assert.ok(rows.every((m) => m.beeId === beeId), "no foreign rows");
    assert.deepEqual(rows.map((m) => m.id), [...beeIds].sort((a, b) => a - b), "ascending id order");
  }
  assert.equal(store.listMessages(pendingOnly.id).length, 4);
  assert.equal(store.listMessages(deliveredOnly.id).length, 4);
  assert.deepEqual(store.listMessages(empty.id), []);

  // Cancel-before-delivery: the row leaves BOTH arms (it is deleted), and the
  // delivered arm never saw it while it was pending.
  const doomed = store.send(pendingOnly.id, "canceled before delivery").message;
  assert.ok(store.listMessages(pendingOnly.id).some((m) => m.id === doomed.id));
  assert.deepEqual(store.cancelMessage(pendingOnly.id, doomed.id), { canceled: true });
  assert.ok(!store.listMessages(pendingOnly.id).some((m) => m.id === doomed.id));
});

test("listMessages union survives outer rollback of deliver and cancel with exact rows", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const { bee } = makeBee(store, "rollback-probe");
  const first = store.send(bee.id, "first").message;
  const second = store.send(bee.id, "second").message;
  const third = store.send(bee.id, "third").message;
  assert.deepEqual(store.markDelivered(first.id, 1), { applied: true });
  const before = store.listMessages(bee.id);
  assert.deepEqual(before.map((m) => [m.id, m.deliveredAt !== null]), [
    [first.id, true],
    [second.id, false],
    [third.id, false],
  ]);

  const boom = new Error("forced rollback");
  assert.throws(
    () =>
      store.transact(() => {
        assert.deepEqual(store.markDelivered(second.id, 1), { applied: true });
        assert.deepEqual(store.cancelMessage(bee.id, third.id), { canceled: true });
        const inside = store.listMessages(bee.id);
        // Inside the open transaction the compound read sees its own
        // uncommitted writes: second moved arms, third gone entirely.
        assert.deepEqual(inside.map((m) => [m.id, m.deliveredAt !== null]), [
          [first.id, true],
          [second.id, true],
        ]);
        throw boom;
      }),
    boom,
  );
  assert.deepEqual(store.listMessages(bee.id), before, "rollback restores the exact pre-transaction rows");

  // And a delivered row keeps its id position when it moves arms for real.
  assert.deepEqual(store.markDelivered(second.id, 1), { applied: true });
  const after = store.listMessages(bee.id);
  assert.deepEqual(after.map((m) => m.id), [first.id, second.id, third.id]);
  assert.equal(after[1]!.deliveredAt !== null, true);
});

test("listMessages union holds on same-bee heavy delivered history with a tiny pending tail", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());

  const { bee } = makeBee(store, "heavy-history");
  const all: number[] = [];
  for (let i = 0; i < 1_000; i++) {
    const m = store.send(bee.id, `history ${i}`).message;
    all.push(m.id);
    assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
  }
  for (let i = 0; i < 3; i++) all.push(store.send(bee.id, `pending tail ${i}`).message.id);

  const rows = store.listMessages(bee.id);
  assert.equal(rows.length, 1_003);
  assert.deepEqual(rows.map((m) => m.id), all, "send order is id order across both arms");
  assert.equal(rows.filter((m) => m.deliveredAt === null).length, 3);
  assert.deepEqual(store.undeliveredMessages(bee.id).map((m) => m.id), all.slice(1_000),
    "the pending read stays on its own arm and sees only the tail");
});

test("the union statement is production SQL, merges without a sort, and steals no plans", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee } = makeBee(store, "plan-probe");
  const delivered = store.send(bee.id, "delivered").message;
  assert.deepEqual(store.markDelivered(delivered.id, 1), { applied: true });
  store.send(bee.id, "pending");
  store.close();

  const source = readFileSync(new URL("../src/store.ts", import.meta.url), "utf8");
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const normalizedSource = norm(source);
  assert.ok(normalizedSource.includes(norm(UNION_SQL)), "store.ts carries the union statement verbatim");
  for (const { name, sql } of MATRIX) {
    if (name === "delivered-arm content read (test-pinned)" || name === "listMessages (union)") continue;
    assert.ok(normalizedSource.includes(norm(sql)), `store.ts carries ${name} verbatim`);
  }

  const check = new DatabaseSync(h.path, { readOnly: true });
  try {
    const unionPlan = planOf(check, UNION_SQL);
    assert.match(unionPlan, /MERGE \(UNION ALL\)/, "compound read is a merge, not a concatenate-and-sort");
    assert.match(unionPlan, /SEARCH mailbox USING INDEX mailbox_pending_metadata \(bee_id=\?\)/);
    assert.match(unionPlan, /SEARCH mailbox USING INDEX mailbox_delivered_by_bee \(bee_id=\?\)/);
    assert.doesNotMatch(unionPlan, /TEMP B-TREE/, "both arms emit id order; no sort");

    for (const { name, sql, pin } of MATRIX) {
      const plan = planOf(check, sql);
      assert.match(plan, pin, `${name} keeps its pinned access path`);
      if (name !== "listMessages (union)" && name !== "delivered-arm content read (test-pinned)") {
        assert.doesNotMatch(plan, /mailbox_delivered_by_bee/,
          `${name} must not be stolen by the delivered-only index`);
      }
    }

    const sql = check.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_delivered_by_bee'",
    ).get() as { sql?: unknown };
    assert.match(String(sql.sql), /WHERE delivered_at IS NOT NULL/, "partial predicate present");
    const cols = check.prepare("SELECT name FROM pragma_index_info('mailbox_delivered_by_bee') ORDER BY seqno")
      .all().map((row) => (row as { name?: unknown }).name);
    assert.deepEqual(cols, ["bee_id"], "single key column; id order comes from the implicit rowid");
  } finally {
    check.close();
  }

  // Delivered-arm content via the pinned covering read: exactly the
  // delivered ids, and pending mail never appears in it.
  store = h.open();
  const pending2 = store.send(bee.id, "still pending").message;
  store.close();
  const content = new DatabaseSync(h.path, { readOnly: true });
  try {
    const deliveredIds = content.prepare(
      "SELECT id FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL ORDER BY id",
    ).all(bee.id).map((row) => Number((row as { id?: unknown }).id));
    assert.deepEqual(deliveredIds, [delivered.id]);
    assert.ok(!deliveredIds.includes(pending2.id), "pending mail is outside the delivered arm");
  } finally {
    content.close();
  }
  store = h.open();
});

test("mailbox_delivered_by_bee installs on existing stores, pre-v8 stores, and tolerates downgrades", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let store = h.open();
  t.after(() => store.close());

  const { bee } = makeBee(store, "migrate-probe");
  const m = store.send(bee.id, "will be delivered").message;
  assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
  store.send(bee.id, "stays pending");
  const expected = store.listMessages(bee.id);
  store.close();

  const raw = (sql: string) => {
    const db = new DatabaseSync(h.path);
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
  };
  const present = () => {
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      return db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_delivered_by_bee'",
      ).get() !== undefined;
    } finally {
      db.close();
    }
  };
  const versionOf = () => {
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown };
      return Number(row.value);
    } finally {
      db.close();
    }
  };
  const versionBefore = versionOf();

  // Existing store missing the index (a pre-candidate build wrote it last):
  // the next open reinstalls from SCHEMA_SQL, no version bump.
  raw("DROP INDEX IF EXISTS mailbox_delivered_by_bee");
  assert.equal(present(), false);
  store = h.open();
  assert.deepEqual(store.listMessages(bee.id), expected, "reinstall changes no rows");
  store.close();
  assert.equal(present(), true, "SCHEMA_SQL reinstalls the delivered index on open");
  assert.equal(versionOf(), versionBefore, "additive index does not change the schema format");

  // Downgrade tolerance: an old build does not know the index but SQLite
  // maintains every schema index on its writes; simulate old-build traffic
  // raw, then prove integrity and identical reads on re-upgrade.
  {
    const db = new DatabaseSync(h.path);
    try {
      db.prepare(
        "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation) VALUES(?, 'operator', 'old-build pending', 0, 'next', 99, NULL, NULL)",
      ).run(bee.id);
      db.prepare("UPDATE mailbox SET delivered_at = 100, delivered_generation = 1 WHERE body = 'old-build pending'").run();
      const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown };
      assert.equal(String(integrity.integrity_check), "ok", "old-build writes keep the index consistent");
    } finally {
      db.close();
    }
  }
  store = h.open();
  const afterDowngradeTraffic = store.listMessages(bee.id);
  assert.equal(afterDowngradeTraffic.length, expected.length + 1);
  assert.equal(afterDowngradeTraffic.at(-1)!.body, "old-build pending");
  store.close();
  store = h.open(); // plain reopen: CREATE INDEX IF NOT EXISTS is a no-op
  store.close();
  assert.equal(present(), true);

  // Pre-v8 store (urgency column absent): SCHEMA_SQL installs the delivered
  // index BEFORE migrations run — it needs only v1-era columns — and the
  // urgency migration then completes as usual.
  const h2 = harness();
  t.after(() => h2.cleanup());
  const fixture = new DatabaseSync(h2.path);
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
      VALUES('old-bee','old-bee','claude','hsr','/tmp','active',5);
    CREATE TABLE runtimes (
      bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE, generation INTEGER NOT NULL CHECK (generation >= 1),
      state TEXT NOT NULL CHECK (state IN ('booting','running','idle','stopped')),
      exit_cause TEXT, pid INTEGER, pid_started_at INTEGER, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (bee_id, generation)
    ) STRICT;
    INSERT INTO runtimes(bee_id, generation, state, exit_cause, pid, pid_started_at, started_at, updated_at)
      VALUES('old-bee', 1, 'stopped', 'clean', NULL, NULL, 5, 6);
    CREATE TABLE mailbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE,
      sender TEXT NOT NULL, body TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
      enqueued_at INTEGER NOT NULL, delivered_at INTEGER, delivered_generation INTEGER
    ) STRICT;
    INSERT INTO mailbox(bee_id, sender, body, enqueued_at, delivered_at, delivered_generation)
      VALUES('old-bee', 'operator', 'old pending', 8, NULL, NULL),
            ('old-bee', 'operator', 'old delivered', 7, 10, 1);
  `);
  fixture.close();
  const oldStore = h2.open();
  assert.deepEqual(
    oldStore.listMessages("old-bee").map((msg) => [msg.body, msg.deliveredAt !== null, msg.urgency]),
    [["old pending", false, "next"], ["old delivered", true, "next"]],
    "pre-v8 mail lists identically through the union with migrated urgency defaults",
  );
  oldStore.close();
  const check = new DatabaseSync(h2.path, { readOnly: true });
  try {
    assert.equal(
      check.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_delivered_by_bee'").get() !== undefined,
      true,
      "delivered index installed on the pre-v8 store",
    );
    const version = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: unknown };
    assert.equal(Number(version.value), SCHEMA_VERSION);
  } finally {
    check.close();
  }

  // Raw-vs-raw identity on a closed file: the compound statement equals the
  // legacy single-scan read byte-for-byte, delivered/pending interleaved.
  const rawCheck = new DatabaseSync(h.path, { readOnly: true });
  try {
    assert.deepEqual(
      rawCheck.prepare(UNION_SQL).all(bee.id, bee.id),
      rawCheck.prepare(LEGACY_SQL).all(bee.id),
      "union rows equal the legacy ORDER BY id scan exactly",
    );
  } finally {
    rawCheck.close();
  }
  store = h.open();
});
