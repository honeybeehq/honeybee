#!/usr/bin/env node
/**
 * Disposable dedup-sweep ruler: 1576571c (alive-set sweep) vs dfecaeba
 * (tracked-candidate sweep) — refinement-specific cost and allocation.
 *
 * - Sources: `git archive <sha> v2` via execFileSync buffers (no shell
 *   interpolation) extracted to two /tmp side dirs. Every extracted v2
 *   src/helpers .ts is hashed per side; when the refs differ the cross-side
 *   delta must be EXACTLY v2/daemon/src/loops.ts, and an A/A run (same ref
 *   twice) must show zero delta while still importing DISTINCT module
 *   instances (recorded via moduleIdentityShared). Tool + source + tree
 *   hashes re-verified at the end of the run.
 * - Fixtures: seeded once per scenario (sends inside one store.transact),
 *   then RE-COPIED pristine from the template before EVERY cycle and
 *   sha-verified — probe-growth writes audit/state, so shared copies would
 *   drift across cycles.
 * - Scenario wide-cadence (I1 on): pending future messages + ONE tracked
 *   overdue id on a stopped bee. The pre-measure violation tick primes
 *   sweepTicks to 1, so the cadence sweep lands at measured index 254 —
 *   the ruler computes, records, and VERIFIES the actual sweep index from
 *   the private counter (diagnostic read only) instead of assuming last.
 * - Scenario probe-cadence (I1 off): grow-pairs (turn_started fold +
 *   interrupt, then idle fold + refused delivery) grow interruptRequested
 *   one id per two ticks; the tick-255 CADENCE sweep membership-probes 128
 *   tracked ids. Honest name: 128 ids cannot reach the 1024 growth trigger;
 *   the growth trigger runs the same sweep body and is functionally proven
 *   by repo test z01.e — this ruler measures sweep cost, not the trigger.
 * - mode none: whole core.step() wall/CPU per tick, uninstrumented; EVERY
 *   raw sample retained; sweep-tick samples split from quiet ticks by the
 *   verified sweep index.
 * - mode profile: V8 heap sampling around TICK EXECUTION ONLY (store open,
 *   hydration, and end assertions sit outside the sampled window); the
 *   report keeps sidecar hashes plus top allocation records WITH their full
 *   frame ancestry so prune attribution is readable.
 * - Exact assertions per cycle: violations, audit head (quiet for wide;
 *   exact fold delta for probe — the audit writers are FakeDriver.interrupt's
 *   synthesized turn_ended fold [runtime.updated + output.recorded] and the
 *   idle→running fold [runtime.updated] on every pair after the first),
 *   pending counts, driver effects, dedup cardinalities via Reflect
 *   (private diagnostic; pruning behavior itself is never monkeypatched),
 *   sweep-counter end state, and the rowid-membership EXPLAIN of the exact
 *   undeliveredMessageIdsAmong statement at 1 and 512 bound ids.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { cpus, hostname, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
function option(name, fallback) {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  assert.ok(value !== undefined && !String(value).startsWith('--'), `${name} requires a value`);
  return value;
}
const repo = resolve(option('--repo', ''));
const out = resolve(option('--out', ''));
const beforeRef = option('--before', '1576571c');
const afterRef = option('--after', 'dfecaeba');
const pending = Number(option('--pending', '20000'));
const rounds = Number(option('--rounds', '2'));
const mode = option('--mode', 'none');
assert.ok(repo && out, 'usage: honeybee-dedup-sweep-ruler.mjs --repo <worktree> --out report.json [--before ref] [--after ref] [--pending N] [--rounds R] [--mode none|profile]');
assert.ok(Number.isSafeInteger(pending) && pending >= 20 && pending <= 200_000, 'pending must be 20..200000');
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 10, 'rounds must be 1..10');
assert.ok(['none', 'profile'].includes(mode), 'mode must be none or profile');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const selfPath = fileURLToPath(import.meta.url);
const selfSha = () => sha256(readFileSync(selfPath));
const CADENCE = 256;
const root = mkdtempSync(join(tmpdir(), 'hb-dedup-ruler-'));
const startedAt = new Date().toISOString();
const loadBefore = loadavg();

function bootIdentity() {
  try {
    const uuid = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).trim();
    return /^[a-f0-9-]{36}$/i.test(uuid) ? { method: 'darwin-kern.bootsessionuuid-sha256', sha256: sha256(uuid.toLowerCase()) } : null;
  } catch {
    return null;
  }
}

function treeHashes(dir) {
  const hashes = {};
  const walk = (rel) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (next.endsWith('.ts') && (next.includes('/src/') || next === 'v2/daemon/tests/helpers.ts')) {
        hashes[next] = sha256(readFileSync(join(dir, next)));
      }
    }
  };
  walk('v2');
  return hashes;
}

function extractSide(name, ref) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const sha = execFileSync('git', ['-C', repo, 'rev-parse', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const archive = execFileSync('git', ['-C', repo, 'archive', sha, 'v2'], { maxBuffer: 512 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  return { dir, ref, sha, hashes: treeHashes(dir) };
}

function dedupState(core) {
  const reportedI1 = Reflect.get(core, 'reportedI1');
  const interruptRequested = Reflect.get(core, 'interruptRequested');
  const sweepTicks = Reflect.get(core, 'sweepTicks');
  const sizeAtLastSweep = Reflect.get(core, 'sizeAtLastSweep');
  assert.ok(reportedI1 instanceof Set && interruptRequested instanceof Set, 'dedup sets moved');
  assert.ok(Number.isSafeInteger(sweepTicks) && Number.isSafeInteger(sizeAtLastSweep), 'sweep counters moved');
  return { reportedI1: reportedI1.size, interruptRequested: interruptRequested.size, sweepTicks, sizeAtLastSweep };
}

const sides = [extractSide('before', beforeRef), extractSide('after', afterRef)];
const changedSourceFiles = [...new Set([...Object.keys(sides[0].hashes), ...Object.keys(sides[1].hashes)])]
  .filter((f) => sides[0].hashes[f] !== sides[1].hashes[f]).sort();
if (sides[0].sha === sides[1].sha) {
  assert.deepEqual(changedSourceFiles, [], 'A/A run: extracted trees must be identical');
} else {
  assert.deepEqual(changedSourceFiles, ['v2/daemon/src/loops.ts'], 'refinement delta must be loops.ts only');
}
const modules = [];
for (const side of sides) {
  const local = (p) => import(pathToFileURL(join(side.dir, p)).href);
  modules.push({
    ...(await local('v2/core/src/index.ts')),
    ...(await local('v2/daemon/src/loops.ts')),
    ...(await local('v2/daemon/tests/helpers.ts')),
  });
}
const moduleIdentityShared = modules[0].DaemonCore === modules[1].DaemonCore;
assert.equal(moduleIdentityShared, false, 'distinct extracted dirs must yield distinct module instances');

// --- fixtures ---------------------------------------------------------------

function seedWide(store) {
  let meta;
  store.transact(() => {
    store.createBee({ id: 'wide', name: 'wide', agent: 'stub', substrate: 'hsr', cwd: '/tmp' });
    store.updateRuntimeState('wide', 1, 'stopped', { exitCause: 'clean' });
    const tracked = store.send('wide', 'tracked overdue').message; // FIFO position 0
    for (let i = 0; i < pending; i++) store.send('wide', `future ${i}`);
    meta = { trackedId: tracked.id, trackedEnqueuedAt: tracked.enqueuedAt };
  });
  return meta;
}

function seedProbe(store) {
  store.transact(() => {
    store.createBee({ id: 'runner', name: 'runner', agent: 'stub', substrate: 'hsr', cwd: '/tmp' });
    store.updateRuntimeState('runner', 1, 'running', { pid: 7_777, pidStartedAt: 1_000 });
    for (let i = 0; i < CADENCE; i++) store.send('runner', `urgent ${i}`, { urgency: 'now' });
    store.createBee({ id: 'held', name: 'held', agent: 'stub', substrate: 'hsr', cwd: '/tmp' });
    store.updateRuntimeState('held', 1, 'stopped', { exitCause: 'clean' });
    for (let i = 0; i < pending; i++) store.send('held', `background ${i}`);
  });
  return {};
}

function makeFixture(name, seed) {
  const template = join(root, `${name}.sqlite3`);
  const clock = { now: 1_000 };
  const store = modules[0].openCoreStore(template, { now: () => clock.now });
  const meta = seed(store);
  store.close();
  return { name, template, templateSha: sha256(readFileSync(template)), meta };
}

/** EXPLAIN of the EXACT probe statement at 1 and 512 bound ids: rowid membership, never a pending scan. */
function probePlanCheck(templatePath) {
  const statement = 'SELECT id FROM mailbox WHERE delivered_at IS NULL AND id IN (SELECT value FROM json_each(?))';
  for (const side of sides) {
    const src = readFileSync(join(side.dir, 'v2/core/src/store.ts'), 'utf8');
    assert.ok(src.includes(statement), `side ${side.ref}: store.ts does not contain the exact probe statement`);
  }
  const db = new DatabaseSync(templatePath, { readOnly: true });
  try {
    const plans = {};
    for (const [label, count] of [['ids1', 1], ['ids512', 512]]) {
      const bound = JSON.stringify(Array.from({ length: count }, (_, i) => i + 1));
      const details = db.prepare(`EXPLAIN QUERY PLAN ${statement}`).all(bound).map((row) => String(row.detail));
      assert.ok(details.some((d) => /USING INTEGER PRIMARY KEY|rowid=/.test(d)),
        `${label}: probe must resolve ids by rowid membership (plan: ${details.join(' | ')})`);
      assert.ok(!details.some((d) => /SCAN mailbox/.test(d)),
        `${label}: probe must not scan the mailbox (plan: ${details.join(' | ')})`);
      plans[label] = details;
    }
    return { statement, plans };
  } finally {
    db.close();
  }
}

