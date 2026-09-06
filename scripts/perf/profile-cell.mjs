#!/usr/bin/env node
// Capture the real built Cell worker's JS CPU/heap samples and Git Trace2.
// These profiling runs are separate from the uninstrumented timing reports.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { summarizeGitTrace } from './git-trace.mjs';

const root = resolve(process.argv[2] ?? '.');
const out = resolve(process.argv[3] ?? '.artifacts/performance/cell-profile');
const local = p => import(pathToFileURL(join(root, p)).href);
const { makeRig, g, fingerprintOrigin } = await local('v2/driver-cell/tests/helpers.ts');
const { refreshGitImage } = await local('v2/driver-cell/src/gitImage.ts');
const { cellPaths } = await local('v2/driver-cell/src/layout.ts');
const { readLedger } = await local('v2/driver-cell/src/ledger.ts');
const rig = makeRig();
let worker, cleaning;
async function cleanup() { cleaning ??= (async () => { if (worker) await worker.terminate(); rig.cleanup(); })(); await cleaning; }
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => { void cleanup().then(() => process.exit(code), () => process.exit(1)); });
async function within(promise, ms) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cell profile timeout')), ms); })]); } finally { clearTimeout(timer); } }
try {
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'choose an empty profile output directory');
  mkdirSync(out, { recursive: true });
  for (let i = 0; i < 200; i++) writeFileSync(join(rig.origin.repo, 'src', `file-${i}.txt`), `tracked-${i}\n`.repeat(32));
  writeFileSync(join(rig.origin.repo, '.gitignore'), 'node_modules/\n');
  g(rig.origin.repo, ['add', '.']); g(rig.origin.repo, ['commit', '-m', 'worker profile fixture']);
  const sha = g(rig.origin.repo, ['rev-parse', 'HEAD']), images = join(rig.root, 'images');
  assert.equal(refreshGitImage(images, rig.origin.repo, sha).status, 'refreshed');
  const before = fingerprintOrigin(rig.origin.repo);
  const request = { beeId: 'profile', originRepo: rig.origin.repo, sha, wrapper: 'profile', repoName: 'fixture', cellId: '0' };
  const entry = join(root, 'dist/v2/provision-worker.js'), tracePath = join(out, 'git-trace.jsonl');
  assert.equal(g(root, ['status', '--porcelain', '--', 'v2/driver-cell/src']), '', 'commit production changes before attribution');
  worker = new Worker(new URL('./profile-cell-worker.mjs', import.meta.url), { execArgv: [], env: { ...process.env, GIT_TRACE2_EVENT: tracePath }, workerData: {
    cellsRoot: rig.cellsRoot, request, opId: 'profile-op', disableCow: false, useGitImages: true, gitImagesRoot: images, perf: { entry, out },
  } });
  const exited = new Promise(resolve => worker.once('exit', resolve));
  const ready = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code !== 0) reject(new Error(`profile worker exited ${code}`)); }); });
  const result = await within(ready, 60000); assert.equal(result.ok, true, result.error);
  // Unblock the baseline's deferred phase. A fresh optimized worker needs no
  // signal; postMessage on that finished port is harmless.
  worker.postMessage({ kind: 'refresh_git_image' });
  assert.equal(await within(exited, 60000), 0);
  const paths = cellPaths(rig.cellsRoot, request.wrapper, request.repoName, request.cellId);
  assert.equal(readLedger(paths.ledgerPath).copy_mode, 'image-cow');
  assert.equal(g(paths.spaceDir, ['rev-parse', 'HEAD']), sha);
  assert.equal(g(paths.spaceDir, ['status', '--porcelain']), '');
  assert.deepEqual(fingerprintOrigin(rig.origin.repo), before);
  const cpu = JSON.parse(readFileSync(join(out, 'worker.cpuprofile'), 'utf8'));
  const heap = JSON.parse(readFileSync(join(out, 'worker.heapprofile'), 'utf8'));
  assert.ok(cpu.nodes.length > 0 && cpu.samples.length > 0 && cpu.samples.length === cpu.timeDeltas.length);
  assert.ok(heap.head && heap.samples.length > 0);
  const git = summarizeGitTrace(readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
  assert.ok(git.commandCount > 0);
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  writeFileSync(join(out, 'index.json'), JSON.stringify({ completed: true, timestamp: new Date().toISOString(), node: process.version,
    revision: g(root, ['rev-parse', 'HEAD']), workerSha256: digest(entry), scriptSha256: digest(new URL(import.meta.url)), wrapperSha256: digest(new URL('./profile-cell-worker.mjs', import.meta.url)),
    workload: { trackedFiles: 203, copyMode: 'image-cow', maintenance: 'signaled at ready' }, git,
    files: ['worker.cpuprofile', 'worker.heapprofile', 'git-trace.jsonl'].map(name => ({ name, sha256: digest(join(out, name)) })),
    scope: 'Instrumented worker module import and execution; inspector CPU and sampled heap allocation profiles, not private RSS or a full heap snapshot. Profiling overhead excluded from headline timings.' }, null, 2) + '\n');
  console.log(out);
} finally { await cleanup(); }
