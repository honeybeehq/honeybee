// C10 bounded-alternative comparison — DIAGNOSTIC SCRATCH ONLY.
// Variants (same index NAME on separate byte-copies so EQP text stays
// comparable): v1 (bee_id), v2 (bee_id, id), v3 (bee_id, delivered_at).
// Queries unchanged; no ANALYZE; no INDEXED BY. Parent owns real measurement.
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const WT = "/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-c10-by-bee-2026-09-07";
const OUT = "/tmp/honeybee-c10-variants.json";
const { openCoreStore } = await import(join(WT, "v2/core/src/index.ts"));

const dir = mkdtempSync(join(tmpdir(), "hb-c10v-"));
const basePath = join(dir, "core.sqlite3");

// ---------------------------------------------------------------- fixture ---
// Parent shapes: sparse 20-of-total, and the SAME-BEE negative control
// (100k delivered + 20 pending on one bee).
let t = 1_000_000;
const now = () => (t += 1_000);
const store = openCoreStore(basePath, { now, ephemeral: true });
const mk = (name) => store.createBee({ name, agent: "claude", substrate: "tmux", cwd: "/tmp/w" });
const sparse = mk("sparse-target").bee;
for (let i = 0; i < 20; i++) {
  const m = store.send(sparse.id, `sparse message body number ${i} with plausible operator text`).message;
  if (i < 12) assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
}
const victim = mk("cascade-victim").bee;
for (let i = 0; i < 10; i++) {
  const m = store.send(victim.id, `victim message ${i}`).message;
  if (i < 8) assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
}
// Genuinely interleaved delivered/pending ids: the UNION ALL rewrite's
// ORDER BY id merge must interleave its two arms row-perfectly here.
const inter = mk("interleaved-states").bee;
for (let i = 0; i < 40; i++) {
  const m = store.send(inter.id, `interleaved message ${i}`, { urgency: i % 3 === 0 ? "now" : "next" }).message;
  if (i % 2 === 0) assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
}
const giant = mk("giant-history").bee;
const others = [];
for (let i = 0; i < 27; i++) others.push(mk(`filler-${i}`).bee);
store.close();
{
  const db = new DatabaseSync(basePath);
  const ins = db.prepare(
    "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation) VALUES(?, ?, ?, 0, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i < 100_020; i++) {
    const delivered = i < 100_000; // 100k delivered + 20 pending, SAME bee
    ins.run(
      giant.id,
      i % 7 === 0 ? "operator" : "system",
      `giant history row ${i} — realistic mid-size body text for storage estimates`,
      i % 11 === 0 ? "now" : i % 5 === 0 ? "idle" : "next",
      2_000_000 + i,
      delivered ? 2_000_500 + i : null,
      delivered ? 1 : null,
    );
  }
  for (const bee of others) {
    for (let i = 0; i < 10; i++) {
      const delivered = i < 8;
      ins.run(bee.id, "operator", `filler ${i}`, "next", 3_000_000 + i, delivered ? 3_000_500 + i : null, delivered ? 1 : null);
    }
  }
  db.exec("COMMIT");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}

const VARIANTS = [
  { key: "control", ddl: null },
  { key: "bee_id", ddl: "CREATE INDEX mailbox_by_bee ON mailbox(bee_id)" },
  { key: "bee_id_id", ddl: "CREATE INDEX mailbox_by_bee ON mailbox(bee_id, id)" },
  { key: "bee_id_delivered_at", ddl: "CREATE INDEX mailbox_by_bee ON mailbox(bee_id, delivered_at)" },
  {
    key: "delivered_partial_union",
    ddl: "CREATE INDEX mailbox_delivered_by_bee ON mailbox(bee_id) WHERE delivered_at IS NOT NULL",
    indexName: "mailbox_delivered_by_bee",
  },
];
for (const v of VARIANTS) {
  v.path = join(dir, `${v.key}.sqlite3`);
  copyFileSync(basePath, v.path);
  if (v.ddl) {
    const db = new DatabaseSync(v.path);
    db.exec(v.ddl);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }
}

