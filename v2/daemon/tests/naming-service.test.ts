import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ResolvedNamingConfig } from "../src/config.ts";
import type { RecordNamingUsageInput } from "../../core/src/index.ts";
import { openAiNamingRates, TitleGeneratorService } from "../src/namingService.ts";
import { HemSecretResolver, type HemGetOutput } from "../src/hemSecret.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = join(HERE, "fixtures", "fake-naming-codex.mjs");

function config(overrides: Partial<ResolvedNamingConfig> = {}): ResolvedNamingConfig {
  return {
    auto: true,
    backend: "codex-app-server",
    tool: "codex",
    model: "gpt-6-luna",
    effort: "none",
    generatorCwd: tmpdir(),
    ...overrides,
  };
}

test("naming telemetry uses GPT-6 Astra standard nano-USD rates", () => {
  assert.deepEqual(openAiNamingRates("gpt-6-astra"), {
    inputNanoUsd: 10_000,
    cachedInputNanoUsd: 1_000,
    cacheWriteNanoUsd: 12_500,
    outputNanoUsd: 50_000,
  });
});

test("naming telemetry uses GPT-6 Sol and GPT-6 Luna standard nano-USD rates", () => {
  // developers.openai.com/api/docs/pricing, 2026-09-23, standard tier, short context.
  assert.deepEqual(openAiNamingRates("gpt-6-sol"), {
    inputNanoUsd: 2_000,
    cachedInputNanoUsd: 200,
    cacheWriteNanoUsd: 2_500,
    outputNanoUsd: 10_000,
  });
  assert.deepEqual(openAiNamingRates("gpt-6-luna"), {
    inputNanoUsd: 100,
    cachedInputNanoUsd: 10,
    cacheWriteNanoUsd: 125,
    outputNanoUsd: 500,
  });
});

test("naming telemetry has no rates for unknown models", () => {
  assert.equal(openAiNamingRates("gpt-7-nova"), null);
  assert.equal(openAiNamingRates(""), null);
});

/** 120 input (20 cached, 10 cache-write, 90 uncached) + 6 output tokens. */
const USAGE_BODY = {
  input_tokens: 120,
  input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
  output_tokens: 6,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 126,
};

async function priceThroughApi(model: string): Promise<RecordNamingUsageInput> {
  const usageRows: RecordNamingUsageInput[] = [];
  const times = [5_000, 5_050];
  const service = new TitleGeneratorService({
    fetchImpl: async () => new Response(JSON.stringify({
      id: `resp_${model}`,
      output: [{ type: "message", content: [{ type: "output_text", text: "Priced Title" }] }],
      usage: USAGE_BODY,
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `req_${model}` } }),
    now: () => times.shift() ?? 5_050,
    recordUsage: (usage) => usageRows.push(usage),
  });
  try {
    assert.equal(await service.generate({ beeId: "bee-priced", userMessages: ["Price me"] }, config({ backend: "openai-api", apiKey: "sk-test", model })), "Priced Title");
  } finally {
    service.close();
  }
  assert.equal(usageRows.length, 1);
  return usageRows[0]!;
}

test("naming service prices a GPT-6 Sol usage body at the published rates", async () => {
  const row = await priceThroughApi("gpt-6-sol");
  assert.equal(row.model, "gpt-6-sol");
  assert.equal(row.inputRateNanoUsd, 2_000);
  assert.equal(row.cachedInputRateNanoUsd, 200);
  assert.equal(row.cacheWriteRateNanoUsd, 2_500);
  assert.equal(row.outputRateNanoUsd, 10_000);
  // 90 * 2_000 + 20 * 200 + 10 * 2_500 + 6 * 10_000
  assert.equal(row.estimatedCostNanoUsd, 269_000);
});

