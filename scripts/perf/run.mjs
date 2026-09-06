#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareReports } from './report.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) { const at = args.indexOf(name); if (at < 0) return fallback; assert.ok(args[at + 1] && !args[at + 1].startsWith('--'), `${name} requires a value`); return args[at + 1]; }
if (args.includes('--compare')) {
  const b = JSON.parse(readFileSync(option('--before'), 'utf8'));
  const a = JSON.parse(readFileSync(option('--after'), 'utf8'));
  const rows = compareReports(b, a);
  const columns = ['scenario', 'metric', 'unit', 'before', 'after', 'deltaPercent', 'beforeP95', 'afterP95', 'n'];
  const csv = [columns.join(','), ...rows.map(r => columns.map(k => r[k] ?? '').join(','))].join('\n') + '\n';
  writeFileSync(resolve(option('--out', 'comparison.csv')), csv);
  console.log(csv);
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('node scripts/perf/run.mjs [--root checkout] [--out report.json] [--samples 15] [--idle-ms 3000] [--suite core|daemon|cli|all] [--profile-dir path]\nCompare: --compare --before report.json --after report.json --out scorecard.csv');
  process.exit(0);
}
const root = resolve(option('--root', join(scriptDir, '../..')));
const out = resolve(option('--out', join(root, '.artifacts/performance/report.json')));
const samples = Number(option('--samples', '15'));
const idleMs = Number(option('--idle-ms', '3000'));
const suite = option('--suite', 'all');
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 1000, 'samples must be 3..1000');
assert.ok(Number.isSafeInteger(idleMs) && idleMs >= 100 && idleMs <= 60000, 'idle-ms must be 100..60000');
assert.ok(['core', 'daemon', 'cli', 'all'].includes(suite), 'unknown suite');
const cases = ['daemon', 'cli'].includes(suite) ? [] : [
  { bees: 10, generations: 1 }, { bees: 1000, generations: 1 },
  { bees: 1000, generations: 20 }, { bees: 100, generations: 200 },
];
const scenarios = [...cases.map(c => ({ kind: 'core', ...c })), ...(['core', 'cli'].includes(suite) ? [] : [{ kind: 'daemon', bees: 0 }, { kind: 'daemon', bees: 1000 }]), ...(['cli', 'all'].includes(suite) ? [{ kind: 'cli', bees: 0 }] : [])];
const workload = { suite, samples, idleMs, scenarios, warmup: 3, durability: 'WAL/NORMAL', runtime: 'source Node type stripping', instrumentation: Boolean(option('--profile-dir', '')) };
function git(...argv) { const p = spawnSync('git', argv, { cwd: root, encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); return p.stdout.trim(); }
const report = { schemaVersion: 1, timestamp: new Date().toISOString(), source: { root, revision: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), diff: git('diff', '--stat') }, environment: { node: process.version, platform: process.platform, arch: process.arch, hostname: hostname(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), loadBefore: loadavg() }, workload, results: [] };
mkdirSync(dirname(out), { recursive: true });
const profileDir = option('--profile-dir', '');
if (profileDir) mkdirSync(resolve(profileDir), { recursive: true });
for (const scenario of scenarios) {
  const name = `${scenario.kind}-${scenario.bees}${scenario.generations ? `x${scenario.generations}` : ''}`;
  process.stderr.write(`Measuring ${name}\n`);
  const profiling = profileDir ? ['--cpu-prof', `--cpu-prof-dir=${resolve(profileDir)}`, `--cpu-prof-name=${name}.cpuprofile`, '--heap-prof', `--heap-prof-dir=${resolve(profileDir)}`, `--heap-prof-name=${name}.heapprofile`] : [];
  const p = spawnSync(process.execPath, [...profiling, join(scriptDir, 'worker.mjs'), JSON.stringify({ root, samples, idleMs, scenario })], { cwd: root, encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, HIVE_NO_KEYCHAIN: '1', HIVE_PERF_DIR: profileDir ? resolve(profileDir) : '', NODE_COMPILE_CACHE: join(root, '.cache/performance-node') } });
  if (p.status !== 0) throw new Error(`${name} failed (${p.status}): ${p.stderr}\n${p.stdout}`);
  report.results.push(JSON.parse(p.stdout));
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
}
report.environment.loadAfter = loadavg();
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out);
