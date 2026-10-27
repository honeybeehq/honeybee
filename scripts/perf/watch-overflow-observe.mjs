import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { CoreStore } from '../../v2/core/src/store.ts';

if (process.env.HIVE_V2_DATA_DIR && process.env.HIVE_WATCH_OBSERVE_OUT) {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  let samples = 0, rssSampledPeak = 0, heapUsedSampledPeak = 0;
  let auditRowsCalls = 0, auditRowsReturned = 0, auditRowsMaxReturned = 0;
  const original = CoreStore.prototype.auditRows;
  CoreStore.prototype.auditRows = function (...args) {
    const rows = original.apply(this, args);
    auditRowsCalls++; auditRowsReturned += rows.length;
    auditRowsMaxReturned = Math.max(auditRowsMaxReturned, rows.length);
    return rows;
  };
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    rssSampledPeak = Math.max(rssSampledPeak, memory.rss);
    heapUsedSampledPeak = Math.max(heapUsedSampledPeak, memory.heapUsed);
    samples++;
  }, 10);
  timer.unref();
  process.on('exit', () => {
    clearInterval(timer); delay.disable();
    writeFileSync(process.env.HIVE_WATCH_OBSERVE_OUT, JSON.stringify({ pid: process.pid, resolutionMs: 1, memorySampleMs: 10, samples, rssSampledPeak, heapUsedSampledPeak, auditRowsCalls, auditRowsReturned, auditRowsMaxReturned, eventLoopDelayMaxMs: delay.max / 1e6, eventLoopDelayMeanMs: delay.mean / 1e6, eventLoopDelayP99Ms: delay.percentile(99) / 1e6 }) + '\n');
  });
}
