import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Never promote a timeout, partial batch, or provider/host/cache change to a baseline.
export function cellSpawnReceipt(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.failure, undefined, 'failed capture');
  assert.equal(report.workload.suite, 'cell-spawn');
  assert.equal(report.workload.instrumentation, false, 'profiles are attribution only');
  assert.equal(report.results.length, 1);
  const scenario = report.workload.scenarios[0];
  assert.equal(report.workload.scenarios.length, 1);
  assert.ok(['warm', 'cold'].includes(scenario.cache));
  assert.ok([1, 4].includes(scenario.width));
  assert.equal(typeof scenario.sandbox, 'boolean');
  const count = report.workload.samples;
  assert.ok(Number.isSafeInteger(count) && count >= 3);
  const result = report.results[0];
  assert.equal(result.observations.invariantHolds, true);
  assert.equal(result.observations.health.tickErrors, 0);
  assert.equal(result.observations.health.i1Violations, 0);
  const all = result.observations.samples;
  assert.equal(all.length, (count + (scenario.cache === 'warm' ? 1 : 0)) * scenario.width);
  const rows = all.filter(row => !row.warmup);
  assert.equal(rows.length, count * scenario.width);
  assert.equal(new Set(all.map(row => row.beeId)).size, all.length, 'duplicate bee');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    assert.equal(row.round, Math.floor(i / scenario.width));
    assert.equal(row.slot, i % scenario.width);
  }
  for (const row of all) {
    assert.equal(row.ok, true); assert.equal(row.error, undefined);
    for (const name of ['acceptMs', 'readyMs', 'usableMs']) assert.ok(Number.isFinite(row[name]) && row[name] >= 0);
    assert.ok(row.acceptMs <= row.readyMs && row.readyMs <= row.usableMs);
  }
  const environment = Object.fromEntries(['node', 'platform', 'arch', 'hostname', 'cpu', 'logicalCpus', 'totalMemoryBytes'].map(k => {
    assert.ok(report.environment[k] !== undefined, `missing environment ${k}`);
    return [k, report.environment[k]];
  }));
  const seriesId = createHash('sha256').update(JSON.stringify({ environment, workload: report.workload })).digest('hex');
  return {
    workload: 'remote-cell-spawn', seriesId,
    results: [['cell.accept', 'acceptMs'], ['cell.ready', 'readyMs'], ['cell.usable', 'usableMs']].map(([metric, key]) => {
      const samples = rows.map(row => row[key]);
      assert.deepEqual(result.raw[metric], samples, 'raw/row mismatch');
      return { metric, samples, invariantHolds: true };
    }),
  };
}
