/**
 * v19 account.lease — the credential-lease mint (RN7a; credential-leases.md,
 * validated by docs/RN7A_EXPERIMENTS.md):
 *  - refresh-token blanking is DEEP and EXACT: every `refresh_token` /
 *    `refresh` / `refreshToken` string anywhere in the document becomes "",
 *    field kept; near-miss keys and non-secret fields ship untouched
 *  - claude: current access token shipped; an expired chain is refreshed
 *    through the daemon's own single-flight refresher first; typed refusals
 *    when the chain cannot be freshened (live runtime / no refresh / failed)
 *  - codex: access+id token with `refresh_token: ""`; a near-expiry token
 *    triggers the central rotation (injected runner) + home→vault harvest;
 *    under-15-min TTL after rotation is a typed refusal, never a stale ship
 *  - grok: every entry's refresh blanked, cached keys preserved, kindNote
 *    carries the XAI_API_KEY scrub rule
 *  - kimi: API-key lease per the design ruling; OAuth-only → lease_unsupported
 *  - opencode: single coding-plan provider filtered out of the multi-provider
 *    auth.json; every other provider dropped; none → lease_unsupported
 *  - single-flight per account (concurrent mints join); refused while the
 *    account's refresher is mid-rotation
 *  - NO fixture refresh token ever appears in a lease, the service log, or
 *    (RPC tier) the daemon output / audit stream
 * SAFETY: temp dirs only (vault/homes inside the rig dir); keychain readers
 * injected as null; no real codex/claude ever runs (rotation is injected;
 * the RPC-tier fixture token is fresh so the default runner is never hit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, parseClaudeCredentials, type CoreStore } from "../../core/src/index.ts";
import type { ClaudeRefreshResult, RefreshedClaudeToken } from "../src/claudeRefreshTransport.ts";
const granted = (token: RefreshedClaudeToken): ClaudeRefreshResult => ({ kind: "success", token });
const refused: ClaudeRefreshResult = { kind: "rejected", httpStatus: 400, error: "invalid_grant", description: "Refresh token not found or invalid" };
import { AccountsService, CLAUDE_KEYCHAIN_REPAIR_RETRY_MS, CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS, CODEX_MIN_SHIP_TTL_MS, LeaseRefusal, type EphemeralCredential } from "../src/accountsService.ts";
import { CLAUDE_REFRESH_LOCK_STALE_MS, claudeRefreshLockPaths } from "../src/claudeRefreshLock.ts";
import { loadNodeConfig, type NodeConfigFile, type ResolvedNodeConfig } from "../src/config.ts";
import { RpcError, type AccountAddResult, type AccountLeaseResult, type AuditTailResult, type DeployInfoResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const HOUR = 60 * 60 * 1000;

// Fixture refresh tokens: distinctive strings the assertions hunt for. They
// must NEVER appear in a lease, a log line, daemon output, or an audit row.
const CLAUDE_REFRESH = "FIXTURE-CLAUDE-REFRESH-TOKEN-a1b2c3";
const CLAUDE_NESTED_REFRESH = "FIXTURE-CLAUDE-NESTED-REFRESH-x9y8";
const CLAUDE_ENROLLED_REFRESH = "FIXTURE-CLAUDE-ENROLLED-REFRESH-e1n2";
const CODEX_REFRESH = "FIXTURE-CODEX-REFRESH-TOKEN-d4e5f6";
const CODEX_ROTATED_REFRESH = "FIXTURE-CODEX-ROTATED-REFRESH-g7h8";
const GROK_REFRESH = "FIXTURE-GROK-REFRESH-TOKEN-i9j0";
const KIMI_REFRESH = "FIXTURE-KIMI-REFRESH-TOKEN-k1l2";
const OPENCODE_REFRESH = "FIXTURE-OPENCODE-REFRESH-TOKEN-m3n4";
const OTHER_PROVIDER_REFRESH = "FIXTURE-OTHER-PROVIDER-REFRESH-o5p6";
const CODEX_STRAY_REFRESH = "FIXTURE-CODEX-STRAY-REFRESH-q7r8";
const CODEX_OPENAI_KEY = "FIXTURE-OPENAI-DEVELOPER-KEY-s9t0";
const ALL_FIXTURE_REFRESHES = [
  CLAUDE_REFRESH,
  CLAUDE_NESTED_REFRESH,
  CLAUDE_ENROLLED_REFRESH,
  CODEX_REFRESH,
  CODEX_ROTATED_REFRESH,
  CODEX_STRAY_REFRESH,
  GROK_REFRESH,
  KIMI_REFRESH,
  OPENCODE_REFRESH,
  OTHER_PROVIDER_REFRESH,
];

interface Rig {
  dir: string;
  store: CoreStore;
  cfg: ResolvedNodeConfig;
  log: string[];
  now: () => number;
  setNow: (t: number) => void;
  vault: string;
  homes: string;
  cleanup: () => void;
}

function rig(config: NodeConfigFile = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-lease-"));
  const vault = join(dir, "vault");
  const homes = join(dir, "homes");
  const file: NodeConfigFile = {
    ...config,
    accounts: {
      vaultDir: vault,
      homesDir: homes,
      tmuxSocket: `hb-v2-lease-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      limitsRefreshMs: 0,
      loginTimeoutMs: 15_000,
      ...(config.accounts ?? {}),
    },
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(file));
  const cfg = loadNodeConfig(dir);
  let t = Date.parse("2026-09-03T12:00:00Z");
  const now = () => t;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, ephemeral: true });
  const log: string[] = [];
  return {
    dir,
    store,
    cfg,
    log,
    now,
    setNow: (v) => {
      t = v;
    },
    vault,
    homes,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addAccount(r: Rig, harness: string, label: string, opts: { status?: "ok" | "paused" | "auth_needed"; home?: Record<string, string>; vault?: Record<string, string> } = {}) {
  const id = `${harness}-${label}`;
  const account = r.store.createAccount({ id, harness, homePath: join(r.homes, id), label, penalty: 0, status: opts.status ?? "ok" });
  for (const [root, files] of [
    [join(r.homes, id), opts.home ?? {}],
    [join(r.vault, harness, id), opts.vault ?? {}],
  ] as const) {
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
  }
  return account;
}

function service(r: Rig, extra: Partial<ConstructorParameters<typeof AccountsService>[0]> = {}): AccountsService {
  // Enrollment validates the chain with one real rotation; the default stub keeps every test off the network.
  const fetchers = { claudeRefresh: async () => (granted({ accessToken: "enrolled-access", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + 8 * HOUR })), ...(extra.fetchers ?? {}) };
  return new AccountsService({ store: r.store, cfg: r.cfg, log: (op) => r.log.push(op), now: r.now, keychainReader: async () => null, keychainWriter: async () => false, ...extra, fetchers });
}

/** An unsigned but structurally valid JWT whose `exp` claim decodes locally. */
function fakeJwt(expSeconds: number): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`;
}

function decodeFile(lease: EphemeralCredential, index = 0): Record<string, unknown> {
  const file = lease.files[index];
  assert.ok(file, `lease has a file at index ${index}`);
  return JSON.parse(Buffer.from(file.contentB64, "base64").toString("utf8")) as Record<string, unknown>;
}

/** The one non-negotiable: no fixture refresh token in the payload or the log. */
function assertNoFixtureSecrets(r: Rig, lease: EphemeralCredential): void {
  const wire = JSON.stringify(lease) + Buffer.from(lease.files.map((f) => f.contentB64).join(), "base64").toString("utf8");
  for (const secret of ALL_FIXTURE_REFRESHES) {
    assert.ok(!wire.includes(secret), `lease payload must not carry ${secret}`);
    assert.ok(!r.log.join("\n").includes(secret), `service log must not carry ${secret}`);
  }
}

async function refuses(fn: () => Promise<unknown>, code: LeaseRefusal["code"], pattern?: RegExp): Promise<void> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof LeaseRefusal, `expected LeaseRefusal, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message, pattern);
    return;
  }
  assert.fail(`expected ${code}`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

test("lease.claude.1: ships .credentials.json with DEEP, EXACT refresh blanking; access token, near-miss keys, and expiry preserved; log secret-free", async () => {
  const r = rig();
  try {
    const expiresAt = r.now() + 3 * HOUR;
    const document = {
      claudeAiOauth: {
        accessToken: "fixture-access-token",
        refreshToken: CLAUDE_REFRESH,
        expiresAt,
        refreshTokenExpiresAt: r.now() + 24 * HOUR, // near-miss KEY: a number, and not in the closed blank list — must survive
        refresher: "keep-me", // near-miss key: must survive
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
      oauthHistory: [{ refresh_token: CLAUDE_NESTED_REFRESH }], // deep: nested arrays/objects blank too
    };
    const account = addAccount(r, "claude", "a", { home: { ".credentials.json": JSON.stringify(document) } });
    const svc = service(r);
    const lease = await svc.mintLease(account);

    assert.equal(lease.files.length, 1);
    assert.equal(lease.files[0]!.homeRelPath, ".credentials.json");
    assert.equal(lease.files[0]!.mode, 0o600);
    assert.equal(lease.expiresAt, Math.floor(expiresAt / 1000));
    const shipped = decodeFile(lease);
    const oauth = shipped.claudeAiOauth as Record<string, unknown>;
    assert.equal(oauth.refreshToken, "", "refreshToken blanked to empty string, field kept");
    assert.equal(oauth.accessToken, "fixture-access-token");
    assert.equal(oauth.refreshTokenExpiresAt, document.claudeAiOauth.refreshTokenExpiresAt);
    assert.equal(oauth.refresher, "keep-me");
    assert.deepEqual(oauth.scopes, ["user:inference"]);
    assert.deepEqual((shipped.oauthHistory as Array<Record<string, unknown>>)[0], { refresh_token: "" });
    assert.match(lease.kindNote, /refresh token blanked/);
    assert.match(lease.kindNote, /ANTHROPIC_API_KEY/);
    assert.ok(r.log.some((op) => op.startsWith("account.lease account=claude-a harness=claude files=1")));
    assertNoFixtureSecrets(r, lease);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.2: an expired chain is refreshed through the daemon's own refresher first; the NEW refresh token also never ships", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "stale", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const freshExpiry = r.now() + HOUR;
    const svc = service(r, {
      fetchers: {
        claudeRefresh: async () => (granted({ accessToken: "fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: freshExpiry })),
      },
    });
    const lease = await svc.mintLease(account);
    const oauth = decodeFile(lease).claudeAiOauth as Record<string, unknown>;
    assert.equal(oauth.accessToken, "fresh-access");
    assert.equal(oauth.refreshToken, "");
    assert.equal(lease.expiresAt, Math.floor(freshExpiry / 1000));
    // The refreshed REAL chain landed in the home + vault (the refresher's
    // existing contract) — only the LEASE is blanked.
    const homeChain = JSON.parse(readFileSync(join(account.homePath, ".credentials.json"), "utf8")) as { claudeAiOauth: { refreshToken: string } };
    assert.equal(homeChain.claudeAiOauth.refreshToken, CLAUDE_NESTED_REFRESH);
    assertNoFixtureSecrets(r, lease);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.4: the 15-minute ship floor — a dying-but-not-expired token is refreshed, never re-shipped; a refresh that stays under the floor refuses", async () => {
  const r = rig();
  try {
    const dying = addAccount(r, "claude", "dying", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "dying-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + 5 * 60_000 } }) },
    });
    const freshExpiry = r.now() + 2 * HOUR;
    let refreshes = 0;
    const svc = service(r, {
      fetchers: {
        claudeRefresh: async () => {
          refreshes += 1;
          return granted({ accessToken: "floor-fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: freshExpiry });
        },
      },
    });
    const lease = await svc.mintLease(dying);
    assert.equal(refreshes, 1, "a token under the floor triggers the refresher even though it is not yet expired");
    const oauth = decodeFile(lease).claudeAiOauth as Record<string, unknown>;
    assert.equal(oauth.accessToken, "floor-fresh-access");
    assert.equal(oauth.refreshToken, "");
    assert.equal(lease.expiresAt, Math.floor(freshExpiry / 1000));
    assertNoFixtureSecrets(r, lease);

    // A refresh whose product is STILL under the floor refuses — never ship dying.
    const stuck = addAccount(r, "claude", "floorstuck", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + 5 * 60_000 } }) },
    });
    const stuckSvc = service(r, {
      fetchers: { claudeRefresh: async () => (granted({ accessToken: "still-dying", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 10 * 60_000 })) },
    });
    await refuses(() => stuckSvc.mintLease(stuck), "lease_unavailable", /15-minute ship floor/);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.3: typed refusals — no credential; near-expiry chain a live runtime still owns; failed refresh", async () => {
  const r = rig();
  try {
    const bare = addAccount(r, "claude", "bare");
    const svc = service(r);
    await refuses(() => svc.mintLease(bare), "lease_unavailable", /no claude OAuth credential/);

    const live = addAccount(r, "claude", "live", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS + 60_000 } }) },
    });
    const { bee } = r.store.createBee({ name: "owner", agent: "claude", substrate: "hsr", cwd: "/tmp", account: live.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 99, pidStartedAt: 1 });
    let raced = 0;
    const liveSvc = service(r, { fetchers: { claudeRefresh: async () => { raced += 1; return refused; } } });
    await refuses(() => liveSvc.mintLease(live), "lease_unavailable", /running Claude owns refresh/);
    assert.equal(raced, 0, "a live runtime keeps its refresh until the deferral deadline");

    const failing = addAccount(r, "claude", "failing", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const failSvc = service(r, { fetchers: { claudeRefresh: async () => refused } });
    await refuses(() => failSvc.mintLease(failing), "lease_unavailable", /refresh failed/);
  } finally {
    r.cleanup();
  }
});

