#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compareReports, distribution } from './report.mjs';

const hash = /^[a-f0-9]{64}$/;
export function compareReadHotspots(before, after, expectedChangedFiles) {
  assert.ok(Array.isArray(expectedChangedFiles), 'explicit expected source changes required');
  for (const r of [before, after]) {
    assert.equal(r.completed, true, 'incomplete capture');
    assert.equal(r.failure, null, 'capture failed');
    assert.match(r.source.revision, /^[a-f0-9]{40}$/);
    assert.equal(typeof r.source.status, 'string');
    assert.doesNotMatch(r.source.status, /^.. v2\//m, 'expected committed v2 source');
    assert.match(r.source.diffSha256, hash);
    for (const file of ['v2/core/src/store.ts', 'v2/core/src/schema.ts', 'v2/core/src/tasks.ts',
      'v2/daemon/src/loops.ts', 'v2/daemon/tests/helpers.ts']) assert.match(r.source.hashes[file], hash);
    for (const file of ['read-hotspots.mjs', 'sql-trace.mjs', 'report.mjs', 'boot-identity.mjs']) assert.match(r.toolHashes[file], hash);
    assert.ok(Number.isSafeInteger(r.workload.samples) && r.workload.samples >= 3);
    assert.equal(r.workload.timingInstrumentation, 'none');
    const times = [r.startedAt, r.measurement.startedAt, r.measurement.finishedAt, r.timestamp].map(Date.parse);
    assert.ok(times.every(Number.isFinite), 'invalid capture times');
    assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), 'capture times out of order');
    assert.deepEqual(r.results.map(s => s.scenario), r.workload.scenarios.map(s => s.id), 'scenario set changed');
    for (const s of r.results) {
      assert.equal(s.completed, true, 'incomplete scenario');
      assert.equal(s.failure, null, 'scenario failed');
      assert.ok(Date.parse(s.measurement.startedAt) >= times[1]
        && Date.parse(s.measurement.finishedAt) >= Date.parse(s.measurement.startedAt)
        && Date.parse(s.measurement.finishedAt) <= times[2], 'invalid scenario interval');
      for (const [raw, metric] of [['wallMs', 'operation.wall'], ['cpuMs', 'operation.cpu']]) {
        assert.equal(s.raw[raw].length, r.workload.samples, 'sample count mismatch');
        assert.ok(s.raw[raw].every(v => Number.isFinite(v) && v >= 0), 'invalid raw samples');
        assert.deepEqual(s.metrics[metric], { unit: 'ms', ...distribution(s.raw[raw]) }, 'summary disagrees with raw samples');
      }
    }
  }
  assert.deepEqual(before.toolHashes, after.toolHashes, 'ruler changed');
  for (const key of ['logicalCpus', 'execArgv', 'nodeCompileCache', 'nodeOptionsSha256']) {
    assert.notEqual(before.environment[key], undefined, `missing environment ${key}`);
    assert.deepEqual(before.environment[key], after.environment[key], `environment changed: ${key}`);
  }
  const boot = before.environment.bootIdentity;
  assert.ok(boot, 'OS boot identity required for this ruler');
  assert.match(boot.sha256, hash);
  assert.ok(['darwin-kern.bootsessionuuid-sha256', 'linux-boot-id-sha256'].includes(boot.method));
  assert.deepEqual(boot, after.environment.bootIdentity, 'OS boot identity changed');
  assert.ok(Date.parse(before.timestamp) <= Date.parse(after.startedAt)
    || Date.parse(after.timestamp) <= Date.parse(before.startedAt), 'capture intervals overlap');
  const changedSourceFiles = [...new Set([...Object.keys(before.source.hashes), ...Object.keys(after.source.hashes)])]
    .filter(file => before.source.hashes[file] !== after.source.hashes[file]).sort();
  assert.deepEqual(changedSourceFiles, [...expectedChangedFiles].sort(), 'unexpected source changes');
  return { completed: true, purpose: 'uninstrumented read-hotspot timings',
    expectedChangedFiles, changedSourceFiles, beforeSource: before.source, afterSource: after.source,
    beforeEnvironment: before.environment, afterEnvironment: after.environment,
    toolHashes: before.toolHashes, workload: before.workload, rows: compareReports(before, after) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [beforePath, afterPath, out, changes] = process.argv.slice(2);
  assert.ok(beforePath && afterPath && out && changes !== undefined,
    'usage: compare-read-hotspots.mjs before.json after.json out.json expected-changed-files,comma-separated');
  const result = compareReadHotspots(...[beforePath, afterPath].map(p => JSON.parse(readFileSync(p, 'utf8'))), changes.split(',').filter(Boolean));
  result.comparatorSha256 = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
  console.log(out);
}
