import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import { THREAD_WRITER_LOCKED_RETRYING_DETAIL } from "../../core/src/index.ts";
import { codexAdapter } from "../../adapters/src/index.ts";
import type { AuditTailResult, SpawnResult, ViewResult } from "../src/protocol.ts";

function resumeReplyWhileHeld(codex: string, env: NodeJS.ProcessEnv, threadId: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const probe = spawn(codex, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    probe.once("error", reject);
    createInterface({ input: probe.stdout! }).on("line", line => {
      let message: { id?: unknown };
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        probe.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
        probe.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/resume", params: { threadId, cwd, approvalPolicy: "never", sandbox: "read-only", excludeTurns: true } })}\n`);
      } else if (message.id === 2) {
        probe.kill();
        resolve(line);
      }
    });
    probe.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "writer-lock-wording-probe", version: "1" } } })}\n`);
  });
}

function assertCodexLockWordingRecognised(codex: string, reply: string, threadId: string, cwd: string): void {
  const signals = codexAdapter({ cwd, resumeThreadId: threadId }).parseLine(reply);
  const recognised = signals.some(signal => signal.kind === "flag" && signal.detail === THREAD_WRITER_LOCKED_RETRYING_DETAIL);
  assert.ok(recognised, [
    `Codex changed its thread-lock error, so Honeybee would hang in booting on a held thread. ${execFileSync(codex, ["--version"], { encoding: "utf8" }).trim()} answered thread/resume with: ${reply}`,
    "To fix: update CODEX_ACTIVE_WRITER in v2/adapters/src/codex.ts to match this error, run `npm run v2:codex:writer-lock` until it passes, land that change, then rerun the release.",
  ].join("\n"));
}

interface Sample { atMs: number; generation: number | null; state: string | null; flags: string[]; spawnFailures: number; detail: string | null }

test("real Codex thread held by another app-server surfaces a lock reason at once and never exhausts the spawn budget", {
  skip: process.env.HONEYBEE_REAL_CODEX_WRITER_LOCK !== "1",
  timeout: 240_000,
}, async t => {
  const root = mkdtempSync(join(tmpdir(), "hb-writer-lock-"));
  const home = join(root, "native"); mkdirSync(home);
  let requests = 0;
  const model = createServer((req, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      const id = ++requests;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const item = { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
      for (const event of [
        { type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => { model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); });
  const address = model.address(); assert(address && typeof address !== "string");
  writeFileSync(join(home, "config.toml"), `model_provider = "probe"
model = "probe"
[model_providers.probe]
name = "probe"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
`);
  const codex = process.env.CODEX_BIN ?? "codex";
  const nativeEnv = { HOME: root, CODEX_HOME: home };
  const rig = makeDaemonDir({
    agents: { codex: { command: codex, args: ["app-server"], adapter: "codex", env: nativeEnv } },
    bootHangTimeoutMs: 8_000,
    retry: { maxAttempts: 3, backoffBaseMs: 500 },
  });
  const daemon = await startDaemon(rig.dir, { platform: process.platform, env: { ...nativeEnv, HIVE_STORE_ROOT: root } });
  const client = await daemon.client();
  t.after(async () => { client.close(); await daemon.stop(); rig.cleanup(); rmSync(root, { recursive: true, force: true }); });

  const bee = await client.request<SpawnResult>("spawn", { name: "writer-lock-fixture", agent: "codex", cwd: root });
  const view = () => client.request<ViewResult>("view", { beeId: bee.beeId });
  const idle = () => waitFor(async () => {
    const current = await view();
    return current.runtime?.state === "idle" && current.bee?.providerSessionId ? current : null;
  }, "real Codex idle", 60_000);
  await idle();
  await client.request("send", { beeId: bee.beeId, body: "Reply OK", urgency: "next" });
  await waitFor(() => requests >= 1, "first model request", 60_000);
  const threadId = (await idle()).bee!.providerSessionId!;
  await client.request("stop", { beeId: bee.beeId });
  await waitFor(async () => (await view()).runtime?.state === "stopped", "bee released its thread", 30_000);

  const holder = spawn(codex, ["app-server"], { env: { ...process.env, ...nativeEnv }, stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: holder.stdout! }).on("line", line => {
    let message: Record<string, unknown>; try { message = JSON.parse(line); } catch { return; }
    if (typeof message.id === "number") replies.get(message.id)?.(message);
  });
  const call = (id: number, method: string, params: unknown) => new Promise<Record<string, unknown>>(resolve => {
    replies.set(id, resolve);
    holder.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  await call(1, "initialize", { clientInfo: { name: "chatgpt-app-stand-in", version: "1" } });
  holder.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const held = await call(2, "thread/resume", { threadId, cwd: root, approvalPolicy: "never", sandbox: "read-only", excludeTurns: true });
  assert.ok("result" in held, `stand-in app holds the thread: ${JSON.stringify(held)}`);
  assertCodexLockWordingRecognised(codex, await resumeReplyWhileHeld(codex, { ...process.env, ...nativeEnv }, threadId, root), threadId, root);

  const startedAt = Date.now();
  const timeline: Sample[] = [];
  const sample = async (): Promise<Sample> => {
    const current = await view();
    const audit = await client.request<AuditTailResult>("audit.tail", { beeId: bee.beeId, limit: 200 });
    const lastSet = audit.rows.findLast(row => row.kind === "flag.set")?.payload as { flag?: { detail?: string } } | undefined;
    const row = current.view.flags.length > 0 ? { detail: lastSet?.flag?.detail } : undefined;
    const point = { atMs: Date.now() - startedAt, generation: current.runtime?.generation ?? null, state: current.runtime?.state ?? null, flags: [...current.view.flags], spawnFailures: current.bee?.spawnFailures ?? 0, detail: row?.detail ?? null };
    const last = timeline.at(-1);
    if (!last || last.generation !== point.generation || last.state !== point.state || last.flags.join() !== point.flags.join() || last.spawnFailures !== point.spawnFailures) {
      timeline.push(point);
      console.log(`TIMELINE ${JSON.stringify(point)}`);
    }
    return point;
  };
  const requestsBeforeLock = requests;
  await client.request("send", { beeId: bee.beeId, body: "Reply OK while the app holds the thread", urgency: "next" });
  const settled = await waitFor(async () => {
    const point = await sample();
    return point.flags.length > 0 && point.state === "stopped" ? point : null;
  }, "a visible blocked reason", 60_000, 200);
  const observeUntil = Date.now() + 20_000;
  while (Date.now() < observeUntil) { await sample(); await new Promise(resolve => setTimeout(resolve, 200)); }

  assert.ok(settled.atMs < 8_000, `the reason lands before the boot-hang deadline: ${settled.atMs}ms`);
  assert.deepEqual(settled.flags, ["resource_blocked"]);
  assert.equal(settled.detail, THREAD_WRITER_LOCKED_RETRYING_DETAIL);
  assert.ok(!(settled.detail ?? "").includes(threadId), "the reason carries no thread id");
  assert.ok(timeline.every(point => !point.flags.includes("spawn_failed") && point.spawnFailures === 0), "no spawn-budget charge");

  holder.kill();
  await new Promise(resolve => holder.once("exit", resolve));
  const recovered = await waitFor(async () => {
    const point = await sample();
    return point.state === "idle" && point.flags.length === 0 && requests > requestsBeforeLock ? point : null;
  }, "the bee resumes once the app lets go", 90_000, 250);
  console.log(`RESULT ${JSON.stringify({ threadId, blockedAfterMs: settled.atMs, recoveredAfterMs: recovered.atMs, generations: recovered.generation })}`);
});
