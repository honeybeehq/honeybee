#!/usr/bin/env node
// Packed-tag fanout costs for real Cell captureWork over deterministic Git fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, statfsSync, statSync, writeFileSync,
} from 'node:fs';
import { cpus, devNull, hostname, loadavg, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootIdentity } from './boot-identity.mjs';
import {
  attributeMaintenanceDescendants,
  balancedRefSchedule,
  summarizeScratchTree,
} from './cell-ref-fanout-lib.mjs';
import {
  aggregateGitRusage,
  captureGitRusage,
  normalizeGitRusageArg,
  setupGitRusage,
  summarizeGitRusageTrace,
  validateGitRusageMode,
  verifyGitRusageSetup,
} from './git-rusage.mjs';
import { summarizeGitTrace } from './git-trace.mjs';
import { distribution } from './report.mjs';

assert.equal(process.env.GIT_TRACE2_EVENT, undefined,
  'unset inherited GIT_TRACE2_EVENT before running uninstrumented headline samples');

const scriptDir = dirname(fileURLToPath(import.meta.url));
const FIXED_DATE = '2026-09-07T00:00:00Z';
const FIXED_EPOCH_SECONDS = String(Date.parse(FIXED_DATE) / 1000);
const FILE_COUNT = 12;
const CELL_COMMITS = 12;
const INPUT_COMMIT_UNION = 14;
const TARGET_BRANCH = 'capture-target';
const TAG_PREFIX = 'refs/tags/hive-fixture/';
const DEFAULT_REF_COUNTS = '0,1000,10000';
const DEFAULT_SAMPLES = '6';
const USAGE = 'usage: cell-ref-fanout.mjs --root source --out report.json --git-rusage-python /absolute/python [--samples 6] [--refs 0,1000,10000]';

process.env.GIT_AUTHOR_DATE = FIXED_DATE;
process.env.GIT_COMMITTER_DATE = FIXED_DATE;

function parseCli(argv) {
  const names = new Set(['--root', '--out', '--samples', '--refs', '--git-rusage-python']);
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    assert.ok(names.has(name), `unknown option ${name}; ${USAGE}`);
    assert.equal(values.has(name), false, `${name} may be specified only once`);
    const value = argv[++index];
    assert.ok(value !== undefined && !value.startsWith('--'), `${name} requires a value`);
    values.set(name, value);
  }
  assert.ok(values.has('--root') && values.has('--out') && values.has('--git-rusage-python'), USAGE);
  const samples = Number(values.get('--samples') ?? DEFAULT_SAMPLES);
  assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 30,
    'samples must be an integer from 3 through 30');
  const rawCounts = String(values.get('--refs') ?? DEFAULT_REF_COUNTS).split(',').map(value => value.trim());
  assert.equal(rawCounts.length, 3, '--refs requires exactly three comma-separated counts');
  assert.ok(rawCounts.every(value => /^\d+$/.test(value)), 'ref counts must be non-negative integers');
  const refCounts = rawCounts.map(Number).sort((a, b) => a - b);
  assert.equal(new Set(refCounts).size, 3, 'ref counts must be unique');
  assert.equal(refCounts[0], 0, 'the three ref counts must include zero');
  assert.ok(refCounts.every(value => Number.isSafeInteger(value) && value <= 100_000),
    'ref counts must not exceed 100000');
  const root = resolve(values.get('--root'));
  const out = resolve(values.get('--out'));
  const pythonExecutable = values.get('--git-rusage-python');
  validateGitRusageMode({ enabled: true, pythonExecutable });
  return { root, out, samples, refCounts, pythonExecutable };
}

const options = parseCli(process.argv.slice(2));
assert.equal(existsSync(options.out), false, `refusing to overwrite report: ${options.out}`);

const sha256 = data => createHash('sha256').update(data).digest('hex');
const digestFile = path => sha256(readFileSync(path));

function rulerGit(cwd, argv, opts = {}) {
  const run = spawnSync('git', argv, {
    cwd,
    encoding: 'utf8',
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_SYSTEM: devNull,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'cell-ref-fanout-ruler',
      GIT_AUTHOR_EMAIL: 'ruler@hive.invalid',
      GIT_COMMITTER_NAME: 'cell-ref-fanout-ruler',
      GIT_COMMITTER_EMAIL: 'ruler@hive.invalid',
      ...(opts.env ?? {}),
    },
  });
  if (run.error) throw run.error;
  if (!opts.allowFail) assert.equal(run.status, 0,
    `git ${argv.join(' ')} in ${cwd} failed (${run.status}): ${run.stderr}`);
  return run;
}

function gitLines(repo, argv) {
  const output = rulerGit(repo, argv).stdout.trim();
  return output.length === 0 ? [] : output.split('\n');
}

