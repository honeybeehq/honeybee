#!/usr/bin/env node
/**
 * Standalone harness boot profiler: replays the exact command a runner-host
 * config records (command, args, cwd, env, boot lines) OUTSIDE Honeybee, drives
 * the same handshake the adapter would, and stamps every stdout/stderr line,
 * child process, and TCP connect with microseconds since exec. Harness debug
 * logging is switched on where the harness offers it (claude --debug-file,
 * codex RUST_LOG, grok --debug-file, opencode --print-logs) so the harness's
 * own stages (config read, MCP connects, auth, model fetch, session start) are
 * attributable from its own timestamps.
 *
 *   node scripts/perf/harness-boot.mjs --config <runner .json> --harness claude|codex|grok|kimi|opencode \
 *     [--session-log <bee .jsonl>] [--no-sandbox] [--no-debug] [--prompt "reply ok"] [--timeout-ms 60000] --out file.json
 *
 * The session log supplies the daemon-side handshake params (thread/start,
 * session/new, set_config_option) so the replay matches production exactly;
 * cwd is taken from the runner config. Never run this against a live bee's
 * home while that bee is mid-turn: harness homes are single-writer caches.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, loadavg, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { createNetWatcher, createProcWatcher, isLinux } from "./boot-trace-lib.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1]; };
const has = (name) => argv.includes(name);
const configPath = opt("--config", null);
const harness = opt("--harness", null);
if (!configPath || !harness) throw new Error("--config and --harness are required");
const sessionLogPath = opt("--session-log", null);
const prompt = opt("--prompt", "Reply with the single word ok.");
const timeoutMs = Number(opt("--timeout-ms", "60000"));
const out = opt("--out", `harness-boot-${harness}-${Date.now()}.json`);
const noSandbox = has("--no-sandbox");
const debug = !has("--no-debug");
const skipPrompt = has("--no-prompt");

const cfg = JSON.parse(readFileSync(configPath, "utf8"));
let command = cfg.command;
let args = [...cfg.args];
let sandbox = null;
if (command === "bwrap" || command.endsWith("/bwrap")) {
  sandbox = "bwrap";
  if (noSandbox) {
    const dd = args.indexOf("--");
    command = args[dd + 1];
    args = args.slice(dd + 2);
  }
} else if (command === "sandbox-exec" || command.endsWith("/sandbox-exec")) {
  sandbox = "seatbelt";
  const f = args.indexOf("-f");
  if (noSandbox || (f >= 0 && !existsSync(args[f + 1]))) {
    sandbox = noSandbox ? "seatbelt" : "seatbelt(profile missing; ran unsandboxed)";
    command = args[f + 2];
    args = args.slice(f + 3);
  }
}
// Locate the harness argv inside a wrapper so debug flags land on the harness.
function innerIndex() {
  if (command !== "bwrap" && !command.endsWith("/bwrap") && command !== "sandbox-exec") return -1;
  if (command.endsWith("bwrap")) return args.indexOf("--") + 1;
  return args.indexOf("-f") + 2;
}
function stripArgs(flagsWithValue, flags) {
  const start = Math.max(innerIndex(), 0);
  const head = args.slice(0, start);
  const tail = [];
  for (let i = start; i < args.length; i++) {
    if (flagsWithValue.includes(args[i])) { i++; continue; }
    if (flags.includes(args[i])) continue;
    tail.push(args[i]);
  }
  args = [...head, ...tail];
}
const env = { ...process.env, ...(cfg.env ?? {}) };
const scratch = mkdtempSync(join(tmpdir(), "harness-boot-"));
let debugFile = null;
// Fresh session every time: resume/fork flags belong to the bee we copied.
if (harness === "claude") stripArgs(["--resume", "--session-id"], ["--fork-session"]);
if (debug) {
  if (harness === "claude") { debugFile = join(scratch, "claude-debug.log"); args.push("--debug-file", debugFile); }
  if (harness === "codex") env.RUST_LOG = env.RUST_LOG ?? "codex_core=debug,codex_app_server=debug,codex_rmcp_client=debug,codex_login=debug,codex_protocol=info,info";
  if (harness === "grok") { debugFile = join(scratch, "grok-debug.log"); args.push("--debug-file", debugFile); }
  if (harness === "opencode") { args.push("--print-logs", "--log-level", "DEBUG"); }
}
// bwrap mounts a private /tmp: the debug file must live somewhere the sandbox can write.
if (debugFile && sandbox === "bwrap" && !noSandbox) {
  const cellBind = args.indexOf("--bind");
  const writable = cellBind >= 0 ? args[cellBind + 1] : cfg.cwd;
  debugFile = join(writable, `.harness-boot-debug-${process.pid}.log`);
  const at = args.lastIndexOf("--debug-file");
  args[at + 1] = debugFile;
}

// Session-log handshake params ------------------------------------------------
const clientLines = [];
if (sessionLogPath && existsSync(sessionLogPath)) {
  for (const line of readFileSync(sessionLogPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m && typeof m.method === "string" && !("result" in m) && !("error" in m)) clientLines.push(m);
    if (clientLines.length > 12) break;
  }
}
const findClient = (method) => clientLines.find((m) => m.method === method);

// Timeline -------------------------------------------------------------------
const t0 = process.hrtime.bigint();
const wall0 = Date.now();
const us = () => Number((process.hrtime.bigint() - t0) / 1000n);
const events = [];
const record = (kind, fields) => { events.push({ us: us(), kind, ...fields }); };
const procs = createProcWatcher(record);
const net = createNetWatcher(record, procs);
record("profile.started", { host: hostname(), platform: platform(), harness, command, args: args.map((a) => a.slice(0, 200)), cwd: cfg.cwd, sandbox, debug, load: loadavg(), wall0, handshakeFromLog: clientLines.map((m) => m.method) });

const child = spawn(command, args, { cwd: cfg.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
record("exec.requested", { pid: child.pid });
child.on("spawn", () => record("exec.confirmed", { pid: child.pid }));
child.on("error", (e) => { record("exec.error", { error: String(e) }); finish("exec-error"); });
child.on("exit", (code, signal) => { record("exit", { code, signal }); });

function write(line) {
  record("stdin.write", { line: line.slice(0, 160) });
  child.stdin.write(`${line}\n`);
}
const stage = { booted: null, sessionId: null, turnEnded: null, init: null };
let nextId = 100;

function onStdout(line) {
  record("stdout", { line: line.slice(0, 200) });
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  switch (harness) {
    case "claude": {
      if (msg.type === "system" && msg.subtype === "init") { stage.init = us(); stage.booted = us(); stage.sessionId = msg.session_id; record("stage.booted", { via: "system/init", sessionId: msg.session_id, mcpServers: msg.mcp_servers }); }
      if (msg.type === "result") { stage.turnEnded = us(); record("stage.turn_ended", { via: "result" }); finish("done"); }
      return;
    }
    case "codex": {
      if (msg.id === 1 && "result" in msg) {
        record("stage.initialized", {});
        const ts = findClient("thread/start") ?? findClient("thread/resume") ?? findClient("thread/fork");
        const params = ts ? { ...ts.params } : {};
        delete params.threadId; delete params.path;
        params.cwd = cfg.cwd;
        write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }));
        write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/start", params }));
      }
      if (msg.id === 2 && msg.result?.thread?.id) {
        stage.booted = us(); stage.sessionId = msg.result.thread.id;
        record("stage.booted", { via: "thread/start result", threadId: stage.sessionId });
        if (skipPrompt) return finish("done");
        write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: stage.sessionId, input: [{ type: "text", text: prompt }] } }));
      }
      if (msg.method === "turn/completed" || (msg.method === "item/completed" && msg.params?.item?.type === "agentMessage")) {
        if (msg.method === "turn/completed") { stage.turnEnded = us(); record("stage.turn_ended", { via: msg.method }); finish("done"); }
      }
      return;
    }
    case "grok":
    case "kimi":
    case "opencode": {
      if (msg.id === 1 && "result" in msg) {
        record("stage.initialized", { authMethods: msg.result?.authMethods?.map((a) => a.id) });
        const sn = findClient("session/new") ?? findClient("session/load") ?? findClient("session/resume");
        const params = sn ? { ...sn.params } : { mcpServers: [] };
        delete params.sessionId;
        params.cwd = cfg.cwd;
        write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params }));
      }
      if (msg.id === 2 && msg.result?.sessionId) {
        stage.sessionId = msg.result.sessionId;
        record("stage.session_new", { sessionId: stage.sessionId });
        if (harness === "kimi") {
          const model = clientLines.find((m) => m.method === "session/set_config_option" && m.params?.configId === "model");
          const mode = clientLines.find((m) => m.method === "session/set_config_option" && m.params?.configId === "mode");
          if (model) write(JSON.stringify({ jsonrpc: "2.0", id: `kimi:model:${stage.sessionId}`, method: "session/set_config_option", params: { sessionId: stage.sessionId, configId: "model", value: model.params.value } }));
          if (mode) write(JSON.stringify({ jsonrpc: "2.0", id: `kimi:mode:${stage.sessionId}`, method: "session/set_config_option", params: { sessionId: stage.sessionId, configId: "mode", value: mode.params.value } }));
          if (!model && !mode) { stage.booted = us(); record("stage.booted", { via: "session/new result (no config replay)" }); if (skipPrompt) return finish("done"); sendPrompt(); }
        } else {
          stage.booted = us(); record("stage.booted", { via: "session/new result" });
          if (skipPrompt) return finish("done");
          sendPrompt();
        }
      }
      if (typeof msg.id === "string" && msg.id.startsWith("kimi:mode:") && "result" in msg) {
        stage.booted = us(); record("stage.booted", { via: "set_config_option mode result" });
        if (skipPrompt) return finish("done");
        sendPrompt();
      }
      if (typeof msg.id === "string" && msg.id.startsWith("kimi:model:") && "result" in msg) record("stage.model_set", {});
      if (msg.id === nextId - 1 && ("result" in msg || "error" in msg)) { stage.turnEnded = us(); record("stage.turn_ended", { via: "session/prompt result", error: msg.error ?? null }); finish("done"); }
      if (msg.method === "session/request_permission" && msg.id != null) {
        const options = msg.params?.options ?? [];
        const allow = options.find((o) => /allow/.test(String(o.kind ?? o.optionId ?? "")));
        write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { outcome: allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" } } }));
      }
      return;
    }
  }
}
function sendPrompt() {
  const id = nextId++;
  write(JSON.stringify({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: stage.sessionId, prompt: [{ type: "text", text: prompt }] } }));
}

let rest = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  const data = rest + chunk;
  const lines = data.split("\n");
  rest = lines.pop() ?? "";
  for (const l of lines) if (l.trim()) onStdout(l.replace(/\r$/, ""));
});
let errRest = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const data = errRest + chunk;
  const lines = data.split("\n");
  errRest = lines.pop() ?? "";
  for (const l of lines) if (l.trim()) record("stderr", { line: l.slice(0, 300) });
});

for (const line of cfg.bootLines ?? []) write(line);
if (harness === "claude" && !skipPrompt) {
  write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }));
}

let finished = false;
function finish(reason) {
  if (finished) return;
  finished = true;
  setTimeout(() => {
    procs.poll(); net.poll();
    let debugLines = [];
    if (debugFile && existsSync(debugFile)) {
      debugLines = readFileSync(debugFile, "utf8").split("\n").filter(Boolean).map((line) => {
        const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/);
        const wall = m ? Date.parse(m[1]) : null;
        return { us: wall == null ? null : (wall - wall0) * 1000, line: line.slice(0, 300) };
      });
    }
    const report = { host: hostname(), platform: platform(), harness, wall0, reason, sandbox, debug, command, cwd: cfg.cwd, stage, loadAfter: loadavg(), events, debugLines, children: procs.snapshot() };
    writeFileSync(out, JSON.stringify(report, null, 1));
    process.stdout.write(`harness-boot ${harness} ${reason}: booted=${stage.booted}us turn_ended=${stage.turnEnded}us -> ${out}\n`);
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} process.exit(0); }, 1500);
  }, 300);
}
setTimeout(() => finish("timeout"), timeoutMs);
function tick() {
  if (finished) return;
  procs.poll();
  net.poll();
  setTimeout(tick, isLinux ? 3 : 0);
}
tick();
