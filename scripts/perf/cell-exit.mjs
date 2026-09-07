#!/usr/bin/env node
// Paired cell-exit (captureWork) costs over real disposable Git fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg, tmpdir } from 'node:os';
import { devNull } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootIdentity } from './boot-identity.mjs';
import { distribution } from './report.mjs';
import { summarizeGitTrace } from './git-trace.mjs';
import {
  aggregateGitRusage, captureGitRusage, setupGitRusage,
  validateGitRusageMode, verifyGitRusageSetup,
} from './git-rusage.mjs';

assert.equal(process.env.GIT_TRACE2_EVENT, undefined, 'unset inherited GIT_TRACE2_EVENT for uninstrumented timing');

const scriptDir = dirname(fileURLToPath(import.meta.url));
// Pinned dates make every fixture AND every measured merge/rebase commit
// deterministic, so result shas are assertable across sides and samples.
const FIXED_DATE = '2026-09-07T00:00:00Z';
process.env.GIT_AUTHOR_DATE = FIXED_DATE;
process.env.GIT_COMMITTER_DATE = FIXED_DATE;

const SCALE = Object.freeze({
  smoke: Object.freeze({ baseFiles: 12, cellCommits: 3, bodyLines: 8 }),
  canonical: Object.freeze({ baseFiles: 2000, cellCommits: 12, bodyLines: 40 }),
  stress: Object.freeze({ baseFiles: 10000, cellCommits: 20, bodyLines: 40 }),
});
const CASES = Object.freeze([
  'merge-land', 'rebase-land', 'merge-conflict', 'rebase-conflict',
  'fast-forward', 'branch-create', 'nothing', 'refused-checked-out',
]);

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  assert.ok(value !== undefined && !String(value).startsWith('--'), `${name} requires a value`);
  return value;
}
function flag(name) {
  const count = args.filter(value => value === name).length;
  assert.ok(count <= 1, `${name} may be specified only once`);
  return count === 1;
}
const beforeArg = option('--before', '');
const afterArg = option('--after', '');
const outArg = option('--out', '');
const gitRusageEnabled = flag('--git-rusage');
const gitRusagePython = option('--git-rusage-python', undefined);
assert.ok(beforeArg && afterArg && outArg,
  'usage: cell-exit.mjs --before root --after root --out report.json [--rounds 5] [--scale smoke|canonical|stress] [--case a,b] [--expected-changed files] [--git-rusage --git-rusage-python /absolute/python]');
validateGitRusageMode({ enabled: gitRusageEnabled, pythonExecutable: gitRusagePython });
const beforeRoot = resolve(beforeArg);
const afterRoot = resolve(afterArg);
const out = resolve(outArg);
const rounds = Number(option('--rounds', '5'));
const scale = String(option('--scale', 'smoke')).toLowerCase();
const expectedChangedArg = option('--expected-changed', undefined);
const caseFilter = String(option('--case', CASES.join(','))).split(',').map(s => s.trim()).filter(Boolean);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 50, 'rounds must be 3..50');
assert.ok(Object.hasOwn(SCALE, scale), 'scale must be smoke, canonical, or stress');
for (const c of caseFilter) assert.ok(CASES.includes(c), `unknown case: ${c}`);
assert.ok(caseFilter.length > 0, 'at least one case required');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const digestFile = p => sha256(readFileSync(p));

