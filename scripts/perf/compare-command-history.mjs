#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution } from './report.mjs';

export function compareCommandHistory(before, after) {
  for (const report of [before, after]) {
    assert.equal(report.completed, true);
    assert.equal(report.prototype, 'none', 'final comparison requires production code');
    for (const name of ['store.ts', 'schema.ts']) assert.match(report.sourceHashes[name], /^[a-f0-9]{64}$/);
    assert.match(report.toolSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.results.map(r => r.name), report.workload.cases.map(r => r.name));
  }
  assert.notDeepEqual(before.sourceHashes, after.sourceHashes, 'final comparison requires different source');
  assert.deepEqual(before.workload, after.workload, 'workload changed');
  assert.equal(before.toolSha256, after.toolSha256, 'ruler changed');
  for (const key of ['node', 'platform', 'arch', 'cpu']) {
    assert.equal(before.environment[key], after.environment[key], `environment changed: ${key}`);
  }
  if (before.environment.bootIdentity || after.environment.bootIdentity) {
    assert.deepEqual(before.environment.bootIdentity, after.environment.bootIdentity, 'OS boot identity changed');
    assert.match(after.environment.bootIdentity.sha256, /^[a-f0-9]{64}$/);
    assert.ok(['darwin-kern.bootsessionuuid-sha256', 'linux-boot-id-sha256'].includes(after.environment.bootIdentity.method));
  } else assert.equal(before.environment.hostname, after.environment.hostname, 'hostname changed without boot identity');
  const rows = [];
  const plans = plan => plan.map(p => p.detail).join('\n');
  for (const [i, a] of after.results.entries()) {
    const b = before.results[i];
    for (const [key, value] of Object.entries(after.workload.cases[i])) {
      assert.deepEqual(a[key], value); assert.deepEqual(b[key], value);
    }
    assert.match(plans(a.plan), /USING INDEX commands_by_bee \(bee_id=\?\)/);
    assert.doesNotMatch(plans(a.plan), /USE TEMP B-TREE/);
    assert.match(plans(a.pendingProbes.deletePending.plan), /USING COVERING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/);
    assert.match(plans(a.pendingProbes.wake.plan), /USING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/);
    assert.match(plans(a.pendingUpdate.plan), /USING INDEX commands_by_bee_status \(bee_id=\? AND status=\?\)/);
    for (const op of ['reads', 'missing', 'queued', 'reconfigure', 'transitions', 'wake', 'deletePending']) {
      const count = op === 'transitions' ? after.workload.transitionBatch.samples
        : ['reads', 'reconfigure'].includes(op) && a.targetCommands >= 100000 ? after.workload.largeResultSamples : after.workload.samples;
      for (const metric of ['wallMs', 'cpuMs']) {
        const summaries = [b, a].map(result => {
          const raw = (result[op] ?? result.pendingProbes[op]).raw;
          assert.equal(raw.length, count, `sample count: ${op}`);
          const values = raw.map(r => r[metric]);
          assert.ok(values.every(v => Number.isFinite(v) && v >= 0), `invalid ${op}.${metric}`);
          return distribution(values);
        });
        rows.push({ scenario: a.name, metric: `${op}.${metric}`, before: summaries[0].p50, after: summaries[1].p50,
          deltaPercent: summaries[0].p50 === 0 ? null : (summaries[1].p50 / summaries[0].p50 - 1) * 100,
          summaries });
      }
    }
    assert.ok([a.sqliteBytes, b.sqliteBytes].every(v => Number.isSafeInteger(v) && v > 0));
    rows.push({ scenario: a.name, metric: 'sqliteBytes', before: b.sqliteBytes, after: a.sqliteBytes,
      deltaPercent: (a.sqliteBytes / b.sqliteBytes - 1) * 100 });
  }
  return { completed: true, beforeRevision: before.revision, afterRevision: after.revision,
    sourceHashes: { before: before.sourceHashes, after: after.sourceHashes }, toolSha256: before.toolSha256,
    hostnames: { before: before.environment.hostname, after: after.environment.hostname },
    bootIdentity: after.environment.bootIdentity ?? null,
    checks: 'Matching ruler/workload/environment; raw distributions recomputed; production history, pending-delete, wake and update plans verified.', rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [before, after, out] = process.argv.slice(2);
  assert.ok(before && after && out, 'usage: compare-command-history.mjs before.json after.json out.json');
  const result = compareCommandHistory(JSON.parse(readFileSync(before)), JSON.parse(readFileSync(after)));
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  const quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = [['scenario', 'metric', 'before p50', 'after p50', 'delta percent'], ...result.rows.map(r => [r.scenario, r.metric, r.before, r.after, r.deltaPercent])];
  writeFileSync(`${out}.csv`, rows.map(r => r.map(quote).join(',')).join('\n') + '\n');
  console.log(out);
}