test("naming service prices a GPT-6 Luna usage body at the published rates", async () => {
  const row = await priceThroughApi("gpt-6-luna");
  assert.equal(row.model, "gpt-6-luna");
  assert.equal(row.inputRateNanoUsd, 100);
  assert.equal(row.cachedInputRateNanoUsd, 10);
  assert.equal(row.cacheWriteRateNanoUsd, 125);
  assert.equal(row.outputRateNanoUsd, 500);
  // 90 * 100 + 20 * 10 + 10 * 125 + 6 * 500
  assert.equal(row.estimatedCostNanoUsd, 13_450);
});

test("naming service records null rates and cost for an unknown model but keeps its tokens", async () => {
  const row = await priceThroughApi("gpt-7-nova");
  assert.equal(row.model, "gpt-7-nova");
  assert.equal(row.status, "succeeded");
  assert.equal(row.inputTokens, 120);
  assert.equal(row.outputTokens, 6);
  assert.equal(row.inputRateNanoUsd, null);
  assert.equal(row.cachedInputRateNanoUsd, null);
  assert.equal(row.cacheWriteRateNanoUsd, null);
  assert.equal(row.outputRateNanoUsd, null);
  assert.equal(row.estimatedCostNanoUsd, null);
});

test("naming service preserves the initial Linear issue even when the model omits it", async () => {
  const service = new TitleGeneratorService({
    fetchImpl: async () => new Response(JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: "Atomic Model Changes Admission" }] }],
    }), { status: 200 }),
  });
  try {
    const title = await service.generate({
      userMessages: ["https://linear.app/honeybee-hq/issue/APY-9/make-model-changes-atomic-with-honeybee-working-state-admission"],
    }, config({ backend: "openai-api", apiKey: "sk-test" }));
    assert.equal(title, "APY-9: Atomic Model Changes Admission");
  } finally {
    service.close();
  }
});

test("naming service keeps one Codex app-server warm and isolates titles in ephemeral threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-naming-service-"));
  const logPath = join(dir, "rpc.jsonl");
  const previous = process.env.FAKE_NAMING_CODEX_LOG;
  process.env.FAKE_NAMING_CODEX_LOG = logPath;
  const service = new TitleGeneratorService({
    codexCommand: process.execPath,
    codexArgs: [FAKE_CODEX],
    timeoutMs: 5_000,
  });
  try {
    const generatorCwd = join(dir, "fresh-generator-cwd");
    assert.equal(await service.generate({ userMessages: ["Fix auto naming"] }, config({ generatorCwd })), "Warm Naming Service");
    assert.equal(await service.generate({ userMessages: ["Fix APY-9"] }, config({ generatorCwd })), "APY-9: Warm Naming Service");
    assert.equal(existsSync(generatorCwd), true);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.method === "initialize").length, 1);
    const threads = calls.filter((call) => call.method === "thread/start");
    assert.equal(threads.length, 2);
    assert.ok(threads.every((call) => call.params.ephemeral === true));
    assert.ok(threads.every((call) => call.params.baseInstructions && call.params.developerInstructions));
    const turns = calls.filter((call) => call.method === "turn/start");
    assert.equal(turns.length, 2);
    assert.ok(turns.every((call) => call.params.effort === "none"));
  } finally {
    service.close();
    if (previous === undefined) delete process.env.FAKE_NAMING_CODEX_LOG;
    else process.env.FAKE_NAMING_CODEX_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("naming service calls Responses API without exposing the configured key in output", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const usageRows: RecordNamingUsageInput[] = [];
  const times = [1_000, 1_123];
  const service = new TitleGeneratorService({
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({
        id: "resp_naming_1",
        output: [{ type: "message", content: [{ type: "output_text", text: "Direct Luna Naming" }] }],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
          output_tokens: 6,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 126,
        },
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_naming_1" } });
    },
    now: () => times.shift() ?? 1_123,
    recordUsage: (usage) => usageRows.push(usage),
  });
  const apiKey = "sk-test-write-only";
  try {
    const title = await service.generate(
      { beeId: "bee-1", userMessages: ["Name this through the API"] },
      config({ backend: "openai-api", apiKey }),
    );
    assert.equal(title, "Direct Luna Naming");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "https://api.openai.com/v1/responses");
    assert.equal((requests[0]?.init?.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
    const body = JSON.parse(String(requests[0]?.init?.body));
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.reasoning.effort, "none");
    assert.equal(body.store, false);
    assert.doesNotMatch(JSON.stringify({ title }), /sk-test-write-only/);
    assert.deepEqual(usageRows, [{
      beeId: "bee-1",
      backend: "openai-api",
      provider: "openai",
      model: "gpt-6-luna",
      status: "succeeded",
      latencyMs: 123,
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
      estimatedCostNanoUsd: 13_450,
      responseId: "resp_naming_1",
      requestId: "req_naming_1",
      error: null,
      recordedAt: 1_123,
    }]);
  } finally {
    service.close();
  }
});

