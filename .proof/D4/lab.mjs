// D4 lab: one scratch node under /var/tmp with its own data dir, socket, runtime root, unit file,
// launcher and a fake service manager (PATH-shimmed systemctl + a Node supervisor that plays
// systemd: SIGTERM the main pid on restart, run the launcher again, Restart=on-failure).
// Proves: five live stub bees (hsr and Cell) survive runtime.activate to a second version
// (boot.handover adopted=5 expected=5), a bee mid-turn keeps its turn, runtime.probe spawns and
// deletes a stub canary in a fresh Cell, a candidate that exits at boot three times reverts to
// previous (rollback: crash_loop), the probe fails typed when a host is killed between census
// and boot, and the typed refusals. Nothing here touches a real service manager or ~/.hive.
import { execFile, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const REPO = resolve(process.env.REPO ?? ".");
const DIST = join(REPO, "dist");
const NODE = process.execPath;
const OUT = resolve(process.env.OUT ?? join(REPO, ".proof", "D4", "lab.jsonl"));
const execFileAsync = promisify(execFile);
const { RpcClient } = await import(join(REPO, "v2", "cli", "src", "client.ts"));
const { readLiveEndpointRecord } = await import(join(REPO, "v2", "daemon", "src", "endpointRecord.ts"));
const { installLauncher } = await import(join(REPO, "v2", "daemon", "src", "launcher.ts"));

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40), SHA_C = "c".repeat(40), SHA_D = "d".repeat(40), SHA_X = "e".repeat(40);
const LABEL = "hb.d4.test";
const root = mkdtempSync("/var/tmp/hb-D4-");
const dataDir = join(root, "v2"), runtimeRoot = join(root, "runtime"), home = join(root, "home"), units = join(root, "units"), bin = join(root, "bin");
for (const dir of [dataDir, runtimeRoot, home, units, bin, join(root, "tmp"), join(root, "cells")]) mkdirSync(dir, { recursive: true });
const lines = [];
const record = (entry) => { const row = { at: new Date().toISOString(), ...entry }; lines.push(row); writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); console.log(JSON.stringify(row)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => { record({ step: "FAIL", message }); throw new Error(message); };
const expect = (name, pass, detail = {}) => { record({ step: name, pass, ...detail }); if (!pass) fail(`${name}: ${JSON.stringify(detail)}`); };

// Versions: A and B are this tree's dist with their own build identity; C exits at boot; D claims an older schema.
const identity = readFileSync(join(DIST, "build-identity.json"), "utf8");
const stage = (sha, label) => {
  const dir = join(runtimeRoot, sha);
  cpSync(DIST, join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "build-identity.json"), JSON.stringify({ ...JSON.parse(identity), version: `d4-lab-${label}`, sourceRevision: sha, dirty: false }, null, 2));
  return dir;
};
stage(SHA_A, "A"); stage(SHA_B, "B");
for (const [sha, schema, exitCode] of [[SHA_C, 59, 3], [SHA_D, 58, 0]]) {
  const dir = join(runtimeRoot, sha);
  mkdirSync(join(dir, "dist", "v2"), { recursive: true });
  writeFileSync(join(dir, "dist", "cli.js"), `console.error("d4 lab candidate ${sha.slice(0, 4)} exits at boot");process.exit(${exitCode});\n`);
  writeFileSync(join(dir, "dist", "v2", "cli.js"), `var SCHEMA_VERSION = ${schema};\n`);
  writeFileSync(join(dir, "dist", "build-identity.json"), JSON.stringify({ ...JSON.parse(identity), version: `d4-lab-${sha.slice(0, 1)}`, sourceRevision: sha, dirty: false }, null, 2));
}
symlinkSync(SHA_A, join(runtimeRoot, "current"));
const launcher = await installLauncher(runtimeRoot);
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ naming: { auto: false }, cells: { root: join(root, "cells"), retention: { enabled: false } }, agents: { stub: { command: NODE, args: [join(REPO, "v2", "driver-hsr", "test-agent", "agent.mjs")], adapter: "stub" } } }));
const env = {
  PATH: `${bin}:${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: join(root, "tmp"), NO_COLOR: "1", TERM: "dumb",
  HIVE_V2_DATA_DIR: dataDir, HIVE_NODE_PATH: NODE, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1",
  HIVE_V2_SERVICE_DIR: units, HIVE_V2_SERVICE_LABEL: LABEL,
  HIVE_CLAUDE_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage", HIVE_CLAUDE_PROFILE_URL: "http://127.0.0.1:9/api/oauth/profile",
  HIVE_CLAUDE_OAUTH_TOKEN_URL: "http://127.0.0.1:9/v1/oauth/token", HIVE_CODEX_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token",
  HIVE_GROK_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_TEST_META_URL: "http://127.0.0.1:9",
};
const execArgs = [launcher, NODE, "v2", "daemon", "run", "--data-dir", dataDir];
writeFileSync(join(units, `${LABEL}.service`), `[Unit]\nDescription=Honeybee v2 hive daemon (${LABEL})\n\n[Service]\nType=simple\nExecStart=${execArgs.map((a) => `"${a}"`).join(" ")}\nKillMode=process\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`);

// The fake service manager. systemctl logs every call; `restart --no-block` hands the unit to the supervisor.
const serviceState = join(root, "service.json"), systemctlLog = join(root, "systemctl.log"), supervisorLog = join(root, "supervisor.log");
writeFileSync(systemctlLog, "");
writeFileSync(join(bin, "supervisor.mjs"), `
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [state, logPath, launcher, node, dataDir] = process.argv.slice(2);
const log = (line) => appendFileSync(logPath, \`\${new Date().toISOString()} \${line}\\n\`);
const read = () => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return { mainPid: null, starts: [] }; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const current = read();
if (current.mainPid && alive(current.mainPid)) {
  log(\`stop: SIGTERM main pid \${current.mainPid} (KillMode=process: only the main pid)\`);
  process.kill(current.mainPid, "SIGTERM");
  const until = Date.now() + 30000;
  while (alive(current.mainPid) && Date.now() < until) await sleep(20);
  log(\`stop: main pid \${current.mainPid} \${alive(current.mainPid) ? "STILL ALIVE" : "gone"}\`);
}
let starts = current.starts ?? [];
for (;;) {
  const child = spawn(launcher, [node, "v2", "daemon", "run", "--data-dir", dataDir], { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  starts.push({ pid: child.pid, at: Date.now() });
  writeFileSync(state, JSON.stringify({ mainPid: child.pid, starts }));
  log(\`start: launcher pid \${child.pid} (start #\${starts.length})\`);
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const code = await new Promise((r) => child.on("exit", (c, s) => r(c ?? \`signal \${s}\`)));
  log(\`exit: pid \${child.pid} code \${code} output=\${JSON.stringify(output.slice(-300))}\`);
  if (code === 0) { writeFileSync(state, JSON.stringify({ mainPid: null, starts })); break; }
  log("Restart=on-failure: RestartSec 0.3");
  await sleep(300);
}
`);
writeFileSync(join(bin, "systemctl"), `#!/bin/sh
echo "systemctl $*" >> "${systemctlLog}"
case "$*" in
  "--user restart --no-block ${LABEL}.service")
    setsid "${NODE}" "${join(bin, "supervisor.mjs")}" "${serviceState}" "${supervisorLog}" "${launcher}" "${NODE}" "${dataDir}" </dev/null >>"${supervisorLog}.out" 2>&1 &
    exit 0 ;;
  *is-active*) echo active; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> "${systemctlLog}"\nexit 0\n`, { mode: 0o755 });
const supervise = () => spawn(NODE, [join(bin, "supervisor.mjs"), serviceState, supervisorLog, launcher, NODE, dataDir], { env, stdio: "ignore", detached: true }).unref();
const serviceMainPid = () => { try { return JSON.parse(readFileSync(serviceState, "utf8")).mainPid; } catch { return null; } };
const starts = () => { try { return JSON.parse(readFileSync(serviceState, "utf8")).starts.length; } catch { return 0; } };
const systemctlCalls = () => readFileSync(systemctlLog, "utf8").split("\n").filter(Boolean);
const daemonLog = () => { try { return readFileSync(join(dataDir, "hived.log"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).op; } catch { return l; } }); } catch { return []; } };
const linkOf = (name) => { try { return readlinkSync(join(runtimeRoot, name)); } catch { return null; } };

