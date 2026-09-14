import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { replayAudit, type CoreStore } from "../src/index.ts";
import { harness, bootToRunning } from "./helpers.ts";

function create(store: CoreStore, id: string, extra = {}) {
  return store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp", ...extra }).bee;
}

for (const state of ["running", "stopped", "archived"] as const) {
  test(`set parent preserves ${state} runtime, mail, descendants and provenance through undo/reopen`, () => {
    const h = harness(); let store = h.open();
    try {
      create(store, "parent");
      const child = create(store, "child", { parentId: "parent", tags: ["apiary:parent=parent", "apiary:top-level", "keep"], forkedFrom: "source", forkSeed: "seed", providerSessionId: "conversation" });
      create(store, "grandchild", { parentId: child.id });
      if (state === "running") bootToRunning(store, child.id, 123, 456);
      else store.updateRuntimeState(child.id, 1, "stopped", { exitCause: "stopped_by_user" });
      store.send(child.id, "pending", { sender: "operator" });
      if (state === "archived") store.archiveBee(child.id);
      const before = store.dumpState();
      const result = store.setBeeParent(child.id, null, true);
      assert.equal(result.applied, true);
      assert.equal(result.bee.parentId, null);
      assert.equal(result.bee.parentExternal, false);
      assert.equal(result.bee.createdById, "parent");
      assert.deepEqual(result.bee.tags, ["apiary:top-level", "keep"]);
      const after = store.dumpState();
      assert.deepEqual({ ...after, bees: before.bees }, before);
      assert.deepEqual(store.getBee("grandchild"), before.bees.find(b => b.id === "grandchild"));
      assert.deepEqual({ ...result.bee, parentId: child.parentId, parentExternal: child.parentExternal, tags: child.tags }, before.bees.find(b => b.id === "child"));
      const event = store.auditRows().filter(r => r.kind === "bee.parent_set").at(-1)!;
      assert.deepEqual(event.payload, { beeId: "child", parentId: null, parentExternal: false, createdById: "parent", tags: ["apiary:top-level", "keep"] });
      const count = store.auditRows().length;
      assert.equal(store.setBeeParent(child.id, null, false).applied, false);
      assert.equal(store.auditRows().length, count);
      store.close(); store = h.open();
      assert.equal(store.getBee(child.id)?.createdById, "parent");
      assert.equal(store.setBeeParent(child.id, "parent", false).applied, true);
      store.deleteBee("parent");
      assert.equal(store.getBee(child.id)?.createdById, "parent");
      assert.equal(store.getBee(child.id)?.parentId, null);
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    } finally { store.close(); h.cleanup(); }
  });
}

test("validation, explicit external claims, root null creator and same-edge legacy cleanup", () => {
  const h = harness(); const store = h.open();
  try {
    create(store, "root", { createdById: null, tags: ["apiary:parent=old"] });
    create(store, "child", { parentId: "root" });
    create(store, "descendant", { parentId: "child" });
    for (const [bee, parent, external] of [["missing", null, false], ["root", "missing", false], ["root", "root", false], ["root", "root", true], ["root", "descendant", false], ["root", "", false], ["root", "\ud800", true]] as const) {
      const before = store.dumpState(); const audit = store.auditRows();
      assert.throws(() => store.setBeeParent(bee, parent, external));
      assert.deepEqual(store.dumpState(), before); assert.deepEqual(store.auditRows(), audit);
    }
    assert.equal(store.setBeeParent("root", null, false).applied, true);
    assert.equal(store.setBeeParent("root", null, true).applied, false);
    assert.equal(store.getBee("root")?.createdById, null);
    store.archiveBee("child");
    store.setBeeParent("descendant", "child", false);
    store.setBeeParent("root", "remote-id", true);
    assert.equal(store.getBee("root")?.parentExternal, true);
    assert.equal(store.getBee("root")?.createdById, null);
    // Matches spawn's existing external collision policy: a separate authority.
    store.setBeeParent("root", "child", true);
    store.deleteBee("child");
    assert.equal(store.getBee("root")?.parentId, "child");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

test("v22 migration recovers recorded parent/tag/orphan provenance, never fills unknown roots; null remains immutable", () => {
  const h = harness(); let store = h.open();
  try {
    create(store, "parent"); create(store, "child", { parentId: "parent" });
    create(store, "legacy", { tags: ["apiary:parent=legacy-parent", "keep"] });
    create(store, "unknown"); create(store, "ambiguous", { tags: ["apiary:parent=a", "apiary:parent=b"] });
    create(store, "orphan", { parentId: "deleted-parent" });
    store.close();
    const db = new DatabaseSync(h.path);
    db.exec("DROP TRIGGER bees_creator_immutable; ALTER TABLE bees DROP COLUMN created_by_id; ALTER TABLE rpc_idempotency DROP COLUMN request_hash; UPDATE meta SET value = '22' WHERE key = 'schema_version'; UPDATE bees SET parent_id = NULL WHERE id = 'orphan'");
    db.exec("UPDATE audit SET payload = json_remove(payload, '$.bee.createdById') WHERE kind = 'bee.created'");
    db.close();
    store = h.open();
    assert.equal(store.getBee("child")?.createdById, "parent");
    assert.equal(store.getBee("legacy")?.createdById, "legacy-parent");
    assert.equal(store.getBee("orphan")?.createdById, "deleted-parent");
    assert.equal(store.getBee("unknown")?.createdById, null);
    assert.equal(store.getBee("ambiguous")?.createdById, null);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.setBeeParent("unknown", "parent", false);
    store.close(); store = h.open();
    assert.equal(store.getBee("unknown")?.createdById, null);
    store.close();
    const raw = new DatabaseSync(h.path);
    assert.throws(() => raw.exec("UPDATE bees SET created_by_id = 'parent' WHERE id = 'unknown'"), /immutable/);
    assert.throws(() => raw.exec("UPDATE bees SET created_by_id = NULL WHERE id = 'child'"), /immutable/);
    raw.close();
  } finally { store.close(); h.cleanup(); }
});

test("parent RPC results are retained beyond ordinary idempotency eviction", () => {
  const h = harness(); const store = h.open({ maxRpcIdempotencyRows: 1 });
  try {
    store.recordRpcResult("parent-key", "bee.setParent", null, { applied: true }, "request");
    store.recordRpcResult("other1", "send", null, {});
    store.recordRpcResult("other2", "send", null, {});
    assert.equal(store.lookupRpcResult("parent-key")?.requestHash, "request");
    assert.equal(store.lookupRpcResult("other1"), null);
    assert.ok(store.lookupRpcResult("other2"));
  } finally { store.close(); h.cleanup(); }
});
