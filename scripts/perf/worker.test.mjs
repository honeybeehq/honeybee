import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function until(fn, label) {
  const deadline = Date.now() + 45000;
  for (;;) { const value = fn(); if (value) return value; assert.ok(Date.now() < deadline, `timeout: ${label}`); await setTimeout(20); }
}
function startWorker() {
  const child = spawn(process.execPath, [resolve(root, 'scripts/perf/worker.mjs'), JSON.stringify({ root, samples: 3, idleMs: 100, scenario: { kind: 'daemon', bees: 0 } })], { cwd: root, env: { ...process.env, HIVE_NO_KEYCHAIN: '1', HIVE_PERF_DIR: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => stdout += text); child.stderr.on('data', text => stderr += text);
  const exited = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit({ code, signal })); });
  return { child, exited, stdout: () => stdout, stderr: () => stderr, fixture: () => {
    const line = stderr.split('\n').find(line => line.startsWith('{"event":"fixture"'));
    return line ? JSON.parse(line).dir : null;
  } };
}
function live(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

test('daemon worker completes a real stub workload and removes its owned fixture', { timeout: 60000 }, async t => {
  const worker = startWorker();
  t.after(async () => { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM'); await worker.exited; });
  const dir = await until(worker.fixture, 'fixture reported');
  const exit = await worker.exited;
  assert.equal(exit.code, 0, worker.stderr());
  const report = JSON.parse(worker.stdout());
  assert.equal(report.observations.health.tickErrors, 0);
  assert.equal(report.metrics['stub.sendToDelivered'].n, 5);
  assert.equal(existsSync(dir), false, 'owned data removed after host exit');
});

test('SIGTERM during an owned runtime cleans up detached hosts and the fixture', { timeout: 60000 }, async t => {
  const worker = startWorker();
  t.after(async () => { if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGTERM'); await worker.exited; });
  const dir = await until(worker.fixture, 'fixture reported');
  const pids = await until(() => {
    try {
      const statuses = readdirSync(join(dir, 'runners')).filter(name => name.endsWith('.status.json'));
      const pids = statuses.flatMap(name => { const row = JSON.parse(readFileSync(join(dir, 'runners', name), 'utf8')); return [row.hostPid, row.childPid].filter(pid => Number.isSafeInteger(pid) && pid > 0); });
      return pids.length > 0 && pids.some(live) ? pids : null;
    } catch { return null; }
  }, 'stub runner exists');
  worker.child.kill('SIGTERM');
  const exit = await worker.exited;
  assert.ok(exit.code === 143 || exit.code === 1, worker.stderr());
  assert.ok(pids.every(pid => !live(pid)), 'detached owned processes exited');
  assert.equal(existsSync(dir), false, 'owned data removed after interruption');
});
