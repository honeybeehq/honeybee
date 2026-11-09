// D5 lab: one scratch node under /var/tmp with its own data dir, socket, runtime root, unit dir,
// launcher and a fake service manager (PATH-shimmed systemctl + a Node supervisor playing systemd
// with a configurable start latency and a stall mode). Proves: hive daemon install adopts an
// Apiary-written explicit-entry unit (the runtime is copied into runtime/<sha>, current points at
// it, ExecStart goes through the launcher); hive send and the client library hold through a swap
// and every send lands exactly once; a send 61 s into a stalled handover fails typed
// hived_handover_stalled; the pre-D5 build fast-fails in the same window and leaves current as an
// external link. Nothing here touches a real service manager or ~/.hive.
import { execFile, spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const REPO = resolve(process.env.REPO ?? ".");
const DIST = join(REPO, "dist");
const BEFORE_DIST = process.env.BEFORE_DIST ? resolve(process.env.BEFORE_DIST) : null;
const NODE = process.execPath;
const OUT = resolve(process.env.OUT ?? join(REPO, ".proof", "D5", "lab.jsonl"));
const START_DELAY_MS = Number(process.env.START_DELAY_MS ?? 1500);
const execFileAsync = promisify(execFile);
const { RpcClient, HandoverStalledError } = await import(join(REPO, "v2", "cli", "src", "client.ts"));
const { readLiveEndpointRecord } = await import(join(REPO, "v2", "daemon", "src", "endpointRecord.ts"));
const { artifactTreeDigest } = await import(join(REPO, "v2", "core", "src", "release", "strictUnpack.ts"));
const { serviceFileDataDir, serviceFileExecArgs } = await import(join(REPO, "v2", "daemon", "src", "service.ts"));

const SHA_S = "5".repeat(40), SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
const APIARY_HASH = "5a3aedcdb5932c0d3dc7cf21d52992e04c1be2d9c2b7da68af50bb54a144a7cf";
const LABEL = "hb.d5.test";
const root = mkdtempSync("/var/tmp/hb-D5-");
const dataDir = join(root, "v2"), runtimeRoot = join(root, "runtime"), home = join(root, "home"), units = join(root, "units"), bin = join(root, "bin");
for (const dir of [dataDir, runtimeRoot, home, units, bin, join(root, "tmp"), join(root, "cells")]) mkdirSync(dir, { recursive: true });
const lines = [];
const record = (entry) => { const row = { at: new Date().toISOString(), ...entry }; lines.push(row); writeFileSync(OUT, lines.map((l) => JSON.stringify(l)).join("\n") + "\n"); console.log(JSON.stringify(row)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => { record({ step: "FAIL", message }); throw new Error(message); };
const expect = (name, pass, detail = {}) => { record({ step: name, pass, ...detail }); if (!pass) fail(`${name}: ${JSON.stringify(detail)}`); };

// Versions. S is an Apiary-style external install (what the satellites run today); A and B are installed versions.
const identity = JSON.parse(readFileSync(join(DIST, "build-identity.json"), "utf8"));
const stageDist = (dir, sha, label) => {
  cpSync(DIST, join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "build-identity.json"), JSON.stringify({ ...identity, version: `d5-lab-${label}`, sourceRevision: sha, dirty: false }, null, 2));
};
const apiaryRuntime = (hash) => {
  const base = join(root, "apiary", "honeybee-runtime", hash);
  const honeybee = join(base, "lib", "node_modules", "honeybee");
  mkdirSync(join(honeybee, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(base, "bin"), { recursive: true });
  stageDist(honeybee, SHA_S, "S");
  writeFileSync(join(honeybee, "package.json"), JSON.stringify({ name: "honeybee", version: "0.0.1" }));
  symlinkSync("../../dist/cli.js", join(honeybee, "node_modules", ".bin", "hive"));
  symlinkSync("../lib/node_modules/honeybee/dist/cli.js", join(base, "bin", "hive"));
  return honeybee;
};
stageDist(join(runtimeRoot, SHA_A), SHA_A, "A");
stageDist(join(runtimeRoot, SHA_B), SHA_B, "B");
const external = apiaryRuntime(APIARY_HASH);
const externalDigest = await artifactTreeDigest(external);
const launcher = join(runtimeRoot, "launch");
const unitPath = join(units, `${LABEL}.service`);
const apiaryUnit = (entry, dir) => `[Unit]
Description=Honeybee v2 hive daemon (${LABEL})

[Service]
Type=simple
ExecStart="${NODE}" "${entry}" "v2" "daemon" "run" "--data-dir" "${dir}"
Environment="HIVE_NODE_PATH=${NODE}"
Environment="HIVE_V2_DATA_DIR=${dir}"
Environment="PATH=${bin}:${dirname(NODE)}:/usr/bin:/bin"
KillMode=process
Restart=always
RestartSec=2
StandardOutput=append:${dir}/hived.log
StandardError=append:${dir}/hived.log

[Install]
WantedBy=default.target
`;
writeFileSync(join(dataDir, "config.json"), JSON.stringify({ naming: { auto: false }, cells: { root: join(root, "cells"), retention: { enabled: false } }, agents: { stub: { command: NODE, args: [join(REPO, "v2", "driver-hsr", "test-agent", "agent.mjs")], adapter: "stub" } } }));
const env = {
  PATH: `${bin}:${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: join(root, "tmp"), NO_COLOR: "1", TERM: "dumb",
  HIVE_V2_DATA_DIR: dataDir, HIVE_NODE_PATH: NODE, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1",
  HIVE_V2_SERVICE_DIR: units, HIVE_V2_SERVICE_LABEL: LABEL,
  HIVE_CLAUDE_USAGE_URL: "http://127.0.0.1:9/api/oauth/usage", HIVE_CLAUDE_PROFILE_URL: "http://127.0.0.1:9/api/oauth/profile",
  HIVE_CLAUDE_OAUTH_TOKEN_URL: "http://127.0.0.1:9/v1/oauth/token", HIVE_CODEX_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token",
  HIVE_GROK_OAUTH_TOKEN_URL: "http://127.0.0.1:9/oauth/token", HIVE_TEST_META_URL: "http://127.0.0.1:9",
};
// hive daemon install is guarded: it must run under the account home (not a redirected HOME) and outside a Cell.
// The service manager it reaches is the PATH shim; the unit dir and label are the lab's.
const installEnv = { ...env, HOME: homedir() };
delete installEnv.HIVE_V2_DATA_DIR; delete installEnv.HIVE_NODE_PATH;

// The fake service manager. systemctl logs every call; `restart --no-block` hands the unit to the supervisor,
// which reads service.conf.json: startDelayMs (service-manager latency before the launcher runs) and stall (never start).
const serviceState = join(root, "service.json"), serviceConf = join(root, "service.conf.json"), systemctlLog = join(root, "systemctl.log"), supervisorLog = join(root, "supervisor.log");
writeFileSync(systemctlLog, "");
const configureService = (conf) => writeFileSync(serviceConf, JSON.stringify(conf));
configureService({ startDelayMs: START_DELAY_MS, stall: false });
writeFileSync(join(bin, "supervisor.mjs"), `
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [state, conf, logPath, launcher, node, dataDir] = process.argv.slice(2);
const log = (line) => appendFileSync(logPath, \`\${new Date().toISOString()} \${line}\\n\`);
const read = () => { try { return JSON.parse(readFileSync(state, "utf8")); } catch { return { mainPid: null, starts: [] }; } };
const config = () => { try { return JSON.parse(readFileSync(conf, "utf8")); } catch { return { startDelayMs: 0, stall: false }; } };
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
if (config().stall) { log("stall: the unit is not started again (simulated service-manager stall)"); writeFileSync(state, JSON.stringify({ mainPid: null, starts })); process.exit(0); }
const delay = config().startDelayMs ?? 0;
if (delay > 0) { log(\`start latency \${delay} ms before the launcher runs\`); await sleep(delay); }
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
    setsid "${NODE}" "${join(bin, "supervisor.mjs")}" "${serviceState}" "${serviceConf}" "${supervisorLog}" "${launcher}" "${NODE}" "${dataDir}" </dev/null >>"${supervisorLog}.out" 2>&1 &
    exit 0 ;;
  *is-active*) echo active; exit 0 ;;
esac
exit 0
`, { mode: 0o755 });
writeFileSync(join(bin, "launchctl"), `#!/bin/sh\necho "launchctl $*" >> "${systemctlLog}"\nexit 0\n`, { mode: 0o755 });
const supervise = () => spawn(NODE, [join(bin, "supervisor.mjs"), serviceState, serviceConf, supervisorLog, launcher, NODE, dataDir], { env, stdio: "ignore", detached: true }).unref();
const serviceMainPid = () => { try { return JSON.parse(readFileSync(serviceState, "utf8")).mainPid; } catch { return null; } };
const systemctlCalls = () => readFileSync(systemctlLog, "utf8").split("\n").filter(Boolean);
const daemonLog = () => { try { return readFileSync(join(dataDir, "hived.log"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).op; } catch { return l; } }); } catch { return []; } };
const linkOf = (name) => { try { return readlinkSync(join(runtimeRoot, name)); } catch { return null; } };
const marker = () => { try { return JSON.parse(readFileSync(join(runtimeRoot, "handover.json"), "utf8")); } catch { return null; } };
const ms = (started) => Math.round((performance.now() - started) * 10) / 10;

let client = null;
const connect = async (notPid, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readLiveEndpointRecord(dataDir);
    if (live && live.pid !== notPid) {
      try { client = await RpcClient.connect(live.socketPath, 500, undefined, { dataDir }); return live; } catch {}
    }
    await sleep(25);
  }
  fail(`no daemon listening (other than pid ${notPid}) within ${timeoutMs} ms; supervisor log: ${readFileSync(supervisorLog, "utf8").slice(-1500)}`);
};
const rpc = async (verb, params = {}, timeout = 120000) => {
  const started = performance.now();
  try { const result = await client.request(verb, params, timeout); return { ok: true, result, ms: ms(started) }; }
  catch (error) { return { ok: false, code: error.code, reason: error.details?.reason ?? null, details: error.details ?? null, message: error.message, ms: ms(started) }; }
};
const cliEntry = (dist = join(external, "dist")) => join(dist, "cli.js");
const hive = async (args, { dist, env: runEnv = env } = {}) => {
  const started = performance.now();
  const result = await execFileAsync(NODE, [cliEntry(dist), ...args, "--data-dir", dataDir], { env: runEnv, maxBuffer: 64 * 1024 * 1024 }).then((r) => ({ ok: true, ...r }), (error) => ({ ok: false, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code }));
  return { ...result, ms: ms(started) };
};
const json = (text) => { try { return JSON.parse(text.trim().split("\n").at(-1)); } catch { return null; } };
const view = async (beeId) => (await rpc("view", { beeId })).result;
const waitFor = async (what, fn, timeoutMs = 60000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(50); } fail(`timeout waiting for ${what}`); };
const pidGone = async (pid, timeoutMs = 30000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return true; } await sleep(10); } return false; };
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// One `hive send` as a subprocess, timed from spawn to exit; the body is the receipt.
const sendsInFlight = [];
const cliSend = (beeId, body, { dist, label } = {}) => {
  const startedAt = Date.now(), started = performance.now();
  const promise = hive(["send", beeId, body, "--json"], { dist }).then((r) => {
    const out = json(r.stdout);
    return { body, label: label ?? "after", startedAt, endedAt: Date.now(), ms: r.ms, ok: r.ok, messageId: out?.messageId ?? null, deduped: out?.deduped ?? null, error: out?.error?.code ?? (r.ok ? null : "exit"), errorMessage: out?.error?.message ?? (r.ok ? null : r.stderr.slice(0, 300)) };
  });
  sendsInFlight.push(promise);
  return promise;
};
const librarySend = async (beeId, body) => {
  const startedAt = Date.now(), started = performance.now();
  try {
    const c = await RpcClient.connect(join(dataDir, "hived.sock"), 3000, undefined, { dataDir });
    const connectedMs = ms(started);
    try { const result = await c.request("send", { beeId, body }); return { body, startedAt, endedAt: Date.now(), ms: ms(started), connectedMs, ok: true, messageId: result.messageId, error: null }; }
    finally { c.close(); }
  } catch (error) { return { body, startedAt, endedAt: Date.now(), ms: ms(started), ok: false, messageId: null, error: error.code ?? error.name, errorMessage: error.message, stalled: error instanceof HandoverStalledError }; }
};

