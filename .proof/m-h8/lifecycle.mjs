#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const root = resolve(option("--root", "."));
const out = resolve(option("--out", ".proof/m-h8/lifecycle.json"));
const logsOut = resolve(option("--logs-out", ".proof/m-h8/lifecycle-logs"));

const local = (file) => import(pathToFileURL(join(root, file)).href);
const { makeDaemonDir, startDaemon, waitFor, sleep } = await local("v2/daemon/tests/helpers.ts");
const { makeOrigin } = await local("v2/driver-cell/tests/helpers.ts");

const here = dirname(new URL(import.meta.url).pathname);
const agentDir = join(root, "v2", "driver-hsr", "test-agent");
const scratch = mkdtempSync(join(tmpdir(), "hb-m-h8-lifecycle-"));
const codexHome = join(scratch, "codex-home");
mkdirSync(codexHome, { recursive: true });
const museRecorded = join(scratch, "muse-recorded.jsonl");
{
  const fixture = readFileSync(join(root, "v2", "adapters", "tests", "fixtures", "muse-usage-changed.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const [usageLine] = fixture;
  usageLine.params = { ...usageLine.params, observedAtMs: Date.now() - 60_000, window: { ...usageLine.params.window, resetsAtMs: Date.now() + 3_600_000 } };
  writeFileSync(museRecorded, `${JSON.stringify(usageLine)}\n`);
}
const origin = makeOrigin(scratch);
const cellsRoot = join(scratch, "cells");
mkdirSync(cellsRoot, { recursive: true });

const { dir, cleanup } = makeDaemonDir({
  tickMs: 200,
  cells: { root: cellsRoot },
  stubEnv: { STUB_TURN_MS: "50" },
  agents: {
    claude: { command: process.execPath, args: [join(agentDir, "fake-claude.mjs"), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], adapter: "claude" },
    codex: { command: process.execPath, args: [join(agentDir, "fake-codex.mjs")], adapter: "codex", env: { CODEX_HOME: codexHome } },
    muse: { command: process.execPath, args: [join(agentDir, "fake-muse.mjs"), "serve"], adapter: "muse", env: { MUSE_NO_AUTO_UPDATE: "1", FAKE_MUSE_RECORDED: museRecorded } },
  },
});
const steps = [];
const t0 = Date.now();
const record = (harness, substrate, step, ok, detail = {}) => {
  steps.push({ at: Date.now() - t0, harness, substrate, step, ok, ...detail });
  console.log(`${ok ? "ok " : "FAIL"} ${harness}/${substrate} ${step} ${JSON.stringify(detail)}`);
};
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

let daemon = await startDaemon(dir, { env: { HIVE_TEST_CELL_VOLUME_BYTES: String(1024 ** 4) } });
let client = await daemon.client();
const view = (beeId) => client.request("view", { beeId });
const runtimeRow = async (beeId) => (await view(beeId)).runtime;
const waitState = (beeId, state, label, ms = 30_000) => waitFor(async () => (await view(beeId)).view.runtimeState === state, label, ms, 50);
const waitDelivered = (beeId, messageId, label, ms = 30_000) => waitFor(async () => (await client.request("mailbox", { beeId })).messages.find((m) => m.id === messageId)?.deliveredAt != null, label, ms, 50);
const waitTurnDone = async (beeId, messageId, label) => {
  await waitDelivered(beeId, messageId, label);
  await waitState(beeId, "idle", `${label} turn ended`);
};

async function cycle(harness, substrate, spawnParams, bodies) {
  const name = `${harness}-${substrate}`;
  const spawned = await client.request("spawn", { name, agent: harness, cwd: scratch, ...spawnParams });
  const beeId = spawned.beeId;
  try {
    await waitState(beeId, "idle", `${name} boots`);
    const gen1 = await runtimeRow(beeId);
    record(harness, substrate, "spawn", gen1.state === "idle" && pidAlive(gen1.pid), { generation: gen1.generation, pid: gen1.pid });

    const hello = await client.request("send", { beeId, body: bodies.hello });
    await waitTurnDone(beeId, hello.messageId, `${name} hello`);
    record(harness, substrate, "send", true, { messageId: hello.messageId, lastOutputAt: (await view(beeId)).view.lastOutputAt });

    if (bodies.slow) {
      const slow = await client.request("send", { beeId, body: bodies.slow });
      await waitDelivered(beeId, slow.messageId, `${name} slow delivered`);
      await waitState(beeId, "running", `${name} slow running`, 10_000);
      const interrupted = await client.request("bee.interrupt", { beeId });
      await waitState(beeId, "idle", `${name} interrupted turn ended`, 10_000);
      record(harness, substrate, "interrupt", interrupted.interrupted === true || interrupted.reason === "unsupported", { outcome: interrupted });
    } else {
      record(harness, substrate, "interrupt", true, { skipped: "the fake muse replays recorded lines and has no slow turn to interrupt" });
    }

    await client.request("stop", { beeId });
    await waitState(beeId, "stopped", `${name} stopped`);
    const stopped = await runtimeRow(beeId);
    await waitFor(() => !pidAlive(gen1.pid), `${name} host pid gone`, 10_000, 50);
    record(harness, substrate, "stop", stopped.state === "stopped" && stopped.exitCause === "stopped_by_user", { exitCause: stopped.exitCause, pidGone: !pidAlive(gen1.pid) });

    await client.request("revive", { beeId });
    await waitState(beeId, "idle", `${name} revived`);
    const gen2 = await runtimeRow(beeId);
    record(harness, substrate, "revive", gen2.generation === gen1.generation + 1 && pidAlive(gen2.pid), { generation: gen2.generation, pid: gen2.pid });

    const again = await client.request("send", { beeId, body: bodies.hello });
    await waitTurnDone(beeId, again.messageId, `${name} after revive`);
    record(harness, substrate, "send-after-revive", true, { messageId: again.messageId });
    return { beeId, generation: gen2.generation, pid: gen2.pid };
  } catch (error) {
    record(harness, substrate, "cycle", false, { error: String(error?.message ?? error) });
    return { beeId, failed: true };
  }
}

let report;
try {
  const live = [];
  live.push({ harness: "stub", ...(await cycle("stub", "hsr", {}, { hello: "hello stub", slow: "@slow:4000 please" })) });
  live.push({ harness: "stub", ...(await cycle("stub", "cell", { substrate: "cell", cell: { originRepo: origin.repo, sandbox: false } }, { hello: "hello cell", slow: "@slow:4000 please" })) });
  live.push({ harness: "claude", ...(await cycle("claude", "hsr", { account: null }, { hello: "hello claude", slow: "@slow:4000 please" })) });
  live.push({ harness: "codex", ...(await cycle("codex", "hsr", { account: null }, { hello: "hello codex", slow: "@slow:4000 please" })) });
  {
    const id = "muse-sub";
    const credential = JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "fixture-key" } } });
    for (const base of [join(dir, "homes", id, "muse"), join(dir, "vault", "muse", id, "muse")]) {
      mkdirSync(base, { recursive: true });
      writeFileSync(join(base, "auth.json"), credential);
    }
    await client.request("account.add", { harness: "muse", label: "sub", importExisting: true });
    live.push({ harness: "muse", ...(await cycle("muse", "hsr", { account: id, tags: ["autoswap=false"] }, { hello: "hello muse", slow: null })) });
  }

  const survivors = live.filter((b) => !b.failed);
  client.close();
  await daemon.kill();
  await sleep(300);
  const pidsAfterStop = survivors.map((b) => ({ harness: b.harness, pid: b.pid, alive: pidAlive(b.pid) }));
  record("daemon", "-", "daemon SIGKILL leaves every runtime alive", pidsAfterStop.every((p) => p.alive), { pids: pidsAfterStop });
  daemon = await startDaemon(dir, { env: { HIVE_TEST_CELL_VOLUME_BYTES: String(1024 ** 4) } });
  client = await daemon.client();
  const health = await client.request("health", {});
  record("daemon", "-", "successor adopts", health.lastBoot?.adopted === survivors.length, { adopted: health.lastBoot?.adopted, expected: survivors.length });
  for (const bee of survivors) {
    try {
      const row = await runtimeRow(bee.beeId);
      const msg = await client.request("send", { beeId: bee.beeId, body: `after restart ${bee.harness}` });
      await waitTurnDone(bee.beeId, msg.messageId, `${bee.harness} after restart`);
      const after = await runtimeRow(bee.beeId);
      record(bee.harness, "adopted", "send after daemon restart", after.generation === bee.generation && after.pid === bee.pid && row.pid === bee.pid, { generation: after.generation, pid: after.pid });
    } catch (error) {
      record(bee.harness, "adopted", "send after daemon restart", false, { error: String(error?.message ?? error) });
    }
  }
  const manifest = {};
  mkdirSync(logsOut, { recursive: true });
  for (const bee of live) {
    const v = await view(bee.beeId);
    const path = v.bee?.sessionLogPath;
    if (!path) continue;
    const name = `${bee.harness}-${bee.beeId.slice(0, 8)}.jsonl`;
    copyFileSync(path, join(logsOut, name));
    manifest[name] = bee.harness;
  }
  writeFileSync(join(logsOut, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  for (const bee of survivors) { await client.request("stop", { beeId: bee.beeId }); }
  await waitFor(async () => (await client.request("list", {})).views.every((v) => v.view.runtimeState === "stopped" || v.view.runtimeState === null), "all stopped", 30_000, 100);
  client.close();
  report = { timestamp: new Date().toISOString(), hostname: hostname(), node: process.version, root, dataDir: dir, ok: steps.every((s) => s.ok), steps };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  copyFileSync(join(dir, "hived.log"), join(logsOut, "hived.log"));
  console.log(JSON.stringify({ out, ok: report.ok, failed: steps.filter((s) => !s.ok).map((s) => `${s.harness}/${s.substrate} ${s.step}`) }));
} finally {
  await daemon.stop().catch(() => {});
  cleanup();
}
