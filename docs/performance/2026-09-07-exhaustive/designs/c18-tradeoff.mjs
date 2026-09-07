#!/usr/bin/env node
// Disposable paired ruler for the C18 rpc_idempotency created_at index tradeoff.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const INDEX_NAME = 'rpc_idempotency_created_at';
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON rpc_idempotency(created_at);`;
const CANONICAL_RETENTION = 10_000;
const FIXED_NOW = 1_800_000_000_000;
const WARMUP_ROUNDS = 3;
const INSTALL_WARMUP_ROUNDS = 1;
const ABBA = Object.freeze([0, 1, 1, 0]);
const SIDES = Object.freeze(['before', 'after']);
const SCALE = Object.freeze({
  smoke: Object.freeze({ rowCounts: [0, 10, 100], installRowCounts: [10, 100], retentionRows: 100 }),
  canonical: Object.freeze({
    rowCounts: [0, 1_000, CANONICAL_RETENTION],
    installRowCounts: [1_000, CANONICAL_RETENTION],
    retentionRows: CANONICAL_RETENTION,
  }),
});

function parseArgs(argv) {
  const options = {
    beforeRoot: null,
    afterRoot: process.cwd(),
    out: '/tmp/honeybee-perf-c18-tradeoff.json',
    rounds: 15,
    scale: 'canonical',
    control: false,
    help: false,
  };
  const value = (name, index) => {
    const next = argv[index + 1];
    assert.ok(next && !next.startsWith('--'), `${name} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--before-root') options.beforeRoot = value(arg, i++);
    else if (arg === '--after-root') options.afterRoot = value(arg, i++);
    else if (arg === '--out') options.out = value(arg, i++);
    else if (arg === '--rounds') options.rounds = Number(value(arg, i++));
    else if (arg === '--scale') options.scale = value(arg, i++).toLowerCase();
    else if (arg === '--control') options.control = true;
    else if (arg === '--help') options.help = true;
    else assert.fail(`unknown option: ${arg}`);
  }
  if (!options.help) assert.ok(options.beforeRoot, '--before-root is required');
  assert.ok(Number.isSafeInteger(options.rounds) && options.rounds >= 1 && options.rounds <= 100,
    'rounds must be 1..100');
  assert.ok(Object.hasOwn(SCALE, options.scale), 'scale must be smoke or canonical');
  if (options.beforeRoot) options.beforeRoot = resolve(options.beforeRoot);
  options.afterRoot = resolve(options.afterRoot);
  options.out = resolve(options.out);
  return options;
}