const MINUTE = 60_000;

function idleClaudeAccount(r: Rig, label: string, ttlMs: number) {
  const account = addAccount(r, "claude", label, {
    home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + ttlMs, subscriptionType: "max" } }) },
  });
  const { bee } = r.store.createBee({ name: `${label}-idle`, agent: "claude", substrate: "hsr", cwd: "/tmp", account: account.id });
  r.store.updateRuntimeState(bee.id, 1, "running", { pid: 99, pidStartedAt: 1 });
  r.store.updateRuntimeState(bee.id, 1, "idle");
  return { account, bee };
}

test("lease.claude.5: an idle running Claude loses the refresh at the deferral deadline — retried mints from T-15m ship a later expiry with over 5 minutes to spare", async () => {
  const r = rig();
  try {
    const oldExpiry = r.now() + 15 * MINUTE;
    const { account, bee } = idleClaudeAccount(r, "idle", 15 * MINUTE);
    const freshExpiry = oldExpiry + 8 * HOUR;
    const locks = claudeRefreshLockPaths(account.homePath);
    let refreshes = 0;
    let locksHeldDuringRefresh = false;
    let keychain: string | null = JSON.stringify({
      claudeAiOauth: { accessToken: "old-access", refreshToken: CLAUDE_REFRESH, expiresAt: oldExpiry, subscriptionType: "max" },
      mcpOAuth: { server: "kept" },
    });
    const svc = service(r, {
      keychainReader: async () => keychain,
      keychainWriter: async (_home, raw) => { keychain = raw; return true; },
      fetchers: {
        claudeRefresh: async (token) => {
          refreshes += 1;
          assert.equal(token, CLAUDE_REFRESH);
          locksHeldDuringRefresh = existsSync(locks.current) && existsSync(locks.legacy) && existsSync(locks.storageWrite);
          return granted({ accessToken: "fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: freshExpiry });
        },
      },
    });

    let shippedAt: number | null = null;
    let lease: EphemeralCredential | null = null;
    for (let elapsed = 30_000; elapsed < 15 * MINUTE && lease === null; elapsed += 150_000) {
      r.setNow(oldExpiry - 15 * MINUTE + elapsed);
      try {
        lease = await svc.mintLease(account);
        shippedAt = r.now();
      } catch (err) {
        assert.ok(err instanceof LeaseRefusal);
        assert.match(err.message, /running Claude owns refresh/);
        assert.ok(oldExpiry - r.now() > CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS, "refusals stop at the deferral deadline");
        assert.equal(refreshes, 0);
      }
    }

    assert.ok(lease && shippedAt !== null);
    assert.equal(refreshes, 1);
    assert.ok(oldExpiry - shippedAt >= 5 * MINUTE, `shipped ${(oldExpiry - shippedAt) / MINUTE} minutes before the old expiry`);
    assert.equal(lease.expiresAt, Math.floor(freshExpiry / 1000));
    const shipped = decodeFile(lease).claudeAiOauth as Record<string, unknown>;
    assert.equal(shipped.accessToken, "fresh-access");
    assert.equal(shipped.refreshToken, "");
    assertNoFixtureSecrets(r, lease);

    assert.ok(locksHeldDuringRefresh, "the rotation ran under Claude Code's refresh locks and its storage write lock");
    assert.ok(!existsSync(locks.current) && !existsSync(locks.legacy) && !existsSync(locks.storageWrite), "every lock is released");
    for (const raw of [readFileSync(join(account.homePath, ".credentials.json"), "utf8"), readFileSync(join(svc.vaultDirOf(account), ".credentials.json"), "utf8"), keychain!]) {
      const oauth = JSON.parse(raw).claudeAiOauth;
      assert.equal(oauth.accessToken, "fresh-access");
      assert.equal(oauth.refreshToken, CLAUDE_NESTED_REFRESH, "running Claude processes read the rotated chain, not a consumed token");
      assert.equal(oauth.subscriptionType, "max");
    }
    assert.deepEqual(JSON.parse(keychain!).mcpOAuth, { server: "kept" }, "the Keychain item keeps what running Claude stored beside the OAuth chain");
    assert.equal(r.store.currentRuntime(bee.id)!.state, "idle");

    const again = await svc.mintLease(account);
    assert.equal(again.expiresAt, Math.floor(freshExpiry / 1000));
    assert.equal(refreshes, 1, "a fresh chain is not rotated again");
  } finally {
    r.cleanup();
  }
});

test("lease.claude.6: past the deadline the daemon still yields to a Claude that is refreshing or has refreshed", async () => {
  const r = rig();
  try {
    let refreshes = 0;
    const fetchers = { claudeRefresh: async () => { refreshes += 1; return granted({ accessToken: "fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 8 * HOUR }); } };

    const contended = idleClaudeAccount(r, "contended", 8 * MINUTE).account;
    const contendedLocks = claudeRefreshLockPaths(contended.homePath);
    const svc = service(r, { fetchers });
    mkdirSync(contendedLocks.current);
    await refuses(() => svc.mintLease(contended), "lease_unavailable", /holds a Claude Code credential lock/);
    assert.equal(refreshes, 0, "a refresh token is never posted while a Claude process holds the lock");
    assert.ok(existsSync(contendedLocks.current), "a live holder's lock is left alone");

    rmSync(contendedLocks.current, { recursive: true });
    mkdirSync(contendedLocks.legacy);
    await refuses(() => svc.mintLease(contended), "lease_unavailable", /holds a Claude Code credential lock/);
    assert.equal(refreshes, 0);
    assert.ok(!existsSync(contendedLocks.current), "the current lock is released when an older Claude holds the legacy one");

    rmSync(contendedLocks.legacy, { recursive: true });
    mkdirSync(contendedLocks.storageWrite);
    await refuses(() => svc.mintLease(contended), "lease_unavailable", /holds a Claude Code credential lock/);
    assert.equal(refreshes, 0, "a Claude rewriting its Keychain item is never raced");
    assert.ok(!existsSync(contendedLocks.current) && !existsSync(contendedLocks.legacy), "the refresh locks are released when the storage write lock is held");
    rmSync(contendedLocks.storageWrite, { recursive: true });
    mkdirSync(contendedLocks.legacy);

    const abandoned = new Date(Date.now() - CLAUDE_REFRESH_LOCK_STALE_MS - 5_000);
    utimesSync(contendedLocks.legacy, abandoned, abandoned);
    mkdirSync(contendedLocks.current);
    utimesSync(contendedLocks.current, abandoned, abandoned);
    const lease = await svc.mintLease(contended);
    assert.equal(refreshes, 1, "a lock abandoned by a dead holder does not strand the account");
    assert.equal((decodeFile(lease).claudeAiOauth as Record<string, unknown>).accessToken, "fresh-access");
    assert.ok(!existsSync(contendedLocks.current) && !existsSync(contendedLocks.legacy));

    const sibling = idleClaudeAccount(r, "sibling", 8 * MINUTE).account;
    const siblingExpiry = r.now() + 8 * HOUR;
    const siblingSvc = service(r, {
      fetchers,
      keychainReader: async () => JSON.stringify({ claudeAiOauth: { accessToken: "claude-refreshed", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: siblingExpiry } }),
    });
    const adopted = await siblingSvc.mintLease(sibling);
    assert.equal(refreshes, 1, "a chain a running Claude already rotated is shipped, not rotated again");
    assert.equal((decodeFile(adopted).claudeAiOauth as Record<string, unknown>).accessToken, "claude-refreshed");
    assertNoFixtureSecrets(r, adopted);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.7: the daemon does not rotate under a running Claude when it cannot publish to the Keychain that Claude reads", async () => {
  const r = rig();
  try {
    const { account } = idleClaudeAccount(r, "locked-keychain", 8 * MINUTE);
    let refreshes = 0;
    let keychainState: "unreadable" | "present" = "unreadable";
    const keychainRaw = JSON.stringify({ claudeAiOauth: { accessToken: "keychain-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 9 * MINUTE } });
    const posted: string[] = [];
    const svc = service(r, {
      keychainStateReader: async () => keychainState === "present" ? { status: "present", raw: keychainRaw } : { status: "unreadable" },
      keychainWriter: async () => true,
      fetchers: { claudeRefresh: async (token) => { refreshes += 1; posted.push(token); return refused; } },
    });
    await refuses(() => svc.mintLease(account), "lease_unavailable", /Keychain is unreadable/);
    assert.equal(refreshes, 0);
    keychainState = "present";
    await refuses(() => svc.mintLease(account), "lease_unavailable", /refresh failed/);
    assert.deepEqual(posted, [CLAUDE_NESTED_REFRESH], "the Keychain's newer chain is posted, never the home file's consumed token, even when the legacy reader sees nothing");
    posted.length = 0;
    const locks = claudeRefreshLockPaths(account.homePath);
    assert.ok(!existsSync(locks.current) && !existsSync(locks.legacy));
    assert.ok(statSync(join(account.homePath, ".credentials.json")).isFile());
    assert.ok(readFileSync(join(account.homePath, ".credentials.json"), "utf8").includes(CLAUDE_REFRESH), "the chain is untouched");
  } finally {
    r.cleanup();
  }
});

test("lease.claude.8: a rotated chain the Keychain refused is re-published until running Claudes can read it", async () => {
  const r = rig();
  try {
    const { account } = idleClaudeAccount(r, "degraded", 8 * MINUTE);
    const freshExpiry = r.now() + 8 * HOUR;
    let keychain = JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + 8 * MINUTE }, mcpOAuth: { server: "kept" } });
    let keychainAccepts = false;
    let writes = 0;
    const svc = service(r, {
      keychainStateReader: async () => ({ status: "present", raw: keychain }),
      keychainWriter: async (_home, raw) => {
        writes += 1;
        if (keychainAccepts) keychain = raw;
        return keychainAccepts;
      },
      fetchers: { claudeRefresh: async () => (granted({ accessToken: "fresh-access", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: freshExpiry })) },
    });
    const lease = await svc.mintLease(account);
    assert.equal(lease.expiresAt, Math.floor(freshExpiry / 1000));
    assert.equal(writes, 3);
    assert.ok(r.log.includes(`account.refresh.keychain_degraded account=${account.id} running_claude=true`));
    assert.equal(JSON.parse(keychain).claudeAiOauth.refreshToken, CLAUDE_REFRESH, "the Keychain still holds the consumed chain");

    assert.equal(svc.claudeKeychainRepairTick(), null, "nothing is re-published before the retry interval");
    r.setNow(r.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
    await svc.claudeKeychainRepairTick();
    assert.equal(writes, 4, "a refused re-publish is retried later");

    keychain = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 }, mcpOAuth: { server: "kept" } });
    keychainAccepts = true;
    const home = join(account.homePath, ".credentials.json");
    const before = new Date(Date.now() - 60_000);
    utimesSync(home, before, before);
    r.setNow(r.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
    await svc.claudeKeychainRepairTick();
    const published = JSON.parse(keychain);
    assert.equal(published.claudeAiOauth.accessToken, "fresh-access", "a Keychain a Claude already cleared after posting the consumed token is healed");
    assert.equal(published.claudeAiOauth.refreshToken, CLAUDE_NESTED_REFRESH);
    assert.deepEqual(published.mcpOAuth, { server: "kept" });
    assert.ok(statSync(home).mtimeMs > before.getTime(), "the home file is rewritten so running Claudes re-read the Keychain");
    assert.ok(r.log.includes(`account.refresh.keychain_repaired account=${account.id}`));
    const locks = claudeRefreshLockPaths(account.homePath);
    assert.ok(!existsSync(locks.current) && !existsSync(locks.legacy) && !existsSync(locks.storageWrite));

    r.setNow(r.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
    assert.equal(svc.claudeKeychainRepairTick(), null, "a repaired account is not re-published again");
    assert.equal(writes, 5);

    const sibling = idleClaudeAccount(r, "sibling-refreshed", 8 * MINUTE).account;
    keychainAccepts = false;
    keychain = JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + 8 * MINUTE } });
    await svc.mintLease(sibling);
    assert.equal(writes, 8);
    keychain = JSON.stringify({ claudeAiOauth: { accessToken: "claude-refreshed", refreshToken: "FIXTURE-CLAUDE-SIBLING-REFRESH", expiresAt: freshExpiry + HOUR } });
    keychainAccepts = true;
    r.setNow(r.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
    await svc.claudeKeychainRepairTick();
    assert.equal(writes, 8, "a chain a running Claude rotated after the daemon is never overwritten");
    assert.equal(JSON.parse(keychain).claudeAiOauth.accessToken, "claude-refreshed");
    r.setNow(r.now() + CLAUDE_KEYCHAIN_REPAIR_RETRY_MS);
    assert.equal(svc.claudeKeychainRepairTick(), null);
  } finally {
    r.cleanup();
  }
});

test("lease.claude.9: with no Claude running the daemon still rotates only from a readable Keychain", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "unreadable", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    let refreshes = 0;
    const svc = service(r, {
      keychainStateReader: async () => ({ status: "unreadable" }),
      fetchers: { claudeRefresh: async () => { refreshes += 1; return refused; } },
    });
    await refuses(() => svc.mintLease(account), "lease_unavailable", /Keychain is unreadable/);
    assert.equal(refreshes, 0, "the home file's possibly consumed refresh token is never posted");
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

test("lease.codex.1: ships access+id token with refresh_token blanked (field KEPT); blanking is DEEP (stray refresh keys outside tokens too); a subscription lease's OPENAI_API_KEY is blanked", async () => {
  const r = rig();
  try {
    const exp = Math.floor(r.now() / 1000) + 8 * 24 * 3600;
    const account = addAccount(r, "codex", "cx", {
      vault: {
        "auth.json": JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: CODEX_OPENAI_KEY,
          tokens: { id_token: "fixture-id-token", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct-1" },
          last_refresh: "2026-09-01T00:00:00Z",
          // A refresh key OUTSIDE tokens: the deep blank must catch it — the
          // old hand-blank of tokens.refresh_token alone would ship it.
          backup: { refresh_token: CODEX_STRAY_REFRESH },
        }),
      },
    });
    const svc = service(r, { codexLeaseRefresh: async () => assert.fail("a fresh token must not trigger rotation") });
    const lease = await svc.mintLease(account);
    assert.equal(lease.files[0]!.homeRelPath, "auth.json");
    assert.equal(lease.files[0]!.mode, 0o600);
    assert.equal(lease.expiresAt, exp);
    const shipped = decodeFile(lease);
    const tokens = shipped.tokens as Record<string, unknown>;
    assert.equal(tokens.refresh_token, "", "refresh_token blanked, field kept (codex serde requires it present)");
    assert.equal(tokens.id_token, "fixture-id-token");
    assert.equal(tokens.access_token, fakeJwt(exp));
    assert.equal(tokens.account_id, "acct-1");
    assert.equal(shipped.auth_mode, "chatgpt");
    assert.equal(shipped.last_refresh, "2026-09-01T00:00:00Z");
    assert.deepEqual(shipped.backup, { refresh_token: "" }, "deep blank reaches refresh keys outside tokens");
    assert.equal(shipped.OPENAI_API_KEY, null, "a ChatGPT-mode lease never smuggles a billable developer key");
    const wire = Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8");
    assert.ok(!wire.includes(CODEX_OPENAI_KEY));
    assertNoFixtureSecrets(r, lease);

    // API-key mode: that billing is the account's intent — the key ships.
    const keyed = addAccount(r, "codex", "keyed", {
      vault: {
        "auth.json": JSON.stringify({
          auth_mode: "apikey",
          OPENAI_API_KEY: CODEX_OPENAI_KEY,
          tokens: { id_token: "id", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct-2" },
        }),
      },
    });
    const keyedLease = await service(r).mintLease(keyed);
    assert.equal(decodeFile(keyedLease).OPENAI_API_KEY, CODEX_OPENAI_KEY, "an API-key-mode lease keeps its key");
  } finally {
    r.cleanup();
  }
});

test("lease.codex.3: a shipped file always carries refresh_token — present as \"\" even when the source file lacks the field (codex serde hard-fails without it)", async () => {
  const r = rig();
  try {
    const exp = Math.floor(r.now() / 1000) + 8 * 24 * 3600;
    const account = addAccount(r, "codex", "nofield", {
      vault: { "auth.json": JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(exp), account_id: "a" } }) },
    });
    const lease = await service(r).mintLease(account);
    const tokens = decodeFile(lease).tokens as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(tokens, "refresh_token"));
    assert.equal(tokens.refresh_token, "");
  } finally {
    r.cleanup();
  }
});

test("lease.codex.2: a near-expiry token triggers the central rotation and harvests home → vault; a rotation that stays stale is a typed TTL refusal", async () => {
  const r = rig();
  try {
    const staleExp = Math.floor((r.now() + CODEX_MIN_SHIP_TTL_MS / 2) / 1000); // 7.5 min left — under the ship floor
    const staleAuth = JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(staleExp), refresh_token: CODEX_REFRESH, account_id: "a" } });

    // 2a. rotation succeeds: the injected runner plays codex rotating auth.json in place in the HOME.
    const account = addAccount(r, "codex", "rot", { home: { "auth.json": staleAuth } });
    const rotatedExp = Math.floor(r.now() / 1000) + 10 * 24 * 3600;
    let rotations = 0;
    const svc = service(r, {
      codexLeaseRefresh: async (homePath) => {
        rotations += 1;
        assert.equal(homePath, account.homePath, "rotation runs against the account's OWN home");
        writeFileSync(join(homePath, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(rotatedExp), refresh_token: CODEX_ROTATED_REFRESH, account_id: "a" } }));
      },
    });
    const lease = await svc.mintLease(account);
    assert.equal(rotations, 1);
    assert.equal(lease.expiresAt, rotatedExp);
    assert.equal((decodeFile(lease).tokens as Record<string, unknown>).refresh_token, "");
    // The rotated REAL chain was harvested into the vault (the vault stays current).
    const vaultAuth = JSON.parse(readFileSync(join(r.vault, "codex", account.id, "auth.json"), "utf8")) as { tokens: { access_token: string } };
    assert.equal(vaultAuth.tokens.access_token, fakeJwt(rotatedExp));
    assertNoFixtureSecrets(r, lease);

    // 2b. rotation that does NOT freshen: refuse — never ship a stale token.
    const stuck = addAccount(r, "codex", "stuck", { home: { "auth.json": staleAuth } });
    let stuckRotations = 0;
    const stuckSvc = service(r, { codexLeaseRefresh: async () => { stuckRotations += 1; } });
    await refuses(() => stuckSvc.mintLease(stuck), "lease_unavailable", /did not produce a fresh access token/);
    assert.equal(stuckRotations, 1, "the rotation was attempted before refusing");

    // 2c. near-expiry with a LIVE runtime: the home is owned — typed refusal, no rotation attempt.
    const owned = addAccount(r, "codex", "owned", { home: { "auth.json": staleAuth } });
    const { bee } = r.store.createBee({ name: "codex-owner", agent: "codex", substrate: "hsr", cwd: "/tmp", account: owned.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 42, pidStartedAt: 1 });
    const ownedSvc = service(r, { codexLeaseRefresh: async () => assert.fail("a live runtime's home is never raced") });
    await refuses(() => ownedSvc.mintLease(owned), "lease_unavailable", /live runtime owns the home/);

    // 2d. no decodable token anywhere.
    const bare = addAccount(r, "codex", "bare", { home: { "auth.json": JSON.stringify({ tokens: { access_token: "not-a-jwt", refresh_token: CODEX_REFRESH } }) } });
    await refuses(() => service(r).mintLease(bare), "lease_unavailable", /no codex auth\.json with a decodable access token/);

    // 2e. TOCTOU: a runtime that starts DURING the (long) rotation turn owns
    // the home — the mint refuses after the turn and never harvests.
    const raced = addAccount(r, "codex", "raced", { home: { "auth.json": staleAuth } });
    const racedSvc = service(r, {
      codexLeaseRefresh: async () => {
        const { bee } = r.store.createBee({ name: "raced-owner", agent: "codex", substrate: "hsr", cwd: "/tmp", account: raced.id });
        r.store.updateRuntimeState(bee.id, 1, "running", { pid: 77, pidStartedAt: 1 });
        writeFileSync(join(raced.homePath, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(rotatedExp), refresh_token: CODEX_ROTATED_REFRESH, account_id: "a" } }));
      },
    });
    await refuses(() => racedSvc.mintLease(raced), "lease_unavailable", /during the token rotation/);
    assert.ok(!existsSync(join(r.vault, "codex", raced.id, "auth.json")), "the owned home is never harvested");
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// grok / kimi / opencode
// ---------------------------------------------------------------------------

