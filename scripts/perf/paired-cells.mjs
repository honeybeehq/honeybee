#!/usr/bin/env node
// Alternate real built-worker captures in fresh Node processes for each side.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCells } from './compare-spawn.mjs';
import { distribution } from './report.mjs';

const [beforePath, afterPath, outPath, roundsArg = '7'] = process.argv.slice(2);
assert.ok(beforePath && afterPath && outPath, 'usage: paired-cells.mjs before-root after-root out.json [rounds]');
const rounds = Number(roundsArg);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 2 && rounds <= 30);
const roots = [resolve(beforePath), resolve(afterPath)], out = resolve(outPath);
const dir = `${out}.captures`;
mkdirSync(dirname(out), { recursive: true }); mkdirSync(dir, { recursive: true });
const tool = fileURLToPath(new URL('./cells.mjs', import.meta.url));
let active, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; active?.kill(signal); });
async function capture(root, path, remoteMode) {
  assert.equal(interrupted, false, 'capture interrupted');
  const child = spawn(process.execPath, [tool, '--root', root, '--out', path, '--mode', 'worker', '--samples', '1', '--hold-ms', '100', '--remote-mode', remoteMode], { stdio: ['ignore', 'ignore', 'pipe'] });
  active = child;
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  // cells.mjs owns its worker and disposable fixture cleanup on termination.
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
  try {
    const code = await new Promise((res, rej) => { child.once('exit', res); child.once('error', rej); });
    assert.equal(code, 0, errors);
    assert.equal(interrupted, false, 'capture interrupted');
    return JSON.parse(readFileSync(path, 'utf8'));
  } finally { clearTimeout(timer); active = undefined; }
}
function aggregate(reports) {
  const first = reports[0];
  for (const report of reports) {
    compareCells(first, report); // Validate samples, tool, environment and workload.
    assert.deepEqual(report.source, first.source, 'source changed during capture');
  }
  const raw = reports.flatMap(r => r.results[0].raw);
  return { ...first, workload: { ...first.workload, samples: reports.length },
    environment: { ...first.environment, loadAfter: reports.at(-1).environment.loadAfter },
    results: [{ scenario: first.results[0].scenario, raw,
      metrics: Object.fromEntries(Object.keys(first.results[0].metrics).map(key => [key, distribution(raw.map(row => row[key]))])) }] };
}
const toolSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('./compare-spawn.mjs', import.meta.url))).update(readFileSync(new URL('./report.mjs', import.meta.url))).digest('hex');
const report = { schemaVersion: 1, toolSha256, completed: false, rounds, roots, order: 'AB on even rounds, BA on odd rounds; each capture is a fresh Node process', scenarios: [] };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
for (const remoteMode of ['none', 'same', 'split']) {
  const captures = [[], []];
  for (let round = 0; round < rounds; round++) {
    for (const side of (round % 2 === 0 ? [0, 1] : [1, 0])) {
      process.stderr.write(`${remoteMode} pair ${round + 1}/${rounds} ${side === 0 ? 'before' : 'after'}\n`);
      captures[side].push(await capture(roots[side], join(dir, `${remoteMode}-${round}-${side}.json`), remoteMode));
    }
  }
  const [before, after] = captures.map(aggregate);
  const comparison = compareCells(before, after).map(row => {
    const deltas = before.results[0].raw.map((sample, i) => after.results[0].raw[i][row.metric] - sample[row.metric]);
    return { ...row, pairedDeltaP50: distribution(deltas).p50, pairsAfterLower: deltas.filter(x => x < 0).length };
  });
  report.scenarios.push({ remoteMode, before, after, comparison,
    captures: captures.map(side => side.map(r => ({ timestamp: r.timestamp, environment: r.environment }))) });
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
report.completed = true;
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out);
