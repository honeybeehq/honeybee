import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import {
  aggregateGitRusageRecords, normalizeGitRusageArg, readGitRusageRecords,
  setupGitRusage, summarizeGitRusageTrace, validateGitRusageMode,
  verifyGitRusageSetup,
} from './git-rusage.mjs';

const ADDITIVE_KEYS = [
  'userMicros', 'systemMicros', 'minflt', 'majflt', 'nswap', 'inblock',
  'oublock', 'msgsnd', 'msgrcv', 'nsignals', 'nvcsw', 'nivcsw',
];

function usage(values, maxRssBytes) {
  return { userMicros: values.userMicros, systemMicros: values.systemMicros,
    maxRssBytes, ...Object.fromEntries(ADDITIVE_KEYS.slice(2).map(key => [key, values[key]])) };
}

function record(argv, returncode, started, maxRssBytes, launcherPid = 1234) {
  const additiveDelta = Object.fromEntries(ADDITIVE_KEYS.map((key, index) =>
    [key, key === 'userMicros' ? started * 10 : key === 'systemMicros' ? started : index + started]));
  const zero = Object.fromEntries(ADDITIVE_KEYS.map(key => [key, 0]));
  return {
    additiveDelta,
    argv,
    cpuMicros: additiveDelta.userMicros + additiveDelta.systemMicros,
    cwd: '/tmp/repo',
    diagnosticWallNs: started * 100,
    launcherPid,
    maxRssAttributable: true,
    maxRssBytes,
    realGitPid: 2000 + started,
    returncode,
    runId: 'test-run',
    rusageChildrenAfter: usage(additiveDelta, maxRssBytes),
    rusageChildrenBefore: usage(zero, 0),
    schemaVersion: 1,
    sequence: started - 1,
    scope: 'test fixture',
    startedEpochNs: String(started),
    startedMonotonicNs: String(started),
    terminatedBySignal: returncode < 0 ? -returncode : null,
    wrapperPid: 1000 + started,
  };
}

function evidence() {
  const records = [
    record(['git', 'status', '--short'], 0, 1, 100),
    record(['git', 'merge', '/tmp/hive-capture-rusage123/repo'], 1, 2, 200),
  ];
  const events = [
    { event: 'start', sid: 'root-1', argv: ['/absolute/git', 'status', '--short'] },
    { event: 'exit', sid: 'root-1', code: 0, t_abs: 0.01 },
    { event: 'start', sid: 'root-2', argv: ['/absolute/git', 'merge', '/tmp/hive-capture-trace456/repo'] },
    { event: 'child_start', sid: 'root-2', child_id: 7, argv: ['git-merge', 'topic'] },
    { event: 'start', sid: 'root-2/child', argv: ['git-merge', 'topic'] },
    { event: 'exit', sid: 'root-2/child', code: 1, t_abs: 0.02 },
    { event: 'child_exit', sid: 'root-2', child_id: 7, code: 1, pid: 9876 },
    { event: 'exit', sid: 'root-2', code: 1, t_abs: 0.03 },
  ];
  return { events, records };
}

const aggregate = (records, events, expectations = {}) => aggregateGitRusageRecords(
  records,
  summarizeGitRusageTrace(events),
  { expectedCount: 2, expectedLauncherPid: 1234, ...expectations },
);

test('aggregates complete rusage and exact Trace2 evidence without summing RSS', () => {
  const { events, records } = evidence();
  const result = aggregate(records, events);
  assert.equal(result.completed, true);
  assert.equal(result.directGitCommands, 2);
  assert.equal(result.realGitAndWaitedDescendantCpuMicros, 33);
  assert.equal(result.maxSingleProcessRssBytesAcrossWaitedGitTrees, 200);
  assert.equal(result.trace2.observedLaunches, 3);
  assert.deepEqual(result.trace2.childProcesses, [{
    sid: 'root-2', childId: 7, argv: ['git-merge', 'topic'], returncode: 1, pid: 9876,
  }]);
});