test("lease.grok.1: every issuer::client entry's refresh_token blanked; cached keys preserved; expiresAt = the soonest entry expiry; kindNote carries the XAI_API_KEY scrub rule", async () => {
  const r = rig();
  try {
    const soonest = r.now() + 6 * HOUR;
    const account = addAccount(r, "grok", "g", {
      home: {
        "auth.json": JSON.stringify({
          // Live grok files carry ISO-string expiries.
          "https://auth.x.ai::client-1": { key: "cached-oauth-key-1", refresh_token: GROK_REFRESH, expires_at: new Date(r.now() + 12 * HOUR).toISOString() },
          "https://auth.x.ai::client-2": { key: "cached-oauth-key-2", refresh_token: GROK_REFRESH, expires_at: new Date(soonest).toISOString() },
          "https://auth.x.ai::client-3": { key: "cached-oauth-key-3", refresh_token: GROK_REFRESH },
        }),
      },
    });
    const lease = await service(r).mintLease(account);
    const shipped = decodeFile(lease);
    for (const entry of Object.values(shipped) as Array<Record<string, unknown>>) {
      assert.equal(entry.refresh_token, "");
      assert.match(String(entry.key), /^cached-oauth-key-/);
    }
    assert.equal(lease.expiresAt, Math.floor(soonest / 1000), "the soonest-dying entry bounds the lease");
    assert.match(lease.kindNote, /XAI_API_KEY/);
    assertNoFixtureSecrets(r, lease);
  } finally {
    r.cleanup();
  }
});

