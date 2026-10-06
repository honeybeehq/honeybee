import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openCoreStore, replayAudit } from '../../v2/core/src/index.ts';
import { harness } from '../../v2/core/tests/helpers.ts';
import { toBeeMoveView } from '../../v2/core/src/cellMove.ts';
import { toBeeHandoffView } from '../../v2/core/src/handoff.ts';

export function addCell(store, beeId, ordinal) {
  return store.putCell({ id: `${beeId}-cell-${ordinal}`, sourceBeeId: beeId,
    originRepo: '/fixture/origin', sha: `head-${ordinal}`, wrapper: `wrapper-${ordinal}`,
    spaceName: `space-${ordinal}`, spaceDir: `/fixture/${beeId}/${ordinal}`,
    gitCommonDirRealpath: '/fixture/origin/.git', objectFormat: 'sha1',
    sandbox: ordinal % 3 === 0 ? null : ordinal % 3 === 1 });
}

export function fixture(bees, history) {
  const h = harness();
  const path = h.path;
  let random = 1;
  const options = { ephemeral: true, now: () => 1000000,
    random: () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 4294967296) };
  const store = openCoreStore(path, options);
  try { store.transact(() => {
    for (let i = 0; i < bees; i++) {
      const id = `bee-${String(i).padStart(3, '0')}`;
      store.createBee({ id, name: id, agent: 'claude', substrate: 'cell', cwd: '/fixture' });
      store.updateRuntimeState(id, 1, 'stopped', { exitCause: 'clean' });
      for (let n = 0; n < history; n++) {
        const cell = addCell(store, id, n);
        if (n < history - 1) store.retainCell(cell.id);
        else if (i % 4 === 2) store.evictCell(cell.id, { head: 'saved', bytes: 100, reason: 'fixture' });
      }
      if (i % 2 === 1) store.archiveBee(id);
    }
  }); } catch (error) { store.close(); h.cleanup(); throw error; }
  return { store, path, options, cleanup: () => h.cleanup() };
}

export function capture(store, lifecycle) {
  const original = store.stmt;
  const seq = store.lastAuditSeq();
  let cellRows = 0, statements = 0;
  store.stmt = function (sql) {
    const statement = original.call(this, sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (['all', 'get', 'run'].includes(key)) statements++;
        const result = value.apply(target, args);
        if (key === 'all' && /\bFROM cells\b/i.test(sql)) cellRows += result.length;
        return result;
      };
    } });
  };
  let output;
  try { output = store.listBeeViewRows(lifecycle); }
  finally { store.stmt = original; }
  const expected = store.listBees().filter(b => lifecycle === null || b.lifecycle === lifecycle).map(bee => {
    const move = store.latestMoveOf(bee.id), handoff = store.latestHandoffOf(bee.id);
    return { bee, runtime: store.currentRuntime(bee.id), view: store.view(bee.id),
      move: move ? toBeeMoveView(move) : null, cell: bee.cellId ? store.getCell(bee.cellId) : null,
      handoff: handoff ? toBeeHandoffView(handoff) : null };
  });
  assert.deepEqual(output, expected);
  assert.equal(store.lastAuditSeq(), seq);
  const selectedCells = new Set(output.flatMap(row => row.cell ? [row.cell.id] : [])).size;
  return { lifecycle, cellRows, selectedCells, statements, excessCellRows: cellRows - selectedCells,
    output, outputSha256: createHash('sha256').update(JSON.stringify(output)).digest('hex') };
}

export function collect() {
  const samples = [];
  for (const bees of [1, 8, 64]) for (const history of [0, 1, 8, 64]) {
    const f = fixture(bees, history);
    try {
      for (const lifecycle of [null, 'active', 'archived', 'unknown']) samples.push({ bees, history, ...capture(f.store, lifecycle) });
      assert.deepEqual(replayAudit(f.store.auditRows()), f.store.dumpState());
    } finally { f.store.close(); f.cleanup(); }
  }
  const paths = ['v2/core/src/store.ts', 'v2/core/src/schema.ts', 'scripts/perf/fleet-cell.mjs', 'v2/core/tests/helpers.ts'];
  return { workload: 'fleet-cell-projection', seriesId: 'fleet-cell-v1', capturedAt: new Date().toISOString(),
    machine: hostname(), runtime: process.version, sourceHashes: Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])),
    complete: true, samples, results: [{ metric: 'excessCellRows', samples: samples.map(s => s.excessCellRows), invariantHolds: samples.every(s => s.excessCellRows === 0) }] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  assert.ok(process.argv.includes('--out') && out);
  const result = collect();
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ samples: result.samples.length, maxRows: Math.max(...result.samples.map(s => s.cellRows)), maxExcess: Math.max(...result.samples.map(s => s.excessCellRows)) }));
}
