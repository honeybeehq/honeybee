#!/usr/bin/env node
/** Read-only process-tree sampling. No attach, signals, environment or argv capture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { parseProcessTable, processTree, cpuPercentBetween } from './process-tree.mjs';
import { distribution } from './report.mjs';

const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `${name} requires a value`); return args[i + 1]; }
if (args.includes('--help')) {
  console.log('node scripts/perf/sample-process.mjs --pid PID --out report.json [--duration-ms 10000] [--interval-ms 1000]');
  process.exit(0);
}
const pid = Number(option('--pid'));
const duration = Number(option('--duration-ms', '10000'));
const interval = Number(option('--interval-ms', '1000'));
assert.ok(Number.isSafeInteger(pid) && pid > 0, 'positive pid required');
assert.ok(Number.isSafeInteger(duration) && duration >= 100 && duration <= 3600000, 'duration-ms must be 100..3600000');
assert.ok(Number.isSafeInteger(interval) && interval >= 100 && interval <= duration, 'interval-ms must be 100..duration');
const out = resolve(option('--out', 'process-samples.json'));
mkdirSync(dirname(out), { recursive: true });
const started = performance.now(), samples = [];
let birth;
let records = 0, truncated = false;
while (performance.now() - started < duration) {
  const snapshotStart = performance.now();
  const p = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(p.status, 0, p.stderr);
  const rows = parseProcessTable(p.stdout);
  const root = rows.find(row => row.pid === pid);
  if (!root) break;
  birth ??= root.birth;
  if (birth !== root.birth) break;
  const tree = processTree(rows, pid);
  if (records + tree.length > 100000) { truncated = true; break; }
  records += tree.length;
  samples.push({ elapsedMs: performance.now() - started, samplingMs: performance.now() - snapshotStart, rssBytes: tree.reduce((n, row) => n + row.rssBytes, 0), processes: tree });
  await setTimeout(Math.min(interval, Math.max(0, duration - (performance.now() - started))));
}
assert.ok(samples.length > 0, 'root process not observed');
const cpuPercent = [];
for (let i = 1; i < samples.length; i++) {
  cpuPercent.push(cpuPercentBetween(samples[i - 1], samples[i]));
}
writeFileSync(out, JSON.stringify({ schemaVersion: 1, pid, birth, truncated, recordLimit: 100000, timestamp: new Date().toISOString(), scope: 'root plus descendants observed by ps; excludes CPU of processes entering/exiting between samples; RSS sums shared pages more than once', config: { duration, interval }, rssBytes: distribution(samples.map(s => s.rssBytes)), cpuPercent: cpuPercent.length ? distribution(cpuPercent) : null, samples }, null, 2) + '\n');
console.log(out);
