import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { AGENT_PATH, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "../../daemon/tests/helpers.ts";
import { runV2Cli, type CliIo } from "../src/main.ts";
import { stripAnsi } from "../src/style.ts";

async function cli(argv: string[], expected = 0): Promise<string> {
  const lines: string[] = [];
  const io: CliIo = { out: line => lines.push(stripAnsi(line)), err: line => lines.push(stripAnsi(line)) };
  assert.equal(await runV2Cli(argv, io), expected, `${argv.join(" ")}: ${lines.join("\n")}`);
  return lines.join("\n");
}

test("env privacy: real daemon and stale CLI emit names only while the child receives original env", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  const canary = `harmless-${randomUUID()}`;
  const env = { PLAIN_SETTING: canary, APIARY_AGENT_TOKEN: canary, CODEX_HOME: join(dir, canary, "codex"), CLAUDE_CONFIG_DIR: join(dir, canary, "claude"), GROK_HOME: join(dir, canary, "grok") };
  const safe = (value: unknown): void => { assert.equal(JSON.stringify(value).includes(canary), false); };
  try {
    const probe = join(dir, "probe.mjs");
    const report = join(dir, "launch.json");
    writeFileSync(probe, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(env))}.map(key => [key,process.env[key]])))); await import(${JSON.stringify(AGENT_PATH)});`);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    config.agents.stub.args = [probe];
    writeFileSync(join(dir, "config.json"), JSON.stringify(config));
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    store.createBee({ id: "fixture-parent", name: "parent", agent: "stub", substrate: "hsr", cwd: dir, env });
    store.createBee({ id: "fixture-child", name: "child", parentId: "fixture-parent", agent: "stub", substrate: "hsr", cwd: dir, env });
    store.setBeeEnv("fixture-parent", { ...env, NEW_SETTING: canary });
    store.enqueueCommand("stop", "fixture-parent", { nested: { env } });
    store.close();
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<{beeId: string}>("spawn", { name: "launch", agent: "stub", cwd: dir, env });
    await waitFor(() => { try { return JSON.parse(readFileSync(report, "utf8")); } catch { return null; } }, "launch probe");
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), env);
    const view = await client.request<{bee:{envKeys:string[];sessionLogPath:string}}>("view", { beeId: spawned.beeId });
    safe(view);
    assert.deepEqual(view.bee.envKeys, Object.keys(env).sort());
    assert.equal("env" in view.bee, false);
    for (const args of [
      ["view", "parent"], ["view", "child"], ["list", "--all"], ["children", "parent"],
      ["events", "--bee", "parent", "--tail", "1000"], ["commands", "parent"], ["transcript", spawned.beeId, "--raw"],
      ["rename", "child", "renamed-child"], ["tag", "renamed-child", "--add", "privacy"],
    ]) {
      safe(await cli([...args, "--data-dir", dir, "--json"]));
    }
    const flagError = await cli(["view", "parent", "--data-dir", dir, "--json", "--reveal-env"], 1);
    assert.match(flagError, /unknown flag/);
    safe(flagError);
    client.close();
    await daemon.stop(); daemon = null;
    for (const args of [["view", "parent"], ["commands", "parent"], ["list", "--all"], ["children", "parent"], ["events", "--bee", "parent"], ["transcript", spawned.beeId, "--raw"]]) {
      const output = await cli([...args, "--data-dir", dir, "--json"]);
      safe(output);
      assert.equal(JSON.parse(output).stale, true);
    }
    safe(await cli(["view", "parent", "--data-dir", dir, "--json", "--reveal-env"], 1));
    const stored = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    assert.deepEqual(stored.getBee(spawned.beeId)?.env, env);
    stored.close();
  } finally { await daemon?.stop(); cleanup(); }
});