function rev(repo, ref) {
  return rulerGit(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
}

function sourceFingerprint(root) {
  const git = (...argv) => {
    const run = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', 'v2').trim().split('\n')
    .filter(path => path.endsWith('.ts') && (path.includes('/src/') || path === 'v2/daemon/tests/helpers.ts'));
  const status = git('status', '--porcelain');
  assert.doesNotMatch(status, /^.. v2\//m, 'source v2 files must be committed before measurement');
  return {
    root,
    revision: git('rev-parse', 'HEAD').trim(),
    status,
    diffSha256: sha256(git('diff', '--binary', 'HEAD')),
    hashes: Object.fromEntries(files.map(path => [path, digestFile(join(root, path))])),
  };
}

function toolFingerprint() {
  return Object.fromEntries([
    'cell-ref-fanout.mjs',
    'cell-ref-fanout-lib.mjs',
    'report.mjs',
    'boot-identity.mjs',
    'git-trace.mjs',
    'git-rusage.mjs',
    'git-rusage-shim.py',
  ].map(name => [name, digestFile(join(scriptDir, name))]));
}

function filesystemFingerprint(path) {
  const realpath = realpathSync(path);
  const stat = statSync(realpath);
  const fs = statfsSync(realpath, { bigint: true });
  let deviceName = null;
  let typeName = null;
  let mountPoint = null;
  const df = spawnSync('/bin/df', ['-P', realpath], { encoding: 'utf8', timeout: 5_000 });
  if (df.status === 0) {
    const fields = df.stdout.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? [];
    if (fields.length >= 6) {
      deviceName = fields[0];
      mountPoint = fields.at(-1);
    }
  }
  if (process.platform === 'darwin' && deviceName !== null && mountPoint !== null) {
    const mount = spawnSync('/sbin/mount', [], { encoding: 'utf8', timeout: 5_000 });
    const prefix = `${deviceName} on ${mountPoint} (`;
    const record = mount.status === 0
      ? mount.stdout.split('\n').find(line => line.startsWith(prefix))
      : undefined;
    typeName = record?.slice(prefix.length).split(',')[0]?.replace(/\)$/, '') ?? null;
  } else if (process.platform === 'linux') {
    const probe = spawnSync('/usr/bin/stat', ['-f', '-c', '%T', realpath],
      { encoding: 'utf8', timeout: 5_000 });
    if (probe.status === 0) typeName = probe.stdout.trim();
  }
  return {
    path,
    realpath,
    device: String(stat.dev),
    deviceName,
    typeCode: String(fs.type),
    typeName,
    mountPoint,
    blockSize: String(fs.bsize),
    blocks: String(fs.blocks),
    blocksFree: String(fs.bfree),
    blocksAvailable: String(fs.bavail),
    files: String(fs.files),
    filesFree: String(fs.ffree),
    availableBytes: String(fs.bavail * fs.bsize),
  };
}

function stableFilesystemIdentity(value) {
  return {
    realpath: value.realpath,
    device: value.device,
    deviceName: value.deviceName,
    typeCode: value.typeCode,
    typeName: value.typeName,
    mountPoint: value.mountPoint,
    blockSize: value.blockSize,
  };
}

function refRecords(repo, prefix) {
  const argv = ['for-each-ref', '--sort=refname', '--format=%(refname)%09%(objectname)'];
  if (prefix !== undefined) argv.push(prefix);
  return gitLines(repo, argv).map(line => {
    const [name, object] = line.split('\t');
    assert.ok(name && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object), `malformed ref record: ${line}`);
    return { name, object };
  });
}

function recordDigest(records) {
  return sha256(JSON.stringify(records));
}

function objectSet(repo) {
  const ids = gitLines(repo, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)']).sort();
  assert.equal(new Set(ids).size, ids.length, 'object enumeration contains duplicates');
  assert.ok(ids.every(id => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id)), 'malformed object id');
  return { count: ids.length, sha256: sha256(ids.join('\n')), ids };
}

function commitSet(repo) {
  return new Set(gitLines(repo, ['rev-list', '--all']));
}

function headState(repo) {
  return {
    symbolic: rulerGit(repo, ['symbolic-ref', '--quiet', 'HEAD']).stdout.trim(),
    commit: rev(repo, 'HEAD'),
  };
}

function treeSnapshot(repo, commit) {
  const bytes = rulerGit(repo, ['ls-tree', '-r', '--full-tree', '-z', commit]).stdout;
  const entries = bytes.split('\0').filter(Boolean);
  const names = entries.map(entry => {
    const separator = entry.indexOf('\t');
    assert.ok(separator > 0, `malformed ls-tree entry: ${entry}`);
    return entry.slice(separator + 1);
  });
  return {
    tree: rulerGit(repo, ['rev-parse', `${commit}^{tree}`]).stdout.trim(),
    fileCount: names.length,
    names,
    manifestSha256: sha256(bytes),
  };
}

function listFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const visit = (dir, relative) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, nextRelative);
      else files.push(nextRelative);
    }
  };
  visit(root, '');
  return files;
}

function commitFiles(repo, files, message) {
  for (const [name, contents] of files) writeFileSync(join(repo, name), contents);
  rulerGit(repo, ['add', '-A']);
  rulerGit(repo, ['commit', '--quiet', '-m', message]);
}

function syntheticRefName(index) {
  return `${TAG_PREFIX}${String(index).padStart(8, '0')}`;
}

function refToken(count) {
  return String(count).padStart(6, '0');
}

function seedPackedTags(origin, count, baseSha) {
  const commands = Array.from({ length: count }, (_, index) =>
    `create ${syntheticRefName(index)} ${baseSha}`).join('\n');
  rulerGit(origin, ['update-ref', '--stdin'], { input: commands.length === 0 ? '' : `${commands}\n` });
  rulerGit(origin, ['pack-refs', '--all']);
  const actual = refRecords(origin, TAG_PREFIX);
  const expected = Array.from({ length: count }, (_, index) => ({
    name: syntheticRefName(index),
    object: baseSha,
  }));
  assert.deepEqual(actual, expected, 'synthetic packed tags must match the fixed manifest');
  const packedPath = join(origin, '.git', 'packed-refs');
  const packedBytes = readFileSync(packedPath);
  const packedLines = packedBytes.toString('utf8').split('\n');
  const packedSynthetic = packedLines.filter(line => line.includes(` ${TAG_PREFIX}`));
  assert.equal(packedSynthetic.length, count, 'every synthetic tag must be packed');
  const looseFiles = listFiles(join(origin, '.git', 'refs', 'tags', 'hive-fixture'));
  assert.deepEqual(looseFiles, [], 'synthetic tags must not remain loose');
  const backendRun = rulerGit(origin, ['config', '--get', 'extensions.refStorage'], { allowFail: true });
  return {
    count,
    prefix: TAG_PREFIX,
    target: baseSha,
    orderedManifestSha256: recordDigest(actual),
    first: actual[0]?.name ?? null,
    last: actual.at(-1)?.name ?? null,
    packedCount: packedSynthetic.length,
    looseCount: looseFiles.length,
    packedRefsBytes: packedBytes.length,
    packedRefsSha256: sha256(packedBytes),
    refBackend: backendRun.status === 0 && backendRun.stdout.trim() ? backendRun.stdout.trim() : 'files',
  };
}

