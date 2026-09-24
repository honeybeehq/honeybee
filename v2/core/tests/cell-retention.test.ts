/**
 * v31 Cell retention in the core store: the `evicted` state transitions, the
 * audit trail (replay reproduces the dump), the mirror row keys, and the
 * v30 → v31 `cells` table rebuild carrying rows across by name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  IllegalTransitionError,
  MIRROR_CELL_KEYS,
  SCHEMA_VERSION,
  openCoreStore,
  replayAudit,
  type CellRow,
} from "../src/index.ts";
import { harness } from "./helpers.ts";

function putActiveCell(store: ReturnType<ReturnType<typeof harness>["open"]>, beeId: string, cwd: string): CellRow {
  return store.putCell({
    sourceBeeId: beeId,
    originRepo: "/tmp/origin",
    sha: "abc",
    wrapper: "w",
    spaceName: "repo-space-c1",
    spaceDir: cwd,
    gitCommonDirRealpath: "/tmp/origin/.git",
    objectFormat: "sha1",
  });
}

test("cell-retention.evict: active → evicted keeps the allocation, records HEAD, reactivates on materialization", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/w/repo-space-c1" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    assert.deepEqual(Object.keys(cell).sort(), [...MIRROR_CELL_KEYS].sort(), "mirror keys cover the row");
    assert.equal(cell.evictedAt, null);
    assert.equal(cell.evictedHead, null);

    const evicted = store.evictCell(cell.id, { head: "feedbeef", bytes: 4096, reason: "archived_age" });
    assert.equal(evicted.state, "evicted");
    assert.equal(evicted.evictedHead, "feedbeef");
    assert.ok(evicted.evictedAt != null);
    assert.equal(store.getBee(bee.id)?.cellId, cell.id, "the bee keeps its Cell id");
    assert.equal(store.getBee(bee.id)?.cwd, "/tmp/w/repo-space-c1", "the bee keeps its cwd");
    // Idempotent: a second eviction is the same row, no new audit.
    const before = store.auditRows().length;
    assert.deepEqual(store.evictCell(cell.id, { head: "other", bytes: null, reason: "x" }), evicted);
    assert.equal(store.auditRows().length, before);
    const evictedAudit = store.auditRows().filter((r) => r.kind === "cell.evicted");
    assert.equal(evictedAudit.length, 1);
    assert.equal((evictedAudit[0]!.payload as { bytes: number }).bytes, 4096);

    const back = store.reactivateCell(cell.id);
    assert.equal(back.applied, true);
    assert.equal(back.cell.state, "active");
    assert.equal(back.cell.evictedAt, null);
    assert.equal(back.cell.evictedHead, null);
    assert.equal(store.reactivateCell(cell.id).applied, false, "reactivate is a no-op on an active row");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-retention.evict: only an active Cell can be evicted; a retained one is removed, an evicted one can still be removed", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/w/repo-space-c1" });
    const cell = putActiveCell(store, bee.id, bee.cwd);
    store.retainCell(cell.id);
    assert.throws(() => store.evictCell(cell.id, { head: null, bytes: null, reason: "x" }), IllegalTransitionError);
    assert.equal(store.markCellRemoved(cell.id).state, "removed");

    const { bee: other } = store.createBee({ name: "d", agent: "claude", substrate: "cell", cwd: "/tmp/w2/repo-space-c2" });
    const second = store.putCell({
      sourceBeeId: other.id, originRepo: "/tmp/origin", sha: "abc", wrapper: "w2", spaceName: "repo-space-c2",
      spaceDir: other.cwd, gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1",
    });
    store.evictCell(second.id, { head: "h", bytes: null, reason: "operator" });
    assert.throws(() => store.evictCell(cell.id, { head: null, bytes: null, reason: "x" }), IllegalTransitionError, "removed stays removed");
    const removed = store.markCellRemoved(second.id);
    assert.equal(removed.state, "removed");
    assert.equal(store.getBee(other.id)?.cellId, null, "removal clears the pointer even from evicted");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("cell-retention.schema: a v30 store's cells table is rebuilt with the evicted state and rows carried across", () => {
  const h = harness();
  try {
    const db = new DatabaseSync(h.path);
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO meta(key, value) VALUES('schema_version', '30');
      INSERT INTO meta(key, value) VALUES('human_ref_installation_id', '11111111-2222-4333-8444-555555555555');
      CREATE TABLE bees (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, agent TEXT NOT NULL, substrate TEXT NOT NULL, cwd TEXT NOT NULL,
        title TEXT, tags TEXT NOT NULL DEFAULT '[]', session_log_path TEXT,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
        created_at INTEGER NOT NULL, archived_at INTEGER, last_output_at INTEGER,
        provider_session_id TEXT, env TEXT NOT NULL DEFAULT '{}', imported_from TEXT,
        spawn_failures INTEGER NOT NULL DEFAULT 0, args TEXT, parent_id TEXT, forked_from TEXT,
        fork_seed TEXT, account TEXT, handle TEXT, parent_external INTEGER NOT NULL DEFAULT 0,
        placement_version INTEGER NOT NULL DEFAULT 0, active_move_id TEXT, cell_id TEXT, active_handoff_id TEXT
      ) STRICT;
      INSERT INTO bees(id, name, agent, substrate, cwd, lifecycle, created_at, handle, cell_id)
        VALUES('b1','old','claude','cell','/cells/w/repo-space-x','archived',5,'CL.old1','cell-1');
      CREATE TABLE cells (
        id TEXT PRIMARY KEY, source_bee_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active','retained','removing','removed')),
        git_common_dir TEXT NOT NULL, object_format TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
        origin_repo TEXT NOT NULL, sha TEXT NOT NULL, wrapper TEXT NOT NULL, space_name TEXT NOT NULL,
        space_dir TEXT NOT NULL, sandbox INTEGER, created_at INTEGER NOT NULL, retained_at INTEGER, removed_at INTEGER
      ) STRICT;
      INSERT INTO cells(id, source_bee_id, state, git_common_dir, object_format, origin_repo, sha, wrapper, space_name, space_dir, sandbox, created_at, retained_at, removed_at)
        VALUES('cell-1','b1','active','/origin/.git','sha1','/origin','abc','w','repo-space-x','/cells/w/repo-space-x',NULL,7,NULL,NULL),
              ('cell-2','b1','retained','/origin/.git','sha1','/origin','abc','w2','repo-space-y','/cells/w2/repo-space-y',1,8,9,NULL);
    `);
    db.close();
    const store = h.open();
    try {
      const carried = store.getCell("cell-1");
      assert.equal(carried?.state, "active");
      assert.equal(carried?.evictedAt, null);
      assert.equal(carried?.evictedHead, null);
      assert.equal(store.getCell("cell-2")?.retainedAt, 9);
      assert.equal(store.getCell("cell-2")?.sandbox, true);
      const evicted = store.evictCell("cell-1", { head: "h1", bytes: 1, reason: "archived_age" });
      assert.equal(evicted.state, "evicted", "the rebuilt CHECK accepts evicted");
    } finally {
      store.close();
    }
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      assert.equal(Number((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 31);
      assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name = 'cells_v30'").get(), undefined, "scratch table dropped");
      const cols = (check.prepare("SELECT name FROM pragma_table_info('cells')").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("evicted_at") && cols.includes("evicted_head"));
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});
