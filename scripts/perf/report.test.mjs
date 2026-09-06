import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distribution, compareReports } from './report.mjs';

test('nearest-rank percentiles preserve raw samples and reject invalid observations', () => {
  const samples = [4, 1, 3, 2];
  assert.deepEqual(distribution(samples), { n: 4, min: 1, p50: 2, p95: 4, max: 4, mean: 2.5 });
  assert.deepEqual(samples, [4, 1, 3, 2]);
  assert.throws(() => distribution([]));
  assert.throws(() => distribution([NaN]));
});

const report = () => ({ schemaVersion: 1, workload: { samples: 3, scenarios: ['idle'] }, environment: { node: '24', platform: 'darwin', arch: 'arm64', cpu: 'test', hostname: 'test' }, results: [{ scenario: 'idle', metrics: { wall: { unit: 'ms', ...distribution([2, 4, 6]) } } }] });
test('comparison computes changes and refuses incompatible evidence', () => {
  const b = report(), a = report();
  a.results[0].metrics.wall = { unit: 'ms', ...distribution([1, 2, 3]) };
  assert.equal(compareReports(b, a)[0].deltaPercent, -50);
  for (const mutate of [r => r.workload.samples++, r => r.environment.node = '25', r => r.results[0].scenario = 'busy', r => r.results[0].metrics.wall.unit = 'bytes', r => r.results[0].metrics.extra = {}, r => r.schemaVersion++]) {
    const bad = report(); mutate(bad); assert.throws(() => compareReports(b, bad));
  }
  b.results[0].metrics.wall = { unit: 'ms', ...distribution([0, 0, 0]) };
  assert.equal(compareReports(b, a)[0].deltaPercent, null);
});


test('comparison rejects missing, nonnumeric and nonfinite metric evidence', () => {
  for (const key of ['min', 'p50', 'p95', 'max', 'mean', 'n']) {
    for (const value of [undefined, NaN, Infinity, '2', -1]) {
      const bad = report(); bad.results[0].metrics.wall[key] = value;
      assert.throws(() => compareReports(report(), bad));
    }
  }
});


test('matching partial reports cannot pass as a complete comparison', () => {
  const before = report(), after = report();
  before.results = []; after.results = [];
  assert.throws(() => compareReports(before, after), /incomplete capture/);
});
