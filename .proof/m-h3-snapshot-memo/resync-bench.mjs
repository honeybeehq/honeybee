import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname, loadavg } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');

async function watchOnce(RpcClient, socketPath, verb = 'watch', client = null) {
  const own = client === null;
  if (own) client = await RpcClient.connect(socketPath, 10_000);
  const meter = { bytes: 0, chunks: 0, firstByteMs: null, lastByteMs: null };
  const start = performance.now();
  const onData = (chunk) => { const at = performance.now() - start; meter.firstByteMs ??= at; meter.lastByteMs = at; meter.bytes += Buffer.byteLength(chunk); meter.chunks += 1; };
  client.socket.prependListener('data', onData);
  const snap = await client.request(verb, {}, 60_000);
  const resolvedMs = performance.now() - start;
  client.socket.removeListener('data', onData);
  if (own) client.close();
  return { snap, sample: { resolvedMs, firstByteMs: meter.firstByteMs, lastByteMs: meter.lastByteMs, bytes: meter.bytes, chunks: meter.chunks } };
}

if (!isMainThread) {
  const { RpcClient } = await import(pathToFileURL(join(workerData.repo, 'v2/cli/src/client.ts')).href);
  const client = await RpcClient.connect(workerData.socketPath, 10_000);
  parentPort.postMessage({ ready: true });
  await new Promise((go) => parentPort.once('message', go));
  const { snap, sample } = await watchOnce(RpcClient, workerData.socketPath, 'watch', client);
  const parseAt = performance.now();
  const hash = digest(snap);
  parentPort.postMessage({ ...sample, seq: snap.seq, views: snap.views.length, hash, fieldHashes: Object.fromEntries(Object.entries(snap).map(([key, value]) => [key, digest(value)])), hashMs: performance.now() - parseAt });
} else {
  function flag(name, fallback) {
    const at = process.argv.indexOf(name);
    if (at < 0) return fallback;
    if (!process.argv[at + 1]) throw new Error(`${name} requires a value`);
    return process.argv[at + 1];
  }
  const repo = resolve(flag('--repo', '.'));
  const bees = Number(flag('--bees', '300'));
  const clients = Number(flag('--clients', '8'));
  const rounds = Number(flag('--rounds', '5'));
  const out = resolve(flag('--out', '.proof/m-h3-snapshot-memo/run.json'));
  const seedIn = flag('--seed', null);
  const seedOut = flag('--seed-out', null);
  const perfDir = flag('--perf-dir', null) ? resolve(flag('--perf-dir', null)) : null;
  if (perfDir) mkdirSync(perfDir, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });

  const mod = (rel) => import(pathToFileURL(join(repo, rel)).href);
  const helpers = await mod('v2/daemon/tests/helpers.ts');
  const { openCoreStore } = await mod('v2/core/src/index.ts');
  const { seedStore } = await mod('scripts/perf/fixtures.mjs');
  const { RpcClient } = await mod('v2/cli/src/client.ts');
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const rig = helpers.makeDaemonDir({ tickMs: 1000 });
  const storePath = join(rig.dir, 'core.sqlite3');
  if (seedIn) {
    copyFileSync(resolve(seedIn), storePath);
  } else {
    const store = openCoreStore(storePath);
    seedStore(store, bees);
    const body = 'Generated review evidence, no real user data.\n'.repeat(60).slice(0, 2000);
    store.transact(() => {
      for (let i = 0; i < bees; i++) store.createSeal(`perf-${i}`, { id: `seal-${i}`, title: `Generated result ${i}`, body });
    });
    store.close();
    if (seedOut) { mkdirSync(dirname(resolve(seedOut)), { recursive: true }); copyFileSync(storePath, resolve(seedOut)); for (const suffix of ['-wal', '-shm']) if (existsSync(storePath + suffix)) copyFileSync(storePath + suffix, resolve(seedOut) + suffix); }
  }

  const hashes = new Set();
  const fieldHashes = {};
  let seq;
  let breakdown;
  function record(snap) {
    seq ??= snap.seq;
    if (snap.seq !== seq) throw new Error(`seq moved ${seq} -> ${snap.seq}`);
    if (snap.views.length !== bees) throw new Error(`views ${snap.views.length} != ${bees}`);
    hashes.add(digest(snap));
    for (const [key, value] of Object.entries(snap)) (fieldHashes[key] ??= new Set()).add(digest(value));
    breakdown ??= Object.fromEntries(Object.entries(snap).map(([key, value]) => [key, { rows: Array.isArray(value) ? value.length : null, bytes: Buffer.byteLength(JSON.stringify(value)) }]));
  }
  function recordWorker(result) {
    if (result.seq !== seq) throw new Error(`worker seq ${result.seq} != ${seq}`);
    if (result.views !== bees) throw new Error(`worker views ${result.views} != ${bees}`);
    hashes.add(result.hash);
    for (const [key, hash] of Object.entries(result.fieldHashes)) (fieldHashes[key] ??= new Set()).add(hash);
  }
  const median = (values) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
  const report = { protocol: 2, host: hostname(), runtime: process.version, repo, head, bees, clients, rounds, loadBefore: loadavg(), fixture: rig.dir, single: [], repeat: [], burst: [], errors: [] };
  let daemon;
  try {
    daemon = await helpers.startDaemon(rig.dir, { env: { HOME: rig.dir, CODEX_HOME: join(rig.dir, 'codex'), CLAUDE_CONFIG_DIR: join(rig.dir, 'claude'), ...(perfDir ? { HIVE_PERF_DIR: perfDir, HIVE_PERF_DURATION_MS: '600000', HIVE_PERF_SAMPLE_MS: '60000' } : {}) } });
    report.daemonPid = daemon.proc.pid;
    const warm = await watchOnce(RpcClient, daemon.socketPath); record(warm.snap); report.warmup = warm.sample;
    for (let round = 0; round < rounds; round++) {
      const { snap, sample } = await watchOnce(RpcClient, daemon.socketPath);
      record(snap);
      report.single.push({ round, ...sample });
      console.log(JSON.stringify({ single: report.single.at(-1) }));
    }
    const sticky = await RpcClient.connect(daemon.socketPath, 10_000);
    for (let round = 0; round < rounds; round++) {
      const { snap, sample } = await watchOnce(RpcClient, daemon.socketPath, 'snapshot', sticky);
      record(snap);
      report.repeat.push({ round, ...sample });
      console.log(JSON.stringify({ repeat: report.repeat.at(-1) }));
    }
    sticky.close();
    for (let round = 0; round < rounds; round++) {
      const workers = Array.from({ length: clients }, () => new Worker(fileURLToPath(import.meta.url), { workerData: { repo, socketPath: daemon.socketPath } }));
      await Promise.all(workers.map((worker) => new Promise((ready, reject) => { worker.once('message', ready); worker.once('error', reject); })));
      const start = performance.now();
      const results = await Promise.all(workers.map((worker) => new Promise((done, reject) => { worker.once('message', done); worker.once('error', reject); worker.postMessage('go'); })));
      const wallMs = performance.now() - start;
      await Promise.all(workers.map((worker) => worker.terminate()));
      for (const result of results) recordWorker(result);
      const sample = { round, wallMs, lastByteMaxMs: Math.max(...results.map((r) => r.lastByteMs)), resolved: results.map((r) => Math.round(r.resolvedMs * 10) / 10), lastByte: results.map((r) => Math.round(r.lastByteMs * 10) / 10), bytes: results.reduce((n, r) => n + r.bytes, 0) };
      report.burst.push(sample);
      console.log(JSON.stringify({ burst: sample }));
    }
    report.summary = {
      seq,
      distinctContentHashes: hashes.size,
      varyingFields: Object.entries(fieldHashes).filter(([, set]) => set.size > 1).map(([key]) => key),
      bytesPerSnapshot: report.single[0]?.bytes ?? null,
      singleMedianMs: median(report.single.map((s) => s.resolvedMs)),
      singleLastByteMedianMs: median(report.single.map((s) => s.lastByteMs)),
      repeatMedianMs: median(report.repeat.map((s) => s.resolvedMs)),
      repeatLastByteMedianMs: median(report.repeat.map((s) => s.lastByteMs)),
      burstWallMedianMs: median(report.burst.map((s) => s.wallMs)),
      burstLastByteMedianMs: median(report.burst.map((s) => s.lastByteMaxMs)),
      breakdown,
    };
  } catch (error) {
    report.errors.push(String(error.stack ?? error));
    process.exitCode = 1;
  } finally {
    if (daemon) {
      await daemon.stop();
      report.daemonStopped = daemon.proc.exitCode !== null || daemon.proc.signalCode !== null;
      report.daemonLogTail = daemon.output().split('\n').filter((line) => /slow|error|snapshot/.test(line)).slice(-20);
      if (perfDir) {
        const summaryName = readdirSync(perfDir).find((name) => name.endsWith('.summary.json'));
        if (summaryName) {
          const spans = JSON.parse(readFileSync(join(perfDir, summaryName), 'utf8')).spans ?? {};
          report.daemonSpans = Object.fromEntries(['rpc.watch', 'rpc.snapshot', 'rpc.serialize', 'daemon.tick.watch'].filter((name) => spans[name]).map((name) => [name, spans[name]]));
        }
      }
    }
    report.loadAfter = loadavg();
    rig.cleanup();
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ out, errors: report.errors, summary: { ...report.summary, breakdown: undefined } }));
  }
}
