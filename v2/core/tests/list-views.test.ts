import { test } from "node:test";
import assert from "node:assert/strict";
import { replayAudit } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("listBeeViewRows batches the same authoritative view, runtime, flags, and lifecycle filtering", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();

  const { bee: active } = makeBee(store, "active");
  bootToRunning(store, active.id, 101, 11);
  store.setFlag(active.id, "auth_needed", "sign in");
  store.setFlag(active.id, "resource_blocked", "quota");

  const { bee: archived } = makeBee(store, "archived");
  store.updateRuntimeState(archived.id, 1, "stopped", { exitCause: "clean" });
  store.archiveBee(archived.id);

  const activeRows = store.listBeeViewRows("active");
  assert.equal(activeRows.length, 1);
  assert.deepEqual(activeRows[0]?.bee, store.getBee(active.id));
  assert.deepEqual(activeRows[0]?.runtime, store.currentRuntime(active.id));
  assert.deepEqual(activeRows[0]?.view, store.view(active.id));
  assert.deepEqual(activeRows[0]?.view.flags, ["auth_needed", "resource_blocked"]);

  const archivedRows = store.listBeeViewRows("archived");
  assert.equal(archivedRows.length, 1);
  assert.equal(archivedRows[0]?.bee.id, archived.id);
  assert.deepEqual(archivedRows[0]?.view, store.view(archived.id));

  const allRows = store.listBeeViewRows();
  assert.deepEqual(allRows.map((row) => row.view), store.views());
  assert.deepEqual(store.listBeeViewRows("deleted"), []);
  store.close();
});


test("list views preserve latest generations, flags, ordering and replay across long histories", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const ids: string[] = [];
  store.transact(() => {
    for (let i = 0; i < 12; i++) {
      const { bee } = store.createBee({ id: `bee-${12 - i}`, name: `worker-${i}`, agent: "stub", substrate: "hsr", cwd: "/tmp" });
      ids.push(bee.id);
      for (let generation = 1; generation <= i * 4 + 1; generation++) {
        store.updateRuntimeState(bee.id, generation, "stopped", { exitCause: "clean" });
        store.reviveBee(bee.id);
      }
      if (i % 3 === 0) store.archiveBee(bee.id);
      if (i % 3 === 1) {
        store.setFlag(bee.id, "auth_needed", "test");
        store.setFlag(bee.id, "resource_blocked", "test");
        store.clearFlag(bee.id, "auth_needed");
      }
      if (i % 3 === 2) bootToRunning(store, bee.id, 101 + i, 10 + i);
    }
  });
  const verify = (): void => {
    const seq = store.lastAuditSeq();
    for (const lifecycle of [null, "active", "archived", "deleted", "unknown"]) {
      const expected = store.listBees()
        .filter(bee => lifecycle === null || bee.lifecycle === lifecycle)
        .map(bee => ({ bee, runtime: store.currentRuntime(bee.id), view: store.view(bee.id), move: null, cell: null }));
      assert.deepEqual(store.listBeeViewRows(lifecycle), expected);
    }
    assert.equal(store.lastAuditSeq(), seq, "read projection never writes audit rows");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  };
  verify();
  const id = ids[0];
  assert.ok(id);
  store.unarchiveBee(id);
  const runtime = store.currentRuntime(id);
  assert.ok(runtime);
  store.updateRuntimeState(id, runtime.generation, "stopped", { exitCause: "clean" });
  store.reviveBee(id);
  verify();
  // A rolled-back generation cannot remain visible through a read optimization.
  assert.throws(() => store.transact(() => {
    const current = store.currentRuntime(id);
    assert.ok(current);
    store.updateRuntimeState(id, current.generation, "stopped", { exitCause: "clean" });
    store.reviveBee(id);
    verify();
    throw new Error("rollback probe");
  }), /rollback probe/);
  verify();
  store.deleteBee(id);
  verify();
});
