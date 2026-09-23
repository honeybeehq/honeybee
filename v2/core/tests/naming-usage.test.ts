import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SCHEMA_VERSION } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

test("v14 naming usage keeps immutable priced and unpriced attempts with an all-time aggregate", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "named");
    const first = store.recordNamingUsage({
      beeId: bee.id,
      backend: "openai-api",
      provider: "openai",
      model: "gpt-6-luna",
      status: "succeeded",
      latencyMs: 980,
      inputTokens: 120,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 6,
      reasoningTokens: 0,
      totalTokens: 126,
      inputRateNanoUsd: 100,
      cachedInputRateNanoUsd: 10,
      cacheWriteRateNanoUsd: 125,
      outputRateNanoUsd: 500,
      // 90 * 100 + 20 * 10 + 10 * 125 + 6 * 500 at gpt-6-luna standard rates.
      estimatedCostNanoUsd: 13_450,
      responseId: "resp_1",
      requestId: "req_1",
      recordedAt: 1_000,
    });
    store.recordNamingUsage({
      beeId: bee.id,
      backend: "openai-api",
      provider: "openai",
      model: "gpt-6-luna",
      status: "failed",
      latencyMs: 300,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      inputRateNanoUsd: 100,
      outputRateNanoUsd: 500,
      estimatedCostNanoUsd: 2_000,
      error: "no usable title",
      recordedAt: 2_000,
    });
    store.recordNamingUsage({
      beeId: bee.id,
      backend: "codex-app-server",
      provider: "openai",
      model: "gpt-6-luna",
      status: "succeeded",
      latencyMs: 750,
      recordedAt: 3_000,
    });

    assert.equal(first.requestId, "req_1");
    assert.deepEqual(store.listNamingUsage().map((row) => row.recordedAt), [3_000, 2_000, 1_000]);
    const summary = store.namingUsageSummary();
    assert.deepEqual(
      {
        requests: summary.requests,
        succeeded: summary.succeeded,
        failed: summary.failed,
        pricedRequests: summary.pricedRequests,
        unpricedRequests: summary.unpricedRequests,
        estimatedCostNanoUsd: summary.estimatedCostNanoUsd,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        averageLatencyMs: summary.averageLatencyMs,
        firstRecordedAt: summary.firstRecordedAt,
        lastRecordedAt: summary.lastRecordedAt,
      },
      {
        requests: 3,
        succeeded: 2,
        failed: 1,
        pricedRequests: 2,
        unpricedRequests: 1,
        estimatedCostNanoUsd: 15_450,
        inputTokens: 130,
        outputTokens: 8,
        averageLatencyMs: 2030 / 3,
        firstRecordedAt: 1_000,
        lastRecordedAt: 3_000,
      },
    );
    assert.deepEqual(
      summary.byModel.map((row) => [row.backend, row.model, row.requests, row.pricedRequests, row.estimatedCostNanoUsd]),
      [
        ["openai-api", "gpt-6-luna", 2, 2, 15_450],
        ["codex-app-server", "gpt-6-luna", 1, 0, 0],
      ],
    );

    store.deleteBee(bee.id);
    assert.equal(store.listNamingUsage().length, 3, "bee deletion retains historical spend");
    store.close();
  } finally {
    h.cleanup();
  }
});

test("v14 migration creates naming_usage without inventing historical spend", () => {
  const h = harness();
  try {
    const initial = h.open();
    initial.close();
    const old = new DatabaseSync(h.path);
    old.prepare("UPDATE meta SET value = '13' WHERE key = 'schema_version'").run();
    old.exec("DROP TABLE naming_usage");
    old.close();

    const migrated = h.open();
    assert.equal(migrated.namingUsageSummary().requests, 0);
    migrated.close();
    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const table = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'naming_usage'").get();
      assert.ok(table);
      assert.equal(
        (check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
        String(SCHEMA_VERSION),
      );
    } finally {
      check.close();
    }
  } finally {
    h.cleanup();
  }
});

test("naming usage keeps unknown-model attempts unpriced with null rates", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "unpriced");
    const row = store.recordNamingUsage({
      beeId: bee.id,
      backend: "openai-api",
      provider: "openai",
      model: "gpt-7-nova",
      status: "succeeded",
      latencyMs: 400,
      inputTokens: 50,
      outputTokens: 4,
      totalTokens: 54,
      inputRateNanoUsd: null,
      cachedInputRateNanoUsd: null,
      cacheWriteRateNanoUsd: null,
      outputRateNanoUsd: null,
      estimatedCostNanoUsd: null,
      recordedAt: 9_000,
    });
    assert.equal(row.inputRateNanoUsd, null);
    assert.equal(row.outputRateNanoUsd, null);
    assert.equal(row.estimatedCostNanoUsd, null);
    const summary = store.namingUsageSummary();
    assert.equal(summary.pricedRequests, 0);
    assert.equal(summary.unpricedRequests, 1);
    assert.equal(summary.estimatedCostNanoUsd, 0);
    assert.deepEqual(
      summary.byModel.map((r) => [r.model, r.pricedRequests, r.unpricedRequests, r.estimatedCostNanoUsd]),
      [["gpt-7-nova", 0, 1, 0]],
    );
    store.close();
  } finally {
    h.cleanup();
  }
});
