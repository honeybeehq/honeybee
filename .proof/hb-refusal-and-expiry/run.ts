/**
 * Proof run for task hb-refusal-and-expiry.
 *
 * Runs the daemon and CLI from this checkout's BUILD (dist/cli.js v2) in a
 * throwaway data dir with its own socket, vault, account homes and HOME, the
 * Keychain bridge off, and the Claude OAuth token + usage endpoints pointed
 * at local stubs. Nothing under ~/.hive or the real Keychain is read or
 * written. Every token here is a stub string and none is printed.
 *
 *   npm run build && node .proof/hb-refusal-and-expiry/run.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../v2/cli/src/client.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = [join(root, "dist", "cli.js"), "v2"];
const dataDir = mkdtempSync(join(tmpdir(), "hb-refusal-proof-"));
const homesDir = join(dataDir, "homes");
const CYCLE_MS = 4000;
const REFRESH_TIMEOUT_MS = 2500;
const RETRY_BASE_MS = 2000;
const SHIP_FLOOR_S = 900;
const DUE_AFTER_S = 10;

type Mode = "ok" | "invalid_grant" | "overloaded" | "bad_gateway" | "hang";
const modes = new Map<string, Mode>();
const presented = new Map<string, number>();
const hanging = new Set<import("node:http").ServerResponse>();

function tokenHandler(server: Server): void {
  server.on("request", (request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const body = JSON.parse(raw) as { refresh_token: string };
      const [, label, serial] = body.refresh_token.split(".");
      presented.set(label!, (presented.get(label!) ?? 0) + 1);
      const mode = modes.get(label!) ?? "ok";
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (mode === "hang") { hanging.add(response); return; }
      if (mode === "invalid_grant") return send(400, { error: "invalid_grant", error_description: "Refresh token not found or invalid" });
      if (mode === "bad_gateway") return send(502, { type: "error", error: { type: "api_error", message: "upstream connect error" } });
      if (mode === "overloaded") return send(503, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
      const next = Number(serial) + 1;
      // The daemon refreshes a token with under 15 minutes left, so this one falls due 10 s after it is issued.
      send(200, { access_token: `stub-access.${label}.${next}`, refresh_token: `stub-refresh.${label}.${next}`, expires_in: SHIP_FLOOR_S + DUE_AFTER_S, refresh_token_expires_in: 28 * 24 * 3600 });
    });
  });
}

let tokenServer = createServer();
tokenHandler(tokenServer);
await new Promise<void>((done) => tokenServer.listen(0, "127.0.0.1", done));
const tokenPort = (tokenServer.address() as AddressInfo).port;
const usageServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ five_hour: { utilization: 7 }, seven_day: { utilization: 19 } }));
});
await new Promise<void>((done) => usageServer.listen(0, "127.0.0.1", done));
const usagePort = (usageServer.address() as AddressInfo).port;

async function stopTokenServer(): Promise<void> {
  tokenServer.closeAllConnections();
  await new Promise<void>((done) => tokenServer.close(() => done()));
}
async function startTokenServer(): Promise<void> {
  tokenServer = createServer();
  tokenHandler(tokenServer);
  await new Promise<void>((done) => tokenServer.listen(tokenPort, "127.0.0.1", done));
}

writeFileSync(join(dataDir, "config.json"), JSON.stringify({
  tickMs: 200,
  accounts: {
    vaultDir: join(dataDir, "vault"), homesDir,
    limitsRefreshMs: CYCLE_MS, limitsFetchTimeoutMs: REFRESH_TIMEOUT_MS, centralRefreshRetryBaseMs: RETRY_BASE_MS,
  },
}));
const env = {
  PATH: process.env.PATH ?? "",
  HOME: join(dataDir, "home"),
  HIVE_V2_DATA_DIR: dataDir,
  HIVE_NO_KEYCHAIN: "1",
  HIVE_GATEWAYS_DISABLE: "1",
  HIVE_CLAUDE_OAUTH_TOKEN_URL: `http://127.0.0.1:${tokenPort}/v1/oauth/token`,
  HIVE_CLAUDE_USAGE_URL: `http://127.0.0.1:${usagePort}/api/oauth/usage`,
  NO_COLOR: "1",
};
mkdirSync(env.HOME, { recursive: true });

let daemon: ChildProcess | null = null;
function startDaemon(): void {
  daemon = spawn(process.execPath, [...CLI, "daemon", "run", "--data-dir", dataDir], { env, stdio: "ignore" });
}
async function killDaemon(signal: NodeJS.Signals): Promise<void> {
  const proc = daemon!;
  proc.kill(signal);
  await until("daemon exit", () => proc.exitCode !== null || proc.signalCode !== null, 10_000);
  daemon = null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(what: string, check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<number> {
  const started = Date.now();
  for (;;) {
    if (await check()) return Date.now() - started;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(100);
  }
}

function hive(...args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [...CLI, ...args, "--data-dir", dataDir], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => done({ code: code ?? -1, out: out.trimEnd() }));
  });
}
async function show(...args: string[]): Promise<void> {
  const { out } = await hive(...args);
  console.log(`$ hive ${args.join(" ")}\n${out}\n`);
}
async function json<T>(...args: string[]): Promise<T> {
  const { out, code } = await hive(...args, "--json");
  if (out === "") return null as T;
  try { return JSON.parse(out) as T; } catch { throw new Error(`hive ${args.join(" ")} (exit ${code}): ${out}`); }
}
type Authority = { phase: string; generation: number; expiresAt: number; refreshTokenExpiresAt: number | null; failure: { outcome: string; attempts: number; description: string | null; at: number } | null };
const authority = (id: string) => json<Authority | null>("account", "credentials", "status", id);
type AccountList = { accounts: Array<{ id: string; status: string; statusReason: string | null; refreshTokenExpiresAt: number | null; credentialHealth: string }>; limits: Array<{ account: string; readable: boolean; unreadableReason: string | null }> };
const accountRow = async (id: string) => (await json<AccountList>("account", "list")).accounts.find((a) => a.id === id)!;
const limitsRow = async (id: string) => (await json<AccountList>("account", "list")).limits.find((l) => l.account === id);

async function lease(id: string): Promise<string> {
  const client = await RpcClient.connect(join(dataDir, "hived.sock"));
  try {
    const result = await client.request<{ files: unknown[]; expiresAt: number }>("account.lease", { account: id });
    return `account.lease ${id} -> granted (files=${result.files.length}, expires ${new Date(result.expiresAt * 1000).toISOString()})`;
  } catch (error) {
    const refusal = error as { code?: string; message: string };
    return `account.lease ${id} -> REFUSED code=${refusal.code} message=${JSON.stringify(refusal.message)}`;
  } finally {
    client.close();
  }
}

function logLines(id: string, since = 0): string {
  const lines = readFileSync(join(dataDir, "hived.log"), "utf8").split("\n")
    .filter((line) => line.includes(`account=${id}`) && /account\.(credentials\.|auth_needed|auth_ok)/.test(line));
  return lines.slice(since).join("\n");
}
const logCount = (id: string) => logLines(id).split("\n").filter(Boolean).length;

async function enroll(label: string): Promise<string> {
  const id = `claude-${label}`;
  await hive("account", "add", "claude", label);
  mkdirSync(join(homesDir, id), { recursive: true, mode: 0o700 });
  writeFileSync(join(homesDir, id, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: `stub-access.${label}.0`, refreshToken: `stub-refresh.${label}.0`, expiresAt: Date.now() + 3600_000,
    scopes: ["user:inference", "user:profile"], subscriptionType: "max",
  } }), { mode: 0o600 });
  const enabled = await hive("account", "credentials", "enable", id);
  if ((await authority(id))?.phase !== "ready") throw new Error(`enable ${id}: ${enabled.out}`);
  await until(`${id} ok`, async () => (await accountRow(id)).status === "ok", 20_000);
  return id;
}

function section(title: string): void {
  console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
}

try {
  startDaemon();
  await until("daemon socket", async () => { const listed = await hive("account", "list"); return listed.code === 0 && !listed.out.startsWith("stale"); }, 20_000);
  console.log(`isolated data dir: ${dataDir}`);
  console.log(`build under test: ${JSON.parse(readFileSync(join(root, "dist", "build-identity.json"), "utf8")).version} (dist/cli.js v2)`);
  console.log(`cycle (accounts.limitsRefreshMs) = ${CYCLE_MS} ms, refresh timeout = ${REFRESH_TIMEOUT_MS} ms, retry base = ${RETRY_BASE_MS} ms`);

  section("1. Refresh-token lifetime is recorded and shown");
  const dying = await enroll("dying");
  console.log("stub token endpoint answers every grant with refresh_token_expires_in = 2419200 (28 days)\n");
  await show("account", "credentials", "status", dying);
  await show("account", "list");
  const expiry = (await authority(dying))!.refreshTokenExpiresAt!;
  console.log(`credentials status --json refreshTokenExpiresAt = ${new Date(expiry).toISOString()} (${((expiry - Date.now()) / 86_400_000).toFixed(2)} days from now)`);
  console.log(`account list --json     refreshTokenExpiresAt = ${new Date((await accountRow(dying)).refreshTokenExpiresAt!).toISOString()}  <- the account row Apiary mirrors`);
  await hive("account", "credentials", "refresh", dying);
  console.log(await lease(dying));

  section("2. The provider refuses the refresh token: 400 invalid_grant");
  await until("a readable limits row", async () => (await limitsRow(dying))?.readable === true, 20_000);
  console.log(`before: status=${(await accountRow(dying)).status} credentialHealth=${(await accountRow(dying)).credentialHealth} limits.readable=${(await limitsRow(dying))!.readable}`);
  modes.set("dying", "invalid_grant");
  const switchedAt = Date.now();
  const dueAt = (await authority(dying))!.expiresAt - SHIP_FLOOR_S * 1000;
  const marker = logCount(dying);
  await until("phase login_required", async () => (await authority(dying))!.phase === "login_required", (DUE_AFTER_S + 10) * 1000 + CYCLE_MS);
  const refusedAt = (await authority(dying))!.failure!.at;
  console.log(`stub switched to 400 invalid_grant at ${new Date(switchedAt).toISOString()}; the current access token fell due for refresh at ${new Date(dueAt).toISOString()}`);
  console.log(`refusal recorded at ${new Date(refusedAt).toISOString()}: ${refusedAt - Math.max(switchedAt, dueAt)} ms after the first moment a refresh was due (one cycle = ${CYCLE_MS} ms)\n`);
  await show("account", "credentials", "status", dying);
  await show("account", "list");
  console.log(`after:  status=${(await accountRow(dying)).status} credentialHealth=${(await accountRow(dying)).credentialHealth} limits.readable=${(await limitsRow(dying))!.readable} limits.unreadableReason=${(await limitsRow(dying))!.unreadableReason}`);
  console.log(await lease(dying));
  const presentedAtRefusal = presented.get("dying")!;
  await sleep(CYCLE_MS * 2 + 500);
  console.log(await lease(dying));
  console.log(`refresh token presentations after the refusal, across two more cycles and two lease requests: ${presented.get("dying")! - presentedAtRefusal} (minting stopped)`);
  console.log(`\ndaemon log (hived.log), ${dying}, from the refusal on:\n${logLines(dying, marker)}`);

  section("3. 503 from the provider: not consumed, stays ready, retries with backoff, recovers");
  const outage = await enroll("outage");
  await until("a readable limits row", async () => (await limitsRow(outage))?.readable === true, 20_000);
  modes.set("outage", "overloaded");
  const outageMarker = logCount(outage);
  await until("three retryable attempts", async () => ((await authority(outage))!.failure?.attempts ?? 0) >= 3, 60_000);
  await show("account", "credentials", "status", outage);
  console.log(`status=${(await accountRow(outage)).status} limits.readable=${(await limitsRow(outage))!.readable} (last-good kept during a provider outage)`);
  console.log(await lease(outage));
  modes.set("outage", "ok");
  await until("recovery", async () => (await authority(outage))!.phase === "ready" && (await authority(outage))!.failure === null, 60_000);
  await show("account", "credentials", "status", outage);
  console.log(await lease(outage));
  console.log(`\ndaemon log, ${outage}:\n${logLines(outage, outageMarker)}`);

  section("4. Connection refused before send: not consumed, stays ready, retries, recovers");
  const netdown = await enroll("netdown");
  const netdownMarker = logCount(netdown);
  await stopTokenServer();
  console.log("stub token endpoint stopped listening\n");
  await until("two connection failures", async () => ((await authority(netdown))!.failure?.attempts ?? 0) >= 2, 60_000);
  await show("account", "credentials", "status", netdown);
  console.log(`status=${(await accountRow(netdown)).status}`);
  await startTokenServer();
  console.log("stub token endpoint listening again\n");
  await until("recovery", async () => (await authority(netdown))!.phase === "ready" && (await authority(netdown))!.failure === null, 60_000);
  await show("account", "credentials", "status", netdown);
  console.log(`\ndaemon log, ${netdown}:\n${logLines(netdown, netdownMarker)}`);

  section("5. Timeout after send, token was consumed: uncertain -> retry -> invalid_grant -> login_required");
  const lost = await enroll("lost");
  modes.set("lost", "hang");
  const lostMarker = logCount(lost);
  await until("phase uncertain", async () => (await authority(lost))!.phase === "uncertain", 60_000);
  await show("account", "credentials", "status", lost);
  await show("account", "list");
  console.log(await lease(lost));
  modes.set("lost", "invalid_grant");
  console.log("\nthe retry now gets the answer a consumed token gets: 400 invalid_grant\n");
  await until("phase login_required", async () => (await authority(lost))!.phase === "login_required", 60_000);
  await show("account", "credentials", "status", lost);
  console.log(await lease(lost));
  console.log(`\ndaemon log, ${lost}:\n${logLines(lost, lostMarker)}`);

  section("6. Timeout after send, token was NOT consumed: uncertain -> retry -> ready, status back to ok");
  const slow = await enroll("slow");
  modes.set("slow", "hang");
  const slowMarker = logCount(slow);
  await until("phase uncertain", async () => (await authority(slow))!.phase === "uncertain", 60_000);
  console.log(`phase=${(await authority(slow))!.phase} status=${(await accountRow(slow)).status}`);
  modes.set("slow", "ok");
  await until("recovery", async () => (await authority(slow))!.phase === "ready" && (await accountRow(slow)).status === "ok", 60_000);
  await show("account", "credentials", "status", slow);
  console.log(`status=${(await accountRow(slow)).status} statusReason=${JSON.stringify((await accountRow(slow)).statusReason)}`);
  console.log(`\ndaemon log, ${slow}:\n${logLines(slow, slowMarker)}`);

  section("6b. 502 from a gateway after the provider rotated: uncertain (not 'unconsumed') -> retry -> invalid_grant -> login_required");
  const gateway = await enroll("gateway");
  modes.set("gateway", "bad_gateway");
  const gatewayMarker = logCount(gateway);
  await until("phase uncertain", async () => (await authority(gateway))!.phase === "uncertain", 60_000);
  await show("account", "credentials", "status", gateway);
  console.log(`status=${(await accountRow(gateway)).status}`);
  modes.set("gateway", "invalid_grant");
  await until("phase login_required", async () => (await authority(gateway))!.phase === "login_required", 60_000);
  console.log(`\ndaemon log, ${gateway}:\n${logLines(gateway, gatewayMarker)}`);

  section("7. Daemon killed mid-refresh (phase refreshing): resolves after restart instead of freezing");
  const crash = await enroll("crash");
  modes.set("crash", "hang");
  const crashMarker = logCount(crash);
  await until("phase refreshing", async () => (await authority(crash))!.phase === "refreshing", 60_000);
  await killDaemon("SIGKILL");
  console.log("daemon SIGKILLed while the refresh was in flight");
  const store = new DatabaseSync(join(dataDir, "core.sqlite3"), { readOnly: true });
  console.log(`store row while no daemon runs: ${JSON.stringify(store.prepare("SELECT phase, generation FROM account_credential_authorities WHERE account = ?").get(crash))}\n`);
  store.close();
  modes.set("crash", "ok");
  startDaemon();
  const resolved = await until("phase ready after restart", async () => {
    const state = await hive("account", "credentials", "status", crash, "--json");
    try { return (JSON.parse(state.out) as Authority).phase === "ready"; } catch { return false; }
  }, 60_000);
  console.log(`daemon restarted; phase ready ${resolved} ms later\n`);
  await show("account", "credentials", "status", crash);
  await until(`${crash} ok`, async () => (await accountRow(crash)).status === "ok", 20_000);
  console.log(`status=${(await accountRow(crash)).status}`);
  console.log(`\ndaemon log, ${crash}:\n${logLines(crash, crashMarker)}`);

  section("8. Final state and secret check");
  await show("account", "list");
  const log = readFileSync(join(dataDir, "hived.log"), "utf8");
  console.log(`hived.log lines: ${log.split("\n").length}; occurrences of a stub refresh token: ${log.split("stub-refresh.").length - 1}; of a stub access token: ${log.split("stub-access.").length - 1}`);
  console.log("PROOF RUN COMPLETE");
} finally {
  if (daemon) await killDaemon("SIGTERM").catch(() => undefined);
  for (const response of hanging) response.destroy();
  await stopTokenServer().catch(() => undefined);
  usageServer.closeAllConnections();
  usageServer.close();
  if (process.env.KEEP_DATA_DIR !== "1") rmSync(dataDir, { recursive: true, force: true });
}