test("lease.kimi.1: API-key lease ships (refresh blanked); an OAuth-only account is a durable lease_unsupported refusal", async () => {
  const r = rig();
  try {
    const keyed = addAccount(r, "kimi", "key", {
      home: { "credentials/kimi-code.json": JSON.stringify({ api_key: "sk-kimi-fixture", access_token: "short-lived", refresh_token: KIMI_REFRESH, expires_at: 1 }) },
    });
    const lease = await service(r).mintLease(keyed);
    assert.equal(lease.files[0]!.homeRelPath, "credentials/kimi-code.json");
    const shipped = decodeFile(lease);
    assert.equal(shipped.api_key, "sk-kimi-fixture");
    assert.equal(shipped.refresh_token, "");
    assert.match(lease.kindNote, /API-key lease/);
    assertNoFixtureSecrets(r, lease);

    const oauthOnly = addAccount(r, "kimi", "oauth", {
      home: { "credentials/kimi-code.json": JSON.stringify({ access_token: "short-lived", refresh_token: KIMI_REFRESH, expires_at: 1 }) },
    });
    await refuses(() => service(r).mintLease(oauthOnly), "lease_unsupported", /OAuth-only/);
  } finally {
    r.cleanup();
  }
});

test("lease.opencode.1: single coding-plan provider filtered out of the multi-provider auth.json; other providers DROPPED, not blanked; none → lease_unsupported", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "opencode", "glm", {
      home: {
        "xdg-data/opencode/auth.json": JSON.stringify({
          "zai-coding-plan": { type: "api", key: "glm-coding-key", refresh: OPENCODE_REFRESH },
          anthropic: { type: "oauth", access: "other-access", refresh: OTHER_PROVIDER_REFRESH },
        }),
      },
    });
    const lease = await service(r).mintLease(account);
    assert.equal(lease.files[0]!.homeRelPath, "xdg-data/opencode/auth.json");
    const shipped = decodeFile(lease);
    assert.deepEqual(Object.keys(shipped), ["zai-coding-plan"], "every other provider's credential is dropped");
    assert.deepEqual(shipped["zai-coding-plan"], { type: "api", key: "glm-coding-key", refresh: "" });
    assert.match(lease.kindNote, /zai-coding-plan/);
    assertNoFixtureSecrets(r, lease);

    const noPlan = addAccount(r, "opencode", "noplan", {
      home: { "xdg-data/opencode/auth.json": JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: OTHER_PROVIDER_REFRESH } }) },
    });
    await refuses(() => service(r).mintLease(noPlan), "lease_unsupported", /no leasable coding-plan provider/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// concurrency + strategy gaps
// ---------------------------------------------------------------------------

test("lease.flight.1: concurrent mints for one account JOIN a single mint (the rotation runs once)", async () => {
  const r = rig();
  try {
    const staleExp = Math.floor((r.now() + CODEX_MIN_SHIP_TTL_MS / 2) / 1000);
    const account = addAccount(r, "codex", "join", {
      home: { "auth.json": JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(staleExp), refresh_token: CODEX_REFRESH, account_id: "a" } }) },
    });
    const gate = deferred<void>();
    const rotatedExp = Math.floor(r.now() / 1000) + 10 * 24 * 3600;
    let rotations = 0;
    const svc = service(r, {
      codexLeaseRefresh: async (homePath) => {
        rotations += 1;
        await gate.promise;
        writeFileSync(join(homePath, "auth.json"), JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(rotatedExp), refresh_token: CODEX_ROTATED_REFRESH, account_id: "a" } }));
      },
    });
    const first = svc.mintLease(account);
    const second = svc.mintLease(account);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(rotations, 1, "concurrent callers join one mint");
    assert.deepEqual(a, b);
    assertNoFixtureSecrets(r, a);
  } finally {
    r.cleanup();
  }
});

test("lease.flight.2: refused while the account's refresher is mid-rotation", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "busy", {
      home: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() - 1 } }) },
    });
    const gate = deferred<ClaudeRefreshResult>();
    const svc = service(r, {
      fetchers: {
        claudeUsage: async () => ({}) as never,
        claudeRefresh: () => gate.promise,
      },
    });
    // The limits probe finds the chain expired and enters the single-flight
    // refresher, which now hangs on the gate — the mint must refuse, not join.
    const probing = svc.refreshLimits([account.id]);
    await waitFor(() => svc.refreshBusy(account), "claude refresher mid-rotation");
    await refuses(() => svc.mintLease(account), "lease_unavailable", /mid-rotation/);
    gate.resolve(refused);
    await probing;

    // A codex app-server probe may rotate auth.json in place — an in-flight
    // codex limits fetch is mid-rotation too (keyed by the account's HOME).
    const exp = Math.floor(r.now() / 1000) + 8 * 24 * 3600;
    const codex = addAccount(r, "codex", "probing", {
      home: { "auth.json": JSON.stringify({ tokens: { id_token: "id", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "a" } }) },
    });
    const codexGate = deferred<{ ok: false; unreadableReason: "timeout"; error: string }>();
    const codexSvc = service(r, { fetchers: { codexRateLimits: () => codexGate.promise } });
    const codexProbing = codexSvc.refreshLimits([codex.id]);
    await waitFor(() => codexSvc.refreshBusy(codex), "codex probe mid-flight");
    await refuses(() => codexSvc.mintLease(codex), "lease_unavailable", /mid-rotation/);
    codexGate.resolve({ ok: false, unreadableReason: "timeout", error: "test gate" });
    await codexProbing;
  } finally {
    r.cleanup();
  }
});

test("lease.strategy.1: harnesses without a lease strategy are a durable typed refusal", async () => {
  const r = rig();
  try {
    const cursor = addAccount(r, "cursor", "c");
    await refuses(() => service(r).mintLease(cursor), "lease_unsupported", /no credential-lease strategy/);
    const stub = addAccount(r, "stub", "s");
    await refuses(() => service(r).mintLease(stub), "lease_unsupported", /no credential-lease strategy/);
  } finally {
    r.cleanup();
  }
});

// ---------------------------------------------------------------------------
// RPC tier — a real daemon over a temp socket
// ---------------------------------------------------------------------------

