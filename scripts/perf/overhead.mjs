#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPerformanceProfiler, NOOP_PERFORMANCE } from '../../v2/daemon/src/performance.ts';
import { distribution } from './report.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hb-perf-overhead-'));
const active = createPerformanceProfiler({ env: { HIVE_PERF_DIR: dir }, limits: { durationMs: 60000, sampleIntervalMs: 60000, maxEvents: 20000, maxArtifactBytes: 8 * 1024 * 1024 }, log: message => assert.fail(message) });
try {
  active.start();
  let sink = 0;
  const operation = () => ++sink;
  const calls = {
    direct: () => operation(),
    disabled: () => NOOP_PERFORMANCE.measureSync('core.step.total', operation),
    enabled: () => active.measureSync('core.step.total', operation),
  };
  const rawNanosecondsPerCall = { direct: [], disabled: [], enabled: [] };
  const iterations = 500, rounds = 15;
  for (const call of Object.values(calls)) for (let i = 0; i < iterations; i++) call();
  for (let round = 0; round < rounds; round++) {
    for (const name of ['direct', 'disabled', 'enabled', 'enabled', 'disabled', 'direct']) {
      const t = performance.now();
      for (let i = 0; i < iterations; i++) calls[name]();
      rawNanosecondsPerCall[name].push((performance.now() - t) * 1e6 / iterations);
    }
  }
  active.stop();
  assert.equal(sink, iterations * 3 + rounds * iterations * 6);
  const names = readdirSync(dir);
  assert.equal(names.length, 2);
  const summary = JSON.parse(readFileSync(join(dir, names.find(name => name.endsWith('.summary.json'))), 'utf8'));
  assert.equal(summary.droppedEvents, 0);
  assert.equal(summary.spans['core.step.total'].count, iterations + rounds * iterations * 2);
  console.log(JSON.stringify({ schemaVersion: 1, node: process.version, timestamp: new Date().toISOString(), scope: 'synthetic call overhead; alternating direct/disabled/enabled then reversed; excludes operation work and final artifact serialization', config: { iterations, rounds }, nanosecondsPerCall: Object.fromEntries(Object.entries(rawNanosecondsPerCall).map(([key, values]) => [key, distribution(values)])), rawNanosecondsPerCall, artifactBytes: names.reduce((n, name) => n + statSync(join(dir, name)).size, 0), recordedSpans: summary.spans['core.step.total'].count, droppedEvents: summary.droppedEvents }, null, 2));
} finally { active.stop(); rmSync(dir, { recursive: true, force: true }); }
