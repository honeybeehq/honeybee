import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type AuditTailResult, type AccountInterruptionsResult, type AccountLeaseInstallResult, type AccountLeaseResult, type MailboxResult, type SendRpcResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import { forceStopTestDaemon, makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const birthOf = (pid: number) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" }).trim().replace(/\s+/g, " "); } catch { return null; }
};

async function killFixtures(pidDir: string): Promise<void> {
  const fixtures = existsSync(pidDir) ? readdirSync(pidDir).map(name => ({ pid: Number(name), birth: readFileSync(join(pidDir, name), "utf8") })) : [];
  for (const { pid, birth } of fixtures) {
    if (birthOf(pid) !== birth) continue;
    try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  await waitFor(() => fixtures.every(({ pid, birth }) => birthOf(pid) !== birth), "auth-death fixtures exited", 10_000, 50);
  rmSync(pidDir, { recursive: true, force: true });
}

for (const stayAlive of [false, true]) test(`auth death isolated daemons: revoked provider access, ${stayAlive ? "system idle stop" : "process exit"}, newer lease revives once; restart, mail FIFO and operator stop`, { timeout: 120_000 }, async t => {
  const access = new Set<string>(), refresh = new Set<string>();
  const firstAccess = randomUUID(), firstRefresh = randomUUID();
  access.add(firstAccess); refresh.add(firstRefresh);
  let rotations = 0;
  const provider = createServer(async (req, res) => {
    if (req.url === "/call") { res.writeHead(access.has(req.headers.authorization?.slice(7) ?? "") ? 200 : 401); res.end("{}"); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers["content-type"]?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    if (!refresh.delete(body.refresh_token)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid_grant" })); return; }
    rotations++; access.clear();
    const nextAccess = randomUUID(), nextRefresh = randomUUID(); access.add(nextAccess); refresh.add(nextRefresh);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ access_token: nextAccess, refresh_token: nextRefresh, expires_in: 3600 }));
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  const pidDir = mkdtempSync(join(tmpdir(), "auth-death-fixtures-"));
  const fixtureEnv = { AUTH_DEATH_PROVIDER_URL: endpoint + "/call", AUTH_DEATH_OWNER_PID: String(process.pid), AUTH_DEATH_PID_DIR: pidDir };
  const source = makeDaemonDir({ accounts: { centralRefreshAheadMs: 0 }, agents: { claude: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/auth-death-claude.mjs", import.meta.url))], adapter: "claude", env: fixtureEnv } } });
  const holder = makeDaemonDir({ idleWindowMs: stayAlive ? 700 : 0, agents: { claude: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/auth-death-claude.mjs", import.meta.url))], adapter: "claude", env: { ...fixtureEnv, AUTH_DEATH_STAY_ALIVE: stayAlive ? "1" : "0" } } } });
  let da: DaemonHandle | null = null, db: DaemonHandle | null = null, ca: RpcClient | null = null, cb: RpcClient | null = null;
  let cleaned: Promise<void> | undefined;
  const cleanup = () => cleaned ??= (async () => {
    ca?.close(); cb?.close();
    const stopped = await Promise.allSettled([da && forceStopTestDaemon(da), db && forceStopTestDaemon(db)]);
    stopped.push(...await Promise.allSettled([killFixtures(pidDir)]));
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    source.cleanup(); holder.cleanup();
    for (const result of stopped) if (result.status === "rejected") throw result.reason;
  })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  const env = (dir: string) => ({ HOME: join(dir, "empty-user-home"), HIVE_GATEWAYS_DISABLE: "1", HIVE_CLAUDE_OAUTH_TOKEN_URL: endpoint + "/token" });
  const poll = <T>(fn: () => Promise<T | null | false>, name: string) => waitFor(fn, name, 30_000);
  const view = (beeId: string) => cb!.request<ViewResult>("view", { beeId });
  const rows = (beeId: string) => cb!.request<AccountInterruptionsResult>("account.interruptions", { beeId });
  try {
    da = await startDaemon(source.dir, { env: env(source.dir), stopTimeoutMs: 30_000 }); ca = await da.client();
    db = await startDaemon(holder.dir, { env: env(holder.dir), stopTimeoutMs: 30_000 }); cb = await db.client();
    assert.ok(cb.capabilities.includes("account.auth_death_recovery.v1"));
    const id = "claude-test-example.com", vault = join(source.dir, "vault", "claude", id);
    mkdirSync(vault, { recursive: true }); writeFileSync(join(vault, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: firstAccess, refreshToken: firstRefresh, expiresAt: Date.now() + 3_600_000 } }));
    await ca.request("account.add", { id, harness: "claude", label: "test-example.com", importExisting: true });
    await ca.request("account.credentials.enable", { id, idempotencyKey: randomUUID() });
    const minted = () => ca!.request<AccountLeaseResult>("account.lease", { account: id });
    const shareId = randomUUID();
    const install = (lease: AccountLeaseResult) => cb!.request<AccountLeaseInstallResult>("account.lease.install", { id, harness: "claude", label: "test-example.com", shareId, authorityNodeId: "test-authority", epoch: 1, generation: lease.generation, expiresAt: lease.expiresAt ?? null, files: lease.files });
    const old = await minted(); assert.ok(Number.isSafeInteger(old.generation));
    const installed = await install(old), leasedId = installed.account.id;
    const spawned = await cb.request<SpawnResult>("spawn", { agent: "claude", name: "managed", account: leasedId, cwd: holder.dir, tags: ["autoswap=false"] });
    const beeId = spawned.beeId;
    const before = await poll(async () => { const value = await view(beeId); return value.bee?.providerSessionId && value.runtime?.state === "idle" ? value : null; }, "fake provider runtime ready");
    assert.ok(before.runtime?.credentialStamp);
    const generation = before.runtime!.generation;
    const central = await ca.request<SpawnResult>("spawn", { agent: "claude", name: "central", account: id, cwd: source.dir, tags: ["autoswap=false"] });
    const centralBefore = await poll(async () => { const value = await ca!.request<ViewResult>("view", { beeId: central.beeId }); return value.bee?.providerSessionId && value.runtime?.state === "idle" ? value : null; }, "central fake provider runtime ready");
    await ca.request("account.credentials.refresh", { id, idempotencyKey: randomUUID() });
    await poll(async () => { const value = await view(beeId); return value.runtime?.state === "stopped" && (await rows(beeId)).interruptions.some(row => row.deathRecovery?.deadline !== null) ? value : null; }, "auth death recorded before delivery");
    const first = await cb.request<SendRpcResult>("send", { beeId, body: "first queued message" });
    const second = await cb.request<SendRpcResult>("send", { beeId, body: "second queued message" });
    assert.deepEqual(first.runtimeStartHold, { code: "account_auth_needed", message: "Waiting for refreshed account material" });
    assert.equal((await view(beeId)).runtime?.generation, generation);
    if (!stayAlive) {
      await db.kill(); cb.close(); db = await startDaemon(holder.dir, { env: env(holder.dir), stopTimeoutMs: 30_000 }); cb = await db.client();
    }
    const newer = await minted(); assert.ok(newer.generation! > old.generation!);
    const centralAfter = await poll(async () => { const value = await ca!.request<ViewResult>("view", { beeId: central.beeId }); return value.runtime?.generation === centralBefore.runtime!.generation + 1 && value.runtime.state === "idle" ? value : null; }, "local central publication recovery");
    assert.equal(centralAfter.bee?.providerSessionId, centralBefore.bee?.providerSessionId);
    const primary = join(holder.dir, "homes", leasedId, ".credentials.json"), bytes = readFileSync(primary);
    await assert.rejects(() => install({ ...newer, generation: old.generation! - 1 }), (error: unknown) => error instanceof RpcError && error.code === "account_lease_conflict");
    assert.ok(bytes.equals(readFileSync(primary)), "regressing generation refuses before file mutation");
    const rotationsBeforeInstall = rotations;
    await install(newer);
    const after = await poll(async () => { const value = await view(beeId); const mail = (await cb!.request<MailboxResult>("mailbox", { beeId })).messages; return value.runtime?.generation === generation + 1 && mail.find(m => m.id === second.messageId)?.deliveredAt != null ? value : null; }, "single recovery and queued message delivery");
    assert.equal(after.bee?.id, before.bee?.id); assert.equal(after.bee?.providerSessionId, before.bee?.providerSessionId); assert.equal(after.bee?.cellId, before.bee?.cellId);
    const mail = (await cb.request<MailboxResult>("mailbox", { beeId })).messages;
    assert.deepEqual(mail.filter(m => [first.messageId, second.messageId].includes(m.id)).map(m => [m.id, m.deliveredGeneration]), [[first.messageId, generation + 1], [second.messageId, generation + 1]]);
    const claims = (await rows(beeId)).interruptions.filter(row => row.deathRecovery?.claimedAt != null);
    assert.equal(claims.length, 1); assert.equal(claims[0]!.continuationKind, "revive");
    const audit = await cb.request<AuditTailResult>("audit.tail", { beeId, limit: 1000 });
    assert.equal(audit.rows.filter(row => row.kind === "auth_death.resumed").length, 1);
    const publicEvidence = JSON.stringify({ audit, after, interruptions: (await rows(beeId)).interruptions }) + db.output() + da.output();
    assert.equal([firstAccess, firstRefresh, ...access, ...refresh].filter(secret => publicEvidence.includes(secret)).length, 0, "credentials absent from logs, audit and public metadata");
    await install(newer); assert.equal((await view(beeId)).runtime?.generation, generation + 1); assert.equal(rotations, rotationsBeforeInstall);
    await cb.request("stop", { beeId }); await poll(async () => (await view(beeId)).runtime?.state === "stopped", "operator stopped restored bee");
    await ca.request("account.credentials.refresh", { id, idempotencyKey: randomUUID() }); await install(await minted());
    assert.equal((await view(beeId)).runtime?.generation, generation + 1);
    console.log(`auth death ${stayAlive ? "system-stop" : "exit/restart"}: provider revocation → held accepted FIFO mail → higher lease generation → one same-id/session recovery; duplicate and operator stop fenced`);
  } finally { await cleanup(); }
});
