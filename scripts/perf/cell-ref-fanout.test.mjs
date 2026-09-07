import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  attributeMaintenanceDescendants,
  balancedRefSchedule,
  deriveScratchClonePolicy,
} from './cell-ref-fanout-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ruler = join(root, 'scripts/perf/cell-ref-fanout.mjs');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function checkedGit(cwd, args) {
  const run = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'cell-ref-fanout-test',
      GIT_AUTHOR_EMAIL: 'cell-ref-fanout-test@example.invalid',
      GIT_COMMITTER_NAME: 'cell-ref-fanout-test',
      GIT_COMMITTER_EMAIL: 'cell-ref-fanout-test@example.invalid',
    },
  });
  assert.equal(run.status, 0,
    `git ${args.join(' ')} failed: ${run.error ?? ''}\n${run.stderr}`);
  return run.stdout.trim();
}

test('balancedRefSchedule gives every count equal samples and balanced positions', () => {
  const counts = [0, 1_000, 10_000];
  for (const samples of [3, 6]) {
    const order = balancedRefSchedule(counts, samples);
    assert.equal(order.length, counts.length * samples);
    for (const count of counts) assert.equal(order.filter(value => value === count).length, samples);
    const rows = Array.from({ length: samples }, (_, index) =>
      order.slice(index * counts.length, (index + 1) * counts.length));
    assert.ok(rows.every(row => new Set(row).size === counts.length));
    for (let position = 0; position < counts.length; position++) {
      const positionCounts = counts.map(count => rows.filter(row => row[position] === count).length);
      assert.ok(Math.max(...positionCounts) - Math.min(...positionCounts) <= 1);
    }
  }
});

test('maintenance descendants remain attributed even with a nonzero outcome', () => {
  const trace = {
    completeChildEvents: true,
    childEventIdentityMatched: true,
    rootOutcomes: [
      { sid: 'root-a', argv: ['git', 'clone', '--shared'], returncode: 0, exitEvents: 1 },
      { sid: 'root-b', argv: ['git', 'fetch'], returncode: 0, exitEvents: 1 },
    ],
    childProcesses: [
      { sid: 'root-a', childId: 0, argv: ['git', 'maintenance', 'run', '--auto'], returncode: 1, pid: 42 },
      { sid: 'root-a/child', childId: 1, argv: ['git-gc', '--auto'], returncode: 0, pid: 43 },
      { sid: 'root-b', childId: 0, argv: ['git-upload-pack', '/repo'], returncode: 0, pid: 44 },
    ],
  };
  const result = attributeMaintenanceDescendants(trace);
  assert.equal(result.policy, 'retain-and-attribute');
  assert.equal(result.accounted, true);
  assert.equal(result.observed.length, 2);
  assert.deepEqual(result.observed.map(value => value.kind), ['maintenance', 'gc']);
  assert.deepEqual(result.observed.map(value => value.returncode), [1, 0], 'adverse outcome is retained');
  assert.deepEqual(result.observed[0].attributedRootArgv, ['git', 'clone', '--shared']);
  assert.deepEqual(result.observed[1].attributedRootArgv, ['git', 'clone', '--shared']);
  assert.equal(result.nonzeroOutcomes, 1);
});

test('scratch clone policy accepts only legacy flags plus optional --no-tags', () => {
  const origin = '/fixture/origin';
  const scratch = '/fixture/scratch';
  const oldClone = ['/usr/bin/git', 'clone', '--quiet', '--shared', '--no-checkout', origin, scratch];
  const noTagsClone = [
    '/usr/bin/git', 'clone', '--quiet', '--no-tags', '--shared', '--no-checkout', origin, scratch,
  ];
  assert.deepEqual(deriveScratchClonePolicy([
    ['/usr/bin/git', 'merge-tree', '--write-tree', 'a', 'b'],
    oldClone,
  ]), {
    capturedArgv: oldClone,
    flags: ['--quiet', '--shared', '--no-checkout'],
    excludesTags: false,
  });
  assert.deepEqual(deriveScratchClonePolicy([noTagsClone]), {
    capturedArgv: noTagsClone,
    flags: ['--quiet', '--no-tags', '--shared', '--no-checkout'],
    excludesTags: true,
  });

  for (const rootArgv of [
    [],
    [oldClone, oldClone],
    [['/usr/bin/git', 'clone', '--quiet', '--no-checkout', origin, scratch]],
    [['/usr/bin/git', 'clone', '--quiet', '--shared', '--filter=blob:none', '--no-checkout', origin, scratch]],
    [['/usr/bin/git', 'clone', '--quiet', '--no-tags', '--shared', '--no-tags', '--no-checkout', origin, scratch]],
    [['/usr/bin/git', 'clone', '--shared', '--quiet', '--no-checkout', origin, scratch]],
    [['/usr/bin/git', 'clone', '--quiet', '--shared', '--no-checkout', origin, scratch, '/extra']],
  ]) {
    assert.throws(() => deriveScratchClonePolicy(rootArgv));
  }
});