const origin = join(root, "origin");
mkdirSync(origin);
const gitEnv = { ...env, GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@example.invalid", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@example.invalid" };
await execFileAsync("git", ["init", "-q", "-b", "main", origin], { env: gitEnv });
writeFileSync(join(origin, "README"), "d5 lab\n");
await execFileAsync("git", ["-C", origin, "add", "README"], { env: gitEnv });
await execFileAsync("git", ["-C", origin, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "lab"], { env: gitEnv });

let exitCode = 0;
try {
  record({ step: "lab.setup", root, runtimeRoot, dataDir, units, external, externalDigest, node: NODE, startDelayMs: START_DELAY_MS, beforeDist: BEFORE_DIST, cwdHome: homedir() });

  // 1. Before (the committed build): the Apiary unit names the explicit entry and current is an absolute link to it,
  //    the shape found on netcup-1. The old daemon install rewrites the unit through the launcher but leaves current
  //    external and copies nothing: runtime/previous after an activate would name a sha that is not installed.
  writeFileSync(unitPath, apiaryUnit(join(external, "dist", "cli.js"), dataDir));
  symlinkSync(external, join(runtimeRoot, "current"));
  if (BEFORE_DIST) {
    const before = await hive(["daemon", "install", "--json"], { dist: BEFORE_DIST, env: { ...installEnv, HIVE_NODE_PATH: NODE } });
    const unitAfterBefore = readFileSync(unitPath, "utf8");
    record({ step: "before.daemon_install", ok: before.ok, ms: before.ms, out: json(before.stdout), stderr: before.stderr.slice(0, 400), execStart: serviceFileExecArgs(unitAfterBefore), current: linkOf("current"), installedS: existsSync(join(runtimeRoot, SHA_S)), systemctl: systemctlCalls() });
    expect("before.leaves_current_external", before.ok && linkOf("current") === external && !existsSync(join(runtimeRoot, SHA_S)), { current: linkOf("current"), installedS: existsSync(join(runtimeRoot, SHA_S)) });
    rmSync(launcher, { force: true });
    writeFileSync(systemctlLog, "");
    writeFileSync(unitPath, apiaryUnit(join(external, "dist", "cli.js"), dataDir));
    rmSync(join(root, "node-runtime.json"), { force: true });
  }

  // 2. After: hive daemon install from the Apiary-installed build adopts the unit: runtime/<S> is a copy of the
  //    external install, current points at it, the launcher is written, ExecStart goes through it.
  const install = await hive(["daemon", "install", "--json"], { env: installEnv });
  const installOut = json(install.stdout);
  const unitText = readFileSync(unitPath, "utf8");
  const execStart = serviceFileExecArgs(unitText);
  record({ step: "daemon_install.adopt", ok: install.ok, ms: install.ms, out: installOut, stderr: install.stderr.slice(0, 400), execStart, unitDataDir: serviceFileDataDir(unitText), current: linkOf("current"), systemctl: systemctlCalls() });
  expect("adopt.copied", install.ok && installOut?.adopted?.sha === SHA_S && installOut.adopted.copied === true && installOut.adopted.retargeted === true && installOut.adopted.source === external, { adopted: installOut?.adopted });
  expect("adopt.bytes", existsSync(join(runtimeRoot, SHA_S, "dist", "cli.js")) && await artifactTreeDigest(join(runtimeRoot, SHA_S)) === externalDigest, { digest: externalDigest });
  expect("adopt.current", linkOf("current") === SHA_S, { current: linkOf("current") });
  expect("adopt.exec_through_launcher", execStart?.[0] === launcher && execStart[1] === NODE && execStart.slice(2).join(" ") === `v2 daemon run --data-dir ${dataDir}` && existsSync(launcher) && serviceFileDataDir(unitText) === dataDir && /Restart=on-failure/.test(unitText) && /KillMode=process/.test(unitText), { execStart, unit: unitText.split("\n").slice(0, 8) });
  expect("adopt.only_daemon_reload", systemctlCalls().length === 1 && systemctlCalls()[0] === "systemctl --user daemon-reload", { calls: systemctlCalls() });
  const again = await hive(["daemon", "install", "--json"], { env: installEnv });
  const againOut = json(again.stdout);
  expect("adopt.idempotent", again.ok && againOut?.adopted === null && linkOf("current") === SHA_S && readFileSync(unitPath, "utf8") === unitText && systemctlCalls().length === 2, { out: againOut, calls: systemctlCalls(), ms: again.ms });
  writeFileSync(systemctlLog, "");

  // 3. The node starts under the adopted unit (launcher -> current -> S).
  const bootStarted = performance.now();
  supervise();
  const first = await connect(null);
  record({ step: "daemon.S.started", pid: first.pid, mainPid: serviceMainPid(), bootMs: Math.round(performance.now() - bootStarted), runtimeUpdate: client.capabilities.includes("runtime.update.v1") });
  const status0 = (await rpc("runtime.status")).result;
  expect("status.S", status0.current === SHA_S && status0.previous === null && status0.running.sourceRevision === SHA_S && status0.marker === null && status0.installed.map((v) => v.sha).sort().join() === [SHA_S, SHA_A, SHA_B].sort().join(), { current: status0.current, previous: status0.previous, running: status0.running, installed: status0.installed.map((v) => v.sha.slice(0, 4)) });

  // 4. One stub bee, idle.
  const spawned = await rpc("spawn", { name: "d5-bee", agent: "stub", cwd: root });
  if (!spawned.ok) fail(`spawn: ${spawned.message}`);
  const beeId = spawned.result.beeId;
  await waitFor("bee idle", async () => (await view(beeId)).view.runtimeState === "idle", 120000);
  const warm = await cliSend(beeId, "d5-warm", { label: "warm" });
  expect("send.warm", warm.ok && warm.messageId != null, { warm });

  // 5. Sends across a swap S -> A. A sender loop issues `hive send` every 100 ms from before the activate until the
  //    successor has served for a while; the service manager adds START_DELAY_MS of latency so many sends start inside
  //    the window with no socket. The pre-D5 CLI and the library client each send once inside the window.
  const sends = [];
  let n = 0, keepSending = true;
  const loop = (async () => { while (keepSending) { sends.push(cliSend(beeId, `d5-swap-${n++}`)); await sleep(100); } })();
  await sleep(300);
  const old = readLiveEndpointRecord(dataDir);
  const swapStarted = Date.now();
  const activate = await rpc("runtime.activate", { sha: SHA_A });
  expect("activate.A.answer", activate.ok && activate.result.sha === SHA_A && activate.result.from === SHA_S && activate.result.census.runtimes === 1, { activate });
  const markerAfterAnswer = marker();
  client.close(); client = null;
  const oldGone = await pidGone(old.pid, 60000);
  const oldGoneAt = Date.now();
  const inGap = [];
  if (BEFORE_DIST) inGap.push(cliSend(beeId, "d5-before-cli", { dist: BEFORE_DIST, label: "before" }));
  inGap.push(cliSend(beeId, "d5-gap-cli", { label: "gap" }));
  const library = librarySend(beeId, "d5-gap-library");
  const successor = await connect(old.pid, 120000);
  const listeningAt = Date.now();
  await sleep(700);
  keepSending = false;
  await loop;
  const gapResults = await Promise.all(inGap);
  const libraryResult = await library;
  const results = await Promise.all(sends);
  const successorStatus = (await rpc("runtime.status")).result;
  const bootLine = daemonLog().filter((op) => op.startsWith("boot.handover ")).at(-1) ?? "";
  expect("boot.handover.A", successorStatus.running.sourceRevision === SHA_A && successorStatus.current === SHA_A && successorStatus.previous === SHA_S && successorStatus.marker === null && /adopted=1 expected=1 degraded=0/.test(bootLine), { running: successorStatus.running, current: successorStatus.current, previous: successorStatus.previous, bootLine });
  const window = { activateAt: swapStarted, oldGoneAt, listeningAt, gapMs: listeningAt - oldGoneAt, marker: markerAfterAnswer };
  const startedInGap = results.filter((s) => s.startedAt >= oldGoneAt && s.startedAt < listeningAt);
  const startedBefore = results.filter((s) => s.startedAt < oldGoneAt);
  const startedAfter = results.filter((s) => s.startedAt >= listeningAt);
  const mailbox = (await rpc("mailbox", { beeId })).result.messages;
  const countOf = (body) => mailbox.filter((m) => m.body === body).length;
  const landed = results.map((s) => ({ ...s, landed: countOf(s.body) }));
  const failed = landed.filter((s) => !s.ok);
  const duplicated = landed.filter((s) => s.landed > 1);
  const lostAcked = landed.filter((s) => s.ok && s.landed !== 1);
  const unackedLanded = landed.filter((s) => !s.ok && s.landed !== 0);
  record({ step: "swap.window", ...window, oldGone, successorPid: successor.pid, sends: results.length, startedBefore: startedBefore.length, startedInGap: startedInGap.length, startedAfter: startedAfter.length, held: startedInGap.map((s) => ({ body: s.body, ms: s.ms, startOffsetMs: s.startedAt - oldGoneAt, endedAfterListen: s.endedAt >= listeningAt })) });
  expect("swap.sends_exactly_once", startedInGap.length >= 5 && failed.length === 0 && duplicated.length === 0 && lostAcked.length === 0 && unackedLanded.length === 0 && startedInGap.every((s) => s.endedAt >= listeningAt), { failed: failed.map((s) => ({ body: s.body, error: s.error, errorMessage: s.errorMessage })), duplicated: duplicated.map((s) => s.body), lostAcked: lostAcked.map((s) => s.body), unackedLanded: unackedLanded.map((s) => s.body), inGap: startedInGap.length, total: results.length });
  const gapCli = gapResults.find((s) => s.label === "gap");
  expect("gap.cli_held_and_landed", gapCli.ok && countOf("d5-gap-cli") === 1 && gapCli.endedAt >= listeningAt, { gapCli, landed: countOf("d5-gap-cli") });
  expect("gap.library_held_and_landed", libraryResult.ok && countOf("d5-gap-library") === 1 && libraryResult.connectedMs >= (listeningAt - libraryResult.startedAt) - 50, { libraryResult, landed: countOf("d5-gap-library") });
  if (BEFORE_DIST) {
    const beforeCli = gapResults.find((s) => s.label === "before");
    expect("gap.before_build_fast_failed", !beforeCli.ok && beforeCli.error === "socket_unreachable" && countOf("d5-before-cli") === 0 && beforeCli.endedAt < listeningAt, { beforeCli, landed: countOf("d5-before-cli") });
  }
  const delivered = await waitFor("deliveries progressing under the successor", async () => { const rows = (await rpc("mailbox", { beeId })).result.messages; return rows.filter((m) => m.body.startsWith("d5-") && m.deliveredAt != null).length >= 5 ? rows : null; }, 60000);
  record({ step: "swap.delivering", landed: delivered.filter((m) => m.body.startsWith("d5-")).length, delivered: delivered.filter((m) => m.body.startsWith("d5-") && m.deliveredAt != null).length, generations: [...new Set(delivered.filter((m) => m.deliveredGeneration != null).map((m) => m.deliveredGeneration))] });

  // 6. A stalled handover: the service manager stops the old daemon and never starts the successor. A send issued
  //    2 s in holds and fails typed when the marker turns 60 s old; a send issued 61 s in fails typed at once.
  configureService({ startDelayMs: 0, stall: true });
  const oldA = readLiveEndpointRecord(dataDir);
  const stallActivate = await rpc("runtime.activate", { sha: SHA_B });
  expect("stall.activate.answer", stallActivate.ok && stallActivate.result.sha === SHA_B, { stallActivate });
  client.close(); client = null;
  await pidGone(oldA.pid, 60000);
  const stallMarker = marker();
  expect("stall.marker", stallMarker?.toSha === SHA_B && stallMarker.fromPid === oldA.pid && linkOf("current") === SHA_B && serviceMainPid() === null, { stallMarker, current: linkOf("current"), mainPid: serviceMainPid() });
  await sleep(2000);
  const early = cliSend(beeId, "d5-stall-early", { label: "stall-early" });
  const earlyLibrary = librarySend(beeId, "d5-stall-early-library");
  const waitUntil = stallMarker.at + 61000;
  while (Date.now() < waitUntil) await sleep(200);
  const late = await cliSend(beeId, "d5-stall-late", { label: "stall-late" });
  const earlyResult = await early;
  const earlyLibraryResult = await earlyLibrary;
  record({ step: "stall.sends", late, early: earlyResult, earlyLibrary: earlyLibraryResult, markerAgeAtLateMs: late.startedAt - stallMarker.at });
  expect("stall.late_send_fails_typed_at_once", !late.ok && late.error === "hived_handover_stalled" && late.ms < 3000, { late });
  expect("stall.early_send_holds_then_fails_typed", !earlyResult.ok && earlyResult.error === "hived_handover_stalled" && earlyResult.endedAt - stallMarker.at >= 60000 && earlyResult.endedAt - stallMarker.at < 63000 && earlyResult.ms >= 55000, { early: earlyResult });
  expect("stall.library_holds_then_fails_typed", !earlyLibraryResult.ok && earlyLibraryResult.stalled === true && earlyLibraryResult.error === "hived_handover_stalled" && earlyLibraryResult.endedAt - stallMarker.at >= 60000, { earlyLibrary: earlyLibraryResult });
  expect("stall.marker_still_present", marker()?.at === stallMarker.at && !pidAlive(oldA.pid), { marker: marker() });

  // 7. Recovery: the service manager comes back; B boots through the launcher, removes the marker; sends land again.
  configureService({ startDelayMs: 0, stall: false });
  supervise();
  const recovered = await connect(oldA.pid, 120000);
  const statusB = (await rpc("runtime.status")).result;
  const afterStall = await cliSend(beeId, "d5-after-stall", { label: "recovered" });
  const mailboxAfter = (await rpc("mailbox", { beeId })).result.messages;
  expect("recovery.B_serves", statusB.running.sourceRevision === SHA_B && statusB.current === SHA_B && statusB.previous === SHA_A && statusB.marker === null && statusB.handover?.result?.adopted === 1 && afterStall.ok && mailboxAfter.filter((m) => m.body === "d5-after-stall").length === 1 && mailboxAfter.filter((m) => m.body.startsWith("d5-stall-")).length === 0, { running: statusB.running, current: statusB.current, previous: statusB.previous, marker: statusB.marker, handover: statusB.handover?.result, afterStall, stalledLanded: mailboxAfter.filter((m) => m.body.startsWith("d5-stall-")).length, recoveredPid: recovered.pid });
  const bee = await view(beeId);
  record({ step: "bee.after", state: bee.view.runtimeState, generation: bee.runtime.generation, pid: bee.runtime.pid });
  record({ step: "systemctl.calls", calls: systemctlCalls() });
  record({ step: "lab.done", pass: true });
} catch (error) {
  exitCode = 1;
  record({ step: "lab.error", message: error instanceof Error ? error.message : String(error), supervisorTail: (() => { try { return readFileSync(supervisorLog, "utf8").slice(-2000); } catch { return null; } })(), daemonLogTail: daemonLog().slice(-30) });
} finally {
  client?.close();
  await Promise.allSettled(sendsInFlight);
  const mainPid = serviceMainPid();
  const live = readLiveEndpointRecord(dataDir);
  for (const pid of new Set([mainPid, live?.pid].filter(Boolean))) { try { process.kill(pid, "SIGTERM"); } catch {} }
  if (mainPid) await pidGone(mainPid, 30000);
  const pids = (await execFileAsync("pgrep", ["-f", root]).catch(() => ({ stdout: "" }))).stdout.split("\n").filter(Boolean).map(Number).filter((p) => p !== process.pid);
  for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  record({ step: "lab.cleanup", stoppedMainPid: mainPid, killedLeftovers: pids.length, keepRoot: process.env.KEEP_ROOT === "1" });
  try { cpSync(join(dataDir, "hived.log"), join(dirname(OUT), "hived.log")); cpSync(supervisorLog, join(dirname(OUT), "supervisor.log")); cpSync(systemctlLog, join(dirname(OUT), "systemctl.log")); cpSync(unitPath, join(dirname(OUT), "adopted-unit.service")); } catch {}
  if (process.env.KEEP_ROOT !== "1") rmSync(root, { recursive: true, force: true });
}
process.exit(exitCode);