// --- one cycle: prepare → ticks (only part sampled/timed) → verify ----------

let cycleOrdinal = 0;

function prepareCycle(sideIndex, fixture, scenario) {
  const m = modules[sideIndex];
  const copy = join(root, `${fixture.name}-s${sideIndex}-c${cycleOrdinal++}.sqlite3`);
  copyFileSync(fixture.template, copy);
  assert.equal(sha256(readFileSync(copy)), fixture.templateSha, 'cycle fixture must be pristine template bytes');
  const clock = { now: 1_000 };
  const now = () => clock.now;
  const store = m.openCoreStore(copy, { now });
  const driver = new m.FakeDriver(now);
  driver.acceptDeliveries = false;
  const violations = [];
  const i1On = scenario === 'wide-cadence';
  const core = new m.DaemonCore({
    store, driver, now, log: () => {},
    policy: { bootHangTimeoutSteps: 1_000_000_000, commandsPerStep: 0, i1DeadlineSteps: i1On ? 1_000 : null },
    onI1Violation: i1On ? (v) => violations.push(v) : undefined,
  });
  if (scenario === 'wide-cadence') {
    clock.now = fixture.meta.trackedEnqueuedAt + 1_500;
    core.step(); // violation tick primes reportedI1={tracked} and sweepTicks=1
    assert.equal(violations.length, 1);
    assert.equal(dedupState(core).reportedI1, 1);
  } else {
    driver.procs.set('runner', { generation: 1, pid: 7_777, pidStartedAt: 1_000, degraded: false });
  }
  const initial = dedupState(core);
  return {
    scenario, store, driver, core, violations, copy,
    auditHead: store.lastAuditSeq(),
    pendingBefore: store.listUndeliveredMessages().length,
    expectedSweepIndex: CADENCE - 1 - initial.sweepTicks,
  };
}

