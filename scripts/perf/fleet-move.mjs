import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { openCoreStore, replayAudit } from '../../v2/core/src/index.ts';
import { harness } from '../../v2/core/tests/helpers.ts';
import { toBeeMoveView } from '../../v2/core/src/cellMove.ts';
import { toBeeHandoffView } from '../../v2/core/src/handoff.ts';

export function addMove(store, id, ordinal) {
  const bee = store.getBee(id);
  const move = store.admitBeeMove({ beeId: id, idempotencyKey: `${id}:${ordinal}`, requestHash: `${id}:${ordinal}`,
    expected: { placementVersion: bee.placementVersion, cellId: bee.cellId }, destinationCwd: `/fixture/dest-${ordinal}` });
  store.failBeeMove(move.id, { code: 'fixture', stage: 'stopping', detail: `failure ${ordinal}` });
  return move;
}

export function fixture(bees, history) {
  const h = harness();
  let random = 1, time = 1000000;
  const options = { ephemeral: true, now: () => time,
    random: () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 4294967296) };
  const store = openCoreStore(h.path, options);
  let uuid = 0;
  const uuidMock = mock.method(crypto, 'randomUUID', () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`);
  syncBuiltinESMExports();
  try { store.transact(() => {
    for (let i = 0; i < bees; i++) {
      const id = `bee-${String(i).padStart(3, '0')}`;
      store.createBee({ id, name: id, agent: 'claude', substrate: 'cell', cwd: '/fixture' });
      store.updateRuntimeState(id, 1, 'stopped', { exitCause: 'clean' });
      store.putCell({ id: `${id}-cell`, sourceBeeId: id, originRepo: '/fixture/origin', sha: 'head',
        wrapper: 'wrapper', spaceName: id, spaceDir: `/fixture/${id}`, gitCommonDirRealpath: '/fixture/origin/.git', objectFormat: 'sha1' });
      for (let n = 0; n < history; n++) addMove(store, id, n);
      if (i % 2) store.archiveBee(id);
    }
  }); } catch (error) { store.close(); h.cleanup(); throw error; }
  finally { uuidMock.mock.restore(); syncBuiltinESMExports(); }
  return { store, path: h.path, options, setTime: value => { time = value; }, cleanup: () => h.cleanup() };
}

export function capture(store, lifecycle) {
  const original = store.stmt;
  const seq = store.lastAuditSeq();
  let moveMappings = 0, moveRows = 0, statements = 0;
  store.stmt = function (sql) {
    const statement = original.call(this, sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (['all', 'get', 'run'].includes(key)) statements++;
        const result = value.apply(target, args);
        if (key !== 'all' || !/\bFROM bee_moves\b/i.test(sql)) return result;
        moveRows += result.length;
        return result.map(row => new Proxy(row, { get(raw, property, receiver) {
          if (property === 'placement_version') moveMappings++;
          return Reflect.get(raw, property, receiver);
        } }));
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
  const selectedMoves = output.filter(row => row.move !== null).length;
  return { lifecycle, moveMappings, moveRows, selectedMoves, statements, excessMoveMappings: moveMappings - selectedMoves,
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
  const paths = ['v2/core/src/store.ts', 'v2/core/src/cellMove.ts', 'scripts/perf/fleet-move.mjs', 'v2/core/tests/helpers.ts'];
  return { workload: 'fleet-move-projection', seriesId: 'fleet-move-v1', capturedAt: new Date().toISOString(),
    machine: hostname(), runtime: process.version, sourceHashes: Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])),
    complete: true, samples, results: [{ metric: 'excessMoveMappings', samples: samples.map(s => s.excessMoveMappings), invariantHolds: samples.every(s => s.excessMoveMappings === 0) }] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  assert.ok(process.argv.includes('--out') && out);
  const result = collect();
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ samples: result.samples.length, maxMappings: Math.max(...result.samples.map(s => s.moveMappings)), maxExcess: Math.max(...result.samples.map(s => s.excessMoveMappings)) }));
}
