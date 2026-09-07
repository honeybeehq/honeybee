#!/usr/bin/env node
// Bounded read-hotspot measurements over disposable CoreStore fixtures.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
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
import { bootIdentity } from './boot-identity.mjs';
import { distribution } from './report.mjs';
import { captureSql } from './sql-trace.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_800_000_000_000;
const FUTURE = FIXED_NOW + 86_400_000;
const WARMUPS = 3;
const RPC_RETENTION = 10_000;

const SCALE = Object.freeze({
  smoke: Object.freeze({
    commandHistories: [0, 10, 100],
    clearedFlags: 100,
    activeFlags: 4,
    bodyBytes: [32, 64 * 1024],
    fullMessages: 200,
    unrelatedMessages: 200,
    sparseMessages: 5,
    emptySupplies: [0, 3],
    pausedSupplies: [3],
    unrelatedAuditRows: 1_000,
    targetAuditRows: 20,
  }),
  canonical: Object.freeze({
    commandHistories: [0, 1_000, 100_000],
    clearedFlags: 100_000,
    activeFlags: 1_000,
    bodyBytes: [64, 1024 * 1024],
    fullMessages: 100_000,
    unrelatedMessages: 100_000,
    sparseMessages: 20,
    emptySupplies: [0, 100, 1_000],
    pausedSupplies: [100, 1_000],
    unrelatedAuditRows: 1_000_000,
    targetAuditRows: 20,
  }),
});