// ------------------------------------------------- verbatim statement set ---
const storeSrc = readFileSync(join(WT, "v2/core/src/store.ts"), "utf8");
const norm = (s) => s.replace(/\s+/g, " ").trim();
const normSrc = norm(storeSrc);
const S = [];
const addStmt = (name, sql, role) => {
  assert.ok(normSrc.includes(norm(sql)), `store.ts must contain ${name} verbatim`);
  S.push({ name, sql, role });
};
addStmt("listMessages", "SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id", "target");
addStmt("undeliveredMessages", "SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id", "pending");
addStmt("perBeePendingProbe", "SELECT 1 FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL LIMIT 1", "pending");
addStmt("listUndeliveredMessages", "SELECT * FROM mailbox WHERE delivered_at IS NULL ORDER BY bee_id, id", "pending");
addStmt(
  "pendingMailJoin",
  `SELECT h.*
       FROM mailbox m
       JOIN mail_history_enqueues h ON h.message_id = m.id
       WHERE m.bee_id = ? AND m.delivered_at IS NULL
       ORDER BY m.id
       LIMIT ?`,
  "pending",
);
addStmt("getMessage", "SELECT * FROM mailbox WHERE id = ?", "pk");
addStmt(
  "workMessages",
  `SELECT message.id,
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
  "pending",
);
addStmt(
  "i1Facts",
  `WITH pending_bees AS (
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
  "pending",
);
addStmt(
  "i1Messages",
  `SELECT id, bee_id, urgency, enqueued_at
       FROM mailbox
       WHERE delivered_at IS NULL
       ORDER BY bee_id, id`,
  "pending",
);
addStmt("globalPendingProbe", "SELECT 1 FROM mailbox WHERE delivered_at IS NULL LIMIT 1", "pending");
addStmt(
  "idsAmong",
  "SELECT id FROM mailbox WHERE delivered_at IS NULL AND id IN (SELECT value FROM json_each(?))",
  "pending",
);
addStmt("dumpStateAllRows", "SELECT * FROM mailbox ORDER BY id", "negative-control");

// ------------------------------------------------------------ per variant ---
const planOf = (db, sql) =>
  db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => String(r.detail)).join("\n");
const withDb = (path, fn, { fk = false, writable = false } = {}) => {
  const db = new DatabaseSync(path, writable ? {} : { readOnly: true });
  try {
    if (fk) db.exec("PRAGMA foreign_keys = ON");
    return fn(db);
  } finally {
    db.close();
  }
};
const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
const timeAll = (path, sql, bind, { reps, warmup }) =>
  withDb(path, (db) => {
    const st = db.prepare(sql);
    for (let i = 0; i < warmup; i++) st.all(...bind);
    const samples = [];
    let lastCount = 0;
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const rows = st.all(...bind);
      samples.push(performance.now() - t0);
      lastCount = rows.length;
    }
    return { medianMs: median(samples), rows: lastCount, samples };
  });

