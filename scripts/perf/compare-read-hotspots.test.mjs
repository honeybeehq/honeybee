import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareReadHotspots } from './compare-read-hotspots.mjs';
import { distribution } from './report.mjs';

function pair() {
  const hashes = files => Object.fromEntries(files.map(f => [f, 'a'.repeat(64)]));
  const before = { schemaVersion: 1, completed: true, failure: null,
    startedAt: '2026-09-07T01:00:00Z', timestamp: '2026-09-07T01:00:03Z',
    measurement: { startedAt: '2026-09-07T01:00:01Z', finishedAt: '2026-09-07T01:00:02Z' },
    source: { revision: 'a'.repeat(40), status: '', diffSha256: 'a'.repeat(64),
      hashes: hashes(['v2/core/src/store.ts', 'v2/core/src/schema.ts', 'v2/core/src/tasks.ts', 'v2/daemon/src/loops.ts', 'v2/daemon/tests/helpers.ts']) },
    toolHashes: hashes(['read-hotspots.mjs', 'sql-trace.mjs', 'report.mjs', 'boot-identity.mjs']),
    environment: { node: 'v24.18.0', platform: 'darwin', arch: 'arm64', cpu: 'Apple M4', hostname: 'Mac.home',
      logicalCpus: 10, execArgv: ['--expose-gc'], nodeCompileCache: null, nodeOptionsSha256: 'a'.repeat(64),
      bootIdentity: { method: 'darwin-kern.bootsessionuuid-sha256', sha256: 'a'.repeat(64) } },
    workload: { samples: 3, timingInstrumentation: 'none', scenarios: [{ id: 'fixture' }] },
    results: [{ scenario: 'fixture', completed: true, failure: null,
      measurement: { startedAt: '2026-09-07T01:00:01Z', finishedAt: '2026-09-07T01:00:02Z' },
      raw: { wallMs: [1, 2, 3], cpuMs: [1, 2, 3] },
      metrics: { 'operation.wall': { unit: 'ms', ...distribution([1, 2, 3]) }, 'operation.cpu': { unit: 'ms', ...distribution([1, 2, 3]) } } }] };
  const after = structuredClone(before);
  after.startedAt = '2026-09-07T01:01:00Z'; after.timestamp = '2026-09-07T01:01:03Z';
  after.measurement = { startedAt: '2026-09-07T01:01:01Z', finishedAt: '2026-09-07T01:01:02Z' };
  after.results[0].measurement = { ...after.measurement };
  return [before, after];
}

test('read-hotspot comparison accepts a verified control and explicit source delta', () => {
  const [b, a] = pair();
  assert.ok(compareReadHotspots(b, a, []).rows.every(r => r.deltaPercent === 0));
  a.source.hashes['v2/core/src/store.ts'] = 'b'.repeat(64);
  assert.deepEqual(compareReadHotspots(b, a, ['v2/core/src/store.ts']).changedSourceFiles, ['v2/core/src/store.ts']);
});

test('read-hotspot comparison rejects incomplete, contaminated, mismatched, and forged captures', () => {
  for (const change of [
    a => { a.completed = false; }, a => { a.failure = {}; },
    a => { a.results[0].completed = false; }, a => { a.results[0].failure = {}; },
    a => { a.toolHashes['read-hotspots.mjs'] = 'b'.repeat(64); },
    a => { a.environment.bootIdentity.sha256 = 'b'.repeat(64); },
    a => { a.environment.execArgv = []; }, a => { a.environment.cpu = 'Apple M4 Max'; },
    a => { a.source.status = ' M v2/core/src/store.ts'; },
    a => { a.source.hashes['v2/core/src/store.ts'] = 'b'.repeat(64); },
    a => { a.startedAt = '2026-09-07T01:00:00Z'; },
    a => { a.results[0].raw.wallMs[0] = 100; },
    a => { a.results[0].raw.cpuMs.pop(); },
    a => { a.results[0].scenario = 'unexpected'; },
    a => { a.workload.timingInstrumentation = 'sql-trace'; },
  ]) {
    const [b, a] = pair(); change(a); assert.throws(() => compareReadHotspots(b, a, []));
  }
});