test("rpc.lease.1: account.lease verb — result shape, typed errors, capability tag, and no secret bytes in daemon output or the audit stream", async () => {
  const { dir, cleanup } = makeDaemonDir();
  let daemon: DaemonHandle | null = null;
  try {
    daemon = await startDaemon(dir);
    const client = await daemon.client();

    const info = await client.request<DeployInfoResult>("deployInfo");
    assert.ok(info.capabilities.includes("account.lease.v1"), "the hello/deployInfo capability list gates the verb");

    // No lease strategy (stub) → lease_unsupported over the wire.
    await client.request<AccountAddResult>("account.add", { harness: "stub", label: "s" });
    await assert.rejects(client.request("account.lease", { account: "stub-s" }), (err: unknown) => err instanceof RpcError && err.code === "lease_unsupported");

    // A codex account whose vault holds the fixture credential (fresh token —
    // the daemon's REAL rotation runner is never triggered).
    await client.request<AccountAddResult>("account.add", { harness: "codex", label: "lx" });
    const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
    const vaultDir = join(dir, "vault", "codex", "codex-lx");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "auth.json"), JSON.stringify({ tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct" } }));

    const lease = await client.request<AccountLeaseResult>("account.lease", { account: "codex-lx" });
    assert.equal(lease.account, "codex-lx");
    assert.equal(lease.harness, "codex");
    assert.equal(lease.files.length, 1);
    assert.equal(lease.files[0]!.homeRelPath, "auth.json");
    assert.equal(lease.files[0]!.mode, 0o600);
    assert.equal(lease.expiresAt, exp);
    const shipped = JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8")) as { tokens: Record<string, unknown> };
    assert.equal(shipped.tokens.refresh_token, "");
    assert.equal(shipped.tokens.access_token, fakeJwt(exp));

    // Typed errors: unknown selector, harness mismatch, paused account.
    await assert.rejects(client.request("account.lease", { account: "nope" }), (err: unknown) => err instanceof RpcError && err.code === "account_not_found");
    await assert.rejects(client.request("account.lease", { account: "codex-lx", harness: "claude" }), (err: unknown) => err instanceof RpcError && err.code === "harness_mismatch");
    await client.request("account.pause", { id: "codex-lx" });
    await assert.rejects(client.request("account.lease", { account: "codex-lx" }), (err: unknown) => err instanceof RpcError && err.code === "account_paused");

    // The verb result is the ONLY place secret bytes appear: neither the
    // fixture refresh token nor the shipped access token may reach the
    // daemon's output/log or the audit stream.
    const audit = await client.request<AuditTailResult>("audit.tail", { limit: 1000 });
    for (const haystack of [JSON.stringify(audit.rows), daemon.output()]) {
      assert.ok(!haystack.includes(CODEX_REFRESH), "refresh token never leaves the mint");
      assert.ok(!haystack.includes(fakeJwt(exp)), "access token appears only in the verb result");
    }
    client.close();
  } finally {
    if (daemon) await daemon.stop();
    cleanup();
  }
});

// Central credentials: exercise the real service/lease seam, never live credentials.
// Enrollment adopts the native chain, validates it with one real rotation
// (generation 1 -> 2) and only then publishes access-only copies.
function nativeDocument(r: Rig, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: "before", refreshToken: CLAUDE_REFRESH, expiresAt: r.now() + HOUR, ...extra } });
}
function nativeCopies(r: Rig, svc: AccountsService, account: { homePath: string; harness: string; id: string }): string[] {
  return [join(account.homePath, ".credentials.json"), join(svc.vaultDirOf(account), ".credentials.json")]
    .filter(path => existsSync(path)).map(path => readFileSync(path, "utf8"));
}

test("central.claude: idle local runtime does not block rotation; leases and runtime copies never carry refresh tokens", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "central", { home: { ".credentials.json": nativeDocument(r) } });
    let keychain: string | null = null;
    const tokens: string[] = [];
    const svc = service(r, { keychainReader: async () => keychain, keychainWriter: async (_home, raw) => { keychain = raw; return true; },
      fetchers: { claudeRefresh: async token => {
        tokens.push(token);
        return tokens.length === 1
          ? granted({ accessToken: "enrolled", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + HOUR })
          : granted({ accessToken: "after", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 8 * HOUR });
      } } });
    assert.equal((await svc.centralCredentials.enable(account)).generation, 2, "adoption is generation 1; the validating rotation is generation 2");
    assert.deepEqual(tokens, [CLAUDE_REFRESH]);
    assert.equal(JSON.parse(keychain!).claudeAiOauth.refreshToken, "");
    const { bee } = r.store.createBee({ name: "local-owner", agent: "claude", substrate: "hsr", cwd: "/tmp", account: account.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 99, pidStartedAt: 1 });
    r.store.updateRuntimeState(bee.id, 1, "idle");
    r.setNow(r.now() + HOUR - 60_000);
    const lease = await svc.mintLease(account);
    assert.deepEqual(tokens, [CLAUDE_REFRESH, CLAUDE_ENROLLED_REFRESH], "each rotation consumes the chain the authority owns");
    assert.equal((decodeFile(lease).claudeAiOauth as Record<string, unknown>).accessToken, "after");
    assertNoFixtureSecrets(r, lease);
    for (const raw of nativeCopies(r, svc, account)) {
      assert.ok(!raw.includes(CLAUDE_REFRESH) && !raw.includes(CLAUDE_ENROLLED_REFRESH) && !raw.includes(CLAUDE_NESTED_REFRESH));
    }
    assert.equal(JSON.parse(keychain!).claudeAiOauth.refreshToken, "");
    assert.equal(r.store.currentRuntime(bee.id)!.state, "idle");
    assert.equal(svc.homeEnvOf(account).CLAUDE_CODE_OAUTH_TOKEN, "");
    assert.equal(svc.centralCredentials.status(account)!.generation, 3);
  } finally { r.cleanup(); }
});

test("central.claude: enrollment refuses idle runtimes, and existing accounts retain their behavior", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "busy", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0;
    const svc = service(r, { fetchers: { claudeRefresh: async () => { refreshes++; return refused; } } });
    const { bee } = r.store.createBee({ name: "existing", agent: "claude", substrate: "hsr", cwd: "/tmp", account: account.id });
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 99, pidStartedAt: 1 });
    r.store.updateRuntimeState(bee.id, 1, "idle");
    await assert.rejects(svc.centralCredentials.enable(account), /Stop this account/);
    assert.equal(svc.centralCredentials.enabled(account), false);
    assert.equal(refreshes, 0);
    assert.ok(readFileSync(join(account.homePath, ".credentials.json"), "utf8").includes(CLAUDE_REFRESH));
    r.setNow(r.now() + HOUR - CLAUDE_REFRESH_DEFERRAL_DEADLINE_MS - 60_000);
    await refuses(() => svc.mintLease(account), "lease_unavailable", /running Claude owns refresh/);
  } finally { r.cleanup(); }
});

test("central.claude: an expired candidate is refused before any state change; native copies stay intact (#12)", async () => {
  const r = rig();
  try {
    const native = nativeDocument(r, { expiresAt: r.now() - 1 });
    const account = addAccount(r, "claude", "expired", { home: { ".credentials.json": native }, vault: { ".credentials.json": native } });
    let refreshes = 0; let keychainWrites = 0;
    const svc = service(r, { keychainReader: async () => native, keychainWriter: async () => { keychainWrites++; return true; },
      fetchers: { claudeRefresh: async () => { refreshes++; return granted({ accessToken: "x", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + HOUR }); } } });
    await assert.rejects(svc.centralCredentials.enable(account), error => {
      assert.match((error as Error).message, /expired at 2026-09-03T11:59:59\.999Z; log in natively \(hive account login claude-expired\)/);
      assert.ok(!(error as Error).message.includes(CLAUDE_REFRESH));
      return true;
    });
    assert.equal(refreshes, 0, "no provider call: the possibly dead chain is never consumed by enrollment");
    assert.equal(keychainWrites, 0);
    assert.equal(svc.centralCredentials.status(account), null, "no authority row");
    assert.equal(existsSync(join(r.vault, ".credential-authorities", `${account.id}.json`)), false, "no authority document");
    assert.deepEqual(nativeCopies(r, svc, account), [native, native]);
    assert.equal(r.store.getAccount(account.id)!.status, "ok");
    // The native path still owns the account: a lease refreshes natively as before.
    const lease = await svc.mintLease(account);
    assert.equal(refreshes, 1);
    assert.equal((decodeFile(lease).claudeAiOauth as Record<string, unknown>).refreshToken, "");
    assert.ok(readFileSync(join(account.homePath, ".credentials.json"), "utf8").includes(CLAUDE_NESTED_REFRESH), "native refresh keeps the full chain");
  } finally { r.cleanup(); }
});

test("central.claude: a provider rejection during enrollment aborts with native copies intact and no access-only publication (#12)", async () => {
  const r = rig();
  try {
    const native = nativeDocument(r);
    const account = addAccount(r, "claude", "rejected", { home: { ".credentials.json": native }, vault: { ".credentials.json": native } });
    let keychainWrites = 0;
    const svc = service(r, { keychainReader: async () => native, keychainWriter: async () => { keychainWrites++; return true; },
      fetchers: { claudeRefresh: async () => refused } });
    await assert.rejects(svc.centralCredentials.enable(account), /provider refused this account's refresh credential \(HTTP 400 invalid_grant: Refresh token not found or invalid\); native copies are unchanged/);
    assert.equal(keychainWrites, 0);
    assert.deepEqual(nativeCopies(r, svc, account), [native, native], "refresh tokens were never stripped");
    assert.equal(svc.centralCredentials.status(account)!.phase, "disabled");
    assert.equal(svc.centralCredentials.enabled(account), false);
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed");
    assert.match(r.store.getAccount(account.id)!.statusReason!, /HTTP 400 invalid_grant/);
    assert.ok(r.log.some(op => op.startsWith(`account.credentials.refresh account=${account.id} during=enroll generation=1 outcome=rejected`)));
    assert.ok(!r.log.join("\n").includes(CLAUDE_REFRESH));
    // Nothing is fenced: capture and a later enable both run against the native copies.
    await assert.rejects(svc.centralCredentials.enable(account), /provider refused/);
    assert.deepEqual(nativeCopies(r, svc, account), [native, native]);
  } finally { r.cleanup(); }
});

test("central.claude: a lost provider response during enrollment is retried after backoff; a consumed token ends in login_required (#12)", async () => {
  const r = rig();
  try {
    const native = nativeDocument(r);
    const account = addAccount(r, "claude", "lost", { home: { ".credentials.json": native }, vault: { ".credentials.json": native } });
    let refreshes = 0; let keychain: string = native; let lost = true;
    const svc = service(r, { keychainReader: async () => keychain, keychainWriter: async (_home, raw) => { keychain = raw; return true; },
      fetchers: { claudeRefresh: async () => { refreshes++; if (lost) throw new Error("connection lost"); return refused; } } });
    await assert.rejects(svc.centralCredentials.enable(account), /enrollment refresh outcome is unknown/);
    assert.equal(refreshes, 1);
    const unknown = svc.centralCredentials.status(account)!;
    assert.equal(unknown.phase, "uncertain");
    assert.deepEqual(unknown.failure, { outcome: "unknown_outcome", httpStatus: null, error: null, description: "connection lost", at: r.now(), attempts: 1, retryAt: r.now() + 30_000 });
    assert.deepEqual(nativeCopies(r, svc, account), [native, native], "nothing was published while the outcome is unknown");
    // Fenced until the backoff passes: nothing presents the token again early, and native paths stay closed.
    await refuses(() => svc.mintLease(account), "lease_unavailable", /next attempt at/);
    await assert.rejects(svc.centralCredentials.enable(account), /incomplete refresh/);
    await assert.rejects(svc.captureAccount(account), /Disable central credentials/);
    assert.equal(svc.centralCredentials.retryDue(account), false);
    assert.equal(refreshes, 1);
    r.setNow(r.now() + 30_000);
    assert.equal(svc.centralCredentials.retryDue(account), true);
    lost = false; // The first request did reach the provider: the consumed token now answers invalid_grant.
    await refuses(() => svc.mintLease(account), "credential_login_required", /Claude login required for claude-lost: the provider refused the refresh token \(HTTP 400 invalid_grant: Refresh token not found or invalid\)/);
    assert.equal(refreshes, 2);
    const terminal = svc.centralCredentials.status(account)!;
    assert.equal(terminal.phase, "login_required");
    assert.equal(terminal.failure?.outcome, "rejected");
    assert.equal(terminal.failure?.attempts, 2);
    assert.equal(terminal.failure?.retryAt, null);
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed");
    assert.match(r.store.getAccount(account.id)!.statusReason!, /hive account credentials disable claude-lost; hive account login claude-lost; hive account credentials enable claude-lost/);
    await refuses(() => svc.mintLease(account), "credential_login_required");
    await assert.rejects(svc.centralCredentials.ensure(account, 0, "operator-retry"), /Claude login required/);
    assert.equal(svc.centralCredentials.retryDue(account), false);
    assert.equal(refreshes, 2, "a refused token is never presented again");
    const restarted = service(r, { keychainReader: async () => keychain, keychainWriter: async (_home, raw) => { keychain = raw; return true; },
      fetchers: { claudeRefresh: async () => { refreshes++; throw new Error("still lost"); } } });
    await assert.rejects(restarted.centralCredentials.enable(account), /Claude login required/);
    assert.equal((await restarted.centralCredentials.disable(account)).phase, "disabled");
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed");
    for (const raw of [...nativeCopies(r, svc, account), keychain]) {
      assert.equal(JSON.parse(raw).claudeAiOauth.refreshToken, "", "disable publishes access-only copies so native refresh cannot retry the token");
    }
    assert.equal(refreshes, 2);
    assert.ok(!r.log.join("\n").includes(CLAUDE_REFRESH));
  } finally { r.cleanup(); }
});

test("central.claude: an enrollment interrupted mid-rotation is uncertain on resume and resolves on the next refresh (#12)", async () => {
  const r = rig();
  try {
    const native = nativeDocument(r);
    const account = addAccount(r, "claude", "interrupted", { home: { ".credentials.json": native } });
    let die!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => { die = reject; });
    let refreshes = 0;
    const first = service(r, { fetchers: { claudeRefresh: async () => { refreshes++; return gate; } } });
    const inFlight = first.centralCredentials.enable(account);
    await waitFor(() => refreshes === 1, "validating rotation started");
    assert.equal(first.centralCredentials.status(account)!.phase, "enrolling");
    assert.notEqual(first.centralCredentials.status(account)!.operationKey, null, "the in-flight rotation is fenced durably");
    // A successor daemon finds the fence but no saved result.
    const successor = service(r, { fetchers: { claudeRefresh: async () => { refreshes++; return granted({ accessToken: "x", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + HOUR }); } } });
    await assert.rejects(successor.centralCredentials.enable(account), /enrollment refresh was interrupted and its outcome is unknown/);
    assert.equal(successor.centralCredentials.status(account)!.phase, "uncertain");
    assert.equal(successor.centralCredentials.retryDue(account), true, "a process death leaves nothing to wait for");
    assert.equal(refreshes, 1);
    assert.deepEqual(nativeCopies(r, successor, account), [native]);
    die(new Error("daemon died")); // Drain the fixture promise.
    await assert.rejects(inFlight, /outcome is unknown/);
    r.setNow(r.now() + 60_000);
    const resolved = await successor.centralCredentials.ensure(account, 0);
    assert.equal(resolved.phase, "ready");
    assert.equal(resolved.failure, null);
    assert.equal(refreshes, 2);
    for (const raw of nativeCopies(r, successor, account)) assert.equal(JSON.parse(raw).claudeAiOauth.refreshToken, "");
  } finally { r.cleanup(); }
});