function helpText() {
  return [
    'node /tmp/honeybee-perf-c18-tradeoff-ruler.mjs --before-root PATH [options]',
    '',
    'Options:',
    '  --after-root PATH   candidate checkout (default: cwd)',
    '  --out PATH          JSON report (default: /tmp/honeybee-perf-c18-tradeoff.json)',
    '  --rounds N          ABBA rounds; two raw samples per side per round (default: 15)',
    '  --scale NAME        canonical uses 0/1000/10000 rows; smoke uses 0/10/100',
    '  --control           require two identical pre-index sources for an A/A noise control',
    '  --help',
  ].join('\n');
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function valueDigest(values) {
  return sha256(values.map(value => `${stableJson(value)}\n`).join(''));
}

function distribution(values) {
  assert.ok(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0),
    'finite non-negative samples required');
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

function summarizeSamples(samples) {
  return {
    'operation.wall': { unit: 'ms', ...distribution(samples.map(sample => sample.wallMs)) },
    'operation.cpu': { unit: 'ms', ...distribution(samples.map(sample => sample.cpuMs)) },
  };
}

function git(root, ...argv) {
  const run = spawnSync('git', argv, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return run.stdout;
}

function sourceFingerprint(root) {
  const runtimeFiles = git(root, 'ls-files', '--cached', '--others', '--exclude-standard', 'v2/core/src')
    .trim().split('\n').filter(file => file.endsWith('.ts')).sort();
  assert.ok(runtimeFiles.length > 0, `no Core source files found under ${root}`);
  const supporting = ['package.json', 'package-lock.json', 'v2/core/package.json']
    .filter(file => existsSync(join(root, file)));
  const files = [...runtimeFiles, ...supporting];
  return {
    root,
    realRoot: realpathSync(root),
    revision: git(root, 'rev-parse', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain'),
    diffSha256: sha256(git(root, 'diff', '--binary', 'HEAD')),
    files: Object.fromEntries(files.map(file => [file, fileSha256(join(root, file))])),
    aggregateSha256: valueDigest(files.map(file => [file, fileSha256(join(root, file))])),
  };
}

function sourceComparison(before, after, control) {
  const beforeFiles = Object.keys(before.files).sort();
  assert.deepEqual(Object.keys(after.files).sort(), beforeFiles, 'source file sets differ');
  const changedFiles = beforeFiles.filter(file => before.files[file] !== after.files[file]);
  const beforeSchema = readFileSync(join(before.root, 'v2/core/src/schema.ts'), 'utf8');
  const afterSchema = readFileSync(join(after.root, 'v2/core/src/schema.ts'), 'utf8');
  const indexSqlCounts = [beforeSchema, afterSchema].map(schema => schema.split(INDEX_SQL).length - 1);
  if (control) {
    assert.deepEqual(changedFiles, [], 'A/A control roots must have identical runtime/package files');
    assert.equal(before.revision, after.revision, 'A/A control roots must use the same revision');
    assert.equal(before.diffSha256, after.diffSha256, 'A/A control roots must have identical diffs');
    assert.deepEqual(indexSqlCounts, [0, 0], 'A/A control requires two identical pre-index sources');
  } else {
    assert.deepEqual(changedFiles, ['v2/core/src/schema.ts'],
      'C18 A/B roots must differ only in v2/core/src/schema.ts among runtime/package files');
    assert.deepEqual(indexSqlCounts, [0, 1],
      'C18 A/B requires a pre-index baseline and the exact candidate index once');
  }
  const expectedTargetIndexPresent = control ? [false, false] : [false, true];
  return {
    mode: control ? 'control-aa-pre-index' : 'treatment-ab',
    changedFiles,
    indexSqlCounts,
    expectedTargetIndexPresent,
    comparisonSha256: sha256(stableJson({
      before: before.aggregateSha256,
      after: after.aggregateSha256,
      changedFiles,
      control,
      expectedTargetIndexPresent,
    })),
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
  const identity = {
    node: process.version,
    nodeExecutable: process.execPath,
    nodeExecutableSha256: fileSha256(process.execPath),
    execArgv: process.execArgv,
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
  return { ...identity, identitySha256: sha256(stableJson(identity)), loadBefore: loadavg(), loadAfter: null };
}

function toolFingerprint(roots) {
  const ruler = fileSha256(SCRIPT_PATH);
  const sqlTrace = roots.map(root => fileSha256(join(root, 'scripts/perf/sql-trace.mjs')));
  assert.equal(sqlTrace[1], sqlTrace[0], 'sql-trace.mjs differs between roots');
  return {
    rulerSha256: ruler,
    sqlTraceSha256: sqlTrace[0],
    aggregateSha256: valueDigest([ruler, sqlTrace[0]]),
  };
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
  assert.ok(!existsSync(wal) || statSync(wal).size === 0,
    `fixture retains a non-empty WAL: ${wal}`);
}

function copyFixture(source, destination) {
  assertCheckpointed(source);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  const sourceHash = fileSha256(source);
  const destinationHash = fileSha256(destination);
  assert.equal(destinationHash, sourceHash, 'fixture copy differs from its source');
  return destinationHash;
}

function seedKey(index, rowCount) {
  return `seed-${String(rowCount - index - 1).padStart(6, '0')}`;
}

function seedResult(index, key) {
  return index % 11 === 0 ? null : { kind: 'seed', ordinal: index, key };
}

function writeKey(ordinal) {
  return `write-${String(ordinal).padStart(6, '0')}`;
}

function writeRecord(ordinal) {
  const key = writeKey(ordinal);
  return {
    key,
    verb: ordinal % 2 === 0 ? 'send' : 'spawn',
    commandId: ordinal % 3 === 0 ? null : ordinal,
    result: ordinal % 7 === 0 ? null : { kind: 'write', ordinal, key },
    createdAt: FIXED_NOW,
  };
}

function expectedSeedRows(rowCount) {
  return Array.from({ length: rowCount }, (_, index) => {
    const key = seedKey(index, rowCount);
    return {
      key,
      verb: index % 2 === 0 ? 'fixture-a' : 'fixture-b',
      commandId: index % 3 === 0 ? null : index,
      result: seedResult(index, key),
      createdAt: FIXED_NOW,
    };
  });
}

function seedFixture(templatePath, destination, rowCount) {
  copyFixture(templatePath, destination);
  const db = new DatabaseSync(destination);
  try {
    db.exec('PRAGMA synchronous = OFF');
    const insert = db.prepare(
      'INSERT INTO rpc_idempotency(key, verb, command_id, result, created_at) VALUES(?, ?, ?, ?, ?)',
    );
    db.exec('BEGIN');
    for (let index = 0; index < rowCount; index += 1) {
      const key = seedKey(index, rowCount);
      insert.run(
        key,
        index % 2 === 0 ? 'fixture-a' : 'fixture-b',
        index % 3 === 0 ? null : index,
        JSON.stringify(seedResult(index, key)),
        FIXED_NOW,
      );
    }
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM rpc_idempotency').get().n), rowCount);
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = ?`).get(INDEX_NAME), undefined,
      'canonical fixture must not contain the candidate index');
  } finally {
    db.close();
  }
  assertCheckpointed(destination);
  return fileSha256(destination);
}

function readRpcRows(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(
      `SELECT rowid AS row_id, key, verb, command_id, result, created_at
       FROM rpc_idempotency ORDER BY created_at, rowid`,
    ).all().map(row => ({
      rowId: Number(row.row_id),
      key: String(row.key),
      verb: String(row.verb),
      commandId: row.command_id == null ? null : Number(row.command_id),
      result: JSON.parse(String(row.result)),
      createdAt: Number(row.created_at),
    }));
  } finally {
    db.close();
  }
}

function logicalRows(rows) {
  return rows.map(({ key, verb, commandId, result, createdAt }) => ({
    key,
    verb,
    commandId,
    result,
    createdAt,
  }));
}

function inspectClosedStore(path) {
  assertCheckpointed(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const pageSize = Number(db.prepare('PRAGMA page_size').get().page_size);
    const pageCount = Number(db.prepare('PRAGMA page_count').get().page_count);
    const freelistCount = Number(db.prepare('PRAGMA freelist_count').get().freelist_count);
    const journalMode = String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase();
    const integrity = String(db.prepare('PRAGMA quick_check').get().quick_check);
    const indexes = db.prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'index' AND tbl_name = 'rpc_idempotency' ORDER BY name`,
    ).all().map(row => ({ name: String(row.name), sql: row.sql == null ? null : String(row.sql) }));
    const dbstat = db.prepare(
      'SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name',
    ).all().map(row => ({ name: String(row.name), pages: Number(row.pages), bytes: Number(row.bytes) }));
    const targetColumns = db.prepare(
      `SELECT name FROM pragma_index_info('${INDEX_NAME}') ORDER BY seqno`,
    ).all().map(row => String(row.name));
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN DELETE FROM rpc_idempotency
       WHERE key IN (
         SELECT key FROM rpc_idempotency ORDER BY created_at, rowid LIMIT ?
       )`,
    ).all(1).map(row => String(row.detail));
    return {
      rowCount: Number(db.prepare('SELECT COUNT(*) AS n FROM rpc_idempotency').get().n),
      sqliteFileBytes: statSync(path).size,
      pageSize,
      pageCount,
      freelistCount,
      allocatedBytes: pageSize * pageCount,
      livePageBytes: pageSize * (pageCount - freelistCount),
      journalMode,
      integrity,
      indexes,
      dbstat,
      targetIndex: {
        present: indexes.some(index => index.name === INDEX_NAME),
        columns: targetColumns,
        bytes: dbstat.find(row => row.name === INDEX_NAME)?.bytes ?? 0,
      },
      evictionPlan: plan,
    };
  } finally {
    db.close();
  }
}

function assertIndexState(stats, expectedPresent) {
  assert.equal(stats.integrity, 'ok');
  assert.equal(stats.journalMode, 'wal');
  if (!expectedPresent) {
    assert.equal(stats.targetIndex.present, false, 'pre-index implementation unexpectedly has candidate index');
    assert.deepEqual(stats.targetIndex.columns, []);
    assert.equal(stats.targetIndex.bytes, 0);
    assert.ok(stats.evictionPlan.some(detail => detail.includes('USE TEMP B-TREE FOR ORDER BY')),
      'baseline eviction plan must materialize its sort');
  } else {
    assert.equal(stats.targetIndex.present, true, 'candidate did not install target index');
    assert.deepEqual(stats.targetIndex.columns, ['created_at'],
      'candidate index must keep implicit rowid as the tie-breaker');
    assert.ok(stats.targetIndex.bytes > 0);
    assert.ok(stats.evictionPlan.some(detail => detail.includes(`USING INDEX ${INDEX_NAME}`)),
      'candidate eviction plan did not choose the target index naturally');
    assert.ok(!stats.evictionPlan.some(detail => detail.includes('USE TEMP B-TREE')),
      'candidate eviction plan still materializes a sort');
  }
}

function expectedRecord(record) {
  return {
    key: record.key,
    verb: record.verb,
    commandId: record.commandId,
    result: record.result,
    createdAt: record.createdAt,
  };
}

function assertLookup(store, record) {
  assert.deepEqual(store.lookupRpcResult(record.key), expectedRecord(record));
}

function measure(operation) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  operation();
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return { wallMs, cpuMs: (used.user + used.system) / 1_000 };
}

function runInterleave(rounds, callback) {
  for (let round = 0; round < rounds; round += 1) {
    for (let leg = 0; leg < ABBA.length; leg += 1) callback(ABBA[leg], round, leg);
  }
}

async function importRoots(roots) {
  const modules = await Promise.all(roots.map((root, side) => import(
    `${pathToFileURL(join(root, 'v2/core/src/index.ts')).href}?c18-ruler-side=${side}-${process.pid}`
  )));
  assert.notEqual(modules[0].CoreStore, modules[1].CoreStore,
    'two roots must load distinct CoreStore module identities');
  assert.notEqual(modules[0].openCoreStore, modules[1].openCoreStore,
    'two roots must load distinct openCoreStore functions');
  const sqlTrace = await Promise.all(roots.map((root, side) => import(
    `${pathToFileURL(join(root, 'scripts/perf/sql-trace.mjs')).href}?c18-ruler-side=${side}-${process.pid}`
  )));
  return { modules, sqlTrace };
}

function createTemplate(module, runDir, liveStores, retentionRows) {
  const path = join(runDir, 'baseline-schema.sqlite3');
  const store = module.openCoreStore(path, {
    now: () => FIXED_NOW,
    maxRpcIdempotencyRows: retentionRows,
  });
  liveStores.add(store);
  assert.ok(store instanceof module.CoreStore);
  store.close();
  liveStores.delete(store);
  const stats = inspectClosedStore(path);
  assertIndexState(stats, false);
  assert.equal(stats.rowCount, 0);
  return path;
}

function balanceSecondModuleOpen(module, templatePath, runDir, liveStores, retentionRows, expectedIndexPresent) {
  const path = join(runDir, 'second-module-balance.sqlite3');
  copyFixture(templatePath, path);
  const store = module.openCoreStore(path, {
    now: () => FIXED_NOW,
    maxRpcIdempotencyRows: retentionRows,
  });
  liveStores.add(store);
  assert.ok(store instanceof module.CoreStore);
  store.close();
  liveStores.delete(store);
  assertIndexState(inspectClosedStore(path), expectedIndexPresent);
}

function verifyFixtureRows(path, rowCount) {
  const actual = logicalRows(readRpcRows(path));
  const expected = expectedSeedRows(rowCount);
  assert.deepEqual(actual, expected);
  return {
    rowCount,
    orderedRowsSha256: valueDigest(actual),
    firstKey: actual[0]?.key ?? null,
    lastKey: actual.at(-1)?.key ?? null,
  };
}

function checkRepresentativeLookups(store, rowCount) {
  assert.equal(store.lookupRpcResult('missing-c18-ruler-key'), null);
  if (rowCount === 0) return;
  const records = expectedSeedRows(rowCount);
  assertLookup(store, records[0]);
  assertLookup(store, records.at(-1));
  const nullRecord = records.find(record => record.result === null);
  assert.ok(nullRecord);
  assertLookup(store, nullRecord);
}

function runInstallCase(ctx, rowCount) {
  const samples = [[], []];
  const order = [];
  let invocation = 0;
  const call = (side, phase, round, leg) => {
    const callDir = join(ctx.runDir, `install-${rowCount}-${phase}-${String(invocation++).padStart(5, '0')}`);
    const path = join(callDir, `${SIDES[side]}.sqlite3`);
    const fixtureSha256 = copyFixture(ctx.fixtures.get(rowCount).path, path);
    let store;
    try {
      const timing = measure(() => {
        store = ctx.modules[side].openCoreStore(path, {
          now: () => FIXED_NOW,
          maxRpcIdempotencyRows: ctx.retentionRows,
        });
      });
      ctx.liveStores.add(store);
      assert.ok(store instanceof ctx.modules[side].CoreStore);
      assert.equal(store.lastAuditSeq(), 0);
      checkRepresentativeLookups(store, rowCount);
      store.close();
      ctx.liveStores.delete(store);
      store = undefined;
      const stats = inspectClosedStore(path);
      assertIndexState(stats, ctx.expectedTargetIndexPresent[side]);
      assert.equal(stats.rowCount, rowCount);
      const rows = verifyFixtureRows(path, rowCount);
      const event = {
        phase,
        round,
        leg,
        side: SIDES[side],
        fixtureSha256,
        wallMs: timing.wallMs,
        cpuMs: timing.cpuMs,
        installedTargetIndex: stats.targetIndex.present,
        retainedRowsSha256: rows.orderedRowsSha256,
      };
      order.push(event);
      if (phase === 'sample') samples[side].push(event);
    } finally {
      if (store) {
        store.close();
        ctx.liveStores.delete(store);
      }
      rmSync(callDir, { recursive: true, force: true });
    }
  };
  runInterleave(INSTALL_WARMUP_ROUNDS, (side, round, leg) => call(side, 'warmup', round, leg));
  runInterleave(ctx.rounds, (side, round, leg) => call(side, 'sample', round, leg));
  assert.equal(samples[0].length, ctx.rounds * 2);
  assert.equal(samples[1].length, ctx.rounds * 2);
  assert.deepEqual(samples[0].map(sample => sample.fixtureSha256), samples[1].map(sample => sample.fixtureSha256),
    'first-open samples did not start from equal copied fixtures');
  return {
    scenario: `c18-first-populated-reopen-${rowCount}`,
    inventoryId: 'C18',
    operation: 'openCoreStore',
    fixture: { initialRows: rowCount, targetIndexInitiallyAbsent: true },
    completed: true,
    timingBoundary: 'openCoreStore call only; fixture copy, checks, close, inspection, and cleanup excluded',
    order,
    sides: Object.fromEntries(SIDES.map((side, index) => [side, {
      raw: samples[index],
      metrics: summarizeSamples(samples[index]),
    }])),
    correctness: {
      equalFixtureCopies: true,
      exactRowsAndResultsRetained: true,
      expectedTargetIndexPresent: ctx.expectedTargetIndexPresent,
      actualTargetIndexPresent: SIDES.map((_, side) => samples[side][0].installedTargetIndex),
      targetIndexColumns: ['created_at'],
    },
  };
}

function runStorageCase(ctx, rowCount) {
  const fixture = ctx.fixtures.get(rowCount);
  const copies = SIDES.map(side => join(ctx.runDir, `storage-${rowCount}-${side}.sqlite3`));
  const copyHashes = copies.map(path => copyFixture(fixture.path, path));
  assert.equal(copyHashes[1], copyHashes[0], 'storage sides did not start byte-identical');
  for (let side = 0; side < SIDES.length; side += 1) {
    const store = ctx.modules[side].openCoreStore(copies[side], {
      now: () => FIXED_NOW,
      maxRpcIdempotencyRows: ctx.retentionRows,
    });
    ctx.liveStores.add(store);
    try {
      checkRepresentativeLookups(store, rowCount);
      assert.equal(store.lastAuditSeq(), 0);
    } finally {
      store.close();
      ctx.liveStores.delete(store);
    }
  }
  const rows = copies.map(path => logicalRows(readRpcRows(path)));
  assert.deepEqual(rows[1], rows[0]);
  assert.deepEqual(rows[0], expectedSeedRows(rowCount));
  const stats = copies.map(inspectClosedStore);
  stats.forEach((value, side) => {
    assertIndexState(value, ctx.expectedTargetIndexPresent[side]);
    assert.equal(value.rowCount, rowCount);
  });
  return {
    scenario: `c18-storage-${rowCount}`,
    inventoryId: 'C18',
    fixture: { initialRows: rowCount },
    completed: true,
    timingUse: 'not timed',
    equalFixtureSha256: copyHashes[0],
    retainedRowsSha256: valueDigest(rows[0]),
    sides: Object.fromEntries(SIDES.map((side, index) => [side, stats[index]])),
    delta: {
      sqliteFileBytes: stats[1].sqliteFileBytes - stats[0].sqliteFileBytes,
      allocatedBytes: stats[1].allocatedBytes - stats[0].allocatedBytes,
      livePageBytes: stats[1].livePageBytes - stats[0].livePageBytes,
      candidateTargetIndexBytes: stats[1].targetIndex.bytes,
    },
    correctness: {
      equalLogicalRows: true,
      exactOrderAndResults: true,
      naturalPlansVerified: true,
    },
  };
}

function expectedRowsAfterWrites(initialRows, writes, retentionRows) {
  const all = [...expectedSeedRows(initialRows), ...Array.from({ length: writes }, (_, index) => writeRecord(index))];
  return all.slice(Math.max(0, all.length - retentionRows));
}

function runWriteCase(ctx, rowCount) {
  const fixture = ctx.fixtures.get(rowCount);
  const copies = SIDES.map(side => join(ctx.runDir, `write-${rowCount}-${side}.sqlite3`));
  const copyHashes = copies.map(path => copyFixture(fixture.path, path));
  assert.equal(copyHashes[1], copyHashes[0], 'write sides did not start byte-identical');
  const stores = copies.map((path, side) => {
    const store = ctx.modules[side].openCoreStore(path, {
      now: () => FIXED_NOW,
      maxRpcIdempotencyRows: ctx.retentionRows,
    });
    ctx.liveStores.add(store);
    assert.ok(store instanceof ctx.modules[side].CoreStore);
    checkRepresentativeLookups(store, rowCount);
    assert.equal(store.lastAuditSeq(), 0);
    return store;
  });
  const sideOrdinals = [0, 0];
  const samples = [[], []];
  const order = [];
  const call = (side, phase, round, leg) => {
    const ordinal = sideOrdinals[side]++;
    const record = writeRecord(ordinal);
    let timing = null;
    if (phase === 'sample') {
      timing = measure(() => stores[side].recordRpcResult(
        record.key,
        record.verb,
        record.commandId,
        record.result,
      ));
    } else {
      stores[side].recordRpcResult(record.key, record.verb, record.commandId, record.result);
    }
    assertLookup(stores[side], record);
    assert.equal(stores[side].lastAuditSeq(), 0, 'RPC retention must not append audit authority');
    const event = { phase, round, leg, side: SIDES[side], ordinal, key: record.key };
    if (timing) {
      Object.assign(event, timing);
      samples[side].push(event);
    }
    order.push(event);
  };
  try {
    runInterleave(WARMUP_ROUNDS, (side, round, leg) => call(side, 'warmup', round, leg));
    assert.equal(sideOrdinals[0], sideOrdinals[1]);
    runInterleave(ctx.rounds, (side, round, leg) => call(side, 'sample', round, leg));
    assert.equal(sideOrdinals[0], sideOrdinals[1]);
    assert.equal(samples[0].length, ctx.rounds * 2);
    assert.equal(samples[1].length, ctx.rounds * 2);
  } finally {
    for (const store of stores) {
      store.close();
      ctx.liveStores.delete(store);
    }
  }
  const writes = sideOrdinals[0];
  const expected = expectedRowsAfterWrites(rowCount, writes, ctx.retentionRows);
  const actual = copies.map(path => readRpcRows(path));
  assert.deepEqual(actual[1], actual[0], 'sides differ after equal ordered writes');
  assert.deepEqual(logicalRows(actual[0]), expected);
  const expectedCount = Math.min(ctx.retentionRows, rowCount + writes);
  assert.equal(actual[0].length, expectedCount);
  const evicted = Math.max(0, rowCount + writes - ctx.retentionRows);
  const evictedKeys = expectedSeedRows(rowCount).slice(0, evicted).map(record => record.key);
  for (const key of evictedKeys) assert.ok(!actual[0].some(row => row.key === key), `oldest row was not evicted: ${key}`);
  for (let ordinal = 0; ordinal < writes; ordinal += 1) {
    assert.deepEqual(logicalRows(actual[0]).find(row => row.key === writeKey(ordinal)), writeRecord(ordinal));
  }
  for (let side = 0; side < SIDES.length; side += 1) {
    const reopened = ctx.modules[side].openCoreStore(copies[side], {
      now: () => FIXED_NOW,
      maxRpcIdempotencyRows: ctx.retentionRows,
    });
    ctx.liveStores.add(reopened);
    try {
      assertLookup(reopened, writeRecord(writes - 1));
      assert.equal(reopened.lastAuditSeq(), 0);
    } finally {
      reopened.close();
      ctx.liveStores.delete(reopened);
    }
  }
  const stats = copies.map(inspectClosedStore);
  stats.forEach((value, side) => {
    assertIndexState(value, ctx.expectedTargetIndexPresent[side]);
    assert.equal(value.rowCount, expectedCount);
  });
  const orderedLogical = logicalRows(actual[0]);
  return {
    scenario: rowCount === ctx.retentionRows
      ? `c18-at-cap-eviction-${rowCount}`
      : `c18-pre-cap-insert-${rowCount}`,
    inventoryId: 'C18',
    operation: 'CoreStore.recordRpcResult',
    fixture: {
      initialRows: rowCount,
      retentionRows: ctx.retentionRows,
      fixedCreatedAt: FIXED_NOW,
      equalTimestampTieBreaker: 'rowid',
    },
    completed: true,
    timingBoundary: 'recordRpcResult only; lookup checks, setup, warmup, close, reopen, inspection, and cleanup excluded',
    order,
    sides: Object.fromEntries(SIDES.map((side, index) => [side, {
      raw: samples[index],
      metrics: summarizeSamples(samples[index]),
    }])),
    correctness: {
      equalFixtureCopies: true,
      callsPerSide: writes,
      warmupCallsPerSide: WARMUP_ROUNDS * 2,
      measuredCallsPerSide: ctx.rounds * 2,
      expectedRetainedRows: expectedCount,
      actualRetainedRows: actual[0].length,
      retainedRowsWithinCapAfterAllCalls: actual[0].length <= ctx.retentionRows,
      evictedSeedRows: evicted,
      evictedKeys,
      allDistinctWritesRetained: true,
      exactKeyResultAndOrder: true,
      expectedOrderSha256: valueDigest(expected),
      actualOrderSha256: valueDigest(orderedLogical),
      firstRetainedKeys: orderedLogical.slice(0, 3).map(row => row.key),
      lastRetainedKeys: orderedLogical.slice(-3).map(row => row.key),
      nullResultsRoundTrip: orderedLogical.some(row => row.result === null),
      durableReopenVerified: true,
      auditSeqBefore: 0,
      auditSeqAfter: 0,
    },
  };
}

function assertSqlCall(statements, kind, sql) {
  assert.ok(statements.some(statement => statement.kind === kind && statement.sql === sql && statement.calls > 0),
    `missing SQL diagnostic call: ${kind} ${sql}`);
}

function runSqlDiagnostic(ctx) {
  const fixture = ctx.fixtures.get(ctx.config.rowCounts.at(-1));
  const sides = {};
  for (let side = 0; side < SIDES.length; side += 1) {
    const path = join(ctx.runDir, `diagnostic-${SIDES[side]}.sqlite3`);
    copyFixture(fixture.path, path);
    const openCapture = ctx.sqlTrace[side].captureSql(() => ctx.modules[side].openCoreStore(path, {
      now: () => FIXED_NOW,
      maxRpcIdempotencyRows: ctx.retentionRows,
    }));
    const store = openCapture.value;
    ctx.liveStores.add(store);
    let writeCapture;
    try {
      writeCapture = ctx.sqlTrace[side].captureSql(() => store.recordRpcResult(
        'diagnostic-write',
        'send',
        null,
        { diagnostic: true },
      ));
      assert.deepEqual(store.lookupRpcResult('diagnostic-write')?.result, { diagnostic: true });
      assert.equal(store.lastAuditSeq(), 0);
    } finally {
      store.close();
      ctx.liveStores.delete(store);
    }
    for (const sql of [
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'BEGIN IMMEDIATE',
      'COMMIT',
    ]) assertSqlCall(openCapture.statements, 'exec', sql);
    assertSqlCall(writeCapture.statements, 'exec', 'BEGIN IMMEDIATE');
    assertSqlCall(writeCapture.statements, 'exec', 'COMMIT');
    assertSqlCall(writeCapture.statements, 'run',
      'INSERT INTO rpc_idempotency(key, verb, command_id, result, created_at) VALUES(?, ?, ?, ?, ?)');
    assertSqlCall(writeCapture.statements, 'get', 'SELECT COUNT(*) AS n FROM rpc_idempotency');
    if (fixture.rowCount === ctx.retentionRows) {
      assertSqlCall(writeCapture.statements, 'run',
        'DELETE FROM rpc_idempotency WHERE key IN (SELECT key FROM rpc_idempotency ORDER BY created_at, rowid LIMIT ?)');
    }
    const stats = inspectClosedStore(path);
    assertIndexState(stats, ctx.expectedTargetIndexPresent[side]);
    assert.equal(stats.rowCount, Math.min(ctx.retentionRows, fixture.rowCount + 1));
    sides[SIDES[side]] = {
      open: openCapture.statements,
      recordRpcResult: writeCapture.statements,
      finalRows: stats.rowCount,
    };
  }
  return {
    instrumented: true,
    timingUse: 'diagnostic only; excluded from raw samples and speed comparisons',
    fixture: { initialRows: fixture.rowCount },
    checks: {
      productionWal: true,
      productionSynchronousNormal: true,
      recordTransactionBeginCommit: true,
      atCapDeleteObserved: fixture.rowCount === ctx.retentionRows,
    },
    sides,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(helpText());
    return;
  }
  assert.notEqual(realpathSync(options.beforeRoot), realpathSync(options.afterRoot),
    'before and after must be distinct checkout roots');
  const roots = [options.beforeRoot, options.afterRoot];
  const startedAt = new Date().toISOString();
  const source = roots.map(sourceFingerprint);
  const comparison = sourceComparison(source[0], source[1], options.control);
  const initialTools = toolFingerprint(roots);
  const environment = environmentEvidence();
  const config = SCALE[options.scale];
  const report = {
    schemaVersion: 1,
    completed: false,
    startedAt,
    timestamp: null,
    source: { before: source[0], after: source[1], comparison },
    toolHashes: initialTools,
    environment,
    workload: {
      inventoryId: 'C18',
      comparisonMode: comparison.mode,
      scale: options.scale,
      rounds: options.rounds,
      samplesPerSidePerCase: options.rounds * 2,
      order: 'ABBA per round',
      warmup: {
        writeRounds: WARMUP_ROUNDS,
        writeCallsPerSide: WARMUP_ROUNDS * 2,
        firstOpenRounds: INSTALL_WARMUP_ROUNDS,
        firstOpenCallsPerSide: INSTALL_WARMUP_ROUNDS * 2,
      },
      rowCounts: config.rowCounts,
      installRowCounts: config.installRowCounts,
      retentionRows: config.retentionRows,
      fixedNow: FIXED_NOW,
      durability: 'real CoreStore defaults; WAL and synchronous=NORMAL; recordRpcResult owns BEGIN IMMEDIATE/COMMIT',
      runtime: 'source TypeScript through Node type stripping',
      timingInstrumentation: 'none',
      setupAndResetTiming: 'excluded',
      syntheticSeed: 'offline SQLite while CoreStore is closed; synchronous=OFF fixture transaction',
    },
    moduleIdentity: null,
    fixtures: [],
    installResults: [],
    storageResults: [],
    results: [],
    sqlDiagnostic: null,
    scope: [
      'This ruler measures C18 read-cost fixture maintenance, retention eviction, storage, and populated index installation.',
      'Offline synthetic rows are not durable RPC mutation or audit-replay evidence.',
      'Timed inserts use real CoreStore production WAL/NORMAL transactions on fresh owned stores.',
      'The two implementations share one process heap, so ABBA reduces host drift but does not remove shared GC, scheduling, filesystem cache, or thermal effects.',
      'Every first-open sample uses a fresh byte-identical database copy. Copy, checks, close, and cleanup are outside timing.',
      'Storage uses closed SQLite files and dbstat object pages. First-open results use warm code and filesystem state, not cold process or cold disk startup.',
      'No provider, daemon, runtime driver, live store, or Mini host is accessed by the ruler.',
    ].join(' '),
    failure: null,
  };
  writeReport(options.out, report);

  const runDir = mkdtempSync(join(tmpdir(), 'hb-c18-tradeoff-'));
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
  const signal = name => {
    finishFailure(new Error(`interrupted by ${name}`));
    process.exit(name === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => signal('SIGINT');
  const onSigterm = () => signal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const imported = await importRoots(roots);
    const modules = imported.modules;
    report.moduleIdentity = {
      distinctRoots: true,
      distinctCoreStoreConstructors: modules[0].CoreStore !== modules[1].CoreStore,
      distinctOpenFunctions: modules[0].openCoreStore !== modules[1].openCoreStore,
      importUrls: roots.map((root, side) =>
        `${pathToFileURL(join(root, 'v2/core/src/index.ts')).href}?c18-ruler-side=${side}-${process.pid}`),
    };

    phase = 'fixture-template';
    const templatePath = createTemplate(modules[0], runDir, liveStores, config.retentionRows);
    balanceSecondModuleOpen(
      modules[1],
      templatePath,
      runDir,
      liveStores,
      config.retentionRows,
      comparison.expectedTargetIndexPresent[1],
    );
    const fixtures = new Map();
    for (const rowCount of config.rowCounts) {
      phase = `fixture-${rowCount}`;
      const path = join(runDir, `fixture-${rowCount}.sqlite3`);
      const sha = seedFixture(templatePath, path, rowCount);
      const verified = verifyFixtureRows(path, rowCount);
      const fixture = { rowCount, path, sha256: sha, ...verified };
      fixtures.set(rowCount, fixture);
      report.fixtures.push({ ...fixture, path: '<owned temporary fixture removed after capture>' });
      writeReport(options.out, report);
    }
    const ctx = {
      runDir,
      roots,
      modules,
      sqlTrace: imported.sqlTrace,
      liveStores,
      fixtures,
      rounds: options.rounds,
      config,
      retentionRows: config.retentionRows,
      expectedTargetIndexPresent: comparison.expectedTargetIndexPresent,
    };

    for (const rowCount of config.installRowCounts) {
      phase = `install-${rowCount}`;
      process.stderr.write(`C18 first-open ${rowCount} rows, ABBA x${options.rounds}\n`);
      report.installResults.push(runInstallCase(ctx, rowCount));
      writeReport(options.out, report);
    }
    for (const rowCount of config.rowCounts) {
      phase = `storage-${rowCount}`;
      process.stderr.write(`C18 storage ${rowCount} rows\n`);
      report.storageResults.push(runStorageCase(ctx, rowCount));
      writeReport(options.out, report);
    }
    for (const rowCount of config.rowCounts) {
      phase = `write-${rowCount}`;
      process.stderr.write(`C18 record ${rowCount} rows, ABBA x${options.rounds}\n`);
      report.results.push(runWriteCase(ctx, rowCount));
      writeReport(options.out, report);
    }
    phase = 'sql-diagnostic';
    report.sqlDiagnostic = runSqlDiagnostic(ctx);

    phase = 'final-provenance';
    assert.deepEqual(roots.map(sourceFingerprint), source, 'source changed during capture');
    assert.deepEqual(toolFingerprint(roots), initialTools, 'ruler or SQL tracer changed during capture');
    assert.equal(report.installResults.length, config.installRowCounts.length);
    assert.equal(report.storageResults.length, config.rowCounts.length);
    assert.equal(report.results.length, config.rowCounts.length);
    assert.ok(report.installResults.every(result => result.completed));
    assert.ok(report.storageResults.every(result => result.completed));
    assert.ok(report.results.every(result => result.completed));
    report.environment.loadAfter = loadavg();
    report.timestamp = new Date().toISOString();
    report.completed = true;
    writeReport(options.out, report);
    console.log(options.out);
  } catch (error) {
    finishFailure(error);
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    cleanup();
  }
}

const isMain = process.argv[1]
  && realpathSync(SCRIPT_PATH) === realpathSync(resolve(process.argv[1]));
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
