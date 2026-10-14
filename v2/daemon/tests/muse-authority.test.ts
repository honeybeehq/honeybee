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
    assert.equal(existsSync(r.homeFile), false);
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

test("Muse idle authorities never mint on ticks, even past expiry; lease demand renews once", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    r.advance(5 * 60 * 60_000);
    r.svc.centralEarlyRefreshTick();
    r.svc.centralRefreshRetryTick();
    await r.svc.refreshLimits([r.account.id]);
    assert.equal(r.calls(), 1);
    assert.equal(r.store.getAccount(r.account.id)?.status, "ok");
    assert.equal(r.store.getAccountCredentialAuthority(r.account.id)?.phase, "ready");
    await r.svc.mintLease(r.account);
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
    await assert.rejects(r.svc.museCredentials.enable(r.account), error => (error as { reason: string }).reason === "unavailable" && /no held Muse login/.test((error as Error).message));
    assert.equal(r.calls(), 0);
    const lease = await r.svc.mintLease(r.account);
    assert.equal(lease.expiresAt, Math.floor((r.now() + MUSE_DEFAULT_KEY_TTL_MS) / 1000));
    const own = r.store.createAccount({ id: "muse-this-mac", harness: "muse", label: "This Mac", homePath: join(r.dir, "own-home", ".config"), native: true });
    const refused = (error: unknown) => (error as { reason?: string; code?: string }).reason === "unavailable" && (error as Error).message.includes("this computer\'s own muse sign-in");
    await assert.rejects(r.svc.museCredentials.enable(own), refused);
    await assert.rejects(r.svc.museCredentials.relogin(own, native, null, { allowDifferentAccount: true, stillWanted: () => true }), refused);
    await assert.rejects(r.svc.mintLease(own), error => (error as { code: string }).code === "lease_unsupported" && (error as Error).message.includes("own muse sign-in"));
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
  let completed = 0, grantPolls = 0;
  const flows = new LoginFlowService({ store: r.store, cfg: r.cfg, accounts: r.svc, now: r.now, log: op => r.logs.push(op), spawner: null,
    transports: {
      museDeviceAuthorize: async () => ({ ok: true, deviceCode: "fixture-device", userCode: "fixture-code", verificationUri: "https://auth.meta.com/device", verificationUriComplete: null, expiresInSeconds: 900, intervalSeconds: 1 }),
      museDeviceToken: async () => { grantPolls++; return { kind: "granted", accessToken: login, refreshToken: null, expiresInSeconds: 3600 }; },
    }, onCompleted: () => completed++ });
  try {
    const ready = await r.svc.museCredentials.enable(r.account);
    const { flow } = await flows.start(r.account, { methodId: "muse-oauth", replaceAccount: true });
    r.advance(1001);
    const approvedAt = r.now();
    flows.tick();
    for (let i = 0; i < 100 && r.store.getLoginFlow(flow.id)?.phase !== "validating"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "validating");
    assert.equal(r.calls(), 1);
    r.advance(MUSE_MINT_FLOOR_MS);
    flows.tick();
    for (let i = 0; i < 100 && r.store.getLoginFlow(flow.id)?.phase !== "succeeded"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "succeeded");
    assert.equal(completed, 1);
    assert.equal(grantPolls, 1);
    const privateValue = JSON.parse(readFileSync(join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.json`), "utf8"));
    assert.equal(JSON.parse(privateValue.nativeSnapshot.vault).providers.meta.expires_at, Math.floor(approvedAt / 1000) + 3600);
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
    await assert.rejects(r.service().museCredentials.enable(r.account), error => (error as { reason: string }).reason === "operation_in_progress");
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    assert.equal((await r.service().museCredentials.enable(r.account)).phase, "ready");
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});

for (const platform of ["linux", "darwin"] as const) test(`Muse ${platform} disable restores native copies byte for byte, including schema and other providers`, async () => {
  const r = rig(platform);
  try {
    const vaultRaw = JSON.stringify({ ...native, schema_version: 17 }, null, 4) + "\n";
    const homeRaw = "  " + JSON.stringify({ ...native, schema_version: 19 }) + "\n";
    writeFileSync(r.vaultFile, vaultRaw);
    if (platform === "linux") { mkdirSync(join(r.homeFile, ".."), { recursive: true }); writeFileSync(r.homeFile, homeRaw); }
    const ready = await r.svc.museCredentials.enable(r.account);
    const facts = JSON.stringify({ dump: r.store.dumpState(), audit: r.store.auditRows(), status: ready, logs: r.logs });
    assert.ok(!facts.includes(login) && !facts.includes("foreign-private-key"));
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    await r.svc.museCredentials.ensure(r.account, 0, "rotate");
    await r.svc.museCredentials.disable(r.account);
    assert.ok(readFileSync(r.vaultFile, "utf8") === vaultRaw);
    if (platform === "linux") assert.ok(readFileSync(r.homeFile, "utf8") === homeRaw);
    else assert.equal(existsSync(r.homeFile), false);
    assert.ok(!readFileSync(r.vaultFile, "utf8").includes("fixture-working-key"));
  } finally { r.cleanup(); }
});

test("Muse elective margin request keeps a usable key through backoff; forced mint remains paced", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    r.advance(190 * 60_000);
    r.response({ kind: "retryable", httpStatus: 429, error: null, description: "paced", retryAfterMs: 600_000 });
    await assert.rejects(r.svc.museCredentials.ensure(r.account, 0, "failed"));
    r.advance(60_000);
    const result = await r.svc.mintLease(r.account, { minTtlMs: 3_600_000 });
    assert.ok(result.expiresAt! * 1000 > r.now());
    assert.equal(r.calls(), 2);
    await assert.rejects(r.svc.museCredentials.ensure(r.account, 0, "forced"), error => (error as { retryAt: number }).retryAt! > r.now());
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});

test("Muse forgetDisabled and missing authority relogin keep the persisted mint floor", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    const authorityFile = join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.json`);
    rmSync(authorityFile);
    await assert.rejects(r.service().museCredentials.relogin(r.account, native, null, { allowDifferentAccount: true, stillWanted: () => true }), error => (error as { reason: string }).reason === "operation_in_progress");
    await r.svc.museCredentials.disable(r.account);
    r.svc.museCredentials.forgetDisabled(r.account);
    writeFileSync(r.vaultFile, JSON.stringify(native));
    writeFileSync(r.homeFile, JSON.stringify(native));
    await assert.rejects(r.service().museCredentials.enable(r.account), error => (error as { reason: string }).reason === "operation_in_progress");
    assert.equal(r.calls(), 1);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    assert.equal((await r.service().museCredentials.enable(r.account)).phase, "ready");
    assert.equal(r.calls(), 2);
  } finally { r.cleanup(); }
});

