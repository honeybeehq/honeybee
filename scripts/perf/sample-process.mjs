#!/usr/bin/env node
/** Read-only process-tree sampling. No attach, signals, environment or argv capture. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { distribution } from './report.mjs';

const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
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
while (performance.now() - started < duration) {
  const snapshotStart = performance.now();
  const p = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,lstart='], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(p.status, 0, p.stderr);
  const rows = p.stdout.trim().split('\n').map(line => {
    const fields = line.trim().split(/\s+/);
    const [id, parent, rss, time, ...start] = fields;
    const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
    const seconds = clock.split(':').reduce((n, part) => n * 60 + Number(part), 0) + Number(days) * 86400;
    return { pid: Number(id), ppid: Number(parent), rssBytes: Number(rss) * 1024, cpuSeconds: seconds, birth: start.join(' ') };
  });
  const root = rows.find(row => row.pid === pid);
  if (!root) break;
  birth ??= root.birth;
  if (birth !== root.birth) break;
  const owned = new Set([pid]);
  for (let changed = true; changed;) { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
  const tree = rows.filter(row => owned.has(row.pid));
  samples.push({ elapsedMs: performance.now() - started, samplingMs: performance.now() - snapshotStart, rssBytes: tree.reduce((n, row) => n + row.rssBytes, 0), processes: tree });
  await setTimeout(Math.min(interval, Math.max(0, duration - (performance.now() - started))));
}
assert.ok(samples.length > 0, 'root process not observed');
const cpuPercent = [];
for (let i = 1; i < samples.length; i++) {
  const before = new Map(samples[i - 1].processes.map(p => [`${p.pid}:${p.birth}`, p.cpuSeconds]));
  let cpu = 0;
  for (const p of samples[i].processes) { const prior = before.get(`${p.pid}:${p.birth}`); if (prior !== undefined) cpu += Math.max(0, p.cpuSeconds - prior); }
  cpuPercent.push(cpu * 100000 / (samples[i].elapsedMs - samples[i - 1].elapsedMs));
}
writeFileSync(out, JSON.stringify({ schemaVersion: 1, pid, birth, timestamp: new Date().toISOString(), scope: 'root plus descendants observed by ps; excludes CPU of processes entering/exiting between samples; RSS sums shared pages more than once', config: { duration, interval }, rssBytes: distribution(samples.map(s => s.rssBytes)), cpuPercent: cpuPercent.length ? distribution(cpuPercent) : null, samples }, null, 2) + '\n');
console.log(out);