test("central.claude: disabling an interrupted enrollment never republishes its unconfirmed refresh token", async () => {
  const r = rig();
  try {
    const native = nativeDocument(r);
    const older = JSON.stringify({ claudeAiOauth: { accessToken: "older-access", refreshToken: "older-fixture-token", expiresAt: r.now() - HOUR } });
    const account = addAccount(r, "claude", "disable-interrupted", { home: { ".credentials.json": native }, vault: { ".credentials.json": older } });
    let die!: (error: Error) => void;
    const gate = new Promise<never>((_resolve, reject) => { die = reject; });
    let refreshes = 0;
    let keychain = native;
    let writable = false;
    const dependencies = { keychainReader: async () => keychain, keychainWriter: async (_home: string, raw: string) => { if (!writable) return false; keychain = raw; return true; } };
    const first = service(r, { ...dependencies, fetchers: { claudeRefresh: async () => { refreshes++; return gate; } } });
    const inFlight = first.centralCredentials.enable(account);
    await waitFor(() => refreshes === 1, "validating rotation started");
    const crashFence = first.centralCredentials.status(account)!;
    const authorityPath = join(r.vault, ".credential-authorities", `${account.id}.json`);
    const authorityBeforeHandler = readFileSync(authorityPath);
    assert.equal(crashFence.phase, "enrolling");
    assert.notEqual(crashFence.operationKey, null);
    // Drain the fixture promise, then restore exactly the durable state a process
    // death before the rejection handler leaves. No provider result was saved.
    die(new Error("daemon died"));
    await assert.rejects(inFlight, /outcome is unknown/);
    r.store.putAccountCredentialAuthority(crashFence);
    writeFileSync(authorityPath, authorityBeforeHandler);
    const successor = service(r, { ...dependencies, fetchers: { claudeRefresh: async () => { throw new Error("must not rotate again"); } } });
    await assert.rejects(successor.centralCredentials.disable(account), /Keychain/);
    assert.equal(successor.centralCredentials.status(account)!.phase, "disabling_uncertain");
    writable = true;
    const restarted = service(r, dependencies);
    assert.equal((await restarted.centralCredentials.disable(account)).phase, "disabled");
    for (const raw of [...nativeCopies(r, successor, account), keychain]) {
      assert.equal(JSON.parse(raw).claudeAiOauth.refreshToken, "", "unknown provider outcome must remain access-only");
    }
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed");
    assert.equal(refreshes, 1);
  } finally { r.cleanup(); }
});

test("central.claude: multiple accounts enroll and rotate independently", async () => {
  const r = rig();
  try {
    const accounts = ["first", "second", "third"].map(label => addAccount(r, "claude", label, { home: { ".credentials.json": JSON.stringify({
      claudeAiOauth: { accessToken: `before-${label}`, refreshToken: `${CLAUDE_REFRESH}-${label}`, expiresAt: r.now() + HOUR },
    }) } }));
    const rotations = new Map<string, number>();
    const svc = service(r, { fetchers: { claudeRefresh: async token => {
      const label = token.split("-").at(-1)!;
      const n = (rotations.get(label) ?? 0) + 1; rotations.set(label, n);
      return granted({ accessToken: `after-${label}-${n}`, refreshToken: `${CLAUDE_NESTED_REFRESH}-${label}`, expiresAt: r.now() + HOUR });
    } } });
    const results = await Promise.all(accounts.map(account => svc.centralCredentials.enable(account)));
    assert.deepEqual(results.map(state => [state.account, state.phase, state.generation]), accounts.map(account => [account.id, "ready", 2]));
    for (const account of accounts) {
      assert.ok(existsSync(join(r.vault, ".credential-authorities", `${account.id}.json`)), `${account.id} has its own authority document`);
      for (const raw of nativeCopies(r, svc, account)) assert.equal(JSON.parse(raw).claudeAiOauth.refreshToken, "");
    }
    // One account's forced rotation and one account's disable leave the others untouched.
    assert.equal((await svc.centralCredentials.ensure(accounts[0]!, 0, "force-first")).generation, 3);
    assert.equal((await svc.centralCredentials.disable(accounts[1]!)).phase, "disabled");
    assert.equal(svc.centralCredentials.status(accounts[0]!)!.generation, 3);
    assert.equal(svc.centralCredentials.status(accounts[2]!)!.generation, 2);
    assert.equal(svc.centralCredentials.status(accounts[2]!)!.phase, "ready");
    assert.deepEqual([...rotations.entries()].sort(), [["first", 2], ["second", 1], ["third", 1]]);
    // Leases are per account: each ships its own access token, and the disabled one is native again.
    assert.equal((decodeFile(await svc.mintLease(accounts[0]!)).claudeAiOauth as Record<string, unknown>).accessToken, "after-first-2");
    assert.equal((decodeFile(await svc.mintLease(accounts[2]!)).claudeAiOauth as Record<string, unknown>).accessToken, "after-third-1");
    assert.ok(readFileSync(join(accounts[1]!.homePath, ".credentials.json"), "utf8").includes(`${CLAUDE_NESTED_REFRESH}-second`), "disable restores the full chain natively");
    // Re-enrolling the disabled account does not disturb the others.
    assert.equal((await svc.centralCredentials.enable(accounts[1]!)).generation, 4);
    assert.equal(svc.centralCredentials.status(accounts[0]!)!.generation, 3);
    for (const lease of await Promise.all(accounts.map(account => svc.mintLease(account)))) assertNoFixtureSecrets(r, lease);
  } finally { r.cleanup(); }
});

test("central.claude: force refresh is coalesced with lease requests and keyed retries survive service restart", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "once", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchers = { claudeRefresh: async () => { refreshes++; if (refreshes > 1) await gate;
      return granted({ accessToken: "after", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 8 * HOUR }); } };
    const svc = service(r, { fetchers });
    await svc.centralCredentials.enable(account);
    const one = svc.centralCredentials.ensure(account, 0, "operator-refresh-1");
    const two = svc.centralCredentials.ensure(account, 0, "operator-refresh-1");
    const lease = svc.mintLease(account);
    await waitFor(() => refreshes === 2, "central refresh"); release();
    assert.equal((await one).generation, 3); assert.equal((await two).generation, 3);
    assert.equal((decodeFile(await lease).claudeAiOauth as Record<string, unknown>).accessToken, "after");
    const restarted = service(r, { fetchers });
    assert.equal((await restarted.centralCredentials.ensure(account, 0, "operator-refresh-1")).generation, 3);
    assert.equal(refreshes, 2);
    await assert.rejects(restarted.captureAccount(account), /Disable/);
    await restarted.centralCredentials.disable(account);
    assert.ok(readFileSync(join(account.homePath, ".credentials.json"), "utf8").includes(CLAUDE_NESTED_REFRESH));
  } finally { r.cleanup(); }
});

test("central.claude: force refresh re-evaluates after an unrelated ensure rejects", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "force-after-rejection", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0;
    const svc = service(r, { fetchers: { claudeRefresh: async () => {
      refreshes += 1;
      return granted({ accessToken: "after", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 8 * HOUR });
    } } });
    await svc.centralCredentials.enable(account);
    const accessOnly = readFileSync(join(account.homePath, ".credentials.json"), "utf8");
    writeFileSync(join(account.homePath, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: "foreign", refreshToken: "foreign-chain", expiresAt: r.now() + 8 * HOUR,
    } }));

    const rejectedEnsure = svc.centralCredentials.ensure(account, 0);
    const repair = rejectedEnsure.catch(() => { writeFileSync(join(account.homePath, ".credentials.json"), accessOnly); });
    const forced = svc.centralCredentials.ensure(account, 0, "force-after-rejection");
    await assert.rejects(rejectedEnsure, /external Claude/);
    await repair;
    assert.equal((await forced).generation, 3);
    assert.equal(refreshes, 2, "the force runs once after the rejected ensure settles");
  } finally { r.cleanup(); }
});

