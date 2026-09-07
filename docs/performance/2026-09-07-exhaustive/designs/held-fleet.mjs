import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const [before, after, out, changes, roundsArg = '15', countsArg = '1,1000,10000'] = process.argv.slice(2);
assert(before && after && out && changes !== undefined);
assert.equal(typeof global.gc, 'function');
const roots = [before, after].map(root => resolve(root)), rounds = Number(roundsArg);
assert.notEqual(roots[0], roots[1]);
assert(Number.isInteger(rounds) && rounds >= 3 && rounds <= 50);
const hash = b => createHash('sha256').update(b).digest('hex');
const git = (root, ...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr); return r.stdout;
};
const fingerprint = root => {
  const files = git(root, 'ls-files', 'v2').trim().split('\n').filter(f => f.endsWith('.ts') && (f.includes('/src/') || f === 'v2/daemon/tests/helpers.ts'));
  assert.doesNotMatch(git(root, 'status', '--porcelain'), /^.. v2\//m);
  return { revision: git(root, 'rev-parse', 'HEAD').trim(), hashes: Object.fromEntries(files.map(f => [f, hash(readFileSync(join(root, f)))])) };
};
const sources = roots.map(fingerprint), toolHash = hash(readFileSync(new URL(import.meta.url)));
const changed = [...new Set(sources.flatMap(s => Object.keys(s.hashes)))].filter(f => sources[0].hashes[f] !== sources[1].hashes[f]).sort();
assert.deepEqual(changed, changes.split(',').filter(Boolean).sort());
const boot = () => {
  const r = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); return hash(r.stdout.trim());
};
const {captureSql} = await import(pathToFileURL(join(roots[0], 'scripts/perf/sql-trace.mjs')));
const sqlToolHash = hash(readFileSync(join(roots[0], 'scripts/perf/sql-trace.mjs')));
const modules = [];
for (const root of roots) {
  const local = path => import(pathToFileURL(join(root, path)).href);
  modules.push({ ...await local('v2/core/src/index.ts'), ...await local('v2/daemon/src/loops.ts'), ...await local('v2/daemon/tests/helpers.ts') });
}
assert.notEqual(modules[0].openCoreStore, modules[1].openCoreStore);
const report = { completed: false, startedAt: new Date().toISOString(), sources, changed, toolHash, sqlToolHash,
  environment: { node: process.version, execArgv: process.execArgv, cpu: cpus()[0].model, boot: boot(), loadBefore: loadavg() },
  scope: 'Real CoreStore and DaemonCore with FakeDriver. One held idle message per real-running Bee; no active move. Whole uninstrumented step CPU/wall; separate one-step SQL diagnostic after timing. Exact pending/state/audit/driver invariants. No real process, delivery or end-to-end latency claim. Copied fixtures, distinct modules, ABBA, setup/checks/GC outside timing.', results: [] };
const dir = mkdtempSync(join(tmpdir(), 'hb-dedup-busy-')), stores = [];
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
const distribution = xs => { const s = [...xs].sort((a,b) => a-b); return { n: s.length, p50: s[Math.floor((s.length-1)*.5)], p95: s[Math.ceil((s.length-1)*.95)], min: s[0], max: s.at(-1) }; };
save();
try {
  for (const count of countsArg.split(',').map(Number)) for (const i1Enabled of [false,true]) {
    assert(Number.isSafeInteger(count) && count>=1 && count<=10000);
    const seedPath = join(dir, `seed-${count}-${i1Enabled}.sqlite`), seed = modules[0].openCoreStore(seedPath, { now: () => 1000 });
    seed.transact(() => {
      for (let i=0;i<count;i++) {
        const id=`pending-${i}`;
        seed.createBee({id,name:id,agent:'stub',substrate:'hsr',cwd:dir});
        seed.updateRuntimeState(id,1,'running');
        assert.equal(seed.currentRuntime(id).bootEvidence,'real');
        seed.send(id,'x'.repeat(64),{urgency:'idle'});
      }
    });
    seed.close();
    const fixtureSha256 = hash(readFileSync(seedPath));
    const rigs = modules.map((m, side) => {
      const path = join(dir, `case-${count}-${i1Enabled}-${side}.sqlite`); copyFileSync(seedPath, path); assert.equal(hash(readFileSync(path)), fixtureSha256);
      const store = m.openCoreStore(path, { now: () => 1000 }); stores.push(store);
      const driver = new m.FakeDriver(() => 1000), callbacks = { count: 0 };
      const core = new m.DaemonCore({ store, driver, now: () => 1000, policy: { commandsPerStep: 0, bootHangTimeoutSteps: 1e12, i1DeadlineSteps: i1Enabled ? 1000000000 : undefined }, onI1Violation: () => callbacks.count++, log: () => {} });
      core.step(); assert.equal(callbacks.count, 0);
      return { store, driver, core, callbacks, seq: store.lastAuditSeq(), state:hash(JSON.stringify(store.dumpState())) };
    });
    const order = [0,1,1,0], raw = [[],[]];
    for (let r = 0; r < 3; r++) for (const side of order) rigs[side].core.step();
    global.gc();
    for (let r = 0; r < rounds; r++) for (const side of order) {
      const cpu = process.cpuUsage(), start = performance.now(); rigs[side].core.step();
      const wallMs = performance.now()-start, used = process.cpuUsage(cpu);
      raw[side].push({ wallMs, cpuMs: (used.user+used.system)/1000 });
    }
    const diagnostics = rigs.map(rig=>captureSql(()=>rig.core.step()).statements);
    for (const rig of rigs) {
      assert.equal(rig.callbacks.count, 0); assert.equal(hash(JSON.stringify(rig.store.dumpState())),rig.state); assert.equal(rig.store.lastAuditSeq(), rig.seq);
      assert.equal(rig.store.listUndeliveredMessages().length, count);
      assert(rig.core.reportedI1 instanceof Set); assert.equal(rig.core.reportedI1.size, 0);
      assert.deepEqual(rig.driver.starts, []); assert.deepEqual(rig.driver.deliveredIds, []); assert.deepEqual(rig.driver.interrupts, []);
      rig.store.close(); stores.splice(stores.indexOf(rig.store),1);
    }
    report.results.push({ count, i1Enabled, diagnostics, fixtureSha256, rounds, stepsPerSample: 1, order: 'ABBA', raw, metrics: raw.map(xs => ({ wallMs: distribution(xs.map(x=>x.wallMs)), cpuMs: distribution(xs.map(x=>x.cpuMs)) })) }); save();
  }
  assert.equal(hash(readFileSync(join(roots[0], 'scripts/perf/sql-trace.mjs'))),sqlToolHash);
  assert.deepEqual(roots.map(fingerprint), sources); assert.equal(boot(), report.environment.boot);
  assert.equal(hash(readFileSync(new URL(import.meta.url))), toolHash); report.completed = true;
} catch (e) { report.failure = String(e?.stack ?? e); throw e; }
finally { report.finishedAt = new Date().toISOString(); report.environment.loadAfter = loadavg(); save(); for (const s of stores) s.close(); rmSync(dir, { recursive: true, force: true }); }
console.log(out);
