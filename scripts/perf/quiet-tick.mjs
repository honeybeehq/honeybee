#!/usr/bin/env node
// Isolate quiet ticks from fixture setup, imports, and unrelated view queries.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus, hostname, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { bootIdentity } from './boot-identity.mjs';
import { seedStore } from './fixtures.mjs';
import { distribution } from './report.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name), value = at < 0 ? fallback : args[at + 1];
  assert.ok(value !== undefined && !value.startsWith('--'), `${name} requires a value`);
  return value;
}
const root = resolve(option('--root', '.'));
const out = resolve(option('--out', '.artifacts/performance/quiet-tick.json'));
const bees = Number(option('--bees', '1000'));
const generations = Number(option('--generations', '20'));
const samples = Number(option('--samples', '30'));
const live = Number(option('--live', '0'));
const pending = Number(option('--pending', '0'));
const bodyBytes = Number(option('--body-bytes', '64'));
const mode = option('--mode', 'none');
const startedAt = new Date().toISOString();
const loadBefore = loadavg();
assert.ok(Number.isSafeInteger(bees) && bees >= 0 && bees <= 100000);
assert.ok(Number.isSafeInteger(generations) && generations >= 1 && generations <= 1000);
assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 10000);
assert.ok(Number.isSafeInteger(live) && live >= 0 && live <= bees, 'live must be between zero and bees');
assert.ok(Number.isSafeInteger(pending) && pending >= 0 && pending <= 100000, 'pending must be 0..100000');
assert.ok(pending === 0 || live > 0, 'held idle mail requires a live target');
assert.ok(Number.isSafeInteger(bodyBytes) && bodyBytes >= 0 && bodyBytes <= 4 * 1024 * 1024, 'body-bytes must be 0..4MiB');
assert.ok(pending * bodyBytes <= 128 * 1024 * 1024, 'pending fixture body budget is 128MiB');
assert.ok(['none', 'profile'].includes(mode));
assert.equal(typeof global.gc, 'function', 'run with node --expose-gc');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const sourceFingerprint = () => {
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', 'v2').trim().split('\n').filter(file =>
    file.endsWith('.ts') && (file.includes('/src/') || file === 'v2/daemon/tests/helpers.ts'));
  return { revision: git('rev-parse', 'HEAD').trim(),
    hashes: Object.fromEntries(files.map(file => [file, digest(join(root, file))])) };
};
const source = { root, ...sourceFingerprint(), status: git('status', '--porcelain'),
  diffSha256: createHash('sha256').update(git('diff', '--binary', 'HEAD')).digest('hex') };
