#!/usr/bin/env node
// Disposable paired ruler for the C25 per-bee audit-tail index tradeoff.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  arch,
  cpus,
  hostname,
  loadavg,
  platform,
  release,
  tmpdir,
  totalmem,
  version as osVersion,
} from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const INDEX_NAME = 'audit_by_bee';
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON audit(bee_id) WHERE bee_id IS NOT NULL;`;
const INDEX_SCHEMA_SQL = `CREATE INDEX ${INDEX_NAME} ON audit(bee_id) WHERE bee_id IS NOT NULL`;
const DELETED_INDEX_NAME = 'audit_bee_deleted_bee_seq';
const TARGET_BEE_ID = '25000000-0000-4000-8000-000000000001';
const MISSING_BEE_ID = '25000000-0000-4000-8000-000000000002';
const MUTATION_BEE_ID = '25000000-0000-4000-8000-000000000003';
const FIXED_NOW = 1_800_000_000_000;
const TAIL_LIMIT = 100;
const READ_ROUNDS = 15;
const READ_WARMUP_ROUNDS = 3;
const WRITE_SAMPLE_BATCHES = 10;
const WRITE_WARMUP_ROUNDS = 1;
const ABBA = Object.freeze([0, 1, 1, 0]);
const SCENARIOS = Object.freeze(['sparse20-target', 'no-target', 'dense-target', 'null50']);
const SCALE = Object.freeze({
  smoke: Object.freeze({ auditRows: 1_000, renameBatchSize: 5 }),
  canonical: Object.freeze({ auditRows: 1_000_000, renameBatchSize: 100 }),
});

function parseArgs(argv) {
  const options = {
    repo: process.cwd(),
    mode: 'ab',
    scale: 'canonical',
    out: null,
    help: false,
  };
  const value = (name, index) => {
    const next = argv[index + 1];
    assert.ok(next && !next.startsWith('--'), `${name} requires a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') options.repo = value(arg, index++);
    else if (arg === '--mode') options.mode = value(arg, index++).toLowerCase();
    else if (arg === '--scale') options.scale = value(arg, index++).toLowerCase();
    else if (arg === '--smoke') options.scale = 'smoke';
    else if (arg === '--out') options.out = value(arg, index++);
    else if (arg === '--help') options.help = true;
    else assert.fail(`unknown option: ${arg}`);
  }
  assert.ok(options.mode === 'ab' || options.mode === 'aa', '--mode must be ab or aa');
  assert.ok(Object.hasOwn(SCALE, options.scale), '--scale must be smoke or canonical');
  options.repo = resolve(options.repo);
  options.out = resolve(options.out ?? `/tmp/honeybee-perf-c25-${options.scale}-${options.mode}.json`);
  return options;
}

