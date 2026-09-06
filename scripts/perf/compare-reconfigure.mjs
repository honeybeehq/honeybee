#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { distribution } from './report.mjs';

export function compareReconfigure(before, after) {
  assert.ok(before.length > 0 && before.length === after.length, 'sample count mismatch');
  const first = before[0];
  for (const side of [before, after]) {
    for (const sample of side) {
      assert.equal(sample.schemaVersion, 1);
      assert.equal(sample.completed, true, 'incomplete capture');
      assert.equal(sample.instrumented, false, 'profiling overhead must not enter timing claims');
      assert.deepEqual(sample.workload, first.workload, 'workload mismatch');
      assert.equal(sample.toolSha256, first.toolSha256, 'measurement tool mismatch');
      for (const key of ['node', 'platform', 'arch', 'cpu', 'hostname']) assert.equal(sample.environment[key], first.environment[key], `environment mismatch: ${key}`);
      assert.equal(sample.revision, side[0].revision, 'revision changed within a side');
      assert.deepEqual(sample.sourceHashes, side[0].sourceHashes, 'source changed within a side');
    }
  }
  const metrics = {
    wallMs: r => r.wallMs, cpuMs: r => r.cpuMs,
    rssBeforeBytes: r => r.before.rss, rssAfterBytes: r => r.after.rss,
    heapBeforeBytes: r => r.before.heapUsed, heapAfterBytes: r => r.after.heapUsed,
    peakBeforeBytes: r => r.peakBeforeKiB * 1024, peakAfterBytes: r => r.peakAfterKiB * 1024,
  };
  const comparison = Object.entries(metrics).map(([metric, value]) => {
    const summarize = side => {
      const values = side.map(value);
      assert.ok(values.every(v => Number.isFinite(v) && v >= 0), `invalid metric: ${metric}`);
      return distribution(values);
    };
    const b = summarize(before), a = summarize(after);
    return { metric, before: b, after: a, deltaPercent: b.p50 === 0 ? null : (a.p50 / b.p50 - 1) * 100 };
  });
  return { schemaVersion: 1, completed: true, workload: first.workload, before, after, comparison };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [beforePrefix, afterPrefix, out, countArg = '3'] = process.argv.slice(2);
  const count = Number(countArg);
  assert.ok(beforePrefix && afterPrefix && out && Number.isSafeInteger(count) && count > 0 && count <= 100, 'usage: compare-reconfigure.mjs before-prefix after-prefix out.json [count]');
  const readSide = prefix => Array.from({ length: count }, (_, i) => JSON.parse(readFileSync(`${prefix}${i + 1}.json`, 'utf8')));
  writeFileSync(out, JSON.stringify(compareReconfigure(readSide(beforePrefix), readSide(afterPrefix)), null, 2) + '\n');
}