test("central.claude: saved rotation survives publication failure; an unknown outcome is retried after backoff and recovers", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "recover", { home: { ".credentials.json": nativeDocument(r) } });
    let failPublish = false; let calls = 0;
    const svc = service(r, { keychainReader: async () => "{}", keychainWriter: async () => !failPublish,
      fetchers: { claudeRefresh: async () => { calls++; return granted({ accessToken: "after", refreshToken: CLAUDE_NESTED_REFRESH, expiresAt: r.now() + 8 * HOUR }); } } });
    await svc.centralCredentials.enable(account); failPublish = true;
    await assert.rejects(svc.centralCredentials.ensure(account, 0, "publish-failure"), /Keychain/);
    assert.equal(svc.centralCredentials.status(account)!.phase, "refreshing");
    failPublish = false;
    assert.equal((await svc.centralCredentials.ensure(account, 0, "publish-failure")).phase, "ready");
    assert.equal(calls, 2);
    let lost = true;
    const uncertain = service(r, { fetchers: { claudeRefresh: async () => { calls++; if (lost) throw new Error("connection lost");
      return granted({ accessToken: "recovered", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + 8 * HOUR }); } } });
    await assert.rejects(uncertain.centralCredentials.ensure(account, 0, "timeout"), /outcome for claude-recover is unknown/);
    await assert.rejects(uncertain.centralCredentials.ensure(account, 0), /next attempt at/);
    assert.equal(calls, 3, "the backoff holds the retry");
    assert.equal(uncertain.centralCredentials.status(account)!.phase, "uncertain");
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed", "a credential in doubt is not reported ok");
    assert.match(r.store.getAccount(account.id)!.statusReason!, /Central refresh outcome unknown for claude-recover \(connection lost\); retrying automatically/);
    assert.equal(uncertain.credentialHealthOf(r.store.getAccount(account.id)!), "unverified");
    const doubted = r.store.getAccount(account.id)!.statusReason;
    assert.equal((await uncertain.refreshLimits([account.id]))[0]!.unreadableReason, "auth_failed", "the typed phase, not the message, classifies the probe");
    assert.equal(r.store.getAccount(account.id)!.statusReason, doubted, "a probe does not reword the authority's reason");
    assert.equal(calls, 3);
    r.setNow(r.now() + 30_000);
    await assert.rejects(uncertain.centralCredentials.ensure(account, 0), /outcome for claude-recover is unknown/);
    assert.equal(uncertain.centralCredentials.status(account)!.failure?.attempts, 2);
    assert.equal(uncertain.centralCredentials.status(account)!.failure?.retryAt, r.now() + 60_000, "the backoff doubles");
    r.setNow(r.now() + 60_000);
    lost = false;
    const recovered = await uncertain.centralCredentials.ensure(account, 0);
    assert.equal(recovered.phase, "ready");
    assert.equal(recovered.failure, null);
    assert.equal(calls, 5);
    assert.equal(r.store.getAccount(account.id)!.status, "ok", "the provider's new token ends the doubt");
    assert.equal(r.store.getAccount(account.id)!.statusReason, "central refresh succeeded");
    await uncertain.centralCredentials.disable(account);
    assert.equal(JSON.parse(readFileSync(join(account.homePath, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, CLAUDE_ENROLLED_REFRESH,
      "a recovered chain is whole again, so disable hands it back to the native copies");
  } finally { r.cleanup(); }
});

test("central.claude: uncertain disable remains fenced across failed publication and restart", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "disable-crash", { home: { ".credentials.json": nativeDocument(r) } });
    let fail = false; let calls = 0;
    const svc = service(r, { keychainReader: async () => "{}", keychainWriter: async () => !fail,
      fetchers: { claudeRefresh: async () => {
        if (++calls > 1) throw new Error("lost response");
        return granted({ accessToken: "enrolled", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + HOUR });
      } } });
    await svc.centralCredentials.enable(account);
    await assert.rejects(svc.centralCredentials.ensure(account, 0, "uncertain"), /outcome for claude-disable-crash is unknown/);
    fail = true;
    await assert.rejects(svc.centralCredentials.disable(account), /Keychain/);
    assert.equal(svc.centralCredentials.status(account)!.phase, "disabling_uncertain");
    const restarted = service(r);
    await assert.rejects(restarted.centralCredentials.enable(account), /incomplete/);
    await assert.rejects(restarted.centralCredentials.ensure(account, 0), /disabling/);
    await restarted.centralCredentials.disable(account);
    assert.equal(JSON.parse(readFileSync(join(account.homePath, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, "");
  } finally { r.cleanup(); }
});

test("central.claude: a refused refresh token ends in login_required — auth_needed with the reason, a typed lease refusal, no last-good limits", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "dying", { home: { ".credentials.json": nativeDocument(r) } });
    const loginExpiry = r.now() + 28 * 24 * HOUR;
    let refuse = false; let refreshes = 0;
    const svc = service(r, { fetchers: {
      claudeUsage: async () => ({ five_hour: { utilization: 7 }, seven_day: { utilization: 19 } }),
      claudeRefresh: async () => { refreshes++;
        return refuse ? refused : granted({ accessToken: "enrolled", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + HOUR, refreshTokenExpiresAt: loginExpiry }); },
    } });
    const enrolled = await svc.centralCredentials.enable(account);
    assert.equal(enrolled.refreshTokenExpiresAt, loginExpiry, "the authority row records when the login itself ends");
    assert.equal(r.store.getAccount(account.id)!.refreshTokenExpiresAt, loginExpiry, "and so does the account row the mirror carries");
    assert.equal(parseClaudeCredentials(JSON.stringify(svc.centralCredentials.document(account)))!.refreshTokenExpiresAt, loginExpiry);
    assert.equal((await svc.refreshLimits([account.id]))[0]!.readable, true);
    assert.equal(svc.credentialHealthOf(r.store.getAccount(account.id)!), "verified");

    r.setNow(r.now() + HOUR);
    refuse = true;
    const [limits] = await svc.refreshLimits([account.id]);
    assert.equal(limits!.readable, false, "last-good limits are not kept over a dead credential");
    assert.equal(limits!.unreadableReason, "auth_failed");
    const terminal = svc.centralCredentials.status(account)!;
    assert.equal(terminal.phase, "login_required");
    assert.deepEqual(terminal.failure, { outcome: "rejected", httpStatus: 400, error: "invalid_grant", description: "Refresh token not found or invalid", at: r.now(), attempts: 1, retryAt: null });
    assert.equal(terminal.refreshTokenExpiresAt, loginExpiry);
    const row = r.store.getAccount(account.id)!;
    assert.equal(row.status, "auth_needed");
    assert.equal(row.statusReason, "Claude login required for claude-dying: the provider refused the refresh token (HTTP 400 invalid_grant: Refresh token not found or invalid). "
      + "Recover with: hive account credentials disable claude-dying; hive account login claude-dying; hive account credentials enable claude-dying");
    assert.equal(svc.mirrorRow(row).credentialHealth, "unverified", "a dead credential is not verified");
    assert.equal(svc.honestStatus(row, "ok"), "auth_needed", "unpause cannot flip a dead login back to ok");
    assert.equal(svc.authNeededReason(row), row.statusReason);
    assert.equal(refreshes, 2);

    await refuses(() => svc.mintLease(row), "credential_login_required", /Claude login required for claude-dying/);
    await assert.rejects(svc.activateForSpawn(row, { cwd: r.dir }), /Claude login required/);
    await svc.refreshLimits([account.id]);
    assert.equal(refreshes, 2, "the refused token is never presented again");
    assert.equal(r.store.getAccount(account.id)!.statusReason, row.statusReason, "later probes do not rewrite the reason");
    assert.equal(svc.centralCredentials.retryDue(row), false);

    assert.ok(r.log.includes(`account.credentials.refresh account=${account.id} during=refresh generation=2 outcome=rejected reason="HTTP 400 invalid_grant: Refresh token not found or invalid" attempts=1 retry_at=-`));
    assert.ok(r.log.includes(`account.credentials.phase account=${account.id} from=refreshing to=login_required generation=2 reason="rejected: HTTP 400 invalid_grant: Refresh token not found or invalid"`));
    assert.ok(r.log.includes(`account.auth_needed account=${account.id} by=central_refresh`));
    for (const secret of [CLAUDE_REFRESH, CLAUDE_ENROLLED_REFRESH]) assert.ok(!r.log.join("\n").includes(secret));
  } finally { r.cleanup(); }
});

test("central.claude: a refresh the provider did not process stays ready, backs off and recovers; last-good limits stay", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "outage", { home: { ".credentials.json": nativeDocument(r) } });
    let answer: ClaudeRefreshResult | null = null; let refreshes = 0;
    const svc = service(r, { fetchers: {
      claudeUsage: async () => ({ five_hour: { utilization: 7 }, seven_day: { utilization: 19 } }),
      claudeRefresh: async () => { refreshes++; return answer ?? granted({ accessToken: `access-${refreshes}`, refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + HOUR }); },
    } });
    await svc.centralCredentials.enable(account);
    assert.equal((await svc.refreshLimits([account.id]))[0]!.readable, true);

    r.setNow(r.now() + HOUR);
    answer = { kind: "retryable", httpStatus: 503, error: "overloaded_error", description: "Overloaded" };
    const [kept] = await svc.refreshLimits([account.id]);
    assert.equal(kept!.readable, true, "a provider outage keeps the last-good limits");
    const waiting = svc.centralCredentials.status(account)!;
    assert.equal(waiting.phase, "ready", "the refresh token is unused, so the credential is not in doubt");
    assert.deepEqual(waiting.failure, { outcome: "retryable", httpStatus: 503, error: "overloaded_error", description: "Overloaded", at: r.now(), attempts: 1, retryAt: r.now() + 30_000 });
    assert.equal(r.store.getAccount(account.id)!.status, "ok");
    await refuses(() => svc.mintLease(account), "lease_unavailable", /next attempt at/);
    assert.equal(refreshes, 2, "the backoff holds further attempts");
    assert.equal(svc.centralCredentials.retryDue(account), false);

    r.setNow(r.now() + 30_000);
    assert.equal(svc.centralCredentials.retryDue(account), true);
    answer = { kind: "retryable", httpStatus: 429, error: "rate_limit_error", description: null, retryAfterMs: 120_000 };
    await refuses(() => svc.mintLease(account), "lease_unavailable", /refresh token is unused/);
    assert.equal(svc.centralCredentials.status(account)!.failure?.attempts, 2);
    assert.equal(svc.centralCredentials.status(account)!.failure?.retryAt, r.now() + 120_000, "Retry-After wins over the backoff");

    r.setNow(r.now() + 120_000);
    answer = null;
    assert.equal(JSON.parse(Buffer.from((await svc.mintLease(account)).files[0]!.contentB64, "base64").toString("utf8")).claudeAiOauth.accessToken, "access-4");
    const recovered = svc.centralCredentials.status(account)!;
    assert.equal(recovered.phase, "ready");
    assert.equal(recovered.failure, null);
    assert.equal(r.store.getAccount(account.id)!.status, "ok");
  } finally { r.cleanup(); }
});