function helpText() {
  return [
    'node /tmp/honeybee-perf-c25-ruler.mjs [options]',
    '',
    'Options:',
    '  --repo PATH        checkout whose real CoreStore module is measured (default: cwd)',
    '  --mode ab|aa       no-index/index treatment or two no-index controls (default: ab)',
    '  --scale NAME       canonical (1M rows) or smoke (1000 rows)',
    '  --smoke            alias for --scale smoke',
    '  --out PATH         atomic JSON report path',
    '  --help',
    '',
    'Protocol: four fixed fixtures; symmetric warmup; reads ABBA x15; writes use',
    '10 measured public rename batches per side. Candidate installation is an',
    'offline CREATE INDEX exec measurement, not daemon or CoreStore startup.',
  ].join('\n');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fileSha256(path) {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function valueDigest(value) {
  return sha256(stableJson(value));
}

function distribution(values) {
  assert.ok(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(fraction * sorted.length) - 1];
  return {
    n: values.length,
    min: sorted[0],
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted.at(-1),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function summarize(samples) {
  return {
    wall: { unit: 'ms', ...distribution(samples.map(sample => sample.wallMs)) },
    cpu: { unit: 'ms', ...distribution(samples.map(sample => sample.cpuMs)) },
  };
}

function measureValue(operation) {
  const cpu = process.cpuUsage();
  const started = performance.now();
  const value = operation();
  const wallMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  return { value, wallMs, cpuMs: (used.user + used.system) / 1_000 };
}

function git(repo, ...args) {
  const run = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return run.stdout;
}

function sourceFingerprint(repo) {
  const files = git(repo, 'ls-files', 'v2/core/src', 'v2/core/package.json', 'package.json', 'package-lock.json')
    .trim().split('\n').filter(Boolean).sort();
  assert.ok(files.length > 0, 'CoreStore source set is empty');
  const hashes = Object.fromEntries(files.map(file => [file, fileSha256(join(repo, file))]));
  return {
    repo,
    realRepo: realpathSync(repo),
    revision: git(repo, 'rev-parse', 'HEAD').trim(),
    status: git(repo, 'status', '--porcelain'),
    diffSha256: sha256(git(repo, 'diff', '--binary', 'HEAD')),
    files: hashes,
    aggregateSha256: valueDigest(hashes),
  };
}

function bootIdentity() {
  let value;
  let method;
  if (process.platform === 'darwin') {
    const run = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (run.status !== 0) return null;
    value = run.stdout.trim();
    method = 'darwin-kern.bootsessionuuid-sha256';
  } else if (process.platform === 'linux') {
    try {
      value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      return null;
    }
    method = 'linux-boot-id-sha256';
  } else {
    return null;
  }
  if (!/^[a-f0-9-]{36}$/i.test(value)) return null;
  return { method, sha256: sha256(value.toLowerCase()) };
}

function environmentEvidence() {
  const sqlite = new DatabaseSync(':memory:');
  let sqliteVersion;
  let dbstatEnabled;
  try {
    sqliteVersion = String(sqlite.prepare('SELECT sqlite_version() AS value').get().value);
    dbstatEnabled = sqlite.prepare('PRAGMA compile_options').all()
      .some(row => String(Object.values(row)[0]).includes('ENABLE_DBSTAT_VTAB'));
  } finally {
    sqlite.close();
  }
  const identity = {
    node: process.version,
    nodeExecutable: process.execPath,
    nodeExecutableSha256: fileSha256(process.execPath),
    execArgv: process.execArgv,
    sqlite: sqliteVersion,
    sqliteDbstatEnabled: dbstatEnabled,
    platform: platform(),
    release: release(),
    osVersion: osVersion(),
    arch: arch(),
    hostname: hostname(),
    bootIdentity: bootIdentity(),
    cpu: cpus()[0]?.model ?? null,
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    nodeCompileCache: process.env.NODE_COMPILE_CACHE ?? null,
    nodeOptionsSha256: sha256(process.env.NODE_OPTIONS ?? ''),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  return { ...identity, identitySha256: valueDigest(identity), loadBefore: loadavg(), loadAfter: null };
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.tmp-${process.pid}`;
  writeFileSync(pending, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(pending, path);
}

function failureEvidence(error, phase) {
  return {
    phase,
    name: error instanceof Error ? error.name : 'NonErrorThrown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
    at: new Date().toISOString(),
  };
}

function assertCheckpointed(path) {
  const wal = `${path}-wal`;
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, `non-empty WAL remains: ${wal}`);
}

function copyFixture(source, destination) {
  assertCheckpointed(source);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const sourceHash = fileSha256(source);
  const copyHash = fileSha256(destination);
  assert.equal(copyHash, sourceHash, 'copied fixture is not byte-identical');
  return copyHash;
}

function uuidForUnrelated(index) {
  const tail = (index % 4_096).toString(16).padStart(12, '0');
  return `26000000-0000-4000-8000-${tail}`;
}

function spreadOrdinals(count, rowCount, multiplier = 1) {
  const available = Math.floor(rowCount / multiplier);
  const ordinals = [];
  for (let position = 1; position <= count; position += 1) {
    ordinals.push(multiplier * Math.floor((position * (available + 1)) / (count + 1)));
  }
  assert.equal(new Set(ordinals).size, count, 'target positions must be distinct');
  assert.ok(ordinals.every(value => value >= 1 && value <= rowCount));
  return ordinals;
}

function fixtureSpec(name, rowCount) {
  let targetOrdinals;
  if (name === 'sparse20-target') targetOrdinals = spreadOrdinals(20, rowCount);
  else if (name === 'null50') targetOrdinals = spreadOrdinals(20, rowCount, 2);
  else targetOrdinals = [];
  const targetSet = new Set(targetOrdinals);
  let deletionOrdinal = Math.max(2, Math.floor(rowCount / 3));
  if (name === 'null50' && deletionOrdinal % 2 !== 0) deletionOrdinal += 1;
  while (targetSet.has(deletionOrdinal)) deletionOrdinal += name === 'null50' ? 2 : 1;
  assert.ok(deletionOrdinal <= rowCount);
  const spec = { name, rowCount, targetOrdinals, targetSet, deletionOrdinal };
  const deletionBeeId = beeIdForOrdinal(spec, deletionOrdinal);
  assert.ok(deletionBeeId !== null, 'deletion lookup fixture must be bee-scoped');
  return { ...spec, deletionBeeId };
}

function beeIdForOrdinal(spec, ordinal) {
  if (spec.name === 'dense-target') return TARGET_BEE_ID;
  if (spec.targetSet.has(ordinal)) return TARGET_BEE_ID;
  if (spec.name === 'null50' && ordinal % 2 !== 0) return null;
  return uuidForUnrelated(ordinal);
}

function logicalFixtureRow(spec, ordinal) {
  return {
    seq: ordinal,
    ts: FIXED_NOW + ordinal,
    kind: ordinal === spec.deletionOrdinal ? 'bee.deleted' : 'fixture.event',
    beeId: beeIdForOrdinal(spec, ordinal),
    payload: { fixture: spec.name, ordinal, token: `p${ordinal % 17}` },
  };
}

function expectedTail(spec, beeId) {
  let ordinals;
  if (beeId === undefined) {
    const first = Math.max(1, spec.rowCount - TAIL_LIMIT + 1);
    ordinals = Array.from({ length: spec.rowCount - first + 1 }, (_, index) => first + index);
  } else if (spec.name === 'dense-target' && beeId === TARGET_BEE_ID) {
    const first = Math.max(1, spec.rowCount - TAIL_LIMIT + 1);
    ordinals = Array.from({ length: spec.rowCount - first + 1 }, (_, index) => first + index);
  } else if (beeId === TARGET_BEE_ID) {
    ordinals = spec.targetOrdinals.slice(-TAIL_LIMIT);
  } else {
    ordinals = [];
  }
  return ordinals.map(ordinal => logicalFixtureRow(spec, ordinal));
}

function createTemplate(module, runDir) {
  const path = join(runDir, 'template.sqlite3');
  const store = module.openCoreStore(path, {
    now: () => FIXED_NOW,
    random: () => 0.25,
  });
  assert.ok(store instanceof module.CoreStore);
  try {
    store.createBee({
      id: MUTATION_BEE_ID,
      name: 'c25-write-seed',
      agent: 'stub',
      substrate: 'hsr',
      cwd: '/tmp',
      handle: 'ST.c025',
    });
  } finally {
    store.close();
  }
  const db = new DatabaseSync(path);
  try {
    assert.equal(db.prepare("SELECT 1 AS value FROM sqlite_schema WHERE type='index' AND name=?")
      .get(INDEX_NAME), undefined, 'production source already contains candidate index');
    assert.ok(db.prepare("SELECT 1 AS value FROM sqlite_schema WHERE type='index' AND name=?")
      .get(DELETED_INDEX_NAME), 'existing deleted-kind index is missing');
    db.exec('PRAGMA synchronous = OFF');
    db.exec('BEGIN IMMEDIATE');
    db.exec("DELETE FROM audit; DELETE FROM sqlite_sequence WHERE name = 'audit';");
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM audit').get().count), 0);
  } finally {
    db.close();
  }
  assertCheckpointed(path);
  return path;
}

function seedFixture(templatePath, destination, spec) {
  copyFixture(templatePath, destination);
  const db = new DatabaseSync(destination);
  let committed = false;
  try {
    db.exec('PRAGMA synchronous = OFF');
    const insert = db.prepare('INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, ?, ?, ?)');
    db.exec('BEGIN IMMEDIATE');
    for (let ordinal = 1; ordinal <= spec.rowCount; ordinal += 1) {
      const row = logicalFixtureRow(spec, ordinal);
      insert.run(row.ts, row.kind, row.beeId, JSON.stringify(row.payload));
    }
    db.exec('COMMIT');
    committed = true;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const counts = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(bee_id IS NULL) AS null_rows,
              SUM(bee_id = ?) AS target_rows,
              MIN(seq) AS min_seq,
              MAX(seq) AS max_seq
       FROM audit`,
    ).get(TARGET_BEE_ID);
    assert.equal(Number(counts.total), spec.rowCount);
    assert.equal(Number(counts.min_seq), 1);
    assert.equal(Number(counts.max_seq), spec.rowCount);
    const expectedNull = spec.name === 'null50' ? spec.rowCount / 2 : 0;
    const expectedTarget = spec.name === 'dense-target' ? spec.rowCount : spec.targetOrdinals.length;
    assert.equal(Number(counts.null_rows), expectedNull);
    assert.equal(Number(counts.target_rows), expectedTarget);
    const deletion = db.prepare(
      "SELECT seq, ts FROM audit WHERE kind='bee.deleted' AND bee_id=? AND seq<=? ORDER BY seq DESC LIMIT 1",
    ).get(spec.deletionBeeId, spec.rowCount);
    assert.deepEqual(
      { seq: Number(deletion.seq), ts: Number(deletion.ts) },
      { seq: spec.deletionOrdinal, ts: FIXED_NOW + spec.deletionOrdinal },
    );
  } catch (error) {
    if (!committed) {
      try { db.exec('ROLLBACK'); } catch { /* best effort */ }
    }
    throw error;
  } finally {
    db.close();
  }
  assertCheckpointed(destination);
  return fileSha256(destination);
}

function installCandidate(path, scenario) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    assert.equal(db.prepare("SELECT 1 AS value FROM sqlite_schema WHERE type='index' AND name=?")
      .get(INDEX_NAME), undefined);
    const timing = measureValue(() => db.exec(INDEX_SQL));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.ok(db.prepare("SELECT 1 AS value FROM sqlite_schema WHERE type='index' AND name=?")
      .get(INDEX_NAME));
    return {
      scenario,
      operation: 'DatabaseSync.exec(CREATE INDEX)',
      timingBoundary: 'candidate CREATE INDEX exec only; database open, pragmas, checkpoint, inspection, and close excluded',
      journalMode: 'wal',
      synchronous: 'normal',
      wallMs: timing.wallMs,
      cpuMs: timing.cpuMs,
    };
  } finally {
    db.close();
  }
}

function planRows(db, sql, ...bindings) {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings).map(row => ({
    id: Number(row.id),
    parent: Number(row.parent),
    detail: String(row.detail),
  }));
}

