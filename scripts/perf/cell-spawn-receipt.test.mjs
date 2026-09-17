import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellSpawnReceipt } from './cell-spawn-receipt.mjs';

function fixture() {
  const samples = Array.from({ length: 4 }, (_, i) => ({ round: i - 1, slot: 0, warmup: i === 0, beeId: `bee-${i}`, ok: true, acceptMs: 1, readyMs: 2, usableMs: 3 }));
  return { schemaVersion: 1, environment: { node: 'v24.18.0', platform: 'linux', arch: 'x64', hostname: 'metal', cpu: 'cpu', logicalCpus: 4, totalMemoryBytes: 1024 }, workload: { suite: 'cell-spawn', instrumentation: false, samples: 3, scenarios: [{ cache: 'warm', width: 1, sandbox: true }] }, results: [{ observations: { invariantHolds: true, health: { tickErrors: 0, i1Violations: 0 }, samples }, raw: { 'cell.accept': [1, 1, 1], 'cell.ready': [2, 2, 2], 'cell.usable': [3, 3, 3] } }] };
}
test('receipt excludes warmup and keeps host/cache/sandbox populations distinct', () => {
  const base = cellSpawnReceipt(fixture());
  assert.deepEqual(base.results[0].samples, [1, 1, 1]);
  for (const change of [r => r.environment.hostname = 'netcup', r => r.workload.scenarios[0].sandbox = false]) {
    const r = fixture(); change(r); assert.notEqual(cellSpawnReceipt(r).seriesId, base.seriesId);
  }
});
test('failed, incomplete, corrupt and instrumented captures never become receipts', () => {
  for (const change of [r => r.failure = {}, r => r.workload.instrumentation = true,
    r => r.results[0].observations.samples.pop(), r => r.results[0].observations.samples[2].beeId = 'bee-1',
    r => r.results[0].raw['cell.ready'][0] = 999, r => r.results[0].observations.samples[1].readyMs = 0,
    r => r.results[0].observations.health.i1Violations = 1]) {
    const r = fixture(); change(r); assert.throws(() => cellSpawnReceipt(r));
  }
});
