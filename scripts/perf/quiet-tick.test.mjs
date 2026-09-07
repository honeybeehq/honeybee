import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readQuietProfiles } from './compare-quiet.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
test('quiet profiling keeps held mail and authority unchanged and produces hashed profiles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-quiet-test-'));
  try {
    const out = join(dir, 'profile.json');
    const run = spawnSync(process.execPath, ['--expose-gc', 'scripts/perf/quiet-tick.mjs',
      '--root', root, '--out', out, '--bees', '3', '--generations', '1', '--live', '1',
      '--pending', '4', '--body-bytes', '65536', '--samples', '3', '--mode', 'profile'],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.completed, true);
    assert.equal(report.workload.liveRuntimes, 1);
    assert.equal(report.workload.seedLifecycleRule, 'every tenth Bee active; remainder archived; revival activates live targets');
    assert.equal(report.workload.pendingMessages, 4);
    assert.equal(report.workload.bodyBytes, 65536);
    assert.equal(report.raw.cpuMs.length, 3);
    assert.ok(Number.isSafeInteger(report.auditSeq));
    assert.ok(readQuietProfiles(report, out).sampledAllocationBytes >= 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quiet profiler rejects invalid and unbounded held-mail fixtures before setup', () => {
  for (const args of [
    ['--bees', '0', '--live', '1'], ['--pending', '1', '--live', '0'],
    ['--bees', '1', '--live', '1', '--pending', '1000', '--body-bytes', '1048576'],
  ]) {
    const run = spawnSync(process.execPath, ['--expose-gc', 'scripts/perf/quiet-tick.mjs', ...args],
      { cwd: root, encoding: 'utf8', timeout: 30000 });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /live must|requires a live target|body budget/);
  }
});
