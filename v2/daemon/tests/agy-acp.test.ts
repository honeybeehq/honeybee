import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeSpawn } from "../src/daemon.ts";
import { BUILTIN_AGENTS } from "../src/config.ts";
import { createTranscriptProjector } from "../../adapters/src/transcripts.ts";
import type { TranscriptProjectedEvent } from "../../adapters/src/transcript.ts";
import type { DeployInfoResult, ListResult, SpawnResult, ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const STUB = fileURLToPath(new URL("./fixtures/agy-acp-stub.mjs", import.meta.url));

function firstRequest(signals: ReturnType<NonNullable<ReturnType<typeof composeSpawn>["adapter"]>["parseLine"]>): Record<string, unknown> {
  const respond = signals.find((signal) => signal.kind === "respond");
  if (respond?.kind !== "respond") assert.fail(`expected a request, got ${JSON.stringify(signals)}`);
  return JSON.parse(respond.lines[0]!) as Record<string, unknown>;
}

test("agy keeps print mode unless the argv carries agy's acp subcommand", () => {
  const spec = BUILTIN_AGENTS.agy!;
  const print = composeSpawn(spec, "agy", { cwd: "/tmp", args: ["--model", "gemini-4-neon"], providerSessionId: "conv-1" });
  assert.deepEqual(print.args, [...spec.args!, "--model", "gemini-4-neon", "--conversation", "conv-1"]);
  assert.deepEqual(print.adapter?.bootLines(), []);

  const acp = composeSpawn(spec, "agy", { cwd: "/work", args: ["--dangerously-skip-permissions", "acp", "--model", "gemini-4-neon", "--effort", "xhigh", "--add-dir", "/extra"], providerSessionId: null });
  assert.deepEqual(acp.args, ["acp", "--add-dir", "/extra"], "print plumbing and lifted flags never reach agy acp");
  assert.equal(acp.model, "gemini-4-neon");
  assert.equal(JSON.parse(acp.adapter!.bootLines()[0]!).method, "initialize");
  assert.equal(spec.env?.AGY_CLI_DISABLE_AUTO_UPDATE, "1", "the ACP path inherits the agent spec env");
});

test("an agy ACP bee answers permissions from its own args, never from the print-mode plumbing", () => {
  const spec = BUILTIN_AGENTS.agy!;
  assert.ok(spec.args?.includes("--dangerously-skip-permissions"), "the print spec carries the flag for print mode");
  const answer = (args: string[], agent = spec) => {
    const { adapter } = composeSpawn(agent, "agy", { cwd: "/work", args, providerSessionId: null });
    const reply = firstRequest(adapter!.parseLine(JSON.stringify({ jsonrpc: "2.0", id: "1", method: "session/request_permission", params: { options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }] } })));
    return ((reply.result as Record<string, unknown>).outcome as Record<string, unknown>).optionId;
  };
  assert.equal(answer(["acp", "--model", "gemini-4-argon-high"]), "deny");
  assert.equal(answer(["--dangerously-skip-permissions", "acp"]), "allow");
  assert.equal(answer([], { ...spec, defaultArgs: ["acp", "--dangerously-skip-permissions"] }), "allow", "a node default applies to every bee");
  assert.equal(answer([], { command: "agy", args: ["acp", "--dangerously-skip-permissions"], adapter: "agy" }), "allow", "an ACP agent spec's own flag counts");
});

test("agy ACP resumes with session/resume and authenticates only when the spawn names a method", () => {
  const spec = BUILTIN_AGENTS.agy!;
  const resumed = composeSpawn(spec, "agy", { cwd: "/work", args: ["acp"], providerSessionId: "saved" }, [], null, {});
  assert.deepEqual(resumed.args, ["acp"], "the print-mode --conversation resume flag is dropped");
  const setup = firstRequest(resumed.adapter!.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { agentCapabilities: { sessionCapabilities: { resume: {} } } } })));
  assert.equal(setup.method, "session/resume");
  assert.deepEqual(setup.params, { cwd: "/work", mcpServers: [], sessionId: "saved" });

  const keyed = composeSpawn(spec, "agy", { cwd: "/work", args: ["acp"], providerSessionId: null }, [], null, { HIVE_AGY_AUTH_METHOD: "gemini-api-key" });
  const auth = firstRequest(keyed.adapter!.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })));
  assert.deepEqual([auth.method, auth.params], ["authenticate", { methodId: "gemini-api-key" }]);
  const denied = keyed.adapter!.parseLine(JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "GEMINI_API_KEY is not set" } }));
  assert.ok(denied.some((signal) => signal.kind === "flag" && signal.flag === "auth_needed" && signal.action === "set"));
});

