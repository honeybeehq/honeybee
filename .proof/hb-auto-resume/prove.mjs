#!/usr/bin/env node
/**
 * Proof for hb-auto-resume. Runs the daemon and CLI built in this checkout
 * (dist/cli.js) against a throwaway data dir: its own store, socket, vault
 * and account homes, HOME pointed at the same temp dir, no Keychain, and the
 * Claude token and usage endpoints pointed at a local stub that is never
 * reachable from a real account. The harness is the repo's fake Claude CLI,
 * which reads `$CLAUDE_CONFIG_DIR/.credentials.json` before every provider
 * call and ends the turn with "Not logged in · Please run /login" when that
 * credential is expired. Only fixture tokens exist; none is printed.
 *
 *   npm run build && node .proof/hb-auto-resume/prove.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(repo, "dist", "cli.js");
const FAKE_CLAUDE = join(repo, "v2", "driver-hsr", "test-agent", "fake-claude.mjs");
const root = mkdtempSync(join(tmpdir(), "hb-auto-resume-proof-"));
const data = join(root, "data");
const daemonLog = join(data, "hived.log");
const daemonOutput = join(root, "daemon.out");
mkdirSync(data, { recursive: true });

const stub = createServer((_request, response) => {
  response.statusCode = 503;
  response.end(JSON.stringify({ error: "proof stub: no provider here" }));
});
await new Promise((done) => stub.listen(0, "127.0.0.1", done));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const env = {
  PATH: process.env.PATH,
  HOME: root,
  HIVE_V2_DATA_DIR: data,
  HIVE_NO_KEYCHAIN: "1",
  HIVE_GATEWAYS_DISABLE: "1",
  HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1",
  HIVE_CLAUDE_OAUTH_TOKEN_URL: `${stubUrl}/v1/oauth/token`,
  HIVE_CLAUDE_USAGE_URL: `${stubUrl}/api/oauth/usage`,
};

writeFileSync(join(data, "config.json"), JSON.stringify({
  tickMs: 50,
  idleWindowMs: 0,
  accounts: { vaultDir: join(root, "vault"), homesDir: join(root, "homes"), limitsRefreshMs: 0 },
  agents: {
    claude: {
      command: process.execPath,
      args: [FAKE_CLAUDE, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
      adapter: "claude",
      env: { FAKE_CLAUDE_REQUIRE_CREDENTIAL: "1" },
    },
  },
  naming: { auto: false },
}, null, 2));

const say = (line = "") => console.log(line);
const step = (title) => say(`\n=== ${title}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function hive(...args) {
  const out = execFileSync(process.execPath, [CLI, "v2", ...args, "--data-dir", data, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim() ? JSON.parse(out) : null;
}

let daemon = null;
async function startDaemon() {
  const log = openSync(daemonOutput, "a");
  daemon = spawn(process.execPath, [CLI, "v2", "daemon", "run", "--data-dir", data], { env, stdio: ["ignore", log, log] });
  await until(() => { try { hive("deploy-info"); return true; } catch { return false; } }, "daemon answers");
  say(`daemon up (pid ${daemon.pid}) on ${join(data, "hived.sock")}`);
}
async function killDaemon() {
  const pid = daemon.pid;
  const gone = new Promise((done) => daemon.once("exit", done));
  daemon.kill("SIGKILL");
  await gone;
  say(`daemon pid ${pid} killed with SIGKILL`);
}

async function until(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(50);
  }
}

function writeCredential(account, name, expiresAt, leased = false) {
  for (const dir of [join(root, "homes", account), ...(leased ? [] : [join(root, "vault", "claude", account)])]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: `PROOF_FIXTURE_ACCESS_${name}`, refreshToken: "", expiresAt },
    }));
  }
}
const inEightHours = () => Date.now() + 8 * 3_600_000;

const view = (bee) => hive("view", bee).view;
const mailbox = (bee) => hive("mailbox", bee).messages;
const interruptions = (bee) => hive("account", "interruptions").interruptions.filter((row) => row.beeId === bee);
const live = (bee) => interruptions(bee).find((row) => ["open", "restored", "resumed"].includes(row.state));

function showBee(name, bee) {
  const v = view(bee);
  say(`  ${name}: runtime=${v.runtimeState} gen=${v.generation} flags=[${v.flags.join(",")}]`);
  for (const m of mailbox(bee)) {
    say(`    mail #${m.id} from ${m.sender} ${m.deliveredAt ? `delivered(gen ${m.deliveredGeneration})` : "PENDING"}: ${JSON.stringify(m.body.slice(0, 70))}`);
  }
  for (const row of interruptions(bee)) {
    say(`    interruption #${row.id} state=${row.state} account=${row.account} gen=${row.generation} cutOffMail=[${row.messageIds}] progress=${row.turnProgress}`
      + ` restoredBy=${row.restoredBy ?? "-"} continuation=${row.continuationKind ?? "-"}[${row.continuationMessageIds}] ${row.settleReason ?? ""}`);
  }
}

async function spawnWarm(name, account) {
  const bee = hive("spawn", name, "--agent", "claude", "--account", account, "--cwd", root, "--tag", "autoswap=false").beeId;
  hive("send", bee, `hello ${name}`);
  await until(() => view(bee).runtimeState === "idle" && mailbox(bee).every((m) => m.deliveredAt), `${name} finished its first turn`);
  return bee;
}

async function cutOff(bee, body) {
  const id = hive("send", bee, body).messageId;
  await until(() => live(bee)?.messageIds.includes(id) && view(bee).flags.includes("auth_needed") && view(bee).runtimeState === "idle", `${body} cut off`);
  return id;
}

const auditLines = () => readFileSync(daemonLog, "utf8").split("\n").filter((line) => /auth\.(interrupted|restored|resume)|flag\.(set|clear) .*auth_needed|account\.auth_/.test(line));
let shown = 0;
function showDaemonLog() {
  const lines = auditLines();
  for (const line of lines.slice(shown)) say(`  daemon| ${line}`);
  shown = lines.length;
}

try {
  step("0. isolated run");
  say(`data dir ${data} (HOME=${root}); built CLI ${CLI}`);
  await startDaemon();
  const info = hive("deploy-info");
  say(`daemon build ${info.daemonVersion}, store ${info.storePath}; capability account.auth_resume.v1: ${info.capabilities.includes("account.auth_resume.v1")}`);

  step("1. LOGIN/CAPTURE PATH — three bees on one account, credential dies mid-work");
  writeCredential("claude-work", "work_1", inEightHours());
  hive("account", "add", "claude", "work", "--import-existing");
  const alpha = await spawnWarm("alpha", "claude-work");
  const beta = await spawnWarm("beta", "claude-work");
  const gamma = await spawnWarm("gamma", "claude-work");
  const betaJob = hive("send", beta, "refactor the parser @steps:4 @slow:500").messageId;
  await until(() => mailbox(beta).find((m) => m.id === betaJob)?.deliveredAt, "beta's job delivered");
  await sleep(750);
  say("beta is one step into a four-step turn; the credential now expires on disk");
  writeCredential("claude-work", "work_1", 1);
  await until(() => live(beta), "beta cut off mid-turn");
  const alphaJob = await cutOff(alpha, "write the release notes");
  const gammaJob = await cutOff(gamma, "tidy the changelog");
  await until(() => hive("account", "get", "claude-work").account.status === "auth_needed", "account auth_needed");
  say(`account claude-work status=${hive("account", "get", "claude-work").account.status}`);
  showBee("alpha", alpha); showBee("beta", beta); showBee("gamma", gamma);
  assert.equal(live(alpha).turnProgress, "none");
  assert.equal(live(beta).turnProgress, "some");

  step("1b. the user stops gamma while it is cut off");
  hive("stop", gamma);
  await until(() => view(gamma).runtimeState === "stopped", "gamma stopped");
  await sleep(500);
  const before = { alpha: mailbox(alpha).length, beta: mailbox(beta).length, gamma: mailbox(gamma).length };
  say(`mail counts while the credential is still broken: ${JSON.stringify(before)} (no continuation yet)`);
  showDaemonLog();

  step("1c. a human logs in again: new credential in the account home, then `hive account capture`");
  writeCredential("claude-work", "work_2", inEightHours());
  say(`capture → ${JSON.stringify((({ captured, source }) => ({ captured, source }))(hive("account", "capture", "claude-work")))}`);
  await until(() => interruptions(alpha).some((row) => row.state === "completed") && interruptions(beta).some((row) => row.state === "completed"), "alpha and beta finished");
  say(`account claude-work status=${hive("account", "get", "claude-work").account.status}; NO message was sent by a human after the cut`);
  showBee("alpha", alpha); showBee("beta", beta); showBee("gamma", gamma);
  showDaemonLog();
  assert.deepEqual(mailbox(alpha).filter((m) => m.id > alphaJob).map((m) => m.body), ["write the release notes"]);
  assert.deepEqual(mailbox(beta).filter((m) => m.id > betaJob).map((m) => m.sender), ["hive:auth-resume"]);
  assert.deepEqual(mailbox(gamma).filter((m) => m.id > gammaJob), []);
  assert.deepEqual([view(alpha).flags, view(beta).flags, view(gamma).flags], [[], [], []]);
  assert.equal(view(gamma).runtimeState, "stopped");
  assert.deepEqual([view(alpha).generation, view(beta).generation], [1, 1]);
  say("PASS: alpha got its original message again (nothing of it had run), beta got one continue message (it was mid-turn),");
  say("      both finished on the same runtime generation, flags are clear, gamma — stopped by the user — stayed stopped with no continuation.");

  step("1d. capture again: no second continuation");
  hive("account", "capture", "claude-work");
  await sleep(600);
  assert.equal(mailbox(alpha).filter((m) => m.id > alphaJob).length, 1);
  assert.equal(mailbox(beta).filter((m) => m.id > betaJob).length, 1);
  say("PASS: still exactly one continuation each");

  step("2. SATELLITE PATH — leased credential installed outside the daemon, daemon killed during recovery");
  writeCredential("claude-sat", "sat_lease_1", inEightHours());
  hive("account", "add", "claude", "sat", "--import-existing");
  const delta = await spawnWarm("delta", "claude-sat");
  const epsilon = await spawnWarm("epsilon", "claude-sat");
  writeCredential("claude-sat", "sat_lease_1", 1);
  const deltaJob = await cutOff(delta, "summarise the incident");
  const epsilonJob = await cutOff(epsilon, "draft the follow-ups");
  showBee("delta", delta); showBee("epsilon", epsilon);
  const refusal = (() => {
    try {
      hive("account", "restored", "claude-sat");
      return null;
    } catch (err) {
      return String(err.stderr).trim().split("\n").pop();
    }
  })();
  assert.ok(refusal, "an expired credential must be refused");
  say(`\`hive account restored\` with the expired lease still in the account home → refused: ${refusal}`);
  assert.deepEqual([mailbox(delta).filter((m) => m.id > deltaJob), mailbox(epsilon).filter((m) => m.id > epsilonJob)], [[], []]);

  step("2b. Apiary installs a fresh lease in the account home and calls account.credentialsRestored; the daemon is killed right after");
  writeCredential("claude-sat", "sat_lease_2", inEightHours(), true);
  const restored = hive("account", "restored", "claude-sat", "--idempotency-key", "lease-2");
  say(`account.credentialsRestored → cleared=${restored.clearedBeeIds.length} resuming=${restored.resumingBeeIds.length} blocked=${restored.blockedBeeIds.length} status=${restored.account.status}`);
  await killDaemon();
  showDaemonLog();

  step("2c. a new daemon starts on the same store");
  await startDaemon();
  await until(() => interruptions(delta).some((row) => row.state === "completed") && interruptions(epsilon).some((row) => row.state === "completed"), "delta and epsilon finished after the restart");
  showBee("delta", delta); showBee("epsilon", epsilon);
  showDaemonLog();
  assert.deepEqual(mailbox(delta).filter((m) => m.id > deltaJob).map((m) => m.body), ["summarise the incident"]);
  assert.deepEqual(mailbox(epsilon).filter((m) => m.id > epsilonJob).map((m) => m.body), ["draft the follow-ups"]);
  assert.deepEqual([view(delta).flags, view(epsilon).flags], [[], []]);
  say("PASS: one continuation each across the kill; both finished; flags clear");

  step("2d. Apiary retries the call (same key, then a fresh call for the same lease)");
  const replay = hive("account", "restored", "claude-sat", "--idempotency-key", "lease-2");
  const again = hive("account", "restored", "claude-sat");
  say(`replay deduped=${replay.deduped === true}; fresh call → cleared=${again.clearedBeeIds.length} resuming=${again.resumingBeeIds.length} sameRevision=${again.revision === restored.revision}`);
  await sleep(600);
  assert.equal(mailbox(delta).filter((m) => m.id > deltaJob).length, 1);
  assert.equal(mailbox(epsilon).filter((m) => m.id > epsilonJob).length, 1);
  say("PASS: no duplicate continuation");

  step("3. every interruption on this node");
  for (const line of execFileSync(process.execPath, [CLI, "v2", "account", "interruptions", "--data-dir", data], { env, encoding: "utf8" }).trim().split("\n")) say(`  ${line}`);
  say("\nALL CHECKS PASSED");
} finally {
  if (daemon && daemon.exitCode === null) {
    const gone = new Promise((done) => daemon.once("exit", done));
    daemon.kill("SIGTERM");
    await Promise.race([gone, sleep(8000)]);
  }
  for (const pid of runnerPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  assert.deepEqual(runnerPids(), [], "no process of this run is left behind");
  await new Promise((done) => stub.close(done));
  rmSync(root, { recursive: true, force: true });
}

function runnerPids() {
  try {
    return execFileSync("pgrep", ["-f", root], { encoding: "utf8" }).split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}
