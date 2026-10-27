import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hostname, loadavg } from 'node:os';
import { createConnection, createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HiveDaemon } from '../../v2/daemon/src/daemon.ts';
import { loadNodeConfig } from '../../v2/daemon/src/config.ts';
import { makeDaemonDir, sleep, waitFor } from '../../v2/daemon/tests/helpers.ts';
import { RpcClient } from '../../v2/cli/src/client.ts';
import { JsonLineBuffer } from '../../v2/daemon/src/jsonl.ts';

const [mode, address, portText, outputText, allowedAddress, arm] = process.argv.slice(2);
assert.ok(['owner', 'collector'].includes(mode), 'owner bind port output allowedIP | collector host port output');
const port = Number(portText);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
assert.ok(address && outputText);
assert.ok(['before', 'after'].includes(arm), 'sixth argument must name before or after arm');
const output = resolve(outputText);
mkdirSync(dirname(output), { recursive: true });
const report = { mode, arm, host: hostname(), runtime: process.version, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceBlob: execFileSync('git', ['hash-object', 'v2/daemon/src/daemon.ts'], { encoding: 'utf8' }).trim(), sourceDiffSha256: createHash('sha256').update(execFileSync('git', ['diff', '--', 'v2/daemon/src/daemon.ts'])).digest('hex'), load: loadavg(), tickMs: 200, samples: [], idle: [], errors: [] };
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n');

if (mode === 'owner') {
  assert.ok(allowedAddress && allowedAddress !== address);
  const rig = makeDaemonDir({ tickMs: 200 });
  const config = loadNodeConfig(rig.dir);
  const daemon = new HiveDaemon(config, { keychainReader: async () => null });
  const sockets = new Set();
  let finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  let idlePromise;
  const idle = () => idlePromise ??= (async () => {
    for (let i = 0; i < 5; i++) {
      const cpu = process.cpuUsage(), usage = process.resourceUsage(), start = performance.now(), tickEpoch = daemon.tickEpoch;
      await sleep(2000);
      const elapsedMs = performance.now() - start, delta = process.cpuUsage(cpu), end = process.resourceUsage();
      report.idle.push({ elapsedMs, cpuMs: (delta.user + delta.system) / 1000, tickCallbacks: daemon.tickEpoch - tickEpoch, voluntaryContextSwitches: end.voluntaryContextSwitches - usage.voluntaryContextSwitches, involuntaryContextSwitches: end.involuntaryContextSwitches - usage.involuntaryContextSwitches });
    }
    persist();
    return report.idle;
  })();
  const allowedVerbs = new Set(['spawn', 'view', 'watch', 'send', 'mailbox']);
  const server = createServer(tcp => {
    if (tcp.remoteAddress !== allowedAddress) { tcp.destroy(); return; }
    sockets.add(tcp);
    const unix = createConnection(config.socketPath);
    sockets.add(unix);
    const frames = new JsonLineBuffer();
    let handshake = false, received = 0;
    tcp.setEncoding('utf8');
    unix.pipe(tcp);
    const close = () => { tcp.destroy(); unix.destroy(); sockets.delete(tcp); sockets.delete(unix); };
    tcp.on('close', close); unix.on('close', close);
    tcp.on('error', close); unix.on('error', close);
    tcp.on('data', chunk => {
      received += Buffer.byteLength(chunk);
      if (received > 1024 * 1024) { close(); return; }
      try {
        for (const line of frames.push(chunk)) {
          const frame = JSON.parse(line);
          if (!handshake) {
            assert.equal(frame.protocol, 'v2/1');
            assert.deepEqual(Object.keys(frame), ['protocol']);
            handshake = true;
            unix.write(line + '\n');
          } else if (frame.verb === 'lab.idle') {
            idle().then(result => { if (!tcp.destroyed) tcp.write(JSON.stringify({ id: frame.id, ok: true, result }) + '\n'); }).catch(error => { report.errors.push(String(error.stack ?? error)); persist(); finish(); });
          } else if (frame.verb === 'lab.finish') {
            tcp.write(JSON.stringify({ id: frame.id, ok: true, result: { finishing: true } }) + '\n', finish);
          } else {
            assert.ok(allowedVerbs.has(frame.verb), `disallowed verb ${frame.verb}`);
            if (frame.verb === 'spawn') {
              assert.deepEqual(Object.keys(frame.params).sort(), ['agent', 'cwd', 'name']);
              assert.equal(frame.params.agent, 'stub');
              assert.equal(frame.params.cwd, '/tmp');
              assert.equal(frame.params.name, 'mail-wake');
            }
            unix.write(line + '\n');
          }
        }
      } catch (error) { report.errors.push(String(error)); persist(); close(); }
    });
  });
  const stop = () => finish();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await daemon.start();
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, address, yes); });
    Object.assign(report, { fixture: rig.dir, pid: process.pid, socketPath: config.socketPath, address, port, allowedAddress });
    persist();
    console.log(JSON.stringify({ ready: true, ...report }));
    await done;
  } catch (error) { report.errors.push(String(error.stack ?? error)); process.exitCode = 1; }
  finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(yes => server.close(yes));
    await daemon.shutdown({ preserveRuntimes: false });
    report.stopped = true;
    report.loadAfter = loadavg();
    persist();
  }
} else {
  let client;
  try {
    client = await RpcClient.connect({ host: address, port });
    const { beeId } = await client.request('spawn', { name: 'mail-wake', agent: 'stub', cwd: '/tmp' });
    await waitFor(async () => (await client.request('view', { beeId })).runtime?.state === 'idle', 'stub idle');
    const events = new Map();
    let sequence;
    client.onEvent = frame => {
      try {
        assert.equal(frame.type, 'delta');
        assert.equal(frame.baseSeq, sequence);
        sequence = frame.seq;
        for (const row of frame.events) if (row.kind === 'mail.delivered') events.set(row.payload.messageId, performance.now());
      } catch (error) { report.errors.push(String(error)); }
    };
    const snapshot = await client.request('watch', {});
    sequence = snapshot.seq;
    report.beeId = beeId;
    for (let i = 0; i < 30; i++) {
      await sleep((i * 37) % 200);
      const start = performance.now();
      const sent = await client.request('send', { beeId, body: `generated-${i}`, idempotencyKey: `sample-${i}` });
      const acceptedMs = performance.now() - start;
      await waitFor(() => events.has(sent.messageId), 'mail delivered watch');
      const messages = (await client.request('mailbox', { beeId })).messages;
      const delivered = messages.find(row => row.id === sent.messageId);
      assert.ok(delivered && delivered.deliveredAt !== null);
      report.samples.push({ i, messageId: sent.messageId, acceptedMs, deliveredWatchMs: events.get(sent.messageId) - start, durableDeliveryMs: delivered.deliveredAt - delivered.enqueuedAt });
      await waitFor(async () => (await client.request('view', { beeId })).runtime?.state === 'idle', 'turn idle');
      persist();
    }
    report.ownerIdle = await client.request('lab.idle', {}, 20000);
    await client.request('lab.finish', {});
  } catch (error) { report.errors.push(String(error.stack ?? error)); process.exitCode = 1; }
  finally { client?.close(); report.loadAfter = loadavg(); persist(); console.log(JSON.stringify({ output, n: report.samples.length, errors: report.errors })); }
}
