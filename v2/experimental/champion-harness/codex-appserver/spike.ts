import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { withCodexHomeBootLock } from "../../../../src/codexBoot.ts";
import { codexThreadRequest } from "../../../adapters/src/codex.ts";
import { object, TurnMeasurement, ZERO_USAGE, type Usage } from "./measure.ts";
import { championPrompt, IDENTITY, MAIL, PROMPT_ORDER } from "./prompt.ts";

const ACCOUNT = "codex-tormod-arbeidsark.no";
const MODEL = "gpt-6.1-sol";
const TIMEOUT_MS = 180_000;
const out = resolve(process.argv[2] ?? `.audit/champion-codex/run-${Date.now()}`);
const pauseMs = Number(process.argv[3] ?? 10_000);
if (!Number.isSafeInteger(pauseMs) || pauseMs < 1 || pauseMs > 60_000) throw new Error("Pause must be 1..60000ms");
mkdirSync(out, { recursive: true, mode: 0o700 });
for (const part of ["home", "tmp", "workspace"]) mkdirSync(join(out, part), { recursive: true, mode: 0o700 });
const logPath = join(out, "run.jsonl");
writeFileSync(logPath, "", { flag: "wx", mode: 0o600 });
const log = (event: string, fields: Record<string, unknown> = {}) => {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
};
const rows: Array<Record<string, unknown>> = [];
const metadata = {
  account: ACCOUNT, model: MODEL, host: hostname(), loadAverage: loadavg(), node: process.version,
  startedAt: new Date().toISOString(), promptOrder: PROMPT_ORDER, pauseMs,
  usageSource: "thread/tokenUsage/updated.tokenUsage.total delta per turn; cached input is included in input",
  firstOutputBoundary: "turn/start write to first nonempty item/agentMessage/delta; item/completed fallback labeled",
  auth: "Honeybee account.get homePath -> child CODEX_HOME; no auth-file reads or environment inheritance",
};
const save = (status: string) => {
  writeFileSync(join(out, "measurements.json"), `${JSON.stringify({ ...metadata, status, turns: rows }, null, 2)}\n`, { mode: 0o600 });
  const columns = ["mailId", "turnId", "rpcAckMs", "firstAssistantOutputMs", "finishMs", "inputTokens", "outputTokens", "cachedInputTokens", "cacheHitShare", "pauseBeforeMs", "compactionCount"];
  writeFileSync(join(out, "measurements.tsv"), `${columns.join("\t")}\n${rows.map(row => columns.map(key => row[key] ?? "").join("\t")).join("\n")}\n`, { mode: 0o600 });
};

type Pending = { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
let child: ChildProcessWithoutNullStreams | undefined;
let nextId = 1;
let active: TurnMeasurement | null = null;
let fatal: Error | null = null;
let stderrBytes = 0;
const pending = new Map<number, Pending>();
const fail = (reason: string) => {
  fatal ??= new Error(reason);
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(fatal); }
  pending.clear();
};
const write = (frame: unknown) => {
  if (!child?.stdin.writable) throw new Error("App-server input unavailable");
  child.stdin.write(`${JSON.stringify(frame)}\n`);
};
const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
  if (fatal) return Promise.reject(fatal);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    log("rpc.sent", { id, method });
    try { write({ jsonrpc: "2.0", id, method, params }); }
    catch { clearTimeout(timer); pending.delete(id); reject(new Error("RPC write failed")); }
  });
};

async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const owned = child;
  const exited = new Promise<void>(resolve => owned.once("exit", () => resolve()));
  owned.stdin.end();
  owned.kill("SIGTERM");
  const timer = setTimeout(() => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); }, 5_000);
  await exited;
  clearTimeout(timer);
  log("process.stopped", { pid: owned.pid, code: owned.exitCode, signal: owned.signalCode, stderrBytes });
}

process.once("SIGTERM", () => fail("Spike interrupted by SIGTERM"));
process.once("SIGINT", () => fail("Spike interrupted by SIGINT"));