function wrapper(dir: string): string {
  const path = join(dir, "agy");
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function stubLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function project(logPath: string): TranscriptProjectedEvent[] {
  const projector = createTranscriptProjector("agy");
  const events = readFileSync(logPath, "utf8").split("\n").filter(Boolean).flatMap((line) => projector.pushLine(line));
  return [...events, ...projector.flush()];
}

test("a live agy ACP bee maps tools, permission requests and usage, interrupts, and resumes its session", { timeout: 180_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir();
  const log = join(dir, "agy-stub.ndjson");
  const agents = { agy: { ...BUILTIN_AGENTS.agy!, command: wrapper(dir), env: { ...BUILTIN_AGENTS.agy!.env, AGY_STUB_LOG: log } } };
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { agents?: Record<string, unknown> };
  writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, agents: { ...config.agents, ...agents } }));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir, { env: { HIVE_GATEWAYS_DISABLE: "1" } });
    const client = await daemon.client();
    assert.ok((await client.request<DeployInfoResult>("deployInfo")).capabilities.includes("agy.acp.v1"), "clients can tell this daemon runs agy over ACP");
    const view = async (beeId: string) => client.request<ViewResult>("view", { beeId });
    const row = async (beeId: string) => (await client.request<ListResult>("list", {})).views.find((entry) => entry.bee?.id === beeId)?.bee;
    const { beeId } = await client.request<SpawnResult>("spawn", {
      name: "agy-acp", agent: "agy", cwd: dir,
      args: ["--dangerously-skip-permissions", "acp", "--model", "gemini-4-argon", "--effort", "low"],
    });
    await waitFor(async () => (await view(beeId)).view.runtimeState === "idle" ? true : null, "agy ACP booted to idle", 60_000);

    const boot = stubLog(log);
    assert.deepEqual(boot[0], { argv: ["acp"], autoUpdateDisabled: "1", authMethodEnv: null });
    assert.equal(boot.some((m) => m.method === "authenticate"), false, "stored login: no authenticate");
    assert.deepEqual(boot.filter((m) => m.method === "session/set_config_option").map((m) => [(m.params as Record<string, unknown>).configId, (m.params as Record<string, unknown>).value]), [["model", "gemini-4-argon"], ["thought_level", "low"]]);
    const sessionId = (await view(beeId)).bee?.providerSessionId;
    assert.match(String(sessionId), /^agy-session-/);

    await client.request("send", { beeId, body: "TOOL-PROBE" });
    await waitFor(async () => (await row(beeId))?.turns === 1 ? true : null, "tool turn counted on the bee row", 60_000);
    const answered = stubLog(log).find((m) => m.id === "1" && "result" in m);
    assert.deepEqual(answered?.result, { outcome: { outcome: "selected", optionId: "allow" } }, "--dangerously-skip-permissions answers allow_once");
    const after = await row(beeId);
    assert.equal(after?.lastModel, "gemini-4-argon-low");
    assert.deepEqual(after?.tokens, { input: 200, output: 20, cacheRead: 80, cacheWrite: 0 });

    const logPath = (await view(beeId)).bee?.sessionLogPath;
    assert.ok(logPath, "session log path");
    const events = project(logPath);
    const texts = events.flatMap((event) => event.kind === "message" ? [`${event.role}:${event.text}`] : []);
    assert.ok(texts.includes("user:TOOL-PROBE") || texts.some((text) => text.startsWith("user:") && text.includes("TOOL-PROBE")));
    assert.ok(texts.includes("system:Permission requested: echo stub > stub.txt [allow (allow_once), deny (reject_once)]"));
    assert.ok(texts.includes("system:Permission allowed: echo stub > stub.txt"));
    assert.ok(texts.includes("assistant:ran the command"));
    const call = events.find((event) => event.kind === "tool_call");
    assert.deepEqual(call && call.kind === "tool_call" ? [call.callId, call.name, call.input] : null, ["call_1", "echo stub > stub.txt", { CommandLine: "echo stub > stub.txt" }]);
    const result = events.find((event) => event.kind === "tool_result");
    assert.equal(result?.kind === "tool_result" && !result.isError, true);
    const usage = events.find((event) => event.kind === "token_usage");
    assert.deepEqual(usage?.kind === "token_usage" ? [usage.usage, usage.model, usage.modelContextWindow] : null,
      [{ input: 200, output: 20, cacheRead: 80, cacheWrite: 0, reasoning: 6, total: 300 }, "gemini-4-argon-low", 1048576]);

    await client.request("send", { beeId, body: "WAIT-FOR-CANCEL" });
    await waitFor(async () => (await view(beeId)).view.working ? true : null, "turn running", 30_000);
    await client.request("bee.interrupt", { beeId });
    await waitFor(async () => (await view(beeId)).view.runtimeState === "idle" ? true : null, "interrupted turn ended", 30_000);
    assert.ok(stubLog(log).some((m) => m.method === "session/cancel"), "interrupt sends session/cancel");
    const lastTurnEnd = () => project(logPath).filter((event) => event.kind === "turn_end").at(-1);
    await waitFor(() => lastTurnEnd()?.finishReason === "cancelled", "cancelled turn end in the session log", 30_000);
    assert.deepEqual(lastTurnEnd(), { kind: "turn_end", ts: null, finishReason: "cancelled", interrupted: true });

    const generation = (await view(beeId)).view.generation!;
    await client.request("stop", { beeId });
    await waitFor(async () => (await view(beeId)).view.runtimeState === "stopped" ? true : null, "stopped", 30_000);
    await client.request("send", { beeId, body: "after resume" });
    await waitFor(async () => {
      const current = await view(beeId);
      return current.view.generation! > generation && current.view.runtimeState === "idle" && stubLog(log).some((m) => m.method === "session/prompt" && JSON.stringify(m.params).includes("after resume")) ? true : null;
    }, "revived generation resumed and answered", 60_000);
    const resume = stubLog(log).find((m) => m.method === "session/resume");
    assert.equal((resume?.params as Record<string, unknown> | undefined)?.sessionId, sessionId, "the next generation resumes the same agy session");
    assert.equal((await view(beeId)).bee?.providerSessionId, sessionId);
  } finally {
    await daemon?.stop();
    cleanup();
  }
});