export function parseArgs(argv, defaults) {
  const parsed = {
    root: defaults.root,
    out: defaults.out,
    samples: 5,
    scale: 'smoke',
    cases: [],
    help: false,
    list: false,
  };
  const value = (name, index) => {
    const next = argv[index + 1];
    assert.ok(next && !next.startsWith('--'), `${name} requires a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') parsed.help = true;
    else if (arg === '--list') parsed.list = true;
    else if (arg === '--root') parsed.root = value(arg, i++);
    else if (arg === '--out') parsed.out = value(arg, i++);
    else if (arg === '--samples') parsed.samples = Number(value(arg, i++));
    else if (arg === '--scale') parsed.scale = value(arg, i++).toLowerCase();
    else if (arg === '--case') {
      parsed.cases.push(...value(arg, i++).split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
    } else {
      assert.fail(`unknown option: ${arg}`);
    }
  }
  assert.ok(Number.isSafeInteger(parsed.samples) && parsed.samples >= 3 && parsed.samples <= 1_000,
    'samples must be 3..1000');
  assert.ok(Object.hasOwn(SCALE, parsed.scale), 'scale must be smoke or canonical');
  parsed.cases = [...new Set(parsed.cases)];
  return parsed;
}

function scenario(inventoryId, kind, operation, fixture) {
  const suffix = Object.values(fixture).map(value => String(value)).join('-');
  return { id: `${inventoryId.toLowerCase()}-${kind}-${suffix}`, inventoryId, kind, operation, fixture };
}

export function buildScenarioPlan(scale, samples, warmups = WARMUPS) {
  assert.ok(Object.hasOwn(SCALE, scale), 'scale must be smoke or canonical');
  assert.ok(Number.isSafeInteger(samples) && samples >= 3, 'samples must be at least 3');
  const cfg = SCALE[scale];
  const plan = [];
  for (const settledCommands of cfg.commandHistories) {
    plan.push(scenario('D05', 'boot-recovery', 'DaemonCore.boot', {
      settledCommands,
      thenRevive: false,
    }));
  }
  for (const settledCommands of cfg.commandHistories) {
    plan.push(scenario('D05', 'pending-stop', 'DaemonCore.step', {
      settledCommands,
      futureQueuedStop: true,
    }));
  }
  plan.push(scenario('C07', 'flag-expiry', 'CoreStore.expireFlags', {
    clearedFlags: cfg.clearedFlags,
    activeFutureFlags: cfg.activeFlags,
  }));
  for (const bodyBytes of cfg.bodyBytes) {
    plan.push(scenario('C09', 'held-idle', 'DaemonCore.step', { bodyBytes }));
    plan.push(scenario('C09', 'stopped-pending', 'DaemonCore.step', { bodyBytes }));
    plan.push(scenario('C09', 'pending-page', 'CoreStore.pendingMail', { bodyBytes }));
  }
  plan.push(scenario('C10', 'full', 'CoreStore.listMessages', {
    totalMessages: cfg.fullMessages,
    targetMessages: cfg.fullMessages,
    unrelatedMessages: 0,
  }));
  plan.push(scenario('C10', 'sparse', 'CoreStore.listMessages', {
    totalMessages: cfg.unrelatedMessages + cfg.sparseMessages,
    targetMessages: cfg.sparseMessages,
    unrelatedMessages: cfg.unrelatedMessages,
  }));
  for (const supplies of cfg.emptySupplies) {
    plan.push(scenario('C22', 'enabled-empty', 'DaemonCore.step', { supplies }));
  }
  for (const supplies of cfg.pausedSupplies) {
    plan.push(scenario('C22', 'enabled-paused', 'DaemonCore.step', { supplies }));
  }
  plan.push(scenario('C25', 'audit-tail', 'CoreStore.auditTail', {
    unrelatedAuditRows: cfg.unrelatedAuditRows,
    targetAuditRows: cfg.targetAuditRows,
  }));
  const writeCalls = warmups + samples + 1;
  assert.ok(writeCalls < RPC_RETENTION, 'idempotency write workload exceeds retention window');
  plan.push(scenario('C18', 'rpc-hit', 'CoreStore.lookupRpcResult', {
    retainedRows: RPC_RETENTION,
  }));
  plan.push(scenario('C18', 'rpc-insert', 'CoreStore.recordRpcResult', {
    retentionRows: RPC_RETENTION,
    seedRows: RPC_RETENTION - writeCalls,
    distinctWrites: writeCalls,
  }));
  plan.push(scenario('C18', 'rpc-eviction', 'CoreStore.recordRpcResult', {
    retentionRows: RPC_RETENTION,
    seedRows: RPC_RETENTION,
    distinctWrites: writeCalls,
  }));
  return plan;
}

export function selectScenarios(plan, selectors) {
  if (selectors.length === 0) return plan;
  const matched = new Set();
  for (const selector of selectors) {
    const found = plan.filter(item =>
      item.id === selector ||
      item.inventoryId.toLowerCase() === selector ||
      item.kind === selector ||
      item.id.startsWith(`${selector}-`));
    assert.ok(found.length > 0, `unknown case: ${selector}`);
    for (const item of found) matched.add(item.id);
  }
  return plan.filter(item => matched.has(item.id));
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function fileDigest(path) {
  return sha256(readFileSync(path));
}

function sequenceDigest(values) {
  const hash = createHash('sha256');
  for (const value of values) hash.update(`${value}\n`);
  return hash.digest('hex');
}

function git(root, ...argv) {
  const run = spawnSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return run.stdout;
}

function sourceFingerprint(root) {
  const files = git(root, 'ls-files', '--cached', '--others', '--exclude-standard', 'v2')
    .trim()
    .split('\n')
    .filter(file => file.endsWith('.ts') && (file.includes('/src/') || file === 'v2/daemon/tests/helpers.ts'));
  return {
    revision: git(root, 'rev-parse', 'HEAD').trim(),
    hashes: Object.fromEntries(files.map(file => [file, fileDigest(join(root, file))])),
  };
}

function toolFingerprint() {
  const files = ['read-hotspots.mjs', 'sql-trace.mjs', 'report.mjs', 'boot-identity.mjs'];
  return Object.fromEntries(files.map(file => [file, fileDigest(join(scriptDir, file))]));
}

function writeReport(path, report) {
  mkdirSync(dirname(path), { recursive: true });
  const pending = `${path}.tmp-${process.pid}`;
  writeFileSync(pending, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(pending, path);
}

function errorEvidence(error, scenarioId = null) {
  return {
    scenario: scenarioId,
    name: error instanceof Error ? error.name : 'NonErrorThrown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
    at: new Date().toISOString(),
  };
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function withDatabase(path, options, fn) {
  const db = new DatabaseSync(path, options);
  try { return fn(db); }
  finally { db.close(); }
}

function seedOffline(path, fn) {
  return withDatabase(path, {}, db => {
    db.exec('PRAGMA synchronous = OFF');
    return transaction(db, () => fn(db));
  });
}

function inspectOffline(path, fn) {
  return withDatabase(path, { readOnly: true }, fn);
}

function createBee(store, dir, id, index = 0) {
  return store.createBee({
    id,
    name: id,
    handle: `PF.${String(index).padStart(6, '0')}`,
    agent: 'stub',
    substrate: 'hsr',
    cwd: dir,
  }).bee;
}

function makeCore(ctx, store, driver, policy = {}) {
  return new ctx.DaemonCore({
    store,
    driver,
    now: () => FIXED_NOW,
    policy: {
      bootHangTimeoutSteps: 60_000,
      commandsPerStep: 8,
      idleWindowSteps: null,
      i1DeadlineSteps: null,
      ...policy,
    },
    onI1Violation: () => assert.fail('read-hotspot fixture must not record I1 violations'),
    log: () => {},
  });
}

function assertNoDriverEffects(driver) {
  assert.deepEqual(driver.starts, []);
  assert.deepEqual(driver.deliveredIds, []);
  assert.deepEqual(driver.interrupts, []);
  assert.deepEqual(driver.events, []);
}

function seedSettledCommands(path, count, beeId = 'target') {
  if (count === 0) return;
  seedOffline(path, db => {
    const insert = db.prepare(
      `INSERT INTO commands(
         verb, bee_id, args, target_generation, status, attempts,
         next_attempt_at, enqueued_at, finished_at, failure_cause, idempotency_key
       ) VALUES('stop', ?, ?, 1, 'done', 1, 0, 0, 1, NULL, NULL)`,
    );
    const args = JSON.stringify({ thenRevive: false, reason: 'read-cost-fixture' });
    for (let i = 0; i < count; i += 1) insert.run(beeId, args);
  });
}

function commandEvidence(commands) {
  return {
    count: commands.length,
    firstId: commands[0]?.id ?? null,
    lastId: commands.at(-1)?.id ?? null,
    orderSha256: sequenceDigest(commands.map(command =>
      `${command.id}:${command.verb}:${command.status}:${command.targetGeneration}:${command.args.thenRevive === true}`)),
  };
}

function createBootRecoveryFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  createBee(store, dir, 'target');
  store.updateRuntimeState('target', 1, 'stopped', { exitCause: 'clean' });
  store.close();
  store = undefined;
  seedSettledCommands(path, spec.fixture.settledCommands);
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const beforeCommands = store.listCommands({ beeId: 'target' });
  assert.equal(beforeCommands.length, spec.fixture.settledCommands);
  assert.ok(beforeCommands.every(command =>
    command.status === 'done' && command.verb === 'stop' && command.args.thenRevive !== true));
  assert.equal(store.currentRuntime('target')?.state, 'stopped');
  const setup = commandEvidence(beforeCommands);
  const driver = new ctx.FakeDriver(() => FIXED_NOW);
  driver.autoBoot = false;
  const core = makeCore(ctx, store, driver);
  const baseSeq = store.lastAuditSeq();
  return {
    setup: { ...setup, runtimeState: 'stopped', driverLiveProcesses: 0 },
    operation: () => core.boot(),
    check: value => assert.deepEqual(value, {
      adopted: 0,
      stoppedByReconcile: 0,
      requeuedCommands: 0,
      orphansReaped: 0,
      wakesEnqueued: 0,
    }),
    finish: ({ calls }) => {
      const added = store.auditRows(baseSeq);
      assert.equal(added.length, calls);
      assert.ok(added.every(row => row.kind === 'boot.reconciled'));
      const after = store.listCommands({ beeId: 'target' });
      assert.deepEqual(commandEvidence(after), setup);
      assert.equal(store.currentRuntime('target')?.state, 'stopped');
      assertNoDriverEffects(driver);
      return {
        exactSettledHistoryRetained: true,
        thenReviveMatched: false,
        bootAuditRows: added.length,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function createPendingStopFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW - 120_000 });
  createBee(store, dir, 'target');
  store.close();
  store = undefined;
  seedSettledCommands(path, spec.fixture.settledCommands);
  const pendingId = seedOffline(path, db => Number(db.prepare(
    `INSERT INTO commands(
       verb, bee_id, args, target_generation, status, attempts,
       next_attempt_at, enqueued_at, finished_at, failure_cause, idempotency_key
     ) VALUES('stop', 'target', ?, 1, 'queued', 0, ?, ?, NULL, NULL, NULL)`,
  ).run(JSON.stringify({ cause: 'stopped_by_system', reason: 'hang_policy' }), FUTURE, FIXED_NOW).lastInsertRowid));
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const commands = store.listCommands({ beeId: 'target' });
  assert.equal(commands.length, spec.fixture.settledCommands + 1);
  assert.ok(commands.slice(0, -1).every(command => command.status === 'done'));
  assert.deepEqual(commands.at(-1), store.getCommand(pendingId));
  assert.equal(commands.at(-1)?.status, 'queued');
  assert.equal(commands.at(-1)?.nextAttemptAt, FUTURE);
  assert.equal(store.currentRuntime('target')?.state, 'booting');
  const setup = commandEvidence(commands);
  const driver = new ctx.FakeDriver(() => FIXED_NOW);
  driver.autoBoot = false;
  const core = makeCore(ctx, store, driver, { bootHangTimeoutSteps: 60_000 });
  const baseSeq = store.lastAuditSeq();
  return {
    setup: { ...setup, pendingStopId: pendingId, pendingStopNotBefore: FUTURE, runtimeState: 'booting' },
    operation: () => core.step(),
    check: value => assert.equal(value, undefined),
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'repeated pending-stop probes must be authority no-ops');
      assert.deepEqual(commandEvidence(store.listCommands({ beeId: 'target' })), setup);
      assert.equal(store.getCommand(pendingId)?.status, 'queued');
      assert.equal(store.currentRuntime('target')?.state, 'booting');
      assertNoDriverEffects(driver);
      return {
        steps: calls,
        quietAuthority: true,
        futureStopRetained: true,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function createFlagExpiryFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const activeBeeIds = [];
  for (let i = 0; i < spec.fixture.activeFutureFlags; i += 1) {
    const beeId = `flag-${String(i).padStart(6, '0')}`;
    activeBeeIds.push(beeId);
    createBee(store, dir, beeId, i);
    store.updateRuntimeState(beeId, 1, 'stopped', { exitCause: 'clean' });
    store.setFlag(beeId, 'resource_blocked', 'future provider reset', { resetsAt: FUTURE });
  }
  store.close();
  store = undefined;
  seedOffline(path, db => {
    const insert = db.prepare(
      `INSERT INTO flags(bee_id, flag, detail, set_at, cleared_at, resets_at)
       VALUES(?, 'resource_blocked', 'cleared read-cost fixture', ?, ?, ?)`,
    );
    const beeId = activeBeeIds[0];
    assert.ok(beeId);
    for (let i = 0; i < spec.fixture.clearedFlags; i += 1) {
      insert.run(beeId, FIXED_NOW - 20_000 - i, FIXED_NOW - 10_000 - i, FIXED_NOW - 15_000 - i);
    }
  });
  const offline = inspectOffline(path, db => ({
    total: Number(db.prepare('SELECT COUNT(*) AS n FROM flags').get().n),
    active: Number(db.prepare('SELECT COUNT(*) AS n FROM flags WHERE cleared_at IS NULL').get().n),
    cleared: Number(db.prepare('SELECT COUNT(*) AS n FROM flags WHERE cleared_at IS NOT NULL').get().n),
    due: Number(db.prepare(
      'SELECT COUNT(*) AS n FROM flags WHERE cleared_at IS NULL AND resets_at IS NOT NULL AND resets_at <= ?',
    ).get(FIXED_NOW).n),
  }));
  assert.deepEqual(offline, {
    total: spec.fixture.clearedFlags + spec.fixture.activeFutureFlags,
    active: spec.fixture.activeFutureFlags,
    cleared: spec.fixture.clearedFlags,
    due: 0,
  });
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  assert.ok(activeBeeIds.every(beeId => {
    const flags = store.activeFlags(beeId);
    return flags.length === 1 && flags[0].resetsAt === FUTURE;
  }));
  const baseSeq = store.lastAuditSeq();
  return {
    setup: { ...offline, activeOrderSha256: sequenceDigest(activeBeeIds), futureResetAt: FUTURE },
    operation: () => store.expireFlags(FIXED_NOW),
    check: value => assert.deepEqual(value, []),
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'nothing-due expiry must not change authority');
      const active = activeBeeIds.flatMap(beeId => store.activeFlags(beeId));
      assert.equal(active.length, spec.fixture.activeFutureFlags);
      assert.ok(active.every(flag => flag.clearedAt === null && flag.resetsAt === FUTURE));
      return {
        calls,
        quietAuthority: true,
        futureFlagsRetained: active.length,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function prepareMailFixture(ctx, spec, state, operationKind) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  createBee(store, dir, 'target');
  if (state === 'running') {
    store.updateRuntimeState('target', 1, 'running', { pid: 101, pidStartedAt: FIXED_NOW - 1_000 });
  } else {
    store.updateRuntimeState('target', 1, 'stopped', { exitCause: 'clean' });
  }
  const body = 'm'.repeat(spec.fixture.bodyBytes);
  const sent = store.send('target', body, { urgency: state === 'running' ? 'idle' : 'next' });
  let wakeId = sent.wakeCommand?.id ?? null;
  if (state === 'stopped') {
    assert.ok(wakeId !== null, 'stopped target must retain legitimate wake intent');
    store.close();
    store = undefined;
    seedOffline(path, db => {
      const changed = db.prepare(
        "UPDATE commands SET next_attempt_at = ? WHERE id = ? AND verb = 'send_wake' AND status = 'queued'",
      ).run(FUTURE, wakeId);
      assert.equal(Number(changed.changes), 1);
    });
    store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  } else {
    assert.equal(wakeId, null);
  }
  const pending = store.listUndeliveredMessages();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, sent.message.id);
  assert.equal(Buffer.byteLength(pending[0].body), spec.fixture.bodyBytes);
  assert.equal(store.currentRuntime('target')?.state, state);
  if (wakeId !== null) {
    const wake = store.getCommand(wakeId);
    assert.equal(wake?.status, 'queued');
    assert.equal(wake?.nextAttemptAt, FUTURE);
  }
  const driver = new ctx.FakeDriver(() => FIXED_NOW);
  driver.autoBoot = false;
  const core = makeCore(ctx, store, driver);
  const baseSeq = store.lastAuditSeq();
  const pendingPage = () => store.pendingMail('target', { limit: 1 });
  const checkPage = value => {
    assert.equal(value.messages.length, 1);
    assert.equal(value.messages[0].id, sent.message.id);
    assert.equal(value.hasMore, false);
    assert.ok(Buffer.byteLength(value.messages[0].body) <= 16 * 1024);
    assert.equal(value.messages[0].bodyTruncated, spec.fixture.bodyBytes > 16 * 1024);
  };
  return {
    setup: {
      runtimeState: state,
      messageId: sent.message.id,
      messageBodyBytes: spec.fixture.bodyBytes,
      urgency: sent.message.urgency,
      wakeId,
      wakeNotBefore: wakeId === null ? null : FUTURE,
      pendingProjectionBodyBytes: Buffer.byteLength(pendingPage().messages[0].body),
    },
    operation: operationKind === 'pending-page' ? pendingPage : () => core.step(),
    check: operationKind === 'pending-page' ? checkPage : value => assert.equal(value, undefined),
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'held mail reads/steps must not change authority');
      const after = store.listUndeliveredMessages();
      assert.equal(after.length, 1);
      assert.equal(after[0].id, sent.message.id);
      assert.equal(Buffer.byteLength(after[0].body), spec.fixture.bodyBytes);
      if (wakeId !== null) {
        assert.equal(store.getCommand(wakeId)?.status, 'queued');
        assert.equal(store.getCommand(wakeId)?.nextAttemptAt, FUTURE);
      }
      assertNoDriverEffects(driver);
      return {
        calls,
        quietAuthority: true,
        messageStillPending: true,
        wakeIntentDelayedButRetained: wakeId !== null,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function createHeldIdleFixture(ctx, spec) {
  return prepareMailFixture(ctx, spec, 'running', 'step');
}

function createStoppedPendingFixture(ctx, spec) {
  return prepareMailFixture(ctx, spec, 'stopped', 'step');
}

function createPendingPageFixture(ctx, spec) {
  return prepareMailFixture(ctx, spec, 'stopped', 'pending-page');
}

function seedDeliveredMailbox(path, targetMessages, unrelatedMessages, bodyBytes) {
  const targetIds = [];
  seedOffline(path, db => {
    const insert = db.prepare(
      `INSERT INTO mailbox(
         bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation
       ) VALUES(?, 'fixture', ?, 0, 'next', ?, ?, 1)`,
    );
    const body = 'b'.repeat(bodyBytes);
    if (unrelatedMessages === 0) {
      for (let i = 0; i < targetMessages; i += 1) {
        targetIds.push(Number(insert.run('target', body, i, i + 1).lastInsertRowid));
      }
      return;
    }
    let targets = 0;
    for (let i = 0; i < unrelatedMessages; i += 1) {
      insert.run('unrelated', body, i, i + 1);
      const wanted = Math.floor(((i + 1) * targetMessages) / unrelatedMessages);
      while (targets < wanted) {
        targetIds.push(Number(insert.run('target', body, i, i + 1).lastInsertRowid));
        targets += 1;
      }
    }
    while (targets < targetMessages) {
      targetIds.push(Number(insert.run('target', body, unrelatedMessages, unrelatedMessages + 1).lastInsertRowid));
      targets += 1;
    }
  });
  return targetIds;
}

function createMailboxHistoryFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  createBee(store, dir, 'target', 0);
  store.updateRuntimeState('target', 1, 'stopped', { exitCause: 'clean' });
  createBee(store, dir, 'unrelated', 1);
  store.updateRuntimeState('unrelated', 1, 'stopped', { exitCause: 'clean' });
  store.close();
  store = undefined;
  const targetIds = seedDeliveredMailbox(
    path,
    spec.fixture.targetMessages,
    spec.fixture.unrelatedMessages,
    128,
  );
  const offline = inspectOffline(path, db => ({
    total: Number(db.prepare('SELECT COUNT(*) AS n FROM mailbox').get().n),
    target: Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id = 'target'").get().n),
    unrelated: Number(db.prepare("SELECT COUNT(*) AS n FROM mailbox WHERE bee_id = 'unrelated'").get().n),
    undelivered: Number(db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE delivered_at IS NULL').get().n),
  }));
  assert.deepEqual(offline, {
    total: spec.fixture.totalMessages,
    target: spec.fixture.targetMessages,
    unrelated: spec.fixture.unrelatedMessages,
    undelivered: 0,
  });
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const expectedDigest = sequenceDigest(targetIds);
  const validateRows = rows => {
    assert.equal(rows.length, targetIds.length);
    assert.equal(rows[0]?.id ?? null, targetIds[0] ?? null);
    assert.equal(rows.at(-1)?.id ?? null, targetIds.at(-1) ?? null);
  };
  const initial = store.listMessages('target');
  validateRows(initial);
  assert.equal(sequenceDigest(initial.map(row => row.id)), expectedDigest);
  assert.ok(initial.every(row => row.deliveredAt !== null && row.deliveredGeneration === 1));
  const baseSeq = store.lastAuditSeq();
  return {
    setup: {
      ...offline,
      targetFirstId: targetIds[0] ?? null,
      targetLastId: targetIds.at(-1) ?? null,
      targetOrderSha256: expectedDigest,
      bodyBytesPerRow: 128,
    },
    operation: () => store.listMessages('target'),
    check: validateRows,
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'mailbox history reads must not change authority');
      const after = store.listMessages('target');
      validateRows(after);
      assert.equal(sequenceDigest(after.map(row => row.id)), expectedDigest);
      return {
        calls,
        quietAuthority: true,
        exactTargetOrderRetained: true,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function createTaskSupplyFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const paused = spec.kind === 'enabled-paused';
  for (let i = 0; i < spec.fixture.supplies; i += 1) {
    const beeId = `supply-${String(i).padStart(6, '0')}`;
    createBee(store, dir, beeId, i);
    store.updateRuntimeState(beeId, 1, 'running', {
      pid: 10_000 + i,
      pidStartedAt: FIXED_NOW - 1_000,
    });
    store.setTaskSupply(beeId, { on: true, limit: paused ? 1 : 5 });
    if (paused) {
      store.addTask({
        list: ctx.beeTaskList(beeId),
        title: `fixture task ${i}`,
        originKind: 'user',
        originSender: 'operator',
      });
      const fed = store.tryFeedTaskSupply(beeId);
      assert.ok(fed);
      assert.equal(fed.supply.paused, true);
    }
  }
  store.close();
  store = undefined;
  const offline = inspectOffline(path, db => ({
    supplies: Number(db.prepare('SELECT COUNT(*) AS n FROM task_supply WHERE enabled = 1').get().n),
    paused: Number(db.prepare('SELECT COUNT(*) AS n FROM task_supply WHERE enabled = 1 AND paused = 1').get().n),
    tasks: Number(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n),
    pendingMessages: Number(db.prepare('SELECT COUNT(*) AS n FROM mailbox WHERE delivered_at IS NULL').get().n),
    runningRuntimes: Number(db.prepare("SELECT COUNT(*) AS n FROM runtimes WHERE state = 'running'").get().n),
  }));
  assert.deepEqual(offline, {
    supplies: spec.fixture.supplies,
    paused: paused ? spec.fixture.supplies : 0,
    tasks: paused ? spec.fixture.supplies : 0,
    pendingMessages: paused ? spec.fixture.supplies : 0,
    runningRuntimes: spec.fixture.supplies,
  });
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const supplies = store.listTaskSupply({ on: true });
  assert.equal(supplies.length, spec.fixture.supplies);
  assert.ok(supplies.every(row => row.on && row.paused === paused));
  const driver = new ctx.FakeDriver(() => FIXED_NOW);
  driver.autoBoot = false;
  const core = makeCore(ctx, store, driver);
  const baseSeq = store.lastAuditSeq();
  return {
    setup: { ...offline, supplyOrderSha256: sequenceDigest(supplies.map(row => row.beeId)) },
    operation: () => core.step(),
    check: value => assert.equal(value, undefined),
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'inactive task supplies must not change authority');
      const after = store.listTaskSupply({ on: true });
      assert.equal(after.length, spec.fixture.supplies);
      assert.ok(after.every(row => row.on && row.paused === paused));
      assertNoDriverEffects(driver);
      return {
        calls,
        quietAuthority: true,
        suppliesRetained: after.length,
        pausedSuppliesRetained: after.filter(row => row.paused).length,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function seedSparseAudit(path, unrelatedRows, targetRows) {
  const targetSeqs = [];
  seedOffline(path, db => {
    const insert = db.prepare(
      "INSERT INTO audit(ts, kind, bee_id, payload) VALUES(?, 'output.recorded', ?, ?)",
    );
    let targets = 0;
    for (let i = 0; i < unrelatedRows; i += 1) {
      insert.run(i, 'unrelated', JSON.stringify({ fixture: true, row: i }));
      const wanted = Math.floor(((i + 1) * targetRows) / unrelatedRows);
      while (targets < wanted) {
        targetSeqs.push(Number(insert.run(i, 'target', JSON.stringify({ fixture: true, target: targets })).lastInsertRowid));
        targets += 1;
      }
    }
    while (targets < targetRows) {
      targetSeqs.push(Number(insert.run(unrelatedRows, 'target', JSON.stringify({ fixture: true, target: targets })).lastInsertRowid));
      targets += 1;
    }
  });
  return targetSeqs;
}

function createAuditTailFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  createBee(store, dir, 'target', 0);
  store.updateRuntimeState('target', 1, 'stopped', { exitCause: 'clean' });
  createBee(store, dir, 'unrelated', 1);
  store.updateRuntimeState('unrelated', 1, 'stopped', { exitCause: 'clean' });
  store.close();
  store = undefined;
  const baselineRows = inspectOffline(path, db => Number(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n));
  const targetSeqs = seedSparseAudit(
    path,
    spec.fixture.unrelatedAuditRows,
    spec.fixture.targetAuditRows,
  );
  const offline = inspectOffline(path, db => ({
    total: Number(db.prepare('SELECT COUNT(*) AS n FROM audit').get().n),
    target: Number(db.prepare("SELECT COUNT(*) AS n FROM audit WHERE bee_id = 'target'").get().n),
    fixtureTarget: Number(db.prepare(
      "SELECT COUNT(*) AS n FROM audit WHERE bee_id = 'target' AND json_extract(payload, '$.fixture') = 1",
    ).get().n),
  }));
  assert.equal(offline.total, baselineRows + spec.fixture.unrelatedAuditRows + spec.fixture.targetAuditRows);
  assert.equal(offline.fixtureTarget, spec.fixture.targetAuditRows);
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const validate = rows => {
    assert.deepEqual(rows.map(row => row.seq), targetSeqs);
    assert.ok(rows.every(row => row.beeId === 'target' && row.kind === 'output.recorded'));
  };
  validate(store.auditTail(0, spec.fixture.targetAuditRows, 'target'));
  const baseSeq = store.lastAuditSeq();
  return {
    setup: {
      baselineAuditRows: baselineRows,
      totalAuditRows: offline.total,
      targetAuditRowsIncludingSetup: offline.target,
      fixtureTargetAuditRows: offline.fixtureTarget,
      targetFirstSeq: targetSeqs[0] ?? null,
      targetLastSeq: targetSeqs.at(-1) ?? null,
      targetOrderSha256: sequenceDigest(targetSeqs),
    },
    operation: () => store.auditTail(0, spec.fixture.targetAuditRows, 'target'),
    check: validate,
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'audit tail reads must not change authority');
      validate(store.auditTail(0, spec.fixture.targetAuditRows, 'target'));
      return {
        calls,
        quietAuthority: true,
        exactSparseTailRetained: true,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: store.lastAuditSeq(),
      };
    },
    cleanup: () => store?.close(),
  };
}

function seedRpcRows(path, count) {
  seedOffline(path, db => {
    const insert = db.prepare(
      'INSERT INTO rpc_idempotency(key, verb, command_id, result, created_at) VALUES(?, ?, NULL, ?, ?)',
    );
    for (let i = 0; i < count; i += 1) {
      insert.run(`seed-${String(i).padStart(6, '0')}`, 'fixture', JSON.stringify({ seed: i }), i);
    }
  });
}

function createRpcFixture(ctx, spec) {
  const dir = join(ctx.runDir, spec.id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'core.sqlite3');
  let store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  store.close();
  store = undefined;
  seedRpcRows(path, spec.fixture.seedRows ?? spec.fixture.retainedRows);
  const initialRows = spec.fixture.seedRows ?? spec.fixture.retainedRows;
  assert.equal(inspectOffline(path, db => Number(db.prepare('SELECT COUNT(*) AS n FROM rpc_idempotency').get().n)), initialRows);
  store = ctx.openCoreStore(path, { now: () => FIXED_NOW });
  const writtenKeys = [];
  const hitKey = `seed-${String(Math.max(0, initialRows - 1)).padStart(6, '0')}`;
  const baseSeq = store.lastAuditSeq();
  const operation = call => {
    if (spec.kind === 'rpc-hit') return store.lookupRpcResult(hitKey);
    const key = `write-${call.phase}-${String(call.index).padStart(6, '0')}`;
    assert.equal(writtenKeys.includes(key), false, `duplicate fixture key: ${key}`);
    writtenKeys.push(key);
    store.recordRpcResult(key, 'fixture', null, { key, ordinal: call.ordinal });
    return key;
  };
  const check = value => {
    if (spec.kind === 'rpc-hit') {
      assert.equal(value?.key, hitKey);
      assert.deepEqual(value?.result, { seed: initialRows - 1 });
    } else {
      assert.equal(store.lookupRpcResult(value)?.result.key, value);
    }
  };
  return {
    setup: { initialRows, hitKey: spec.kind === 'rpc-hit' ? hitKey : null, retentionRows: RPC_RETENTION },
    operation,
    check,
    finish: ({ calls }) => {
      assert.equal(store.lastAuditSeq(), baseSeq, 'RPC idempotency infrastructure must not change audit authority');
      if (spec.kind === 'rpc-hit') {
        assert.equal(writtenKeys.length, 0);
        assert.equal(calls, ctx.warmups + ctx.samples + 1);
      } else {
        assert.equal(writtenKeys.length, spec.fixture.distinctWrites);
        assert.equal(new Set(writtenKeys).size, writtenKeys.length);
        assert.ok(writtenKeys.every(key => store.lookupRpcResult(key)?.result.key === key));
      }
      store.close();
      store = undefined;
      const rows = inspectOffline(path, db => ({
        count: Number(db.prepare('SELECT COUNT(*) AS n FROM rpc_idempotency').get().n),
        seedRows: Number(db.prepare("SELECT COUNT(*) AS n FROM rpc_idempotency WHERE key LIKE 'seed-%'").get().n),
        firstSeedPresent: Boolean(db.prepare("SELECT 1 FROM rpc_idempotency WHERE key = 'seed-000000'").get()),
        nextSeedPresent: Boolean(db.prepare(
          'SELECT 1 FROM rpc_idempotency WHERE key = ?',
        ).get(`seed-${String(writtenKeys.length).padStart(6, '0')}`)),
        newRows: Number(db.prepare("SELECT COUNT(*) AS n FROM rpc_idempotency WHERE key LIKE 'write-%'").get().n),
      }));
      if (spec.kind === 'rpc-hit') {
        assert.deepEqual(rows, {
          count: RPC_RETENTION,
          seedRows: RPC_RETENTION,
          firstSeedPresent: true,
          nextSeedPresent: true,
          newRows: 0,
        });
      } else if (spec.kind === 'rpc-insert') {
        assert.deepEqual(rows, {
          count: RPC_RETENTION,
          seedRows: initialRows,
          firstSeedPresent: true,
          nextSeedPresent: true,
          newRows: writtenKeys.length,
        });
      } else {
        assert.deepEqual(rows, {
          count: RPC_RETENTION,
          seedRows: RPC_RETENTION - writtenKeys.length,
          firstSeedPresent: false,
          nextSeedPresent: true,
          newRows: writtenKeys.length,
        });
      }
      return {
        calls,
        quietAuthority: true,
        distinctKeysWritten: writtenKeys.length,
        retainedRows: rows.count,
        firstSeedPresent: rows.firstSeedPresent,
        nextUnevictedSeedPresent: rows.nextSeedPresent,
        allNewKeysRetained: rows.newRows === writtenKeys.length,
        authoritySeqBefore: baseSeq,
        authoritySeqAfter: baseSeq,
      };
    },
    cleanup: () => store?.close(),
  };
}

const WORKLOAD_FACTORIES = Object.freeze({
  'boot-recovery': createBootRecoveryFixture,
  'pending-stop': createPendingStopFixture,
  'flag-expiry': createFlagExpiryFixture,
  'held-idle': createHeldIdleFixture,
  'stopped-pending': createStoppedPendingFixture,
  'pending-page': createPendingPageFixture,
  full: createMailboxHistoryFixture,
  sparse: createMailboxHistoryFixture,
  'enabled-empty': createTaskSupplyFixture,
  'enabled-paused': createTaskSupplyFixture,
  'audit-tail': createAuditTailFixture,
  'rpc-hit': createRpcFixture,
  'rpc-insert': createRpcFixture,
  'rpc-eviction': createRpcFixture,
});

function callFixture(fixture, call) {
  const value = fixture.operation(call);
  assert.ok(!value || typeof value.then !== 'function', 'read-hotspot operations must be synchronous');
  fixture.check(value, call);
  return value;
}

function runScenario(ctx, spec, result) {
  const factory = WORKLOAD_FACTORIES[spec.kind];
  assert.ok(factory, `no workload factory for ${spec.kind}`);
  let fixture;
  let ordinal = 0;
  try {
    fixture = factory(ctx, spec);
    result.setup = fixture.setup;
    for (let i = 0; i < ctx.warmups; i += 1) {
      callFixture(fixture, { phase: 'warmup', index: i, ordinal: ordinal++ });
    }
    if (typeof global.gc === 'function') global.gc();
    const raw = result.raw;
    result.measurement = { startedAt: new Date().toISOString(), finishedAt: null };
    for (let i = 0; i < ctx.samples; i += 1) {
      const cpu = process.cpuUsage();
      const start = performance.now();
      const value = fixture.operation({ phase: 'sample', index: i, ordinal: ordinal++ });
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      raw.wallMs.push(wallMs);
      raw.cpuMs.push((used.user + used.system) / 1_000);
      assert.ok(!value || typeof value.then !== 'function', 'read-hotspot operations must be synchronous');
      fixture.check(value, { phase: 'sample', index: i, ordinal: ordinal - 1 });
    }
    result.measurement.finishedAt = new Date().toISOString();
    result.metrics = {
      'operation.wall': { unit: 'ms', ...distribution(raw.wallMs) },
      'operation.cpu': { unit: 'ms', ...distribution(raw.cpuMs) },
    };
    const diagnostic = captureSql(() => fixture.operation({ phase: 'diagnostic', index: 0, ordinal: ordinal++ }));
    fixture.check(diagnostic.value, { phase: 'diagnostic', index: 0, ordinal: ordinal - 1 });
    result.sqlDiagnostic = {
      instrumented: true,
      timingUse: 'diagnostic-only; excluded from raw samples and speed comparisons',
      statements: diagnostic.statements,
    };
    result.correctness = fixture.finish({ calls: ordinal });
    result.completed = true;
  } catch (error) {
    result.failure = errorEvidence(error, spec.id);
    throw error;
  } finally {
    fixture?.cleanup();
  }
}

function helpText() {
  return [
    'node scripts/perf/read-hotspots.mjs [--root checkout] [--out report.json] [--samples 5]',
    '  [--scale smoke|canonical] [--case D05|c09-held-idle|exact-case-id] [--list]',
    '',
    'Repeat --case or pass a comma-separated list. The default smoke scale runs every semantic shape',
    'with small fixtures. Use --list with a scale to print its exact case IDs and fixture sizes.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const defaults = {
    root: resolve(scriptDir, '../..'),
    out: resolve(scriptDir, '../../.artifacts/performance/read-hotspots.json'),
  };
  const options = parseArgs(argv, defaults);
  options.root = resolve(options.root);
  options.out = resolve(options.out);
  const fullPlan = buildScenarioPlan(options.scale, options.samples, WARMUPS);
  const plan = selectScenarios(fullPlan, options.cases);
  if (options.help) {
    console.log(helpText());
    return;
  }
  if (options.list) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  const initialFingerprint = sourceFingerprint(options.root);
  const initialToolHashes = toolFingerprint();
  const source = {
    root: options.root,
    ...initialFingerprint,
    status: git(options.root, 'status', '--porcelain'),
    diffSha256: sha256(git(options.root, 'diff', '--binary', 'HEAD')),
  };
  const report = {
    schemaVersion: 1,
    completed: false,
    startedAt,
    timestamp: null,
    measurement: { startedAt: null, finishedAt: null },
    source,
    toolHashes: initialToolHashes,
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      osVersion: osVersion(),
      arch: arch(),
      hostname: hostname(),
      bootIdentity: bootIdentity(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      execArgv: process.execArgv,
      nodeCompileCache: process.env.NODE_COMPILE_CACHE ?? null,
      nodeOptionsSha256: sha256(process.env.NODE_OPTIONS ?? ''),
      loadBefore: loadavg(),
      loadAfter: null,
    },
    workload: {
      scale: options.scale,
      samples: options.samples,
      warmups: WARMUPS,
      scenarios: plan,
      timingInstrumentation: 'none',
      diagnosticInstrumentation: 'one separate post-timing captureSql call per case',
      durability: 'CoreStore production defaults: WAL/NORMAL during every timed operation',
      fixtureSeed: 'offline SQLite with synchronous=OFF while CoreStore is closed',
      fixedNow: FIXED_NOW,
    },
    results: [],
    failure: null,
    scope: [
      'Real CoreStore reads and real DaemonCore loops use FakeDriver over fresh owned temporary stores.',
      'No provider, process driver, live daemon, installed runtime, or live store is accessed.',
      'Synthetic command, flag, delivered-mail, audit, and RPC histories are inserted only while CoreStore is closed. They are read-cost fixtures, not durable enqueue, delivery, or audit-replay evidence.',
      'Fixture setup, warmups, semantic checks, cleanup, and SQL diagnostics are outside uninstrumented CPU/wall samples.',
      'SQL diagnostic timings include observer overhead and are attribution evidence only.',
    ].join(' '),
  };
  writeReport(options.out, report);

  const runDir = mkdtempSync(join(tmpdir(), 'hb-read-hotspots-'));
  let activeScenario = null;
  let cleaning = false;
  const cleanup = () => {
    if (cleaning) return;
    cleaning = true;
    rmSync(runDir, { recursive: true, force: true });
  };
  const signal = name => {
    if (!report.failure) report.failure = errorEvidence(new Error(`interrupted by ${name}`), activeScenario);
    report.timestamp = new Date().toISOString();
    report.environment.loadAfter = loadavg();
    try { writeReport(options.out, report); } finally { cleanup(); }
    process.exit(name === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => signal('SIGINT');
  const onSigterm = () => signal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    const local = file => import(pathToFileURL(join(options.root, file)).href);
    const [{ openCoreStore, beeTaskList }, { DaemonCore }, { FakeDriver }] = await Promise.all([
      local('v2/core/src/index.ts'),
      local('v2/daemon/src/loops.ts'),
      local('v2/daemon/tests/helpers.ts'),
    ]);
    const ctx = {
      root: options.root,
      runDir,
      samples: options.samples,
      warmups: WARMUPS,
      openCoreStore,
      beeTaskList,
      DaemonCore,
      FakeDriver,
    };
    for (const spec of plan) {
      activeScenario = spec.id;
      process.stderr.write(`Measuring ${spec.id}\n`);
      const result = {
        scenario: spec.id,
        inventoryId: spec.inventoryId,
        operation: spec.operation,
        fixture: spec.fixture,
        completed: false,
        measurement: null,
        setup: null,
        raw: { wallMs: [], cpuMs: [] },
        metrics: null,
        sqlDiagnostic: null,
        correctness: null,
        failure: null,
      };
      report.results.push(result);
      report.measurement.startedAt ??= new Date().toISOString();
      runScenario(ctx, spec, result);
      writeReport(options.out, report);
    }
    activeScenario = null;
    report.measurement.finishedAt = new Date().toISOString();
    assert.equal(report.results.length, plan.length, 'incomplete result set');
    assert.ok(report.results.every(result => result.completed), 'incomplete scenario');
    assert.deepEqual(sourceFingerprint(options.root), initialFingerprint, 'source changed during capture');
    assert.deepEqual(toolFingerprint(), initialToolHashes, 'measurement tool changed during capture');
    report.environment.loadAfter = loadavg();
    report.timestamp = new Date().toISOString();
    report.completed = true;
    writeReport(options.out, report);
    console.log(options.out);
  } catch (error) {
    report.failure ??= errorEvidence(error, activeScenario);
    report.environment.loadAfter = loadavg();
    report.timestamp = new Date().toISOString();
    writeReport(options.out, report);
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    cleanup();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}