function inspectClosed(path, spec) {
  assertCheckpointed(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
    const freelistCount = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
    const indexes = db.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name='audit' ORDER BY name",
    ).all().map(row => ({ name: String(row.name), sql: row.sql == null ? null : String(row.sql) }));
    const dbstat = db.prepare(
      'SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name',
    ).all().map(row => ({ name: String(row.name), pages: Number(row.pages), bytes: Number(row.bytes) }));
    const candidate = indexes.find(index => index.name === INDEX_NAME);
    const candidateInfo = candidate
      ? db.prepare(`SELECT seqno, cid, name FROM pragma_index_info('${INDEX_NAME}') ORDER BY seqno`)
          .all().map(row => ({ seqno: Number(row.seqno), cid: Number(row.cid), name: String(row.name) }))
      : [];
    const deletionSql =
      "SELECT seq, ts FROM audit WHERE kind='bee.deleted' AND bee_id=? AND seq<=? ORDER BY seq DESC LIMIT 1";
    const deletion = db.prepare(deletionSql).get(spec.deletionBeeId, spec.rowCount);
    return {
      quickCheck: String(db.prepare('PRAGMA quick_check').get().quick_check),
      journalMode: String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(),
      schemaVersion: String(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value),
      rowCount: Number(db.prepare('SELECT COUNT(*) AS count FROM audit').get().count),
      sqliteFileBytes: statSync(path).size,
      pageSize,
      pageCount,
      freelistCount,
      allocatedBytes: pageSize * pageCount,
      livePageBytes: pageSize * (pageCount - freelistCount),
      indexes,
      dbstat,
      candidate: {
        present: candidate !== undefined,
        sql: candidate?.sql ?? null,
        columns: candidateInfo,
        pages: dbstat.find(row => row.name === INDEX_NAME)?.pages ?? 0,
        bytes: dbstat.find(row => row.name === INDEX_NAME)?.bytes ?? 0,
      },
      plans: {
        perBeeTail: planRows(
          db,
          'SELECT * FROM audit WHERE seq > ? AND bee_id = ? ORDER BY seq DESC LIMIT ?',
          0,
          TARGET_BEE_ID,
          TAIL_LIMIT,
        ),
        globalTail: planRows(
          db,
          'SELECT * FROM audit WHERE seq > ? ORDER BY seq DESC LIMIT ?',
          0,
          TAIL_LIMIT,
        ),
        naturalDeletionLookup: planRows(db, deletionSql, spec.deletionBeeId, spec.rowCount),
      },
      deletionLookupResult: deletion
        ? { seq: Number(deletion.seq), ts: Number(deletion.ts) }
        : null,
    };
  } finally {
    db.close();
  }
}

