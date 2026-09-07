import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { harness, makeBee } from "./helpers.ts";

test("flag expiry index installs on populated reopen and preserves due order, audit, and rollback", () => {
  const h = harness();
  let store = h.open();
  try {
    const { bee } = makeBee(store);
    const dueLater = store.setFlag(bee.id, "auth_needed", "later timestamp, earlier id", { resetsAt: 200 });
    const dueEarlier = store.setFlag(bee.id, "resource_blocked", "earlier timestamp, later id", { resetsAt: 100 });
    const open = store.setFlag(bee.id, "spawn_failed", "open ended");
    const future = store.setFlag(bee.id, "node_unreachable", "future", { resetsAt: 300 });
    const state = store.dumpState(), audit = store.auditRows();
    store.close();
    const old = new DatabaseSync(h.path);
    try { old.exec("DROP INDEX flags_due"); } finally { old.close(); }
    store = h.open();
    assert.deepEqual(store.dumpState(), state);
    assert.deepEqual(store.auditRows(), audit, "index installation is not a semantic event");
    const rollback = new Error("rollback expiry");
    assert.throws(() => store.transact(() => {
      assert.deepEqual(store.expireFlags(200).map(f => f.id), [dueLater.id, dueEarlier.id]);
      throw rollback;
    }), error => error === rollback);
    assert.deepEqual(store.dumpState(), state);
    assert.deepEqual(store.auditRows(), audit);
    const result = store.expireFlags(200);
    assert.deepEqual(result, [dueLater, dueEarlier], "returned rows retain pre-clear values in id order");
    assert.deepEqual(store.activeFlags(bee.id), [open, future]);
    const clears = store.auditRows().slice(audit.length);
    assert.deepEqual(clears.map(row => row.kind), ["flag.cleared", "flag.cleared"]);
    assert.deepEqual(clears.map(row => {
      const payload = row.payload;
      assert.ok(payload && typeof payload === "object" && "flagId" in payload);
      return payload.flagId;
    }), [dueLater.id, dueEarlier.id]);
    const seq = store.lastAuditSeq();
    assert.deepEqual(store.expireFlags(200), []);
    assert.equal(store.lastAuditSeq(), seq);
    store.close();
    const db = new DatabaseSync(h.path, { readOnly: true });
    try {
      const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM flags WHERE cleared_at IS NULL AND resets_at IS NOT NULL AND resets_at <= ? ORDER BY id").all(200);
      assert.match(plan.map(row => String(row.detail)).join("\n"), /SEARCH flags USING INDEX flags_due/);
      const count = db.prepare("SELECT COUNT(*) AS n FROM flags INDEXED BY flags_due WHERE cleared_at IS NULL AND resets_at IS NOT NULL").get();
      assert.equal(count?.n, 1, "cleared and open-ended rows are excluded");
    } finally { db.close(); }
  } finally { store.close(); h.cleanup(); }
});