test("naming service records failed direct API attempts without hiding their latency", async () => {
  const usageRows: RecordNamingUsageInput[] = [];
  const times = [2_000, 2_250];
  const service = new TitleGeneratorService({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "x-request-id": "req_failed" },
    }),
    now: () => times.shift() ?? 2_250,
    recordUsage: (usage) => usageRows.push(usage),
  });
  try {
    await assert.rejects(
      service.generate({ beeId: "bee-2", userMessages: ["Name it"] }, config({ backend: "openai-api", apiKey: "sk-test" })),
      /rate limited/,
    );
    assert.equal(usageRows.length, 1);
    assert.deepEqual(usageRows[0], {
      beeId: "bee-2",
      backend: "openai-api",
      provider: "openai",
      model: "gpt-6-luna",
      status: "failed",
      latencyMs: 250,
      responseId: null,
      requestId: "req_failed",
      error: "OpenAI API naming failed (429): rate limited",
      recordedAt: 2_250,
    });
  } finally {
    service.close();
  }
});

test("naming service restarts the warm app-server after an unexpected exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hive-naming-restart-"));
  const logPath = join(dir, "rpc.jsonl");
  const previousLog = process.env.FAKE_NAMING_CODEX_LOG;
  const previousExit = process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN;
  process.env.FAKE_NAMING_CODEX_LOG = logPath;
  process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN = "1";
  const service = new TitleGeneratorService({
    codexCommand: process.execPath,
    codexArgs: [FAKE_CODEX],
    timeoutMs: 5_000,
  });
  try {
    assert.equal(await service.generate({ userMessages: ["First title"] }, config()), "Warm Naming Service");
    await new Promise((resolve) => setTimeout(resolve, 30));
    delete process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN;
    assert.equal(await service.generate({ userMessages: ["Second title"] }, config()), "Warm Naming Service");
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.filter((call) => call.method === "initialize").length, 2);
  } finally {
    service.close();
    if (previousLog === undefined) delete process.env.FAKE_NAMING_CODEX_LOG;
    else process.env.FAKE_NAMING_CODEX_LOG = previousLog;
    if (previousExit === undefined) delete process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN;
    else process.env.FAKE_NAMING_CODEX_EXIT_AFTER_TURN = previousExit;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openai-api naming resolves apiKeyRef through hem lazily, caches it, and never leaks it in errors", async () => {
  const hemKey = "sk-from-hem-0123456789abcdef";
  const hemCalls: string[][] = [];
  let clock = 0;
  let hemReply: HemGetOutput = { ok: true, stdout: `${hemKey}\n`, stderr: "", timedOut: false };
  const hemSecrets = new HemSecretResolver({
    locateHem: () => "/fake/hem",
    now: () => clock,
    cacheTtlMs: 1_000,
    failureHoldMs: 500,
    approvalHoldMs: 10_000,
    run: async (command, args) => {
      hemCalls.push([command, ...args]);
      return hemReply;
    },
  });
  const authorizations: string[] = [];
  let openAiStatus = 200;
  const service = new TitleGeneratorService({
    hemSecrets,
    fetchImpl: async (_input, init) => {
      authorizations.push(String((init?.headers as Record<string, string>).authorization));
      if (openAiStatus === 401) {
        return new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-from***cdef" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "Hem Keyed Title" }] }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const refConfig = config({ backend: "openai-api", apiKeyRef: "global/hive-naming-openai" });
  const name = () => service.generate({ beeId: "bee-hem", userMessages: ["Name it"] }, refConfig);
  const rejectsWith = (pattern: RegExp) =>
    assert.rejects(name(), (error: Error) => pattern.test(error.message) && !error.message.includes("sk-from"));
  try {
    assert.equal(await name(), "Hem Keyed Title");
    assert.equal(await name(), "Hem Keyed Title");
    assert.deepEqual(hemCalls, [["/fake/hem", "get", "global/hive-naming-openai", "api_key"]]);
    assert.deepEqual(authorizations, [`Bearer ${hemKey}`, `Bearer ${hemKey}`]);

    openAiStatus = 401;
    await rejectsWith(/^OpenAI API naming failed \(401\): the API key was rejected$/);
    openAiStatus = 200;
    await rejectsWith(/hem ref "global\/hive-naming-openai" holds a key OpenAI rejected/);
    assert.equal(hemCalls.length, 1, "a rejected key is held, not re-read at once");
    clock += 1_000;
    assert.equal(await name(), "Hem Keyed Title");
    assert.equal(hemCalls.length, 2, "a rejected key is re-read from hem after the hold");

    for (const stdout of ["[\"sk-from-hem-0123456789abcdef\"]\n", " sk-from-hem-0123456789abcdef\n", "{\"pending\":1}\n", "short\n"]) {
      clock += 2_000;
      hemReply = { ok: true, stdout, stderr: "", timedOut: false };
      await rejectsWith(/hem ref "global\/hive-naming-openai" did not return a plain secret value/);
    }

    clock += 2_000;
    hemReply = { ok: true, stdout: "status: PendingApproval, pending_request_id: apr_1\n", stderr: "", timedOut: false };
    await rejectsWith(/waiting for approval/);
    const callsWhilePending = hemCalls.length;
    clock += 5_000;
    await rejectsWith(/waiting for approval/);
    assert.equal(hemCalls.length, callsWhilePending, "a pending approval is not re-asked");

    clock += 10_000;
    hemReply = { ok: true, stdout: "sk-approval_required-0123456789\n", stderr: "", timedOut: false };
    assert.equal(await name(), "Hem Keyed Title", "a valid value is never mistaken for a pending approval");
    assert.equal(authorizations.at(-1), "Bearer sk-approval_required-0123456789");
    service.reconfigure(refConfig);

    clock += 10_000;
    hemReply = { ok: false, stdout: "", stderr: 'status: NotFound, message: "secret not found: global/hive-naming-openai"', timedOut: false };
    await rejectsWith(/requires a configured API key: hem ref "global\/hive-naming-openai" could not be read: secret not found/);
  } finally {
    service.close();
  }
});

test("hem resolver refuses refs outside the naming allowlist without running hem", async () => {
  let ran = 0;
  const hemSecrets = new HemSecretResolver({
    locateHem: () => "/fake/hem",
    run: async () => {
      ran += 1;
      return { ok: true, stdout: "sk-should-never-be-read-000\n", stderr: "", timedOut: false };
    },
  });
  for (const ref of ["global/openai-prod", "project/x/hive-naming-a", "global/hive-naming-a --token y", "-global/hive-naming-a"]) {
    await assert.rejects(hemSecrets.resolve(ref), /not an allowed naming secret reference/);
  }
  assert.equal(ran, 0);
});

test("openai-api transport errors never carry the key", async () => {
  const apiKey = "sk-plain-key-with-a-control-char\n";
  const service = new TitleGeneratorService({
    fetchImpl: async (_input, init) => {
      throw new TypeError(`Headers.append: "${String((init?.headers as Record<string, string>).authorization)}" is an invalid header value.`);
    },
  });
  try {
    await assert.rejects(
      service.generate({ beeId: "bee-bad-key", userMessages: ["Name it"] }, config({ backend: "openai-api", apiKey })),
      (error: Error) => error.message === "OpenAI API request failed: network or request error",
    );
  } finally {
    service.close();
  }
});