test("Muse rollback never overwrites an external login, including where the native snapshot was absent", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    const foreign = JSON.stringify({ providers: { meta: { access_token: "operator-new-login" } } });
    writeFileSync(r.homeFile, foreign);
    const vaultBefore = readFileSync(r.vaultFile, "utf8");
    assert.equal((await r.svc.museCredentials.disable(r.account)).phase, "disabled");
    assert.ok(readFileSync(r.homeFile, "utf8") === foreign);
    assert.ok(readFileSync(r.vaultFile, "utf8") === vaultBefore);
  } finally { r.cleanup(); }
});

test("Muse an old authority without a snapshot disables without fabricating native material", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    const path = join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.json`);
    const value = JSON.parse(readFileSync(path, "utf8")); delete value.nativeSnapshot;
    writeFileSync(path, JSON.stringify(value));
    const published = readFileSync(r.vaultFile, "utf8");
    assert.equal((await r.service().museCredentials.disable(r.account)).phase, "disabled");
    assert.ok(readFileSync(r.vaultFile, "utf8") === published);
    assert.ok(existsSync(path));
    assert.match(r.store.getAccount(r.account.id)?.statusReason ?? "", /snapshot.*unavailable/i);
  } finally { r.cleanup(); }
});

for (const end of ["cancel", "timeout", "shutdown"] as const) test(`Muse paced approved grant is dropped on ${end} without another device request or mint`, async () => {
  const r = rig();
  let polls = 0;
  const flows = new LoginFlowService({ store: r.store, cfg: r.cfg, accounts: r.svc, now: r.now, log: op => r.logs.push(op), spawner: null,
    transports: {
      museDeviceAuthorize: async () => ({ ok: true, deviceCode: "fixture-device", userCode: "fixture-code", verificationUri: "https://auth.meta.com/device", verificationUriComplete: null, expiresInSeconds: 30, intervalSeconds: 1 }),
      museDeviceToken: async () => { polls++; return { kind: "granted", accessToken: login, refreshToken: null, expiresInSeconds: null }; },
    } });
  try {
    await r.svc.museCredentials.enable(r.account);
    const { flow } = await flows.start(r.account, { methodId: "muse-oauth", replaceAccount: true });
    r.advance(1001); flows.tick();
    for (let i = 0; i < 100 && r.store.getLoginFlow(flow.id)?.phase !== "validating"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "validating");
    const runner = Reflect.get(flows, "runners").get(flow.id);
    assert.ok(Reflect.get(runner, "pendingGrant"));
    assert.ok(r.store.getLoginFlow(flow.id)!.expiresAt > r.now() + MUSE_MINT_FLOOR_MS);
    if (end === "cancel") await flows.cancel(flow.id);
    else if (end === "shutdown") await flows.shutdown();
    else { r.advance(r.store.getLoginFlow(flow.id)!.expiresAt - r.now() + 1); flows.tick(); }
    r.advance(2 * MUSE_MINT_FLOOR_MS); flows.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, 1);
    assert.equal(Reflect.get(runner, "pendingGrant"), null);
    assert.equal(r.calls(), 1);
    assert.ok(!JSON.stringify({ audit: r.store.auditRows(), flows: r.store.listLoginFlows(), logs: r.logs }).includes(login));
  } finally { await flows.shutdown(); r.cleanup(); }
});

test("Muse corrupt renewal marker fails closed; removing it re-paces from the authority watermark", async () => {
  const r = rig();
  try {
    await r.svc.museCredentials.enable(r.account);
    const marker = join(r.cfg.accounts.vaultDir, ".credential-authorities", `${r.account.id}.renewal.json`);
    writeFileSync(marker, "not-json");
    await assert.rejects(r.service().museCredentials.ensure(r.account, 0, "forced"), error => (error as { reason: string }).reason === "unavailable" && /pacing state is unavailable/.test((error as Error).message));
    assert.equal(readFileSync(marker, "utf8"), "not-json");
    rmSync(marker);
    await assert.rejects(r.service().museCredentials.ensure(r.account, 0, "forced"), error => (error as { reason: string }).reason === "operation_in_progress");
    assert.equal(r.calls(), 1);
    r.advance(MUSE_MINT_FLOOR_MS + 1);
    assert.equal((await r.service().museCredentials.ensure(r.account, 0, "forced")).phase, "ready");
    assert.equal(r.calls(), 2);
    const safe = JSON.stringify({ dump: r.store.dumpState(), audit: r.store.auditRows(), status: r.svc.museCredentials.status(r.account), logs: r.logs });
    assert.ok(!safe.includes("attemptAt") && !safe.includes(login));
  } finally { r.cleanup(); }
});

test("Muse an approved grant that expires during pacing fails without a mint or changing the held login", async () => {
  const r = rig();
  let polls = 0;
  const flows = new LoginFlowService({ store: r.store, cfg: r.cfg, accounts: r.svc, now: r.now, log: op => r.logs.push(op), spawner: null,
    transports: {
      museDeviceAuthorize: async () => ({ ok: true, deviceCode: "fixture-device", userCode: "fixture-code", verificationUri: "https://auth.meta.com/device", verificationUriComplete: null, expiresInSeconds: 900, intervalSeconds: 1 }),
      museDeviceToken: async () => { polls++; return { kind: "granted", accessToken: login, refreshToken: null, expiresInSeconds: 1 }; },
    } });
  try {
    const ready = await r.svc.museCredentials.enable(r.account);
    const { flow } = await flows.start(r.account, { methodId: "muse-oauth", replaceAccount: true });
    r.advance(1001); flows.tick();
    for (let i = 0; i < 100 && r.store.getLoginFlow(flow.id)?.phase !== "validating"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const runner = Reflect.get(flows, "runners").get(flow.id);
    r.advance(MUSE_MINT_FLOOR_MS); flows.tick();
    for (let i = 0; i < 100 && r.store.getLoginFlow(flow.id)?.phase !== "failed"; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(r.store.getLoginFlow(flow.id)?.phase, "failed");
    assert.match(r.store.getLoginFlow(flow.id)?.error?.message ?? "", /expired.*sign in again/i);
    assert.equal(Reflect.get(runner, "pendingGrant"), null);
    assert.equal(polls, 1);
    assert.equal(r.calls(), 1);
    assert.equal(r.svc.museCredentials.status(r.account)?.generation, ready.generation);
    assert.equal(r.svc.museCredentials.status(r.account)?.phase, "ready");
  } finally { await flows.shutdown(); r.cleanup(); }
});
