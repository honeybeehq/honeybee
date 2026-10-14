import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeSpawn } from "../src/daemon.ts";
import { BUILTIN_AGENTS } from "../src/config.ts";
import type { HarnessAdapter } from "../../adapters/src/index.ts";
import type { AccountGetResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_MUSE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-muse.mjs");
const USAGE_FIXTURE = join(here, "..", "..", "adapters", "tests", "fixtures", "muse-usage-changed.jsonl");

const GATEWAY = { name: "apiary", command: "/usr/bin/node", args: ["shim.mjs"], env: [{ name: "HONEYBEE_GATEWAY", value: "apiary" }] };

function setupRequest(adapter: HarnessAdapter | null): { method: string; params: Record<string, unknown> } {
  assert.ok(adapter);
  const signals = adapter.parseLine(JSON.stringify({ id: JSON.parse(adapter.bootLines()[0]!).id, jsonrpc: "2.0", result: {} }));
  if (signals[0]?.kind !== "respond") assert.fail();
  return JSON.parse(signals[0].lines[1]!);
}

test("Muse serves MSP with yolo, model and effort lifted off argv and gateways in session/start", () => {
  const spec = BUILTIN_AGENTS.muse;
  assert.ok(spec, "Muse must be a built-in agent");
  const plan = composeSpawn(spec, "muse", {
    cwd: "/work",
    args: ["--yolo", "--model", "muse-spark-1.2", "--effort", "low", "--model", "muse-spark-1.3", "--provider", "echo"],
    providerSessionId: null,
  }, [GATEWAY]);
  assert.deepEqual(plan.args, [
    "serve", "-c", "context.foreign_personal_rules=false", "-c", "context.foreign_personal_skills=false",
    "--provider", "echo", "--disable-sandbox", "--trust-workspace",
  ]);
  assert.equal(plan.model, "muse-spark-1.3");
  const start = setupRequest(plan.adapter);
  assert.equal(start.method, "session/start");
  assert.equal(start.params.workspaceRoot, "/work");
  assert.equal(start.params.approvalMode, "allowAll");
  assert.equal(start.params.modelId, "muse-spark-1.3");
  assert.deepEqual(Object.keys((start.params.config as { mcpServers: object }).mcpServers), ["apiary"]);
  const turn = JSON.parse(plan.adapter!.encodeMessage("hi", { sessionId: "s", messageId: 1, turnActive: false, turnId: null })!);
  assert.equal(turn.params.reasoningEffort, "low");
});

test("Muse revives through session/resume on the recorded provider session", () => {
  const spec = BUILTIN_AGENTS.muse;
  assert.ok(spec);
  const plan = composeSpawn(spec, "muse", { cwd: "/work", args: null, providerSessionId: "01a133e2-6725-7481-a1f9-1b611f7748be" }, [GATEWAY]);
  assert.equal(plan.args.includes("--resume"), false);
  const resume = setupRequest(plan.adapter);
  assert.equal(resume.method, "session/resume");
  assert.equal(resume.params.sessionId, "01a133e2-6725-7481-a1f9-1b611f7748be");
  assert.deepEqual(Object.keys((resume.params.config as { mcpServers: object }).mcpServers), ["apiary"]);
});

test("Muse usage/changed and a quota terminal from a running bee land on its account's limits row (fake muse serve, real daemon)", async () => {
  // The schema-shaped recording (usage/changed, then a quota-exhausted turn),
  // re-dated so the observation precedes the quota the driver stamps now.
  const [usageLine, , quotaLine] = readFileSync(USAGE_FIXTURE, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const observedAtMs = Date.now() - 60_000;
  const resetsAtMs = Date.now() + 3_600_000;
  usageLine.params = { ...usageLine.params, observedAtMs, window: { ...usageLine.params.window, resetsAtMs } };
  quotaLine.params.error.quota.resetsAtMs = resetsAtMs;
  const recordedDir = mkdtempSync(join(tmpdir(), "hb-v2-muse-usage-"));
  const recordedPath = join(recordedDir, "recorded.jsonl");
  writeFileSync(recordedPath, `${JSON.stringify(usageLine)}\n${JSON.stringify(quotaLine)}\n`);
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      muse: { command: process.execPath, args: [FAKE_MUSE, "serve"], adapter: "muse", env: { MUSE_NO_AUTO_UPDATE: "1", FAKE_MUSE_RECORDED: recordedPath } },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const id = "muse-sub";
    const credential = JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "fixture-key" } } });
    for (const base of [join(dir, "homes", id, "muse"), join(dir, "vault", "muse", id, "muse")]) {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "auth.json"), credential);
    }
    await client.request("account.add", { harness: "muse", label: "sub", importExisting: true });
    const limits = async () => (await client.request<AccountGetResult>("account.get", { id })).limits;
    const before = await limits();
    assert.ok(before === null || before.readable === false, "no observation yet: no readable limits");

    const spawned = await client.request<SpawnResult>("spawn", { name: "muser", agent: "muse", cwd: dir, account: id, tags: ["autoswap=false"] });
    await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "first turn" });
    const observed = await waitFor(async () => {
      const row = await limits();
      return row?.readable ? row : null;
    }, "usage/changed lands on the account", 15_000);
    assert.deepEqual(
      [observed.fetchedAt, observed.plan, observed.fiveHourPct, observed.fiveHourResetsAt, observed.fiveHourMinutes, observed.weeklyPct],
      [observedAtMs, "fixture-tier-from-provider", 37, resetsAtMs, 300, 12],
    );

    await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "second turn" });
    const exhausted = await waitFor(async () => {
      const row = await limits();
      return row && row.fiveHourPct === 100 ? row : null;
    }, "quota marks the observed window used up", 15_000);
    assert.ok(exhausted.fetchedAt > observedAtMs);
    assert.equal(exhausted.weeklyPct, 12);
    const view = await client.request<ViewResult>("view", { beeId: spawned.beeId });
    assert.ok(view.view.flags.includes("resource_blocked"));
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(recordedDir, { recursive: true, force: true });
  }
});