// Ruler-owned git: side-neutral fixture setup and assertions never run either
// candidate's helpers. Same pinned-config discipline as the driver's gitEnv.
function rulerGit(cwd, argv, opts = {}) {
  const run = spawnSync('git', argv, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull,
      GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'cell-exit-ruler', GIT_AUTHOR_EMAIL: 'ruler@hive.invalid',
      GIT_COMMITTER_NAME: 'cell-exit-ruler', GIT_COMMITTER_EMAIL: 'ruler@hive.invalid',
      ...(opts.env ?? {}),
    },
  });
  if (!opts.allowFail) assert.equal(run.status, 0, `git ${argv.join(' ')} in ${cwd}: ${run.stderr}`);
  return run;
}
const refDigest = repo => sha256(rulerGit(repo, ['for-each-ref']).stdout);
const rev = (repo, ref) => rulerGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
const showFile = (repo, sha, path) => rulerGit(repo, ['show', `${sha}:${path}`]).stdout;
const headState = repo => ({
  symbolic: rulerGit(repo, ['symbolic-ref', '--quiet', 'HEAD'], { allowFail: true }).stdout.trim(),
  commit: rev(repo, 'HEAD'),
});

function gitFingerprint(root) {
  const g = (...argv) => {
    const run = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.equal(run.status, 0, run.stderr); return run.stdout;
  };
  const files = g('ls-files', '--cached', '--others', '--exclude-standard', 'v2').trim().split('\n')
    .filter(p => p.endsWith('.ts') && (p.includes('/src/') || p === 'v2/daemon/tests/helpers.ts'));
  return { root, revision: g('rev-parse', 'HEAD').trim(), status: g('status', '--porcelain'),
    diffSha256: sha256(g('diff', '--binary', 'HEAD')),
    hashes: Object.fromEntries(files.map(p => [p, digestFile(join(root, p))])) };
}
const fingerprintTools = () => Object.fromEntries([
  'cell-exit.mjs', 'report.mjs', 'boot-identity.mjs', 'git-trace.mjs',
  'git-rusage.mjs', 'git-rusage-shim.py',
]
  .map(p => [p, digestFile(join(scriptDir, p))]));

const startedAt = new Date().toISOString();
const loadBefore = loadavg();
const roots = [beforeRoot, afterRoot];
const sources = roots.map(gitFingerprint);
const toolHashes = fingerprintTools();
const changedSourceFiles = [...new Set(sources.flatMap(s => Object.keys(s.hashes)))]
  .filter(f => sources[0].hashes[f] !== sources[1].hashes[f]).sort();