test('scratch clone policy drives real Git tag transfer diagnostics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-cell-ref-clone-policy-test-'));
  try {
    const origin = join(dir, 'origin');
    mkdirSync(origin);
    checkedGit(origin, ['init', '--quiet']);
    writeFileSync(join(origin, 'fixture.txt'), 'fixture\n');
    checkedGit(origin, ['add', 'fixture.txt']);
    checkedGit(origin, ['commit', '--quiet', '-m', 'fixture']);
    checkedGit(origin, ['tag', 'hive-fixture/000001']);

    for (const scenario of [
      { name: 'legacy', extra: [], expectedTags: ['refs/tags/hive-fixture/000001'] },
      { name: 'no-tags', extra: ['--no-tags'], expectedTags: [] },
    ]) {
      const capturedDestination = join(dir, `captured-${scenario.name}`);
      const capturedArgv = [
        '/usr/bin/git', 'clone', '--quiet', '--shared', ...scenario.extra, '--no-checkout',
        origin, capturedDestination,
      ];
      const policy = deriveScratchClonePolicy([capturedArgv]);
      const scratch = join(dir, scenario.name);
      checkedGit(dir, ['clone', ...policy.flags, origin, scratch]);
      const refs = checkedGit(scratch,
        ['for-each-ref', '--format=%(refname)', 'refs/tags/hive-fixture'])
        .split('\n').filter(Boolean);
      assert.deepEqual(refs, scenario.expectedTags);
      assert.equal(policy.excludesTags, scenario.expectedTags.length === 0);
      assert.deepEqual(readdirSync(scratch).sort(), ['.git']);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cell-ref-fanout smoke preserves fixture parity and separates all diagnostics', {
  skip: process.platform !== 'darwin' || !existsSync('/usr/bin/python3'),
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-cell-ref-fanout-test-'));
  try {
    const out = join(dir, 'report.json');
    const run = spawnSync(process.execPath, [ruler,
      '--root', root,
      '--out', out,
      '--samples', '3',
      '--refs', '0,7,13',
      '--git-rusage-python', '/usr/bin/python3',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: dir },
      timeout: 480_000,
    });
    assert.equal(run.status, 0, `${run.error ?? ''}\n${run.stderr}`);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.completed, true);
    assert.equal(report.failure, null);
    assert.deepEqual(report.workload.refCounts, [0, 7, 13]);
    assert.deepEqual(report.workload.fixture, {
      files: 12,
      inputCommitUnion: 14,
      cellCommits: 12,
      finalFiles: 12,
      resultAddsMergeCommit: true,
    });
    assert.equal(report.workload.samplesPerRefCount, 3);
    assert.equal(report.workload.warmupsPerRefCount, 1);
    assert.equal(report.workload.measuredOrder.length, 9);
    assert.equal(report.results.length, 3);

    const initialObjects = new Set(report.results.map(result => result.fixture.initialObjectSet.sha256));
    const cellObjects = new Set(report.results.map(result => result.fixture.cellObjectSet.sha256));
    const steadyObjects = new Set(report.results.map(result => result.fixture.steadyObjectSet.sha256));
    const finalShas = new Set(report.results.map(result => result.expectedResult.sha));
    const finalTrees = new Set(report.results.map(result => result.expectedResult.tree));
    const finalParents = new Set(report.results.map(result => JSON.stringify(result.expectedResult.parents)));
    const originPathLengths = new Set(report.results.map(result => result.scratchStorage.originStorage.root.length));
    const scratchPathLengths = new Set(report.results.flatMap(result =>
      result.scratchStorage.raw.map(sample => sample.storage.root.length)));
    assert.equal(initialObjects.size, 1, 'tag count adds no objects');
    assert.equal(cellObjects.size, 1, 'Cell object sets match across tag counts');
    assert.equal(steadyObjects.size, 1, 'warmup and reset leave equal object sets');
    assert.equal(finalShas.size, 1, 'pinned merge sha matches across tag counts');
    assert.equal(finalTrees.size, 1);
    assert.equal(finalParents.size, 1);
    assert.equal(originPathLengths.size, 1, 'fixed-width ref tokens keep origin paths equal');
    assert.equal(scratchPathLengths.size, 1, 'fixed-width ref and sample tokens keep scratch paths equal');

    for (const result of report.results) {
      assert.equal(result.fixture.syntheticTags.count, result.refCount);
      assert.equal(result.fixture.syntheticTags.looseCount, 0);
      assert.equal(result.fixture.commitUnionCount, 14);
      assert.equal(result.expectedResult.fileCount, 12);
      assert.equal(result.headline.raw.length, 3);
      assert.ok(result.headline.raw.every(sample => sample.semanticCheck.passed));
      assert.equal(result.headline.wallMs.n, 3);
      assert.equal(result.headline.parentCpuMs.n, 3);

      assert.equal(result.trace2.diagnosticOnly, true);
      assert.equal(result.trace2.captureOutcome.status, 'landed');
      assert.equal(result.trace2.summary.completeRootOutcomes, true);
      assert.equal(result.trace2.maintenance.policy, 'retain-and-attribute');
      const traceBytes = readFileSync(result.trace2.artifact.path);
      assert.equal(sha256(traceBytes), result.trace2.artifact.sha256);

      assert.equal(result.gitRusage.diagnosticOnly, true);
      assert.equal(result.gitRusage.aggregate.completed, true);
      assert.equal(result.gitRusage.aggregate.directGitCommands,
        result.trace2.summary.rootGitCommands);
      assert.equal(result.gitRusage.aggregate.trace2.completeChildEvents, true);
      assert.equal(result.gitRusage.rawArtifact.files.length,
        result.gitRusage.aggregate.directGitCommands);
      for (const file of result.gitRusage.rawArtifact.files) {
        const bytes = readFileSync(join(result.gitRusage.rawArtifact.path, file.name));
        assert.equal(sha256(bytes), file.sha256);
      }

      assert.equal(result.scratchStorage.diagnosticOnly, true);
      assert.equal(result.scratchStorage.raw.length, 3);
      assert.equal(result.scratchStorage.cleanupWallMs.n, 3);
      assert.equal(result.scratchStorage.cleanupParentCpuMs.n, 3);
      assert.equal(result.scratchStorage.expectedSyntheticTagCount,
        result.scratchStorage.excludesTags ? 0 : result.refCount);
      assert.deepEqual(result.scratchStorage.cloneCommand,
        ['git', 'clone', ...result.scratchStorage.cloneFlags, '<origin>', '<scratchRepo>']);
      assert.ok(result.trace2.summary.rootArgv.some(argv =>
        JSON.stringify(argv) === JSON.stringify(result.scratchStorage.productionTraceCloneArgv)));
      for (const sample of result.scratchStorage.raw) {
        assert.equal(sample.semanticCheck.passed, true);
        assert.equal(sample.storage.syntheticTagCount,
          result.scratchStorage.expectedSyntheticTagCount);
        assert.equal(sample.storage.alternatesMatchesOrigin, true);
        assert.equal(sample.storage.localMaintenanceAuto, null);
        assert.equal(sample.storage.localGcAuto, null);
        assert.equal(sample.cleanup.removed, true);
        assert.equal(sample.clone.trace2.completeRootOutcomes, true);
        const bytes = readFileSync(sample.clone.traceArtifact.path);
        assert.equal(sha256(bytes), sample.clone.traceArtifact.sha256);
      }
    }

    assert.deepEqual(report.source.end, report.source.start);
    assert.deepEqual(report.tools.end, report.tools.start);
    assert.deepEqual(report.environment.bootIdentityEnd, report.environment.bootIdentityStart);
    assert.equal(report.interpretation.sumOfMedians.representativeCaptureTotal, false);
    assert.match(report.interpretation.sumOfMedians.label, /descriptive/i);
    assert.equal(report.fixtureParity.normalizedTraceRootArgvMatched, true);
    assert.equal(report.fixtureParity.objectOnlyTraceValidated, true);
    assert.equal(report.fixtureParity.scratchClonePolicyMatched, true);
    assert.equal(report.rows.length, 4, 'two headline metrics against zero-ref baseline');
    assert.ok(readdirSync(dir).every(name => !name.startsWith('hb-cell-ref-fanout-')),
      'ruler-owned working directory must be removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cell-ref-fanout rejects out-of-scope CLI values before fixture work', () => {
  const valid = ['--root', root, '--out', 'report.json', '--samples', '3',
    '--refs', '0,7,13', '--git-rusage-python', '/usr/bin/python3'];
  for (const argv of [
    [],
    valid.flatMap((value, index) => index >= valid.length - 2 ? [] : [value]),
    valid.map(value => value === '3' ? '2' : value),
    valid.map(value => value === '0,7,13' ? '1,7,13' : value),
    valid.map(value => value === '0,7,13' ? '0,7' : value),
    [...valid, '--unknown'],
  ]) {
    const run = spawnSync(process.execPath, [ruler, ...argv], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 1, `unexpected status for ${JSON.stringify(argv)}: ${run.stderr}`);
    assert.match(run.stderr, /usage:|samples|three|zero|unknown|git-rusage-python/i);
  }
});

test('cell-ref-fanout retains setup failure evidence and removes its owned run directory', {
  skip: process.platform !== 'darwin',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-cell-ref-fanout-failure-test-'));
  try {
    const out = join(dir, 'report.json');
    const run = spawnSync(process.execPath, [ruler,
      '--root', root,
      '--out', out,
      '--samples', '3',
      '--refs', '0,7,13',
      '--git-rusage-python', '/definitely/missing/python3',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: dir },
      timeout: 60_000,
    });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /ENOENT|no such file/i);
    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(report.completed, false);
    assert.equal(report.failure.scenario, 'git-rusage-setup');
    assert.equal(report.gitRusageProvenance, null);
    assert.deepEqual(readdirSync(dir), ['report.json'], 'owned run directory must be removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
