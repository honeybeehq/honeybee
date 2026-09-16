import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HsrDriver } from "../src/index.ts";
import { codexAdapter } from "../../adapters/src/index.ts";
import { drainUntil } from "./helpers.ts";

const fakeCodex = new URL("../test-agent/fake-codex.mjs", import.meta.url).pathname;

test("reconnect uses the existing host/thread, fences send, and recovers receipt after daemon detach", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hb-reconnect-host-"));
  const log = join(dir, "rpc.jsonl");
  const config = {
    sessionLogDir: join(dir, "logs"),
    resolve: () => ({ adapter: codexAdapter({ cwd: dir }), command: process.execPath, args: [fakeCodex], cwd: dir, env: { ...process.env, FAKE_CODEX_RPC_LOG: log } }),
  };
  const driver = new HsrDriver(config);
  let adopted: HsrDriver | null = null;
  t.after(() => { adopted?.disposeAll(); driver.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  driver.start("bee", 1);
  await drainUntil(driver, events => events.some(e => e.kind === "turn_ended"), 60_000);
  const identity = driver.procOf("bee", 1)!;
  let release!: () => void;
  let prepared!: () => void;
  const entered = new Promise<void>(resolve => { prepared = resolve; });
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pending = driver.reconnectTools("bee", 1, 11, async apply => {
    prepared(); await barrier; await apply(["apiary"]);
  });
  await entered;
  assert.deepEqual(driver.deliver("bee", 1, 22, "must wait"), { accepted: false, reason: "not_ready" });
  release();
  const result = await pending;
  assert.equal(result.outcome, "reloaded");
  assert.deepEqual(result.targets, ["apiary"]);
  assert.deepEqual(driver.procOf("bee", 1), identity);
  let calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(c => c.method.startsWith("config/")).map(c => c.method), ["config/value/write", "config/mcpServer/reload"]);
  assert.equal(calls.find(c => c.method === "config/value/write").params.keyPath, "mcp_servers.apiary.env.HONEYBEE_MCP_RECONNECT_NONCE");

  driver.observe();
  const cursor = driver.observeRecoveryCursors().at(-1)?.cursor ?? 0;
  driver.detachAll();
  adopted = new HsrDriver(config);
  assert.equal(adopted.adopt("bee", 1, identity.pid, identity.pidStartedAt, "idle", cursor, result.threadId), true);
  // The durable response settles even when adoption's socket is not usable yet.
  const recoveredProc = (adopted as unknown as { procs: Map<string, { socketBroken: boolean }> }).procs.get("bee")!;
  recoveredProc.socketBroken = true;
  const recovered = await adopted.reconnectTools("bee", 1, 11, async () => { throw new Error("must recover existing acknowledgement"); });
  recoveredProc.socketBroken = false;
  assert.equal(recovered?.threadId, result.threadId);
  calls = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.filter(c => c.method === "config/mcpServer/reload").length, 1);
  assert.equal(calls.filter(c => c.method === "thread/start").length, 1);
  assert.equal(calls.filter(c => c.method === "turn/start").length, 0);
});

test("reconnect refuses a real active turn and legacy host recovery evidence", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hb-reconnect-refuse-"));
  const driver = new HsrDriver({ sessionLogDir: join(dir, "logs"), resolve: () => ({ adapter: codexAdapter({ cwd: dir }), command: process.execPath, args: [fakeCodex], cwd: dir }) });
  t.after(() => { driver.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  driver.start("bee", 1);
  await drainUntil(driver, events => events.some(e => e.kind === "turn_ended"), 60_000);
  driver.deliver("bee", 1, 1, "@slow:2000");
  await drainUntil(driver, events => events.some(e => e.kind === "turn_started"), 60_000);
  let prepared = false;
  await assert.rejects(driver.reconnectTools("bee", 1, 1, async () => { prepared = true; }), { code: "not_ready" });
  assert.equal(prepared, false);
  const p = (driver as unknown as { procs: Map<string, { statusPath: string }> }).procs.get("bee")!;
  const status = JSON.parse(readFileSync(p.statusPath, "utf8"));
  delete status.beeId; delete status.generation;
  writeFileSync(p.statusPath, JSON.stringify(status));
  assert.deepEqual(driver.reconnectToolsSupport("bee", 1), { supported: false, reason: "unsupported_runner_host" });
  assert.equal(driver.reconnectToolsSupport("bee", 2).supported, false);
});

test("native config rejection fails explicitly without reload or session replacement", async t => {
  const dir = mkdtempSync(join(tmpdir(), "hb-reconnect-native-refusal-"));
  const log = join(dir, "rpc.jsonl");
  const driver = new HsrDriver({ sessionLogDir: join(dir, "logs"), resolve: () => ({ adapter: codexAdapter({ cwd: dir }), command: process.execPath, args: [fakeCodex], cwd: dir, env: { ...process.env, FAKE_CODEX_REJECT_RECONNECT: "1", FAKE_CODEX_RPC_LOG: log } }) });
  t.after(() => { driver.disposeAll(); rmSync(dir, { recursive: true, force: true }); });
  driver.start("bee", 1);
  await drainUntil(driver, events => events.some(e => e.kind === "turn_ended"), 60_000);
  const identity = driver.procOf("bee", 1)!;
  await assert.rejects(driver.reconnectTools("bee", 1, 1, async apply => apply(["apiary"])), { code: "reload_rejected" });
  assert.equal(driver.procOf("bee", 1)?.pid, identity.pid);
  assert.doesNotMatch(readFileSync(log, "utf8"), /config\/mcpServer\/reload|thread\/resume/);
  await assert.rejects(driver.reconnectTools("bee", 1, 2, async () => {}), { code: "reload_unconfirmed" });
});
