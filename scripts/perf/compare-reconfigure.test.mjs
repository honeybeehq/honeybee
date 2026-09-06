import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareReconfigure } from './compare-reconfigure.mjs';
const row = value => ({ schemaVersion: 1, completed: true, instrumented: false, revision: 'a', sourceHashes: { store: 'a' }, toolSha256: 'tool', workload: { ownSettledCommands: 100000 }, environment: { node: '25', platform: 'darwin', arch: 'arm64', cpu: 'fixture', hostname: 'host' }, wallMs: value, cpuMs: value, before: { rss: 10, heapUsed: 5 }, after: { rss: 10 + value, heapUsed: 5 + value }, peakBeforeKiB: 10, peakAfterKiB: 10 + value });
test('reconfigure comparison recomputes distributions and converts peak RSS units', () => {
  const result = compareReconfigure([row(10), row(20), row(30)], [row(1), row(2), row(3)]);
  assert.equal(result.comparison[0].deltaPercent, -90);
  assert.equal(result.comparison.find(r => r.metric === 'peakAfterBytes').after.p50, 12 * 1024);
});
test('reconfigure comparison rejects mixed profiling, source, workload, and invalid samples', () => {
  for (const mutate of [r => { r.instrumented = true; }, r => { r.completed = false; }, r => { r.workload.ownSettledCommands = 10; }, r => { r.toolSha256 = 'changed'; }, r => { r.environment.node = '26'; }, r => { r.sourceHashes.store = 'changed'; }, r => { r.wallMs = NaN; }]) {
    const after = [row(1), row(2)]; mutate(after[1]);
    assert.throws(() => compareReconfigure([row(10), row(20)], after));
  }
});