function assertInspection(stats, expectedIndex, spec) {
  assert.equal(stats.quickCheck, 'ok');
  assert.equal(stats.journalMode, 'wal');
  assert.equal(stats.rowCount, spec.rowCount);
  assert.equal(stats.candidate.present, expectedIndex);
  assert.deepEqual(stats.candidate.columns, expectedIndex ? [{ seqno: 0, cid: 3, name: 'bee_id' }] : []);
  assert.equal(stats.candidate.sql, expectedIndex ? INDEX_SCHEMA_SQL : null);
  assert.equal(stats.candidate.bytes > 0, expectedIndex);
  assert.deepEqual(stats.deletionLookupResult, {
    seq: spec.deletionOrdinal,
    ts: FIXED_NOW + spec.deletionOrdinal,
  });
  if (expectedIndex) {
    assert.ok(stats.plans.perBeeTail.some(row => row.detail.includes(`USING INDEX ${INDEX_NAME}`)));
    assert.ok(!stats.plans.perBeeTail.some(row => row.detail.includes('USE TEMP B-TREE')));
  } else {
    assert.ok(!stats.plans.perBeeTail.some(row => row.detail.includes(INDEX_NAME)));
  }
  assert.ok(stats.plans.globalTail.every(row => !row.detail.includes(INDEX_NAME)));
}

