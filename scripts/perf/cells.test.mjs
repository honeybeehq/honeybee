import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

async function run(script, args) {
  const child = spawn(process.execPath, [resolve(script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0, output);
  } finally { clearTimeout(timer); }
}

for (const [name, script, flags] of [
  ['individual worker', 'scripts/perf/cells.mjs', ['--mode', 'worker']],
  ['worker cohort', 'scripts/perf/cell-cohort.mjs', ['--width', '1']],
]) {
  test(`${name}: repeated captures replace Git evidence instead of adding old commands`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-cell-capture-test-'));
    const out = join(dir, 'result.json');
    try {
      let count;
      for (let i = 0; i < 2; i++) {
        await run(script, ['--root', resolve('.'), '--out', out, '--samples', '1', '--hold-ms', '100', ...flags]);
        const report = JSON.parse(readFileSync(out, 'utf8'));
        assert.equal(report.completed, true);
        assert.match(report.source.workerSha256, /^[a-f0-9]{64}$/);
        const next = report.results[0].metrics.gitCommandCount.p50;
        assert.ok(next > 0);
        if (i === 1) assert.equal(next, count, 'second capture must not include first-capture Git commands');
        count = next;
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