if (expectedChangedArg !== undefined) {
  assert.deepEqual(changedSourceFiles, expectedChangedArg.split(',').filter(Boolean).sort(), 'unexpected source changes');
  for (const s of sources) assert.doesNotMatch(s.status, /^.. v2\//m, 'expected committed v2 source');
}
const captures = [];
for (const root of roots) {
  captures.push((await import(pathToFileURL(join(root, 'v2/driver-cell/src/capture.ts')).href)).captureWork);
}

// --- deterministic fixtures ------------------------------------------------

function commitFiles(repo, files, message) {
  for (const [path, content] of files) writeFileSync(join(repo, path), content);
  rulerGit(repo, ['add', '-A']);
  rulerGit(repo, ['commit', '--quiet', '-m', message]);
}

/** Build one case fixture. Deterministic: identical shas on both sides. */
function buildFixture(caseName, dir, cfg) {
  const origin = join(dir, 'origin'), cell = join(dir, 'cell', 'space'), shaper = join(dir, 'shaper');
  mkdirSync(origin, { recursive: true });
  rulerGit(origin, ['init', '--quiet', '-b', 'main']);
  // Detached auto-maintenance/gc children would race fixture teardown and
  // pollute per-sample timing; disabled repo-locally (recorded in workload).
  rulerGit(origin, ['config', 'maintenance.auto', 'false']);
  rulerGit(origin, ['config', 'gc.auto', '0']);
  const base = [];
  for (let i = 0; i < cfg.baseFiles; i++) base.push([`f${String(i).padStart(4, '0')}.txt`, `base ${i}\n`.repeat(cfg.bodyLines)]);
  base.push(['shared.txt', 'shared base\n']);
  commitFiles(origin, base, 'base');
  const baseSha = rev(origin, 'HEAD');
  mkdirSync(dirname(cell), { recursive: true });
  rulerGit(dir, ['clone', '--quiet', origin, cell]);
  rulerGit(cell, ['config', 'maintenance.auto', 'false']);
  rulerGit(cell, ['config', 'gc.auto', '0']);
  // Cell work: disjoint files, plus a shared.txt edit for conflict cases.
  for (let i = 0; i < cfg.cellCommits; i++) {
    const files = [[`cell-${i}.txt`, `cell ${caseName} ${i}\n`.repeat(cfg.bodyLines)]];
    if (i === 0 && caseName.includes('conflict')) files.push(['shared.txt', 'shared cell edit\n']);
    commitFiles(cell, files, `cell ${i}`);
  }
  const cellHead = rev(cell, 'HEAD');
  // Shape the origin's target branch without touching its working tree.
  const target = 'capture-target';
  const needsDiverged = ['merge-land', 'rebase-land', 'merge-conflict', 'rebase-conflict'].includes(caseName);
  let targetTip = null;
  if (needsDiverged) {
    rulerGit(dir, ['clone', '--quiet', '--config', 'maintenance.auto=false', '--config', 'gc.auto=0', origin, shaper]);
    const files = [['origin-only.txt', `origin ${caseName}\n`]];
    if (caseName.includes('conflict')) files.push(['shared.txt', 'shared origin edit\n']);
    commitFiles(shaper, files, 'origin advance');
    rulerGit(shaper, ['push', '--quiet', 'origin', `HEAD:refs/heads/${target}`]);
    targetTip = rev(origin, target);
  } else if (caseName === 'fast-forward') {
    rulerGit(origin, ['branch', target, baseSha]);
    targetTip = baseSha;
  } else if (caseName === 'nothing') {
    rulerGit(dir, ['clone', '--quiet', '--config', 'maintenance.auto=false', '--config', 'gc.auto=0', origin, shaper]);
    rulerGit(shaper, ['fetch', '--quiet', cell, 'HEAD']);
    rulerGit(shaper, ['checkout', '--quiet', '--detach', cellHead]);
    commitFiles(shaper, [['ahead.txt', 'target ahead\n']], 'ahead of cell');
    rulerGit(shaper, ['push', '--quiet', 'origin', `HEAD:refs/heads/${target}`]);
    targetTip = rev(origin, target);
  } // branch-create: no target branch; refused-checked-out: target is 'main'.
  rmSync(shaper, { recursive: true, force: true });
  const targetBranch = caseName === 'refused-checked-out' ? 'main' : target;
  return { origin, cell, targetBranch, baseSha, cellHead, targetTip, preRefs: refDigest(origin), originHead: headState(origin), cellHeadState: headState(cell), cellRefs: refDigest(cell) };
}

// Exact expectations per case; resultSha checked structurally + cross-side.
function expectedReport(caseName, fx) {
  const mode = caseName.startsWith('rebase') ? 'rebase' : 'merge';
  const base = { targetBranch: fx.targetBranch, mode, conflicts: [], reason: null, resultSha: null };
  switch (caseName) {
    case 'merge-land': case 'rebase-land':
      return { ...base, status: 'landed', cellHead: fx.cellHead, baseTarget: fx.targetTip };
    case 'merge-conflict': case 'rebase-conflict':
      return { ...base, status: 'conflict', cellHead: fx.cellHead, baseTarget: fx.targetTip, conflicts: ['shared.txt'] };
    case 'fast-forward':
      return { ...base, status: 'landed', cellHead: fx.cellHead, baseTarget: fx.targetTip, resultSha: fx.cellHead };
    case 'branch-create':
      return { ...base, status: 'landed', cellHead: fx.cellHead, baseTarget: null, resultSha: fx.cellHead };
    case 'nothing':
      return { ...base, status: 'nothing_to_capture', cellHead: fx.cellHead, baseTarget: fx.targetTip };
    case 'refused-checked-out':
      return { ...base, mode: 'merge', status: 'refused', cellHead: fx.cellHead, baseTarget: null, reason: 'target_checked_out' };
    default: assert.fail(`unknown case ${caseName}`);
  }
}

/** Assert one sample's full outcome outside timing, then reset the fixture. */
function verifyAndReset(caseName, fx, cfg, report) {
  assert.deepEqual(headState(fx.origin), fx.originHead, 'origin HEAD must remain unchanged');
  assert.deepEqual(headState(fx.cell), fx.cellHeadState, 'Cell HEAD must remain unchanged');
  assert.equal(refDigest(fx.cell), fx.cellRefs, 'Cell refs must remain unchanged');
  assert.equal(rulerGit(fx.cell, ['status', '--porcelain']).stdout, '', 'Cell working tree must remain unchanged');
  const expected = expectedReport(caseName, fx);
  const landedResult = report.resultSha;
  if (expected.status === 'landed' && expected.resultSha === null) {
    assert.ok(typeof landedResult === 'string' && landedResult.length === 40, 'landed result sha required');
    assert.deepEqual({ ...report, resultSha: null }, { ...expected, resultSha: null });
  } else {
    assert.deepEqual(report, expected);
  }
  assert.equal(rulerGit(fx.origin, ['for-each-ref', 'refs/hive/']).stdout, '', 'transient ref must not survive');
  if (expected.status === 'landed') {
    assert.equal(rev(fx.origin, fx.targetBranch), landedResult, 'target branch advanced to result');
    if (caseName === 'merge-land') {
      assert.equal(rev(fx.origin, `${landedResult}^1`), fx.targetTip, 'first parent is the target tip');
      assert.equal(rev(fx.origin, `${landedResult}^2`), fx.cellHead, 'second parent is the cell head');
      assert.equal(rulerGit(fx.origin, ['rev-parse', '--verify', '--quiet', `${landedResult}^3`], { allowFail: true }).status === 0, false);
      assert.equal(showFile(fx.origin, landedResult, 'origin-only.txt').includes('origin merge-land'), true);
      assert.equal(showFile(fx.origin, landedResult, 'cell-0.txt').includes('cell merge-land 0'), true);
    }
    if (caseName === 'rebase-land') {
      assert.equal(rulerGit(fx.origin, ['rev-list', '--count', `${fx.targetTip}..${landedResult}`]).stdout.trim(), String(cfg.cellCommits));
      assert.equal(showFile(fx.origin, landedResult, 'origin-only.txt').includes('origin rebase-land'), true);
      assert.equal(showFile(fx.origin, landedResult, `cell-${cfg.cellCommits - 1}.txt`).length > 0, true);
    }
    // Reset: restore or delete the target ref, then require an exact ref-set match.
    if (caseName === 'branch-create') rulerGit(fx.origin, ['update-ref', '-d', `refs/heads/${fx.targetBranch}`]);
    else rulerGit(fx.origin, ['update-ref', `refs/heads/${fx.targetBranch}`, fx.targetTip, landedResult]);
  }
  assert.equal(refDigest(fx.origin), fx.preRefs, 'origin ref set must return to its pre-sample state');
  assert.equal(rulerGit(fx.origin, ['status', '--porcelain']).stdout, '', 'origin working tree untouched');
  return landedResult;
}

function parseTrace2(path, retainedPath) {
  const bytes = readFileSync(path);
  const events = bytes.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  assert.ok(events.every(event => event && typeof event === 'object' && typeof event.event === 'string'), 'malformed Git trace event');
  const topLevel = summarizeGitTrace(events);
  assert.ok(topLevel.commandCount > 0, 'missing Git operation trace');
  const commands = {};
  const starts = events.filter(event => event.event === 'start');
  for (const event of starts) {
    assert.ok(Array.isArray(event.argv) && event.argv.every(arg => typeof arg === 'string'), 'malformed Git argv');
    const dashed = (event.argv[0] ?? '').match(/git-([a-z-]+)$/);
    const name = dashed ? dashed[1] : (event.argv.slice(1).find(arg => !arg.startsWith('-')) ?? 'unknown');
    commands[name] = (commands[name] ?? 0) + 1;
  }
  writeFileSync(retainedPath, bytes);
  return { processes: starts.length, children: events.filter(event => event.event === 'child_start').length,
    commands, topLevel, artifact: { path: retainedPath, bytes: bytes.length, sha256: sha256(bytes) } };
}

// --- run -------------------------------------------------------------------

const cfg = SCALE[scale];
const runDir = mkdtempSync(join(tmpdir(), 'hb-cell-exit-'));
let gitRusageSession = null;
const report = {
  schemaVersion: 1, completed: false, startedAt, timestamp: null,
  measurement: { startedAt: null, finishedAt: null },
  sources, changedSourceFiles, expectedChangedFiles: expectedChangedArg ?? null,
  sharedModuleIdentity: captures[0] === captures[1], toolHashes,
  ...(gitRusageEnabled ? { gitRusage: {
    enabled: true, diagnosticOnly: true, macOSOnly: true,
    provenance: null,
    rawArtifacts: [],
  } } : {}),
  environment: { node: process.version, execArgv: process.execArgv, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, hostname: hostname(), bootIdentity: bootIdentity(),
    gitVersion: rulerGit(runDir, ['--version']).stdout.trim(),
    nodeCompileCache: process.env.NODE_COMPILE_CACHE ?? null,
    nodeOptionsSha256: sha256(process.env.NODE_OPTIONS ?? ''), loadBefore, loadAfter: null },
  workload: { scale, rounds, warmups: 1, cases: caseFilter,
    fixture: { ...cfg, autoMaintenance: 'maintenance.auto/gc.auto disabled repo-locally in origin, Cell, and shaper fixtures; production scratch clone keeps defaults' },
    pinnedDates: FIXED_DATE,
    order: 'ABBA per round; one unmeasured warmup sample per side per case; assertions and resets outside timing' },
  results: [], rows: [], failure: null,
  scope: gitRusageEnabled
    ? 'Real captureWork from both roots over disposable deterministic Git repositories. Headline wall/cpu arrays contain only the original uninstrumented ABBA calls; cpuMs remains parent Node CPU. Trace2 and Git rusage each use their own later captureWork call per side/case. The rusage call has Trace2 disabled and reports real Git plus terminated descendants waited into macOS RUSAGE_CHILDREN; wrapper CPU is excluded. Trace2 supplies matched Git-observed launch evidence, not a kernel process census. RSS is a propagated per-process maximum, not summed tree memory. Fixture setup, checks, resets, diagnostics, and cleanup stay outside headline samples. No production store, daemon, RPC, or provisioning is involved.'
    : 'Real captureWork from both roots over disposable deterministic Git repositories. Wall time includes synchronous git children; cpuMs is the PARENT process only and excludes git child CPU. Trace2 process counts come from one separate diagnostic sample per side and are attribution evidence, never timing. Fixture setup, expectation checks, ref-set resets, and cleanup are outside timed samples. No production store, daemon, RPC, or provisioning is involved; nothing here measures whole-daemon behavior.',
};
const writeReport = () => {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
  renameSync(tmp, out);
};
const errorEvidence = (error, scenario) => ({
  scenario, name: error instanceof Error ? error.name : 'NonErrorThrown',
  message: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? (error.stack ?? null) : null, at: new Date().toISOString() });
let active = null, cleaning = false;
const cleanup = () => { if (!cleaning) { cleaning = true; rmSync(runDir, { recursive: true, force: true }); } };
const onSignal = name => {
  report.failure ??= errorEvidence(new Error(`interrupted by ${name}`), active);
  report.timestamp = new Date().toISOString(); report.environment.loadAfter = loadavg();
  try { writeReport(); } finally { cleanup(); }
  process.exit(name === 'SIGINT' ? 130 : 143);
};
const onSigint = () => onSignal('SIGINT'), onSigterm = () => onSignal('SIGTERM');
process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm);

