import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { distribution } from './report.mjs';

const { root, samples, idleMs, scenario } = JSON.parse(process.argv[2]);
const importAt = performance.now();
const local = path => import(pathToFileURL(join(root, path)).href);
const { openCoreStore } = await local('v2/core/src/index.ts');
const { DaemonCore } = await local('v2/daemon/src/loops.ts');
const { FakeDriver, makeDaemonDir, sleep, waitFor } = await local('v2/daemon/tests/helpers.ts');
const metrics = {};
const raw = {};
const observations = { importsMs: performance.now() - importAt, memoryBefore: process.memoryUsage() };
function record(name, values, unit = 'ms') { raw[name] = values; metrics[name] = { unit, ...distribution(values) }; }
function measure(name, fn, count = samples) {
  for (let i = 0; i < 3; i++) fn();
  const wall = [], cpu = [];
  for (let i = 0; i < count; i++) {
    const c = process.cpuUsage(), t = performance.now();
    fn();
    wall.push(performance.now() - t);
    const used = process.cpuUsage(c); cpu.push((used.user + used.system) / 1000);
  }
  record(`${name}.wall`, wall); record(`${name}.cpu`, cpu);
}
async function measureAsync(name, fn, count = samples) {
  for (let i = 0; i < 3; i++) await fn();
  const wall = [];
  for (let i = 0; i < count; i++) { const t = performance.now(); await fn(); wall.push(performance.now() - t); }
  record(`${name}.wall`, wall);
}
function bytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += bytes(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}
function seed(store, bees, generations = 1) {
  store.transact(() => {
    for (let i = 0; i < bees; i++) {
      const id = `perf-${i}`;
      store.createBee({ id, name: id, handle: `PF.${i}`, agent: 'stub', substrate: 'hsr', cwd: '/tmp' });
      store.updateRuntimeState(id, 1, 'stopped', { exitCause: 'clean' });
      for (let gen = 2; gen <= generations; gen++) {
        const rt = store.reviveBee(id);
        store.updateRuntimeState(id, rt.generation, 'stopped', { exitCause: 'clean' });
      }
      if (i % 10 !== 0) store.archiveBee(id);
    }
  });
}
if (scenario.kind === 'core') {
  const dir = mkdtempSync(join(tmpdir(), 'hb-perf-'));
  let store;
  try {
    const path = join(dir, 'core.sqlite3');
    store = openCoreStore(path);
    seed(store, scenario.bees, scenario.generations);
    observations.auditRows = store.lastAuditSeq();
    observations.storageOpenBytes = bytes(dir);
    const rows = store.listBeeViewRows();
    assert.equal(rows.length, scenario.bees);
    assert.ok(rows.every(row => row.runtime.generation === scenario.generations && row.runtime.state === 'stopped'));
    const seq = store.lastAuditSeq();
    measure('view.all', () => assert.equal(store.listBeeViewRows().length, scenario.bees));
    measure('view.active', () => assert.equal(store.listBeeViewRows('active').length, Math.ceil(scenario.bees / 10)));
    measure('view.one', () => assert.equal(store.view('perf-0').generation, scenario.generations));
    measure('audit.tail', () => assert.ok(store.auditTail(0, 100).length <= 100));
    measure('mail.pending', () => assert.equal(store.listUndeliveredMessages().length, 0));
    const core = new DaemonCore({ store, driver: new FakeDriver(() => 1000), now: () => 1000, policy: { bootHangTimeoutSteps: 60000, commandsPerStep: 8, i1DeadlineSteps: 10000 }, onI1Violation: () => assert.fail('unexpected delivery violation'), log: () => {} });
    measure('core.quietStep', () => core.step());
    assert.equal(store.lastAuditSeq(), seq, 'quiet reads/ticks must not mutate authority');
    record('storage.open', [bytes(dir)], 'bytes');
    store.close(); store = undefined;
    measure('store.reopen', () => { const reopened = openCoreStore(path); reopened.close(); });
    record('storage.closed', [bytes(dir)], 'bytes');
    observations.memoryAfter = process.memoryUsage();
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
} else if (scenario.kind === 'cli') {
  const dir = mkdtempSync(join(tmpdir(), 'hb-perf-cli-'));
  try {
    writeFileSync(join(dir, 'FROZEN'), '');
    const times = [];
    for (let i = -3; i < samples; i++) {
      const t = performance.now();
      const p = spawnSync(process.execPath, [join(root, 'dist/cli.js'), '--help'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HIVE_STORE_ROOT: dir, HIVE_V2_DATA_DIR: dir, HIVE_NO_KEYCHAIN: '1' } });
      assert.equal(p.status, 0, p.stderr);
      assert.match(p.stdout, /hive/);
      if (i >= 0) times.push(performance.now() - t);
    }
    record('cli.helpProcess', times);
    observations.bundleBytes = statSync(join(root, 'dist/v2/cli.js')).size;
  } finally { rmSync(dir, { recursive: true, force: true }); }
} else {
  const { HiveDaemon } = await local('v2/daemon/src/daemon.ts');
  const { loadNodeConfig } = await local('v2/daemon/src/config.ts');
  const { RpcClient } = await local('v2/cli/src/client.ts');
  const { dir, cleanup } = makeDaemonDir({ tickMs: 200, naming: { auto: false } });
  let daemon, client;
  try {
    const store = openCoreStore(join(dir, 'core.sqlite3'));
    seed(store, scenario.bees);
    store.close();
    const cfg = loadNodeConfig(dir);
    daemon = new HiveDaemon(cfg);
    const start = performance.now();
    await daemon.start();
    client = await RpcClient.connect(cfg.socketPath);
    record('daemon.startToHello', [performance.now() - start]);
    const list = await client.request('list', { lifecycle: null });
    observations.listRows = list.views.length;
    await measureAsync('rpc.health', () => client.request('health'));
    await measureAsync('rpc.list', () => client.request('list'));
    await measureAsync('rpc.snapshot', () => client.request('snapshot'));
    const idleCPU = [], idleRSS = [], idleHeap = [], idleELU = [], idleLag = [];
    // Three real quiet windows include daemon timers but no client traffic.
    for (let i = 0; i < 3; i++) {
      const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
      const cpu = process.cpuUsage(), elu = performance.eventLoopUtilization(), t = performance.now();
      await sleep(idleMs);
      const wall = performance.now() - t, used = process.cpuUsage(cpu);
      idleCPU.push((used.user + used.system) / (wall * 10));
      idleELU.push(performance.eventLoopUtilization(elu).utilization * 100);
      idleLag.push(delay.percentile(99) / 1e6);
      idleRSS.push(process.memoryUsage().rss); idleHeap.push(process.memoryUsage().heapUsed);
      delay.disable();
    }
    record('idle.cpuOneCore', idleCPU, 'percent'); record('idle.eventLoopUtilization', idleELU, 'percent');
    record('idle.eventLoopDelayP99', idleLag); record('idle.rss', idleRSS, 'bytes'); record('idle.heapUsed', idleHeap, 'bytes');
    const spawnedAt = performance.now();
    const spawned = await client.request('spawn', { name: 'perf-stub', agent: 'stub', cwd: dir });
    await waitFor(async () => (await client.request('view', { beeId: spawned.beeId })).view.runtimeState === 'idle', 'stub boot', 60000);
    record('stub.spawnToIdle', [performance.now() - spawnedAt]);
    const delivery = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const sent = await client.request('send', { beeId: spawned.beeId, body: `performance message ${i}` });
      await waitFor(async () => (await client.request('mailbox', { beeId: spawned.beeId })).messages.some(m => m.id === sent.messageId && m.deliveredAt !== null), 'mail delivery', 30000);
      delivery.push(performance.now() - t);
      await waitFor(async () => (await client.request('view', { beeId: spawned.beeId })).view.runtimeState === 'idle', 'stub turn', 30000);
    }
    record('stub.sendToDelivered', delivery);
    const health = await client.request('health');
    assert.equal(health.tickErrors, 0); assert.equal(health.i1Violations, 0);
    observations.health = health;
    record('storage.open', [bytes(dir)], 'bytes');
    client.close(); client = undefined;
    const stop = performance.now(); await daemon.shutdown({ preserveRuntimes: false }); daemon = undefined;
    record('daemon.shutdown', [performance.now() - stop]);
    // Let the owned runner host finish its asynchronous teardown before cleanup.
    await sleep(1000);
    observations.memoryAfter = process.memoryUsage();
  } finally {
    client?.close(); await daemon?.shutdown({ preserveRuntimes: false });
    cleanup();
  }
}
console.log(JSON.stringify({ scenario: `${scenario.kind}-${scenario.bees}${scenario.generations ? `x${scenario.generations}` : ''}`, metrics, raw, observations }));
