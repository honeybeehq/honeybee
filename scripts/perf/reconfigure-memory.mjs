#!/usr/bin/env node
// One unchanged-settings check in a fresh process, after a collected fixture setup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir, cpus, hostname, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

assert.equal(typeof global.gc, 'function', 'run with node --expose-gc');
const root = resolve(process.argv[2] ?? '.');
const out = resolve(process.argv[3] ?? '.artifacts/performance/reconfigure-memory.json');
const profileMode = process.argv[4] ?? 'none';
assert.ok(['none', 'profile', 'allocations'].includes(profileMode));
const instrumented = profileMode !== 'none';
const { openCoreStore } = await import(pathToFileURL(join(root, 'v2/core/src/index.ts')).href);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
assert.equal(revision.status, 0);
const fixture = mkdtempSync(join(tmpdir(), 'hb-reconfigure-memory-'));
let store, db, session;
try {
  mkdirSync(dirname(out), { recursive: true });
  const path = join(fixture, 'core.sqlite3');
  store = openCoreStore(path, { ephemeral: true });
  store.createBee({ id: 'target', name: 'target', handle: 'PF.target', agent: 'stub', substrate: 'hsr', cwd: fixture });
  store.updateRuntimeState('target', 1, 'stopped', { exitCause: 'clean' });
  store.close(); store = undefined;
  db = new DatabaseSync(path); db.exec('PRAGMA synchronous=OFF'); db.exec('BEGIN');
  const insert = db.prepare("INSERT INTO commands(verb,bee_id,args,target_generation,status,attempts,next_attempt_at,enqueued_at,finished_at) VALUES('stop','target',?,1,'done',1,0,0,1)");
  const args = JSON.stringify({ reason: 'x'.repeat(256) });
  for (let i = 0; i < 100000; i++) insert.run(args);
  db.exec('COMMIT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 100000);
  db.close(); db = undefined;
  store = openCoreStore(path, { ephemeral: true });
  const seq = store.lastAuditSeq();
  global.gc();
  if (instrumented) {
    session = new Session(); session.connect();
    await session.post('Profiler.enable'); await session.post('Profiler.start');
    await session.post('HeapProfiler.enable');
    await session.post('HeapProfiler.startSampling', { samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: profileMode === 'allocations',
      includeObjectsCollectedByMinorGC: profileMode === 'allocations',
    });
  }
  const before = process.memoryUsage(), peakBeforeKiB = process.resourceUsage().maxRSS;
  const cpuStart = process.cpuUsage(), start = performance.now();
  assert.equal(store.reconfigureBee('target', null).outcome, 'unchanged');
  const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
  const after = process.memoryUsage(), peakAfterKiB = process.resourceUsage().maxRSS;
  const profiles = [];
  if (session) {
    for (const [command, suffix] of [['Profiler.stop', 'cpuprofile'], ['HeapProfiler.stopSampling', 'heapprofile']]) {
      const { profile } = await session.post(command);
      const profilePath = `${out}.${suffix}`;
      writeFileSync(profilePath, JSON.stringify(profile) + '\n');
      profiles.push({ path: profilePath, sha256: digest(profilePath) });
    }
    session.disconnect(); session = undefined;
  }
  assert.equal(store.lastAuditSeq(), seq);
  const report = { schemaVersion: 1, completed: true, instrumented, profileMode, timestamp: new Date().toISOString(), revision: revision.stdout.trim(),
    sourceHashes: Object.fromEntries(['store.ts', 'schema.ts'].map(name => [name, digest(join(root, 'v2/core/src', name))])), toolSha256: digest(new URL(import.meta.url)),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostname: hostname(), loadAfter: loadavg() },
    workload: { ownSettledCommands: 100000, reasonChars: 256, operation: 'reconfigureBee(target, null)', samples: 1, gcBefore: true },
    wallMs, cpuMs: (cpu.user + cpu.system) / 1000, before, after, peakBeforeKiB, peakAfterKiB, profiles,
    scope: 'One real unchanged-settings check; synthetic history seeded before measurement while CoreStore is closed. Explicit GC before the call removes fixture garbage. RSS includes shared/allocator pages, not private memory. Heap is observed usage, not allocated bytes. Peak RSS includes fixture setup; compare before and after high-water marks. Instrumented runs are separate from timing claims.' };
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(out);
} finally { session?.disconnect(); store?.close(); db?.close(); rmSync(fixture, { recursive: true, force: true }); }