function buildFixture(dir, refCount) {
  const origin = join(dir, 'origin');
  const cell = join(dir, 'cell', 'space');
  const shaper = join(dir, 'shaper');
  mkdirSync(origin, { recursive: true });
  rulerGit(origin, ['init', '--quiet', '-b', 'main']);
  rulerGit(origin, ['config', 'maintenance.auto', 'false']);
  rulerGit(origin, ['config', 'gc.auto', '0']);

  const baseFiles = Array.from({ length: FILE_COUNT }, (_, index) => [
    `f${String(index).padStart(2, '0')}.txt`,
    `base file ${index}\n`.repeat(8),
  ]);
  commitFiles(origin, baseFiles, 'base');
  const baseSha = rev(origin, 'HEAD');

  mkdirSync(dirname(cell), { recursive: true });
  rulerGit(dir, ['clone', '--quiet', origin, cell]);
  rulerGit(cell, ['config', 'maintenance.auto', 'false']);
  rulerGit(cell, ['config', 'gc.auto', '0']);
  for (let index = 0; index < CELL_COMMITS; index++) {
    const fileIndex = index === CELL_COMMITS - 1 ? 0 : index;
    commitFiles(cell, [[
      `f${String(fileIndex).padStart(2, '0')}.txt`,
      `cell revision ${index}\n`.repeat(8),
    ]], `cell ${index}`);
  }
  const cellHead = rev(cell, 'HEAD');

  rulerGit(dir, ['clone', '--quiet', origin, shaper]);
  rulerGit(shaper, ['config', 'maintenance.auto', 'false']);
  rulerGit(shaper, ['config', 'gc.auto', '0']);
  commitFiles(shaper, [['f11.txt', 'target revision\n'.repeat(8)]], 'target advance');
  rulerGit(shaper, ['push', '--quiet', 'origin', `HEAD:refs/heads/${TARGET_BRANCH}`]);
  const targetTip = rev(origin, TARGET_BRANCH);
  rmSync(shaper, { recursive: true, force: true });

  const syntheticTags = seedPackedTags(origin, refCount, baseSha);
  const allRefs = refRecords(origin);
  const nonSyntheticRefs = allRefs.filter(ref => !ref.name.startsWith(TAG_PREFIX));
  const union = new Set([...commitSet(origin), ...commitSet(cell)]);
  assert.equal(union.size, INPUT_COMMIT_UNION, 'fixture input commit union must stay fixed');
  assert.equal(treeSnapshot(origin, baseSha).fileCount, FILE_COUNT, 'base tree must have exactly 12 files');
  assert.equal(headState(origin).symbolic, 'refs/heads/main');
  assert.notEqual(TARGET_BRANCH, 'main');
  assert.equal(rulerGit(origin, ['status', '--porcelain']).stdout, '');
  assert.equal(rulerGit(cell, ['status', '--porcelain']).stdout, '');
  return {
    refCount,
    origin,
    cell,
    baseSha,
    cellHead,
    targetTip,
    commitUnionCount: union.size,
    initialObjectSet: objectSet(origin),
    cellObjectSet: objectSet(cell),
    preRefsSha256: recordDigest(allRefs),
    nonSyntheticRefsSha256: recordDigest(nonSyntheticRefs),
    originHead: headState(origin),
    cellHeadState: headState(cell),
    cellRefsSha256: recordDigest(refRecords(cell)),
    syntheticTags,
  };
}

function expectedCaptureReport(fixture, resultSha) {
  return {
    targetBranch: TARGET_BRANCH,
    mode: 'merge',
    status: 'landed',
    reason: null,
    conflicts: [],
    cellHead: fixture.cellHead,
    baseTarget: fixture.targetTip,
    resultSha,
  };
}

function showFile(repo, commit, name) {
  return rulerGit(repo, ['show', `${commit}:${name}`]).stdout;
}

function verifyAndReset(fixture, captureReport, expectedObjects = null) {
  assert.ok(captureReport && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(captureReport.resultSha ?? ''),
    'capture must return a landed result sha');
  assert.deepEqual(captureReport, expectedCaptureReport(fixture, captureReport.resultSha));
  assert.deepEqual(headState(fixture.origin), fixture.originHead, 'origin HEAD must not move');
  assert.deepEqual(headState(fixture.cell), fixture.cellHeadState, 'Cell HEAD must not move');
  assert.equal(recordDigest(refRecords(fixture.cell)), fixture.cellRefsSha256, 'Cell refs must not change');
  assert.deepEqual(objectSet(fixture.cell), fixture.cellObjectSet, 'Cell object set must not change');
  assert.equal(rulerGit(fixture.cell, ['status', '--porcelain']).stdout, '', 'Cell worktree must remain clean');
  assert.equal(rulerGit(fixture.origin, ['for-each-ref', 'refs/hive/']).stdout, '', 'transient ref must not survive');
  assert.equal(rev(fixture.origin, TARGET_BRANCH), captureReport.resultSha, 'target must point at result');

  const parents = rulerGit(fixture.origin, ['show', '-s', '--format=%P', captureReport.resultSha])
    .stdout.trim().split(' ');
  assert.deepEqual(parents, [fixture.targetTip, fixture.cellHead], 'merge parent order must stay fixed');
  const tree = treeSnapshot(fixture.origin, captureReport.resultSha);
  assert.equal(tree.fileCount, FILE_COUNT, 'final merge tree must have exactly 12 files');
  assert.deepEqual(tree.names,
    Array.from({ length: FILE_COUNT }, (_, index) => `f${String(index).padStart(2, '0')}.txt`));
  assert.equal(showFile(fixture.origin, captureReport.resultSha, 'f00.txt'),
    `cell revision ${CELL_COMMITS - 1}\n`.repeat(8));
  assert.equal(showFile(fixture.origin, captureReport.resultSha, 'f11.txt'), 'target revision\n'.repeat(8));
  const timestamps = rulerGit(fixture.origin,
    ['show', '-s', '--format=%at%x00%ct', captureReport.resultSha]).stdout.trim().split('\0');
  assert.deepEqual(timestamps, [FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS], 'result dates must stay pinned');
  const commitBytes = rulerGit(fixture.origin, ['cat-file', 'commit', captureReport.resultSha]).stdout;
  const result = {
    sha: captureReport.resultSha,
    tree: tree.tree,
    parents,
    fileCount: tree.fileCount,
    names: tree.names,
    treeManifestSha256: tree.manifestSha256,
    commitObjectSha256: sha256(commitBytes),
    authorEpochSeconds: timestamps[0],
    committerEpochSeconds: timestamps[1],
  };

  rulerGit(fixture.origin, ['update-ref', `refs/heads/${TARGET_BRANCH}`,
    fixture.targetTip, captureReport.resultSha]);
  assert.equal(recordDigest(refRecords(fixture.origin)), fixture.preRefsSha256,
    'origin refs must return exactly to their pre-sample state');
  assert.equal(rulerGit(fixture.origin, ['status', '--porcelain']).stdout, '',
    'origin worktree and index must remain clean');
  const objects = objectSet(fixture.origin);
  if (expectedObjects !== null) assert.deepEqual(objects, expectedObjects,
    'capture must retain the exact warmed object set');
  return { passed: true, result, objectSet: objects };
}

