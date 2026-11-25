import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandsResult, DeployInfoResult, ReconfigureResult, SetEnvResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const VALUE = "fake-apy68-env-value-CAFEBABE";
const code = (expected: string) => (e: Error & { code?: string }) => e.code === expected;

test("bee.setEnv sets env on an existing bee, an env-only reconfigure restarts it, and a later unchanged reconfigure keeps that restart", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    assert.ok((await client.request<DeployInfoResult>("deployInfo")).capabilities.includes("bee.setEnv.v1"));
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "env", agent: "stub", cwd: "/tmp", env: { KEEP: "1" } });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.runtimeState === "idle", "idle", 60_000);

    const set = await client.request<SetEnvResult>("bee.setEnv", { beeId, set: { APIARY_MCP_TOKEN: VALUE }, idempotencyKey: "env-1" });
    assert.equal(set.applied, true);
    assert.deepEqual(set.bee.envKeys, ["APIARY_MCP_TOKEN", "KEEP"]);
    assert.equal((await client.request<SetEnvResult>("bee.setEnv", { beeId, set: { APIARY_MCP_TOKEN: VALUE }, idempotencyKey: "env-1" })).deduped, true);
    assert.equal((await client.request<SetEnvResult>("bee.setEnv", { beeId, set: { APIARY_MCP_TOKEN: VALUE } })).applied, false);
    assert.deepEqual((await client.request<SetEnvResult>("bee.setEnv", { beeId, set: { KEEP: null } })).bee.envKeys, ["APIARY_MCP_TOKEN"]);
    for (const set of [{}, { "BAD NAME": "x" }, { A: 1 }, null]) await assert.rejects(client.request("bee.setEnv", { beeId, set }), code("invalid_request"));

    const before = (await client.request<ViewResult>("view", { beeId })).view.generation!;
    await client.request("send", { beeId, body: "@hang" });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId })).view.working, "busy turn", 60_000);
    const envOnly = await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: null, set: { APIARY_MCP_TOKEN: `${VALUE}-2` } });
    assert.equal(envOnly.outcome, "queued", "an env-only change restarts a live runtime");
    const unchanged = await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: null });
    assert.equal(unchanged.outcome, "queued", "a later unchanged reconfigure keeps the pending env restart");
    assert.equal(unchanged.commandId, envOnly.commandId);
    await client.request("bee.interrupt", { beeId });
    await waitFor(async () => {
      const { view } = await client.request<ViewResult>("view", { beeId });
      return view.generation! > before && view.runtimeState === "idle";
    }, "restarted with the new env", 60_000);

    const log = readFileSync(join(dir, "hived.log"), "utf8");
    assert.ok(log.split("\n").some((line) => line.includes(`bee.setEnv bee=${beeId} env.keys=`) && line.includes("APIARY_MCP_TOKEN")));
    assert.ok(!log.includes(VALUE), "set logs env names, never values");
  } finally {
    await daemon?.stop();
    cleanup();
  }
});

function ownEnv(pid: number, name: string): string | undefined {
  try {
    if (existsSync(`/proc/${pid}/environ`)) return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
    return new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" }))?.[1];
  } catch {
    return undefined;
  }
}

function processEnv(pid: number, name: string): string | undefined {
  const queue = [pid];
  for (let at = 0; at < queue.length && at < 50; at += 1) {
    const found = ownEnv(queue[at]!, name);
    if (found !== undefined) return found;
    let children = "";
    try { children = execFileSync("pgrep", ["-P", String(queue[at])], { encoding: "utf8" }); } catch {}
    queue.push(...children.split("\n").filter(Boolean).map(Number));
  }
  return undefined;
}

test("a pending env restart survives reverted args and a later set on a model change, and a stopped bee gets its env at revive; the new process really has the value", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "env-cases", agent: "stub", cwd: "/tmp" });
    const view = () => client.request<ViewResult>("view", { beeId });
    const idleAfter = (generation: number) => waitFor(async () => { const { view: v } = await view(); return v.generation! > generation && v.runtimeState === "idle"; }, "restarted", 60_000);
    const busy = async () => { await client.request("send", { beeId, body: "@hang" }); await waitFor(async () => (await view()).view.working, "busy turn", 60_000); };
    await waitFor(async () => (await view()).view.runtimeState === "idle", "idle", 60_000);

    let generation = (await view()).view.generation!;
    await busy();
    const changed = await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: ["--model", "b"], set: { PROBE: "after-revert" } });
    assert.equal(changed.outcome, "queued");
    const reverted = await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: null });
    assert.equal(reverted.outcome, "queued", "reverting the args keeps the env restart");
    await client.request("bee.interrupt", { beeId });
    await idleAfter(generation);
    assert.equal((await view()).bee?.args ?? null, null);
    assert.equal(processEnv((await view()).runtime!.pid!, "PROBE"), "after-revert", "the restarted process has the new env");

    generation = (await view()).view.generation!;
    await busy();
    const model = await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: ["--model", "c"] });
    assert.equal(model.outcome, "queued");
    const withEnv = await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: ["--model", "c"], set: { PROBE: "on-model-change" } });
    assert.equal(withEnv.outcome, "queued");
    const pending = (await client.request<CommandsResult>("commands", { beeId })).commands.find((command) => command.id === (withEnv as { commandId: number }).commandId);
    assert.equal((pending?.args as { envApplied?: boolean } | undefined)?.envApplied, true, "the pending model change is marked as carrying env");
    assert.equal((await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: null })).outcome, "queued", "a later revert keeps that restart");
    await client.request("bee.interrupt", { beeId });
    await idleAfter(generation);
    assert.equal(processEnv((await view()).runtime!.pid!, "PROBE"), "on-model-change");

    await client.request("stop", { beeId });
    await waitFor(async () => (await view()).view.runtimeState === "stopped", "stopped", 60_000);
    assert.equal((await client.request<ReconfigureResult>("bee.reconfigure", { beeId, args: null, set: { PROBE: "at-revive" } })).outcome, "recorded");
    generation = (await view()).view.generation!;
    await client.request("revive", { beeId });
    await idleAfter(generation);
    assert.equal(processEnv((await view()).runtime!.pid!, "PROBE"), "at-revive");
  } finally {
    await daemon?.stop();
    cleanup();
  }
});