test('normalizes only the captureWork-owned randomized scratch repo component', () => {
  assert.equal(normalizeGitRusageArg('/tmp/hive-capture-a/repo/file'),
    '/tmp/hive-capture-<owned>/repo/file');
  assert.equal(normalizeGitRusageArg('/tmp/hive-capture-a/not-repo'),
    '/tmp/hive-capture-a/not-repo');
  assert.equal(normalizeGitRusageArg('/tmp/prefix-hive-capture-a/repo'),
    '/tmp/prefix-hive-capture-a/repo');
});

test('accepts repeated same-code root exits and preserves their count', () => {
  const { events, records } = evidence();
  events.push({ event: 'exit', sid: 'root-2', code: 1, t_abs: 0.04 });
  const result = aggregate(records, events);
  assert.equal(result.trace2.rootOutcomes[1].exitEvents, 2);
});

test('rejects a root exit outcome mismatch between separate diagnostics', () => {
  const { events, records } = evidence();
  events.at(-1).code = 2;
  assert.throws(() => aggregate(records, events), /root outcomes/);
});

test('rejects conflicting repeated Trace2 root exit outcomes', () => {
  const { events } = evidence();
  events.push({ event: 'exit', sid: 'root-2', code: 2, t_abs: 0.04 });
  assert.throws(() => summarizeGitRusageTrace(events), /conflicting exit codes/);
});

test('rejects unmatched Trace2 child identity', () => {
  const { events } = evidence();
  events.find(event => event.event === 'child_exit').child_id = 8;
  assert.throws(() => summarizeGitRusageTrace(events), /child identity mismatch/);
});

test('rejects duplicate Trace2 child starts and exits by exact identity', () => {
  const first = evidence().events;
  const childStart = first.find(event => event.event === 'child_start');
  first.splice(first.indexOf(childStart) + 1, 0, structuredClone(childStart));
  assert.throws(() => summarizeGitRusageTrace(first), /duplicate Trace2 child_start/);

  const second = evidence().events;
  const childExit = second.find(event => event.event === 'child_exit');
  second.splice(second.indexOf(childExit) + 1, 0, structuredClone(childExit));
  assert.throws(() => summarizeGitRusageTrace(second), /duplicate Trace2 child_exit/);
});

test('rejects argv differences outside the one owned scratch component', () => {
  const { events, records } = evidence();
  records[1].argv = ['git', 'merge', 'different'];
  assert.throws(() => aggregate(records, events), /root argv/);
});

test('rejects an unexpected direct launcher PID', () => {
  const { events, records } = evidence();
  assert.throws(() => aggregate(records, events, { expectedLauncherPid: 9999 }), /launcher PIDs/);
});

test('rejects an incomplete direct-record count', () => {
  const { events, records } = evidence();
  assert.throws(() => aggregate(records, events, { expectedCount: 3 }), /expected 3 direct Git records/);
});

