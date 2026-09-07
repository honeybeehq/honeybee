#!/usr/bin/env node
// Quiet and busy fallback costs, including the runtime index's write/open tradeoff.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { bootIdentity } from './boot-identity.mjs';
import { seedStore } from './fixtures.mjs';
import { distribution } from './report.mjs';

const [beforeArg, afterArg, outArg, roundsArg = '15', expectedChangedArg] = process.argv.slice(2);
assert.ok(beforeArg && afterArg && outArg, 'usage: paired-step.mjs before-root after-root out.json [rounds]');
const roots = [resolve(beforeArg), resolve(afterArg)], out = resolve(outArg), rounds = Number(roundsArg);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 100);
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
function source(root) {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(r.status, 0, r.stderr); return r.stdout;
  };
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', 'v2').trim().split('\n')
    .filter(p => p.endsWith('.ts') && (p.includes('/src/') || p === 'v2/daemon/tests/helpers.ts'));
  return { root, revision: git('rev-parse', 'HEAD').trim(), status: git('status', '--porcelain'),
    diffSha256: createHash('sha256').update(git('diff', '--binary', 'HEAD')).digest('hex'),
    hashes: Object.fromEntries(files.map(p => [p, digest(join(root, p))])) };
}
const sources = roots.map(source);
const changedSourceFiles = [...new Set(sources.flatMap(s => Object.keys(s.hashes)))]
  .filter(file => sources[0].hashes[file] !== sources[1].hashes[file]).sort();
