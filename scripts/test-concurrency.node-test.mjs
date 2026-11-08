import assert from "node:assert/strict";
import { test } from "node:test";
import { testConcurrency } from "./test-env.mjs";

test("test files use spare CPUs with an eight-worker ceiling and always make progress", () => {
  for (const [cpuCount, load, expected] of [[1, 0, 1], [64, 0, 8], [4, 1.6, 2], [10, 9.2, 1], [10, 10, 1], [10, 30, 1]]) {
    assert.equal(testConcurrency({ env: {}, cpuCount, load }), expected);
  }
});

test("an explicit test concurrency overrides automatic load selection", () => {
  assert.equal(testConcurrency({ env: { HIVE_TEST_CONCURRENCY: " 3 " }, cpuCount: 1, load: 30 }), 3);
  assert.equal(testConcurrency({ env: { HIVE_TEST_CONCURRENCY: " " }, cpuCount: 4, load: 1 }), 3);
});

test("invalid explicit test concurrency fails before starting workers", () => {
  for (const value of ["0", "-1", "1.5", "invalid", "Infinity"]) {
    assert.throws(() => testConcurrency({ env: { HIVE_TEST_CONCURRENCY: value }, cpuCount: 4, load: 0 }), /positive integer/);
  }
});
