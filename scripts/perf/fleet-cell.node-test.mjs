import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCell, capture, fixture } from './fleet-cell.mjs';
import { openCoreStore, replayAudit } from '../../v2/core/src/index.ts';

test('fleet Cell projection follows replacement, retention, eviction, removal, rollback, deletion and reopen', () => {
  const f = fixture(8, 8);
  let store = f.store;
  const verify = () => {
    for (const lifecycle of [null, 'active', 'archived', 'deleted', 'unknown']) {
      assert.equal(capture(store, lifecycle).excessCellRows, 0);
    }
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  };
  try {
    verify();
    store.retainCell('bee-000-cell-7');
    assert.equal(store.listBeeViewRows()[0].cell.state, 'retained');
    verify();
    const replacement = addCell(store, 'bee-000', 90);
    assert.equal(store.listBeeViewRows()[0].cell.id, replacement.id);
    store.markCellRemoved('bee-000-cell-7');
    assert.equal(store.listBeeViewRows()[0].cell.id, replacement.id);
    store.evictCell(replacement.id, { head: 'new-head', bytes: 500, reason: 'fixture' });
    assert.equal(store.listBeeViewRows()[0].cell.evictedHead, 'new-head');
    verify();
    store.reactivateCell(replacement.id);
    assert.equal(store.listBeeViewRows()[0].cell.state, 'active');
    assert.throws(() => store.transact(() => {
      addCell(store, 'bee-000', 91);
      assert.equal(store.listBeeViewRows()[0].cell.id, 'bee-000-cell-91');
      verify();
      throw new Error('rollback probe');
    }), /rollback probe/);
    assert.equal(store.listBeeViewRows()[0].cell.id, replacement.id);
    store.markCellRemoved(replacement.id);
    assert.equal(store.listBeeViewRows()[0].cell, null);
    store.archiveBee('bee-000');
    store.unarchiveBee('bee-001');
    verify();
    store.deleteBee('bee-001');
    verify();
    store.close();
    store = openCoreStore(f.path, f.options);
    verify();
  } finally { store.close(); f.cleanup(); }
});

test('fleet Cell query seeks the existing primary key, independent of retained history', () => {
  const f = fixture(8, 64);
  const original = f.store.stmt;
  let sql;
  f.store.stmt = function(query) {
    if (/\bFROM cells WHERE id IN\b/i.test(query)) sql = query;
    return original.call(this, query);
  };
  try {
    assert.equal(capture(f.store, 'active').cellRows, 4);
    assert.ok(sql);
    for (const lifecycle of [null, 'active', 'archived', 'unknown']) {
      const plan = original.call(f.store, `EXPLAIN QUERY PLAN ${sql}`).all(lifecycle, lifecycle).map(row => row.detail).join('\n');
      assert.match(plan, /SEARCH cells USING INDEX sqlite_autoindex_cells_1/);
      assert.doesNotMatch(plan, /SCAN cells/);
    }
  } finally { f.store.close(); f.cleanup(); }
});

test('fleet Cells preserve null, missing, empty and shared references without duplicate row hydration', () => {
  const f = fixture(8, 1);
  try {
    f.store.stmt("UPDATE bees SET cell_id = NULL WHERE id = 'bee-000'").run();
    f.store.stmt("UPDATE bees SET cell_id = 'missing' WHERE id = 'bee-001'").run();
    f.store.stmt("UPDATE cells SET id = '' WHERE id = 'bee-002-cell-0'").run();
    f.store.stmt("UPDATE bees SET cell_id = '' WHERE id = 'bee-002'").run();
    f.store.stmt("UPDATE bees SET cell_id = 'bee-003-cell-0' WHERE id = 'bee-004'").run();
    for (const lifecycle of [null, 'active', 'archived', 'unknown']) {
      assert.equal(capture(f.store, lifecycle).excessCellRows, 0);
    }
    assert.equal(f.store.listCells().length, 8);
  } finally { f.store.close(); f.cleanup(); }
});
