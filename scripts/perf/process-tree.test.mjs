import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProcessTable, processTree, cpuPercentBetween } from './process-tree.mjs';

test('ps parsing accepts macOS/Linux clock formats and rejects malformed input', () => {
  const rows = parseProcessTable(' 12 1 2048 1:02.50 Sun Sep 6 05:00:00 2026\n13 12 4096 1-02:03:04 Sun Sep 6 05:00:00 2026');
  assert.equal(rows[0].cpuSeconds, 62.5);
  assert.equal(rows[1].cpuSeconds, 93784);
  assert.equal(rows[0].rssBytes, 2097152);
  assert.deepEqual(parseProcessTable(''), []);
  assert.throws(() => parseProcessTable('garbage'));
  assert.throws(() => parseProcessTable('12 1 -8 0:00 Sun Sep 6 05:00:00 2026'));
});
test('descendants are found independent of table order', () => {
  const rows = [{ pid: 30, ppid: 20 }, { pid: 99, ppid: 1 }, { pid: 10, ppid: 1 }, { pid: 20, ppid: 10 }];
  assert.deepEqual(processTree(rows, 10).map(p => p.pid), [30, 10, 20]);
});
test('CPU deltas exclude reused PIDs, new processes and counter regressions', () => {
  const p = (pid, birth, cpuSeconds) => ({ pid, birth, cpuSeconds });
  const before = { elapsedMs: 0, processes: [p(1, 'a', 1), p(2, 'b', 40), p(3, 'c', 8)] };
  const after = { elapsedMs: 1000, processes: [p(1, 'a', 1.5), p(2, 'new', 60), p(3, 'c', 7), p(4, 'd', 90)] };
  assert.equal(cpuPercentBetween(before, after), 50);
  assert.throws(() => cpuPercentBetween(before, before));
});
