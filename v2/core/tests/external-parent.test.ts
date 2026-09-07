/**
 * External-parent persistence is a lineage claim, not a cross-node foreign
 * key. These tests stay inside a temp core store and exercise restart,
 * replay, and local-delete behavior without touching a live daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { replayAudit, SCHEMA_VERSION, type AuditRow, type CoreStore } from "../src/index.ts";
import { harness } from "./helpers.ts";

const PARENT_ID = "15ecdadc-f4b1-4265-9fac-9516a5ada650";

test("external parent flag survives restart and local deletion never orphans the external edge", () => {
  const h = harness();
  let store: CoreStore | null = null;
  try {
    store = h.open();
    const parent = store.createBee({
      id: PARENT_ID,
      name: "local-copy-of-parent",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    }).bee;
    const external = store.createBee({
      name: "external-child",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
      parentId: parent.id,
      parentExternal: true,
    }).bee;
    const local = store.createBee({
      name: "local-child",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
      parentId: parent.id,
    }).bee;
    const unrelated = store.createBee({
      name: "unrelated",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    }).bee;
    const initialStore = store;
    assert.throws(() => initialStore.createBee({
      name: "malformed-external-parent",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
      parentId: "\ud800",
      parentExternal: true,
    }), /external parentId must be well-formed UTF-16/);
    assert.throws(() => initialStore.createBee({
      name: "oversized-external-parent",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
      parentId: "x".repeat(257),
      parentExternal: true,
    }), /external parentId must be at most 256 UTF-8 bytes/);

    assert.equal(parent.parentExternal, false, "roots default to local lineage");
    assert.equal(local.parentExternal, false, "ordinary children default to local lineage");
    assert.equal(external.parentExternal, true);
    assert.equal(external.parentId, PARENT_ID);
    const created = store.auditRows().find((row) => row.kind === "bee.created" && row.beeId === external.id);
    assert.equal((created?.payload.bee as { parentExternal?: unknown }).parentExternal, true,
      "the semantic creation event carries the external-lineage claim");

    store.close();
    store = h.open();
    assert.equal(store.getBee(external.id)?.parentExternal, true, "the flag survives a store restart");

    store.deleteBee(unrelated.id);
    assert.equal(store.getBee(external.id)?.parentId, PARENT_ID, "an unrelated delete leaves the edge intact");
    assert.equal(store.getBee(external.id)?.parentExternal, true);

    const deleted = store.deleteBee(parent.id);
    assert.deepEqual(deleted.orphanedChildIds, [local.id], "only local children are orphaned");
    assert.equal(store.getBee(local.id)?.parentId, null);
    assert.equal(store.getBee(local.id)?.parentExternal, false);
    assert.equal(store.getBee(external.id)?.parentId, PARENT_ID,
      "deleting a local ID collision does not clear foreign lineage");
    assert.equal(store.getBee(external.id)?.parentExternal, true);
    assert.deepEqual(
      store.auditRows().filter((row) => row.kind === "bee.orphaned").map((row) => row.beeId),
      [local.id],
    );
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());

    store.close();
    store = null;
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      const stored = db.prepare("SELECT parent_external FROM bees WHERE id = ?").get(external.id) as {
        parent_external: number;
      };
      assert.equal(stored.parent_external, 1);
      const column = (db.prepare("SELECT * FROM pragma_table_info('bees')").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>).find((candidate) => candidate.name === "parent_external");
      assert.equal(column?.notnull, 1);
      assert.equal(column?.dflt_value, "0");
    } finally {
      db.close();
    }
  } finally {
    store?.close();
    h.cleanup();
  }
});

test("pre-v21 creation events replay with local lineage", () => {
  const h = harness();
  const store = h.open();
  try {
    const root = store.createBee({
      name: "legacy-root",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    }).bee;
    const legacy: AuditRow[] = store.auditRows().map((row) => {
      if (row.kind !== "bee.created") return row;
      const { parentExternal: _dropped, ...bee } = row.payload.bee as Record<string, unknown>;
      return { ...row, payload: { ...row.payload, bee } };
    });

    assert.equal(replayAudit(legacy).bees.find((bee) => bee.id === root.id)?.parentExternal, false);
    assert.deepEqual(replayAudit(legacy), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("a v20 store migrates existing parent edges to local lineage at the current schema", () => {
  const h = harness();
  let store: CoreStore | null = null;
  try {
    store = h.open();
    const parent = store.createBee({
      id: "migration-parent",
      name: "migration-parent",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    }).bee;
    const child = store.createBee({
      id: "migration-child",
      name: "migration-child",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
      parentId: parent.id,
    }).bee;
    store.close();
    store = null;

    const v20 = new DatabaseSync(h.path);
    try {
      v20.exec("ALTER TABLE bees DROP COLUMN parent_external");
      v20.prepare("UPDATE meta SET value = '20' WHERE key = 'schema_version'").run();
      const columns = (v20.prepare("SELECT name FROM pragma_table_info('bees')").all() as Array<{
        name: string;
      }>).map((column) => column.name);
      assert.equal(columns.includes("parent_external"), false, "the fixture has the v20 bee shape");
    } finally {
      v20.close();
    }

    store = h.open();
    assert.deepEqual(store.listBees().map((bee) => bee.id).sort(), [child.id, parent.id].sort());
    assert.equal(store.getBee(parent.id)?.parentExternal, false);
    assert.equal(store.getBee(child.id)?.parentId, parent.id, "migration retains the existing parent edge");
    assert.equal(store.getBee(child.id)?.parentExternal, false);
    store.close();
    store = null;

    const migrated = new DatabaseSync(h.path, { readOnly: true });
    try {
      const version = migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      assert.equal(Number(version.value), SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 22);
      const column = migrated.prepare(
        "SELECT name FROM pragma_table_info('bees') WHERE name = 'parent_external'",
      ).get() as { name: string } | undefined;
      assert.equal(column?.name, "parent_external");
    } finally {
      migrated.close();
    }
  } finally {
    store?.close();
    h.cleanup();
  }
});