if (expectedChangedArg !== undefined) {
  assert.deepEqual(changedSourceFiles, expectedChangedArg.split(',').filter(Boolean).sort(), 'unexpected source changes');
  for (const s of sources) assert.doesNotMatch(s.status, /^.. v2\//m, 'expected committed v2 source');
}
const fingerprintTools = () => Object.fromEntries(['paired-step.mjs', 'fixtures.mjs', 'report.mjs', 'boot-identity.mjs']
  .map(p => [p, digest(new URL(p, import.meta.url))]));
const toolHashes = fingerprintTools();
const modules = [];
for (const root of roots) {
  const local = p => import(pathToFileURL(join(root, p)).href);
  modules.push({ ...await local('v2/core/src/index.ts'), ...await local('v2/daemon/src/loops.ts'),
    ...await local('v2/daemon/tests/helpers.ts') });
}
const scenarios = [
  { name: 'empty', bees: 0, generations: 1, live: 0, pending: 0, bodyBytes: 0 },
  { name: 'retained-1000', bees: 1000, generations: 20, live: 0, pending: 0, bodyBytes: 0 },
  { name: 'retained-10000', bees: 10000, generations: 1, live: 0, pending: 0, bodyBytes: 0 },
  { name: 'sparse-live', bees: 1000, generations: 20, live: 1, pending: 0, bodyBytes: 0 },
  { name: 'all-live', bees: 1000, generations: 1, live: 1000, pending: 0, bodyBytes: 0 },
  { name: 'held-mail', bees: 10, generations: 1, live: 1, pending: 1000, bodyBytes: 1024 },
  { name: 'write-every-tick', bees: 1000, generations: 1, live: 1, pending: 0, bodyBytes: 0, rename: true },
];
const measure = fn => {
  const cpu = process.cpuUsage(), start = performance.now(); fn();
  const wallMs = performance.now() - start, used = process.cpuUsage(cpu);
  return { wallMs, cpuMs: (used.user + used.system) / 1000 };
};
const startedAt = new Date().toISOString(), loadBefore = loadavg(), results = [];
const stateHash = s => createHash('sha256').update(JSON.stringify({ state: s.dumpState(), audit: s.auditRows() })).digest('hex');
const storage = path => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { bytes: statSync(path).size, pageCount: db.prepare('PRAGMA page_count').get().page_count,
      freePages: db.prepare('PRAGMA freelist_count').get().freelist_count,
      schemaVersion: db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
      indexes: db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name='runtimes' ORDER BY name").all() };
  } finally { db.close(); }
};
for (const scenario of scenarios) {
  process.stderr.write(`Paired steps: ${scenario.name}\n`);
  const dir = mkdtempSync(join(tmpdir(), 'hb-paired-step-'));
  const paths = [join(dir, 'before.sqlite3'), join(dir, 'after.sqlite3')];
  const stores = [];
  try {
    // Seed both implementations equally before copying the baseline database.
    // This warms distinct module instances, not just the baseline's write paths.
    const seedHashes = [];
    for (let side = 0; side < 2; side++) {
      const seed = modules[side].openCoreStore(paths[side], { now: () => 1000 });
      try {
      seedStore(seed, scenario.bees, scenario.generations);
      seed.transact(() => {
        for (let i = 0; i < scenario.live; i++) {
          const id = `perf-${i}`, rt = seed.reviveBee(id);
          seed.updateRuntimeState(id, rt.generation, 'running');
        }
        for (let i = 0; i < scenario.pending; i++) seed.send('perf-0', 'x'.repeat(scenario.bodyBytes), { urgency: 'idle' });
      });
        seedHashes.push(stateHash(seed));
      } finally { seed.close(); }
      assert.equal(existsSync(`${paths[side]}-wal`), false, 'seed close must checkpoint the copied database');
    }
    assert.equal(seedHashes[0], seedHashes[1], 'candidate fixture creation changed state or audit');
    const seededBytes = statSync(paths[0]).size;
    copyFileSync(paths[0], paths[1]);
    const firstOpen = modules.map((m, i) => measure(() => { stores.push(m.openCoreStore(paths[i], { now: () => 1000 })); }));
    const initialHashes = stores.map(stateHash), initialSeqs = stores.map(s => s.lastAuditSeq());
    assert.equal(initialHashes[0], initialHashes[1], 'both sides start with identical authority and audit');
    const cores = modules.map((m, i) => new m.DaemonCore({ store: stores[i], driver: new m.FakeDriver(() => 1000),
      now: () => 1000, policy: { bootHangTimeoutSteps: 60000, commandsPerStep: 8, i1DeadlineSteps: 1e12 },
      onI1Violation: () => assert.fail('unexpected I1 violation'), log: () => {} }));
    const counters = [0, 0];
    const step = side => {
      if (scenario.rename) stores[side].renameBee('perf-0', `revision-${++counters[side]}`);
      cores[side].step();
    };
    for (let i = 0; i < 3; i++) for (const side of [0, 1]) step(side);
    const raw = [[], []], order = [];
    for (let r = 0; r < rounds; r++) for (const side of [0, 1, 1, 0]) {
      raw[side].push(measure(() => step(side))); order.push(side);
    }
    assert.equal(stateHash(stores[0]), stateHash(stores[1]), 'step behavior or audit differs');
    if (!scenario.rename) for (const side of [0, 1]) {
      assert.equal(stateHash(stores[side]), initialHashes[side], 'quiet fixture changed authority or audit');
      assert.equal(stores[side].lastAuditSeq(), initialSeqs[side], 'quiet step audited');
    }
    // Every sample performs ten real durable create/stop/revive/stop cycles.
    const writeRaw = [[], []], writeCounter = [0, 0];
    const write = side => {
      const s = stores[side];
      for (let j = 0; j < 10; j++) {
        const n = ++writeCounter[side], id = `write-${n}`;
        s.createBee({ id, name: id, handle: `WX.${n.toString(36)}`, agent: 'stub', substrate: 'hsr', cwd: '/tmp' });
        s.updateRuntimeState(id, 1, 'stopped', { exitCause: 'clean' });
        const rt = s.reviveBee(id); s.updateRuntimeState(id, rt.generation, 'stopped', { exitCause: 'clean' });
      }
    };
    for (let warm = 0; warm < 2; warm++) for (const side of [0, 1]) write(side);
    for (let r = 0; r < rounds; r++) for (const side of [0, 1, 1, 0]) writeRaw[side].push(measure(() => write(side)));
    assert.equal(stateHash(stores[0]), stateHash(stores[1]), 'lifecycle writes or audit differ');
    for (const s of stores) s.close(); stores.length = 0;
    const closedStorage = paths.map(storage);
    assert.equal(closedStorage[0].schemaVersion, closedStorage[1].schemaVersion, 'schema format changed');
    const repeatOpen = [[], []];
    for (let repeat = 0; repeat < 5; repeat++) for (const side of [0, 1, 1, 0]) repeatOpen[side].push(measure(() => {
      const s = modules[side].openCoreStore(paths[side], { now: () => 1000 }); s.close();
    }));
    results.push({ scenario, seededBytes, firstOpen, closedStorage, raw, writeRaw, repeatOpen, order });
  } finally { for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); }
}
assert.deepEqual(roots.map(source), sources, 'source changed during paired capture');
assert.deepEqual(fingerprintTools(), toolHashes, 'ruler changed during paired capture');
const rows = [];
for (const r of results) for (const operation of ['raw', 'writeRaw', 'repeatOpen']) for (const metric of ['wallMs', 'cpuMs']) {
  const b = distribution(r[operation][0].map(s => s[metric])), a = distribution(r[operation][1].map(s => s[metric]));
  rows.push({ scenario: r.scenario.name, operation: operation === 'raw' ? 'step' : operation === 'writeRaw' ? 'tenDurableLifecycleCycles' : 'repeatOpen',
    metric, before: b, after: a, deltaPercent: b.p50 === 0 ? null : (a.p50 / b.p50 - 1) * 100 });
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ schemaVersion: 2, completed: true, startedAt, timestamp: new Date().toISOString(), sources,
  changedSourceFiles, expectedChangedFiles: expectedChangedArg ?? null, sharedModuleIdentity: modules[0].DaemonCore === modules[1].DaemonCore,
  toolHashes,
  environment: { node: process.version, execArgv: process.execArgv, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, hostname: hostname(), bootIdentity: bootIdentity(),
    nodeCompileCache: process.env.NODE_COMPILE_CACHE ?? null,
    nodeOptionsSha256: createHash('sha256').update(process.env.NODE_OPTIONS ?? '').digest('hex'), loadBefore, loadAfter: loadavg() },
  workload: { scenarios, rounds, order: 'ABBA each round; both modules seeded; three step and two write-batch warmups per side', durability: 'WAL/NORMAL' }, results, rows,
  scope: 'Real CoreStore and DaemonCore with FakeDriver, source runtime. One process alternates both implementations over copied identical databases. Shared-heap GC can cross sides; ABBA reduces but cannot eliminate that coupling. No provider/process readiness or whole-daemon idle claim. First open is one sample per scenario and includes candidate index installation; repeat open includes close/checkpoint. Closed bytes include subsequent identical lifecycle writes and page-allocation effects; index definitions and free pages are retained. Write batches grow the same retained history on both sides; every mutation commits with production durability. RSS and private memory are not measured here.' }, null, 2) + '\n');
console.log(out);