function runInterleave(rounds, callback) {
  for (let round = 0; round < rounds; round += 1) {
    for (let leg = 0; leg < ABBA.length; leg += 1) callback(ABBA[leg], round, leg);
  }
}

function runReadCase(stores, spec, operation, expected) {
  const samples = [[], []];
  const warmupOrder = [];
  const expectedSha256 = valueDigest(expected);
  const invoke = side => operation === 'perBeeTail'
    ? stores[side].auditTail(0, TAIL_LIMIT, TARGET_BEE_ID)
    : stores[side].auditTail(0, TAIL_LIMIT);
  const call = (side, phase, round, leg) => {
    if (phase === 'warmup') {
      const value = invoke(side);
      assert.deepEqual(value, expected);
      warmupOrder.push({ phase, round, leg, side });
      return;
    }
    const measured = measureValue(() => invoke(side));
    assert.deepEqual(measured.value, expected);
    const actualSha256 = valueDigest(measured.value);
    assert.equal(actualSha256, expectedSha256);
    samples[side].push({
      round,
      leg,
      side,
      wallMs: measured.wallMs,
      cpuMs: measured.cpuMs,
      rows: measured.value.length,
      resultSha256: actualSha256,
    });
  };
  runInterleave(READ_WARMUP_ROUNDS, (side, round, leg) => call(side, 'warmup', round, leg));
  runInterleave(READ_ROUNDS, (side, round, leg) => call(side, 'sample', round, leg));
  assert.equal(samples[0].length, READ_ROUNDS * 2);
  assert.equal(samples[1].length, READ_ROUNDS * 2);
  return {
    scenario: spec.name,
    operation: operation === 'perBeeTail'
      ? 'CoreStore.auditTail(0, 100, targetBeeId)'
      : 'CoreStore.auditTail(0, 100)',
    timingBoundary: 'auditTail call only; exact full-result assertions and result hashing excluded',
    fixture: {
      auditRows: spec.rowCount,
      targetRows: spec.name === 'dense-target' ? spec.rowCount : spec.targetOrdinals.length,
      targetBeeId: operation === 'perBeeTail' ? TARGET_BEE_ID : null,
    },
    warmupOrder,
    expected: {
      rowCount: expected.length,
      firstSeq: expected[0]?.seq ?? null,
      lastSeq: expected.at(-1)?.seq ?? null,
      orderedFullRowsSha256: expectedSha256,
    },
    sides: samples.map(raw => ({ raw, metrics: summarize(raw) })),
    correctness: {
      exactFullRowsEveryCall: true,
      strictAscendingSeq: expected.every((row, index) => index === 0 || expected[index - 1].seq < row.seq),
      samplesPerSide: READ_ROUNDS * 2,
    },
  };
}

function openWithExecEvidence(module, path) {
  const originalExec = DatabaseSync.prototype.exec;
  const calls = [];
  DatabaseSync.prototype.exec = function tracedExec(sql) {
    calls.push(String(sql));
    return Reflect.apply(originalExec, this, [sql]);
  };
  let store;
  try {
    store = module.openCoreStore(path, { now: () => FIXED_NOW, random: () => 0.25 });
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }
  assert.ok(store instanceof module.CoreStore);
  const evidence = {
    busyTimeoutZero: calls.includes('PRAGMA busy_timeout = 0'),
    lockingExclusive: calls.includes('PRAGMA locking_mode = EXCLUSIVE'),
    journalWal: calls.includes('PRAGMA journal_mode = WAL'),
    synchronousNormal: calls.includes('PRAGMA synchronous = NORMAL'),
    candidateIndexExecutedByCoreStore: calls.some(sql => sql.includes(INDEX_SQL)),
  };
  assert.equal(evidence.busyTimeoutZero, true);
  assert.equal(evidence.lockingExclusive, true);
  assert.equal(evidence.journalWal, true);
  assert.equal(evidence.synchronousNormal, true);
  assert.equal(evidence.candidateIndexExecutedByCoreStore, false);
  return { store, evidence };
}

