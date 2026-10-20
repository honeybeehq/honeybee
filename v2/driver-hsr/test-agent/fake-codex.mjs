#!/usr/bin/env node
/**
 * Fake `codex app-server` for the WP7 continuity test (spec 07 §F): a
 * JSON-RPC 2.0 stdio peer speaking the subset the codex adapter drives —
 * initialize → initialized → thread/start | thread/resume → turn/start | turn/steer —
 * and HONORS `thread/resume {threadId}` the way the real app-server does:
 * the response carries the same `thread.id`. `thread/fork {threadId}` (v6
 * bee.fork) answers with a NEW thread id (the app-server copies the rollout);
 * `turn/interrupt {threadId, turnId}` (v6 bee.interrupt) ends the in-flight
 * turn with turn/completed. `@slow:<ms>` in a turn's text makes it take that
 * long. Never a real agent CLI.
 *
 * env FAKE_CODEX_RPC_LOG   append {method, params, argv, env:{CODEX_HOME}} per request
 *                          (argv = the process's own args, so a test can see which
 *                          `-c key=value` overrides reached the app-server child)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function log(method, params) {
  if (!process.env.FAKE_CODEX_RPC_LOG) return;
  appendFileSync(
    process.env.FAKE_CODEX_RPC_LOG,
    `${JSON.stringify({ method, params, argv: process.argv.slice(2), cwd: process.cwd(), env: { CODEX_HOME: process.env.CODEX_HOME ?? null } })}\n`,
  );
}

const strictHome = process.env.FAKE_CODEX_STRICT_HOME === "1";
let rollout = null;
function indexRollout(id, path) {
  const db = new DatabaseSync(join(process.env.CODEX_HOME, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    db.prepare("INSERT OR REPLACE INTO threads VALUES (?, ?)").run(id, path);
  } finally { db.close(); }
}
function findRollout(id, path) {
  if (!path && existsSync(join(process.env.CODEX_HOME, "state_5.sqlite"))) {
    const db = new DatabaseSync(join(process.env.CODEX_HOME, "state_5.sqlite"), { readOnly: true });
    try { path = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(id)?.rollout_path; }
    finally { db.close(); }
  }
  if (!path || !existsSync(path)) throw new Error("rollout unavailable in CODEX_HOME");
  const rel = relative(realpathSync(process.env.CODEX_HOME), realpathSync(path));
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("rollout outside CODEX_HOME");
  const meta = JSON.parse(readFileSync(path, "utf8").split("\n")[0]);
  if (meta.type !== "session_meta" || meta.payload.id !== id) throw new Error("rollout identity mismatch");
  return path;
}

let threadId = null;
let turnTimer = null;
let currentTurnId = null;
let lateEffect = null;
process.on("SIGTERM", () => {
  if (lateEffect && rollout) {
    appendFileSync(rollout, JSON.stringify({ type: "fixture_late_effect", nonce: lateEffect }) + "\n");
    if (process.env.FAKE_CODEX_LATE_EFFECT_LOG) appendFileSync(process.env.FAKE_CODEX_LATE_EFFECT_LOG, JSON.stringify({ threadId, nonce: lateEffect }) + "\n");
  }
  process.exit(0);
});
const rl = createInterface({ input: process.stdin });
rl.on("line", (raw) => {
  const line = String(raw).trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg.method !== "string") return;
  log(msg.method, msg.params ?? null);
  switch (msg.method) {
    case "initialize":
      emit({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex/0" } });
      return;
    case "initialized":
      return;
    case "thread/start":
      threadId = randomUUID();
      if (strictHome) {
        rollout = join(process.env.CODEX_HOME, "sessions", `rollout-${threadId}.jsonl`);
        mkdirSync(dirname(rollout), { recursive: true });
        writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: threadId, model_provider: "openai" } }) + "\n");
        indexRollout(threadId, rollout);
      }
      emit({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, cwd: msg.params?.cwd ?? null } } });
      return;
    case "thread/resume":
      threadId = String(msg.params?.threadId ?? "");
      if (strictHome) {
        try { rollout = findRollout(threadId, msg.params?.path); indexRollout(threadId, rollout); }
        catch (error) { emit({ id: msg.id, error: { code: -32600, message: error.message } }); return; }
      }
      emit({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, cwd: msg.params?.cwd ?? null } } });
      return;
    case "thread/fork":
      // The fork is a NEW thread seeded from the source rollout.
      threadId = randomUUID();
      emit({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, cwd: msg.params?.cwd ?? null, forkedFrom: String(msg.params?.threadId ?? "") } } });
      return;
    case "config/value/write":
    case "config/mcpServer/reload":
      if (process.env.FAKE_CODEX_REJECT_RECONNECT === "1") emit({ id: msg.id, error: { code: -32601, message: "unsupported MCP control" } });
      else setTimeout(() => emit({ id: msg.id, result: {} }), Number(process.env.FAKE_CODEX_RECONNECT_DELAY_MS ?? "0"));
      return;
    case "turn/start": {
      if (process.env.FAKE_DELIVERY_REFUSE_ONCE === "1") {
        delete process.env.FAKE_DELIVERY_REFUSE_ONCE;
        emit({jsonrpc: "2.0", id: msg.id, error: {code: -32600, message: "fixture refused before acceptance"}});
        return;
      }
      const turnId = randomUUID();
      currentTurnId = turnId;
      const text = msg.params?.input?.[0]?.text ?? "";
      let reply = "echo";
      if (strictHome && rollout) {
        const late = /@lateEffect:([a-zA-Z0-9-]+)/.exec(String(text));
        if (late) lateEffect = late[1];
        const remember = /@remember:([a-zA-Z0-9-]+)/.exec(String(text));
        if (remember) appendFileSync(rollout, JSON.stringify({ type: "fixture_nonce", nonce: remember[1] }) + "\n");
        if (String(text).includes("@checkLate")) {
          const rows = readFileSync(rollout, "utf8").trim().split("\n").map(row => JSON.parse(row));
          reply = `late:${rows.filter(row => row.type === "fixture_late_effect").map(row => row.nonce).join(",")}`;
          log("fixture/lateRecall", { reply });
        }
        if (String(text).includes("@recall")) {
          const rows = readFileSync(rollout, "utf8").trim().split("\n").map(row => JSON.parse(row));
          reply = `recall:${rows.findLast(row => row.type === "fixture_nonce")?.nonce ?? "MISSING"}`;
          emit({ method: "item/started", params: { threadId, turnId, item: { id: `effect-${turnId}`, type: "commandExecution", command: "fixture-record-recall", status: "inProgress" } } });
          if (process.env.FAKE_CODEX_EFFECT_LOG) appendFileSync(process.env.FAKE_CODEX_EFFECT_LOG, JSON.stringify({ threadId, reply, home: process.env.CODEX_HOME }) + "\n");
          appendFileSync(rollout, JSON.stringify({ type: "fixture_effect", reply }) + "\n");
          emit({ method: "item/completed", params: { threadId, turnId, item: { id: `effect-${turnId}`, type: "commandExecution", command: "fixture-record-recall", status: "completed", exitCode: 0, aggregatedOutput: reply } } });
        }
      }
      const slow = /@slow:(\d+)/.exec(String(text));
      emit({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId } } });
      emit({ jsonrpc: "2.0", method: "turn/started", params: { threadId, turn: { id: turnId } } });
      const quotaMode = /@quota:(text_fallback|native|delayed|once|weekly_only|weekly)/.exec(String(text))?.[1];
      const marker = process.env.FAKE_QUOTA_ONCE_PATH ?? join(process.cwd(), ".fake-codex-quota-once");
      if (String(text).includes("@usageLimit") || (quotaMode && !(quotaMode === "once" && marker && existsSync(marker)))) {
        if (quotaMode === "once" && marker) writeFileSync(marker, "failed");
        if (quotaMode === "delayed") emit({ method: "item/completed", params: { threadId, item: { id: randomUUID(), type: "agentMessage", text: "visible progress before quota" } } });
        const error = quotaMode === "text_fallback" ? { message: "429 Too Many Requests: rate limit exceeded" } : { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" };
        emit({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "premium", primary: null, secondary: null, rateLimitReachedType: null } } });
        if (quotaMode && quotaMode !== "text_fallback") {
          const reset = Number(process.env.FAKE_QUOTA_RESETS_AT_SECONDS ?? Math.floor(Date.now() / 1000) + 3600);
          const weekly = quotaMode === "weekly" || quotaMode === "weekly_only";
          emit({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "premium", primary: quotaMode === "weekly_only" ? null : { usedPercent: weekly ? 40 : 100, windowDurationMins: 300, resetsAt: weekly ? reset - 3600 : reset }, secondary: weekly ? { usedPercent: 100, windowDurationMins: 10080, resetsAt: reset } : null, rateLimitReachedType: "rate_limit_reached" } } });
        }
        const fail = () => {
        emit({ method: "error", params: { threadId, turnId, error, willRetry: false } });
        emit({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed", error } } });
        currentTurnId = null;
        };
        if (quotaMode === "delayed") turnTimer = setTimeout(fail, 200);
        else fail();
        return;
      }
      if (String(text).includes("@quiet")) {
        emit({ method: "item/completed", params: { threadId, item: { id: randomUUID(), type: "agentMessage", text: "done <quiet/>\u{E0100}" } } });
        emit({ method: "account/rateLimits/updated", params: { rateLimits: { rateLimitReachedType: "probe", primary: { usedPercent: 0 } } } });
      }
      turnTimer = setTimeout(() => {
        turnTimer = null;
        currentTurnId = null;
        emit({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId, delta: reply } });
        // Mirrors the real structured stream seen in the CO.751a incident.
        // Lifecycle still derives from turn/completed; the status notification
        // is deliberately non-authoritative in the Codex adapter.
        emit({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
        emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", error: null } } });
      }, slow ? Number(slow[1]) : 10);
      return;
    }
    case "turn/steer": {
      const expected = String(msg.params?.expectedTurnId ?? "");
      if (turnTimer && currentTurnId === expected) {
        emit({ jsonrpc: "2.0", id: msg.id, result: { turnId: currentTurnId } });
      } else {
        emit({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32600, message: `fake-codex: active turn does not match ${expected}` },
        });
      }
      return;
    }
    case "turn/interrupt": {
      const wanted = String(msg.params?.turnId ?? "");
      if (turnTimer && currentTurnId === wanted) {
        clearTimeout(turnTimer);
        turnTimer = null;
        currentTurnId = null;
        emit({ jsonrpc: "2.0", id: msg.id, result: {} });
        emit({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { id: wanted, status: "interrupted", error: null }, interrupted: true } });
      } else {
        emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: `fake-codex: no active turn ${wanted}` } });
      }
      return;
    }
    default:
      if (msg.id !== undefined) emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `fake-codex: ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
