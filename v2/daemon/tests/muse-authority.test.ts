import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { LoginFlowService } from "../src/loginFlows.ts";
import { loadNodeConfig } from "../src/config.ts";
import { defaultMuseKeyTransport, MUSE_DEFAULT_KEY_TTL_MS, MUSE_MINT_FLOOR_MS, MUSE_KEY_URL } from "../src/museCredentialAuthority.ts";
import type { CredentialRefreshTransport, CredentialRefreshResult } from "../src/claudeRefreshTransport.ts";

const login = "fixture-held-bootstrap";
const native = { schema_version: 1, providers: { meta: { mechanism: "oauth", access_token: login, obtained_via: "device_code", expires_at: 1, user_email: "private@example.invalid" }, foreign: { api_key: "foreign-private-key" } } };
function rig(platform: "linux" | "darwin" = "linux") {
  const dir = mkdtempSync(join(tmpdir(), "muse-authority-"));
  const homes = join(dir, "homes"), vault = join(dir, "vault");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { homesDir: homes, vaultDir: vault, limitsRefreshMs: 0, centralRefreshAheadMs: 3 * 60 * 60_000 }, naming: { auto: false } }));
  const cfg = loadNodeConfig(dir);
  let at = Date.parse("2026-10-14T12:00:00Z"), calls = 0;
  let result: CredentialRefreshResult | null = null;
  const store = openCoreStore(cfg.storePath, { now: () => at });
  const account = store.createAccount({ id: "muse-fixture", harness: "muse", homePath: join(homes, "muse-fixture"), label: "fixture", penalty: 0, status: "ok" });
  const vaultFile = join(vault, "muse", account.id, "muse", "auth.json");
  const homeFile = join(account.homePath, "muse", "auth.json");
  mkdirSync(join(vaultFile, ".."), { recursive: true });
  writeFileSync(vaultFile, JSON.stringify(native));
  const logs: string[] = [];
  const mint: CredentialRefreshTransport = async bootstrap => {
    assert.ok(bootstrap === login);
    calls++;
    return result ?? { kind: "success", token: { accessToken: `fixture-working-key-${calls}`, apiBaseUrl: "https://api.meta.ai/muse-code", expiresAt: at + MUSE_DEFAULT_KEY_TTL_MS } };
  };
  const service = () => new AccountsService({ store, cfg, platform, now: () => at, log: op => logs.push(op), museKeyMint: mint, home: join(dir, "own-home"), env: {} });
  const svc = service();
  return { dir, cfg, store, account, svc, homeFile, vaultFile, logs, service, calls: () => calls, now: () => at, advance: (ms: number) => at += ms, response: (value: CredentialRefreshResult | null) => result = value, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const platform of ["linux", "darwin"] as const) test(`Muse authority ${platform}: one shared mint, anchored leases, private bootstrap, T21 recreation and no T15`, async () => {
  const r = rig(platform);
  try {
    const ready = await r.svc.museCredentials.enable(r.account);
    assert.equal(r.calls(), 1);
    assert.equal(ready.phase, "ready");
    assert.ok(ready.authorityInstanceId);
    const expiry = Math.floor((r.now() + MUSE_DEFAULT_KEY_TTL_MS) / 1000);
    const leases = await Promise.all(Array.from({ length: 5 }, () => r.svc.mintLease(r.account)));
    assert.equal(r.calls(), 1);
    r.advance(60_000);
    const lease = await r.svc.mintLease(r.account);
    assert.equal(lease.expiresAt, expiry);
    assert.equal(lease.generation, ready.generation);
    assert.equal(lease.authorityInstanceId, ready.authorityInstanceId);
    for (const artifact of [...leases, lease]) {
      const raw = Buffer.from(artifact.files[0]!.contentB64, "base64").toString();
      assert.ok(!raw.includes(login) && !raw.includes("access_token") && !raw.includes("refresh") && !raw.includes("user_email") && !raw.includes("foreign-private-key"));
      assert.deepEqual(Object.keys(JSON.parse(raw).providers.meta).sort(), ["api_base_url", "api_key"]);
    }
    assert.ok(!readFileSync(r.vaultFile, "utf8").includes(login));
    assert.equal(existsSync(r.homeFile), platform === "linux");
    const privateRaw = readFileSync(join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.json`), "utf8");
    assert.ok(privateRaw.includes(login));
    assert.ok(!JSON.stringify(r.logs).includes(login));
    assert.equal(r.svc.authDeathMaterial(r.account), null);
    assert.equal(r.svc.museCredentials.supportsCredentialHandoff(), false);
    assert.equal(r.svc.museCredentials.supportsAuthDeathRecovery(), false);
    const restarted = r.service();
    const restartLease = await restarted.mintLease(r.account);
    assert.equal(restartLease.expiresAt, expiry);
    assert.equal(r.calls(), 1);
    await restarted.museCredentials.disable(r.account);
    assert.ok(readFileSync(r.vaultFile, "utf8").includes(login));
    if (platform === "linux") assert.ok(readFileSync(r.homeFile, "utf8").includes(login));
    await assert.rejects(restarted.museCredentials.enable(r.account), error => (error as { reason: string }).reason === "operation_in_progress");
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    const recreated = await restarted.museCredentials.enable(r.account);
    assert.ok(recreated.authorityInstanceId !== ready.authorityInstanceId);
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});

test("Muse renewal is shared, paced across restart, one generation per operation; provider auth alone requires login", async () => {
  const r = rig();
  try {
    const ready = await r.svc.museCredentials.enable(r.account);
    await assert.rejects(r.svc.museCredentials.ensure(r.account, 0, "holder-current"), error => (error as { reason: string; retryAt: number }).reason === "operation_in_progress" && (error as { retryAt: number }).retryAt === r.now() + MUSE_MINT_FLOOR_MS);
    assert.equal(r.calls(), 1);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    const [first, same] = await Promise.all([r.svc.museCredentials.ensure(r.account, 0, "holder-current"), r.svc.museCredentials.ensure(r.account, 0, "holder-current")]);
    assert.equal(first.generation, ready.generation + 1);
    assert.equal(same.generation, first.generation);
    assert.equal(r.calls(), 2);
    assert.equal((await r.svc.museCredentials.ensure(r.account, 0, "holder-current")).generation, first.generation);
    await assert.rejects(r.service().museCredentials.ensure(r.account, 0, "another-holder"));
    assert.equal(r.calls(), 2);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    r.response({ kind: "rejected", httpStatus: 401, error: "authentication_error", description: "held login refused" });
    await assert.rejects(r.svc.museCredentials.ensure(r.account, 0, "new-holder"), /login required/);
    assert.equal(r.store.getAccountCredentialAuthority(r.account.id)?.phase, "login_required");
    assert.equal(r.store.getAccount(r.account.id)?.status, "auth_needed");
    await assert.rejects(r.svc.mintLease(r.account));
    assert.equal(r.calls(), 3);
  } finally { r.cleanup(); }
});

test("Muse early refresh respects the one-hour window despite the common three-hour setting", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    r.advance(2 * 60 * 60_000);
    r.svc.centralEarlyRefreshTick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.calls(), 1);
    r.advance(61 * 60_000);
    r.svc.centralEarlyRefreshTick();
    for (let i = 0; i < 10 && r.svc.museCredentials.busy(r.account); i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});

test("Muse publication preserves external login/key changes; held login is not a lease", async () => {
  const r = rig();
  try {
    await assert.rejects(r.svc.mintLease(r.account), /Enable central Muse/);
    await r.svc.museCredentials.enable(r.account);
    const foreign = JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "user-replaced-key" } } });
    writeFileSync(r.homeFile, foreign);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    await assert.rejects(r.svc.museCredentials.ensure(r.account, 0, "current"), /external Muse/);
    assert.ok(readFileSync(r.homeFile, "utf8") === foreign);
    assert.equal(r.calls(), 1);
  } finally { r.cleanup(); }
});

for (const variant of ["default", "observed", "invalid", "auth", "quota", "malformed"] as const) test(`Muse mint transport ${variant}: exact central request and secret-free outcomes`, async () => {
  const at = Date.parse("2026-10-14T12:00:00Z");
  const response = variant === "auth" ? new Response(login, { status: 403 }) : variant === "quota" ? new Response(login, { status: 429 }) : new Response(JSON.stringify(variant === "malformed" ? { api_key: login } : { api_key: "fixture-working-key", base_url: "https://api.meta.ai/muse-code", ...(variant === "observed" ? { expires_in: 1800 } : variant === "invalid" ? { expires_in: -1 } : {}) }), { status: 200 });
  let calls = 0;
  const mint = defaultMuseKeyTransport(1000, () => at, async (url, init) => {
    calls++;
    assert.equal(url, MUSE_KEY_URL);
    assert.equal(init?.method, "POST");
    assert.ok((init?.headers as Record<string, string>).Authorization === `Bearer ${login}`);
    assert.equal((init?.headers as Record<string, string>)["x-api-version"], "1.0.0");
    assert.deepEqual(JSON.parse(init?.body as string), { onboard: false });
    return response;
  });
  const result = await mint(login);
  assert.equal(calls, 1);
  if (variant === "default" || variant === "observed") {
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.token.expiresAt, at + (variant === "observed" ? 1800_000 : MUSE_DEFAULT_KEY_TTL_MS));
      assert.equal(result.token.refreshToken, undefined);
    }
  } else {
    assert.equal(result.kind, variant === "auth" ? "rejected" : variant === "quota" ? "retryable" : "unknown_outcome");
    assert.ok(!JSON.stringify(result).includes(login));
  }
});

for (const kind of ["retryable", "unknown_outcome"] as const) test(`Muse ${kind} attempts retain pacing and provider backoff through restart`, async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    r.response(kind === "retryable" ? { kind, httpStatus: 429, error: null, description: "paced", retryAfterMs: 900_000 } : { kind, description: "transport unavailable" });
    await assert.rejects(r.svc.museCredentials.ensure(r.account, 0, "failed"));
    const failedAt = r.now();
    const failure = r.store.getAccountCredentialAuthority(r.account.id)!.failure!;
    const retryAt = Math.max(failedAt + MUSE_MINT_FLOOR_MS, failure.retryAt ?? 0);
    assert.equal(r.calls(), 2);
    await assert.rejects(r.service().museCredentials.ensure(r.account, 0, "other"), error => (error as { retryAt: number }).retryAt === retryAt);
    r.advance(retryAt - r.now() - 1);
    await assert.rejects(r.service().museCredentials.ensure(r.account, 0, "other"));
    assert.equal(r.calls(), 2);
    r.advance(2);
    r.response(null);
    assert.equal((await r.service().museCredentials.ensure(r.account, 0, "recovered")).phase, "ready");
    assert.equal(r.calls(), 3);
  } finally { r.cleanup(); }
});

test("Muse relogin requires explicit replacement, mints once, preserves the previous login on refusal and supports cancellation", async () => {
  const r = rig();
  try {
    const ready = await r.svc.museCredentials.enable(r.account);
    const authorityFile = join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.json`);
    const before = readFileSync(authorityFile, "utf8");
    await assert.rejects(r.svc.museCredentials.relogin(r.account, native, null, { allowDifferentAccount: false, stillWanted: () => true }), error => (error as { reason: string }).reason === "identity_unverified");
    assert.ok(readFileSync(authorityFile, "utf8") === before);
    await assert.rejects(r.svc.museCredentials.relogin(r.account, native, null, { allowDifferentAccount: true, stillWanted: () => true }), error => (error as { reason: string }).reason === "operation_in_progress");
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    r.response({ kind: "rejected", httpStatus: 403, error: "authentication_error", description: "new login refused" });
    await assert.rejects(r.svc.museCredentials.relogin(r.account, native, null, { allowDifferentAccount: true, stillWanted: () => true }));
    assert.equal(r.store.getAccountCredentialAuthority(r.account.id)?.generation, ready.generation);
    assert.ok(readFileSync(r.homeFile, "utf8").includes("fixture-working-key-1"));
    await assert.rejects(r.service().museCredentials.relogin(r.account, native, null, { allowDifferentAccount: true, stillWanted: () => true }));
    assert.equal(r.calls(), 2);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    r.response(null);
    await assert.rejects(r.svc.museCredentials.relogin(r.account, native, null, { allowDifferentAccount: true, stillWanted: () => false }));
    assert.equal(r.store.getAccountCredentialAuthority(r.account.id)?.generation, ready.generation);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    const replaced = await r.svc.museCredentials.relogin(r.account, native, null, { allowDifferentAccount: true, stillWanted: () => true });
    assert.equal(replaced.generation, ready.generation + 1);
    assert.equal(replaced.authorityInstanceId, ready.authorityInstanceId);
    assert.ok(!readFileSync(r.homeFile, "utf8").includes(login));
    assert.equal(r.calls(), 4);
  } finally { r.cleanup(); }
});