function runWriteCase(stores, paths, spec, batchSize) {
  const samples = [[], []];
  const warmupOrder = [];
  const nextOrdinal = [0, 0];
  const walBytes = path => existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0;
  const call = (side, phase, round, leg) => {
    const firstOrdinal = nextOrdinal[side];
    const names = Array.from({ length: batchSize }, (_, offset) =>
      `c25-rename-${String(firstOrdinal + offset).padStart(7, '0')}`);
    let applied = 0;
    let lastName = null;
    const execute = () => {
      for (const name of names) {
        const result = stores[side].renameBee(MUTATION_BEE_ID, name);
        if (result.applied) applied += 1;
        lastName = result.bee.name;
      }
    };
    if (phase === 'warmup') {
      execute();
      warmupOrder.push({ phase, round, leg, side, firstOrdinal, calls: batchSize });
    } else {
      const measured = measureValue(execute);
      samples[side].push({
        round,
        leg,
        side,
        firstOrdinal,
        calls: batchSize,
        wallMs: measured.wallMs,
        cpuMs: measured.cpuMs,
        walBytesAfter: walBytes(paths[side]),
      });
    }
    assert.equal(applied, batchSize, 'every public rename in a batch must apply');
    assert.equal(lastName, names.at(-1));
    assert.equal(stores[side].getBee(MUTATION_BEE_ID)?.name, names.at(-1));
    nextOrdinal[side] += batchSize;
  };
  const walBytesBefore = paths.map(walBytes);
  runInterleave(WRITE_WARMUP_ROUNDS, (side, round, leg) => call(side, 'warmup', round, leg));
  assert.equal(nextOrdinal[0], nextOrdinal[1]);
  const writeRounds = WRITE_SAMPLE_BATCHES / 2;
  assert.ok(Number.isInteger(writeRounds));
  runInterleave(writeRounds, (side, round, leg) => call(side, 'sample', round, leg));
  assert.equal(samples[0].length, WRITE_SAMPLE_BATCHES);
  assert.equal(samples[1].length, WRITE_SAMPLE_BATCHES);
  assert.equal(nextOrdinal[0], nextOrdinal[1]);
  return {
    scenario: spec.name,
    operation: `CoreStore.renameBee x${batchSize}`,
    timingBoundary: 'one batch of sequential public renameBee calls; name preparation, checks, and WAL stat excluded',
    durability: 'real CoreStore defaults observed dynamically: WAL, synchronous=NORMAL, EXCLUSIVE locking',
    warmupOrder,
    measuredBatchesPerSide: WRITE_SAMPLE_BATCHES,
    callsPerBatch: batchSize,
    totalCallsPerSideIncludingWarmup: nextOrdinal[0],
    walBytesBefore,
    sides: samples.map(raw => ({ raw, metrics: summarize(raw) })),
  };
}

function readMutationRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(
      "SELECT seq, ts, kind, bee_id, payload FROM audit WHERE bee_id=? AND kind='bee.renamed' ORDER BY seq",
    ).all(MUTATION_BEE_ID).map(row => ({
      seq: Number(row.seq),
      ts: Number(row.ts),
      kind: String(row.kind),
      beeId: String(row.bee_id),
      payload: JSON.parse(String(row.payload)),
    }));
  } finally {
    db.close();
  }
}

function verifyWrites(paths, spec, totalCalls) {
  paths.forEach(assertCheckpointed);
  const rows = paths.map(readMutationRows);
  assert.deepEqual(rows[1], rows[0], 'paired public mutations produced different audit rows');
  assert.equal(rows[0].length, totalCalls);
  for (let index = 0; index < rows[0].length; index += 1) {
    const name = `c25-rename-${String(index).padStart(7, '0')}`;
    const previous = index === 0
      ? 'c25-write-seed'
      : `c25-rename-${String(index - 1).padStart(7, '0')}`;
    assert.deepEqual(rows[0][index], {
      seq: spec.rowCount + index + 1,
      ts: FIXED_NOW,
      kind: 'bee.renamed',
      beeId: MUTATION_BEE_ID,
      payload: { beeId: MUTATION_BEE_ID, name, previous },
    });
  }
  const finalStats = paths.map(path => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return {
        auditRows: Number(db.prepare('SELECT COUNT(*) AS count FROM audit').get().count),
        beeName: String(db.prepare('SELECT name FROM bees WHERE id=?').get(MUTATION_BEE_ID).name),
        quickCheck: String(db.prepare('PRAGMA quick_check').get().quick_check),
        sqliteFileBytes: statSync(path).size,
        sha256: fileSha256(path),
      };
    } finally {
      db.close();
    }
  });
  for (const stats of finalStats) {
    assert.equal(stats.auditRows, spec.rowCount + totalCalls);
    assert.equal(stats.beeName, `c25-rename-${String(totalCalls - 1).padStart(7, '0')}`);
    assert.equal(stats.quickCheck, 'ok');
  }
  return {
    exactOrderedMutationRowsSha256: valueDigest(rows[0]),
    rowsPerSide: rows[0].length,
    firstSeq: rows[0][0]?.seq ?? null,
    lastSeq: rows[0].at(-1)?.seq ?? null,
    fullRowsEqual: true,
    expectedPayloadChain: true,
    final: finalStats,
  };
}