function readTraceEvents(path) {
  const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.trim());
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`malformed Trace2 JSON on line ${index + 1}`, { cause: error }); }
  });
}

function retainAndSummarizeTrace(path, retainedPath) {
  const bytes = readFileSync(path);
  assert.equal(existsSync(retainedPath), false, `refusing to overwrite Trace2 artifact: ${retainedPath}`);
  writeFileSync(retainedPath, bytes, { flag: 'wx', mode: 0o600 });
  const events = readTraceEvents(path);
  const topLevel = summarizeGitTrace(events);
  const summary = summarizeGitRusageTrace(events);
  assert.equal(summary.rootGitCommands, topLevel.commandCount, 'Trace2 root summaries disagree');
  return {
    artifact: { path: retainedPath, bytes: bytes.length, sha256: sha256(bytes) },
    summary: { ...summary, topLevelWallMs: topLevel.wallMs },
    maintenance: attributeMaintenanceDescendants(summary),
  };
}

function captureError(error) {
  return {
    name: error instanceof Error ? error.name : 'NonErrorThrown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? null) : null,
  };
}

function runCapture(captureWork, fixture, opId) {
  return captureWork({
    originRepo: fixture.origin,
    cellSpaceDir: fixture.cell,
    targetBranch: TARGET_BRANCH,
    mode: 'merge',
    opId,
  });
}

function normalizeCaptureArg(value) {
  return normalizeGitRusageArg(value)
    .replace(/\/refs-\d{6}(?=\/|$)/g, '/refs-<count>')
    .replace(/cell-ref-fanout-\d{6}-diagnostic/g, 'cell-ref-fanout-<count>-diagnostic');
}

function timeCapture(captureWork, fixture, opId) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  let outcome = null;
  let error = null;
  try { outcome = runCapture(captureWork, fixture, opId); }
  catch (caught) { error = captureError(caught); }
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return {
    outcome,
    error,
    wallMs,
    parentCpuMs: (cpu.user + cpu.system) / 1000,
  };
}

function parseCountObjects(repo) {
  return Object.fromEntries(gitLines(repo, ['count-objects', '-v']).map(line => {
    const separator = line.indexOf(':');
    assert.ok(separator > 0, `malformed count-objects line: ${line}`);
    return [line.slice(0, separator), line.slice(separator + 1).trim()];
  }));
}

function measureCleanup(path) {
  const cpuStart = process.cpuUsage();
  const wallStart = performance.now();
  rmSync(path, { recursive: true, force: true });
  const wallMs = performance.now() - wallStart;
  const cpu = process.cpuUsage(cpuStart);
  return {
    wallMs,
    parentCpuMs: (cpu.user + cpu.system) / 1000,
    removed: !existsSync(path),
  };
}

const startedAt = new Date().toISOString();
const sourceStart = sourceFingerprint(options.root);
const toolsStart = toolFingerprint();
const bootStart = bootIdentity();
const temporaryFilesystemStart = filesystemFingerprint(tmpdir());
const gitVersion = rulerGit(options.root, ['--version']).stdout.trim();
const captureWork = (await import(pathToFileURL(
  join(options.root, 'v2/driver-cell/src/capture.ts')).href)).captureWork;
assert.equal(typeof captureWork, 'function', 'source root does not export captureWork');

for (const refCount of options.refCounts) {
  const token = refToken(refCount);
  for (const path of [
    `${options.out}.refs-${token}.trace2.jsonl`,
    `${options.out}.refs-${token}.git-rusage-records`,
  ]) assert.equal(existsSync(path), false, `refusing to overwrite artifact: ${path}`);
  for (let sample = 0; sample < options.samples; sample++) {
    const ordinalToken = String(sample).padStart(2, '0');
    assert.equal(existsSync(`${options.out}.refs-${token}.scratch-${ordinalToken}.trace2.jsonl`), false,
      'refusing to overwrite scratch Trace2 artifact');
  }
}

