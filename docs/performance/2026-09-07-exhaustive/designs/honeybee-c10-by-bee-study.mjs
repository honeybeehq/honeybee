// C10 listMessages index-shape study — DIAGNOSTIC SCRATCH ONLY.
// Real schema from the c10 worktree build (10c25dfc); byte-copied control vs
// candidate; no production claim beyond plan/structure. Parent owns real
// measurements. Raw bulk inflation bypasses the audit-append contract on
// purpose (plan/storage diagnostics need cardinality, not replayable audit).
import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const WT = "/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-c10-by-bee-2026-09-07";
const OUT = "/tmp/honeybee-c10-by-bee-study.json";
const { openCoreStore } = await import(join(WT, "v2/core/src/index.ts"));

const dir = mkdtempSync(join(tmpdir(), "hb-c10-"));
const basePath = join(dir, "core.sqlite3");

// ---------------------------------------------------------------- fixture ---
let t = 1_000_000;
const now = () => (t += 1_000);
const store = openCoreStore(basePath, { now, ephemeral: true });
const mk = (name) => store.createBee({ name, agent: "claude", substrate: "tmux", cwd: "/tmp/w" });

const sparse = mk("sparse-target").bee; // parent's sparse shape: 20 rows for this bee
for (let i = 0; i < 20; i++) {
  const m = store.send(sparse.id, `sparse message body number ${i} with plausible operator text`).message;
  if (i < 12) assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
}
const victim = mk("cascade-victim").bee; // small mailbox; delete cost isolates child LOCATION
for (let i = 0; i < 10; i++) {
  const m = store.send(victim.id, `victim message ${i}`).message;
  if (i < 8) assert.deepEqual(store.markDelivered(m.id, 1), { applied: true });
}
const giant = mk("giant-history").bee; // parent's full-100k shape, raw-inflated below
const others = [];
for (let i = 0; i < 27; i++) others.push(mk(`filler-${i}`).bee);
store.close();

