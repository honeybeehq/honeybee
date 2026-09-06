#!/usr/bin/env node
/** Alternate two real implementations over identical isolated stores to reduce host drift. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { cpus, hostname, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { seedStore } from './fixtures.mjs';
import { distribution, compareReports } from './report.mjs';

const args = process.argv.slice(2);
function option(key, fallback) { const at = args.indexOf(key); const value = at < 0 ? fallback : args[at + 1]; assert.ok(value && !value.startsWith('--'), `${key} requires a value`); return value; }
const beforeRoot = resolve(option('--before-root'));
const afterRoot = resolve(option('--after-root', '.'));
const out = resolve(option('--out-dir', '.artifacts/performance/paired'));
const rounds = Number(option('--rounds', '15'));
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 100, 'rounds must be 3..100');
mkdirSync(out, { recursive: true });
const scenarios = [{ bees: 10, generations: 1 }, { bees: 1000, generations: 1 }, { bees: 1000, generations: 20 }, { bees: 100, generations: 200 }];
const toolDigest = createHash('sha256').update(readFileSync(new URL('./paired-core.mjs', import.meta.url))).update(readFileSync(new URL('./fixtures.mjs', import.meta.url))).update(readFileSync(new URL('./report.mjs', import.meta.url))).digest('hex');
const workload = { scenarios, rounds, toolDigest, method: 'alternating AB then BA; identical checkpointed databases; three warmups per side', durability: 'WAL/NORMAL' };
const environment = { node: process.version, platform: process.platform, arch: process.arch, hostname: hostname(), cpu: cpus()[0]?.model, loadBefore: loadavg() };
function git(root, ...argv) { const p = spawnSync('git', argv, { cwd: root, encoding: 'utf8' }); assert.equal(p.status, 0, p.stderr); return p.stdout.trim(); }
const importRoot = async root => {
  const local = file => import(pathToFileURL(join(root, file)).href);
  const { openCoreStore } = await local('v2/core/src/index.ts');
  const { DaemonCore } = await local('v2/daemon/src/loops.ts');
  const { FakeDriver } = await local('v2/daemon/tests/helpers.ts');
  return { openCoreStore, DaemonCore, FakeDriver, source: { root, revision: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain'), codeHashes: Object.fromEntries(['v2/core/src/store.ts', 'v2/daemon/src/loops.ts'].map(file => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')])) } };
};
const implementations = [await importRoot(beforeRoot), await importRoot(afterRoot)];
const reports = implementations.map(impl => ({ schemaVersion: 1, timestamp: new Date().toISOString(), source: impl.source, environment, workload, results: [] }));
for (const scenario of scenarios) {
  const name = `core-${scenario.bees}x${scenario.generations}`;
  process.stderr.write(`Alternating ${name}\n`);
  const dir = mkdtempSync(join(tmpdir(), 'hb-paired-'));
  const stores = [];
  try {
    const seed = implementations[0].openCoreStore(join(dir, 'before.sqlite3'), { now: () => 1000 });
    try { seedStore(seed, scenario.bees, scenario.generations); } finally { seed.close(); }
    copyFileSync(join(dir, 'before.sqlite3'), join(dir, 'after.sqlite3'));
    for (let i = 0; i < 2; i++) stores.push(implementations[i].openCoreStore(join(dir, i === 0 ? 'before.sqlite3' : 'after.sqlite3'), { now: () => 1000 }));
    assert.deepEqual(stores[0].dumpState(), stores[1].dumpState());
    const seqs = stores.map(store => store.lastAuditSeq());
    const cores = implementations.map((impl, i) => new impl.DaemonCore({ store: stores[i], driver: new impl.FakeDriver(() => 1000), now: () => 1000, policy: { bootHangTimeoutSteps: 60000, commandsPerStep: 8, i1DeadlineSteps: 10000 }, onI1Violation: () => assert.fail('unexpected I1 violation'), log: () => {} }));
    const operations = ['view.all', 'view.active', 'view.one', 'core.quietStep'];
    const call = (side, operation) => {
      const store = stores[side];
      if (operation === 'view.all') return store.listBeeViewRows();
      if (operation === 'view.active') return store.listBeeViewRows('active');
      if (operation === 'view.one') return store.view('perf-0');
      return cores[side].step();
    };
    const raw = [{}, {}];
    for (const operation of operations) {
      assert.deepEqual(call(0, operation), call(1, operation), 'both implementations return the same result');
      for (let warm = 0; warm < 3; warm++) { call(0, operation); call(1, operation); }
      for (const side of [0, 1]) { raw[side][`${operation}.wall`] = []; raw[side][`${operation}.cpu`] = []; }
      for (let round = 0; round < rounds; round++) {
        for (const side of [0, 1, 1, 0]) {
          const cpu = process.cpuUsage(), t = performance.now();
          call(side, operation);
          raw[side][`${operation}.wall`].push(performance.now() - t);
          const used = process.cpuUsage(cpu); raw[side][`${operation}.cpu`].push((used.user + used.system) / 1000);
        }
      }
    }
    for (let i = 0; i < 2; i++) {
      assert.equal(stores[i].lastAuditSeq(), seqs[i], 'reads and quiet steps remain semantic no-ops');
      reports[i].results.push({ scenario: name, metrics: Object.fromEntries(Object.entries(raw[i]).map(([name, values]) => [name, { unit: 'ms', ...distribution(values) }])), raw: raw[i] });
    }
  } finally { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); }
}
environment.loadAfter = loadavg();
for (let i = 0; i < 2; i++) writeFileSync(join(out, i === 0 ? 'before.json' : 'after.json'), JSON.stringify(reports[i], null, 2) + '\n');
const rows = compareReports(...reports);
const columns = ['scenario', 'metric', 'unit', 'before', 'after', 'deltaPercent', 'beforeP95', 'afterP95', 'n'];
writeFileSync(join(out, 'scorecard.csv'), [columns.join(','), ...rows.map(r => columns.map(key => r[key] ?? '').join(','))].join('\n') + '\n');
console.log(out);
