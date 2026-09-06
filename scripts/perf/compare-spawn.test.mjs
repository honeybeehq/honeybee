import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareCells, compareHosts } from './compare-spawn.mjs';
import { distribution } from './report.mjs';

const result = values => ({ scenario: 'worker-image-hit', raw: values.map(wallMs => ({ wallMs })), metrics: { wallMs: distribution(values) } });
const report = values => ({ schemaVersion: 1, completed: true, workload: { samples: values.length, mode: 'worker' }, environment: { node: '25', platform: 'darwin', arch: 'arm64', cpu: 'fixture', hostname: 'test' }, toolSha256: 'tool', results: [result(values)] });

test('comparison derives the delta and rejects partial or incompatible Cell captures', () => {
  const before = report([10, 20, 30]), after = report([5, 10, 15]);
  assert.equal(compareCells(before, after)[0].deltaPercent, -50);
  for (const mutate of [r => { r.completed = false; }, r => { r.toolSha256 = 'changed'; }, r => { r.environment.node = '26'; }, r => { r.workload.mode = 'provision'; }, r => { r.results[0].raw.pop(); }, r => { r.results[0].metrics.wallMs.p50 = 1; }]) {
    const invalid = structuredClone(after); mutate(invalid); assert.throws(() => compareCells(before, invalid));
  }
});

test('paired host comparison validates summaries against samples and preserves zero baselines', () => {
  const pair = { schemaVersion: 1, spec: { rounds: 2 }, results: [result([0, 0]), result([1, 2])] };
  assert.equal(compareHosts(pair)[0].deltaPercent, null);
  pair.results[1].raw[0].wallMs = Infinity;
  assert.throws(() => compareHosts(pair), /invalid metric/);
});
