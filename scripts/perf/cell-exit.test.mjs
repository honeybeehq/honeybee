import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ruler = join(root, 'scripts/perf/cell-exit.mjs');

test('cell-exit smoke pairs one root with itself and produces exact deterministic evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-cell-exit-test-'));
  try {
    const out = join(dir, 'report.json');
    const run = spawnSync(process.execPath, [ruler,
      '--before', root, '--after', root, '--out', out,
      '--rounds', '3', '--scale', 'smoke', '--case', 'merge-land,rebase-conflict,refused-checked-out',
    ], { cwd: root, encoding: 'utf8', timeout: 480_000 });
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.completed, true);
    assert.equal(report.failure, null);
    assert.equal(report.sharedModuleIdentity, true, 'same root twice shares module identity');
    assert.deepEqual(report.workload.cases, ['merge-land', 'rebase-conflict', 'refused-checked-out']);
    assert.equal(report.results.length, 3);
    for (const result of report.results) {
      for (const side of [0, 1]) {
        assert.equal(result.raw[side].wallMs.length, 6, 'rounds×2 measured samples per side');
        assert.equal(result.raw[side].cpuMs.length, 6);
      }
      assert.equal(result.order.length, 12);
      assert.deepEqual([...new Set(result.order)].sort(), [0, 1]);
      assert.equal(result.trace2.diagnosticOnly, true);
    }
    const merge = report.results.find(r => r.case === 'merge-land');
    assert.match(merge.setup.landedSha, /^[a-f0-9]{40}$/, 'pinned dates make the landed sha reportable');
    assert.ok(merge.trace2.before.processes >= 5, 'merge capture spawns several git processes');
    assert.ok(merge.trace2.before.commands.fetch >= 1);
    const refusal = report.results.find(r => r.case === 'refused-checked-out');
    assert.equal(refusal.setup.landedSha, null);
    assert.ok(refusal.trace2.before.processes <= 3, 'refusal path stays cheap');
    assert.equal(report.rows.length, 6);
    assert.ok(report.rows.every(row => row.before.n === 6 && row.after.n === 6));
    assert.match(report.environment.gitVersion, /^git version /);
    assert.equal(report.changedSourceFiles.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cell-exit rejects invalid bounds, cases, and missing arguments before any fixture work', () => {
  for (const argv of [
    [],
    ['--before', root, '--after', root, '--out', 'x.json', '--rounds', '2'],
    ['--before', root, '--after', root, '--out', 'x.json', '--scale', 'huge'],
    ['--before', root, '--after', root, '--out', 'x.json', '--case', 'unknown-case'],
  ]) {
    const run = spawnSync(process.execPath, [ruler, ...argv], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /usage:|rounds must|scale must|unknown case/);
  }
});