const runDir = mkdtempSync(join(tmpdir(), 'hb-cell-ref-fanout-'));
const measuredOrder = balancedRefSchedule(options.refCounts, options.samples);
const report = {
  schemaVersion: 1,
  completed: false,
  startedAt,
  timestamp: null,
  failure: null,
  source: { start: sourceStart, end: null },
  tools: { start: toolsStart, end: null },
  environment: {
    node: process.version,
    execArgv: process.execArgv,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    hostname: hostname(),
    gitVersion,
    bootIdentityStart: bootStart,
    bootIdentityEnd: null,
    temporaryFilesystemStart,
    temporaryFilesystemEnd: null,
    loadBefore: loadavg(),
    loadAfter: null,
    nodeCompileCache: process.env.NODE_COMPILE_CACHE ?? null,
    nodeOptionsSha256: sha256(process.env.NODE_OPTIONS ?? ''),
  },
  workload: {
    refCounts: options.refCounts,
    samplesPerRefCount: options.samples,
    warmupsPerRefCount: 1,
    measuredOrder,
    fixture: {
      files: FILE_COUNT,
      inputCommitUnion: INPUT_COMMIT_UNION,
      cellCommits: CELL_COMMITS,
      finalFiles: FILE_COUNT,
      resultAddsMergeCommit: true,
    },
    tags: {
      kind: 'packed lightweight tags',
      prefix: TAG_PREFIX,
      target: 'the fixed base commit',
      setup: 'update-ref --stdin followed by pack-refs --all for every count, including zero',
    },
    pinnedDates: FIXED_DATE,
    ownedPathTokens: 'six decimal digits for ref counts and two decimal digits for sample ordinals',
    fixtureMaintenance: 'maintenance.auto=false and gc.auto=0 in origin, Cell, and shaper only; production scratch clones keep defaults',
    order: 'three-count rotating Latin order, mirrored after the first three sample rows',
  },
  measurement: {
    headline: { startedAt: null, finishedAt: null },
    diagnostics: { startedAt: null, finishedAt: null },
  },
  fixtureParity: null,
  gitRusageProvenance: null,
  results: [],
  rows: [],
  interpretation: {
    headline: 'wallMs and parentCpuMs come only from uninstrumented captureWork calls. Parent CPU excludes Git children.',
    trace2: 'Trace2 uses one later captureWork call per ref count. It retains root and child argv and outcomes but is not a kernel process census.',
    gitRusage: 'Git rusage uses another later captureWork call per ref count. Each total sums non-overlapping direct Git trees and includes descendants that the direct Git process terminated and waited for.',
    scratchStorage: 'Scratch clone and storage inspection are separate diagnostics. The snapshot is immediately after no-checkout clone, not a full-capture peak. Clone timings include Trace2 overhead. Cleanup timing includes only synchronous recursive removal after storage inspection.',
    maintenance: 'Production maintenance descendants are retained and attributed to their direct Git parent. Their presence or nonzero outcome does not discard a sample. Missing or unaccountable evidence makes the report incomplete.',
    sumOfMedians: {
      label: 'A sum of per-command medians is descriptive only.',
      representativeCaptureTotal: false,
      emittedByThisRuler: false,
    },
  },
  scope: 'Real captureWork over fresh owned Git fixtures. No provider, live daemon, production store, RPC, or provisioning is involved.',
};

