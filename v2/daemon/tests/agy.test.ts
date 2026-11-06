/**
 * agy over ACP through a real daemon and the fake `agy acp`
 * (v2/driver-hsr/test-agent/fake-agy.mjs): the bee runs unbound on the
 * machine's own sign-in, no account path reaches it, GEMINI_API_KEY passes
 * through from the environment, and an agy too old for `agy acp` is refused
 * by name before anything is spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openCoreStore } from "../../core/src/index.ts";
import { DAEMON_CAPABILITIES, RpcError, type DeployInfoResult, type NodeHarnessesResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGY = join(here, "..", "..", "driver-hsr", "test-agent", "fake-agy.mjs");

type Request = { method: string; params: Record<string, unknown> };
const requestsIn = (path: string): Request[] =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as Request) : [];

async function refused(fn: () => Promise<unknown>, code: string, message: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof RpcError, `expected RpcError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    assert.match(err.message, message);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("agy: --account auto runs unbound on the machine's own sign-in, beside a leftover agy account row; every account path is refused", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hb-v2-agy-"));
  const facts = join(scratch, "facts.json");
  const requests = join(scratch, "requests.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: { agy: { command: process.execPath, args: [FAKE_AGY, "acp"], adapter: "agy", env: { AGY_CLI_DISABLE_AUTO_UPDATE: "1", FAKE_AGY_OUT: facts, FAKE_AGY_REQUESTS: requests } } },
  });
  let daemon: DaemonHandle | null = null;
  try {
    // A row the removed agy recipe left behind, with a vaulted token beside it.
    const store = openCoreStore(join(dir, "core.sqlite3"));
    store.createAccount({ id: "agy-old", harness: "agy", label: "old", homePath: join(dir, "homes", "agy-old") });
    store.close();
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    // A client tells an ACP daemon from a print-mode one by this tag, in the hello and in deployInfo.
    assert.ok((DAEMON_CAPABILITIES as readonly string[]).includes("agy.acp.v1"));
    assert.ok(client.capabilities.includes("agy.acp.v1"), "advertised in the connection hello");
    assert.ok((await client.request<DeployInfoResult>("deployInfo")).capabilities.includes("agy.acp.v1"), "and in deployInfo");
    const idle = (beeId: string) => waitFor(async () => {
      const view = await client.request<ViewResult>("view", { beeId });
      return view.view.runtimeState === "idle" ? view : null;
    }, `${beeId} idle`, 20_000);

    // `account` omitted is `auto`.
    const spawned = await client.request<SpawnResult>("spawn", { name: "agy-auto", agent: "agy", cwd: dir });
    const booted = await idle(spawned.beeId);
    assert.equal(booted.bee?.account, null, "unbound: no account, no rotation, no reserve");
    assert.deepEqual(booted.view.flags, []);
    const ran = JSON.parse(readFileSync(facts, "utf8")) as { argv: string[]; autoUpdateDisabled: boolean; sshConnection: string | null; home: string };
    assert.deepEqual(ran.argv, ["acp"], "the builtin spawn is `agy acp`, with no permission bypass of its own");
    assert.equal(ran.autoUpdateDisabled, true);
    assert.notEqual(ran.sshConnection, "127.0.0.1 1 127.0.0.1 1", "no fake SSH session");
    assert.equal(ran.home.startsWith(join(dir, "homes")), false, "HOME is the daemon's own, never an account home");
    assert.deepEqual(requestsIn(requests).map((r) => r.method), ["initialize", "session/new"], "no authenticate, no configuration");
    assert.deepEqual((requestsIn(requests)[0]!.params as { clientInfo: unknown }).clientInfo, { name: "Honeybee", version: "2" });

    await client.request<SendRpcResult>("send", { beeId: spawned.beeId, body: "hello" });
    await waitFor(() => requestsIn(requests).some((r) => r.method === "session/prompt"), "prompt delivered", 20_000);
    await idle(spawned.beeId);

    // Model, effort and the permission bypass come per bee.
    const tuned = await client.request<SpawnResult>("spawn", {
      name: "agy-tuned", agent: "agy", cwd: dir, account: "auto",
      args: ["--model", "gemini-3.8-flash", "--effort", "high", "--dangerously-skip-permissions"],
    });
    assert.equal((await idle(tuned.beeId)).bee?.account, null);
    assert.deepEqual((JSON.parse(readFileSync(facts, "utf8")) as { argv: string[] }).argv, ["acp", "--dangerously-skip-permissions"]);
    assert.deepEqual(
      requestsIn(requests).filter((r) => r.method === "session/set_config_option").map((r) => [r.params.configId, r.params.value]),
      [["model", "gemini-3.8-flash"], ["thought_level", "high"]],
    );

    // No account path reaches agy.
    const own = /agy runs on this computer's own agy sign-in/;
    await refused(() => client.request("spawn", { name: "agy-explicit", agent: "agy", cwd: dir, account: "agy-old" }), "account_unavailable", own);
    await refused(() => client.request("spawn", { name: "agy-rr", agent: "agy", cwd: dir, account: "rr" }), "account_unavailable", own);
    await refused(() => client.request("spawn", { name: "agy-only", agent: "agy", cwd: dir, account: "auto", onlyAccountIds: ["agy-old"] }), "account_unavailable", own);
    await refused(() => client.request("bee.swapAccount", { beeId: spawned.beeId, account: "agy-old" }), "account_unavailable", own);
    await refused(() => client.request("account.add", { harness: "agy", label: "new" }), "account_unavailable", own);
    assert.equal((await client.request<ViewResult>("view", { beeId: spawned.beeId })).bee?.account, null);
    const fact = (await client.request<NodeHarnessesResult>("node.harnesses")).harnesses.find((h) => h.harness === "agy");
    assert.deepEqual([fact?.present, fact?.unavailable], [true, null]);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("agy: a signed-out agy is auth_needed; GEMINI_API_KEY from the bee's environment authenticates when agy asks", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hb-v2-agy-key-"));
  const facts = join(scratch, "facts.json");
  const requests = join(scratch, "requests.jsonl");
  const { dir, cleanup } = makeDaemonDir({
    agents: { agy: { command: process.execPath, args: [FAKE_AGY, "acp"], adapter: "agy", env: { FAKE_AGY_SIGNED_OUT: "1", FAKE_AGY_OUT: facts, FAKE_AGY_REQUESTS: requests } } },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const out = await client.request<SpawnResult>("spawn", { name: "agy-out", agent: "agy", cwd: dir });
    const flagged = await waitFor(async () => {
      const view = await client.request<ViewResult>("view", { beeId: out.beeId });
      return view.view.flags.includes("auth_needed") ? view : null;
    }, "auth_needed", 20_000);
    assert.notEqual(flagged.view.runtimeState, "idle", "an auth refusal is not readiness");
    assert.equal(requestsIn(requests).some((r) => r.method === "authenticate"), false, "no key in the environment: no authenticate call");
    await client.request("stop", { beeId: out.beeId });

    const keyed = await client.request<SpawnResult>("spawn", { name: "agy-key", agent: "agy", cwd: dir, env: { GEMINI_API_KEY: "fixture-key" } });
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: keyed.beeId })).view.runtimeState === "idle", "keyed bee idle", 20_000);
    assert.deepEqual(requestsIn(requests).slice(-4).map((r) => [r.method, r.params.methodId]), [
      ["initialize", undefined], ["session/new", undefined], ["authenticate", "gemini-api-key"], ["session/new", undefined],
    ]);
    assert.equal((JSON.parse(readFileSync(facts, "utf8")) as { hasApiKey: boolean }).hasApiKey, true, "the key reaches agy through its environment, nowhere else");
    assert.equal(readFileSync(requests, "utf8").includes("fixture-key"), false, "the key is never put on the wire");
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("agy: an installed agy older than the ACP floor is refused by name and never run", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "hb-v2-agy-old-"));
  const requests = join(scratch, "requests.jsonl");
  const oldAgy = join(scratch, "agy");
  writeFileSync(oldAgy, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "1.4.9"; exit 0; fi\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`);
  chmodSync(oldAgy, 0o755);
  const { dir, cleanup } = makeDaemonDir({
    agents: { agy: { command: oldAgy, args: ["acp"], adapter: "agy", env: { FAKE_AGY_REQUESTS: requests } } },
  });
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();
    const spawned = await client.request<SpawnResult>("spawn", { name: "agy-old", agent: "agy", cwd: dir });
    const log = join(dir, "hived.log");
    await waitFor(() => existsSync(log) && readFileSync(log, "utf8").includes("start_failed"), "start refusal logged", 20_000);
    assert.match(readFileSync(log, "utf8"), /agy 1\.4\.9 is too old for Honeybee: it runs agy over ACP \(`agy acp`\), which needs agy 1\.5\.1 or newer\. Update agy on this computer\./);
    const view = await waitFor(async () => {
      const current = await client.request<ViewResult>("view", { beeId: spawned.beeId });
      return current.view.flags.includes("spawn_failed") ? current : null;
    }, "spawn_failed", 30_000);
    assert.notEqual(view.view.runtimeState, "idle");
    assert.equal(existsSync(requests), false, "`agy acp` was never started");
    // The node says the same before anyone spawns.
    const fact = (await client.request<NodeHarnessesResult>("node.harnesses")).harnesses.find((h) => h.harness === "agy");
    assert.deepEqual([fact?.present, fact?.version], [true, "1.4.9"]);
    assert.match(fact?.unavailable ?? "", /^agy 1\.4\.9 is too old for Honeybee/);
    client.close();
  } finally {
    await daemon?.stop();
    cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
});