// Daemon connection helpers. Each daemon is identified by the endpoint record's pid.
let client = null;
const connect = async (notPid, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readLiveEndpointRecord(dataDir);
    if (live && live.pid !== notPid) {
      try { client = await RpcClient.connect(live.socketPath, 500); return live; } catch {}
    }
    await sleep(25);
  }
  fail(`no daemon listening (other than pid ${notPid}) within ${timeoutMs} ms; supervisor log: ${readFileSync(supervisorLog, "utf8").slice(-1500)}`);
};
const rpc = async (verb, params = {}, timeout = 120000) => {
  const started = performance.now();
  try { const result = await client.request(verb, params, timeout); return { ok: true, result, ms: Math.round((performance.now() - started) * 10) / 10 }; }
  catch (error) { return { ok: false, code: error.code, reason: error.details?.reason ?? null, details: error.details ?? null, message: error.message, ms: Math.round((performance.now() - started) * 10) / 10 }; }
};
const hive = async (...args) => {
  const started = performance.now();
  const result = await execFileAsync(NODE, [join(runtimeRoot, "current", "dist", "cli.js"), ...args, "--data-dir", dataDir], { env, maxBuffer: 64 * 1024 * 1024 }).then((r) => ({ ok: true, ...r }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }));
  return { ...result, ms: Math.round((performance.now() - started) * 10) / 10 };
};
const view = async (beeId) => (await rpc("view", { beeId })).result;
const waitFor = async (what, fn, timeoutMs = 60000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(50); } fail(`timeout waiting for ${what}`); };
const pidGone = async (pid, timeoutMs = 30000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return true; } await sleep(20); } return false; };
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; };
const timeRpc = async (verb, n) => { const samples = []; for (let i = 0; i < n; i += 1) { const r = await rpc(verb); if (!r.ok) fail(`${verb}: ${r.message}`); samples.push(r.ms); } return { n, p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), max: Math.max(...samples) }; };

