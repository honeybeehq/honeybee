import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync, chmodSync, constants, mkdirSync, readFileSync, readdirSync,
  realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_ENV = 'HONEYBEE_GIT_RUSAGE_CONFIG';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const shimBodyPath = join(scriptDir, 'git-rusage-shim.py');
const ADDITIVE_KEYS = Object.freeze([
  'userMicros', 'systemMicros', 'minflt', 'majflt', 'nswap', 'inblock',
  'oublock', 'msgsnd', 'msgrcv', 'nsignals', 'nvcsw', 'nivcsw',
]);
const USAGE_KEYS = Object.freeze(['userMicros', 'systemMicros', 'maxRssBytes', ...ADDITIVE_KEYS.slice(2)]);
const RECORD_KEYS = Object.freeze([
  'additiveDelta', 'argv', 'cpuMicros', 'cwd', 'diagnosticWallNs',
  'launcherPid', 'maxRssAttributable', 'maxRssBytes', 'realGitPid',
  'returncode', 'runId', 'rusageChildrenAfter', 'rusageChildrenBefore',
  'schemaVersion', 'scope', 'sequence', 'startedEpochNs', 'startedMonotonicNs',
  'terminatedBySignal', 'wrapperPid',
]);
const PYTHON_PROBE = [
  'import json, platform, sys',
  'print(json.dumps({',
  '"schemaVersion": 1,',
  '"executable": sys.executable,',
  '"implementation": platform.python_implementation(),',
  '"machine": platform.machine(),',
  '"version": platform.python_version(),',
  '"versionInfo": list(sys.version_info[:3]),',
  '}, separators=(",", ":")))',
].join('\n');

const sha256 = data => createHash('sha256').update(data).digest('hex');
const digestFile = path => sha256(readFileSync(path));
const mode = path => statSync(path).mode & 0o777;

function assertOwnerOnly(path, label, expectedKind) {
  const stats = statSync(path);
  assert.equal(expectedKind === 'directory' ? stats.isDirectory() : stats.isFile(), true,
    `${label} must be a ${expectedKind}`);
  if (typeof process.getuid === 'function') assert.equal(stats.uid, process.getuid(), `${label} must be owned by this user`);
  assert.equal(stats.mode & 0o077, 0, `${label} must be owner-only`);
}

function assertInteger(value, message, { positive = false } = {}) {
  assert.ok(Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0), message);
}

function executableFingerprint(path) {
  accessSync(path, constants.X_OK);
  const stats = statSync(path);
  assert.ok(stats.isFile(), `not an executable file: ${path}`);
  return { path, realpath: realpathSync(path), bytes: stats.size, sha256: digestFile(path) };
}

function probePython(pythonExecutable) {
  const result = spawnSync(pythonExecutable, ['-c', PYTHON_PROBE], {
    encoding: 'utf8', env: process.env, timeout: 10_000,
  });
  assert.equal(result.status, 0, `Git rusage Python unavailable: ${result.error ?? result.stderr}`);
  let probe;
  try { probe = JSON.parse(result.stdout); }
  catch (error) { throw new Error('--git-rusage-python did not return direct Python provenance', { cause: error }); }
  assert.deepEqual(Object.keys(probe).sort(),
    ['executable', 'implementation', 'machine', 'schemaVersion', 'version', 'versionInfo'],
    'unexpected Git rusage Python provenance');
  assert.equal(probe.schemaVersion, 1, 'unsupported Git rusage Python probe');
  assert.ok(typeof probe.executable === 'string' && isAbsolute(probe.executable),
    'Git rusage Python reported a non-absolute sys.executable');
  assert.ok(typeof probe.implementation === 'string' && probe.implementation.length > 0,
    'Git rusage Python implementation is missing');
  assert.ok(typeof probe.machine === 'string' && probe.machine.length > 0,
    'Git rusage Python architecture is missing');
  assert.match(probe.version, /^\d+\.\d+\.\d+/, 'Git rusage Python version is malformed');
  assert.ok(Array.isArray(probe.versionInfo) && probe.versionInfo.length === 3
    && probe.versionInfo.every(Number.isSafeInteger), 'Git rusage Python version tuple is malformed');
  assert.ok(probe.versionInfo[0] === 3 && probe.versionInfo[1] >= 9,
    '--git-rusage requires Python 3.9 or newer');
  return probe;
}