try {
  let accountResponse: Record<string, unknown>;
  try {
    accountResponse = object(JSON.parse(execFileSync("hive", ["account", "get", ACCOUNT, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 })));
  } catch { throw new Error("Cannot resolve the pinned Honeybee account through live account.get"); }
  const account = object(accountResponse.account);
  if (account.id !== ACCOUNT || account.harness !== "codex" || typeof account.homePath !== "string") throw new Error("Pinned account metadata mismatch");
  const home = account.homePath;
  log("account.selected", { account: ACCOUNT, source: "Honeybee live account.get", automaticSwitching: false });
  const env = { HOME: join(out, "home"), TMPDIR: join(out, "tmp"), PATH: process.env.PATH, CODEX_HOME: home };
  const version = execFileSync("codex", ["--version"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();
  log("runtime.version", { version });
  const bootStart = performance.now();
  const threadId = await withCodexHomeBootLock(home, async (lock) => {
    log("boot.lock", { waited: lock.waited, waitMs: lock.waitMs });
    child = spawn("codex", ["app-server", "-c", "mcp_servers={}"], { env, cwd: join(out, "workspace"), stdio: ["pipe", "pipe", "pipe"] });
    log("process.started", { pid: child.pid, environmentPolicy: "explicit allowlist; HOME and TMPDIR inside run directory" });
    child.on("error", () => fail("App-server process error"));
    child.stdin.on("error", () => fail("App-server input error"));
    child.once("exit", () => fail("App-server exited"));
    child.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; });
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        const frame = object(JSON.parse(line));
        if (typeof frame.method === "string") {
          if (frame.id !== undefined) {
            write({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "No client-side tools or login supported in spike" } });
            log("server.request.refused");
            fail("Unexpected server request; no tools or auth refresh handled by spike");
            return;
          }
          const params = object(frame.params);
          active?.observe(frame.method, params, performance.now());
          if (frame.method === "thread/tokenUsage/updated" && active && params.threadId === active.threadId) {
            log("thread.tokenUsage", { threadId: active.threadId, turnId: active.turnId, total: active.total, last: active.last });
          }
          if (frame.method === "error") { log("server.error", { willRetry: params.willRetry === true }); if (!params.willRetry) fail("App-server error; raw error omitted"); }
          if (active && frame.method === "turn/completed" && params.threadId === active.threadId) log("turn.completed", { turnId: active.turnId, status: active.status });
          return;
        }
        if (typeof frame.id !== "number") return;
        const entry = pending.get(frame.id);
        if (!entry) return;
        pending.delete(frame.id);
        clearTimeout(entry.timer);
        if (frame.error !== undefined) entry.reject(new Error("App-server RPC rejected; raw error omitted"));
        else { log("rpc.accepted", { id: frame.id }); entry.resolve(object(frame.result)); }
      } catch { fail("Invalid app-server frame or usage counters; raw content omitted"); }
    });
    await request("initialize", { clientInfo: { name: "hive-champion-spike", title: "Champion spike", version: "1" }, capabilities: null });
    write({ jsonrpc: "2.0", method: "initialized" });
    const auth = object((await request("account/read", { refreshToken: false })).account);
    if (auth.type !== "chatgpt") throw new Error(`Human login required: on Studio run hive login ${ACCOUNT}, then rerun the spike`);
    if (auth.email !== account.label) throw new Error("Native account identity does not match the pinned Honeybee account label");
    log("auth.confirmed", { account: ACCOUNT, mode: "chatgpt", identityMatchesHoneybee: true });
    const thread = codexThreadRequest({ cwd: join(out, "workspace"), model: MODEL });
    const result = await request(thread.method, {
      ...thread.params, sandbox: "read-only", baseInstructions: IDENTITY,
      developerInstructions: "Use only the ordered Champion prompt supplied by the client. Never call tools.",
      ephemeral: true, config: { mcp_servers: {}, model_reasoning_effort: "low" },
    });
    const id = object(result.thread).id;
    if (typeof id !== "string") throw new Error("App-server returned no thread id");
    log("thread.opened", { threadId: id, bootMs: performance.now() - bootStart });
    return id;
  }, { timeoutMs: 60_000 });
  let previous: Usage = ZERO_USAGE;
  for (const [index, mail] of MAIL.entries()) {
    const pauseStart = performance.now();
    if (index === 2) { log("pause.started", { pauseMs }); await delay(pauseMs); }
    const pauseBeforeMs = index === 2 ? performance.now() - pauseStart : 0;
    const prompt = championPrompt(mail.summary, mail.text);
    const measurement = new TurnMeasurement(threadId, performance.now(), previous);
    active = measurement;
    log("turn.sent", { mailId: mail.id, promptSha256: createHash("sha256").update(prompt).digest("hex"), promptChars: prompt.length, pauseBeforeMs });
    const accepted = await request("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], effort: "low" });
    measurement.rpcAckMs = performance.now() - measurement.startedAtMs;
    const nativeId = object(accepted.turn).id;
    if (typeof nativeId === "string" && measurement.turnId !== null && measurement.turnId !== nativeId) throw new Error("Turn id changed before acceptance");
    if (typeof nativeId === "string") measurement.turnId = nativeId;
    while (measurement.status === null || (measurement.status === "completed" && measurement.total === null)) {
      if (fatal) throw fatal;
      if (performance.now() - measurement.startedAtMs > TIMEOUT_MS) throw new Error("Turn/usage timeout");
      await delay(10);
    }
    const result = measurement.result();
    if (measurement.output.trim() !== mail.expected) throw new Error("Champion acknowledgment mismatch");
    rows.push({ mailId: mail.id, ...result, pauseBeforeMs, compactionCount: result.compactionEvents.length, acknowledgment: mail.expected });
    previous = result.nativeTotal;
    log("turn.measured", rows.at(-1));
    save("running");
    active = null;
  }
  save("completed");
  log("run.completed", { turns: rows.length, turn2CachePositive: Number(rows[1]?.cacheHitShare) > 0 });
  console.log(JSON.stringify({ out, turns: rows.length, turn2CacheHitShare: rows[1]?.cacheHitShare }));
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown spike failure";
  log("run.failed", { reason: message });
  save("failed");
  console.error(message);
  process.exitCode = 1;
} finally {
  await stopChild();
}