// A swap as the updater sees it: activate, watch the old socket drop, reconnect to the successor.
const swap = async (sha, { viaCli = false, afterAnswer = async () => {} } = {}) => {
  const old = readLiveEndpointRecord(dataDir);
  const started = performance.now();
  let answer;
  if (viaCli) {
    const r = await hive("runtime", "activate", sha, "--json");
    answer = r.ok ? { ok: true, result: JSON.parse(r.stdout), ms: r.ms, stdout: r.stdout } : { ok: false, stderr: r.stderr, ms: r.ms };
  } else answer = await rpc("runtime.activate", { sha });
  const answeredMs = Math.round(performance.now() - started);
  const links = { current: linkOf("current"), previous: linkOf("previous"), marker: existsSync(join(runtimeRoot, "handover.json")) ? JSON.parse(readFileSync(join(runtimeRoot, "handover.json"), "utf8")) : null };
  await afterAnswer();
  client?.close(); client = null;
  const gone = await pidGone(old.pid, 60000);
  const stoppedMs = Math.round(performance.now() - started);
  const successor = await connect(old.pid, 120000);
  const listeningMs = Math.round(performance.now() - started);
  return { answer, answeredMs, links, oldPid: old.pid, oldGone: gone, stoppedMs, listeningMs, successor, unservedMs: listeningMs - stoppedMs };
};

