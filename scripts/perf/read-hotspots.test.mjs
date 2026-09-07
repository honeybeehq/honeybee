import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { compareReports } from './report.mjs';
import { buildScenarioPlan, parseArgs } from './read-hotspots.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('read-hotspots CLI parsing keeps smoke cheap and rejects unknown input', () => {
  const defaults = { root, out: join(root, '.artifacts/performance/read-hotspots-smoke.json') };
  assert.deepEqual(parseArgs([], defaults), {
    root,
    out: defaults.out,
    samples: 5,
    scale: 'smoke',
    cases: [],
    help: false,
    list: false,
  });
  assert.deepEqual(parseArgs(['--samples', '3', '--case', 'D05,c09-held-idle'], defaults).cases, [
    'd05',
    'c09-held-idle',
  ]);
  assert.throws(() => parseArgs(['--wat'], defaults), /unknown option: --wat/);
  assert.throws(() => parseArgs(['--samples', '2'], defaults), /samples must be 3..1000/);
});

test('canonical plan names every requested read hotspot and exact large history sizes', () => {
  const plan = buildScenarioPlan('canonical', 5, 3);
  const byInventory = id => plan.filter(scenario => scenario.inventoryId === id);
  assert.deepEqual(byInventory('D05').filter(s => s.kind === 'boot-recovery').map(s => s.fixture.settledCommands), [
    0,
    1_000,
    100_000,
  ]);
  assert.deepEqual(byInventory('D05').filter(s => s.kind === 'pending-stop').map(s => s.fixture.settledCommands), [
    0,
    1_000,
    100_000,
  ]);
  assert.equal(byInventory('C07')[0]?.fixture.clearedFlags, 100_000);
  assert.deepEqual(new Set(byInventory('C09').map(s => s.fixture.bodyBytes)), new Set([64, 1024 * 1024]));
  assert.ok(byInventory('C10').some(s => s.kind === 'sparse' && s.fixture.totalMessages === 100_020));
  assert.ok(byInventory('C22').some(s => s.kind === 'enabled-empty' && s.fixture.supplies === 1_000));
  assert.deepEqual(byInventory('C25')[0]?.fixture, { unrelatedAuditRows: 1_000_000, targetAuditRows: 20 });
  assert.deepEqual(byInventory('C18').map(s => s.kind), ['rpc-hit', 'rpc-insert', 'rpc-eviction']);
});

test('one real smoke case writes a complete report with raw timing and separate SQL diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-read-hotspots-test-'));
  try {
    const out = join(dir, 'report.json');
    const run = spawnSync(process.execPath, [
      join(root, 'scripts/perf/read-hotspots.mjs'),
      '--root', root,
      '--out', out,
      '--samples', '3',
      '--scale', 'smoke',
      '--case', 'c18-rpc-hit',
    ], { cwd: root, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.completed, true);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].scenario.startsWith('c18-rpc-hit-'), true);
    assert.equal(report.results[0].raw.wallMs.length, 3);
    assert.equal(report.results[0].raw.cpuMs.length, 3);
    assert.ok(report.results[0].sqlDiagnostic.statements.some(row =>
      row.sql === 'SELECT * FROM rpc_idempotency WHERE key = ?' && row.kind === 'get'));
    assert.equal(Object.hasOwn(report.results[0].sqlDiagnostic, 'value'), false);
    assert.doesNotThrow(() => compareReports(report, report));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