const LIST_SQL = "SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id";
const UNDELIVERED_SQL = "SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL ORDER BY id";
// Parent's query-rewrite shape: ONE statement, disjoint/exhaustive partitions,
// final ORDER BY id. Reported structurally only — no production edit approval.
const UNION_SQL = `SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL
UNION ALL
SELECT * FROM mailbox WHERE bee_id = ? AND delivered_at IS NOT NULL
ORDER BY id`;
const controlPlans = {};
const results = [];
for (const v of VARIANTS) {
  const plans = withDb(v.path, (db) =>
    S.map(({ name, sql, role }) => ({ name, role, plan: planOf(db, sql) })),
  );
  if (v.key === "control") for (const p of plans) controlPlans[p.name] = p.plan;
  const moved = plans.filter((p) => controlPlans[p.name] !== p.plan).map((p) => p.name);
  const xinfo = v.ddl
    ? withDb(v.path, (db) => db.prepare(`PRAGMA index_xinfo(${v.indexName ?? "mailbox_by_bee"})`).all())
    : null;
  const unionRewrite = withDb(v.path, (db) => {
    const plan = planOf(db, UNION_SQL);
    const original = db.prepare(LIST_SQL);
    const rewritten = db.prepare(UNION_SQL);
    for (const bee of [sparse, inter, giant]) {
      assert.deepEqual(
        rewritten.all(bee.id, bee.id),
        original.all(bee.id),
        `UNION ALL rewrite must return byte-identical rows (${v.key})`,
      );
    }
    return { plan };
  });
  unionRewrite.timing = {
    sparse: timeAll(v.path, UNION_SQL, [sparse.id, sparse.id], { reps: 200, warmup: 20 }),
    interleaved: timeAll(v.path, UNION_SQL, [inter.id, inter.id], { reps: 200, warmup: 20 }),
    giant: timeAll(v.path, UNION_SQL, [giant.id, giant.id], { reps: 3, warmup: 1 }),
  };
  const timing = {
    sparseList: timeAll(v.path, LIST_SQL, [sparse.id], { reps: 200, warmup: 20 }),
    giantList: timeAll(v.path, LIST_SQL, [giant.id], { reps: 5, warmup: 1 }),
    sparseUndelivered: timeAll(v.path, UNDELIVERED_SQL, [sparse.id], { reps: 200, warmup: 20 }),
    giantUndelivered: timeAll(v.path, UNDELIVERED_SQL, [giant.id], { reps: 20, warmup: 2 }),
  };
  assert.equal(timing.sparseList.rows, 20);
  assert.equal(timing.giantList.rows, 100_020);
  assert.equal(timing.sparseUndelivered.rows, 8);
  assert.equal(timing.giantUndelivered.rows, 20);
  assert.equal(unionRewrite.timing.interleaved.rows, 40);
  const cascadeMs = withDb(
    v.path,
    (db) => {
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id = ?").get(victim.id).n), 10);
      const t0 = performance.now();
      db.prepare("DELETE FROM bees WHERE id = ?").run(victim.id);
      const ms = performance.now() - t0;
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id = ?").get(victim.id).n), 0);
      return ms;
    },
    { fk: true, writable: true },
  );
  const vac = new DatabaseSync(v.path);
  vac.exec("VACUUM");
  vac.close();
  const size = statSync(v.path).size;
  results.push({ variant: v.key, ddl: v.ddl, moved, plans, xinfo, unionRewrite, timing, cascadeMs, postVacuumBytes: size });
}

const controlSize = results.find((r) => r.variant === "control").postVacuumBytes;
for (const r of results) r.indexBytes = r.postVacuumBytes - controlSize;

const out = {
  scope:
    "diagnostic scratch; real schema at 10c25dfc via the worktree's own openCoreStore; raw bulk inflation bypasses audit (stated); same-bee negative control = 100k delivered + 20 pending on one bee; wall timings are not measurement claims",
  sqlite: withDb(basePath, (db) => String(db.prepare("SELECT sqlite_version() AS v").get().v)),
  node: process.version,
  counts: withDb(basePath, (db) => ({
    mailboxRows: Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get().n),
    pendingRows: Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE delivered_at IS NULL").get().n),
  })),
  results,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    results.map((r) => ({
      variant: r.variant,
      moved: r.moved,
      indexBytes: r.indexBytes,
      sparseListMs: r.timing.sparseList.medianMs,
      giantListMs: r.timing.giantList.medianMs,
      giantUndeliveredMs: r.timing.giantUndelivered.medianMs,
      unionGiantMs: r.unionRewrite.timing.giant.medianMs,
      unionPlanHasSort: /TEMP B-TREE/.test(r.unionRewrite.plan),
      cascadeMs: r.cascadeMs,
    })),
    null,
    2,
  ),
);