// A git origin for the Cell bees of the lab (the daemon makes its own for the probe canary).
const origin = join(root, "origin");
mkdirSync(origin);
const gitEnv = { ...env, GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@example.invalid", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@example.invalid" };
await execFileAsync("git", ["init", "-q", "-b", "main", origin], { env: gitEnv });
writeFileSync(join(origin, "README"), "d4 lab\n");
await execFileAsync("git", ["-C", origin, "add", "README"], { env: gitEnv });
await execFileAsync("git", ["-C", origin, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "lab"], { env: gitEnv });

let exitCode = 0;
try {
  record({ step: "lab.setup", root, runtimeRoot, dataDir, units, launcher, launcherLines: readFileSync(launcher, "utf8").split("\n").filter(Boolean).length, current: linkOf("current"), node: NODE, sandboxBwrap: existsSync("/usr/bin/bwrap") });

  // 1. The node starts under the fake unit on version A.
  const bootStarted = performance.now();
  supervise();
  const first = await connect(null);
  record({ step: "daemon.A.started", pid: first.pid, mainPid: serviceMainPid(), bootMs: Math.round(performance.now() - bootStarted), capabilities: client.capabilities.length, runtimeUpdate: client.capabilities.includes("runtime.update.v1") });
  const status0 = (await rpc("runtime.status")).result;
  expect("status.A", status0.current === SHA_A && status0.previous === null && status0.running.sourceRevision === SHA_A && status0.handover === null && status0.marker === null, { current: status0.current, previous: status0.previous, running: status0.running, installed: status0.installed.map((v) => v.sha.slice(0, 4)), store: status0.store });
  record({ step: "timing.before.deployInfo", ...(await timeRpc("deployInfo", 50)) });
  record({ step: "timing.before.runtime.status", ...(await timeRpc("runtime.status", 50)) });

  // 2. Five live stub bees: three hsr, two in fresh Cells. All idle.
  const bees = [];
  for (const [name, params] of [["hsr-1", {}], ["hsr-2", {}], ["hsr-3", {}], ["cell-1", { substrate: "cell", cell: { originRepo: origin } }], ["cell-2", { substrate: "cell", cell: { originRepo: origin } }]]) {
    const spawned = await rpc("spawn", { name, agent: "stub", cwd: root, ...params });
    if (!spawned.ok) fail(`spawn ${name}: ${spawned.message}`);
    bees.push({ name, beeId: spawned.result.beeId });
  }
  for (const bee of bees) {
    const v = await waitFor(`${bee.name} idle`, async () => { const r = await view(bee.beeId); return r.view.runtimeState === "idle" ? r : null; }, 120000);
    bee.generation = r0(v); bee.pid = v.runtime.pid; bee.substrate = v.bee.substrate; bee.cwd = v.bee.cwd;
  }
  function r0(v) { return v.runtime.generation; }
  record({ step: "bees.idle", bees: bees.map((b) => ({ name: b.name, substrate: b.substrate, generation: b.generation, pid: b.pid })) });
  expect("bees.substrates", bees.filter((b) => b.substrate === "cell").length === 2 && bees.filter((b) => b.substrate === "hsr").length === 3, { substrates: bees.map((b) => b.substrate) });

  // 3. One bee goes mid-turn right before the swap.
  const midTurn = bees[1];
  const sent = await rpc("send", { beeId: midTurn.beeId, body: "@slow:9000 keep this turn across the swap" });
  if (!sent.ok) fail(`send: ${sent.message}`);
  await waitFor("mid-turn bee running", async () => (await view(midTurn.beeId)).view.runtimeState === "running");
  const midTurnBefore = await view(midTurn.beeId);
  record({ step: "midturn.before", bee: midTurn.name, state: midTurnBefore.view.runtimeState, generation: midTurnBefore.runtime.generation, pid: midTurnBefore.runtime.pid });

  // 4. Activate B through the CLI with all five live. The old daemon answers, then the fake unit restarts it.
  const toB = await swap(SHA_B, { viaCli: true });
  expect("activate.B.answer", toB.answer.ok && toB.answer.result.sha === SHA_B && toB.answer.result.from === SHA_A && toB.answer.result.census.runtimes === 5 && toB.answer.result.census.degraded === 0, { answer: toB.answer, cliStdout: toB.answer.stdout?.slice(0, 400) });
  expect("activate.B.links", toB.links.current === SHA_B && toB.links.previous === SHA_A && toB.links.marker?.toSha === SHA_B && toB.links.marker?.fromPid === toB.oldPid, toB.links);
  expect("activate.B.restart", toB.oldGone && systemctlCalls().some((c) => c === `systemctl --user restart --no-block ${LABEL}.service`), { calls: systemctlCalls(), oldPid: toB.oldPid });
  record({ step: "activate.B.window", answeredMs: toB.answeredMs, oldStoppedMs: toB.stoppedMs, successorListeningMs: toB.listeningMs, unservedMs: toB.unservedMs, successorPid: toB.successor.pid, serviceStarts: starts() });
  const statusB = (await rpc("runtime.status")).result;
  const bootLine = daemonLog().filter((op) => op.startsWith("boot.handover ")).at(-1) ?? "";
  expect("boot.handover.B", statusB.running.sourceRevision === SHA_B && statusB.current === SHA_B && statusB.previous === SHA_A && statusB.marker === null && statusB.handover?.toSha === SHA_B && statusB.handover.result?.adopted === 5 && statusB.handover.result?.expected === 5 && statusB.handover.result?.degraded === 0 && statusB.handover.result?.reverted === false && /adopted=5 expected=5 degraded=0/.test(bootLine), { running: statusB.running, current: statusB.current, previous: statusB.previous, marker: statusB.marker, handover: statusB.handover, bootLine, markerFile: existsSync(join(runtimeRoot, "handover.json")) });
  expect("journal.activated", statusB.journal.some((e) => e.event === "activated" && e.sha === SHA_B && e.detail.from === SHA_A && e.detail.runtimes === 5), { journal: statusB.journal });
  const survivors = [];
  for (const bee of bees) {
    const v = await view(bee.beeId);
    survivors.push({ name: bee.name, generation: v.runtime.generation, pid: v.runtime.pid, state: v.view.runtimeState, samePid: v.runtime.pid === bee.pid, sameGeneration: v.runtime.generation === bee.generation });
  }
  expect("bees.survived", survivors.every((s) => s.samePid && s.sameGeneration && s.state !== "stopped"), { survivors });

  // 5. The mid-turn bee finishes its turn under the successor, same generation and pid.
  const midTurnAfter = await waitFor("mid-turn bee back to idle", async () => { const r = await view(midTurn.beeId); return r.view.runtimeState === "idle" ? r : null; }, 60000);
  const sessionLog = join(dataDir, "session-logs", `${midTurn.beeId}.jsonl`);
  const sessionText = existsSync(sessionLog) ? readFileSync(sessionLog, "utf8") : "";
  const echoed = sessionText.includes("@slow:9000") && sessionText.includes('"event":"turn_ended"');
  const ops = daemonLog();
  const successorStarted = ops.findIndex((op) => op === `daemon.started pid=${toB.successor.pid} store=${join(dataDir, "core.sqlite3")}`);
  const turnEndedUnderSuccessor = successorStarted >= 0 && ops.slice(successorStarted).some((op) => op === `obs.turn_ended bee=${midTurn.beeId} gen=${midTurn.generation}`);
  expect("midturn.kept", midTurnAfter.runtime.generation === midTurn.generation && midTurnAfter.runtime.pid === midTurn.pid && echoed && turnEndedUnderSuccessor, { generation: midTurnAfter.runtime.generation, pid: midTurnAfter.runtime.pid, echoed, turnEndedUnderSuccessor, successorPid: toB.successor.pid, lastOutputAt: midTurnAfter.view.lastOutputAt, turnStartedAt: ops.find((op) => op.startsWith(`obs.turn_started bee=${midTurn.beeId}`)) ?? null });

  // 6. The probe: handover complete, a stub canary in a fresh Cell reaches idle and is deleted.
  const probe = await rpc("runtime.probe", {}, 180000);
  expect("probe.ok", probe.ok && probe.result.handover.adopted === 5 && probe.result.handover.expected === 5 && probe.result.degraded === 0 && probe.result.canary.beeId && probe.result.canary.cell.includes("-space-"), { probe });
  const canaryRow = await rpc("view", { beeId: probe.result.canary.beeId });
  const canaryGone = !canaryRow.ok || canaryRow.result?.bee == null || JSON.stringify(canaryRow.result).includes('"lifecycle":"deleted"');
  const canaryCellGone = !existsSync(probe.result.canary.cell);
  expect("probe.canary.deleted", canaryGone, { canaryGone, canaryCellGone, canaryRow: canaryRow.ok ? { bee: canaryRow.result?.bee ? { lifecycle: canaryRow.result.bee.lifecycle, substrate: canaryRow.result.bee.substrate } : null, view: canaryRow.result?.view ? { lifecycle: canaryRow.result.view.lifecycle, runtimeState: canaryRow.result.view.runtimeState } : null } : { code: canaryRow.code } });
  const probeCli = await hive("runtime", "probe", "--json");
  expect("probe.cli", probeCli.ok && JSON.parse(probeCli.stdout).canary.beeId, { ok: probeCli.ok, ms: probeCli.ms, stderr: probeCli.stderr.slice(0, 300) });
  record({ step: "timing.after.deployInfo", ...(await timeRpc("deployInfo", 50)) });
  record({ step: "timing.after.runtime.status", ...(await timeRpc("runtime.status", 50)) });
  const statusCli = await hive("runtime", "status");
  record({ step: "status.cli", ok: statusCli.ok, ms: statusCli.ms, text: statusCli.stdout.split("\n").slice(0, 12) });

  // 7. Typed refusals, nothing moved.
  const refusals = [];
  for (const [name, params, code, reason] of [["not_installed", { sha: SHA_X }, "runtime_refused", "not_installed"], ["is_current", { sha: SHA_B }, "runtime_refused", "is_current"], ["store_newer_than_target", { sha: SHA_D }, "runtime_refused", "store_newer_than_target"], ["bad_sha", { sha: "abc" }, "invalid_request", "sha"]]) {
    const r = await rpc("runtime.activate", params);
    refusals.push({ name, pass: !r.ok && r.code === code && r.reason === reason, code: r.code, reason: r.reason, details: r.details, message: r.message });
  }
  expect("activate.refusals", refusals.every((r) => r.pass) && linkOf("current") === SHA_B && !existsSync(join(runtimeRoot, "handover.json")), { refusals, current: linkOf("current") });

  // 8. Crash loop: C exits at boot; after three failed starts the launcher reverts current to previous (B).
  const startsBefore = starts();
  const toC = await swap(SHA_C);
  expect("activate.C.answer", toC.answer.ok && toC.links.current === SHA_C && toC.links.previous === SHA_B, { answer: toC.answer, links: toC.links });
  const statusAfterC = (await rpc("runtime.status")).result;
  const rollbackEntry = statusAfterC.journal.find((e) => e.event === "rollback" && e.detail.reason === "crash_loop");
  const supervisorText = readFileSync(supervisorLog, "utf8");
  const failedStarts = (supervisorText.match(/exit: pid \d+ code 3/g) ?? []).length;
  expect("crashloop.reverted", statusAfterC.running.sourceRevision === SHA_B && statusAfterC.current === SHA_B && rollbackEntry?.detail.candidate === SHA_C && rollbackEntry?.detail.previous === SHA_B && rollbackEntry?.detail.attempts === 3 && failedStarts === 3 && !existsSync(join(runtimeRoot, "rollback.json")) && !existsSync(join(runtimeRoot, "handover.json")) && !existsSync(join(runtimeRoot, "handover.attempts")), { running: statusAfterC.running, current: statusAfterC.current, previous: statusAfterC.previous, rollbackEntry, failedStarts, serviceStarts: starts() - startsBefore, handover: statusAfterC.handover, bootLine: daemonLog().filter((op) => op.startsWith("boot.rollback")).at(-1) ?? null });
  const probeAfterC = await rpc("runtime.probe", {}, 180000);
  expect("probe.reverted", !probeAfterC.ok && probeAfterC.code === "runtime_refused" && probeAfterC.reason === "activation_reverted", { probe: probeAfterC });
  const survivorsAfterC = [];
  for (const bee of bees) { const v = await view(bee.beeId); survivorsAfterC.push({ name: bee.name, samePid: v.runtime.pid === bee.pid, sameGeneration: v.runtime.generation === bee.generation, state: v.view.runtimeState }); }
  expect("crashloop.bees_survived", survivorsAfterC.every((s) => s.samePid && s.sameGeneration && s.state !== "stopped"), { survivorsAfterC });

  // 9. A host killed between census and boot: the successor adopts 4 of 5 and the probe fails typed.
  const victim = bees[2];
  const toA = await swap(SHA_A, { afterAnswer: async () => { process.kill(victim.pid, "SIGKILL"); record({ step: "kill.between_census_and_boot", bee: victim.name, pid: victim.pid, currentBeforeBoot: linkOf("current") }); } });
  expect("activate.A.answer", toA.answer.ok && toA.answer.result.census.runtimes === 5, { answer: toA.answer });
  const statusA = (await rpc("runtime.status")).result;
  const bootLineA = daemonLog().filter((op) => op.startsWith("boot.handover ")).at(-1) ?? "";
  expect("boot.handover.A.incomplete", statusA.running.sourceRevision === SHA_A && statusA.handover.result.expected === 5 && statusA.handover.result.adopted === 4 && statusA.handover.result.missing.length === 1 && statusA.handover.result.missing[0].beeId === victim.beeId, { handover: statusA.handover, bootLineA });
  const probeA = await rpc("runtime.probe", {}, 180000);
  expect("probe.incomplete", !probeA.ok && probeA.code === "runtime_refused" && probeA.reason === "handover_incomplete" && probeA.details.adopted === 4 && probeA.details.expected === 5, { probe: probeA });
  const victimView = await view(victim.beeId);
  record({ step: "victim.after", state: victimView.view.runtimeState, exitCause: victimView.runtime.exitCause, generation: victimView.runtime.generation, reachable: victimView.view.reachable });

  record({ step: "systemctl.calls", calls: systemctlCalls(), serviceStarts: starts() });
  record({ step: "lab.done", pass: true });
} catch (error) {
  exitCode = 1;
  record({ step: "lab.error", message: error instanceof Error ? error.message : String(error), supervisorTail: (() => { try { return readFileSync(supervisorLog, "utf8").slice(-2000); } catch { return null; } })(), daemonLogTail: daemonLog().slice(-30) });
} finally {
  client?.close();
  const mainPid = serviceMainPid();
  const live = readLiveEndpointRecord(dataDir);
  for (const pid of new Set([mainPid, live?.pid].filter(Boolean))) { try { process.kill(pid, "SIGTERM"); } catch {} }
  if (mainPid) await pidGone(mainPid, 30000);
  const pids = (await execFileAsync("pgrep", ["-f", root]).catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid);
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  record({ step: "lab.cleanup", stoppedMainPid: mainPid, killedLeftovers: pids.length, keepRoot: process.env.KEEP_ROOT === "1" });
  try { cpSync(join(dataDir, "hived.log"), join(dirname(OUT), "hived.log")); cpSync(supervisorLog, join(dirname(OUT), "supervisor.log")); cpSync(systemctlLog, join(dirname(OUT), "systemctl.log")); } catch {}
  if (process.env.KEEP_ROOT !== "1") rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