test('raw reader rejects interrupted or foreign files instead of inventing a summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-git-rusage-records-test-'));
  try {
    chmodSync(dir, 0o700);
    const value = record(['git', 'status'], 0, 1, 100);
    writeFileSync(join(dir, 'one.json'), JSON.stringify(value) + '\n', { mode: 0o600 });
    assert.deepEqual(readGitRusageRecords(dir, 'test-run'), [value]);
    writeFileSync(join(dir, '.record-interrupted.tmp'), '{"incomplete":', { mode: 0o600 });
    assert.throws(() => readGitRusageRecords(dir, 'test-run'), /incomplete or foreign/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('raw reader rejects foreign run IDs and internally inconsistent counters', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-git-rusage-record-test-'));
  try {
    chmodSync(dir, 0o700);
    const foreign = record(['git', 'status'], 0, 1, 100);
    foreign.runId = 'other-run';
    writeFileSync(join(dir, 'foreign.json'), JSON.stringify(foreign) + '\n', { mode: 0o600 });
    assert.throws(() => readGitRusageRecords(dir, 'test-run'), /foreign record/);
    rmSync(join(dir, 'foreign.json'));
    const inconsistent = record(['git', 'status'], 0, 1, 100);
    inconsistent.additiveDelta.userMicros += 1;
    writeFileSync(join(dir, 'inconsistent.json'), JSON.stringify(inconsistent) + '\n', { mode: 0o600 });
    assert.throws(() => readGitRusageRecords(dir, 'test-run'), /additive counter mismatch/);
    rmSync(join(dir, 'inconsistent.json'));
    const first = record(['git', 'status'], 0, 1, 100);
    const duplicate = record(['git', 'symbolic-ref'], 0, 2, 100);
    duplicate.sequence = 0;
    writeFileSync(join(dir, 'first.json'), JSON.stringify(first) + '\n', { mode: 0o600 });
    writeFileSync(join(dir, 'duplicate.json'), JSON.stringify(duplicate) + '\n', { mode: 0o600 });
    assert.throws(() => readGitRusageRecords(dir, 'test-run'), /missing or duplicate.*sequence/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rusage mode is inert by default and rejects ambiguous or non-macOS opt-in', () => {
  assert.doesNotThrow(() => validateGitRusageMode({ enabled: false, pythonExecutable: undefined, platform: 'linux' }));
  assert.throws(() => validateGitRusageMode({ enabled: false, pythonExecutable: '/python', platform: 'darwin' }),
    /requires --git-rusage/);
  assert.throws(() => validateGitRusageMode({ enabled: true, pythonExecutable: '/python', platform: 'linux' }),
    /only on macOS/);
  assert.throws(() => validateGitRusageMode({ enabled: true, pythonExecutable: undefined, platform: 'darwin' }),
    /requires --git-rusage-python/);
  assert.throws(() => validateGitRusageMode({ enabled: true, pythonExecutable: 'python3', platform: 'darwin' }),
    /absolute path/);
  assert.throws(() => validateGitRusageMode({ enabled: true, pythonExecutable: '/path with spaces/python', platform: 'darwin' }),
    /shebang-safe/);
});

test('setup materializes the explicit interpreter shebang and verifies all executable hashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-git-rusage-setup-test-'));
  try {
    chmodSync(dir, 0o700);
    const fakePython = join(dir, 'python-test');
    const probe = (minor) => JSON.stringify({
      schemaVersion: 1, executable: fakePython, implementation: 'CPython',
      machine: 'arm64', version: `3.${minor}.6`, versionInfo: [3, minor, 6],
    });
    writeFileSync(fakePython, `#!/bin/sh\nprintf '%s\\n' '${probe(8)}'\n`, { mode: 0o700 });
    chmodSync(fakePython, 0o700);
    assert.throws(() => setupGitRusage({ runDir: dir, pythonExecutable: fakePython, platform: 'darwin' }),
      /Python 3\.9 or newer/);
    writeFileSync(fakePython, `#!/bin/sh\nprintf '%s\\n' '${probe(9)}'\n`, { mode: 0o700 });
    chmodSync(fakePython, 0o700);
    const session = setupGitRusage({ runDir: dir, pythonExecutable: fakePython, platform: 'darwin' });
    assert.equal(readFileSync(session.shimPath, 'utf8').split('\n')[0], `#!${fakePython}`);
    assert.equal(session.provenance.python.path, fakePython);
    assert.equal(session.provenance.pythonRuntime.path, fakePython);
    assert.deepEqual(session.provenance.pythonProbe.versionInfo, [3, 9, 6]);
    assert.equal(isAbsolute(session.provenance.realGit.path), true);
    assert.deepEqual(verifyGitRusageSetup(session), session.startFingerprints);
    writeFileSync(session.shimPath, '\n# changed\n', { flag: 'a' });
    assert.throws(() => verifyGitRusageSetup(session), /binary or shim changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
