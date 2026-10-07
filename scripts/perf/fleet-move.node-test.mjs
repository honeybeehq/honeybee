import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, capture, addMove } from './fleet-move.mjs';
import { openCoreStore, replayAudit } from '../../v2/core/src/index.ts';

test('fleet move mapping preserves tied time, older inserts, freshness, rollback, deletion and reopen', () => {
  const f = fixture(8, 8);
  let store = f.store;
  const verify = () => {
    for (const lifecycle of [null, 'active', 'archived', 'unknown']) assert.equal(capture(store, lifecycle).excessMoveMappings, 0);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  };
  try {
    verify();
    assert.equal(store.listBeeViewRows()[0].move.failure.detail, 'failure 7');
    f.setTime(2000000);
    const newest = addMove(store, 'bee-000', 90);
    f.setTime(1500000);
    addMove(store, 'bee-000', 91);
    assert.equal(store.listBeeViewRows()[0].move.id, newest.id);
    verify();
    f.setTime(3000000);
    assert.throws(() => store.transact(() => {
      addMove(store, 'bee-000', 92);
      assert.equal(store.listBeeViewRows()[0].move.failure.detail, 'failure 92');
      throw new Error('rollback');
    }), /rollback/);
    assert.equal(store.listBeeViewRows()[0].move.id, newest.id);
    const bee = store.getBee('bee-000');
    const active = store.admitBeeMove({ beeId: bee.id, idempotencyKey: 'active', requestHash: 'active',
      expected: { placementVersion: bee.placementVersion, cellId: bee.cellId }, destinationCwd: '/fixture/active' });
    verify();
    store.setBeeMovePhase(active.id, 'placing');
    verify();
    store.failBeeMove(active.id, { stage: 'placing', code: 'fixture', detail: 'late failure' });
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

test('move mapping scales with selected latest rows while SQL still returns retained history', () => {
  for (const history of [0, 1, 8, 64]) {
    const f = fixture(8, history);
    try {
      for (const lifecycle of [null, 'active', 'archived', 'unknown']) {
        const s = capture(f.store, lifecycle);
        assert.equal(s.moveMappings, history === 0 || lifecycle === 'unknown' ? 0 : lifecycle === null ? 8 : 4);
        assert.equal(s.moveRows, lifecycle === 'unknown' ? 0 : 8 * history);
      }
    } finally { f.store.close(); f.cleanup(); }
  }
});

test('selected latest corruption still fails; obsolete and unselected corruption is not mapped', () => {
  const f = fixture(2, 2);
  try {
    const old = f.store.listBeeMoves().find(m => m.beeId === 'bee-000' && m.failure.detail === 'failure 0');
    const latest = f.store.latestMoveOf('bee-000');
    const archived = f.store.latestMoveOf('bee-001');
    f.store.db.prepare('UPDATE bee_moves SET failure_json = ? WHERE id IN (?, ?)').run('{', old.id, archived.id);
    assert.equal(f.store.listBeeViewRows('active')[0].move.id, latest.id);
    assert.throws(() => f.store.listBeeMoves(), SyntaxError);
    assert.throws(() => f.store.listBeeViewRows(), SyntaxError);
    f.store.db.prepare('UPDATE bee_moves SET failure_json = ? WHERE id = ?').run('{', latest.id);
    assert.throws(() => f.store.listBeeViewRows('active'), SyntaxError);
  } finally { f.store.close(); f.cleanup(); }
});
