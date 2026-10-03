import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, capture, addHandoff } from './fleet-handoff.mjs';
import { openCoreStore, replayAudit } from '../../v2/core/src/index.ts';

test('fleet handoff projection preserves ties, filters, fresh failures, rollback, delete and reopen', () => {
  const f = fixture(8, 8);
  let store = f.store;
  const verify = () => {
    for (const lifecycle of [null, 'active', 'archived', 'unknown']) {
      const s = capture(store, lifecycle);
      assert.equal(s.excessHandoffRows, 0);
    }
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  };
  try {
    verify();
    const row = store.listBeeViewRows()[0];
    assert.equal(row.handoff.instruction, 'request 7');
    f.setTime(2000000);
    const newest = addHandoff(store, 'bee-000', 90);
    f.setTime(1500000);
    addHandoff(store, 'bee-000', 91);
    assert.equal(store.listBeeViewRows()[0].handoff.id, newest.id);
    verify();
    f.setTime(3000000);
    assert.throws(() => store.transact(() => {
      addHandoff(store, 'bee-000', 92);
      assert.equal(store.listBeeViewRows()[0].handoff.instruction, 'request 92');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.listBeeViewRows()[0].handoff.id, newest.id);
    store.unarchiveBee('bee-001');
    store.archiveBee('bee-000');
    verify();
    store.deleteBee('bee-000');
    verify();
    store.close();
    store = openCoreStore(f.path, f.options);
    verify();
  } finally { store.close(); f.cleanup(); }
});

test('handoff list seeks the existing index without sorting retained history', () => {
  const f = fixture(1, 64);
  const original = f.store.stmt;
  let sql;
  f.store.stmt = function(query) { if (query.includes('SELECT handoff.*')) sql = query; return original.call(this, query); };
  try {
    capture(f.store, null);
    assert.ok(sql);
    const plan = original.call(f.store, `EXPLAIN QUERY PLAN ${sql}`).all(null, null).map(r => r.detail).join('\n');
    assert.match(plan, /SEARCH latest USING COVERING INDEX bee_handoffs_bee/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  } finally { f.store.close(); f.cleanup(); }
});
