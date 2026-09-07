#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution } from './report.mjs';

const hash = /^[a-f0-9]{64}$/;
export function validateQuietPair(before, after, expectedChangedFiles) {
  for (const r of [before, after]) {
    assert.equal(r.schemaVersion, 2, 'capture schema must include full provenance');
    assert.equal(r.completed, true, 'incomplete capture');
    assert.match(r.source.revision, /^[a-f0-9]{40}$/);
    assert.equal(typeof r.source.status, 'string'); assert.match(r.source.diffSha256, hash);
    for (const file of ['v2/core/src/store.ts', 'v2/core/src/schema.ts', 'v2/core/src/view.ts',
      'v2/core/src/tasks.ts', 'v2/daemon/src/loops.ts', 'v2/daemon/tests/helpers.ts']) assert.match(r.source.hashes[file], hash);
    for (const file of ['quiet-tick.mjs', 'fixtures.mjs', 'report.mjs', 'boot-identity.mjs']) assert.match(r.toolHashes[file], hash);
    assert.ok(Number.isSafeInteger(r.workload.samples) && r.workload.samples >= 3);
    assert.ok(['none', 'profile'].includes(r.workload.mode));
    const dates = [r.startedAt, r.measurement.startedAt, r.measurement.finishedAt, r.timestamp].map(Date.parse);
    assert.ok(dates.every(Number.isFinite), 'invalid capture timestamps');
    assert.ok(dates.every((value, i) => i === 0 || value >= dates[i - 1]), 'capture timestamps out of order');
    for (const key of ['wallMs', 'cpuMs']) {
      const values = r.raw[key];
      assert.equal(values.length, r.workload.samples, 'sample count mismatch');
      assert.ok(values.every(value => Number.isFinite(value) && value >= 0), 'invalid raw sample');
      assert.deepEqual(r.metrics[key], distribution(values), 'summary disagrees with raw samples');
    }
  }
  assert.deepEqual(before.workload, after.workload, 'workload or instrumentation changed');
  assert.deepEqual(before.toolHashes, after.toolHashes, 'ruler changed');
  for (const key of ['node', 'platform', 'arch', 'cpu', 'logicalCpus', 'execArgv', 'nodeCompileCache', 'nodeOptionsSha256']) {
    assert.notEqual(before.environment[key], undefined, `missing environment ${key}`);
    assert.deepEqual(before.environment[key], after.environment[key], `environment changed: ${key}`);
  }
  const boot = before.environment.bootIdentity;
  if (boot || after.environment.bootIdentity) {
    assert.deepEqual(boot, after.environment.bootIdentity, 'OS boot identity changed');
    assert.match(boot.sha256, hash);
    assert.ok(['darwin-kern.bootsessionuuid-sha256', 'linux-boot-id-sha256'].includes(boot.method));
  } else {
    assert.equal(typeof before.environment.hostname, 'string');
    assert.equal(before.environment.hostname, after.environment.hostname, 'hostname changed without boot identity');
  }
  assert.ok(Date.parse(before.timestamp) <= Date.parse(after.startedAt)
    || Date.parse(after.timestamp) <= Date.parse(before.startedAt), 'capture intervals overlap, including setup');
  const changedSourceFiles = [...new Set([...Object.keys(before.source.hashes), ...Object.keys(after.source.hashes)])]
    .filter(file => before.source.hashes[file] !== after.source.hashes[file]).sort();
  if (expectedChangedFiles !== undefined) {
    assert.deepEqual(changedSourceFiles, [...expectedChangedFiles].sort(), 'unexpected source changes');
    for (const r of [before, after]) assert.doesNotMatch(r.source.status, /^.. v2\//m, 'expected committed v2 source');
  }
  return changedSourceFiles;
}

export function compareQuiet(before, after, expectedChangedFiles) {
  const changedSourceFiles = validateQuietPair(before, after, expectedChangedFiles);
  assert.equal(before.workload.mode, 'none', 'profiling overhead must not enter timing claims');
  const rows = ['wallMs', 'cpuMs'].map(metric => {
    const b = distribution(before.raw[metric]), a = distribution(after.raw[metric]);
    return { metric, before: b, after: a, deltaPercent: b.p50 === 0 ? null : (a.p50 / b.p50 - 1) * 100 };
  });
  return { completed: true, purpose: 'uninstrumented quiet-step timing', workload: before.workload,
    changedSourceFiles, expectedChangedFiles: expectedChangedFiles ?? null,
    beforeSource: before.source, afterSource: after.source,
    beforeEnvironment: before.environment, afterEnvironment: after.environment, rows };
}

export function readQuietProfiles(report, reportPath) {
  assert.equal(report.workload.mode, 'profile');
  assert.equal(report.profiles.length, 2, 'expected CPU and allocation profiles');
  const profiles = new Map();
  for (const p of report.profiles) {
    const kind = p.path.endsWith('.heapprofile') ? 'heap' : p.path.endsWith('.cpuprofile') ? 'cpu' : null;
    assert.ok(kind && !profiles.has(kind), 'unexpected or duplicate profile');
    const bytes = readFileSync(join(dirname(reportPath), basename(p.path)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), p.sha256, 'profile hash mismatch');
    profiles.set(kind, JSON.parse(bytes));
  }
  let sampledAllocationBytes = 0;
  const pending = [profiles.get('heap').head];
  while (pending.length) {
    const n = pending.pop();
    assert.ok(Number.isSafeInteger(n.selfSize) && n.selfSize >= 0, 'invalid allocation sample');
    sampledAllocationBytes += n.selfSize; pending.push(...(n.children ?? []));
  }
  return { sampledAllocationBytes, phases: report.phases,
    scope: 'Sampled allocations include collected objects. Phase timing includes instrumentation. Neither measures private or retained memory.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [beforePath, afterPath, out, changedArg] = process.argv.slice(2);
  assert.ok(beforePath && afterPath && out, 'usage: compare-quiet.mjs before.json after.json out.json [expected-changed-files,comma-separated]');
  const expected = changedArg === undefined ? undefined : changedArg.split(',').filter(Boolean);
  const [before, after] = [beforePath, afterPath].map(path => JSON.parse(readFileSync(path, 'utf8')));
  const changedSourceFiles = validateQuietPair(before, after, expected);
  const result = before.workload.mode === 'none' ? compareQuiet(before, after, expected) : {
    completed: true, purpose: 'instrumented attribution only; not a timing speedup',
    beforeSource: before.source, afterSource: after.source,
    changedSourceFiles, expectedChangedFiles: expected ?? null,
    beforeEnvironment: before.environment, afterEnvironment: after.environment,
    before: readQuietProfiles(before, beforePath), after: readQuietProfiles(after, afterPath),
  };
  result.comparatorSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(out);
}
