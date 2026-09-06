#!/usr/bin/env node
// Each cohort runs in a fresh Node process so previous V8 workers cannot bias RSS.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { distribution } from './report.mjs';
import { summarizeGitTrace } from './git-trace.mjs';

const args = process.argv.slice(2);
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const root = resolve(option('--root', '.')), out = resolve(option('--out', '.artifacts/performance/cohort.json'));
const samples = Number(option('--samples', '3')), width = Number(option('--width', '5')), holdMs = Number(option('--hold-ms', '2000'));
for (const [n, max] of [[samples, 20], [width, 20], [holdMs, 60000]]) assert.ok(Number.isSafeInteger(n) && n > 0 && n <= max);
const childMode = args.includes('--child');
const script = fileURLToPath(import.meta.url);
const digest = paths => { const h = createHash('sha256'); for (const p of paths) h.update(readFileSync(p)); return h.digest('hex'); };
const toolSha256 = digest([script, new URL('./git-trace.mjs', import.meta.url)]);
const environment = { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostname: hostname(), loadBefore: loadavg() };
const workerEntry = join(root, 'dist/v2/provision-worker.js');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }); assert.equal(revision.status, 0);
const source = { revision: revision.stdout.trim(), workerSha256: digest([workerEntry]) };
const workload = { mode: 'worker-cohort', samples, width, holdMs, trackedFiles: 203, trace2: true };
mkdirSync(dirname(out), { recursive: true });
const report = { schemaVersion: 1, source, workload, environment, toolSha256,
  scope: 'Fresh Node process per cohort; real built workers and disposable prewarmed Git image; Node CPU excludes Git/cp children. RSS is process resident memory including shared pages, not per-worker private memory. Controlled hold starts after all workers report ready.' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, ms) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cohort timeout')), ms); })]); } finally { clearTimeout(timer); } }

