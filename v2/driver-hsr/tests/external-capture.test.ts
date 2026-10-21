import { test } from "node:test";
import assert from "node:assert/strict";
import { ExternalCapture, EXTERNAL_DRAIN_PASSES } from "../src/externalCapture.ts";

test("raw and operational capture caps are independent, sticky and bounded", () => {
  const budget = new ExternalCapture(4);
  assert.equal(budget.take("stdout.raw", 3), 3);
  assert.equal(budget.take("stdout.raw", 3), 1);
  assert.equal(budget.take("stdout.raw", 100000000), 0);
  assert.equal(budget.take("stderr.raw", 4), 4);
  assert.equal(budget.take("bridge-stderr.raw", 5), 4);
  assert.equal(budget.truncated, true);
  assert.deepEqual(budget.snapshot().streams, {
    "stdout.raw": {bytes: 4, truncated: true},
    "stderr.raw": {bytes: 4, truncated: false},
    "bridge-stderr.raw": {bytes: 4, truncated: true},
  });
  assert.equal(EXTERNAL_DRAIN_PASSES, 32);
});