function runTicks(ctx) {
  const stepWallMs = [];
  const stepCpuMs = [];
  for (let tick = 0; tick < CADENCE; tick++) {
    if (ctx.scenario === 'probe-cadence' && tick % 2 === 0) {
      ctx.driver.events.push({ beeId: 'runner', generation: 1, kind: 'turn_started' });
    }
    const cpu = process.cpuUsage();
    const start = performance.now();
    ctx.core.step();
    stepWallMs.push(performance.now() - start);
    const used = process.cpuUsage(cpu);
    stepCpuMs.push((used.user + used.system) / 1000);
  }
  return { stepWallMs, stepCpuMs };
}

function verifyCycle(ctx) {
  const { store, driver, core, scenario } = ctx;
  const pairs = CADENCE / 2;
  assert.equal(store.listUndeliveredMessages().length, ctx.pendingBefore, 'pending backlog unchanged');
  assert.deepEqual(driver.starts, []);
  assert.deepEqual(driver.deliveredIds, []);
  const state = dedupState(core);
  // The sweep landed exactly where the primed counter said it would.
  assert.equal(state.sweepTicks, CADENCE - 1 - ctx.expectedSweepIndex, 'post-cycle sweep counter must match the sweep index');
  if (scenario === 'wide-cadence') {
    assert.equal(store.lastAuditSeq(), ctx.auditHead, 'wide cadence cycle must be authority-quiet');
    assert.equal(ctx.violations.length, 1, 'the tracked id is reported exactly once across the cadence');
    assert.equal(state.reportedI1, 1, 'sweep retains the pending tracked id');
    assert.equal(state.sizeAtLastSweep, 1);
    assert.equal(driver.interrupts.length, 0);
  } else {
    // Audit writers, identified exactly: each pair's synthesized turn_ended
    // fold writes runtime.updated + output.recorded; every pair after the
    // first also folds idle→running (runtime.updated).
    assert.equal(store.lastAuditSeq(), ctx.auditHead + 2 * pairs + (pairs - 1), 'exact probe-cadence audit delta');
    assert.equal(driver.interrupts.length, pairs, 'one interrupt per grow pair');
    assert.equal(state.interruptRequested, pairs, 'sweep retains every pending tracked id');
    assert.equal(state.sizeAtLastSweep, pairs);
    assert.equal(state.reportedI1, 0, 'reportedI1 never grows with I1 disabled');
  }
  store.close();
  rmSync(ctx.copy, { force: true });
}

