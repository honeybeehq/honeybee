import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname, loadavg } from 'node:os';
import { HiveDaemon } from '../../v2/daemon/src/daemon.ts';
import { loadNodeConfig } from '../../v2/daemon/src/config.ts';
import { makeDaemonDir, sleep, waitFor } from '../../v2/daemon/tests/helpers.ts';
import { RpcClient } from '../../v2/cli/src/client.ts';

const output = resolve(process.argv[2] ?? '.proof/mail-wake/run.json');
const rig = makeDaemonDir({ tickMs: 200 });
const daemon = new HiveDaemon(loadNodeConfig(rig.dir), { keychainReader: async () => null });
const report = { host: hostname(), runtime: process.version, load: loadavg(), fixture: rig.dir, tickMs: 200, samples: [], idle: [], errors: [] };
let client;
try {
  await daemon.start();
  client = await RpcClient.connect(loadNodeConfig(rig.dir).socketPath);
  const { beeId } = await client.request('spawn', { name: 'mail-wake', agent: 'stub', cwd: rig.dir });
  await waitFor(async () => (await client.request('view', { beeId })).runtime?.state === 'idle', 'stub idle');
  const events = new Map();
  client.onEvent = frame => {
    assert.equal(frame.type, 'delta');
    for (const row of frame.events) {
      if (row.kind === 'mail.delivered') events.set(row.payload.messageId, performance.now());
    }
  };
  await client.request('watch', {});
  for (let i = 0; i < 30; i++) {
    await sleep((i * 37) % 200);
    const start = performance.now();
    const sent = await client.request('send', { beeId, body: `generated-${i}`, idempotencyKey: `sample-${i}` });
    const acceptedMs = performance.now() - start;
    await waitFor(() => events.has(sent.messageId), 'mail delivered watch');
    const messages = (await client.request('mailbox', { beeId })).messages;
    const delivered = messages.find(row => row.id === sent.messageId);
    assert.ok(delivered.deliveredAt !== null);
    report.samples.push({ i, messageId: sent.messageId, acceptedMs, deliveredWatchMs: events.get(sent.messageId) - start, durableDeliveryMs: delivered.deliveredAt - delivered.enqueuedAt });
    await waitFor(async () => (await client.request('view', { beeId })).runtime?.state === 'idle', 'turn idle');
  }
  for (let i = 0; i < 5; i++) {
    const cpu = process.cpuUsage(), usage = process.resourceUsage(), start = performance.now(), tickEpoch = daemon.tickEpoch;
    await sleep(2000);
    const elapsedMs = performance.now() - start, delta = process.cpuUsage(cpu), end = process.resourceUsage();
    report.idle.push({ elapsedMs, cpuMs: (delta.user + delta.system) / 1000, tickCallbacks: daemon.tickEpoch - tickEpoch, voluntaryContextSwitches: end.voluntaryContextSwitches - usage.voluntaryContextSwitches, involuntaryContextSwitches: end.involuntaryContextSwitches - usage.involuntaryContextSwitches });
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  client?.close();
  await daemon.shutdown({ preserveRuntimes: false });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, n: report.samples.length, errors: report.errors }));
}