for (const platform of ["linux", "darwin"] as const) test(`Muse ${platform} static or native login cannot be enrolled or minted as a bootstrap`, async () => {
  const r = rig(platform);
  try {
    writeFileSync(r.vaultFile, JSON.stringify({ providers: { meta: { api_key: "fixture-static-key" } } }));
    await assert.rejects(r.svc.museCredentials.enable(r.account), /no held Muse login/);
    assert.equal(r.calls(), 0);
    const lease = await r.svc.mintLease(r.account);
    assert.equal(lease.expiresAt, Math.floor((r.now() + MUSE_DEFAULT_KEY_TTL_MS) / 1000));
    const own = { ...r.account, native: true };
    await assert.rejects(r.svc.museCredentials.enable(own));
    await assert.rejects(r.svc.mintLease(own));
    assert.equal(r.calls(), 0);
  } finally { r.cleanup(); }
});

test("Muse failed enrollment obeys retry-after across restart without changing native copies", async () => {
  const r = rig();
  try {
    const before = readFileSync(r.vaultFile, "utf8");
    r.response({ kind: "retryable", httpStatus: 429, error: null, description: "paced", retryAfterMs: 900_000 });
    await assert.rejects(r.svc.museCredentials.enable(r.account));
    assert.ok(readFileSync(r.vaultFile, "utf8") === before);
    assert.equal(r.calls(), 1);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    await assert.rejects(r.service().museCredentials.enable(r.account), error => (error as { retryAt: number }).retryAt === r.now() - MUSE_MINT_FLOOR_MS - 1 + 900_000);
    assert.equal(r.calls(), 1);
    r.advance(600_000);
    r.response(null);
    assert.equal((await r.service().museCredentials.enable(r.account)).phase, "ready");
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});

for (const platform of ["linux", "darwin"] as const) test(`Muse ${platform} device login replaces an enabled authority in place without publishing the bootstrap`, async () => {
  const r = rig(platform);
  let completed = 0;
  const flows = new LoginFlowService({ store: r.store, cfg: r.cfg, accounts: r.svc, now: r.now, log: op => r.logs.push(op), spawner: null,
    transports: {
      museDeviceAuthorize: async () => ({ ok: true, deviceCode: "fixture-device", userCode: "fixture-code", verificationUri: "https://auth.meta.com/device", verificationUriComplete: null, expiresInSeconds: 900, intervalSeconds: 1 }),
      museDeviceToken: async () => ({ kind: "granted", accessToken: login, refreshToken: null, expiresInSeconds: null }),
    }, onCompleted: () => completed++ });
  try {
    const ready = await r.svc.museCredentials.enable(r.account);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    const { flow } = await flows.start(r.account, { methodId: "muse-oauth", replaceAccount: true });
    r.advance(1001);
    flows.tick();
    for (let i = 0; i < 100 && r.store.getLoginFlow(flow.id)?.phase !== "succeeded"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "succeeded");
    assert.equal(completed, 1);
    assert.equal(r.store.getAccountCredentialAuthority(r.account.id)?.generation, ready.generation + 1);
    assert.equal(r.calls(), 2);
    assert.ok(!readFileSync(r.vaultFile, "utf8").includes(login));
    assert.equal(existsSync(r.homeFile), platform === "linux");
    if (platform === "linux") assert.ok(!readFileSync(r.homeFile, "utf8").includes(login));
  } finally { await flows.shutdown(); r.cleanup(); }
});

test("Muse a lost disabled authority can enroll a newly supplied native login", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    rmSync(join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.json`));
    await r.svc.museCredentials.disable(r.account);
    writeFileSync(r.vaultFile, JSON.stringify(native));
    writeFileSync(r.homeFile, JSON.stringify(native));
    assert.equal((await r.service().museCredentials.enable(r.account)).phase, "ready");
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});
