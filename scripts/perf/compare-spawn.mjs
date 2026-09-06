#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { distribution } from './report.mjs';

function checkedMetrics(result, count) {
  assert.equal(result.raw.length, count, 'incomplete samples');
  assert.ok(count > 0);
  for (const [key, summary] of Object.entries(result.metrics)) {
    const values = result.raw.map(row => row[key]);
    assert.ok(values.every(value => Number.isFinite(value) && value >= 0), `invalid metric: ${key}`);
    assert.deepEqual(summary, distribution(values), `summary differs from raw samples: ${key}`);
  }
}

function rows(before, after, scenario) {
  assert.deepEqual(Object.keys(after.metrics), Object.keys(before.metrics), 'metric mismatch');
  return Object.keys(before.metrics).map(metric => {
    const b = before.metrics[metric].p50, a = after.metrics[metric].p50;
    return { scenario, metric, before: b, after: a, deltaPercent: b === 0 ? null : (a / b - 1) * 100,
      beforeP95: before.metrics[metric].p95, afterP95: after.metrics[metric].p95, n: after.raw.length };
  });
}

export function compareCells(before, after) {
  for (const report of [before, after]) {
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.completed, true, 'incomplete capture');
    assert.ok(report.results.length > 0);
    for (const result of report.results) checkedMetrics(result, report.workload.samples);
  }
  assert.deepEqual(after.workload, before.workload, 'workload mismatch');
  assert.equal(after.toolSha256, before.toolSha256, 'measurement tool mismatch');
  for (const key of ['node', 'platform', 'arch', 'cpu', 'hostname']) assert.equal(after.environment[key], before.environment[key], `environment mismatch: ${key}`);
  assert.deepEqual(after.results.map(r => r.scenario), before.results.map(r => r.scenario), 'scenario mismatch');
  return before.results.flatMap((result, i) => rows(result, after.results[i], result.scenario));
}

export function compareHosts(report) {
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.results.length, 2);
  for (const result of report.results) checkedMetrics(result, report.spec.rounds);
  return rows(report.results[0], report.results[1], 'runner-host').map(row => {
    const deltas = report.results[0].raw.map((sample, i) => report.results[1].raw[i][row.metric] - sample[row.metric]);
    return { ...row, pairedDeltaP50: distribution(deltas).p50, pairsAfterLower: deltas.filter(delta => delta < 0).length,
      beforeImplementation: report.results[0].implementation.name,
      afterImplementation: report.results[1].implementation.name,
      beforeEntrySha256: report.results[0].implementation.entrySha256,
      afterEntrySha256: report.results[1].implementation.entrySha256,
    };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...paths] = process.argv.slice(2);
  assert.ok((mode === 'cells' && paths.length === 3) || (mode === 'hosts' && paths.length === 2), 'usage: compare-spawn.mjs cells before.json after.json out.csv | hosts paired.json out.csv');
  const read = path => JSON.parse(readFileSync(path, 'utf8'));
  const data = mode === 'cells' ? compareCells(read(paths[0]), read(paths[1])) : compareHosts(read(paths[0]));
  const columns = Object.keys(data[0]);
  const csv = value => value == null ? '' : `"${String(value).replaceAll('"', '""')}"`;
  writeFileSync(paths.at(-1), [columns.map(csv).join(','), ...data.map(row => columns.map(key => csv(row[key])).join(','))].join('\n') + '\n');
}
