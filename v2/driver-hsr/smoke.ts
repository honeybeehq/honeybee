/**
 * WP3 manual smoke runner (SMOKE.md, steps 1–5 automated; step 6 stays manual).
 *
 *   npm run v2:smoke -- stub                 # wiring proof, no tokens
 *   npm run v2:smoke -- claude [--model m]   # real claude CLI from PATH
 *   npm run v2:smoke -- codex  [--model m]   # real codex app-server from PATH
 *   npm run v2:smoke -- grok   [--model m]   # real grok agent stdio from PATH
 *   npm run v2:smoke -- agy    [--model m] [--effort e]  # real `agy acp` from PATH (run `npm run build` first)
 *   npm run v2:smoke -- muse   [--model m] [--provider echo]  # real muse serve from PATH
 *
 * Spawns ONE real bee (plus one short-lived boot-delivery bee), runs two short
 * turns, stops it, and prints a ✓/✗ checklist. agy runs its own flow (below):
 * three short turns that also prove a session MCP server, cancel and resume. Delivery uses daemon semantics:
 * a not_ready refusal is retried, never treated as failure — refusal is only a
 * failure where the contract says it must not happen. Everything lives in a
 * fresh temp dir; ~/.hive is never touched.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeHost, type SpawnSpec } from "./src/index.ts";
import { agyAdapter, agySpawnPlan, agyVersionRefusal, claudeAdapter, codexAdapter, createTranscriptProjector, grokAdapter, grokSpawnPlan, museAdapter, museSpawnPlan, stubAdapter, AGY_MIN_VERSION, type TranscriptProjectedEvent } from "../adapters/src/index.ts";
import type { DeliverOutcome, DriverObservation } from "../harness/src/driver.ts";

const here = dirname(fileURLToPath(import.meta.url));
const harness = process.argv[2];
const modelFlag = process.argv.indexOf("--model");
const model = modelFlag > 0 ? process.argv[modelFlag + 1] : undefined;
const providerFlag = process.argv.indexOf("--provider");
const provider = providerFlag > 0 ? process.argv[providerFlag + 1] : undefined;
const effortFlag = process.argv.indexOf("--effort");
const effort = effortFlag > 0 ? process.argv[effortFlag + 1] : undefined;

if (!harness || !["stub", "agy", "claude", "codex", "grok", "muse"].includes(harness)) {
  console.error("usage: npm run v2:smoke -- <stub|agy|claude|codex|grok|muse> [--model <m>] [--effort <e>] [--provider <p>]");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "hive-smoke-"));
const logDir = join(dir, "logs");
const cwd = mkdtempSync(join(tmpdir(), "hive-smoke-cwd-"));

function specFor(): SpawnSpec {
  switch (harness) {
    case "agy":
      return agySpec("smoke-1");
    case "claude":
      return {
        adapter: claudeAdapter,
        command: "claude",
        args: [
          "-p",
          "--input-format", "stream-json",
          "--output-format", "stream-json",
          "--verbose",
          ...(model ? ["--model", model] : []),
        ],
        cwd,
      };
    case "codex":
      return {
        adapter: codexAdapter({ cwd, ...(model ? { model } : {}) }),
        command: "codex",
        args: ["app-server"],
        cwd,
      };
    case "grok": {
      const home = join(dir, "grok-home");
      mkdirSync(home, { recursive: true });
      const realAuth = join(homedir(), ".grok", "auth.json");
      if (existsSync(realAuth)) copyFileSync(realAuth, join(home, "auth.json"));
      const planned = grokSpawnPlan([
        "--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio",
        ...(model ? ["--model", model] : []),
      ]);
      return {
        adapter: grokAdapter({ cwd }),
        command: "grok",
        args: planned.argv,
        cwd,
        env: { ...(process.env as Record<string, string>), GROK_HOME: home },
      };
    }
    case "muse": {
      const planned = museSpawnPlan([
        "serve", "-c", "context.foreign_personal_rules=false", "-c", "context.foreign_personal_skills=false",
        ...(provider ? ["--provider", provider] : []),
        ...(model ? ["--model", model] : []),
      ]);
      return {
        adapter: museAdapter({ cwd, ...(planned.model ? { model: planned.model } : {}), approvalMode: planned.approvalMode }),
        command: "muse",
        args: planned.argv,
        cwd,
        env: { ...(process.env as Record<string, string>), MUSE_NO_AUTO_UPDATE: "1" },
      };
    }
    default:
      return {
        adapter: stubAdapter,
        command: process.execPath,
        args: [join(here, "test-agent", "agent.mjs")],
        cwd,
        env: { STUB_BOOT_MS: "300", STUB_TURN_MS: "200" },
      };
  }
}

/**
 * agy: every smoke turn runs on a Gemini model (the session default may be
 * another vendor's), with one stdio MCP server in session/new. smoke-1 takes
 * the model family and effort through configuration options; smoke-2 takes a
 * concrete model id.
 */
