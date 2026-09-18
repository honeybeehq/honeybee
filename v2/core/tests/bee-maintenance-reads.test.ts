import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { harness } from "./helpers.ts";

test("maintenance reads follow title and lifecycle changes, rollback, deletion and populated reopen", () => {
  const h = harness();
  let store = h.open();
  try {
    assert.deepEqual(store.countBeesByLifecycle(), { total: 0, active: 0, archived: 0 });
    const add = (id: string, title: string | null = null) => store.createBee({
      id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp", ...(title === null ? {} : { title }),
    });
    add("untitled");
    add("empty-title", "");
    add("named", "Already named");
    add("archived");
    store.archiveBee("archived");
    const verify = () => {
      const bees = store.listBees();
      const seq = store.lastAuditSeq();
      assert.deepEqual(store.listAutoTitleCandidates(), bees
        .filter(bee => bee.lifecycle === "active" && !bee.title)
        .map(({ id, title, lifecycle }) => ({ id, title, lifecycle })));
      assert.deepEqual(store.countBeesByLifecycle(), {
        total: bees.length,
        active: bees.filter(bee => bee.lifecycle === "active").length,
        archived: bees.filter(bee => bee.lifecycle === "archived").length,
      });
      assert.equal(store.lastAuditSeq(), seq, "maintenance reads are silent");
    };
    verify();
    store.setBeeTitle("untitled", "Named now");
    store.unarchiveBee("archived");
    verify();
    assert.throws(() => store.transact(() => {
      store.archiveBee("empty-title");
      store.setBeeTitle("archived", "Speculative title");
      verify();
      throw new Error("rollback maintenance probe");
    }), /rollback maintenance probe/);
    verify();
    store.deleteBee("empty-title");
    verify();
    const state = store.dumpState(), audit = store.auditRows();
    store.close();
    const old = new DatabaseSync(h.path);
    try { old.exec("DROP INDEX bees_auto_title_candidates; DROP INDEX bees_by_lifecycle"); }
    finally { old.close(); }
    store = h.open();
    assert.deepEqual(store.dumpState(), state);
    assert.deepEqual(store.auditRows(), audit, "index installation is not a semantic event");
    verify();
    store.close();
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      const candidatePlan = db.prepare("EXPLAIN QUERY PLAN SELECT id, title, lifecycle FROM bees WHERE lifecycle = 'active' AND (title IS NULL OR title = '') ORDER BY id").all();
      assert.match(candidatePlan.map(row => String(row.detail)).join("\n"), /USING COVERING INDEX bees_auto_title_candidates/);
      const countsPlan = db.prepare("EXPLAIN QUERY PLAN SELECT lifecycle, COUNT(*) AS count FROM bees GROUP BY lifecycle").all();
      assert.match(countsPlan.map(row => String(row.detail)).join("\n"), /USING COVERING INDEX bees_by_lifecycle/);
    } finally { db.close(); }
  } finally { store.close(); h.cleanup(); }
});
