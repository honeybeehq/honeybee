#!/usr/bin/env node
// Repeated real host launches. A spec identifies two executable implementations.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { cpus, hostname, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { distribution } from './report.mjs';
import { parseProcessTable } from './process-tree.mjs';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = resolve(process.argv[3] ?? '.artifacts/performance/runner-host.json');
assert.equal(spec.implementations.length, 2);
assert.ok(Number.isSafeInteger(spec.rounds) && spec.rounds >= 2 && spec.rounds <= 100);
assert.ok(Number.isSafeInteger(spec.idleMs) && spec.idleMs >= 0 && spec.idleMs <= 60000);
for (const impl of spec.implementations) {
  assert.ok(typeof impl.name === 'string' && Array.isArray(impl.args));
  assert.ok(impl.args.every(x => typeof x === 'string'));
  assert.ok(Array.isArray(impl.nodeArgs ?? []) && (impl.nodeArgs ?? []).every(x => typeof x === 'string'));
  assert.ok(existsSync(impl.entry));
  assert.ok(Array.isArray(impl.dependencies ?? []));
  for (const dependency of impl.dependencies ?? []) assert.ok(typeof dependency === 'string' && existsSync(dependency));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function within(promise, ms, timeout) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => { try { resolve(timeout()); } catch (error) { reject(error); } }, ms); })]); }
  finally { clearTimeout(timer); }
}
const fixture = mkdtempSync(join(tmpdir(), 'hb-host-perf-'));
process.stderr.write(JSON.stringify({ event: 'fixture', dir: fixture }) + '\n');
const active = new Set();
let cleaning;
async function stop(item) {
  if (item.child.exitCode === null && item.child.signalCode === null) {
    // Still an unreaped child of this process: its PID cannot have been reused.
    try { process.kill(-item.child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const ended = await within(item.exit.then(() => true), 3000, () => false);
    if (!ended && item.child.exitCode === null && item.child.signalCode === null) process.kill(-item.child.pid, 'SIGKILL');
  }
  await item.exit;
  active.delete(item);
}
async function cleanup() {
  cleaning ??= (async () => { for (const item of active) await stop(item); rmSync(fixture, { recursive: true, force: true }); })();
  await cleaning;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { void cleanup().then(() => process.exit(code), () => process.exit(1)); });
}
function processRow(pid) {
  const p = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,ppid=,rss=,time=,lstart='], { encoding: 'utf8' });
  assert.equal(p.status, 0, 'owned host must be alive when sampled');
  return parseProcessTable(p.stdout)[0];
}
const raw = spec.implementations.map(() => []);
const environment = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostname: hostname(), loadBefore: loadavg() };
const artifact = path => ({ path, bytes: statSync(path).size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
const implementations = spec.implementations.map(impl => ({ ...impl, entryBytes: statSync(impl.entry).size, entrySha256: createHash('sha256').update(readFileSync(impl.entry)).digest('hex'),
  dependencyArtifacts: (impl.dependencies ?? []).map(artifact) }));
async function launch(side, serial, record) {
  const dir = join(fixture, String(serial)); mkdirSync(dir);
  const config = { beeId: `perf-${serial}`, generation: 1, command: process.execPath, args: [resolve(spec.agent)], cwd: dir,
    env: { PATH: process.env.PATH, STUB_TURN_MS: '5' }, sessionLogPath: join(dir, 'session.jsonl'), observationLogPath: join(dir, 'observations.jsonl'),
    sidecarPath: join(dir, 'stderr.log'), socketPath: join(fixture, `${serial}.sock`), statusPath: join(dir, 'status.json'), bootLines: [] };
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, JSON.stringify(config));
  const impl = implementations[side];
  const started = performance.now();
  const child = spawn(process.execPath, [...(impl.nodeArgs ?? []), impl.entry, ...impl.args, configPath], { detached: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, HIVE_STORE_ROOT: fixture, HIVE_V2_DATA_DIR: fixture, HIVE_NO_KEYCHAIN: '1', HIVE_PERF_DIR: '', NODE_COMPILE_CACHE: join(fixture, `compile-${side}`) } });
  let stderr = ''; child.stderr.on('data', b => { if (stderr.length < 8192) stderr += b; });
  const item = { child, exit: new Promise((res, rej) => { child.once('exit', (code, signal) => res({ code, signal })); child.once('error', rej); }) };
  active.add(item);
  try {
    let hostReadyMs, agentReadyMs;
    while (agentReadyMs === undefined) {
      assert.ok(performance.now() - started < 30000, `host boot timeout: ${stderr}`);
      assert.ok(child.exitCode === null && child.signalCode === null, `host exited early: ${stderr}`);
      try {
        const status = JSON.parse(readFileSync(config.statusPath, 'utf8'));
        assert.ok(!status.spawnError && !status.socketError);
        if (status.agentPid && hostReadyMs === undefined) hostReadyMs = performance.now() - started;
      } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      try {
        if (readFileSync(config.observationLogPath, 'utf8').split('\n').some(line => line && JSON.parse(line).event === 'ready')) agentReadyMs = performance.now() - started;
      } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
      if (agentReadyMs === undefined) await sleep(5);
    }
    assert.ok(hostReadyMs !== undefined);
    const before = processRow(child.pid), idleAt = performance.now();
    if (spec.idleMs) await sleep(spec.idleMs);
    const idleWallMs = performance.now() - idleAt, after = processRow(child.pid);
    assert.equal(after.birth, before.birth);
    const socket = connect(config.socketPath);
    await new Promise((res, rej) => { socket.once('error', rej); socket.once('connect', res); });
    socket.end(JSON.stringify({ op: 'write', line: JSON.stringify({ type: 'message', id: 1, body: '@exit' }) }) + '\n');
    const exited = await within(item.exit, 10000, () => { throw new Error('host clean exit timeout'); });
    assert.equal(exited.code, 0, stderr);
    const events = readFileSync(config.observationLogPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(e => e.event === 'ready').length, 1);
    assert.equal(events.filter(e => e.event === 'turn_ended' && e.messageId === 1).length, 1);
    const status = JSON.parse(readFileSync(config.statusPath, 'utf8'));
    assert.equal(status.exited, true);
    assert.equal(status.exitCode, 0);
    if (record) raw[side].push({ hostReadyMs, agentReadyMs, hostRssBytes: before.rssBytes, hostCpuToReadyMs: before.cpuSeconds * 1000,
      ...(spec.idleMs ? { idleCpuOneCorePercent: (after.cpuSeconds - before.cpuSeconds) * 100000 / idleWallMs } : {}), hostRssAfterIdleBytes: after.rssBytes });
  } finally { await stop(item); }
}
try {
  let serial = 0;
  for (let i = 0; i < 2; i++) for (const side of [0, 1]) await launch(side, serial++, false);
  for (let round = 0; round < spec.rounds; round++) {
    process.stderr.write(`Host pair ${round + 1}/${spec.rounds}\n`);
    for (const side of round % 2 ? [1, 0] : [0, 1]) await launch(side, serial++, true);
  }
  const results = raw.map((samples, i) => ({ implementation: implementations[i], metrics: Object.fromEntries(Object.keys(samples[0]).map(key => [key, distribution(samples.map(s => s[key]))])), raw: samples }));
  environment.loadAfter = loadavg(); mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ schemaVersion: 1, timestamp: new Date().toISOString(), spec, environment, results,
    toolSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    scope: 'Alternating fresh real hosts, two warmups per side; 5ms polling; warm per-side compile cache; host-only ps RSS/CPU, OS-quantized CPU; same stub; no provider inference. RSS is not private memory.' }, null, 2) + '\n');
  console.log(out);
} finally { await cleanup(); }
