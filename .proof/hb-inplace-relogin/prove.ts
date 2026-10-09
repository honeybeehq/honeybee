/**
 * Proof for hb-inplace-relogin (also covers hb-early-refresh).
 *
 * Runs the daemon and CLI from this checkout's BUILD (dist/cli.js v2) in a
 * throwaway data dir with its own socket, store, vault, account homes and
 * HOME, the Keychain bridge off, and the Claude OAuth token, usage and
 * profile endpoints pointed at one local stub. The harness is the repo's fake
 * Claude CLI, which reads `$CLAUDE_CONFIG_DIR/.credentials.json` before every
 * provider call and ends the turn "Not logged in" once that copy is expired.
 * Nothing under ~/.hive or the real Keychain is read or written. Every token
 * is a stub string and none is printed.
 *
 *   npm run build && node .proof/hb-inplace-relogin/prove.ts
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { RpcClient } from "../../v2/cli/src/client.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(repo, "dist", "cli.js");
const FAKE_CLAUDE = join(repo, "v2", "driver-hsr", "test-agent", "fake-claude.mjs");
const root = mkdtempSync(join(tmpdir(), "hb-inplace-relogin-proof-"));
const data = join(root, "data");
const homes = join(root, "homes");
const vault = join(root, "vault");
const daemonLog = join(data, "hived.log");
mkdirSync(data, { recursive: true });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AHEAD_MS = 3 * HOUR;
const MIN_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// stub provider (its own process: the proof blocks on CLI calls)
// ---------------------------------------------------------------------------

const stub = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "stub.ts")], { stdio: ["ignore", "pipe", "inherit"] });
const stubPort = await new Promise<number>((done) => stub.stdout!.once("data", (chunk) => done(Number(String(chunk).trim()))));
const stubUrl = `http://127.0.0.1:${stubPort}`;
async function control(change: { lifetime?: Record<string, number>; refuse?: string } = {}): Promise<Record<string, number>> {
  const response = await fetch(`${stubUrl}/control`, { method: "POST", body: JSON.stringify(change) });
  return ((await response.json()) as { presented: Record<string, number> }).presented;
}
const presentations = async (label: string) => (await control())[label] ?? 0;
const labelOfToken = (token: string) => token.split(".")[1]!;

const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  HIVE_V2_DATA_DIR: data,
  HIVE_NO_KEYCHAIN: "1",
  HIVE_GATEWAYS_DISABLE: "1",
  HIVE_TEST_REAP_RUNTIMES_ON_SHUTDOWN: "1",
  HIVE_CLAUDE_OAUTH_TOKEN_URL: `${stubUrl}/v1/oauth/token`,
  HIVE_CLAUDE_USAGE_URL: `${stubUrl}/api/oauth/usage`,
  HIVE_CLAUDE_PROFILE_URL: `${stubUrl}/api/oauth/profile`,
  NO_COLOR: "1",
};

writeFileSync(join(data, "config.json"), JSON.stringify({
  tickMs: 50,
  idleWindowMs: 0,
  accounts: {
    vaultDir: vault, homesDir: homes, limitsRefreshMs: 2000, limitsFetchTimeoutMs: 2500, centralRefreshRetryBaseMs: 2000,
    centralRefreshAheadMs: AHEAD_MS, centralRefreshMinIntervalMs: MIN_INTERVAL_MS,
  },
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const say = (line = "") => console.log(line);
const section = (title: string) => say(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const hm = (ms: number) => `${Math.floor(ms / HOUR)}h${String(Math.floor((ms % HOUR) / 60_000)).padStart(2, "0")}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;

function hive(...args: string[]): any {
  const out = execFileSync(process.execPath, [CLI, "v2", ...args, "--data-dir", data, "--json"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return out.trim() ? JSON.parse(out) : null;
}
function hiveText(...args: string[]): string {
  try {
    return execFileSync(process.execPath, [CLI, "v2", ...args, "--data-dir", data], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; status?: number };
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trimEnd() + `\n(exit ${failed.status})`;
  }
}
const show = (...args: string[]) => say(`$ hive ${args.join(" ")}\n${hiveText(...args)}\n`);
async function rpc<T>(verb: string, params: Record<string, unknown>): Promise<T> {
  const client = await RpcClient.connect(join(data, "hived.sock"));
  try { return await client.request<T>(verb as never, params); } finally { client.close(); }
}

let daemon: ChildProcess | null = null;
async function startDaemon(): Promise<void> {
  const log = openSync(join(root, "daemon.out"), "a");
  daemon = spawn(process.execPath, [CLI, "v2", "daemon", "run", "--data-dir", data], { env, stdio: ["ignore", log, log] });
  await until(() => { try { hive("deploy-info"); return true; } catch { return false; } }, "daemon answers");
  say(`daemon up (pid ${daemon.pid})`);
}
async function killDaemon(): Promise<void> {
  const proc = daemon!;
  const gone = new Promise((done) => proc.once("exit", done));
  proc.kill("SIGKILL");
  await gone;
  daemon = null;
  say(`daemon pid ${proc.pid} killed with SIGKILL`);
}
async function until<T>(check: () => T | Promise<T>, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(50);
  }
}

type Authority = { phase: string; generation: number; expiresAt: number; refreshTokenExpiresAt: number | null; failure: unknown };
const authority = (id: string): Authority => hive("account", "credentials", "status", id);
const account = (id: string) => hive("account", "get", id).account as { id: string; status: string; statusReason: string | null; lastLoginAt: number | null; refreshTokenExpiresAt: number | null; loginDueAt: number | null };
const view = (bee: string) => hive("view", bee).view;
const mailbox = (bee: string) => hive("mailbox", bee).messages as Array<{ id: number; sender: string; body: string; deliveredAt: number | null; deliveredGeneration: number | null }>;
const interruptions = (bee: string) => (hive("account", "interruptions").interruptions as Array<Record<string, any>>).filter((row) => row.beeId === bee);
const live = (bee: string) => interruptions(bee).find((row) => ["open", "restored", "resumed"].includes(row.state));
function runtimeRow(bee: string): { generation: number; state: string; pid: number | null } {
  const runtime = hive("view", bee).runtime as { generation: number; state: string; pid: number | null };
  return { generation: runtime.generation, state: runtime.state, pid: runtime.pid };
}
const authorityFile = (id: string) => join(vault, ".credential-authorities", `${encodeURIComponent(id)}.json`);
const previousFile = (id: string) => join(vault, ".credential-authorities", `${encodeURIComponent(id)}.previous.json`);
const fileGeneration = (path: string) => (JSON.parse(readFileSync(path, "utf8")) as { generation: number }).generation;
const accessLabel = (path: string) => { const oauth = JSON.parse(readFileSync(path, "utf8")).claudeAiOauth; return `${labelOfToken(oauth.accessToken)}.${oauth.accessToken.split(".")[2]}, refreshToken ${oauth.refreshToken === "" ? "blank" : "PRESENT"}`; };
const logLines = (pattern: RegExp) => readFileSync(daemonLog, "utf8").split("\n").filter((line) => pattern.test(line));
function showLog(pattern: RegExp, since = 0): number {
  const lines = logLines(pattern);
  for (const line of lines.slice(since)) say(`  daemon| ${line}`);
  return lines.length;
}

function writeNative(id: string, label: string, expiresInMs: number): void {
  for (const dir of [join(homes, id), join(vault, "claude", id)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: `stub-access.${label}.0`, refreshToken: `stub-refresh.${label}.0`, expiresAt: Date.now() + expiresInMs, scopes: ["user:inference"], subscriptionType: "max",
    } }), { mode: 0o600 });
  }
}
async function enroll(label: string, lifetimeSeconds?: number): Promise<string> {
  const id = `claude-${label}`;
  if (lifetimeSeconds !== undefined) await control({ lifetime: { [label]: lifetimeSeconds } });
  writeNative(id, label, HOUR);
  hive("account", "add", "claude", label, "--import-existing");
  hive("account", "credentials", "enable", id);
  assert.equal(authority(id).phase, "ready");
  await until(() => account(id).status === "ok", `${id} ok`);
  return id;
}
async function intoLoginRequired(id: string, label: string): Promise<void> {
  await control({ refuse: label });
  await until(() => authority(id).phase === "login_required", `${id} login_required`, 60_000);
}
async function login(id: string, code: string, opts: { replaceAccount?: boolean } = {}): Promise<{ flowId: string; submit: Promise<any> }> {
  const started = hive("login", id, "--no-wait", ...(opts.replaceAccount ? ["--replace-account"] : []));
  assert.equal(started.flow.phase, "waiting_input");
  return { flowId: started.flow.id, submit: rpc("account.login.submit", { flowId: started.flow.id, values: { code } }) };
}

async function spawnWarm(name: string, accountId: string): Promise<string> {
  const bee = hive("spawn", name, "--agent", "claude", "--account", accountId, "--cwd", root, "--tag", "autoswap=false").beeId as string;
  hive("send", bee, `hello ${name}`);
  await until(() => view(bee).runtimeState === "idle" && mailbox(bee).every((m) => m.deliveredAt), `${name} finished its first turn`);
  return bee;
}
function showBee(name: string, bee: string): void {
  const v = view(bee);
  const rt = runtimeRow(bee);
  say(`  ${name}: runtime=${v.runtimeState} gen=${v.generation} pid=${rt.pid} flags=[${v.flags.join(",")}]`);
  for (const m of mailbox(bee)) say(`    mail #${m.id} from ${m.sender} ${m.deliveredAt ? `delivered(gen ${m.deliveredGeneration})` : "PENDING"}: ${JSON.stringify(m.body.slice(0, 60))}`);
  for (const row of interruptions(bee)) {
    say(`    interruption #${row.id} state=${row.state} progress=${row.turnProgress} restoredBy=${row.restoredBy ?? "-"} continuation=${row.continuationKind ?? "-"}[${row.continuationMessageIds}]`);
  }
}
function refreshTokensOutsideAuthority(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path.startsWith(join(vault, ".credential-authorities"))) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (readFileSync(path, "utf8").includes("stub-refresh.")) hits.push(path.slice(root.length + 1));
    }
  };
  walk(homes);
  walk(vault);
  return hits;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

try {
  section("0. Isolated run");
  say(`data dir ${data} (HOME=${root}); CLI ${CLI}; stub provider ${stubUrl}`);
  await startDaemon();
  const info = hive("deploy-info");
  say(`daemon build ${info.daemonVersion}; capabilities: ${["account.central_relogin.v1", "account.lease.min_ttl.v1", "account.login_due.v1"].map((c) => `${c}=${info.capabilities.includes(c)}`).join(" ")}`);

  section("1. A centrally managed account whose login dies while two bees are mid-work");
  const kontrol = await enroll("kontrol", 40);
  say(`${kontrol} enrolled; the stub issues 40-second access tokens for this chain so its copies die quickly`);
  const alpha = await spawnWarm("alpha", kontrol);
  const beta = await spawnWarm("beta", kontrol);
  await intoLoginRequired(kontrol, "kontrol");
  say("the stub now refuses the chain's refresh token (400 invalid_grant), as Anthropic does after ~4 weeks");
  show("account", "credentials", "status", kontrol);
  const betaJob = hive("send", beta, "refactor the parser @steps:40 @slow:1000").messageId as number;
  await until(() => mailbox(beta).find((m) => m.id === betaJob)?.deliveredAt, "beta's job delivered");
  await until(() => live(beta), "beta cut off mid-turn when its access-only copy expires", 60_000);
  const alphaJob = hive("send", alpha, "write the release notes").messageId as number;
  await until(() => live(alpha)?.messageIds.includes(alphaJob) && view(alpha).flags.includes("auth_needed"), "alpha cut off");
  await until(() => view(beta).flags.includes("auth_needed") && view(beta).runtimeState === "idle", "beta idle and flagged");
  say(`account ${kontrol}: status=${account(kontrol).status}`);
  showBee("alpha", alpha);
  showBee("beta", beta);
  const before = { alpha: runtimeRow(alpha), beta: runtimeRow(beta), authority: authority(kontrol) };
  assert.equal(before.authority.phase, "login_required");
  assert.notEqual(before.alpha.state, "stopped");
  assert.notEqual(before.beta.state, "stopped");

  section("2. The old recovery path needs the sessions stopped");
  show("account", "credentials", "disable", kontrol);

  section("3. `hive login` in place: no disable, no enable, nothing stopped");
  const relogin = await login(kontrol, "code-kontrol2");
  say(`hive login ${kontrol} --no-wait -> flow ${relogin.flowId} waiting for the pasted code; account.login.submit with a code for the SAME Anthropic account`);
  const submitted = await relogin.submit;
  say(`flow phase=${submitted.flow.phase}`);
  assert.equal(submitted.flow.phase, "succeeded");
  const after = authority(kontrol);
  say(`authority: phase ${before.authority.phase} -> ${after.phase}, generation ${before.authority.generation} -> ${after.generation}, failure=${JSON.stringify(after.failure)}`);
  assert.equal(after.phase, "ready");
  assert.equal(after.generation, before.authority.generation + 1);
  const row = account(kontrol);
  say(`account: status=${row.status} lastLoginAt=${row.lastLoginAt ? iso(row.lastLoginAt) : "-"} statusReason=${JSON.stringify(row.statusReason)}`);
  assert.equal(row.status, "ok");
  say(`home copy:  ${accessLabel(join(homes, kontrol, ".credentials.json"))}`);
  say(`vault copy: ${accessLabel(join(vault, "claude", kontrol, ".credentials.json"))}`);
  say(`authority file generation ${fileGeneration(authorityFile(kontrol))}; previous-generation file kept: ${existsSync(previousFile(kontrol))} (generation ${fileGeneration(previousFile(kontrol))})`);
  await until(() => interruptions(alpha).some((r) => r.state === "completed") && interruptions(beta).some((r) => r.state === "completed"), "alpha and beta resumed and finished", 60_000);
  await sleep(1000);
  showBee("alpha", alpha);
  showBee("beta", beta);
  const alphaAfter = mailbox(alpha).filter((m) => m.id > alphaJob);
  const betaAfter = mailbox(beta).filter((m) => m.id > betaJob);
  assert.deepEqual(alphaAfter.map((m) => m.body), ["write the release notes"], "alpha gets its cut-off message once");
  assert.deepEqual(betaAfter.map((m) => m.sender), ["hive:auth-resume"], "beta gets one continue message");
  assert.equal(runtimeRow(alpha).pid, before.alpha.pid);
  assert.equal(runtimeRow(beta).pid, before.beta.pid);
  assert.equal(runtimeRow(alpha).generation, before.alpha.generation);
  assert.equal(runtimeRow(beta).generation, before.beta.generation);
  const ownership = logLines(new RegExp(`account\\.credentials\\.phase account=${kontrol} .*to=(disabling|disabled|enrolling)`));
  say(`phase changes into disabling/disabled/enrolling after enrollment: ${ownership.filter((line) => !line.includes("from=-")).length}; stop commands issued: ${logLines(/stopped_by_user|bee\.stop/).length}`);
  showLog(new RegExp(`account=${kontrol}.*(relogin|login\\.captured|auth_ok)|auth\\.(restored|resume)`));
  say("PASS: same runtime processes (pid + generation) before and after; each bee resumed exactly once; no refresh token in any copy");

  section("4. A login as a DIFFERENT Anthropic account is refused; nothing changes");
  const homeBefore = readFileSync(join(homes, kontrol, ".credentials.json"), "utf8");
  const wrong = await login(kontrol, "code-intruder");
  const refused = await wrong.submit;
  say(`flow phase=${refused.flow.phase} error=${JSON.stringify(refused.flow.error)}`);
  assert.equal(refused.flow.error.code, "different_account");
  assert.equal(authority(kontrol).generation, after.generation);
  assert.equal(readFileSync(join(homes, kontrol, ".credentials.json"), "utf8"), homeBefore);
  say(`authority generation still ${authority(kontrol).generation}; home copy byte-identical: true`);

  section("5. account.lease {minTtlMs}: below the requested margin the daemon refreshes centrally first");
  const margin = await enroll("margin", 4 * 3600);
  const plain = await rpc<{ expiresAt: number }>("account.lease", { account: margin });
  say(`lease without minTtlMs        -> expires ${iso(plain.expiresAt * 1000)} (${hm(plain.expiresAt * 1000 - Date.now())} left)`);
  await sleep(MIN_INTERVAL_MS + 500);
  const presentedBefore = await presentations("margin");
  const widened = await rpc<{ expiresAt: number }>("account.lease", { account: margin, minTtlMs: 5 * HOUR });
  say(`lease with minTtlMs = 5h       -> expires ${iso(widened.expiresAt * 1000)} (provider refreshes: +${(await presentations("margin")) - presentedBefore})`);
  const repeat = await rpc<{ expiresAt: number }>("account.lease", { account: margin, minTtlMs: 5 * HOUR });
  say(`same request again at once     -> expires ${iso(repeat.expiresAt * 1000)} (provider refreshes: +${(await presentations("margin")) - presentedBefore}; a just-issued token is not refreshed again)`);
  assert.ok(widened.expiresAt > plain.expiresAt);
  assert.equal(repeat.expiresAt, widened.expiresAt);
  showLog(new RegExp(`account\\.credentials\\.refresh account=${margin}`));

  section("6. The timer refreshes a central credential hours before expiry");
  const early = await enroll("early", 3 * 3600 + 8);
  const issued = authority(early).expiresAt;
  say(`${early} holds a token expiring ${iso(issued)} (${hm(issued - Date.now())} left); accounts.centralRefreshAheadMs = 3h`);
  await control({ lifetime: { early: 8 * 3600 } });
  const earlyLog = new RegExp(`account=${early}.*(early_refresh|credentials\\.refresh)`);
  const marker = logLines(earlyLog).length;
  await until(() => authority(early).expiresAt > issued, "the early refresh", 30_000);
  const refreshedAt = Date.now();
  say(`refreshed with ${hm(issued - refreshedAt)} of the old token left; new expiry ${iso(authority(early).expiresAt)}`);
  showLog(earlyLog, marker);
  assert.ok(issued - refreshedAt > 2 * HOUR);

  section("7. Login-due hint 3 days before the login ends");
  const due = await enroll("due");
  const dueRow = account(due);
  say(`${due}: refreshTokenExpiresAt=${iso(dueRow.refreshTokenExpiresAt!)} loginDueAt=${iso(dueRow.loginDueAt!)} (due now: ${dueRow.loginDueAt! <= Date.now()})`);
  say(`${kontrol}: refreshTokenExpiresAt=${iso(account(kontrol).refreshTokenExpiresAt!)} loginDueAt=${iso(account(kontrol).loginDueAt!)} (due now: ${account(kontrol).loginDueAt! <= Date.now()})`);
  assert.ok(dueRow.loginDueAt! <= Date.now());
  show("account", "list");

  section("8. The daemon is killed in the middle of an in-place login");
  const crash = await enroll("crash", 40);
  await intoLoginRequired(crash, "crash");
  const crashBefore = authority(crash);
  const lock = join(homes, crash, ".storage-write.lock");
  mkdirSync(lock);
  say(`a Claude process holds Claude Code's credential storage lock in ${crash}'s home, so publication waits for it`);
  const crashing = await login(crash, "code-crash2");
  crashing.submit.catch(() => undefined);
  await until(() => logLines(new RegExp(`account\\.credentials\\.relogin account=${crash}`)).length > 0, "the new chain saved");
  await sleep(300);
  await killDaemon();
  const db = new DatabaseSync(join(data, "core.sqlite3"), { readOnly: true });
  const stored = db.prepare("SELECT phase, generation FROM account_credential_authorities WHERE account = ?").get(crash) as { phase: string; generation: number };
  db.close();
  say(`while down: store row ${JSON.stringify(stored)}; authority file generation ${fileGeneration(authorityFile(crash))}; previous file generation ${fileGeneration(previousFile(crash))}; home copy ${accessLabel(join(homes, crash, ".credentials.json"))}`);
  rmSync(lock, { recursive: true });
  await startDaemon();
  const settledIn = Date.now();
  await until(() => authority(crash).phase === "ready", "the saved login settles after restart", 60_000);
  say(`after restart: phase ${authority(crash).phase}, generation ${crashBefore.generation} -> ${authority(crash).generation} (${Date.now() - settledIn} ms); account status=${(await until(() => account(crash).status === "ok" && account(crash), `${crash} ok`)).status}`);
  say(`home copy ${accessLabel(join(homes, crash, ".credentials.json"))}; provider presentations of the new chain: ${await presentations("crash2")}`);
  assert.equal(authority(crash).generation, crashBefore.generation + 1);
  say(`the interrupted flow: ${hive("account", "login-status", crash).flow.phase}`);

  section("9. Secrets");
  const hits = refreshTokensOutsideAuthority();
  const log = readFileSync(daemonLog, "utf8");
  say(`files under homes/ and vault/ (outside the private authority dir) holding a refresh token: ${hits.length === 0 ? "none" : hits.join(", ")}`);
  say(`hived.log occurrences of a stub refresh token: ${log.split("stub-refresh.").length - 1}; of a stub access token: ${log.split("stub-access.").length - 1}`);
  assert.deepEqual(hits, []);
  say("\nALL CHECKS PASSED");
} finally {
  if (daemon && daemon.exitCode === null) {
    const proc = daemon;
    const gone = new Promise((done) => proc.once("exit", done));
    proc.kill("SIGTERM");
    await Promise.race([gone, sleep(8000)]);
  }
  for (const pid of runnerPids()) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  stub.kill();
  if (process.env.KEEP_DATA_DIR !== "1") rmSync(root, { recursive: true, force: true });
}

function runnerPids(): number[] {
  try {
    return execFileSync("pgrep", ["-f", root], { encoding: "utf8" }).split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}
