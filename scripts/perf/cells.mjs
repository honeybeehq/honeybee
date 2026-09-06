#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { cpus, hostname, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { distribution } from './report.mjs';
import { summarizeGitTrace } from './git-trace.mjs';

const args = process.argv.slice(2);
function option(key, fallback) { const i = args.indexOf(key); if (i < 0) return fallback; assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `${key} requires a value`); return args[i + 1]; }
const root = resolve(option('--root', '.'));
const out = resolve(option('--out', '.artifacts/performance/cells.json'));
const samples = Number(option('--samples', '5'));
const mode = option('--mode', 'provision');
const holdMs = Number(option('--hold-ms', '2000'));
const remoteMode = option('--remote-mode', 'none');
assert.ok(['none', 'same', 'split'].includes(remoteMode));
assert.ok(Number.isSafeInteger(samples) && samples >= 1 && samples <= 100);
assert.ok(Number.isSafeInteger(holdMs) && holdMs >= 100 && holdMs <= 60000);
assert.ok(['provision', 'worker'].includes(mode));
const local = p => import(pathToFileURL(join(root, p)).href);
const { makeRig, g, fingerprintOrigin } = await local('v2/driver-cell/tests/helpers.ts');
const { provisionCell } = await local('v2/driver-cell/src/provision.ts');
const { refreshGitImage } = await local('v2/driver-cell/src/gitImage.ts');
const { cellPaths } = await local('v2/driver-cell/src/layout.ts');
const { readLedger } = await local('v2/driver-cell/src/ledger.ts');
const rig = makeRig();
let worker;
let cleaning;
async function cleanup() { cleaning ??= (async () => { if (worker) await worker.terminate(); rig.cleanup(); })(); await cleaning; }
for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130]]) process.once(signal, () => { void cleanup().then(() => process.exit(code), () => process.exit(1)); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function within(p, ms) { let timer; try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cell worker timeout')), ms); })]); } finally { clearTimeout(timer); } }
function gitCommand(...argv) { const p = spawnSync('git', argv, { cwd: root, encoding: 'utf8' }); assert.equal(p.status, 0); return p.stdout.trim(); }
function logicalBytes(dir) { return readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => { const p = join(dir, e.name); return sum + (e.isDirectory() ? logicalBytes(p) : e.isFile() ? statSync(p).size : 0); }, 0); }
const priorTrace = process.env.GIT_TRACE2_EVENT;
mkdirSync(dirname(out), { recursive: true });
const traceDir = `${out}.traces`; mkdirSync(traceDir, { recursive: true });
const report = { schemaVersion: 1, timestamp: new Date().toISOString(), source: { revision: gitCommand('rev-parse', 'HEAD'), status: gitCommand('status', '--porcelain') },
  workload: { mode, samples, holdMs, remoteMode, trackedFiles: 203, warmFiles: 1000, runtime: 'source provision function / built provision-worker', trace2: true },
  environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostname: hostname(), loadBefore: loadavg() },
  toolSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(readFileSync(new URL('./git-trace.mjs', import.meta.url))).digest('hex'), results: [],
  scope: 'Real disposable origin/image/checkout; warm OS caches. Node CPU excludes git/cp children; Git Trace2 supplies child command wall time. RSS includes parent and worker threads, not child processes. Logical bytes are not physical CoW allocation.' };
if (mode === 'worker') report.source.workerSha256 = createHash('sha256').update(readFileSync(join(root, 'dist/v2/provision-worker.js'))).digest('hex');
function save() { writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); }
try {
  for (let i = 0; i < 200; i++) writeFileSync(join(rig.origin.repo, 'src', `file-${i}.txt`), `tracked-${i}\n`.repeat(32));
  writeFileSync(join(rig.origin.repo, '.gitignore'), 'node_modules/\n');
  g(rig.origin.repo, ['add', '.']); g(rig.origin.repo, ['commit', '-m', 'performance fixture']);
  let sha = g(rig.origin.repo, ['rev-parse', 'HEAD']);
  const warm = join(rig.origin.repo, 'node_modules'); mkdirSync(warm);
  for (let i = 0; i < 1000; i++) writeFileSync(join(warm, `file-${i}.txt`), `dependency-${i}\n`.repeat(32));
  // A real remote adds configuration work even though provisioning stays local.
  const fetchUrl = 'https://example.invalid/fixture.git';
  const pushUrl = remoteMode === 'split' ? 'ssh://git@example.invalid/fixture-push.git' : fetchUrl;
  if (remoteMode !== 'none') {
    g(rig.origin.repo, ['remote', 'add', 'origin', fetchUrl]);
    if (remoteMode === 'split') g(rig.origin.repo, ['remote', 'set-url', '--push', 'origin', pushUrl]);
  }
  const sharedImages = join(rig.root, 'images');
  const image = refreshGitImage(sharedImages, rig.origin.repo, sha);
  assert.ok(image.status === 'refreshed' || image.status === 'ready', 'fixture requires working local Git images');
  // Measure warm files against the same graph as image-hit, before stale-image
  // samples append commits/packs. The stale scenario has one extra tracked file.
  const scenarios = mode === 'worker' ? ['worker-image-hit'] : ['clone', 'origin-cow', 'image-cold', 'image-hit', 'image-warm-files', 'image-stale'];
  let serial = 0;
  for (const scenario of scenarios) {
    process.stderr.write(`Cell ${scenario}\n`);
    const rows = [];
    for (let i = 0; i < samples; i++) {
      if (scenario === 'image-stale') {
        writeFileSync(join(rig.origin.repo, 'advance.txt'), `advance ${i}\n`);
        g(rig.origin.repo, ['add', 'advance.txt']); g(rig.origin.repo, ['commit', '-m', `advance ${i}`]); sha = g(rig.origin.repo, ['rev-parse', 'HEAD']);
      }
      const id = serial++;
      const request = { beeId: `cell-perf-${id}`, originRepo: rig.origin.repo, sha, wrapper: `perf-${id}`, repoName: 'fixture', cellId: String(id), ...(scenario === 'image-warm-files' ? { warmArtifacts: ['node_modules'] } : {}) };
      const fingerprint = fingerprintOrigin(rig.origin.repo);
      const tracePath = join(traceDir, `${scenario}-${i}.jsonl`);
      // Trace2 appends. Reusing an output path must start a new capture.
      writeFileSync(tracePath, ''); process.env.GIT_TRACE2_EVENT = tracePath;
      const images = scenario === 'image-cold' ? join(rig.root, `cold-images-${id}`) : sharedImages;
      const rssBefore = process.memoryUsage().rss, cpuBefore = process.cpuUsage(), started = performance.now();
      let cell, extra = {};
      try {
        if (mode === 'worker') {
          worker = new Worker(pathToFileURL(join(root, 'dist/v2/provision-worker.js')), { execArgv: [], workerData: { cellsRoot: rig.cellsRoot, request, opId: `op-${id}`, disableCow: false, useGitImages: true, gitImagesRoot: images } });
          let exitAt;
          const exited = new Promise(res => { worker.once('exit', code => { exitAt = performance.now(); res(code); }); });
          const message = await within(new Promise((res, rej) => { worker.once('message', res); worker.once('error', rej); worker.once('exit', code => { if (code !== 0) rej(new Error(`worker exit ${code}`)); }); }), 60000);
          assert.equal(message.ok, true, message.error);
          const readyAt = performance.now(), rssReady = process.memoryUsage().rss;
          await sleep(holdMs);
          extra = { readyWallMs: readyAt - started, workerAliveAtHold: exitAt === undefined ? 1 : 0, rssAtReadyBytes: rssReady, rssAtHoldBytes: process.memoryUsage().rss };
          if (exitAt === undefined) worker.postMessage({ kind: 'refresh_git_image' });
          assert.equal(await within(exited, 30000), 0);
          extra.workerTailMs = exitAt - readyAt;
          worker = undefined;
          const paths = cellPaths(rig.cellsRoot, request.wrapper, request.repoName, request.cellId);
          cell = { paths, copyMode: readLedger(paths.ledgerPath).copy_mode };
        } else {
          cell = provisionCell(rig.cellsRoot, request, `op-${id}`, { disableCow: scenario === 'clone', useGitImages: scenario !== 'origin-cow', gitImagesRoot: images });
        }
      } finally { if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = priorTrace; }
      const wallMs = performance.now() - started, cpu = process.cpuUsage(cpuBefore);
      const expectedMode = scenario === 'clone' ? 'clone' : scenario === 'origin-cow' ? 'cow' : 'image-cow';
      assert.equal(cell.copyMode, expectedMode, `scenario ${scenario} requires ${expectedMode}; fallback is not comparable evidence`);
      const events = existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      const gitTrace = summarizeGitTrace(events);
      assert.ok(gitTrace.commandCount > 0, 'real provisioning must produce Git trace evidence');
      rows.push({ wallMs, nodeCpuMs: (cpu.user + cpu.system) / 1000, rssBeforeBytes: rssBefore, rssAfterBytes: process.memoryUsage().rss, gitCommandCount: gitTrace.commandCount, gitCommandWallMs: gitTrace.wallMs, copyMode: cell.copyMode, commands: gitTrace.commands, ...extra });
      assert.equal(g(cell.paths.spaceDir, ['rev-parse', 'HEAD']), sha);
      assert.equal(g(cell.paths.spaceDir, ['status', '--porcelain']), '');
      assert.deepEqual(fingerprintOrigin(rig.origin.repo), fingerprint);
      if (remoteMode !== 'none' && scenario !== 'clone') {
        assert.equal(g(cell.paths.spaceDir, ['remote', 'get-url', 'origin']), fetchUrl);
        assert.equal(g(cell.paths.spaceDir, ['remote', 'get-url', '--push', 'origin']), pushUrl);
      }
      assert.equal(readFileSync(join(cell.paths.spaceDir, 'src/file-199.txt'), 'utf8'), 'tracked-199\n'.repeat(32));
      if (scenario === 'image-warm-files') assert.equal(readFileSync(join(cell.paths.spaceDir, 'node_modules/file-999.txt'), 'utf8'), 'dependency-999\n'.repeat(32));
      rows.at(-1).logicalCellBytes = logicalBytes(cell.paths.wrapperDir);
    }
    const numeric = Object.keys(rows[0]).filter(k => typeof rows[0][k] === 'number');
    report.results.push({ scenario, metrics: Object.fromEntries(numeric.map(k => [k, distribution(rows.map(row => row[k]))])), raw: rows }); save();
  }
  report.environment.loadAfter = loadavg(); report.completed = true; save(); console.log(out);
} finally { if (priorTrace === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = priorTrace; await cleanup(); }
