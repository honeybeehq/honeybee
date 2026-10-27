import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, loadavg } from 'node:os';
import { createConnection } from 'node:net';
import { createHash } from 'node:crypto';
import { openCoreStore } from '../../v2/core/src/index.ts';
import { makeDaemonDir, startDaemon } from '../../v2/daemon/tests/helpers.ts';
import { RpcClient } from '../../v2/cli/src/client.ts';
import { PROTOCOL } from '../../v2/daemon/src/protocol.ts';
import { seedStore } from './fixtures.mjs';

const outFlag = process.argv.indexOf('--out');
if (outFlag >= 0 && !process.argv[outFlag + 1]) throw new Error('--out requires a path');
const out = resolve(outFlag < 0 ? '.proof/watch/run.json' : process.argv[outFlag + 1]);
mkdirSync(dirname(out), { recursive: true });
const rig = makeDaemonDir({ tickMs: 1000 });
const body = 'Generated review evidence, no real user data.\n'.repeat(450).slice(0, 19000);
const store = openCoreStore(join(rig.dir, 'core.sqlite3'));
seedStore(store, 1000);
store.transact(() => {
  for (let i = 0; i < 1000; i++) store.createSeal(`perf-${i}`, { id: `seal-${i}`, title: `Generated result ${i}`, body });
});
const seededSeq = store.lastAuditSeq();
let seq;
store.close();
const report = { protocol: 1, host: hostname(), runtime: process.version, model: process.platform, loadBefore: loadavg(), fixture: rig.dir, seededSeq, samples: [], warmups: [], errors: [] };
let daemon;
let expectedHash;
function validate(frame) {
  assert.equal(frame.ok, true);
  const snap = frame.result;
  seq ??= snap.seq;
  assert.equal(snap.seq, seq);
  assert.equal(snap.views.length, 1000);
  assert.equal(snap.seals.length, 1000);
  assert.ok(snap.seals.every(s => s.body === body));
  const hash = createHash('sha256').update(JSON.stringify(snap)).digest('hex');
  expectedHash ??= hash;
  assert.equal(hash, expectedHash);
  return snap;
}
async function raw(mode) {
  return new Promise((resolveSample, reject) => {
    const socket = createConnection(daemon.socketPath);
    socket.setEncoding('utf8');
    let hello = '', buffer = '', chunks = [], started, firstByteMs, bytes = 0, callbacks = 0, scannedChars = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`${mode} timeout`)); }, 30000);
    socket.on('error', error => { clearTimeout(timer); socket.destroy(); reject(error); });
    socket.on('data', chunk => {
      try {
        if (started === undefined) {
          hello += chunk;
          const nl = hello.indexOf('\n');
          if (nl < 0) return;
          assert.equal(JSON.parse(hello.slice(0, nl)).protocol, PROTOCOL);
          socket.write(JSON.stringify({ protocol: PROTOCOL }) + '\n');
          started = performance.now();
          socket.write(JSON.stringify({ id: 1, verb: 'watch', params: {} }) + '\n');
          return;
        }
        firstByteMs ??= performance.now() - started;
        callbacks++;
        bytes += Buffer.byteLength(chunk);
        let complete;
        if (mode === 'accumulate') {
          buffer += chunk;
          scannedChars += buffer.length;
          complete = buffer.indexOf('\n') >= 0;
        } else {
          chunks.push(chunk);
          scannedChars += chunk.length;
          complete = chunk.indexOf('\n') >= 0;
        }
        if (!complete) return;
        const lastByteMs = performance.now() - started;
        clearTimeout(timer);
        socket.destroy();
        const parseAt = performance.now();
        const frame = JSON.parse(mode === 'accumulate' ? buffer : chunks.join(''));
        const parseMs = performance.now() - parseAt;
        const snap = validate(frame);
        report.breakdown ??= Object.fromEntries(Object.entries(snap).map(([key, value]) => [key, { rows: Array.isArray(value) ? value.length : null, bytes: Buffer.byteLength(JSON.stringify(value)) }]));
        resolveSample({ mode, bytes, callbacks, scannedChars, firstByteMs, lastByteMs, parseMs });
      } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
    });
  });
}
async function production() {
  const client = await RpcClient.connect(daemon.socketPath);
  let firstByteMs, lastByteMs, bytes = 0;
  const start = performance.now();
  client.socket.prependListener('data', chunk => {
    firstByteMs ??= performance.now() - start;
    lastByteMs = performance.now() - start;
    bytes += Buffer.byteLength(chunk);
  });
  try {
    const snapshot = await client.request('watch', {}, 30000);
    const resolvedMs = performance.now() - start;
    validate({ ok: true, result: snapshot });
    return { mode: 'RpcClient', firstByteMs, lastByteMs, bytes, resolvedMs };
  } finally { client.close(); }
}
try {
  daemon = await startDaemon(rig.dir, { env: { HOME: rig.dir, CODEX_HOME: join(rig.dir, 'codex'), CLAUDE_CONFIG_DIR: join(rig.dir, 'claude') } });
  report.daemonPid = daemon.proc.pid;
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  for (const mode of ['accumulate', 'chunks']) report.warmups.push(await raw(mode));
  report.warmups.push(await production());
  for (let round = 0; round < 5; round++) {
    for (const mode of round % 2 ? ['chunks', 'accumulate'] : ['accumulate', 'chunks']) {
      const sample = { round, ...await raw(mode) };
      report.samples.push(sample);
      console.log(JSON.stringify(sample));
    }
    const sample = { round, ...await production() };
    report.samples.push(sample);
    console.log(JSON.stringify(sample));
  }
} catch (error) {
  report.errors.push(String(error.stack ?? error));
  process.exitCode = 1;
} finally {
  if (daemon) await daemon.stop();
  report.loadAfter = loadavg();
  report.hash = expectedHash;
  report.daemonStopped = daemon ? daemon.proc.exitCode !== null || daemon.proc.signalCode !== null : null;
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ out, errors: report.errors, breakdown: report.breakdown }));
}