function writeReport() {
  mkdirSync(dirname(options.out), { recursive: true });
  const temporary = `${options.out}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, options.out);
}

function failureEvidence(error, scenario) {
  return { scenario, ...captureError(error), at: new Date().toISOString() };
}

let active = 'initialization';
let cleaning = false;
function cleanup() {
  if (cleaning) return;
  cleaning = true;
  rmSync(runDir, { recursive: true, force: true });
}

function onSignal(signal) {
  report.failure ??= failureEvidence(new Error(`interrupted by ${signal}`), active);
  report.timestamp = new Date().toISOString();
  report.environment.loadAfter = loadavg();
  try { writeReport(); }
  finally { cleanup(); }
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
process.once('SIGINT', onSigint);
process.once('SIGTERM', onSigterm);

try {
  writeReport();
  active = 'environment-provenance';
  assert.ok(bootStart !== null, 'OS boot identity is required for this macOS ruler');
  for (const key of ['deviceName', 'typeName', 'mountPoint']) {
    assert.ok(temporaryFilesystemStart[key], `temporary filesystem ${key} provenance is required`);
  }
  active = 'git-rusage-setup';
  const rusageSession = setupGitRusage({
    runDir,
    pythonExecutable: options.pythonExecutable,
  });
  report.gitRusageProvenance = { ...rusageSession.provenance, endFingerprints: null };
  writeReport();

  active = 'fixture-setup';
  const fixtures = options.refCounts.map(refCount => {
    const dir = join(runDir, `refs-${refToken(refCount)}`);
    mkdirSync(dir, { recursive: true });
    return buildFixture(dir, refCount);
  });
  const parityProjection = fixture => ({
    baseSha: fixture.baseSha,
    cellHead: fixture.cellHead,
    targetTip: fixture.targetTip,
    commitUnionCount: fixture.commitUnionCount,
    initialObjectSet: fixture.initialObjectSet,
    cellObjectSet: fixture.cellObjectSet,
    nonSyntheticRefsSha256: fixture.nonSyntheticRefsSha256,
    originHead: fixture.originHead,
    cellHeadState: fixture.cellHeadState,
    cellRefsSha256: fixture.cellRefsSha256,
  });
  const expectedInitialParity = parityProjection(fixtures[0]);
  for (const fixture of fixtures.slice(1)) assert.deepEqual(parityProjection(fixture), expectedInitialParity,
    'fixtures must differ only by the synthetic packed tags');
  report.fixtureParity = {
    validated: true,
    fields: expectedInitialParity,
    scope: 'logical commits, objects, non-synthetic refs, HEAD states, and Cell refs; owned paths use equal-width count tokens',
    allowedLogicalDifference: 'synthetic packed tag manifest and resulting packed-refs storage only',
  };

  report.results = fixtures.map(fixture => ({
    refCount: fixture.refCount,
    fixture: {
      baseSha: fixture.baseSha,
      cellHead: fixture.cellHead,
      targetTip: fixture.targetTip,
      commitUnionCount: fixture.commitUnionCount,
      initialObjectSet: fixture.initialObjectSet,
      cellObjectSet: fixture.cellObjectSet,
      steadyObjectSet: null,
      preRefsSha256: fixture.preRefsSha256,
      nonSyntheticRefsSha256: fixture.nonSyntheticRefsSha256,
      syntheticTags: fixture.syntheticTags,
    },
    warmup: null,
    expectedResult: null,
    headline: { raw: [], wallMs: null, parentCpuMs: null },
    trace2: null,
    gitRusage: null,
    scratchStorage: null,
  }));
  writeReport();

  active = 'warmups';
  for (let index = 0; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    const outcome = runCapture(captureWork, fixture,
      `cell-ref-fanout-${refToken(fixture.refCount)}-warmup`);
    const semanticCheck = verifyAndReset(fixture, outcome);
    fixture.steadyObjectSet = semanticCheck.objectSet;
    fixture.expectedResult = semanticCheck.result;
    report.results[index].fixture.steadyObjectSet = semanticCheck.objectSet;
    report.results[index].expectedResult = semanticCheck.result;
    report.results[index].warmup = { captureOutcome: outcome, semanticCheck };
    writeReport();
  }
  for (const fixture of fixtures.slice(1)) {
    assert.deepEqual(fixture.steadyObjectSet, fixtures[0].steadyObjectSet,
      'warmed object sets must match across tag counts');
    assert.deepEqual(fixture.expectedResult, fixtures[0].expectedResult,
      'pinned final tree, parents, and sha must match across tag counts');
  }

  active = 'headline';
  report.measurement.headline.startedAt = new Date().toISOString();
  const resultByCount = new Map(report.results.map(result => [result.refCount, result]));
  const fixtureByCount = new Map(fixtures.map(fixture => [fixture.refCount, fixture]));
  const ordinals = new Map(options.refCounts.map(refCount => [refCount, 0]));
  for (let sequence = 0; sequence < measuredOrder.length; sequence++) {
    const refCount = measuredOrder[sequence];
    const result = resultByCount.get(refCount);
    const fixture = fixtureByCount.get(refCount);
    const ordinal = ordinals.get(refCount);
    ordinals.set(refCount, ordinal + 1);
    active = `headline refs=${refCount} sample=${ordinal}`;
    const timed = timeCapture(captureWork, fixture,
      `cell-ref-fanout-${refToken(refCount)}-headline-${String(ordinal).padStart(2, '0')}`);
    const record = {
      sequence,
      ordinal,
      refCount,
      wallMs: timed.wallMs,
      parentCpuMs: timed.parentCpuMs,
      captureOutcome: timed.outcome,
      captureError: timed.error,
      semanticCheck: { passed: false },
    };
    result.headline.raw.push(record);
    writeReport();
    if (timed.error !== null) throw new Error(`captureWork threw during ${active}: ${timed.error.message}`);
    try {
      const semanticCheck = verifyAndReset(fixture, timed.outcome, fixture.steadyObjectSet);
      assert.deepEqual(semanticCheck.result, fixture.expectedResult,
        'headline result must match the pinned warmup result');
      record.semanticCheck = semanticCheck;
      writeReport();
    } catch (error) {
      record.semanticCheck = { passed: false, error: captureError(error) };
      writeReport();
      throw error;
    }
  }
  report.measurement.headline.finishedAt = new Date().toISOString();
  for (const result of report.results) {
    assert.equal(result.headline.raw.length, options.samples, 'headline sample count mismatch');
    result.headline.wallMs = distribution(result.headline.raw.map(sample => sample.wallMs));
    result.headline.parentCpuMs = distribution(result.headline.raw.map(sample => sample.parentCpuMs));
  }
  writeReport();

  report.measurement.diagnostics.startedAt = new Date().toISOString();
  for (const fixture of fixtures) {
    const result = resultByCount.get(fixture.refCount);
    const token = refToken(fixture.refCount);
    const diagnosticId = `cell-ref-fanout-${token}-diagnostic`;
    active = `trace2 refs=${fixture.refCount}`;
    const tracePath = join(runDir, `refs-${token}.capture.trace2.jsonl`);
    let traceOutcome = null;
    let traceError = null;
    process.env.GIT_TRACE2_EVENT = tracePath;
    try { traceOutcome = runCapture(captureWork, fixture, diagnosticId); }
    catch (error) { traceError = captureError(error); }
    finally { delete process.env.GIT_TRACE2_EVENT; }
    const trace = retainAndSummarizeTrace(
      tracePath, `${options.out}.refs-${token}.trace2.jsonl`);
    result.trace2 = {
      diagnosticOnly: true,
      captureOutcome: traceOutcome,
      captureError: traceError,
      semanticCheck: { passed: false },
      ...trace,
    };
    writeReport();
    if (traceError !== null) throw new Error(`captureWork threw during ${active}: ${traceError.message}`);
    result.trace2.semanticCheck = verifyAndReset(fixture, traceOutcome, fixture.steadyObjectSet);
    assert.deepEqual(result.trace2.semanticCheck.result, fixture.expectedResult,
      'Trace2 result must match the pinned result');
    writeReport();

    active = `git-rusage refs=${fixture.refCount}`;
    const captured = captureGitRusage(rusageSession, {
      id: `refs-${token}`,
      operation: () => runCapture(captureWork, fixture, diagnosticId),
      retainedDir: `${options.out}.refs-${token}.git-rusage-records`,
    });
    result.gitRusage = {
      diagnosticOnly: true,
      trace2Disabled: true,
      captureOutcome: captured.value ?? null,
      captureError: captured.failed ? captureError(captured.error) : null,
      semanticCheck: { passed: false },
      aggregate: null,
      rawArtifact: captured.rawArtifact,
      maintenanceAttribution: trace.maintenance,
    };
    writeReport();
    if (captured.failed) throw captured.error;
    result.gitRusage.semanticCheck = verifyAndReset(fixture, captured.value, fixture.steadyObjectSet);
    assert.deepEqual(result.gitRusage.semanticCheck.result, fixture.expectedResult,
      'Git rusage result must match the pinned result');
    assert.deepEqual(captured.value, traceOutcome,
      'separate Trace2 and Git rusage capture outcomes must match');
    result.gitRusage.aggregate = aggregateGitRusage({
      recordsDir: captured.recordsDir,
      runId: captured.runId,
      expectedCount: trace.summary.rootGitCommands,
      expectedLauncherPid: process.pid,
      tracePath,
    });
    writeReport();
  }
  const traceRootShape = report.results[0].trace2.summary.rootArgv
    .map(argv => argv.map(normalizeCaptureArg));
  assert.ok(traceRootShape.some(argv => argv.includes('merge-tree')),
    'clean capture must exercise object-only merge-tree');
  assert.ok(traceRootShape.some(argv => argv.includes('commit-tree')),
    'clean capture must exercise object-only commit-tree');
  assert.equal(traceRootShape.some(argv => argv.includes('checkout')), false,
    'clean capture must not materialize a checkout');
  assert.equal(traceRootShape.some(argv => argv.includes('merge')), false,
    'clean capture must not run working-tree merge');
  for (const result of report.results.slice(1)) {
    assert.deepEqual(result.trace2.summary.rootArgv.map(argv => argv.map(normalizeCaptureArg)),
      traceRootShape, 'captureWork direct Git command shape must match across ref counts');
  }
  report.fixtureParity.normalizedTraceRootArgvMatched = true;
  report.fixtureParity.objectOnlyTraceValidated = true;
  writeReport();

  mkdirSync(join(runDir, 'scratch-storage'), { recursive: true });
  mkdirSync(join(runDir, 'scratch-traces'), { recursive: true });
  for (const fixture of fixtures) {
    const result = resultByCount.get(fixture.refCount);
    result.scratchStorage = {
      diagnosticOnly: true,
      cloneTrace2Instrumented: true,
      cloneCommand: ['git', 'clone', '--quiet', '--shared', '--no-checkout', '<origin>', '<scratchRepo>'],
      snapshotPoint: 'immediately after no-checkout clone and before capture merge objects',
      originStorage: summarizeScratchTree(join(fixture.origin, '.git')),
      originCountObjects: parseCountObjects(fixture.origin),
      raw: [],
      cloneWallMs: null,
      cloneParentCpuMs: null,
      cleanupWallMs: null,
      cleanupParentCpuMs: null,
      scratchLogicalBytes: null,
      scratchAllocatedBytes: null,
    };
  }
  writeReport();
  const storageOrdinals = new Map(options.refCounts.map(refCount => [refCount, 0]));
  for (let sequence = 0; sequence < measuredOrder.length; sequence++) {
      const refCount = measuredOrder[sequence];
      const fixture = fixtureByCount.get(refCount);
      const scratchStorage = resultByCount.get(refCount).scratchStorage;
      const ordinal = storageOrdinals.get(refCount);
      storageOrdinals.set(refCount, ordinal + 1);
      active = `scratch-storage refs=${refCount} sample=${ordinal}`;
      const token = refToken(refCount);
      const ordinalToken = String(ordinal).padStart(2, '0');
      const sampleRoot = join(runDir, 'scratch-storage', `refs-${token}-${ordinalToken}`);
      const scratchRepo = join(sampleRoot, 'repo');
      mkdirSync(sampleRoot, { recursive: true });
      const tracePath = join(runDir, 'scratch-traces', `refs-${token}-${ordinalToken}.trace2.jsonl`);
      const record = {
        sequence,
        ordinal,
        refCount,
        clone: null,
        storage: null,
        semanticCheck: { passed: false },
        cleanup: null,
      };
      scratchStorage.raw.push(record);
      writeReport();
      let sampleError = null;
      try {
        const cpuStart = process.cpuUsage();
        const wallStart = performance.now();
        process.env.GIT_TRACE2_EVENT = tracePath;
        let cloneRun;
        try {
          cloneRun = rulerGit(sampleRoot,
            ['clone', '--quiet', '--shared', '--no-checkout', fixture.origin, scratchRepo],
            { allowFail: true });
        } finally {
          delete process.env.GIT_TRACE2_EVENT;
        }
        const wallMs = performance.now() - wallStart;
        const cpu = process.cpuUsage(cpuStart);
        const retainedTrace = `${options.out}.refs-${token}.scratch-${ordinalToken}.trace2.jsonl`;
        const trace = retainAndSummarizeTrace(tracePath, retainedTrace);
        record.clone = {
          wallMs,
          parentCpuMs: (cpu.user + cpu.system) / 1000,
          status: cloneRun.status,
          signal: cloneRun.signal,
          stderr: cloneRun.stderr,
          trace2Instrumented: true,
          traceArtifact: trace.artifact,
          trace2: trace.summary,
          maintenance: trace.maintenance,
        };
        assert.equal(cloneRun.status, 0, `scratch clone failed: ${cloneRun.stderr}`);
        assert.deepEqual(readdirSync(scratchRepo).sort(), ['.git'],
          'no-checkout scratch clone must not materialize files');
        const tags = refRecords(scratchRepo, TAG_PREFIX);
        assert.equal(tags.length, fixture.refCount, 'scratch synthetic tag count mismatch');
        assert.ok(tags.every(tag => tag.object === fixture.baseSha),
          'scratch synthetic tags must retain the base target');
        const alternatesPath = join(scratchRepo, '.git', 'objects', 'info', 'alternates');
        const alternates = readFileSync(alternatesPath, 'utf8').trim();
        const expectedAlternates = realpathSync(join(fixture.origin, '.git', 'objects'));
        const alternatesMatchesOrigin = realpathSync(alternates) === expectedAlternates;
        assert.equal(alternatesMatchesOrigin, true, 'shared clone alternates must point at origin objects');
        const storage = summarizeScratchTree(scratchRepo);
        const localMaintenance = rulerGit(scratchRepo,
          ['config', '--local', '--get', 'maintenance.auto'], { allowFail: true });
        const localGcAuto = rulerGit(scratchRepo,
          ['config', '--local', '--get', 'gc.auto'], { allowFail: true });
        assert.equal(localMaintenance.status, 1,
          'production scratch clone must not inherit fixture maintenance.auto');
        assert.equal(localGcAuto.status, 1,
          'production scratch clone must not inherit fixture gc.auto');
        record.storage = {
          ...storage,
          syntheticTagCount: tags.length,
          syntheticTagManifestSha256: recordDigest(tags),
          alternates,
          expectedAlternates,
          alternatesMatchesOrigin,
          countObjects: parseCountObjects(scratchRepo),
          localMaintenanceAuto: null,
          localGcAuto: null,
        };
        record.semanticCheck = { passed: true };
      } catch (error) {
        sampleError = error;
        record.semanticCheck = { passed: false, error: captureError(error) };
      } finally {
        record.cleanup = measureCleanup(sampleRoot);
        assert.equal(record.cleanup.removed, true, 'owned scratch diagnostic root must be removed');
        writeReport();
      }
      if (sampleError !== null) throw sampleError;
  }
  for (const result of report.results) {
    const scratchStorage = result.scratchStorage;
    assert.equal(scratchStorage.raw.length, options.samples, 'scratch diagnostic sample count mismatch');
    scratchStorage.cloneWallMs = distribution(scratchStorage.raw.map(sample => sample.clone.wallMs));
    scratchStorage.cloneParentCpuMs = distribution(scratchStorage.raw.map(sample => sample.clone.parentCpuMs));
    scratchStorage.cleanupWallMs = distribution(scratchStorage.raw.map(sample => sample.cleanup.wallMs));
    scratchStorage.cleanupParentCpuMs = distribution(scratchStorage.raw.map(sample => sample.cleanup.parentCpuMs));
    scratchStorage.scratchLogicalBytes = distribution(scratchStorage.raw.map(sample => sample.storage.logicalBytes));
    scratchStorage.scratchAllocatedBytes = distribution(scratchStorage.raw.map(sample => sample.storage.allocatedBytes));
    writeReport();
  }
  report.measurement.diagnostics.finishedAt = new Date().toISOString();

  active = 'final-fixture-parity';
  for (const fixture of fixtures) {
    assert.deepEqual(objectSet(fixture.origin), fixture.steadyObjectSet,
      'storage diagnostics must not change the warmed origin object set');
    assert.deepEqual(objectSet(fixture.cell), fixture.cellObjectSet,
      'measurement must not change the Cell object set');
    assert.equal(recordDigest(refRecords(fixture.origin)), fixture.preRefsSha256,
      'measurement must leave the exact origin ref set reset');
    assert.equal(recordDigest(refRecords(fixture.cell)), fixture.cellRefsSha256,
      'measurement must leave the exact Cell ref set unchanged');
    assert.deepEqual(headState(fixture.origin), fixture.originHead, 'origin HEAD must remain fixed');
    assert.deepEqual(headState(fixture.cell), fixture.cellHeadState, 'Cell HEAD must remain fixed');
    assert.equal(rulerGit(fixture.origin, ['status', '--porcelain']).stdout, '');
    assert.equal(rulerGit(fixture.cell, ['status', '--porcelain']).stdout, '');
  }

  active = 'final-provenance';
  report.source.end = sourceFingerprint(options.root);
  assert.deepEqual(report.source.end, report.source.start, 'source changed during ruler execution');
  report.tools.end = toolFingerprint();
  assert.deepEqual(report.tools.end, report.tools.start, 'measurement tools changed during ruler execution');
  report.gitRusageProvenance.endFingerprints = verifyGitRusageSetup(rusageSession);
  report.environment.bootIdentityEnd = bootIdentity();
  assert.deepEqual(report.environment.bootIdentityEnd, report.environment.bootIdentityStart,
    'OS boot identity changed during ruler execution');
  report.environment.temporaryFilesystemEnd = filesystemFingerprint(tmpdir());
  assert.deepEqual(stableFilesystemIdentity(report.environment.temporaryFilesystemEnd),
    stableFilesystemIdentity(report.environment.temporaryFilesystemStart),
    'temporary filesystem identity changed during ruler execution');
  assert.equal(rulerGit(options.root, ['--version']).stdout.trim(), gitVersion,
    'Git version changed during ruler execution');
  report.environment.loadAfter = loadavg();

  const baseline = resultByCount.get(0);
  for (const refCount of options.refCounts.filter(value => value !== 0)) {
    const treatment = resultByCount.get(refCount);
    for (const metric of ['wallMs', 'parentCpuMs']) {
      const before = baseline.headline[metric];
      const after = treatment.headline[metric];
      report.rows.push({
        baselineRefCount: 0,
        refCount,
        metric,
        before,
        after,
        deltaPercent: before.p50 === 0 ? null : (after.p50 / before.p50 - 1) * 100,
      });
    }
  }
  assert.equal(report.results.length, options.refCounts.length, 'incomplete ref-count results');
  assert.ok(report.results.every(result =>
    result.headline.raw.length === options.samples
    && result.trace2?.semanticCheck?.passed
    && result.gitRusage?.semanticCheck?.passed
    && result.gitRusage?.aggregate?.completed
    && result.scratchStorage?.raw.length === options.samples
    && result.scratchStorage.raw.every(sample => sample.semanticCheck.passed && sample.cleanup.removed)),
  'incomplete measurement or diagnostic evidence');
  report.timestamp = new Date().toISOString();
  report.completed = true;
  active = null;
  writeReport();
  console.log(options.out);
} catch (error) {
  report.failure ??= failureEvidence(error, active);
  report.environment.loadAfter = loadavg();
  report.timestamp = new Date().toISOString();
  writeReport();
  throw error;
} finally {
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  cleanup();
}
