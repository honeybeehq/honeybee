import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openCoreStore, replayAudit } from '../../v2/core/src/index.ts';
import { toBeeHandoffView } from '../../v2/core/src/handoff.ts';

export function fixture(bees, history) {
  const dir = mkdtempSync(join(tmpdir(), 'speedy-fleet-handoff-'));
  const path = join(dir, 'fixture.sqlite');
  let random = 1, time = 1000000;
  const options = { ephemeral: true, now: () => time, random: () => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 4294967296) };
  const store = openCoreStore(path, options);
  try { store.transact(() => {
    for (let i = 0; i < bees; i++) {
      const id = `bee-${String(i).padStart(3, '0')}`;
      store.createBee({ id, name: id, agent: 'claude', substrate: 'hsr', cwd: '/tmp/fixture', args: ['source'] });
      store.updateRuntimeState(id, 1, 'stopped', { exitCause: 'clean' });
      for (let n = 0; n < history; n++) addHandoff(store, id, n);
      if (i % 2 === 1) store.archiveBee(id);
    }
  });
  } catch (error) { store.close(); execFileSync('trash', [dir]); throw error; }
  return { store, path, options, setTime: value => { time = value; }, cleanup: () => execFileSync('trash', [dir]) };
}

export function addHandoff(store, id, n) {
  const handoff = store.admitBeeHandoff({ beeId: id, idempotencyKey: `${id}:${n}`, requestHash: `${id}:${n}`,
    expected: { generation: 1 }, target: { agent: 'codex', args: ['target', String(n)], account: null, env: { HIVE_FIXTURE: String(n) } },
    instruction: `request ${n}`, stopAt: 'now' });
  store.failBeeHandoff(handoff.id, { stage: 'validate', code: 'fixture', detail: `failure ${n}` });
  return handoff;
}

export function capture(store, lifecycle) {
  const original = store.stmt;
  let handoffRows = 0, statements = 0;
  store.stmt = function (sql) {
    const statement = original.call(this, sql);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (['all', 'get', 'run'].includes(key)) statements++;
        const result = value.apply(target, args);
        if (key === 'all' && sql.includes('bee_handoffs')) handoffRows += result.length;
        return result;
      };
    } });
  };
  let output;
  const seq = store.lastAuditSeq();
  try { output = store.listBeeViewRows(lifecycle); }
  finally { store.stmt = original; }
  const expected = store.listBees().filter(b => lifecycle === null || b.lifecycle === lifecycle).map(bee => {
    const h = store.latestHandoffOf(bee.id);
    return { bee, runtime: store.currentRuntime(bee.id), view: store.view(bee.id), move: null, cell: null, handoff: h ? toBeeHandoffView(h) : null };
  });
  assert.deepEqual(output, expected);
  assert.equal(store.lastAuditSeq(), seq);
  return { lifecycle, handoffRows, selectedHandoffs: output.filter(r => r.handoff !== null).length, statements,
    excessHandoffRows: handoffRows - output.filter(r => r.handoff !== null).length,
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
  const paths = ['v2/core/src/store.ts','v2/core/src/schema.ts','v2/core/src/handoff.ts','scripts/perf/fleet-handoff.mjs'];
  return { workload: 'fleet-handoff-projection', seriesId: 'fleet-handoff-v1', capturedAt: new Date().toISOString(),
    machine: hostname(), runtime: process.version, sourceHashes: Object.fromEntries(paths.map(p => [p, createHash('sha256').update(readFileSync(p)).digest('hex')])),
    complete: true, samples, results: [{ metric: 'excessHandoffRows', samples: samples.map(s => s.excessHandoffRows), invariantHolds: samples.every(s => s.excessHandoffRows === 0) }] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  assert.ok(process.argv.includes('--out') && out);
  const result = collect(); writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ samples: result.samples.length, maxRows: Math.max(...result.samples.map(s => s.handoffRows)), maxExcess: Math.max(...result.samples.map(s => s.excessHandoffRows)) }));
}