function runScenario(ctx, spec) {
  const scenarioDir = join(ctx.runDir, spec.name);
  mkdirSync(scenarioDir, { recursive: true });
  const canonicalPath = join(scenarioDir, 'canonical.sqlite3');
  process.stderr.write(`C25 seed ${spec.name}: ${spec.rowCount} audit rows\n`);
  const canonicalSha256 = seedFixture(ctx.templatePath, canonicalPath, spec);
  const paths = [join(scenarioDir, 'side-a.sqlite3'), join(scenarioDir, 'side-b.sqlite3')];
  const copyHashes = paths.map(path => copyFixture(canonicalPath, path));
  assert.deepEqual(copyHashes, [canonicalSha256, canonicalSha256]);

  let install = null;
  if (ctx.options.mode === 'ab') {
    process.stderr.write(`C25 install ${spec.name}: offline candidate CREATE INDEX\n`);
    install = installCandidate(paths[1], spec.name);
  }
  const setupHashes = paths.map(fileSha256);
  const inspections = paths.map(path => inspectClosed(path, spec));
  assertInspection(inspections[0], false, spec);
  assertInspection(inspections[1], ctx.options.mode === 'ab', spec);
  assert.equal(inspections[0].schemaVersion, inspections[1].schemaVersion);
  assert.deepEqual(inspections[0].deletionLookupResult, inspections[1].deletionLookupResult);
  if (ctx.options.mode === 'aa') {
    assert.equal(setupHashes[1], setupHashes[0]);
    assert.deepEqual(inspections[1], inspections[0]);
  }

  const opened = paths.map(path => openWithExecEvidence(ctx.module, path));
  const stores = opened.map(value => value.store);
  ctx.liveStores.add(stores[0]);
  ctx.liveStores.add(stores[1]);
  let reads;
  let writes;
  try {
    process.stderr.write(`C25 read ${spec.name}: symmetric warmup, ABBA x${READ_ROUNDS}\n`);
    reads = [
      runReadCase(stores, spec, 'perBeeTail', expectedTail(spec, TARGET_BEE_ID)),
      runReadCase(stores, spec, 'globalTail', expectedTail(spec, undefined)),
    ];
    process.stderr.write(`C25 write ${spec.name}: ${WRITE_SAMPLE_BATCHES} measured batches per side\n`);
    writes = runWriteCase(stores, paths, spec, ctx.scale.renameBatchSize);
  } finally {
    for (const store of stores) {
      store.close();
      ctx.liveStores.delete(store);
    }
  }
  const writeVerification = verifyWrites(paths, spec, writes.totalCallsPerSideIncludingWarmup);
  const storage = {
    timingUse: 'not timed; captured after offline install and before CoreStore open or public mutations',
    sides: inspections,
    deltaBMinusA: {
      sqliteFileBytes: inspections[1].sqliteFileBytes - inspections[0].sqliteFileBytes,
      allocatedBytes: inspections[1].allocatedBytes - inspections[0].allocatedBytes,
      livePageBytes: inspections[1].livePageBytes - inspections[0].livePageBytes,
      candidateIndexBytes: inspections[1].candidate.bytes - inspections[0].candidate.bytes,
    },
  };
  return {
    scenario: spec.name,
    completed: true,
    fixture: {
      auditRows: spec.rowCount,
      targetRows: spec.name === 'dense-target' ? spec.rowCount : spec.targetOrdinals.length,
      nullRows: spec.name === 'null50' ? spec.rowCount / 2 : 0,
      uuidSizedIds: true,
      canonicalSha256,
      equalPreTreatmentCopySha256: copyHashes[0],
      postTreatmentCopySha256: setupHashes,
      syntheticSeed: 'offline prepared inserts into a schema and state created by the measured real CoreStore module',
      deletionLookup: { beeId: spec.deletionBeeId, seq: spec.deletionOrdinal },
    },
    indexInstall: install ?? {
      scenario: spec.name,
      operation: 'not run in AA mode',
      timingBoundary: null,
    },
    storage,
    openDurabilityEvidence: opened.map(value => value.evidence),
    reads,
    writes,
    writeVerification,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  const scale = SCALE[options.scale];
  const startedAt = new Date().toISOString();
  const source = sourceFingerprint(options.repo);
  assert.equal(source.status, '', 'performance author worktree must be clean');
  const toolSha256 = fileSha256(SCRIPT_PATH);
  const environment = environmentEvidence();
  assert.equal(environment.sqliteDbstatEnabled, true, 'SQLite dbstat support is required');
  const report = {
    schemaVersion: 1,
    completed: false,
    startedAt,
    timestamp: null,
    inventoryId: 'C25',
    mode: options.mode === 'ab' ? 'treatment-ab-noindex-vs-partial-index' : 'control-aa-two-noindex-copies',
    source,
    tool: { path: SCRIPT_PATH, sha256: toolSha256 },
    environment,
    workload: {
      scale: options.scale,
      auditRowsPerFixture: scale.auditRows,
      fixtureScenarios: SCENARIOS,
      targetBeeId: TARGET_BEE_ID,
      missingBeeId: MISSING_BEE_ID,
      mutationBeeId: MUTATION_BEE_ID,
      idBytes: Buffer.byteLength(TARGET_BEE_ID),
      tailAfterSeq: 0,
      tailLimit: TAIL_LIMIT,
      readOrder: 'ABBA per round',
      readRounds: READ_ROUNDS,
      readSamplesPerSidePerCase: READ_ROUNDS * 2,
      readWarmupRounds: READ_WARMUP_ROUNDS,
      readWarmupCallsPerSidePerCase: READ_WARMUP_ROUNDS * 2,
      measuredRenameBatchesPerSidePerFixture: WRITE_SAMPLE_BATCHES,
      renameBatchSize: scale.renameBatchSize,
      renameOrder: 'ABBA x5 rounds gives 10 measured batches per side',
      renameWarmupRounds: WRITE_WARMUP_ROUNDS,
      renameWarmupBatchesPerSide: WRITE_WARMUP_ROUNDS * 2,
      fixedNow: FIXED_NOW,
      runtime: 'one real CoreStore TypeScript module loaded through Node type stripping; two independent copied databases',
      treatment: options.mode === 'ab' ? INDEX_SQL : 'none; both sides retain production no-index schema',
      indexInstall: 'offline DatabaseSync.exec only under WAL/NORMAL; not CoreStore, daemon, or process startup',
    },
    module: null,
    results: [],
    scope: [
      'This disposable ruler compares C25 per-bee auditTail behavior on byte-equal copied databases before treatment.',
      'Synthetic audit fixtures are inserted offline while CoreStore is closed; measured reads and mutations call the real public CoreStore methods.',
      'Read and write comparisons share one process heap, so ABBA reduces host drift but does not remove shared GC, scheduling, cache, or thermal effects.',
      'Storage uses closed files and dbstat. Candidate installation times only CREATE INDEX exec and is not labeled as whole-daemon or CoreStore startup.',
      'The ruler does not access a deployed daemon, provider, runtime driver, live store, benchmark script, or Mini host.',
    ].join(' '),
    failure: null,
  };
  writeReport(options.out, report);

  const runDir = mkdtempSync(join(tmpdir(), 'hb-c25-ruler-'));
  const liveStores = new Set();
  let phase = 'import';
  let cleaning = false;
  const cleanup = () => {
    if (cleaning) return;
    cleaning = true;
    for (const store of liveStores) {
      try { store.close(); } catch { /* best effort on failure */ }
    }
    liveStores.clear();
    rmSync(runDir, { recursive: true, force: true });
  };
  const finishFailure = error => {
    report.failure ??= failureEvidence(error, phase);
    report.environment.loadAfter = loadavg();
    report.timestamp = new Date().toISOString();
    try { writeReport(options.out, report); } finally { cleanup(); }
  };
  const onSignal = name => {
    finishFailure(new Error(`interrupted by ${name}`));
    process.exit(name === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const importUrl = `${pathToFileURL(join(options.repo, 'v2/core/src/index.ts')).href}?c25-ruler=${process.pid}`;
    const module = await import(importUrl);
    assert.equal(typeof module.openCoreStore, 'function');
    assert.equal(typeof module.CoreStore, 'function');
    report.module = {
      importUrl,
      coreStoreConstructor: module.CoreStore.name,
      sameModuleBothSides: true,
    };
    phase = 'template';
    const templatePath = createTemplate(module, runDir);
    const ctx = { options, scale, runDir, liveStores, module, templatePath };
    for (const name of SCENARIOS) {
      phase = `scenario-${name}`;
      report.results.push(runScenario(ctx, fixtureSpec(name, scale.auditRows)));
      writeReport(options.out, report);
    }
    phase = 'final-provenance';
    assert.deepEqual(sourceFingerprint(options.repo), source, 'CoreStore source or worktree changed during capture');
    assert.equal(fileSha256(SCRIPT_PATH), toolSha256, 'ruler bytes changed during capture');
    assert.equal(report.results.length, SCENARIOS.length);
    assert.ok(report.results.every(result => result.completed));
    report.environment.loadAfter = loadavg();
    report.timestamp = new Date().toISOString();
    report.completed = true;
    writeReport(options.out, report);
  } catch (error) {
    finishFailure(error);
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    cleanup();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
