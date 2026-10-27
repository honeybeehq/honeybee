import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname, loadavg } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openCoreStore } from '../../v2/core/src/index.ts';
import { HiveDaemon } from '../../v2/daemon/src/daemon.ts';
import { loadNodeConfig } from '../../v2/daemon/src/config.ts';
import { makeDaemonDir, sleep, waitFor } from '../../v2/daemon/tests/helpers.ts';
import { RpcClient } from '../../v2/cli/src/client.ts';
import { seedStore } from './fixtures.mjs';

const [arm, outputText] = process.argv.slice(2);
assert.ok(['before', 'after-provisional', 'after-final'].includes(arm));
assert.ok(outputText);
const output = resolve(outputText);
mkdirSync(dirname(output), { recursive: true });
const rig = makeDaemonDir({ tickMs: 200 });
const report = { arm, instrumented: true, host: hostname(), runtime: process.version, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceBlob: execFileSync('git', ['hash-object', 'v2/daemon/src/daemon.ts'], { encoding: 'utf8' }).trim(), sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', '--', 'v2/daemon/src/daemon.ts'])).digest('hex'), fixture: rig.dir, generatedStoppedBees: 9733, additionalInboxBees: 1, loadBefore: loadavg(), cases: [], errors: [] };
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const seed = openCoreStore(resolve(rig.dir, 'core.sqlite3'));
const seedStart = performance.now();
seedStore(seed, 9733);
seed.createBee({ id: 'burst-inbox', name: 'burst-inbox', handle: 'BI.0', agent: 'inbox', substrate: 'hsr', cwd: '/tmp' });
seed.close();
report.seedMs = performance.now() - seedStart;
const daemon = new HiveDaemon(loadNodeConfig(rig.dir), { keychainReader: async () => null });
let client, activeCase;
const ticks = [];
const nativeTick = daemon.tick.bind(daemon);
daemon.tick = () => {
  const start = performance.now(), cpu = process.cpuUsage();
  try { return nativeTick(); }
  finally {
    const delta = process.cpuUsage(cpu);
    ticks.push({ case: activeCase ?? 'outside', wallMs: performance.now() - start, cpuMs: (delta.user + delta.system) / 1000 });
  }
};
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
};
try {
  persist();
  await daemon.start();
  client = await RpcClient.connect(loadNodeConfig(rig.dir).socketPath);
  const events = new Map();
  let seq;
  client.onEvent = frame => {
    try {
      assert.equal(frame.type, 'delta');
      assert.equal(frame.baseSeq, seq);
      seq = frame.seq;
      for (const row of frame.events) if (row.kind === 'mail.enqueued') events.set(row.payload.message.id, performance.now());
    } catch (error) { report.errors.push(String(error)); }
  };
  seq = (await client.request('watch', {}, 30000)).seq;
  await sleep(500);
  for (const paceMs of [0, 10]) {
    const result = { name: paceMs ? 'paced-10ms' : 'back-to-back', paceMs, acceptedMs: [], messageIds: [], failed: [] };
    report.cases.push(result);
    activeCase = result.name;
    const start = performance.now(), cpu = process.cpuUsage(), epoch = daemon.tickEpoch, tickIndex = ticks.length;
    for (let i = 0; i < 100; i++) {
      if (i && paceMs) await sleep(paceMs);
      const requestStart = performance.now();
      try {
        const sent = await client.request('send', { beeId: 'burst-inbox', body: `generated-${paceMs}-${i}`, idempotencyKey: `burst-${paceMs}-${i}` });
        result.acceptedMs.push(performance.now() - requestStart);
        result.messageIds.push(sent.messageId);
      } catch (error) { result.failed.push({ i, error: String(error.stack ?? error) }); }
    }
    result.submissionSpanMs = performance.now() - start;
    await waitFor(() => result.messageIds.every(id => events.has(id)), 'all enqueues visible', 30000);
    result.settledWallMs = performance.now() - start;
    const delta = process.cpuUsage(cpu);
    result.cpuMs = (delta.user + delta.system) / 1000;
    result.tickEpochDelta = daemon.tickEpoch - epoch;
    result.ticks = ticks.slice(tickIndex);
    result.tickWallMs = summary(result.ticks.map(t => t.wallMs));
    result.tickCpuMs = summary(result.ticks.map(t => t.cpuMs));
    result.acceptedSummaryMs = summary(result.acceptedMs);
    result.observedEnqueued = result.messageIds.filter(id => events.has(id)).length;
    const mailbox = (await client.request('mailbox', { beeId: 'burst-inbox' })).messages;
    assert.ok(result.messageIds.every(id => mailbox.some(row => row.id === id && row.deliveredAt === null)));
    assert.equal(result.failed.length, 0);
    assert.equal(result.messageIds.length, 100);
    persist();
    activeCase = undefined;
    await sleep(500);
  }
} catch (error) { report.errors.push(String(error.stack ?? error)); process.exitCode = 1; }
finally {
  client?.close();
  await daemon.shutdown({ preserveRuntimes: false });
  report.ticks = ticks;
  report.stopped = true;
  report.loadAfter = loadavg();
  persist();
  console.log(JSON.stringify({ output, cases: report.cases.map(({ ticks, messageIds, acceptedMs, ...rest }) => rest), errors: report.errors }));
}
