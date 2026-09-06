#!/usr/bin/env node
// Synthetic settled history, queried through the real public CoreStore API.
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

const root = resolve(process.argv[2] ?? '.');
const out = resolve(process.argv[3] ?? '.artifacts/performance/command-history.json');
const prototype = process.argv[4] ?? 'none';
const prototypes = {
  none: [],
  history: ['CREATE INDEX IF NOT EXISTS perf_commands_bee ON commands(bee_id,id)'],
  status: ['CREATE INDEX IF NOT EXISTS perf_commands_bee_status ON commands(bee_id,status,id)'],
  both: ['CREATE INDEX IF NOT EXISTS perf_commands_bee ON commands(bee_id,id)', 'CREATE INDEX IF NOT EXISTS perf_commands_bee_status ON commands(bee_id,status,id)'],
};
assert.ok(Object.hasOwn(prototypes, prototype), 'prototype must be none, history, status, or both');
const { openCoreStore } = await import(pathToFileURL(join(root, 'v2/core/src/index.ts')).href);
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
assert.equal(revision.status, 0);
const report = { schemaVersion: 1, completed: false, prototype, prototypeSql: prototypes[prototype], revision: revision.stdout.trim(),
  sourceHashes: Object.fromEntries(['store.ts', 'schema.ts'].map(name => [name, digest(join(root, 'v2/core/src', name))])),
  toolSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('./report.mjs', import.meta.url))).digest('hex'),
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostname: hostname(), loadBefore: loadavg() },
  workload: { cases: [1000, 10000, 100000].map(unrelatedCommands => ({ name: `unrelated-${unrelatedCommands}`, unrelatedCommands, targetCommands: 10 })).concat([{ name: 'own-100000', unrelatedCommands: 1000, targetCommands: 100000 }]), unrelatedBees: 100, samples: 25, warmups: 3, reasonChars: 256 }, results: [],
  scope: 'Real CoreStore reads and reconfigure no-op; direct SQL seeds synthetic settled commands while the store is closed. Insert cost is one fixture transaction with synchronous OFF, not production durable command latency. Storage is allocated SQLite pages after close, not WAL peak. No live daemon state is accessed.' };
mkdirSync(dirname(out), { recursive: true });
const fixture = mkdtempSync(join(tmpdir(), 'hb-command-history-'));
let store, db;
function measure(fn) {
  for (let i = 0; i < report.workload.warmups; i++) fn();
  const raw = [];
  for (let i = 0; i < report.workload.samples; i++) {
    const startCpu = process.cpuUsage(), start = performance.now(); fn();
    const wallMs = performance.now() - start, cpu = process.cpuUsage(startCpu);
    raw.push({ wallMs, cpuMs: (cpu.user + cpu.system) / 1000 });
  }
  return { raw, wallMs: distribution(raw.map(r => r.wallMs)), cpuMs: distribution(raw.map(r => r.cpuMs)) };
}
try {
  for (const scenario of report.workload.cases) {
    const size = scenario.unrelatedCommands;
    const path = join(fixture, `${scenario.name}.sqlite3`);
    store = openCoreStore(path, { ephemeral: true });
    store.createBee({ id: 'target', name: 'target', handle: 'PF.target', agent: 'stub', substrate: 'hsr', cwd: fixture });
    store.updateRuntimeState('target', 1, 'stopped', { exitCause: 'clean' });
    store.close(); store = undefined;
    db = new DatabaseSync(path);
    db.exec('PRAGMA synchronous=OFF');
    for (const sql of prototypes[prototype]) db.exec(sql);
    const insert = db.prepare("INSERT INTO commands(verb,bee_id,args,target_generation,status,attempts,next_attempt_at,enqueued_at,finished_at) VALUES('stop',?,?,1,'done',1,0,0,1)");
    const args = JSON.stringify({ reason: 'x'.repeat(report.workload.reasonChars) });
    const insertCpu = process.cpuUsage(), insertStart = performance.now();
    db.exec('BEGIN');
    for (let i = 0; i < size; i++) insert.run(`unrelated-${i % 100}`, args);
    for (let i = 0; i < scenario.targetCommands; i++) insert.run('target', args);
    db.exec('COMMIT');
    const insertWallMs = performance.now() - insertStart, used = process.cpuUsage(insertCpu);
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM commands WHERE bee_id = ? ORDER BY id').all('target');
    // These exact production query shapes can choose a different index after DDL.
    const queries = {
      wake: ["SELECT * FROM commands WHERE bee_id = ? AND verb = 'send_wake' AND status IN ('queued','running') AND target_generation = ? LIMIT 1", ['target', 1]],
      deletePending: ["SELECT id FROM commands WHERE bee_id = ? AND status IN ('queued','running') ORDER BY id", ['target']],
    };
    const source = readFileSync(join(root, 'v2/core/src/store.ts'), 'utf8').replace(/\s+/g, ' ');
    const pendingProbes = Object.fromEntries(Object.entries(queries).map(([name, [sql, params]]) => {
      assert.ok(source.includes(sql), `production query changed: ${name}`);
      const query = db.prepare(sql);
      return [name, { plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params), ...measure(() => assert.deepEqual(query.all(...params), [])) }];
    }));
    const sqliteBytes = Number(db.prepare('PRAGMA page_count').get().page_count) * Number(db.prepare('PRAGMA page_size').get().page_size);
    db.close(); db = undefined;
    const openStart = performance.now(); store = openCoreStore(path, { ephemeral: true });
    const reopenMs = performance.now() - openStart, seq = store.lastAuditSeq();
    const expected = Array.from({ length: scenario.targetCommands }, (_, i) => size + i + 1);
    const reads = measure(() => assert.deepEqual(store.listCommands({ beeId: 'target' }).map(c => c.id), expected));
    const missing = measure(() => assert.deepEqual(store.listCommands({ beeId: 'missing' }), []));
    const queued = measure(() => assert.deepEqual(store.listCommands({ beeId: 'target', status: 'queued' }), []));
    const reconfigure = measure(() => assert.equal(store.reconfigureBee('target', null).outcome, 'unchanged'));
    assert.equal(store.lastAuditSeq(), seq, 'reads/no-ops must not append authority changes');
    store.close(); store = undefined;
    report.results.push({ ...scenario, insertWallMs, insertCpuMs: (used.user + used.system) / 1000, sqliteBytes, reopenMs, plan, pendingProbes, reads, missing, queued, reconfigure });
  }
  report.environment.loadAfter = loadavg(); report.completed = true;
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(out);
} finally { store?.close(); db?.close(); rmSync(fixture, { recursive: true, force: true }); }