test("central.claude: a refresh interrupted by a daemon death resolves on the next tick instead of freezing", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "crashed", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0;
    const fetchers = {
      claudeUsage: async () => ({ five_hour: { utilization: 7 }, seven_day: { utilization: 19 } }),
      claudeRefresh: async () => { refreshes++; return granted({ accessToken: `access-${refreshes}`, refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + 8 * HOUR }); },
    };
    const first = service(r, { fetchers });
    const ready = await first.centralCredentials.enable(account);
    // The durable state a process death leaves between the fence and the provider's answer.
    r.store.putAccountCredentialAuthority({ ...ready, phase: "refreshing", operationKey: "died-mid-refresh" });

    const successor = service(r, { fetchers });
    assert.equal(successor.centralCredentials.retryDue(account), true);
    successor.centralRefreshRetryTick();
    await waitFor(() => successor.centralCredentials.status(account)!.phase === "ready", "the interrupted refresh resolved");
    const resolved = successor.centralCredentials.status(account)!;
    assert.equal(resolved.generation, ready.generation + 1);
    assert.equal(resolved.failure, null);
    assert.equal(refreshes, 2);
    assert.ok(r.log.includes(`account.credentials.phase account=${account.id} from=refreshing to=uncertain generation=${ready.generation} reason="unknown_outcome: the daemon stopped during the refresh"`));
    await waitFor(() => r.store.getAccountLimits(account.id)?.readable === true, "the probe that drove the retry settled");
    assert.equal(r.store.getAccount(account.id)!.status, "ok");
  } finally { r.cleanup(); }
});

test("central.claude: unreadable Keychain blocks enrollment before the validating rotation and preserves the native copy", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "locked", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0;
    const svc = service(r, { keychainStateReader: async () => ({ status: "unreadable" }),
      fetchers: { claudeRefresh: async () => { refreshes++; return refused; } } });
    await assert.rejects(svc.centralCredentials.enable(account), /Keychain is unreadable/);
    assert.equal(refreshes, 0, "the chain is not consumed while publication is known to be impossible");
    assert.equal(svc.centralCredentials.status(account)!.phase, "enrolling");
    assert.equal(svc.centralCredentials.status(account)!.operationKey, null);
    assert.ok(readFileSync(join(account.homePath, ".credentials.json"), "utf8").includes(CLAUDE_REFRESH));
    await assert.rejects(svc.centralCredentials.ensure(account, 0), /enrolling/);
    await assert.rejects(svc.centralCredentials.enable(account), /Keychain is unreadable/);
    assert.equal(refreshes, 0);
  } finally { r.cleanup(); }
});

test("central.claude: lost authority has a supported disable and login recovery path", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "lost-authority", { home: { ".credentials.json": nativeDocument(r) } });
    const svc = service(r);
    await svc.centralCredentials.enable(account);
    writeFileSync(join(r.vault, ".credential-authorities", `${account.id}.json`), "corrupt");
    await assert.rejects(svc.centralCredentials.ensure(account, 0), /unavailable/);
    await svc.centralCredentials.disable(account);
    assert.equal(svc.centralCredentials.enabled(account), false);
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed");
  } finally { r.cleanup(); }
});

test("central.claude: a foreign native rotation is preserved and blocks provider refresh", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "foreign", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0;
    const svc = service(r, { fetchers: { claudeRefresh: async () => {
      if (++refreshes === 1) return granted({ accessToken: "enrolled", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + HOUR });
      return refused;
    } } });
    await svc.centralCredentials.enable(account);
    const foreign = JSON.stringify({ claudeAiOauth: { accessToken: "foreign", refreshToken: "foreign-chain", expiresAt: r.now() + 8 * HOUR } });
    writeFileSync(join(account.homePath, ".credentials.json"), foreign);
    await assert.rejects(svc.centralCredentials.ensure(account, 0), /external Claude/);
    await assert.rejects(svc.centralCredentials.ensure(account, 0, "force"), /external Claude/);
    assert.equal(refreshes, 1);
    assert.equal(readFileSync(join(account.homePath, ".credentials.json"), "utf8"), foreign);
    await svc.centralCredentials.disable(account);
    assert.equal(svc.centralCredentials.enabled(account), false);
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed");
    assert.equal(readFileSync(join(account.homePath, ".credentials.json"), "utf8"), foreign);
  } finally { r.cleanup(); }
});

test("central.claude: a foreign login that lands during enrollment is detected before the validating rotation", async () => {
  const r = rig();
  try {
    // A stale, older chain in the vault is not foreign: enrollment adopts the freshest copy.
    const account = addAccount(r, "claude", "foreign-enroll", { home: { ".credentials.json": nativeDocument(r) },
      vault: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "old", refreshToken: "older-chain", expiresAt: r.now() + HOUR / 2 } }) } });
    let refreshes = 0;
    const svc = service(r, { keychainStateReader: async () => ({ status: "present", raw: JSON.stringify({ claudeAiOauth: {
      accessToken: "newer", refreshToken: "foreign-chain", expiresAt: r.now() + 8 * HOUR } }) }),
      fetchers: { claudeRefresh: async () => { refreshes++; return refused; } } });
    await assert.rejects(svc.centralCredentials.enable(account), /external Claude/);
    assert.equal(refreshes, 0, "nothing is rotated while ownership is contested");
    assert.equal(svc.centralCredentials.status(account)!.phase, "enrolling");
    assert.ok(readFileSync(join(account.homePath, ".credentials.json"), "utf8").includes(CLAUDE_REFRESH));
    const settled = service(r, { keychainStateReader: async () => ({ status: "absent" }), keychainWriter: async () => true });
    assert.equal((await settled.centralCredentials.enable(account)).phase, "ready", "the older vault chain never counts as foreign");
  } finally { r.cleanup(); }
});

test("central.claude: a pending native Keychain seed prevents enrollment", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "seeding", { vault: { ".credentials.json": nativeDocument(r) } });
    const gate = deferred<boolean>();
    const svc = service(r, { keychainWriter: async () => gate.promise, gatewayMcpSeeder: async () => ({ status: "skipped", written: [], reason: "fixture" }) });
    await svc.activateForSpawn(account, { cwd: r.dir });
    await assert.rejects(svc.centralCredentials.enable(account), /native credential refresh/);
    assert.equal(svc.centralCredentials.enabled(account), false);
    gate.resolve(true);
  } finally { r.cleanup(); }
});

test("central.claude: a validated rotation is saved before publication; a retry publishes without rotating again (#12)", async () => {
  const r = rig();
  try {
    const account = addAccount(r, "claude", "absent-write", { home: { ".credentials.json": nativeDocument(r) } });
    let refreshes = 0; let writable = false;
    const svc = service(r, { keychainStateReader: async () => ({ status: "absent" }), keychainWriter: async () => writable,
      fetchers: { claudeRefresh: async () => { refreshes++; return granted({ accessToken: "enrolled", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + 8 * HOUR }); } } });
    await assert.rejects(svc.centralCredentials.enable(account), /Could not replace/);
    const state = svc.centralCredentials.status(account)!;
    assert.equal(state.phase, "enrolling");
    assert.equal(state.generation, 1);
    assert.notEqual(state.operationKey, null);
    const saved = JSON.parse(readFileSync(join(r.vault, ".credential-authorities", `${account.id}.json`), "utf8"));
    assert.equal(saved.generation, 2, "the provider result is durable before any copy is published");
    assert.equal(saved.operationKey, state.operationKey);
    assert.ok(!JSON.stringify(saved.adopted).includes(CLAUDE_REFRESH), "the adopted-chain record carries no secret");
    await assert.rejects(svc.centralCredentials.enable(account), /Could not replace/);
    saved.rollbackAdopted = saved.adopted;
    writeFileSync(join(r.vault, ".credential-authorities", `${account.id}.json`), JSON.stringify(saved));
    writable = true;
    const ready = await service(r, { keychainStateReader: async () => ({ status: "absent" }), keychainWriter: async () => true,
      fetchers: { claudeRefresh: async () => { refreshes++; return refused; } } }).centralCredentials.enable(account);
    assert.equal(ready.phase, "ready");
    assert.equal(JSON.parse(readFileSync(join(r.vault, ".credential-authorities", `${account.id}.json`), "utf8")).rollbackAdopted, undefined, "ready cannot inherit a rollback allowance");
    assert.equal(ready.generation, 2);
    assert.equal(refreshes, 1, "resume publishes the saved result instead of consuming the new token");
    assert.equal(JSON.parse(readFileSync(join(account.homePath, ".credentials.json"), "utf8")).claudeAiOauth.accessToken, "enrolled");
  } finally { r.cleanup(); }
});


test("central.claude: disable restores a validated enrollment result over its older adopted copies", async () => {
  const r = rig();
  try {
    const native = nativeDocument(r);
    const older = JSON.stringify({ claudeAiOauth: { accessToken: "old-access", refreshToken: "old-fixture", expiresAt: r.now() - HOUR } });
    const account = addAccount(r, "claude", "saved-disable", { home: { ".credentials.json": native }, vault: { ".credentials.json": older } });
    let keychain = native;
    let writable = false;
    let refreshes = 0;
    const deps = { keychainReader: async () => keychain, keychainWriter: async (_home: string, raw: string) => { if (!writable) return false; keychain = raw; return true; },
      fetchers: { claudeRefresh: async () => { refreshes++; return granted({ accessToken: "validated", refreshToken: CLAUDE_ENROLLED_REFRESH, expiresAt: r.now() + 8 * HOUR }); } } };
    const svc = service(r, deps);
    await assert.rejects(svc.centralCredentials.enable(account), /Could not replace/);
    assert.equal(svc.centralCredentials.status(account)!.phase, "enrolling");
    // A crash may occur after saving the result but before publishing any copy.
    writeFileSync(join(account.homePath, ".credentials.json"), native);
    writeFileSync(join(svc.vaultDirOf(account), ".credentials.json"), older);
    writable = true;
    const restarted = service(r, deps);
    assert.equal((await restarted.centralCredentials.disable(account)).phase, "disabled");
    for (const raw of [...nativeCopies(r, restarted, account), keychain]) {
      assert.equal(JSON.parse(raw).claudeAiOauth.refreshToken, CLAUDE_ENROLLED_REFRESH);
    }
    assert.equal(refreshes, 1);
  } finally { r.cleanup(); }
});