function resolveExecutable(name, pathValue, cwd = process.cwd()) {
  assert.equal(typeof pathValue, 'string', `PATH is required to resolve ${name}`);
  for (const entry of pathValue.split(delimiter)) {
    const base = entry.length === 0 ? cwd : entry;
    const candidate = isAbsolute(base) ? join(base, name) : resolve(cwd, base, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  assert.fail(`cannot resolve ${name} from PATH before diagnostic instrumentation`);
}

export function validateGitRusageMode({ enabled, pythonExecutable, platform = process.platform }) {
  if (!enabled) {
    assert.equal(pythonExecutable, undefined, '--git-rusage-python requires --git-rusage');
    return;
  }
  assert.equal(platform, 'darwin', '--git-rusage is supported only on macOS');
  assert.ok(pythonExecutable, '--git-rusage requires --git-rusage-python /absolute/python');
  assert.ok(isAbsolute(pythonExecutable), '--git-rusage-python must be an absolute path');
  assert.doesNotMatch(pythonExecutable, /[\s\0]/, '--git-rusage-python must be a direct shebang-safe executable path');
}

function snapshotEnvironment(env) {
  return {
    pathPresent: Object.hasOwn(env, 'PATH'),
    path: env.PATH,
    cfPresent: Object.hasOwn(env, '__CF_USER_TEXT_ENCODING'),
    cf: env.__CF_USER_TEXT_ENCODING,
  };
}

function assertEnvironmentSnapshot(actual, expected, message) {
  assert.deepEqual(snapshotEnvironment(actual), expected, message);
}

function withScopedEnvironment(updates, operation) {
  const prior = Object.fromEntries(Object.keys(updates).map(key => [key,
    { present: Object.hasOwn(process.env, key), value: process.env[key] }]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return operation(); }
  finally {
    for (const [key, state] of Object.entries(prior)) {
      if (state.present) process.env[key] = state.value;
      else delete process.env[key];
    }
  }
}

export function setupGitRusage({ runDir, pythonExecutable, platform = process.platform }) {
  validateGitRusageMode({ enabled: true, pythonExecutable, platform });
  assert.equal(process.env[CONFIG_ENV], undefined, `unset inherited ${CONFIG_ENV}`);
  assert.equal(process.env.GIT_TRACE2_EVENT, undefined, 'unset inherited GIT_TRACE2_EVENT');
  assert.ok(isAbsolute(runDir), 'Git rusage runDir must be absolute');

  const environment = snapshotEnvironment(process.env);
  const python = executableFingerprint(pythonExecutable);
  const pythonProbe = probePython(pythonExecutable);
  const pythonRuntimePath = pythonProbe.executable;
  const pythonRuntime = executableFingerprint(pythonRuntimePath);
  const realGitPath = resolveExecutable('git', environment.path);
  const realGit = executableFingerprint(realGitPath);

  const toolDir = join(runDir, 'git-rusage-tool');
  const capturesDir = join(runDir, 'git-rusage-captures');
  mkdirSync(toolDir, { mode: 0o700 });
  mkdirSync(capturesDir, { mode: 0o700 });
  chmodSync(toolDir, 0o700);
  chmodSync(capturesDir, 0o700);
  const shimPath = join(toolDir, 'git');
  const shimSource = `#!${pythonExecutable}\n${readFileSync(shimBodyPath, 'utf8')}`;
  writeFileSync(shimPath, shimSource, { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  chmodSync(shimPath, 0o700);
  const shim = executableFingerprint(shimPath);

  return {
    capturesDir, environment, pythonExecutable, pythonProbe, pythonRuntimePath,
    realGitPath, shimPath, toolDir,
    startFingerprints: { python, pythonRuntime, realGit, shim },
    provenance: {
      platform, pythonVersion: pythonProbe.version,
      python, pythonRuntime, pythonProbe, realGit, shim,
      shimBody: { path: shimBodyPath, bytes: statSync(shimBodyPath).size, sha256: digestFile(shimBodyPath) },
      originalEnvironment: {
        pathPresent: environment.pathPresent,
        pathSha256: sha256(environment.path ?? ''),
        cfUserTextEncodingPresent: environment.cfPresent,
        cfUserTextEncodingSha256: sha256(environment.cf ?? ''),
      },
    },
  };
}

function retainRawRecords(recordsDir, retainedDir) {
  assertOwnerOnly(recordsDir, 'Git rusage recordsDir', 'directory');
  mkdirSync(retainedDir, { mode: 0o700 });
  chmodSync(retainedDir, 0o700);
  assertOwnerOnly(retainedDir, 'retained Git rusage directory', 'directory');
  const entries = readdirSync(recordsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.map(entry => {
    assert.ok(entry.isFile(), `unexpected Git rusage record entry: ${entry.name}`);
    const source = join(recordsDir, entry.name);
    const target = join(retainedDir, entry.name);
    assertOwnerOnly(source, `Git rusage record ${entry.name}`, 'file');
    const bytes = readFileSync(source);
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    chmodSync(target, 0o600);
    assertOwnerOnly(target, `retained Git rusage record ${entry.name}`, 'file');
    return { name: entry.name, bytes: bytes.length, mode: mode(target), sha256: sha256(bytes) };
  });
  return { path: retainedDir, mode: mode(retainedDir), files, manifestSha256: sha256(JSON.stringify(files)) };
}

export function captureGitRusage(session, { id, operation, retainedDir }) {
  assert.match(id, /^[a-zA-Z0-9._-]+$/, 'Git rusage capture id must be path-safe');
  assert.equal(typeof operation, 'function', 'Git rusage operation is required');
  assert.ok(isAbsolute(retainedDir), 'Git rusage retainedDir must be absolute');
  assert.equal(process.env.GIT_TRACE2_EVENT, undefined, 'Trace2 must stay off during Git rusage capture');
  assert.equal(process.env[CONFIG_ENV], undefined, `${CONFIG_ENV} must start absent`);
  assertEnvironmentSnapshot(process.env, session.environment, 'environment changed after Git rusage setup');

  const runId = `${id}-${process.pid}-${randomUUID()}`;
  const recordsDir = join(session.capturesDir, `${id}.records`);
  const configPath = join(session.capturesDir, `${id}.config.json`);
  const sequencePath = join(session.capturesDir, `${id}.sequence`);
  mkdirSync(recordsDir, { mode: 0o700 });
  chmodSync(recordsDir, 0o700);
  writeFileSync(sequencePath, '0\n', { encoding: 'ascii', flag: 'wx', mode: 0o600 });
  chmodSync(sequencePath, 0o600);
  writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    originalCfUserTextEncoding: session.environment.cfPresent ? session.environment.cf : null,
    originalPath: session.environment.pathPresent ? session.environment.path : null,
    realGit: session.realGitPath,
    recordsDir,
    runId,
    sequencePath,
  }) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(configPath, 0o600);

  let value;
  let error = null;
  let failed = false;
  try {
    value = withScopedEnvironment({
      [CONFIG_ENV]: configPath,
      PATH: session.environment.pathPresent
        ? `${session.toolDir}${delimiter}${session.environment.path}`
        : session.toolDir,
    }, operation);
  } catch (caught) {
    failed = true;
    error = caught;
  }
  assert.equal(process.env[CONFIG_ENV], undefined, `${CONFIG_ENV} leaked after capture`);
  assert.equal(process.env.GIT_TRACE2_EVENT, undefined, 'Trace2 appeared during Git rusage capture');
  assertEnvironmentSnapshot(process.env, session.environment, 'Git rusage capture did not restore environment');
  const rawArtifact = retainRawRecords(recordsDir, retainedDir);
  return { error, failed, rawArtifact, recordsDir, runId, value };
}

function validateUsageSnapshot(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...USAGE_KEYS].sort(), `${label} has unexpected fields`);
  for (const key of USAGE_KEYS) assertInteger(value[key], `${label}.${key} must be a non-negative integer`);
}

function validateRecord(record, runId, name) {
  assert.ok(record && typeof record === 'object' && !Array.isArray(record), `invalid record: ${name}`);
  assert.deepEqual(Object.keys(record).sort(), [...RECORD_KEYS].sort(), `unexpected record shape: ${name}`);
  assert.equal(record.schemaVersion, 1, `unsupported record schema: ${name}`);
  assert.equal(record.runId, runId, `foreign record: ${name}`);
  assert.ok(Array.isArray(record.argv) && record.argv.length > 0
    && record.argv.every(value => typeof value === 'string'), `invalid argv in record: ${name}`);
  assert.equal(record.argv[0], 'git', `invalid argv[0] in record: ${name}`);
  assert.ok(typeof record.cwd === 'string' && isAbsolute(record.cwd), `invalid cwd in record: ${name}`);
  assert.match(record.startedEpochNs, /^\d+$/, `invalid epoch timestamp in record: ${name}`);
  assert.match(record.startedMonotonicNs, /^\d+$/, `invalid monotonic timestamp in record: ${name}`);
  assertInteger(record.sequence, `invalid sequence in record: ${name}`);
  for (const key of ['wrapperPid', 'launcherPid', 'realGitPid']) {
    assertInteger(record[key], `invalid ${key} in record: ${name}`, { positive: true });
  }
  assertInteger(record.diagnosticWallNs, `invalid wall duration in record: ${name}`);
  assert.ok(Number.isSafeInteger(record.returncode), `invalid returncode in record: ${name}`);
  assert.ok(record.terminatedBySignal === null || Number.isSafeInteger(record.terminatedBySignal),
    `invalid signal in record: ${name}`);
  if (record.returncode < 0) assert.equal(record.terminatedBySignal, -record.returncode, `signal mismatch: ${name}`);
  else assert.equal(record.terminatedBySignal, null, `unexpected signal: ${name}`);
  assert.equal(typeof record.maxRssAttributable, 'boolean', `invalid RSS attribution in record: ${name}`);
  assertInteger(record.maxRssBytes, `invalid max RSS in record: ${name}`);
  assertInteger(record.cpuMicros, `invalid CPU total in record: ${name}`);
  assert.equal(typeof record.scope, 'string', `invalid scope in record: ${name}`);
  validateUsageSnapshot(record.rusageChildrenBefore, `${name}.rusageChildrenBefore`);
  validateUsageSnapshot(record.rusageChildrenAfter, `${name}.rusageChildrenAfter`);
  assert.ok(record.additiveDelta && typeof record.additiveDelta === 'object'
    && !Array.isArray(record.additiveDelta), `invalid additive delta: ${name}`);
  assert.deepEqual(Object.keys(record.additiveDelta).sort(), [...ADDITIVE_KEYS].sort(),
    `unexpected additive fields: ${name}`);
  for (const key of ADDITIVE_KEYS) assertInteger(record.additiveDelta[key], `invalid additive ${key}: ${name}`);
  for (const key of ADDITIVE_KEYS) {
    assert.equal(record.rusageChildrenAfter[key] - record.rusageChildrenBefore[key], record.additiveDelta[key],
      `additive counter mismatch for ${key}: ${name}`);
  }
  assert.equal(record.cpuMicros, record.additiveDelta.userMicros + record.additiveDelta.systemMicros,
    `CPU total mismatch: ${name}`);
  assert.equal(record.maxRssBytes, record.rusageChildrenAfter.maxRssBytes, `RSS total mismatch: ${name}`);
  assert.equal(record.maxRssAttributable, record.rusageChildrenBefore.maxRssBytes === 0,
    `RSS attribution mismatch: ${name}`);
}

export function readGitRusageRecords(recordsDir, runId) {
  assertOwnerOnly(recordsDir, 'Git rusage recordsDir', 'directory');
  const entries = readdirSync(recordsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const invalid = entries.filter(entry => !entry.isFile() || !entry.name.endsWith('.json')).map(entry => entry.name);
  assert.deepEqual(invalid, [], `incomplete or foreign record files: ${JSON.stringify(invalid)}`);
  const records = entries.map(entry => {
    const path = join(recordsDir, entry.name);
    assertOwnerOnly(path, `Git rusage record ${entry.name}`, 'file');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    validateRecord(record, runId, entry.name);
    return { name: entry.name, record };
  });
  assert.ok(records.length > 0, 'no complete Git rusage records');
  assert.deepEqual(records.map(value => value.record.sequence).sort((a, b) => a - b),
    records.map((_, index) => index), 'missing or duplicate Git rusage sequence');
  records.sort((a, b) => a.record.sequence - b.record.sequence);
  return records.map(value => value.record);
}

function traceChildIdentity(event) {
  assert.ok(typeof event.sid === 'string' && Number.isSafeInteger(event.child_id),
    'malformed Trace2 child identity');
  return `${event.sid}\0${event.child_id}`;
}

export function summarizeGitRusageTrace(events) {
  assert.ok(Array.isArray(events) && events.every(event => event && typeof event === 'object'
    && typeof event.event === 'string'), 'malformed Git trace event');
  const starts = events.filter(event => event.event === 'start');
  for (const event of starts) {
    assert.ok(typeof event.sid === 'string', 'malformed Trace2 start identity');
    assert.ok(Array.isArray(event.argv) && event.argv.length > 0
      && event.argv.every(value => typeof value === 'string'), 'malformed Trace2 start argv');
  }
  const roots = starts.filter(event => typeof event.sid === 'string' && !event.sid.includes('/'));
  assert.ok(roots.length > 0, 'Trace2 has no root Git commands');
  assert.equal(new Set(roots.map(event => event.sid)).size, roots.length, 'duplicate Trace2 root start identity');

  const exitsBySid = new Map();
  for (const event of events.filter(value => value.event === 'exit')) {
    assert.ok(typeof event.sid === 'string', 'invalid Trace2 exit identity');
    assert.ok(Number.isSafeInteger(event.code), 'Trace2 exit lacks an integer code');
    const existing = exitsBySid.get(event.sid) ?? [];
    existing.push(event);
    exitsBySid.set(event.sid, existing);
  }
  const rootOutcomes = roots.map(root => {
    assert.ok(Array.isArray(root.argv) && root.argv.length > 0
      && root.argv.every(value => typeof value === 'string'), 'malformed Trace2 root argv');
    const exits = exitsBySid.get(root.sid) ?? [];
    assert.ok(exits.length > 0, `Trace2 root lacks matching exit: ${root.sid}`);
    const codes = new Set(exits.map(event => event.code));
    assert.equal(codes.size, 1, `Trace2 root has conflicting exit codes: ${root.sid}`);
    return { sid: root.sid, argv: root.argv, returncode: exits.at(-1).code, exitEvents: exits.length };
  });

  const childStarts = events.filter(event => event.event === 'child_start');
  const childExits = events.filter(event => event.event === 'child_exit');
  const startsByIdentity = new Map();
  for (const event of childStarts) {
    const identity = traceChildIdentity(event);
    assert.ok(!startsByIdentity.has(identity), `duplicate Trace2 child_start identity: ${identity}`);
    assert.ok(Array.isArray(event.argv) && event.argv.length > 0
      && event.argv.every(value => typeof value === 'string'), `malformed Trace2 child argv: ${identity}`);
    startsByIdentity.set(identity, event);
  }
  const exitsByIdentity = new Map();
  for (const event of childExits) {
    const identity = traceChildIdentity(event);
    assert.ok(!exitsByIdentity.has(identity), `duplicate Trace2 child_exit identity: ${identity}`);
    assert.ok(Number.isSafeInteger(event.code), `Trace2 child_exit lacks an integer code: ${identity}`);
    assert.ok(event.pid === undefined || (Number.isSafeInteger(event.pid) && event.pid > 0),
      `Trace2 child_exit has an invalid pid: ${identity}`);
    exitsByIdentity.set(identity, event);
  }
  const startIdentities = [...startsByIdentity.keys()].sort();
  const exitIdentities = [...exitsByIdentity.keys()].sort();
  assert.deepEqual(exitIdentities, startIdentities, 'Trace2 child identity mismatch');
  const childProcesses = [...startsByIdentity].map(([identity, start]) => {
    const end = exitsByIdentity.get(identity);
    return { sid: start.sid, childId: start.child_id, argv: start.argv,
      returncode: end.code, pid: end.pid ?? null };
  });
  return {
    rootGitCommands: roots.length,
    rootArgv: roots.map(event => event.argv),
    rootOutcomes,
    gitProcessStarts: starts.length,
    childStartEvents: childStarts.length,
    childExitEvents: childExits.length,
    childProcesses,
    observedLaunches: roots.length + childStarts.length,
    completeRootOutcomes: true,
    completeChildEvents: true,
    childEventIdentityMatched: true,
    scope: 'Git Trace2 launch events, not a kernel-exhaustive OS process census',
  };
}

export function normalizeGitRusageArg(value) {
  return value.replace(/\/hive-capture-[^/]+\/repo(?=\/|$)/g, '/hive-capture-<owned>/repo');
}

export function aggregateGitRusageRecords(records, trace, { expectedCount, expectedLauncherPid }) {
  assertInteger(expectedCount, 'expected Git rusage record count must be positive', { positive: true });
  assertInteger(expectedLauncherPid, 'expected Git rusage launcher PID must be positive', { positive: true });
  assert.equal(records.length, expectedCount, `expected ${expectedCount} direct Git records, got ${records.length}`);
  assert.deepEqual([...new Set(records.map(record => record.launcherPid))], [expectedLauncherPid],
    'unexpected Git rusage launcher PIDs');
  assert.ok(records.every(record => record.maxRssAttributable),
    'fresh shim invariant failed; max RSS is not attributable');
  assert.equal(trace.rootGitCommands, records.length, 'Trace2 root count does not match complete shim records');

  const traceArgs = trace.rootArgv.map(argv => argv.slice(1).map(normalizeGitRusageArg));
  const recordArgs = records.map(record => record.argv.slice(1).map(normalizeGitRusageArg));
  assert.deepEqual(recordArgs, traceArgs, 'separate Trace2 root argv does not match shim diagnostic argv');
  assert.deepEqual(records.map(record => record.returncode), trace.rootOutcomes.map(outcome => outcome.returncode),
    'separate Trace2 root outcomes do not match shim diagnostic outcomes');
  assert.equal(trace.completeChildEvents, true, 'incomplete Trace2 child events');
  assert.equal(trace.childEventIdentityMatched, true, 'unmatched Trace2 child identity');

  const additiveCounters = Object.fromEntries(ADDITIVE_KEYS.map(key =>
    [key, records.reduce((total, record) => total + record.additiveDelta[key], 0)]));
  return {
    schemaVersion: 1,
    completed: true,
    directGitCommands: records.length,
    diagnosticWrapperProcesses: records.length,
    realGitAndWaitedDescendantCpuMicros: additiveCounters.userMicros + additiveCounters.systemMicros,
    realGitAndWaitedDescendantUserMicros: additiveCounters.userMicros,
    realGitAndWaitedDescendantSystemMicros: additiveCounters.systemMicros,
    maxSingleProcessRssBytesAcrossWaitedGitTrees: Math.max(...records.map(record => record.maxRssBytes)),
    additiveCounters,
    trace2: trace,
    argvComparison: {
      matched: true,
      normalization: 'only the captureWork-owned /hive-capture-*/repo path component',
    },
    raw: records,
    scope: {
      cpu: 'sum of non-overlapping direct Git command trees; each includes only terminated descendants waited into macOS rusage',
      rss: 'maximum propagated per-process RSS, not summed RSS and not concurrent whole-tree peak',
      processCount: 'directGitCommands is exact and excludes the same number of diagnostic wrappers; matched separate Trace2 child identities/counts are Git-observed rather than kernel-exhaustive',
    },
  };
}

export function aggregateGitRusage({ recordsDir, runId, expectedCount, expectedLauncherPid, tracePath }) {
  assert.equal(process.env.GIT_TRACE2_EVENT, undefined, 'Trace2 leaked into Git rusage aggregation');
  assert.equal(process.env[CONFIG_ENV], undefined, `${CONFIG_ENV} leaked into Git rusage aggregation`);
  const events = readFileSync(tracePath, 'utf8').split('\n').filter(line => line.trim()).map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { throw new Error(`malformed Trace2 JSON on line ${index + 1}`, { cause: error }); }
  });
  return aggregateGitRusageRecords(
    readGitRusageRecords(recordsDir, runId),
    summarizeGitRusageTrace(events),
    { expectedCount, expectedLauncherPid },
  );
}

export function verifyGitRusageSetup(session) {
  assert.deepEqual(probePython(session.pythonExecutable), session.pythonProbe,
    'Git rusage Python resolution changed during capture');
  const end = {
    python: executableFingerprint(session.pythonExecutable),
    pythonRuntime: executableFingerprint(session.pythonRuntimePath),
    realGit: executableFingerprint(session.realGitPath),
    shim: executableFingerprint(session.shimPath),
  };
  assert.deepEqual(end, session.startFingerprints, 'Git rusage binary or shim changed during capture');
  assertEnvironmentSnapshot(process.env, session.environment, 'environment changed during Git rusage ruler');
  return end;
}