if (!childMode) {
  let child;
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) process.once(signal, () => {
    if (child) { child.once('exit', () => process.exit(code)); child.kill(signal); }
    else process.exit(code);
  });
  const raw = [];
  for (let i = 0; i < samples; i++) {
    const trialOut = `${out}.trial-${i}.json`;
    process.stderr.write(`Cell cohort ${i + 1}/${samples}, width ${width}\n`);
    child = spawn(process.execPath, [script, '--root', root, '--out', trialOut, '--samples', String(samples), '--width', String(width), '--hold-ms', String(holdMs), '--child'], { stdio: ['ignore', 'ignore', 'inherit'] });
    const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    let code;
    try { code = await within(exited, 180000); }
    catch (error) { child.kill('SIGTERM'); await exited; throw error; }
    child = undefined;
    assert.equal(code, 0, 'cohort child failed');
    const trial = JSON.parse(readFileSync(trialOut, 'utf8'));
    assert.equal(trial.completed, true); assert.deepEqual(trial.workload, workload);
    assert.deepEqual(trial.source, source); assert.equal(trial.toolSha256, toolSha256);
    raw.push(trial.row);
  }
  report.results = [{ scenario: width === 5 ? 'five-worker-image-hit' : `${width}-worker-image-hit`, raw, metrics: Object.fromEntries(Object.keys(raw[0]).map(key => [key, distribution(raw.map(row => row[key]))])) }];
  report.completed = true; report.environment.loadAfter = loadavg();
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(out);
} else {
  const local = p => import(pathToFileURL(join(root, p)).href);
  const { makeRig, g, fingerprintOrigin } = await local('v2/driver-cell/tests/helpers.ts');
  const { refreshGitImage } = await local('v2/driver-cell/src/gitImage.ts');
  const { cellPaths } = await local('v2/driver-cell/src/layout.ts');
  const { readLedger } = await local('v2/driver-cell/src/ledger.ts');
  const rig = makeRig(), workers = [];
  let cleaning;
  async function cleanup() { cleaning ??= (async () => { await Promise.all(workers.map(item => item.worker.terminate())); rig.cleanup(); })(); await cleaning; }
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) process.once(signal, () => { void cleanup().then(() => process.exit(code), () => process.exit(1)); });
  try {
    for (let i = 0; i < 200; i++) writeFileSync(join(rig.origin.repo, 'src', `file-${i}.txt`), `tracked-${i}\n`.repeat(32));
    writeFileSync(join(rig.origin.repo, '.gitignore'), 'node_modules/\n');
    g(rig.origin.repo, ['add', '.']); g(rig.origin.repo, ['commit', '-m', 'cohort fixture']);
    const sha = g(rig.origin.repo, ['rev-parse', 'HEAD']), images = join(rig.root, 'images');
    assert.equal(refreshGitImage(images, rig.origin.repo, sha).status, 'refreshed');
    const fingerprint = fingerprintOrigin(rig.origin.repo);
    const traceDir = `${out}.traces`; mkdirSync(traceDir, { recursive: true });
    const rssBeforeBytes = process.memoryUsage().rss, cpuStart = process.cpuUsage(), started = performance.now();
    for (let i = 0; i < width; i++) {
      const request = { beeId: `cohort-${i}`, originRepo: rig.origin.repo, sha, wrapper: `cohort-${i}`, repoName: 'fixture', cellId: String(i) };
      const tracePath = join(traceDir, `${i}.jsonl`);
      writeFileSync(tracePath, '');
      const worker = new Worker(pathToFileURL(workerEntry), { execArgv: [], env: { ...process.env, GIT_TRACE2_EVENT: tracePath },
        workerData: { cellsRoot: rig.cellsRoot, request, opId: `op-${i}`, disableCow: false, useGitImages: true, gitImagesRoot: images } });
      const item = { worker, request, tracePath };
      item.exited = new Promise(resolve => worker.once('exit', code => { item.exitAt = performance.now(); resolve(code); }));
      item.ready = new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.once('message', message => { if (!message.ok) reject(new Error(message.error)); else { item.readyAt = performance.now(); resolve(); } });
        worker.once('exit', code => { if (item.readyAt === undefined) reject(new Error(`worker exited before ready: ${code}`)); });
      });
      workers.push(item);
    }
    await within(Promise.all(workers.map(item => item.ready)), 120000);
    const allReadyAt = performance.now(), rssAtReadyBytes = process.memoryUsage().rss, cpuReady = process.cpuUsage();
    await sleep(holdMs);
    const rssAtHoldBytes = process.memoryUsage().rss, cpuHold = process.cpuUsage(cpuReady), heldMs = performance.now() - allReadyAt;
    const workersAliveAtHold = workers.filter(item => item.exitAt === undefined).length;
    for (const item of workers) if (item.exitAt === undefined) item.worker.postMessage({ kind: 'refresh_git_image' });
    const codes = await within(Promise.all(workers.map(item => item.exited)), 60000);
    assert.ok(codes.every(code => code === 0));
    const cpu = process.cpuUsage(cpuStart);
    const row = { readyWallMs: allReadyAt - started, wallMs: performance.now() - started,
      nodeCpuMs: (cpu.user + cpu.system) / 1000, nodeCpuDuringHoldMs: (cpuHold.user + cpuHold.system) / 1000,
      idleCpuOneCorePercent: (cpuHold.user + cpuHold.system) / 10 / heldMs,
      rssBeforeBytes, rssAtReadyBytes, rssAtHoldBytes, rssAfterBytes: process.memoryUsage().rss,
      workersAliveAtHold, workerTailMaxMs: Math.max(...workers.map(item => item.exitAt - item.readyAt)),
      gitCommandCount: 0, gitCommandWallMs: 0 };
    for (const item of workers) {
      const events = readFileSync(item.tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      const trace = summarizeGitTrace(events); row.gitCommandCount += trace.commandCount; row.gitCommandWallMs += trace.wallMs;
      const paths = cellPaths(rig.cellsRoot, item.request.wrapper, item.request.repoName, item.request.cellId);
      assert.equal(readLedger(paths.ledgerPath).copy_mode, 'image-cow');
      assert.equal(g(paths.spaceDir, ['rev-parse', 'HEAD']), sha);
      assert.equal(g(paths.spaceDir, ['status', '--porcelain']), '');
      assert.equal(readFileSync(join(paths.spaceDir, 'src/file-199.txt'), 'utf8'), 'tracked-199\n'.repeat(32));
    }
    assert.deepEqual(fingerprintOrigin(rig.origin.repo), fingerprint);
    report.row = row; report.completed = true; report.environment.loadAfter = loadavg();
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  } finally { await cleanup(); }
}