const AGY_MODEL = model ?? "gemini-3.8-flash";
const AGY_EFFORT = effort ?? "low";
const mcpLog = join(dir, "mcp-calls.jsonl");
let agyResumeSessionId: string | undefined;
function agySpec(beeId: string): SpawnSpec {
  const concrete = beeId === "smoke-2";
  const planned = agySpawnPlan([
    "acp", "--dangerously-skip-permissions",
    ...(concrete ? ["--model", `${AGY_MODEL}-${AGY_EFFORT}`] : ["--model", AGY_MODEL, "--effort", AGY_EFFORT]),
  ]);
  return {
    adapter: agyAdapter({
      cwd,
      model: planned.model,
      effort: planned.effort,
      skipPermissions: planned.skipPermissions,
      apiKeyAuth: (process.env.GEMINI_API_KEY ?? "").length > 0,
      mcpServers: [{ name: "smoke", command: process.execPath, args: [join(here, "test-agent", "smoke-mcp-server.mjs")], env: [{ name: "SMOKE_MCP_LOG", value: mcpLog }] }],
      ...(agyResumeSessionId && !concrete ? { resumeSessionId: agyResumeSessionId } : {}),
    }),
    command: "agy",
    args: planned.argv,
    cwd,
    env: { ...(process.env as Record<string, string>), AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
  };
}

const spec = specFor();
const driver = new RuntimeHost({ sessionLogDir: logDir, resolve: (beeId) => harness === "agy" ? agySpec(beeId) : specFor() });
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push([name, ok, detail]);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const events: DriverObservation[] = [];
function drain(): void {
  events.push(...driver.observe());
}
async function waitFor(
  kind: DriverObservation["kind"],
  beeId: string,
  timeoutMs: number,
): Promise<DriverObservation | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    drain();
    const hit = events.find((e) => e.kind === kind && e.beeId === beeId);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}
/** Daemon semantics: not_ready means retry, not failure. */
async function deliverRetrying(
  beeId: string,
  messageId: number,
  body: string,
  timeoutMs: number,
): Promise<DeliverOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = driver.deliver(beeId, 1, messageId, body);
    if (out.accepted || out.reason !== "not_ready") return out;
    if (Date.now() > deadline) return out;
    await new Promise((r) => setTimeout(r, 500));
    drain();
  }
}

const BOOT_TIMEOUT = harness === "stub" ? 5_000 : 120_000;
const TURN_TIMEOUT = harness === "stub" ? 5_000 : 300_000;

