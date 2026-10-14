import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ROLE_CONTEXT_POLICY,
  claudeContextLaunch,
  roleOfTags,
  contextPolicyConfigOf,
  contextPolicyFacts,
  contextPolicyOf,
  ContextPolicyError,
  effectiveContextPolicy,
  modelForWindow,
  workspaceOfTags,
  writeContextPolicy,
} from "../src/contextPolicy.ts";
import { ConfigError, loadNodeConfig } from "../src/config.ts";
import type { ContextPolicyResult, ContextPolicySetResult, DeployInfoResult, MailboxResult, SendRpcResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = join(here, "..", "..", "driver-hsr", "test-agent", "fake-claude.mjs");

test("context policy fields are validated and closed", () => {
  assert.deepEqual(contextPolicyOf({ window: "200k", autoCompactWindow: 150_000, autoCompactPercent: 80 }, "p"), { window: "200k", autoCompactWindow: 150_000, autoCompactPercent: 80 });
  assert.deepEqual(contextPolicyOf({}, "p"), {});
  for (const bad of [null, [], "1m", { window: "2m" }, { autoCompactWindow: 99_999 }, { autoCompactWindow: 1_000_001 }, { autoCompactWindow: 150_000.5 }, { autoCompactPercent: 0 }, { autoCompactPercent: 101 }, { threshold: 1 }]) {
    assert.throws(() => contextPolicyOf(bad, "p"), ContextPolicyError, JSON.stringify(bad));
  }
});

test("facts follow Claude Code's threshold rule: window minus the 20k output reserve and 13k buffer, lowered by the percent override", () => {
  assert.deepEqual(contextPolicyFacts({}), { window: null, windowTokens: null, autoCompactWindow: null, autoCompactPercent: null, thresholdTokens: null });
  assert.equal(contextPolicyFacts({ window: "1m" }).thresholdTokens, null, "auto window is Claude's choice");
  assert.deepEqual(contextPolicyFacts({ window: "200k" }), { window: "200k", windowTokens: 200_000, autoCompactWindow: 200_000, autoCompactPercent: null, thresholdTokens: 167_000 });
  assert.equal(contextPolicyFacts({ window: "1m", autoCompactWindow: 400_000 }).thresholdTokens, 367_000);
  assert.deepEqual(contextPolicyFacts({ window: "200k", autoCompactWindow: 400_000 }), { window: "200k", windowTokens: 200_000, autoCompactWindow: 200_000, autoCompactPercent: null, thresholdTokens: 167_000 }, "clamped to the model window");
  assert.equal(contextPolicyFacts({ window: "1m", autoCompactWindow: 400_000, autoCompactPercent: 50 }).thresholdTokens, 190_000);
  assert.equal(contextPolicyFacts({ autoCompactWindow: 100_000, autoCompactPercent: 99 }).thresholdTokens, 67_000);
});

test("window variant rewrites the model suffix", () => {
  assert.equal(modelForWindow("opus", "1m"), "opus[1m]");
  assert.equal(modelForWindow("opus[1m]", "1m"), "opus[1m]");
  assert.equal(modelForWindow("claude-opus-5-5[1M]", "200k"), "claude-opus-5-5");
});

test("workspace comes from the apiary workspace tag", () => {
  assert.equal(workspaceOfTags(["team:a", "apiary:workspace=w1"]), "w1");
  assert.equal(workspaceOfTags(["apiary:workspace="]), null);
  assert.equal(workspaceOfTags(["apiary:workspace=__proto__", "apiary:workspace=w2"]), "w2");
  assert.equal(workspaceOfTags([]), null);
});

test("workspace policy overrides the node default field by field", () => {
  const config = contextPolicyConfigOf({ contextPolicy: { default: { window: "1m", autoCompactPercent: 90 }, workspaces: { w1: { window: "200k" } } } });
  assert.deepEqual(effectiveContextPolicy(config, "w1"), { window: "200k", autoCompactPercent: 90 });
  assert.deepEqual(effectiveContextPolicy(config, "w2"), { window: "1m", autoCompactPercent: 90 });
  assert.deepEqual(effectiveContextPolicy(config, null), { window: "1m", autoCompactPercent: 90 });
});

test("claude launch: env and model per policy; per-bee env wins", () => {
  const home = mkdtempSync(join(tmpdir(), "hb-ctx-home-"));
  try {
    writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "sonnet[1m]" }));
    const env = { CLAUDE_CONFIG_DIR: home };
    assert.deepEqual(claudeContextLaunch({}, [], env, null), { modelArgs: [], env: {}, unset: [] });
    assert.deepEqual(claudeContextLaunch({ window: "200k" }, [], env, null), {
      modelArgs: ["--model", "sonnet"],
      env: { CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: "200000" },
      unset: [],
    });
    assert.deepEqual(claudeContextLaunch({ window: "1m", autoCompactWindow: 300_000, autoCompactPercent: 70 }, ["--model", "opus"], env, null), {
      modelArgs: ["--model", "opus[1m]"],
      env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000", CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "70" },
      unset: ["CLAUDE_CODE_DISABLE_1M_CONTEXT"],
    });
    assert.deepEqual(claudeContextLaunch({ window: "1m", autoCompactPercent: 70 }, [], {}, { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "5", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1" }), {
      modelArgs: ["--model", "opus[1m]"],
      env: {},
      unset: [],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("writeContextPolicy keeps other config keys and clears empty scopes", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-ctx-cfg-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ tickMs: 20, naming: { auto: false } }));
    writeContextPolicy(path, { workspace: "w1" }, { window: "200k" });
    writeContextPolicy(path, null, { autoCompactPercent: 80 });
    let raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.tickMs, 20);
    assert.deepEqual(raw.naming, { auto: false });
    assert.deepEqual(raw.contextPolicy, { default: { autoCompactPercent: 80 }, workspaces: { w1: { window: "200k" } } });
    assert.deepEqual(loadNodeConfig(dir).contextPolicy, raw.contextPolicy);
    writeContextPolicy(path, { workspace: "w1" }, null);
    writeContextPolicy(path, null, {});
    raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal("contextPolicy" in raw, false);
    writeFileSync(path, JSON.stringify({ contextPolicy: { workspaces: { w1: { window: "3m" } } } }));
    assert.throws(() => loadNodeConfig(dir), ConfigError);
    writeFileSync(path, '{"contextPolicy":{"workspaces":{"__proto__":{"window":"1m"}}}}');
    assert.throws(() => loadNodeConfig(dir), ConfigError);
    assert.throws(() => writeContextPolicy(path, { workspace: "constructor" }, { window: "1m" }), ContextPolicyError);
    assert.deepEqual(effectiveContextPolicy(contextPolicyConfigOf({ contextPolicy: { workspaces: { w1: { window: "1m" } } } }), "constructor"), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contextPolicy.get/set over RPC; a tagged claude bee boots with the workspace policy", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-ctx-rpc-"));
  const argvLog = join(root, "argv.jsonl");
  const claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("context.policy.v1"));

    const empty = await client.request<ContextPolicyResult>("contextPolicy.get", { workspace: "w1" });
    assert.deepEqual({ ...empty, configPath: undefined }, {
      workspace: "w1", stored: null, default: null, role: null, rolePolicy: null, rolePolicyBuiltin: false, effective: {},
      facts: { window: null, windowTokens: null, autoCompactWindow: null, autoCompactPercent: null, thresholdTokens: null },
      configPath: undefined,
    });

    const set = { workspace: "w1", policy: { window: "200k", autoCompactPercent: 50 }, idempotencyKey: "ctx-1" };
    const applied = await client.request<ContextPolicySetResult>("contextPolicy.set", set);
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.stored, { window: "200k", autoCompactPercent: 50 });
    assert.equal(applied.facts.thresholdTokens, 90_000);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).contextPolicy, { workspaces: { w1: { window: "200k", autoCompactPercent: 50 } } });
    const replay = await client.request<ContextPolicySetResult>("contextPolicy.set", set);
    assert.equal(replay.deduped, true);
    const same = await client.request<ContextPolicySetResult>("contextPolicy.set", { workspace: "w1", policy: { autoCompactPercent: 50, window: "200k" } });
    assert.equal(same.applied, false);
    await assert.rejects(() => client.request("contextPolicy.set", { workspace: "w1", policy: { window: "2m" } }), (e: Error & { code?: string }) => e.code === "invalid_request");
    await assert.rejects(() => client.request("contextPolicy.set", { workspace: "w1" }), (e: Error & { code?: string }) => e.code === "invalid_request");
    await assert.rejects(() => client.request("contextPolicy.set", { workspace: "", policy: null }), (e: Error & { code?: string }) => e.code === "invalid_request");
    await assert.rejects(() => client.request("contextPolicy.set", { workspace: "__proto__", policy: { window: "1m" } }), (e: Error & { code?: string }) => e.code === "invalid_request");

    const tagged = await client.request<SpawnResult>("spawn", { name: "ctx", agent: "claude", cwd: root, args: ["--model", "opus[1m]"], tags: ["apiary:workspace=w1"], env: { CLAUDE_CONFIG_DIR: claudeHome } });
    const plain = await client.request<SpawnResult>("spawn", { name: "plain", agent: "claude", cwd: root, tags: ["apiary:workspace=w2"], env: { CLAUDE_CONFIG_DIR: claudeHome } });
    const hellos = new Map<string, number>();
    for (const beeId of [tagged.beeId, plain.beeId]) {
      hellos.set(beeId, (await client.request<SendRpcResult>("send", { beeId, body: "hello" })).messageId);
    }
    type Boot = { argv: string[]; env: Record<string, string | null> };
    const boots = (): Boot[] => existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Boot) : [];
    await waitFor(async () => boots().length >= 2, "both claude bees booted");
    const byBee = (beeId: string): Boot => boots().find((b) => b.env.HIVE_BEE_ID === beeId)!;
    const t = byBee(tagged.beeId);
    assert.equal(t.argv[t.argv.indexOf("--model") + 1], "opus");
    assert.equal(t.argv.filter((a) => a === "--model").length, 1);
    assert.equal(t.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, "1");
    assert.equal(t.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
    assert.equal(t.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "50");
    const p = byBee(plain.beeId);
    assert.equal(p.argv.includes("--model"), false);
    assert.equal(p.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, null);
    assert.equal(p.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, null);

    const forBee = await client.request<ContextPolicyResult>("contextPolicy.get", { beeId: tagged.beeId });
    assert.equal(forBee.workspace, "w1");
    assert.deepEqual(forBee.bee, { beeId: tagged.beeId, harness: "claude", applies: true, model: "opus" });
    assert.equal(forBee.facts.windowTokens, 200_000);
    const forPlain = await client.request<ContextPolicyResult>("contextPolicy.get", { beeId: plain.beeId });
    assert.deepEqual(forPlain.bee, { beeId: plain.beeId, harness: "claude", applies: true, model: "opus[1m]" });
    await assert.rejects(() => client.request("contextPolicy.get", { beeId: tagged.beeId, workspace: "w1" }), (e: Error & { code?: string }) => e.code === "invalid_request");

    await client.request("contextPolicy.set", { policy: { window: "1m", autoCompactWindow: 300_000 } });
    await client.request("contextPolicy.set", { workspace: "w1", policy: null });
    await waitFor(async () => {
      const mailbox = await client.request<MailboxResult>("mailbox", { beeId: tagged.beeId });
      const delivered = mailbox.messages.find((m) => m.id === hellos.get(tagged.beeId))?.deliveredAt != null;
      return delivered && (await client.request<ViewResult>("view", { beeId: tagged.beeId })).view.runtimeState === "idle";
    }, "first message delivered and answered");
    await client.request("stop", { beeId: tagged.beeId });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: tagged.beeId })).view.runtimeState === "stopped", "stopped");
    await client.request<SendRpcResult>("send", { beeId: tagged.beeId, body: "again" });
    await waitFor(async () => boots().filter((b) => b.env.HIVE_BEE_ID === tagged.beeId).length >= 2, "revived with the new policy");
    const revived = boots().filter((b) => b.env.HIVE_BEE_ID === tagged.beeId).at(-1)!;
    assert.equal(revived.argv[revived.argv.indexOf("--model") + 1], "opus[1m]");
    assert.equal(revived.env.CLAUDE_CODE_DISABLE_1M_CONTEXT, null);
    assert.equal(revived.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
    assert.equal(revived.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, null);
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("champion role: built-in default compacts at 650k on a 1M window; workspace and stored role policy win", () => {
  assert.equal(roleOfTags(["apiary:workspace=w1", "apiary:role=champion"]), "champion");
  assert.equal(roleOfTags(["apiary:role=chief", "apiary:champion=kal"]), null);
  assert.deepEqual(BUILTIN_ROLE_CONTEXT_POLICY.champion, { autoCompactWindow: 683_000 });
  const none = contextPolicyConfigOf({});
  assert.deepEqual(effectiveContextPolicy(none, "w1", "champion"), { autoCompactWindow: 683_000 });
  assert.equal(contextPolicyFacts(effectiveContextPolicy(none, "w1", "champion")).thresholdTokens, 650_000);
  assert.equal(contextPolicyFacts(effectiveContextPolicy(none, "w1", "champion")).thresholdTokens! <= 650_000, true);
  assert.deepEqual(effectiveContextPolicy(none, "w1", null), {});
  assert.equal(contextPolicyFacts({ window: "1m", autoCompactWindow: 683_000 }).thresholdTokens, 650_000);
  const set = contextPolicyConfigOf({ contextPolicy: { default: { autoCompactWindow: 900_000 }, roles: { champion: { autoCompactPercent: 50 } }, workspaces: { w2: { autoCompactWindow: 500_000 } } } });
  assert.deepEqual(effectiveContextPolicy(set, "w1", "champion"), { autoCompactWindow: 900_000, autoCompactPercent: 50 }, "a stored role policy replaces the built-in default");
  assert.deepEqual(effectiveContextPolicy(set, "w2", "champion"), { autoCompactWindow: 500_000, autoCompactPercent: 50 }, "workspace wins");
  assert.deepEqual(effectiveContextPolicy(contextPolicyConfigOf({ contextPolicy: { default: { autoCompactWindow: 900_000 } } }), null, "champion"), { autoCompactWindow: 683_000 }, "the champion default wins over the node default");
  assert.throws(() => contextPolicyConfigOf({ contextPolicy: { roles: { chief: {} } } }), ContextPolicyError);
  assert.deepEqual(claudeContextLaunch(effectiveContextPolicy(none, null, "champion"), ["--model", "opus[1m]"], {}, null), {
    modelArgs: [],
    env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "683000" },
    unset: [],
  });
  assert.deepEqual(claudeContextLaunch(effectiveContextPolicy(none, null, "champion"), [], {}, { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000" }).env, {}, "per-bee env still wins");
});

test("contextPolicy over RPC: a champion-tagged claude bee gets the 650k default, others do not, overrides win", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-ctx-champion-"));
  const argvLog = join(root, "argv.jsonl");
  const claudeHome = join(root, "claude-home");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
  const { dir, cleanup } = makeDaemonDir({
    agents: {
      claude: {
        command: process.execPath,
        args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
        adapter: "claude",
        env: { FAKE_CLAUDE_ARGV_LOG: argvLog },
      },
    },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    assert.ok((await client.request<DeployInfoResult>("deployInfo")).capabilities.includes("context.policy.roles.v1"));
    type Boot = { argv: string[]; env: Record<string, string | null> };
    const boots = (): Boot[] => existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Boot) : [];
    const bootOf = async (beeId: string, count = 1): Promise<Boot> => {
      await waitFor(async () => boots().filter((b) => b.env.HIVE_BEE_ID === beeId).length >= count, `boot ${count} of ${beeId}`);
      return boots().filter((b) => b.env.HIVE_BEE_ID === beeId).at(-1)!;
    };
    const spawn = async (name: string, tags: string[]): Promise<string> => {
      const { beeId } = await client.request<SpawnResult>("spawn", { name, agent: "claude", cwd: root, tags, env: { CLAUDE_CONFIG_DIR: claudeHome } });
      await client.request<SendRpcResult>("send", { beeId, body: "hello" });
      return beeId;
    };
    const champion = await spawn("champ", ["apiary:workspace=w1", "apiary:role=champion"]);
    const worker = await spawn("worker", ["apiary:workspace=w1", "apiary:champion=champ"]);
    assert.equal((await bootOf(champion)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "683000");
    assert.equal((await bootOf(worker)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, null);

    const got = await client.request<ContextPolicyResult>("contextPolicy.get", { beeId: champion });
    assert.equal(got.role, "champion");
    assert.equal(got.rolePolicyBuiltin, true);
    assert.deepEqual(got.rolePolicy, { autoCompactWindow: 683_000 });
    assert.equal(got.facts.thresholdTokens, 650_000);
    assert.equal((await client.request<ContextPolicyResult>("contextPolicy.get", { beeId: worker })).role, null);
    await assert.rejects(() => client.request("contextPolicy.set", { workspace: "w1", role: "champion", policy: null }), (e: Error & { code?: string }) => e.code === "invalid_request");
    await assert.rejects(() => client.request("contextPolicy.set", { role: "chief", policy: null }), (e: Error & { code?: string }) => e.code === "invalid_request");

    const roleSet = await client.request<ContextPolicySetResult>("contextPolicy.set", { role: "champion", policy: { autoCompactWindow: 400_000 } });
    assert.equal(roleSet.applied, true);
    assert.equal(roleSet.rolePolicyBuiltin, false);
    assert.equal(roleSet.facts.thresholdTokens, 367_000);
    const restart = async (beeId: string, count: number): Promise<Boot> => {
      await waitFor(async () => {
        const mailbox = await client.request<MailboxResult>("mailbox", { beeId });
        const settled = mailbox.messages.every((m) => m.deliveredAt != null);
        return settled && (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle";
      }, `${beeId} answered and idle`);
      await client.request("stop", { beeId });
      await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "stopped", `${beeId} stopped`);
      await client.request<SendRpcResult>("send", { beeId, body: "again" });
      return bootOf(beeId, count);
    };
    assert.equal((await restart(champion, 2)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "400000", "stored champion policy replaces the built-in default");

    await client.request("contextPolicy.set", { workspace: "w1", policy: { autoCompactWindow: 900_000 } });
    assert.equal((await restart(champion, 3)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "900000", "workspace policy wins over the champion default");
    assert.equal((await restart(worker, 2)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "900000");

    await client.request("contextPolicy.set", { workspace: "w1", policy: null });
    await client.request("contextPolicy.set", { role: "champion", policy: null });
    assert.equal((await restart(champion, 4)).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "683000", "clearing restores the built-in default");
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
