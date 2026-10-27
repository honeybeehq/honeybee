import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, loadavg } from 'node:os';
import { openCoreStore } from '../../v2/core/src/index.ts';
import { makeDaemonDir, startDaemon, waitFor, sleep } from '../../v2/daemon/tests/helpers.ts';
import { seedStore } from './fixtures.mjs';
import { fileURLToPath } from 'node:url';

const outFlag = process.argv.indexOf('--out');
const out = resolve(outFlag < 0 ? '.proof/watch-overflow/run.json' : process.argv[outFlag + 1]);
const tickMs = Number(process.env.WATCH_TICK_MS ?? 10000);
const count = Number(process.env.WATCH_EVENTS ?? 512);
const payloadBytes = Number(process.env.WATCH_PAYLOAD_BYTES ?? 0);
const payload = 'Generated data. '.repeat(Math.ceil(payloadBytes / 16)).slice(0, payloadBytes);
const chunkSize = Number(process.env.WATCH_BURST_CHUNK ?? count);
const chunkPauseMs = Number(process.env.WATCH_BURST_DELAY_MS ?? 0);
mkdirSync(dirname(out), { recursive: true });
const rig = makeDaemonDir({ tickMs, watchMaxBatch: 256 });
const store = openCoreStore(join(rig.dir, 'core.sqlite3'));
seedStore(store, 1000);
const body = 'Generated evidence, no user data.\n'.repeat(600).slice(0, 19000);
store.transact(() => {
  for (let i = 0; i < 1000; i++) store.createSeal(`perf-${i}`, { id: `seal-${i}`, title: `Generated ${i}`, body });
});
store.close();
const report = { protocol: 1, workload: 'watch-overflow', host: hostname(), runtime: process.version, loadBefore: loadavg(), fixture: rig.dir, tickMs, count, payloadBytes, chunkSize, chunkPauseMs, samples: [], errors: [] };
let daemon, watcher, writer;
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
try {
  const diagnostics = process.env.WATCH_DIAGNOSTICS === '1';
  report.diagnostics = diagnostics;
  daemon = await startDaemon(rig.dir, { env: { HOME: join(rig.dir, 'home'), CODEX_HOME: join(rig.dir, 'codex'), CLAUDE_CONFIG_DIR: join(rig.dir, 'claude'), ...(diagnostics ? { NODE_OPTIONS: `--import=${fileURLToPath(new URL('./watch-overflow-observe.mjs', import.meta.url))}`, HIVE_WATCH_OBSERVE_OUT: out + '.daemon.json' } : {}) } });
  report.daemonPid = daemon.proc.pid;
  watcher = await daemon.client(); writer = await daemon.client();
  let cursor = (await watcher.request('watch', {}, 30000)).seq;
  for (let round = 0; round < 6; round++) {
    const sample = { round, warmup: round === 0, startSeq: cursor, gaps: 0, deltaBytes: 0, replacementSnapshotBytes: 0, frames: [], timerLatenessMs: 0 };
    let firstAt, finished = false, recovery;
    const started = performance.now();
    let expectedTimer = started + 5;
    const timer = setInterval(() => { const now = performance.now(); sample.timerLatenessMs = Math.max(sample.timerLatenessMs, now - expectedTimer); expectedTimer = now + 5; }, 5);
    watcher.onEvent = frame => {
      firstAt ??= performance.now();
      if (frame.type === 'gap') {
        sample.gaps++;
        recovery = watcher.request('snapshot', {}, 30000).then(snapshot => {
          sample.replacementSnapshotBytes += Buffer.byteLength(JSON.stringify({ id: 0, ok: true, result: snapshot }) + '\n');
          cursor = snapshot.seq; finished = true;
        });
      } else {
        assert.equal(frame.baseSeq, cursor);
        for (let i = 0; i < frame.events.length; i++) assert.equal(frame.events[i].seq, cursor + i + 1);
        if (payloadBytes) for (const event of frame.events) assert.equal(event.payload.seal.body, payload);
        cursor = frame.seq;
        const bytes = Buffer.byteLength(JSON.stringify(frame) + '\n');
        sample.deltaBytes += bytes;
        sample.frames.push({ baseSeq: frame.baseSeq, seq: frame.seq, rows: frame.events.length, bytes, atMs: performance.now() - firstAt });
        if (cursor >= sample.startSeq + count) finished = true;
      }
    };
    try {
      for (let offset = 0; offset < count; offset += chunkSize) {
        await Promise.all(Array.from({ length: Math.min(chunkSize, count - offset) }, (_, index) => {
          const i = offset + index;
          return payloadBytes
            ? writer.request('seal.create', { beeId: 'perf-0', id: `burst-${round}-${i}`, title: `Generated ${round} ${i}`, body: payload }, 30000)
            : writer.request('bee.rename', { beeId: 'perf-0', name: `generated-${round}-${i}` }, 30000);
        }));
        if (chunkPauseMs && offset + chunkSize < count) await sleep(chunkPauseMs);
      }
      sample.burstMs = performance.now() - started;
      await waitFor(() => finished, 'overflow catch-up', tickMs + 30000);
      await recovery;
      sample.catchupMs = performance.now() - firstAt;
      sample.endSeq = cursor;
      assert.ok(cursor >= sample.startSeq + count);
    } finally { clearInterval(timer); }
    report.samples.push(sample); save();
    console.log(JSON.stringify(sample));
  }
} catch (error) { report.errors.push(String(error.stack ?? error)); process.exitCode = 1; }
finally {
  watcher?.close(); writer?.close();
  if (daemon) await daemon.stop();
  report.daemonStopped = daemon ? daemon.proc.exitCode !== null || daemon.proc.signalCode !== null : null;
  report.loadAfter = loadavg(); save();
  console.log(JSON.stringify({ out, errors: report.errors, daemonStopped: report.daemonStopped }));
}