const toolFiles = ['quiet-tick.mjs', 'fixtures.mjs', 'report.mjs', 'boot-identity.mjs'];
const fingerprintTools = () => Object.fromEntries(toolFiles.map(file => [file, digest(new URL(file, import.meta.url))]));
const toolHashes = fingerprintTools();
const local = file => import(pathToFileURL(join(root, file)).href);
const { openCoreStore } = await local('v2/core/src/index.ts');
const { DaemonCore } = await local('v2/daemon/src/loops.ts');
const { FakeDriver } = await local('v2/daemon/tests/helpers.ts');
const dir = mkdtempSync(join(tmpdir(), 'hb-quiet-tick-'));
let store, session;
try {
  mkdirSync(dirname(out), { recursive: true });
  store = openCoreStore(join(dir, 'core.sqlite3'), { now: () => 1000 });
  seedStore(store, bees, generations);
  store.transact(() => {
    for (let i = 0; i < live; i++) {
      const id = `perf-${i}`, rt = store.reviveBee(id);
      store.updateRuntimeState(id, rt.generation, 'running');
      assert.equal(store.currentRuntime(id).bootEvidence, 'real');
    }
    const body = 'x'.repeat(bodyBytes);
    for (let i = 0; i < pending; i++) store.send('perf-0', body, { urgency: 'idle' });
  });
  assert.equal(store.listUndeliveredMessages().length, pending);
  const phases = {};
  const recorder = {
    startSpan() { assert.fail('quiet steps must use synchronous spans'); },
    measureSync(name, fn) {
      const cpu = process.cpuUsage(), start = performance.now();
      try { return fn(); }
      finally {
        const elapsed = performance.now() - start, used = process.cpuUsage(cpu);
        const phase = phases[name] ??= { wallMs: [], cpuMs: [] };
        phase.wallMs.push(elapsed); phase.cpuMs.push((used.user + used.system) / 1000);
      }
    },
  };
  const driver = new FakeDriver(() => 1000);
  const core = new DaemonCore({ store, driver, now: () => 1000,
    policy: { bootHangTimeoutSteps: 60000, commandsPerStep: 8, i1DeadlineSteps: 10000 },
    onI1Violation: () => assert.fail('unexpected I1 violation'), log: () => {},
    ...(mode === 'profile' ? { performance: recorder } : {}),
  });
  const stateDigest = () => createHash('sha256').update(JSON.stringify(store.dumpState())).digest('hex');
  const state = stateDigest();
  const auditSeq = store.lastAuditSeq();
  for (let i = 0; i < 3; i++) core.step();
  for (const key of Object.keys(phases)) delete phases[key];
  global.gc();
  if (mode === 'profile') {
    session = new Session(); session.connect();
    await session.post('Profiler.enable'); await session.post('Profiler.start');
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  }
  const before = process.memoryUsage(), peakBeforeKiB = process.resourceUsage().maxRSS;
  const measurementStartedAt = new Date().toISOString();
  const raw = { wallMs: [], cpuMs: [] };
  for (let i = 0; i < samples; i++) {
    const cpu = process.cpuUsage(), start = performance.now();
    core.step();
    raw.wallMs.push(performance.now() - start);
    const used = process.cpuUsage(cpu); raw.cpuMs.push((used.user + used.system) / 1000);
  }
  const after = process.memoryUsage(), peakAfterKiB = process.resourceUsage().maxRSS;
  const measurementFinishedAt = new Date().toISOString();
  const profiles = [];
  const pendingProfiles = [];
  if (session) {
    for (const [command, suffix] of [['Profiler.stop', 'cpuprofile'], ['HeapProfiler.stopSampling', 'heapprofile']]) {
      const { profile } = await session.post(command), path = `${out}.${suffix}`;
      pendingProfiles.push({ path, profile });
    }
    session.disconnect(); session = undefined;
  }
  assert.equal(stateDigest(), state, 'quiet ticks must not change durable state');
  assert.equal(store.lastAuditSeq(), auditSeq, 'quiet ticks must not append audit events');
  assert.deepEqual(driver.starts, [], 'quiet fixture must not start a process');
  assert.deepEqual(driver.deliveredIds, [], 'held idle mail must stay pending');
  assert.deepEqual(driver.interrupts, [], 'idle urgency must not interrupt a turn');
  global.gc();
  const collectedAfter = process.memoryUsage();
  assert.deepEqual(sourceFingerprint(), { revision: source.revision, hashes: source.hashes }, 'source changed during capture');
  assert.deepEqual(fingerprintTools(), toolHashes, 'ruler changed during capture');
  for (const { path, profile } of pendingProfiles) {
    writeFileSync(path, JSON.stringify(profile) + '\n');
    profiles.push({ path, sha256: digest(path) });
  }
  const report = { schemaVersion: 2, completed: true, startedAt, timestamp: new Date().toISOString(),
    measurement: { startedAt: measurementStartedAt, finishedAt: measurementFinishedAt },
    source, toolHashes, auditSeq,
    environment: { node: process.version, platform: process.platform, arch: process.arch, hostname: hostname(),
      bootIdentity: bootIdentity(), cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      execArgv: process.execArgv, nodeCompileCache: process.env.NODE_COMPILE_CACHE ?? null,
      nodeOptionsSha256: createHash('sha256').update(process.env.NODE_OPTIONS ?? '').digest('hex'), loadBefore, loadAfter: loadavg() },
    workload: { bees, generations, samples, mode, warmups: 3, gcBefore: true, durability: 'WAL/NORMAL',
      currentRuntimes: live ? 'real-running live targets; stopped remainder' : 'stopped',
      liveRuntimes: live, seedLifecycleRule: 'every tenth Bee active; remainder archived; revival activates live targets', pendingMessages: pending,
      bodyBytes, urgency: 'idle', pendingTarget: pending ? 'perf-0' : null, now: 1000 },
    raw, metrics: Object.fromEntries(Object.entries(raw).map(([key, values]) => [key, distribution(values)])),
    phases, before, after, collectedAfter, peakBeforeKiB, peakAfterKiB, profiles,
    scope: 'Real core quiet steps over retained stopped bees and optional real-running targets with held idle mail, using FakeDriver. The source runtime state is seeded; no real process is launched or readiness measured. Imports, seeding and correctness assertions are outside the measured interval. Profile mode includes per-phase CPU/wall recording and V8 sampling, so its timing is not compared with uninstrumented timing. RSS is process resident memory, not private memory; maxRSS includes setup. Collected heap usage is not total allocation. Allocation profiles include sampled objects collected during the measured interval.' };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(out);
} finally { session?.disconnect(); store?.close(); rmSync(dir, { recursive: true, force: true }); }
