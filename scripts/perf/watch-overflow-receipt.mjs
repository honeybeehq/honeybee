import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const [beforePath, afterPath, out] = process.argv.slice(2);
assert.ok(beforePath && afterPath && out, 'usage: node scripts/perf/watch-overflow-receipt.mjs before.json after.json receipt.json');
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
for (const key of ['host', 'runtime', 'tickMs', 'count']) assert.equal(before[key], after[key], `different ${key}`);
for (const key of ['payloadBytes', 'chunkPauseMs']) assert.equal(before[key] ?? 0, after[key] ?? 0, `different ${key}`);
assert.equal(before.chunkSize ?? before.count, after.chunkSize ?? after.count);
assert.equal(before.diagnostics ?? false, after.diagnostics ?? false);
for (const capture of [before, after]) {
  assert.deepEqual(capture.errors, []);
  assert.equal(capture.daemonStopped, true);
  assert.equal(capture.samples.filter(sample => !sample.warmup).length, 5);
}
const samples = after.samples.filter(sample => !sample.warmup);
for (const sample of samples) {
  assert.equal(sample.gaps, 0);
  assert.equal(sample.replacementSnapshotBytes, 0);
  let cursor = sample.startSeq;
  for (const frame of sample.frames) {
    assert.equal(frame.baseSeq, cursor);
    assert.ok(frame.rows > 0 && frame.rows <= 256);
    assert.ok(frame.bytes <= 128 * 1024 || frame.rows === 1);
    assert.equal(frame.seq, cursor + frame.rows);
    cursor = frame.seq;
  }
  assert.equal(cursor, sample.endSeq);
  assert.equal(cursor, sample.startSeq + after.count);
}
const owners = ['v2/core/src/store.ts', 'v2/daemon/src/rpc.ts', 'v2/daemon/src/daemon.ts', 'v2/daemon/src/performance.ts'];
const sourceHashes = Object.fromEntries(owners.map(path => [path, execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim()]));
const receipt = {
  workload: 'watch-overflow', seriesId: `watch-overflow-v1:${after.host}:${after.runtime}:${after.tickMs}:${after.count}:${after.payloadBytes ?? 0}:${after.diagnostics ?? false}:${after.chunkSize ?? after.count}:${after.chunkPauseMs ?? 0}`,
  capturedAt: new Date().toISOString(), machine: after.host, runtime: after.runtime, complete: true, sourceHashes,
  collector: 'Generated disposable real hived; sequential before/after; contiguous transport/cursor only; timing excludes deliberate collection wait and includes receiver polling; no Apiary fold/install.',
  before: { snapshotBytes: before.samples.filter(sample => !sample.warmup).map(sample => sample.replacementSnapshotBytes), gaps: before.samples.filter(sample => !sample.warmup).map(sample => sample.gaps) },
  counts: samples.map(sample => ({ deltaBytes: sample.deltaBytes, frames: sample.frames.length, maxFrameRows: Math.max(...sample.frames.map(frame => frame.rows)), maxFrameBytes: Math.max(...sample.frames.map(frame => frame.bytes)), startSeq: sample.startSeq, endSeq: sample.endSeq })),
  results: [{ metric: 'replacementSnapshotBytes', samples: samples.map(sample => sample.replacementSnapshotBytes), invariantHolds: true }],
};
writeFileSync(out, JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ out, samples: samples.length, snapshotBytes: 0, maxFrameRows: Math.max(...receipt.counts.map(sample => sample.maxFrameRows)), maxFrameBytes: Math.max(...receipt.counts.map(sample => sample.maxFrameBytes)) }));