try {
  writeReport();
  if (gitRusageEnabled) {
    active = 'git-rusage-setup';
    gitRusageSession = setupGitRusage({ runDir, pythonExecutable: gitRusagePython });
    report.gitRusage.provenance = { ...gitRusageSession.provenance, endFingerprints: null };
    writeReport();
  }
  for (const caseName of caseFilter) {
    active = caseName;
    process.stderr.write(`cell-exit: ${caseName}\n`);
    const mode = caseName.startsWith('rebase') ? 'rebase' : 'merge';
    const sides = [0, 1].map(side => {
      const dir = join(runDir, `${caseName}-${side}`);
      mkdirSync(dir, { recursive: true });
      return buildFixture(caseName, dir, cfg);
    });
    assert.equal(sides[0].cellHead, sides[1].cellHead, 'fixture cell heads must match across sides');
    assert.equal(sides[0].targetTip, sides[1].targetTip, 'fixture target tips must match across sides');
    assert.equal(sides[0].preRefs, sides[1].preRefs, 'fixture ref sets must match across sides');
    let ordinal = 0;
    const diagnosticOpIds = [0, 1].map(side => `cell-exit-${caseName}-${side}-diagnostic`);
    const run = side => {
      const fx = sides[side];
      const request = { originRepo: fx.origin, cellSpaceDir: fx.cell, targetBranch: fx.targetBranch,
        mode, opId: `cell-exit-${caseName}-${side}-${ordinal++}` };
      const cpu = process.cpuUsage(); const start = performance.now();
      const result = captures[side](request);
      const wallMs = performance.now() - start; const used = process.cpuUsage(cpu);
      return { result, wallMs, cpuMs: (used.user + used.system) / 1000, fx };
    };
    const diagnosticRun = side => {
      const fx = sides[side];
      const request = { originRepo: fx.origin, cellSpaceDir: fx.cell, targetBranch: fx.targetBranch,
        mode, opId: diagnosticOpIds[side] };
      return { result: captures[side](request), fx };
    };
    const landedShas = [new Set(), new Set()];
    const sample = (side, record) => {
      const { result, wallMs, cpuMs, fx } = run(side);
      const landed = verifyAndReset(caseName, fx, cfg, result);
      if (landed != null) landedShas[side].add(landed);
      if (record) { raw[side].wallMs.push(wallMs); raw[side].cpuMs.push(cpuMs); order.push(side); }
    };
    const raw = [{ wallMs: [], cpuMs: [] }, { wallMs: [], cpuMs: [] }];
    const order = [];
    for (const side of [0, 1]) sample(side, false);
    report.measurement.startedAt ??= new Date().toISOString();
    for (let r = 0; r < rounds; r++) for (const side of [0, 1, 1, 0]) sample(side, true);
    for (const set of landedShas) assert.ok(set.size <= 1, 'pinned dates must make landed results deterministic per side');
    assert.deepEqual([...landedShas[0]], [...landedShas[1]], 'landed results must match across sides');
    const traceProbes = [0, 1].map(side => {
      const path = join(runDir, `${caseName}-${side}.trace2`);
      // Trace exactly the measured operation: verification/reset git calls
      // run after the env var is cleared and never enter the attribution.
      process.env.GIT_TRACE2_EVENT = path;
      let probe;
      try { probe = diagnosticRun(side); } finally { delete process.env.GIT_TRACE2_EVENT; }
      const landed = verifyAndReset(caseName, sides[side], cfg, probe.result);
      if (landed != null) landedShas[side].add(landed);
      return { result: probe.result, landed, path,
        summary: parseTrace2(path, `${out}.${caseName}.${side}.trace2.jsonl`) };
    });
    const gitRusage = gitRusageSession ? [0, 1].map(side => {
      const sideName = side === 0 ? 'before' : 'after';
      const captured = captureGitRusage(gitRusageSession, {
        id: `${caseName}-${sideName}`,
        operation: () => diagnosticRun(side),
        retainedDir: `${out}.${caseName}.${sideName}.git-rusage-records`,
      });
      report.gitRusage.rawArtifacts.push({ case: caseName, side: sideName,
        kind: 'raw-git-rusage-records', ...captured.rawArtifact });
      writeReport();
      if (captured.failed) throw captured.error;
      const landed = verifyAndReset(caseName, sides[side], cfg, captured.value.result);
      if (landed != null) landedShas[side].add(landed);
      assert.deepEqual(captured.value.result, traceProbes[side].result,
        'Git rusage and separate Trace2 captureWork outcomes must match');
      assert.equal(landed, traceProbes[side].landed,
        'Git rusage and separate Trace2 landed outcomes must match');
      const aggregate = aggregateGitRusage({
        recordsDir: captured.recordsDir,
        runId: captured.runId,
        expectedCount: traceProbes[side].summary.topLevel.commandCount,
        expectedLauncherPid: process.pid,
        tracePath: traceProbes[side].path,
      });
      return { diagnosticOnly: true, trace2Disabled: true,
        captureOutcome: captured.value.result, landedSha: landed,
        aggregate, rawArtifact: captured.rawArtifact };
    }) : null;
    for (const set of landedShas) assert.ok(set.size <= 1, 'diagnostic result must preserve the measured landed SHA');
    assert.deepEqual([...landedShas[0]], [...landedShas[1]], 'diagnostic results must match across sides');
    report.results.push({
      case: caseName, mode,
      setup: { baseSha: sides[0].baseSha, cellHead: sides[0].cellHead, targetTip: sides[0].targetTip,
        targetBranch: sides[0].targetBranch, landedSha: [...landedShas[0]][0] ?? null },
      raw, order,
      metrics: Object.fromEntries([0, 1].flatMap(side => ['wallMs', 'cpuMs'].map(metric =>
        [`${side === 0 ? 'before' : 'after'}.${metric}`, distribution(raw[side][metric])]))),
      trace2: { diagnosticOnly: true, before: traceProbes[0].summary, after: traceProbes[1].summary },
      ...(gitRusage ? { gitRusage: {
        diagnosticOnly: true, before: gitRusage[0], after: gitRusage[1],
      } } : {}),
    });
    writeReport();
    for (const side of [0, 1]) {
      const fixtureDir = join(runDir, `${caseName}-${side}`);
      try { rmSync(fixtureDir, { recursive: true, force: true }); }
      catch { rmSync(fixtureDir, { recursive: true, force: true }); } // one retry for a racing writer
    }
  }
  active = null;
  report.measurement.finishedAt = new Date().toISOString();
  assert.deepEqual(roots.map(gitFingerprint), sources, 'source changed during capture');
  assert.deepEqual(fingerprintTools(), toolHashes, 'ruler changed during capture');
  if (gitRusageSession) {
    report.gitRusage.provenance.endFingerprints = verifyGitRusageSetup(gitRusageSession);
  }
  for (const r of report.results) for (const metric of ['wallMs', 'cpuMs']) {
    const b = distribution(r.raw[0][metric]), a = distribution(r.raw[1][metric]);
    report.rows.push({ case: r.case, metric, before: b, after: a,
      deltaPercent: b.p50 === 0 ? null : (a.p50 / b.p50 - 1) * 100 });
  }
  assert.deepEqual(bootIdentity(), report.environment.bootIdentity, 'boot changed during capture');
  assert.equal(rulerGit(runDir, ['--version']).stdout.trim(), report.environment.gitVersion, 'Git version changed during capture');
  assert.equal(report.results.length, caseFilter.length, 'incomplete cases');
  report.environment.loadAfter = loadavg();
  report.timestamp = new Date().toISOString();
  report.completed = true;
  writeReport();
  console.log(out);
} catch (error) {
  report.failure ??= errorEvidence(error, active);
  report.environment.loadAfter = loadavg();
  report.timestamp = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  cleanup();
}
