import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareQuiet } from './compare-quiet.mjs';
import { distribution } from './report.mjs';

function pair() {
  const hash = 'a'.repeat(64);
  const before = { schemaVersion: 2, completed: true,
    startedAt: '2026-09-07T01:00:00Z', timestamp: '2026-09-07T01:00:03Z',
    measurement: { startedAt: '2026-09-07T01:00:01Z', finishedAt: '2026-09-07T01:00:02Z' },
    source: { revision: 'a'.repeat(40), status: '', diffSha256: hash,
      hashes: Object.fromEntries(['v2/core/src/store.ts', 'v2/core/src/schema.ts', 'v2/core/src/view.ts',
        'v2/core/src/tasks.ts', 'v2/daemon/src/loops.ts', 'v2/daemon/tests/helpers.ts'].map(file => [file, hash])) },
    toolHashes: Object.fromEntries(['quiet-tick.mjs', 'fixtures.mjs', 'report.mjs', 'boot-identity.mjs'].map(file => [file, hash])),
    workload: { samples: 3, mode: 'none', bees: 1000 },
    environment: { node: 'v24.18.0', platform: 'darwin', arch: 'arm64', cpu: 'Apple M4', logicalCpus: 10,
      hostname: 'Mac.home', bootIdentity: { method: 'darwin-kern.bootsessionuuid-sha256', sha256: hash },
      execArgv: ['--expose-gc'], nodeCompileCache: null, nodeOptionsSha256: hash },
    raw: { wallMs: [1, 2, 3], cpuMs: [0, 0, 0] },
    metrics: { wallMs: distribution([1, 2, 3]), cpuMs: distribution([0, 0, 0]) } };
  const after = structuredClone(before);
  after.startedAt = '2026-09-07T01:00:04Z'; after.timestamp = '2026-09-07T01:00:07Z';
  after.measurement = { startedAt: '2026-09-07T01:00:05Z', finishedAt: '2026-09-07T01:00:06Z' };
  after.source.revision = 'b'.repeat(40);
  after.raw.wallMs = [0.5, 1, 1.5]; after.metrics.wallMs = distribution(after.raw.wallMs);
  return [before, after];
}

test('recomputes quiet timing, preserves zero baselines, and permits measured hostname drift', () => {
  const [before, after] = pair(); after.environment.hostname = 'another-name';
  const result = compareQuiet(before, after);
  assert.equal(result.rows[0].deltaPercent, -50); assert.equal(result.rows[1].deltaPercent, null);
});

test('refuses mixed machines, boots, modes, tools, overlapping captures and incomplete evidence', () => {
  const changes = [
    a => { a.environment.cpu = 'Apple M4 Max'; },
    a => { a.environment.bootIdentity.sha256 = 'b'.repeat(64); },
    a => { a.environment.bootIdentity = null; },
    a => { a.environment.node = 'v25.8.0'; },
    a => { a.workload.mode = 'profile'; },
    a => { a.toolHashes['quiet-tick.mjs'] = 'b'.repeat(64); },
    a => { a.completed = false; },
    a => { a.raw.wallMs.pop(); },
    a => { a.metrics.wallMs.p50 = 0; },
    a => { a.source.hashes['v2/core/src/view.ts'] = ''; },
    a => { a.measurement.startedAt = '2026-09-07T01:00:01Z'; a.startedAt = '2026-09-07T01:00:00Z'; },
    a => { a.startedAt = '2026-09-07T01:00:02Z'; },
    a => { a.timestamp = 'invalid'; },
  ];
  for (const change of changes) {
    const [before, after] = pair(); change(after);
    assert.throws(() => compareQuiet(before, after));
  }
  const [before, after] = pair(); before.workload.mode = after.workload.mode = 'profile';
  assert.throws(() => compareQuiet(before, after), /profiling overhead/);
});

test('enforces the claimed change set and committed source when requested', () => {
  const [before, after] = pair();
  after.source.hashes['v2/daemon/src/loops.ts'] = 'b'.repeat(64);
  assert.deepEqual(compareQuiet(before, after, ['v2/daemon/src/loops.ts']).changedSourceFiles, ['v2/daemon/src/loops.ts']);
  assert.throws(() => compareQuiet(before, after, []), /unexpected source/);
  after.source.status = ' M v2/daemon/src/loops.ts\n';
  assert.throws(() => compareQuiet(before, after, ['v2/daemon/src/loops.ts']), /committed v2 source/);
});
