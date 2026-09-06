#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, hostname, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { distribution } from './report.mjs';

const [beforeArg, afterArg, outArg] = process.argv.slice(2);
assert.ok(beforeArg && afterArg && outArg, 'usage: command-index-upgrade.mjs before-root after-root out.json');
const roots = [resolve(beforeArg), resolve(afterArg)], out = resolve(outArg);
const modules = await Promise.all(roots.map(root => import(pathToFileURL(join(root, 'v2/core/src/index.ts')).href)));
const digest = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const revisions = roots.map(root => {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0); return result.stdout.trim();
});
const fixture = mkdtempSync(join(tmpdir(), 'hb-index-upgrade-'));
const path = join(fixture, 'core.sqlite3');
const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const target = id(999999);
let store, db;
const bytes = db => Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size);
const indexes = db => db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name='commands' ORDER BY name").all();
try {
  store = modules[0].openCoreStore(path, { ephemeral: true });
  store.createBee({ id: target, name: 'target', handle: 'PF.target', agent: 'stub', substrate: 'hsr', cwd: fixture });
  store.updateRuntimeState(target, 1, 'stopped', { exitCause: 'clean' });
  const seq = store.lastAuditSeq(); store.close(); store = undefined;
  db = new DatabaseSync(path); db.exec('PRAGMA synchronous=OFF'); db.exec('BEGIN');
  const insert = db.prepare("INSERT INTO commands(verb,bee_id,args,target_generation,status,attempts,next_attempt_at,enqueued_at,finished_at) VALUES('stop',?,?,1,'done',1,0,0,1)");
  const args = JSON.stringify({ reason: 'x'.repeat(256) });
  for (let i = 0; i < 100000; i++) insert.run(id(i % 100), args);
  for (let i = 0; i < 10; i++) insert.run(target, args);
  db.exec('COMMIT');
  const before = { sqliteBytes: bytes(db), indexes: indexes(db) }; db.close(); db = undefined;
  const open = module => {
    const memoryBefore = process.memoryUsage(), peakBeforeKiB = process.resourceUsage().maxRSS;
    const cpuStart = process.cpuUsage(), start = performance.now();
    store = module.openCoreStore(path); // Normal production pragmas, including durability.
    const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    const memoryAfter = process.memoryUsage(), peakAfterKiB = process.resourceUsage().maxRSS;
    assert.equal(store.lastAuditSeq(), seq, 'index installation must not add authority events');
    assert.deepEqual(store.listCommands({ beeId: target }).map(c => c.id), Array.from({ length: 10 }, (_, i) => 100001 + i));
    store.close(); store = undefined;
    return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000, memoryBefore, memoryAfter, peakBeforeKiB, peakAfterKiB };
  };
  const oldOpen = open(modules[0]);
  const firstOpen = open(modules[1]);
  const repeatOpen = Array.from({ length: 5 }, () => open(modules[1]));
  db = new DatabaseSync(path);
  const after = { sqliteBytes: bytes(db), indexes: indexes(db) };
  for (const name of ['commands_by_bee', 'commands_by_bee_status']) {
    assert.ok(!before.indexes.some(index => index.name === name), 'baseline must precede new indexes');
    assert.ok(after.indexes.some(index => index.name === name), 'candidate must install both indexes');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commands').get().n, 100010);
  db.close(); db = undefined;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ schemaVersion: 1, completed: true, roots, revisions, timestamp: new Date().toISOString(),
    sourceHashes: roots.map(root => Object.fromEntries(['store.ts', 'schema.ts'].map(name => [name, digest(join(root, 'v2/core/src', name))]))),
    toolSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('./report.mjs', import.meta.url))).digest('hex'),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostname: hostname(), loadAfter: loadavg() },
    workload: { unrelatedCommands: 100000, targetCommands: 10, uuidBeeIds: true, reasonChars: 256, normalOpenPragmas: true },
    before, after, oldOpen, firstOpen, repeatOpen,
    repeatSummary: { wallMs: distribution(repeatOpen.map(r => r.wallMs)), cpuMs: distribution(repeatOpen.map(r => r.cpuMs)) },
    scope: 'Existing database first opened by baseline, then candidate; warm filesystem caches. First candidate open includes index construction. One upgrade sample, not a tail estimate. UUID-sized IDs complement the short-ID query fixture. Synthetic seed is not production enqueue latency.' }, null, 2) + '\n');
  console.log(out);
} finally { store?.close(); db?.close(); rmSync(fixture, { recursive: true, force: true }); }