function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  return { n: values.length, min: sorted[0], p50: pick(0.5), p95: pick(0.95), max: sorted.at(-1),
    mean: values.reduce((a, b) => a + b, 0) / values.length };
}

/** Top allocation records with COMPLETE frame ancestry for prune attribution. */
function summarizeHeapProfile(profile) {
  const records = [];
  const walk = (node, ancestry) => {
    const frame = `${node.callFrame.functionName || '(anonymous)'}@${String(node.callFrame.url).split('/').slice(-2).join('/')}:${node.callFrame.lineNumber}`;
    const path = [...ancestry, frame];
    if (node.selfSize > 0) records.push({ selfSize: node.selfSize, ancestry: path });
    for (const child of node.children ?? []) walk(child, path);
  };
  walk(profile.head, []);
  records.sort((a, b) => b.selfSize - a.selfSize);
  const total = records.reduce((a, r) => a + r.selfSize, 0);
  return { sampledAllocationBytes: total, allocationScope: 'ticks-only', topRecords: records.slice(0, 12) };
}

// --- run ---------------------------------------------------------------------

const report = {
  schemaVersion: 2, completed: false, startedAt, timestamp: null,
  tool: { path: selfPath, sha256: selfSha() },
  repo, sides: sides.map((s) => ({ ref: s.ref, sha: s.sha,
    loopsSha256: s.hashes['v2/daemon/src/loops.ts'], storeSha256: s.hashes['v2/core/src/store.ts'],
    treeFileCount: Object.keys(s.hashes).length })),
  changedSourceFiles, moduleIdentityShared,
  workload: { pending, rounds, cadence: CADENCE, mode,
    order: 'ABBA cycles per round; pristine template re-copy + sha check before EVERY cycle; fresh DaemonCore per cycle' },
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length, hostname: hostname(),
    bootIdentity: bootIdentity(), execArgv: process.execArgv, loadBefore, loadAfter: null },
  probePlan: null, scenarios: [], failure: null,
  scope: 'Disposable refinement comparison over archived sources. mode none: whole uninstrumented core.step() wall/CPU per tick, ALL raw samples retained; sweep tick located and verified via the private sweep counter, then split from quiet ticks. mode profile: V8 heap sampling strictly around tick execution (open/hydration/assertions outside the window); attribution-only, never a timing comparison; top records carry full frame ancestry. CPU is process-wide. Private fields are read reflectively as diagnostics only; pruning behavior is never monkeypatched. No repository, Mini, or production state is touched.',
};
try {
  for (const scenario of ['wide-cadence', 'probe-cadence']) {
    process.stderr.write(`dedup-ruler: ${scenario}\n`);
    const fixture = makeFixture(scenario, scenario === 'wide-cadence' ? seedWide : seedProbe);
    if (scenario === 'wide-cadence') report.probePlan = { pendingSeeded: pending + 1, ...probePlanCheck(fixture.template) };
    const raw = [
      { wallMs: [], cpuMs: [], sweepWallMs: [], sweepCpuMs: [], sweepIndices: [] },
      { wallMs: [], cpuMs: [], sweepWallMs: [], sweepCpuMs: [], sweepIndices: [] },
    ];
    for (let r = 0; r < rounds; r++) {
      for (const side of [0, 1, 1, 0]) {
        const ctx = prepareCycle(side, fixture, scenario);
        const { stepWallMs, stepCpuMs } = runTicks(ctx);
        verifyCycle(ctx);
        raw[side].sweepIndices.push(ctx.expectedSweepIndex);
        raw[side].sweepWallMs.push(stepWallMs[ctx.expectedSweepIndex]);
        raw[side].sweepCpuMs.push(stepCpuMs[ctx.expectedSweepIndex]);
        raw[side].wallMs.push(...stepWallMs.filter((_, i) => i !== ctx.expectedSweepIndex));
        raw[side].cpuMs.push(...stepCpuMs.filter((_, i) => i !== ctx.expectedSweepIndex));
      }
    }
    const allocation = [null, null];
    if (mode === 'profile') {
      for (const side of [0, 1]) {
        const ctx = prepareCycle(side, fixture, scenario);
        const session = new Session();
        session.connect();
        await session.post('HeapProfiler.enable');
        await session.post('HeapProfiler.startSampling', { samplingInterval: 8192,
          includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
        runTicks(ctx);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        session.disconnect();
        verifyCycle(ctx);
        const sidecar = `${out}.${scenario}.side${side}.heapprofile`;
        writeFileSync(sidecar, JSON.stringify(profile) + '\n');
        allocation[side] = { sidecar, sidecarSha256: sha256(readFileSync(sidecar)), ...summarizeHeapProfile(profile) };
      }
    }
    report.scenarios.push({
      scenario, fixtureSha256: fixture.templateSha, pendingSeeded: pending, raw,
      metrics: Object.fromEntries([0, 1].flatMap((side) => [
        [`${side === 0 ? 'before' : 'after'}.quietStep.wallMs`, distribution(raw[side].wallMs)],
        [`${side === 0 ? 'before' : 'after'}.quietStep.cpuMs`, distribution(raw[side].cpuMs)],
        [`${side === 0 ? 'before' : 'after'}.sweepStep.wallMs`, distribution(raw[side].sweepWallMs)],
        [`${side === 0 ? 'before' : 'after'}.sweepStep.cpuMs`, distribution(raw[side].sweepCpuMs)],
      ])),
      allocation: { before: allocation[0], after: allocation[1] },
    });
  }
  for (const [i, side] of sides.entries()) {
    assert.deepEqual(treeHashes(side.dir), side.hashes, `side ${side.ref}: extracted sources changed during the run`);
    assert.equal(report.sides[i].loopsSha256, side.hashes['v2/daemon/src/loops.ts']);
  }
  assert.equal(selfSha(), report.tool.sha256, 'ruler changed during the run');
  report.environment.loadAfter = loadavg();
  report.timestamp = new Date().toISOString();
  report.completed = true;
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(out);
} catch (error) {
  report.failure = { name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack ?? null };
  report.environment.loadAfter = loadavg();
  report.timestamp = new Date().toISOString();
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  throw error;
} finally {
  rmSync(root, { recursive: true, force: true });
}
