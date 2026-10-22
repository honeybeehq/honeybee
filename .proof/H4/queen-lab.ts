import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { AccountsService } from "../../v2/daemon/src/accountsService.ts";
import { loadNodeConfig } from "../../v2/daemon/src/config.ts";

const root = process.env.HOME!;
if (!root || root !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(root)) throw new Error("Isolated HOME and TMPDIR required");
const document = (access: string, refresh: string, expiry: number) => JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: expiry } });
const needleStub = document("", "", 0);
const identity = { accountUuid: "fixture-account", organizationUuid: "fixture-org" };
const cases = ["home-newer", "home-partial", "keychain-newer", "keychain-ready", "uncertain", "vault-only-uncertain", "expired-vault-only", "reported-stub", "zero-byte", "empty-object", "wrong-account", "wrong-org", "identity-unknown", "identity-unrecorded", "identity-timeout", "identity-race", "login-race", "login-busy", "refresh-busy", "seed-busy"];
for (const scenario of cases) {
  const dir = join(root, `queen-${scenario}-${Date.now()}`), home = join(dir, "homes", "claude-lab"), vault = join(dir, "vault", "claude", "claude-lab");
  mkdirSync(home, { recursive: true }); mkdirSync(vault, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { homesDir: join(dir, "homes"), vaultDir: join(dir, "vault"), limitsRefreshMs: 0, limitsFetchTimeoutMs: 1000 } }));
  const cfg = loadNodeConfig(dir), store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  let raw = scenario === "zero-byte" ? "" : scenario === "empty-object" ? "{}" : needleStub;
  let keychain: string | null = document("KEYCHAIN-ACCESS", "KEYCHAIN-LIVE", 4102444800000);
  let expectedRefresh: string | null = null;
  if (scenario === "home-newer") { raw = document("", "HOME-LIVE", 0); keychain = null; expectedRefresh = "HOME-LIVE"; }
  if (scenario === "home-partial") { raw = JSON.stringify({ claudeAiOauth: { refreshToken: "HOME-LIVE" } }); keychain = null; expectedRefresh = "HOME-LIVE"; }
  if (scenario === "keychain-newer") { raw = document("HOME-OLD-ACCESS", "HOME-SPENT", 1); keychain = document("KEYCHAIN-EXPIRED-ACCESS", "KEYCHAIN-LIVE", 2); expectedRefresh = "KEYCHAIN-LIVE"; }
  if (scenario === "keychain-ready") raw = document("HOME-OLD-ACCESS", "HOME-SPENT", 1);
  if (scenario === "uncertain") { raw = document("", "HOME-LIVE", 0); keychain = document("", "KEYCHAIN-DIFFERENT", 0); }
  if (scenario === "vault-only-uncertain") keychain = null;
  if (scenario === "expired-vault-only") { keychain = null; raw = document("EXPIRED-ACCESS", "", 1); }
  writeFileSync(join(home, ".credentials.json"), raw);
  writeFileSync(join(vault, ".credentials.json"), document("VAULT-EXPIRED", "VAULT-SPENT", 99));
  if (scenario !== "identity-unrecorded") writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: identity }));
  const account = store.createAccount({ id: "claude-lab", harness: "claude", label: "lab", homePath: home, status: "ok" });
  let refreshCalls = 0, identityCalls = 0;
  const service = new AccountsService({ store, cfg, platform: keychain ? "darwin" : "linux", keychainReader: async () => keychain, keychainWriter: async () => true, log: () => {}, fetchers: {
    claudeUsage: async () => ({ five_hour: { utilization: 1 }, seven_day: { utilization: 1 } }),
    claudeIdentity: async () => { identityCalls++; assert.equal(existsSync(join(home, ".oauth_refresh.lock")), false); if (scenario === "identity-timeout") return new Promise(() => {}); if (scenario === "identity-race") writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { ...identity, accountUuid: "changed" } })); if (scenario === "login-race") store.activeLoginFlow = (() => ({ id: "fixture" })) as typeof store.activeLoginFlow; return scenario === "identity-unknown" ? null : { ...identity, ...(scenario === "wrong-account" ? { accountUuid: "other" } : {}), ...(scenario === "wrong-org" ? { organizationUuid: "other" } : {}) }; },
    claudeRefresh: async token => { assert.equal(token, expectedRefresh, "Only the current live chain may be refreshed; vault snapshot must never be posted"); refreshCalls++; return { kind: "success", token: { accessToken: "ROTATED-ACCESS", refreshToken: "ROTATED-LIVE", expiresAt: 4102444800000 } }; },
  } });
  if (scenario === "login-busy") store.activeLoginFlow = (() => ({ id: "fixture" })) as typeof store.activeLoginFlow;
  if (scenario === "refresh-busy") service.refreshBusy = () => true;
  if (scenario === "seed-busy") (service as unknown as { nativeKeychainSeeds: Map<string, Set<Promise<unknown>>> }).nativeKeychainSeeds.set(account.id, new Set());
  if (["home-newer", "uncertain"].includes(scenario)) { const { bee } = store.createBee({ name: "healthy-sibling", agent: "claude", substrate: "hsr", cwd: dir, account: account.id }); store.updateRuntimeState(bee.id, 1, "running", { pid: 101, pidStartedAt: 1 }); }
  try {
    await service.verifyCredentials(account);
    const held = ["uncertain", "vault-only-uncertain", "expired-vault-only", "wrong-account", "wrong-org", "identity-unknown", "identity-unrecorded", "identity-timeout", "identity-race", "login-race", "login-busy", "refresh-busy", "seed-busy"].includes(scenario);
    const readiness = service.credentialReadiness(store.getAccount(account.id)!);
    assert.equal(readiness.ready, !held, scenario);
    assert.equal(refreshCalls, expectedRefresh ? 1 : 0);
    const attention = service.mirrorRow(store.getAccount(account.id)!).attention;
    if (held) { assert.equal(readFileSync(join(home, ".credentials.json"), "utf8"), raw); const code = scenario === "expired-vault-only" ? "account_credential_expired" : "credential_file_damaged"; assert.equal(readiness.ready ? null : readiness.code, code); assert.equal(attention?.code, code); }
    if (["uncertain", "vault-only-uncertain", "expired-vault-only"].includes(scenario)) {
      const limits = store.getAccountLimits(account.id)!;
      assert.equal(limits.unreadableReason, "provider_error");
      assert.ok(limits.error?.includes(scenario === "uncertain" ? "live_chain_ambiguous" : "snapshot_refresh_unproven"));
      assert.equal(store.getAccount(account.id)!.status, "ok");
      if (scenario === "expired-vault-only") assert.ok(limits.error?.startsWith("credential_source_unconfirmed:"));
    }
    console.log(JSON.stringify({ scenario, ready: readiness.ready, refreshCalls, identityCalls, vaultRefreshCalls: 0, attention: attention?.code ?? null }));
  } finally { store.close(); }
}
