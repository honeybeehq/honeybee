import assert from 'node:assert/strict';

export function distribution(samples) {
  assert.ok(samples.length > 0 && samples.every(Number.isFinite), 'finite nonempty samples required');
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.ceil(p * sorted.length) - 1];
  return { n: samples.length, min: sorted[0], p50: percentile(.5), p95: percentile(.95), max: sorted.at(-1), mean: samples.reduce((a, b) => a + b, 0) / samples.length };
}

export function compareReports(before, after) {
  assert.equal(before.schemaVersion, 1, 'unsupported baseline schema');
  assert.equal(after.schemaVersion, 1, 'unsupported candidate schema');
  assert.deepEqual(after.workload, before.workload, 'workload mismatch');
  for (const report of [before, after]) assert.equal(report.results.length, report.workload.scenarios.length, 'incomplete capture');
  for (const key of ['node', 'platform', 'arch', 'cpu', 'hostname']) assert.equal(after.environment[key], before.environment[key], `environment mismatch: ${key}`);
  assert.deepEqual(after.results.map(r => r.scenario), before.results.map(r => r.scenario), 'scenario mismatch');
  return before.results.flatMap((b, i) => {
    const a = after.results[i];
    assert.deepEqual(Object.keys(a.metrics), Object.keys(b.metrics), 'metric mismatch');
    return Object.entries(b.metrics).map(([metric, base]) => {
      const next = a.metrics[metric];
      assert.equal(next.unit, base.unit, 'unit mismatch');
      for (const value of [base, next]) {
        assert.ok(Number.isSafeInteger(value.n) && value.n > 0, 'invalid sample count');
        for (const key of ['min', 'p50', 'p95', 'max', 'mean']) assert.ok(Number.isFinite(value[key]) && value[key] >= 0, `invalid metric ${key}`);
        assert.ok(value.min <= value.p50 && value.p50 <= value.p95 && value.p95 <= value.max, 'invalid percentile ordering');
      }
      return { scenario: b.scenario, metric, unit: base.unit, before: base.p50, after: next.p50, deltaPercent: base.p50 === 0 ? null : (next.p50 / base.p50 - 1) * 100, beforeP95: base.p95, afterP95: next.p95, n: next.n };
    });
  });
}