// Raw inflation (diagnostic; bypasses audit): giant bee 100k rows ~97%
// delivered, small pending tail; fillers 10 mixed rows each.
{
  const db = new DatabaseSync(basePath);
  const ins = db.prepare(
    "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation) VALUES(?, ?, ?, 0, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  for (let i = 0; i < 100_000; i++) {
    const delivered = i < 97_000;
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

const aPath = join(dir, "a.sqlite3"); // control: current schema (10c25dfc)
const bPath = join(dir, "b.sqlite3"); // candidate: + mailbox_by_bee
copyFileSync(basePath, aPath);
copyFileSync(basePath, bPath);
{
  const db = new DatabaseSync(bPath);
  db.exec("CREATE INDEX mailbox_by_bee ON mailbox(bee_id)");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
}
const preVacuumSizes = { a: statSync(aPath).size, b: statSync(bPath).size };

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

// -------------------------------------------------------------- plan matrix ---
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

const matrix = [];
withDb(aPath, (da) =>
  withDb(bPath, (db) => {
    for (const { name, sql, role } of S) {
      const a = planOf(da, sql);
      const b = planOf(db, sql);
      matrix.push({ name, role, control: a, candidate: b, moved: a !== b });
    }
  }),
);
const target = matrix.find((m) => m.name === "listMessages");
assert.match(target.candidate, /SEARCH mailbox USING INDEX mailbox_by_bee \(bee_id=\?\)/);
assert.doesNotMatch(target.candidate, /TEMP B-TREE/);
assert.match(target.control, /SCAN mailbox/);
const negative = matrix.find((m) => m.name === "dumpStateAllRows");
assert.equal(negative.moved, false, "all-row projection must not move");
const theft = matrix.filter((m) => m.role === "pending" && m.moved);

const xinfo = withDb(bPath, (db) => db.prepare("PRAGMA index_xinfo(mailbox_by_bee)").all());

// -------------------------------------------------- timing diagnostics -------
const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
const timeAll = (path, sql, bind, { reps, warmup }) => {
  return withDb(path, (db) => {
    const st = db.prepare(sql);
    for (let i = 0; i < warmup; i++) st.all(...bind);
    const samples = [];
    for (let i = 0; i < reps; i++) {
      const t0 = performance.now();
      const rows = st.all(...bind);
      samples.push(performance.now() - t0);
      assert.ok(rows.length >= 0);
    }
    return { medianMs: median(samples), samples };
  });
};
const LIST_SQL = "SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id";
const timing = {
  note: "wall-clock diagnostic only; parent owns real measurements",
  sparseList: {
    control: timeAll(aPath, LIST_SQL, [sparse.id], { reps: 200, warmup: 20 }),
    candidate: timeAll(bPath, LIST_SQL, [sparse.id], { reps: 200, warmup: 20 }),
  },
  giantList: {
    control: timeAll(aPath, LIST_SQL, [giant.id], { reps: 5, warmup: 1 }),
    candidate: timeAll(bPath, LIST_SQL, [giant.id], { reps: 5, warmup: 1 }),
  },
};
for (const k of ["sparseList", "giantList"]) {
  timing[k].control = { medianMs: timing[k].control.medianMs, samples: timing[k].control.samples };
  timing[k].candidate = { medianMs: timing[k].candidate.medianMs, samples: timing[k].candidate.samples };
}

// ------------------------------------------------------------- storage -------
const vacuumAndSize = (path) => {
  const db = new DatabaseSync(path);
  db.exec("VACUUM");
  db.close();
  return statSync(path).size;
};
const postVacuumSizes = { a: vacuumAndSize(aPath), b: vacuumAndSize(bPath) };

// ---------------------------------------------- FK cascade: structure + time --
const roots = withDb(bPath, (db) =>
  Object.fromEntries(
    db
      .prepare("SELECT name, rootpage FROM sqlite_master WHERE name IN ('mailbox','mailbox_by_bee','mailbox_pending_metadata')")
      .all()
      .map((r) => [String(r.name), Number(r.rootpage)]),
  ),
);
const cascadeOps = (path) =>
  withDb(
    path,
    (db) => {
      const rp = Object.fromEntries(
        db
          .prepare("SELECT name, rootpage FROM sqlite_master WHERE name IN ('mailbox','mailbox_by_bee','mailbox_pending_metadata')")
          .all()
          .map((r) => [String(r.name), Number(r.rootpage)]),
      );
      const ops = db.prepare("EXPLAIN DELETE FROM bees WHERE id = ?").all();
      const byRoot = {};
      for (const [name, page] of Object.entries(rp)) {
        byRoot[name] = ops
          .filter((o) => (String(o.opcode) === "OpenRead" || String(o.opcode) === "OpenWrite") && Number(o.p2) === page)
          .map((o) => `${o.addr}:${o.opcode}(cursor p1=${o.p1})`);
      }
      const scanOps = ops.filter((o) => ["Rewind", "SeekGE", "SeekGT", "Last"].includes(String(o.opcode))).length;
      return { totalOps: ops.length, mailboxCursorOpens: byRoot, positioningOps: scanOps };
    },
    { fk: true },
  );
const cascadeStructure = { control: cascadeOps(aPath), candidate: cascadeOps(bPath) };

const cascadeDelete = (path) =>
  withDb(
    path,
    (db) => {
      const pre = db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id = ?").get(victim.id);
      assert.equal(Number(pre.n), 10);
      const t0 = performance.now();
      db.prepare("DELETE FROM bees WHERE id = ?").run(victim.id);
      const ms = performance.now() - t0;
      const post = db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id = ?").get(victim.id);
      assert.equal(Number(post.n), 0, "cascade must still remove the victim's mailbox rows");
      return ms;
    },
    { fk: true, writable: true },
  );
const cascadeTimingMs = { control: cascadeDelete(aPath), candidate: cascadeDelete(bPath) };

// ------------------------------------------------------------------ output ---
const counts = withDb(aPath, (db) => ({
  mailboxRows: Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox").get().n),
  pendingRows: Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE delivered_at IS NULL").get().n),
  bees: Number(db.prepare("SELECT COUNT(*) AS n FROM bees").get().n),
}));
const out = {
  scope: "diagnostic scratch; real schema at 10c25dfc via the worktree's own openCoreStore; raw bulk inflation bypasses audit (stated); wall timings are not measurement claims",
  sqlite: withDb(aPath, (db) => String(db.prepare("SELECT sqlite_version() AS v").get().v)),
  node: process.version,
  counts,
  preVacuumSizes,
  postVacuumSizes,
  indexBytesPostVacuum: postVacuumSizes.b - postVacuumSizes.a,
  matrix,
  theftMoved: theft.map((m) => m.name),
  xinfo,
  timing,
  cascadeStructure,
  cascadeTimingMs,
};
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      ok: true,
      counts,
      indexBytesPostVacuum: out.indexBytesPostVacuum,
      theftMoved: out.theftMoved,
      sparse: { a: timing.sparseList.control.medianMs, b: timing.sparseList.candidate.medianMs },
      giant: { a: timing.giantList.control.medianMs, b: timing.giantList.candidate.medianMs },
      cascadeTimingMs,
    },
    null,
    2,
  ),
);