function logRows(beeId: string): Array<Record<string, unknown>> {
  const path = join(logDir, `${beeId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    try {
      const row: unknown = JSON.parse(line);
      return row && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function projected(beeId: string): TranscriptProjectedEvent[] {
  const projector = createTranscriptProjector(harness as string);
  const path = join(logDir, `${beeId}.jsonl`);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0) : [];
  return [...lines.flatMap((line) => projector.pushLine(line)), ...projector.flush()];
}

/**
 * agy over ACP. Three short turns on one session: one calls the session MCP
 * server, one is cancelled, one runs after stop and session/resume and must
 * recall the first. A second runtime proves boot refusal and a concrete model
 * id without a turn.
 */
/** Boot, or the flag evidence that says why not (a signed-out agy never boots). */
async function agyBoot(beeId: string): Promise<{ booted: boolean; refusal: string }> {
  const deadline = Date.now() + BOOT_TIMEOUT;
  for (;;) {
    drain();
    if (events.some((e) => e.kind === "booted" && e.beeId === beeId)) return { booted: true, refusal: "" };
    const refusal = driver.observeEvidence().find((flag) => flag.beeId === beeId && flag.action === "set");
    if (refusal) return { booted: false, refusal: `${refusal.flag}: ${refusal.detail}` };
    const exited = events.find((e) => e.kind === "exited" && e.beeId === beeId);
    if (exited) return { booted: false, refusal: `exited ${exited.exitCause ?? ""} ${exited.detail ?? ""}`.trim() };
    if (Date.now() > deadline) return { booted: false, refusal: "boot timeout" };
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function agySmoke(): Promise<void> {
  let version: string | null = null;
  try {
    version = execFileSync("agy", ["--version"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null;
  } catch {
    version = null;
  }
  check(`agy is ${AGY_MIN_VERSION} or newer`, version !== null && agyVersionRefusal(version) === null, version ?? "agy --version failed");
  check("smoke model is a Gemini model", AGY_MODEL.startsWith("gemini-"), `${AGY_MODEL} effort ${AGY_EFFORT}`);
  if (!AGY_MODEL.startsWith("gemini-")) return;

  driver.start("smoke-1", 1);
  const proc = driver.procOf("smoke-1", 1);
  check("pid + start-time captured at spawn", !!proc && proc.pid > 0, proc ? `pid ${proc.pid}` : "no process");
  const early = driver.deliver("smoke-1", 1, 1, "Reply with exactly: SMOKE_EARLY");
  check("deliver while booting refused not_ready", !early.accepted && early.reason === "not_ready", early.accepted ? "was accepted" : early.reason ?? "");
  const boot = await agyBoot("smoke-1");
  const sessionId = driver.observeSessions().find((s) => s.beeId === "smoke-1")?.sessionId;
  check("booted with a session id (session/new with an MCP server, model and effort applied)", boot.booted && !!sessionId, sessionId ?? boot.refusal);
  if (!boot.booted || !sessionId) return;

  // Turn 1: the session MCP server. (Boot lands on idle through its own turn_ended.)
  await waitFor("turn_ended", "smoke-1", 5_000);
  events.length = 0;
  const d1 = await deliverRetrying("smoke-1", 2, "Call the smoke_echo tool with text SMOKE_TURN_1, then reply with exactly what the tool returned.", TURN_TIMEOUT);
  check("first deliver accepted", d1.accepted, d1.reason ?? "");
  const t1s = await waitFor("turn_started", "smoke-1", TURN_TIMEOUT);
  const t1e = await waitFor("turn_ended", "smoke-1", TURN_TIMEOUT);
  check("turn_started then turn_ended", !!t1s && !!t1e);
  const calls = existsSync(mcpLog) ? readFileSync(mcpLog, "utf8") : "";
  check("the session MCP server was called", calls.includes('"tools/call"') && calls.includes("SMOKE_TURN_1"), calls.includes('"initialize"') ? "server started" : "server never started");
  const turn1 = projected("smoke-1");
  const toolCall = turn1.find((event) => event.kind === "tool_call");
  check("projection has the tool call, its result and the answer",
    !!toolCall && turn1.some((event) => event.kind === "tool_result") && turn1.some((event) => event.kind === "message" && event.role === "assistant" && event.text.includes("SMOKE_TURN_1")),
    toolCall?.kind === "tool_call" ? `tool ${toolCall.name}` : "no tool_call event");

  // Turn 2: cancel.
  events.length = 0;
  const d2 = await deliverRetrying("smoke-1", 3, "Count from 1 to 400, one number per line, with nothing else.", TURN_TIMEOUT);
  check("second deliver accepted", d2.accepted, d2.reason ?? "");
  const t2s = await waitFor("turn_started", "smoke-1", TURN_TIMEOUT);
  const interrupted = t2s ? driver.interrupt("smoke-1", 1) : { interrupted: false, reason: "no turn" };
  check("interrupt sent mid-turn", interrupted.interrupted, interrupted.interrupted ? "" : String(interrupted.reason));
  const t2e = await waitFor("turn_ended", "smoke-1", 60_000);
  const stops = logRows("smoke-1").flatMap((row) => typeof row.id === "number" && row.id >= 1000 && row.method === undefined && row.result && typeof row.result === "object" ? [String((row.result as Record<string, unknown>).stopReason)] : []);
  check("the cancelled prompt ended as cancelled and the runtime stayed up", !!t2e && stops.at(-1) === "cancelled" && driver.hasProcess("smoke-1", 1), `stop reasons: ${stops.join(", ")}`);

  // Stop, then resume the same session in a new process.
  events.length = 0;
  const stopped = driver.stop("smoke-1", 1, "stopped_by_user");
  check("stop had a live process", stopped.hadProcess);
  const exited = await waitFor("exited", "smoke-1", 15_000);
  check("exited with stopped cause", exited?.exitCause === "stopped_by_user", `exitCause=${exited?.exitCause ?? "none"}`);
  events.length = 0;
  agyResumeSessionId = sessionId;
  driver.start("smoke-1", 2);
  const resumed = (await agyBoot("smoke-1")).booted;
  const resumedSession = driver.observeSessions().find((s) => s.beeId === "smoke-1" && s.generation === 2)?.sessionId;
  check("session/resume booted the same session", resumed && resumedSession === sessionId, resumedSession ?? "no session");
  if (resumed) {
    await waitFor("turn_ended", "smoke-1", 5_000);
    events.length = 0;
    const before = projected("smoke-1").length;
    const deadline = Date.now() + TURN_TIMEOUT;
    let d3: DeliverOutcome;
    for (;;) {
      d3 = driver.deliver("smoke-1", 2, 4, "What text did the smoke_echo tool return earlier in this conversation? Reply with only that text.");
      if (d3.accepted || d3.reason !== "not_ready" || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 500));
      drain();
    }
    check("deliver after resume accepted", d3.accepted, d3.reason ?? "");
    const t3e = await waitFor("turn_ended", "smoke-1", TURN_TIMEOUT);
    const answer = projected("smoke-1").slice(before).flatMap((event) => event.kind === "message" && event.role === "assistant" ? [event.text] : []).join(" ");
    check("the resumed session recalls the first turn", !!t3e && answer.includes("SMOKE_TURN_1"), answer.slice(0, 120));
  }
  driver.stop("smoke-1", 2, "stopped_by_user");

  // A concrete model id, through the model option or its session/set_model retry. No turn.
  events.length = 0;
  driver.start("smoke-2", 1);
  const concrete = await agyBoot("smoke-2");
  const routes = logRows("smoke-2").flatMap((row) => typeof row.id === "string" && row.id.startsWith("agy:") ? [`${row.id.split(":")[1]}=${"error" in row ? "refused" : "result" in row ? "ok" : "sent"}`] : []);
  check(`a concrete model id (${AGY_MODEL}-${AGY_EFFORT}) boots`, concrete.booted, `${routes.join(" ")} ${concrete.refusal}`.trim());
  driver.stop("smoke-2", 1, "stopped_by_user");

  const rows = logRows("smoke-1");
  const raw = existsSync(join(logDir, "smoke-1.jsonl")) ? readFileSync(join(logDir, "smoke-1.jsonl"), "utf8").trim().split("\n") : [];
  check("session log is verbatim native jsonl", raw.length > 0 && rows.length === raw.length, `${raw.length} lines`);

  // Protocol facts for the adapter's record (no credentials appear in ACP rows; only shapes are printed).
  const updates = rows.flatMap((row) => row.method === "session/update" ? [((row.params as Record<string, unknown> | undefined)?.update ?? {}) as Record<string, unknown>] : []);
  const kinds = new Map<string, number>();
  for (const update of updates) kinds.set(String(update.sessionUpdate), (kinds.get(String(update.sessionUpdate)) ?? 0) + 1);
  const initialized = rows.find((row) => row.id === 1 && "result" in row)?.result as Record<string, unknown> | undefined;
  // Updates outside a prompt: harmless unless they are of a kind that opens a turn.
  const outside = new Map<string, number>();
  let open = false;
  for (const row of rows) {
    if (row.method === "session/prompt") open = true;
    else if (typeof row.id === "number" && row.id >= 1000 && row.method === undefined) open = false;
    else if (row.method === "session/update" && !open) {
      const kind = String((((row.params as Record<string, unknown> | undefined)?.update ?? {}) as Record<string, unknown>).sessionUpdate);
      outside.set(kind, (outside.get(kind) ?? 0) + 1);
    }
  }
  const opening = ["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].filter((kind) => outside.has(kind));
  check("no turn-opening update arrives outside a prompt", opening.length === 0, opening.join(", "));
  console.log("\nagy protocol facts:");
  console.log(`  agentInfo: ${JSON.stringify(initialized?.agentInfo ?? null)}`);
  console.log(`  authMethods: ${JSON.stringify(Array.isArray(initialized?.authMethods) ? initialized.authMethods.map((m) => (m as Record<string, unknown>).id) : null)}`);
  console.log(`  agentCapabilities: ${JSON.stringify(initialized?.agentCapabilities ?? null)}`);
  console.log(`  configuration (smoke-1): ${rows.flatMap((row) => typeof row.id === "string" && row.id.startsWith("agy:") && row.method === undefined ? [`${row.id.split(":")[1]}=${"error" in row ? `refused ${JSON.stringify(row.error)}` : "ok"}`] : []).join("; ")}`);
  console.log(`  configuration (smoke-2): ${routes.join(" ")}`);
  console.log(`  authenticate sent: ${rows.some((row) => row.method === "authenticate")}`);
  console.log(`  session/update kinds: ${[...kinds].map(([kind, count]) => `${kind}×${count}`).join(", ")}`);
  console.log(`  session/update outside a prompt: ${[...outside].map(([kind, count]) => `${kind}×${count}`).join(", ") || "none"}`);
  console.log(`  permission requests: ${rows.filter((row) => row.method === "session/request_permission").length}`);
  for (const update of updates.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update")) {
    console.log(`  ${String(update.sessionUpdate)}: ${JSON.stringify({ title: update.title, name: update.name, kind: update.kind, status: update.status, keys: Object.keys(update).sort(), args: update.args, rawInput: update.rawInput, content: update.content, rawOutput: update.rawOutput }).slice(0, 900)}`);
  }
  for (const row of rows.filter((r) => typeof r.id === "number" && r.id >= 1000 && r.method === undefined)) {
    console.log(`  prompt ${row.id} response: ${JSON.stringify("error" in row ? { error: row.error } : row.result).slice(0, 500)}`);
  }
  console.log(`  projected events: ${projected("smoke-1").map((event) => event.kind === "tool_call" ? `tool_call(${event.name})` : event.kind === "message" ? `message(${event.role})` : event.kind === "turn_end" ? `turn_end(${event.finishReason ?? ""})` : event.kind).join(" ")}`);
}

function finish(): never {
  console.log(`\nsession logs: ${logDir}`);
  console.log("step 6 (auth-failure evidence) remains manual — see SMOKE.md.");
  const failed = results.filter(([, ok]) => !ok);
  console.log(failed.length === 0
    ? `\nSMOKE ${harness}: ALL ${results.length} CHECKS PASS`
    : `\nSMOKE ${harness}: ${failed.length}/${results.length} FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
}

try {
  if (harness === "agy") {
    try {
      await agySmoke();
    } finally {
      for (const [beeId, generation] of [["smoke-1", 1], ["smoke-1", 2], ["smoke-2", 1]] as const) {
        try { driver.stop(beeId, generation, "stopped_by_system"); } catch { /* already gone */ }
      }
    }
    finish();
  }
  // 1. spawn
  driver.start("smoke-1", 1);
  const live = driver.procOf("smoke-1", 1);
  check("pid + start-time captured at spawn", !!live && live.pid > 0, live ? `pid ${live.pid}` : "no process");
  const booted = await waitFor("booted", "smoke-1", BOOT_TIMEOUT);
  check("booted observation", !!booted, spec.adapter.readyAtSpawn ? "synthetic (ready at spawn)" : "");

  if (!booted) {
    // Fail fast: everything downstream needs a live runtime — do not compound
    // timeouts for 20 minutes (lesson from the first claude smoke run).
    check("first turn", false, "skipped: no boot");
    check("follow-up turn", false, "skipped: no boot");
  } else {
    // 2–3. first turn
    const d1 = await deliverRetrying("smoke-1", 1, "Reply with exactly: SMOKE_TURN_1", TURN_TIMEOUT);
    check("first deliver accepted", d1.accepted, d1.reason ?? "");
    const t1s = await waitFor("turn_started", "smoke-1", TURN_TIMEOUT);
    const t1e = await waitFor("turn_ended", "smoke-1", TURN_TIMEOUT);
    check("turn_started then turn_ended", !!t1s && !!t1e);

    // 3b. follow-up turn (retry covers harness-internal continuation turns)
    events.length = 0;
    const d2 = await deliverRetrying("smoke-1", 2, "Reply with exactly: SMOKE_TURN_2", TURN_TIMEOUT);
    check("follow-up deliver accepted", d2.accepted, d2.reason ?? "");
    const t2e = await waitFor("turn_ended", "smoke-1", TURN_TIMEOUT);
    check("second turn completed", !!t2e);
  }

  // 4. delivery-at-boot contract — adapter-specific by design
  driver.start("smoke-2", 1);
  const early = driver.deliver("smoke-2", 1, 3, "Reply with exactly: SMOKE_EARLY");
  if (spec.adapter.readyAtSpawn) {
    check("deliver at spawn accepted (readyAtSpawn)", early.accepted, early.reason ?? "");
    const et = await waitFor("turn_ended", "smoke-2", TURN_TIMEOUT);
    check("spawn-time delivery produced a turn", !!et);
  } else {
    check("deliver while booting refused not_ready", !early.accepted && early.reason === "not_ready",
      early.accepted ? "was accepted" : early.reason ?? "");
    const boot2 = await waitFor("booted", "smoke-2", BOOT_TIMEOUT);
    const late = boot2
      ? await deliverRetrying("smoke-2", 4, "Reply with exactly: SMOKE_LATE", TURN_TIMEOUT)
      : ({ accepted: false, reason: "not_ready" } as DeliverOutcome);
    check("accepted after boot", late.accepted, boot2 ? (late.reason ?? "") : "no boot");
  }
  driver.stop("smoke-2", 1, "stopped_by_user");

  // 5. stop
  events.length = 0;
  const stopped = driver.stop("smoke-1", 1, "stopped_by_user");
  check("stop had a live process", stopped.hadProcess);
  const exited = await waitFor("exited", "smoke-1", 10_000);
  check("exited with stopped cause", exited?.exitCause === "stopped_by_user",
    `exitCause=${exited?.exitCause ?? "none"}`);

  // session log verbatim (file exists only if the runtime emitted any lines)
  const logPath = join(logDir, "smoke-1.jsonl");
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, "utf8").trim().split("\n");
    const parseable = log.filter((l) => { try { JSON.parse(l); return true; } catch { return false; } });
    check("session log is verbatim native jsonl", log.length > 0 && parseable.length === log.length,
      `${log.length} lines`);
  } else {
    check("session log is verbatim native jsonl", false, "no log file — runtime emitted zero lines");
  }

  finish();
} finally {
  try { driver.stop("smoke-1", 1, "stopped_by_system"); } catch { /* already gone */ }
  try { driver.stop("smoke-2", 1, "stopped_by_system"); } catch { /* already gone */ }
}
