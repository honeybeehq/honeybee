/**
 * Cursor credentials: Honeybee re-captures Cursor's own machine-wide login
 * (which cursor-agent keeps fresh) instead of refreshing tokens itself.
 *  - a cached token near its JWT exp is re-captured before a probe / spawn;
 *    a fresh one costs no store read
 *  - a 401 triggers one forced re-capture and a second probe before
 *    auth_needed; with nothing newer the reason offers "capture again"
 *  - the authority node leases access-only tokens; a leased (satellite)
 *    account never reads its own machine's Cursor login
 *  - capture refuses a login that belongs to another Cursor user
 * SAFETY: temp dirs only; the Cursor store and provider HTTP are injected
 * fakes; every token is a fake JWT built here. No Keychain, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type AccountRow, type CoreStore } from "../../core/src/index.ts";
import { AccountsService, CURSOR_RECAPTURE_AHEAD_MS, type EphemeralCredential } from "../src/accountsService.ts";
import { loadNodeConfig, type ResolvedNodeConfig } from "../src/config.ts";
import { cursorIdentityVerdict, cursorTokenIdentity, parseCursorAuth, type CursorAuthSnapshot } from "../src/cursorAuth.ts";
import { CredentialAuthorityError } from "../src/claudeCredentialAuthority.ts";
import { RpcError } from "../src/protocol.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

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

function rig(name: string): Rig {
  const dir = mkdtempSync(join(tmpdir(), `hb-v2-cursor-${name}-`));
  const vault = join(dir, "vault");
  const homes = join(dir, "homes");
  writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { vaultDir: vault, homesDir: homes, limitsRefreshMs: 0 } }));
  const cfg = loadNodeConfig(dir);
  let t = Date.parse("2026-11-18T12:00:00Z");
  const store = openCoreStore(join(dir, "core.sqlite3"), { now: () => t, ephemeral: true });
  const log: string[] = [];
  return { dir, store, cfg, log, now: () => t, setNow: (v) => { t = v; }, vault, homes, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A fake Cursor access token: an unsigned JWT with `sub` and `exp`. */
function fakeJwt(sub: string, expMs: number, nonce: string): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub, exp: Math.floor(expMs / 1000), nonce })}.fake-signature`;
}

function authDoc(accessToken: string, refreshToken = "FAKE-CURSOR-REFRESH"): string {
  return `${JSON.stringify({ accessToken, refreshToken }, null, 2)}\n`;
}

/** The fake machine-wide Cursor login (stands in for the Keychain / global auth.json). */
function fakeCursorStore() {
  const state = { raw: null as string | null, reads: 0 };
  const reader = async (): Promise<CursorAuthSnapshot | null> => {
    state.reads += 1;
    return parseCursorAuth(state.raw, "keychain");
  };
  return { state, reader };
}

function addCursor(r: Rig, label: string, raw: string): AccountRow {
  const id = `cursor-${label}`;
  const account = r.store.createAccount({ id, harness: "cursor", homePath: join(r.homes, id), label, status: "ok" });
  for (const dir of [account.homePath, join(r.vault, "cursor", id)]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), raw);
  }
  return account;
}

const usage = (r: Rig) => ({ billingCycleStart: r.now(), billingCycleEnd: r.now() + 30 * 24 * HOUR, planUsage: { totalSpend: "10", limit: "1000", totalPercentUsed: 1, apiPercentUsed: 2 } });

function service(r: Rig, store: ReturnType<typeof fakeCursorStore>, http: { postJson: (url: string, headers: Record<string, string>) => Promise<unknown> } = { postJson: async () => usage(r) }): AccountsService {
  return new AccountsService({
    store: r.store,
    cfg: r.cfg,
    log: (op) => r.log.push(op),
    now: r.now,
    platform: "linux",
    keychainReader: async () => null,
    keychainWriter: async () => false,
    cursorAuthReader: store.reader,
    providerHttp: { getJson: async () => { throw new Error("unexpected GET"); }, postJson: http.postJson },
  });
}

function homeToken(account: AccountRow): string | undefined {
  return parseCursorAuth(readFileSync(join(account.homePath, "auth.json"), "utf8"))?.accessToken;
}

function vaultToken(r: Rig, account: AccountRow): string | undefined {
  return parseCursorAuth(readFileSync(join(r.vault, "cursor", account.id, "auth.json"), "utf8"))?.accessToken;
}

test("cursor identity: the JWT sub names the user; same / different / unverified / first", () => {
  const a = fakeJwt("auth0|user_a", Date.now() + HOUR, "1");
  const a2 = fakeJwt("auth0|user_a", Date.now() + 2 * HOUR, "2");
  const b = fakeJwt("auth0|user_b", Date.now() + HOUR, "3");
  assert.equal(cursorTokenIdentity({ accessToken: a }), "auth0|user_a");
  assert.equal(cursorTokenIdentity({ accessToken: "not-a-jwt" }), null);
  assert.equal(cursorIdentityVerdict(authDoc(a), authDoc(a2)), "same");
  assert.equal(cursorIdentityVerdict(authDoc(a), authDoc(b)), "different");
  assert.equal(cursorIdentityVerdict(authDoc(a), authDoc("opaque-token")), "unverified");
  assert.equal(cursorIdentityVerdict(null, authDoc(b)), "first");
});

test("cursor refresh-before-expiry: a token near its exp is re-captured from Cursor's login into home + vault before the probe and the spawn; a fresh one costs no store read", async () => {
  const r = rig("expiry");
  try {
    const cursor = fakeCursorStore();
    const old = fakeJwt("auth0|user_a", r.now() + 10 * MIN, "old");
    const fresh = fakeJwt("auth0|user_a", r.now() + 3 * HOUR, "fresh");
    const account = addCursor(r, "a", authDoc(old));
    const seen: string[] = [];
    const svc = service(r, cursor, { postJson: async (_url, headers) => { seen.push(headers.Authorization!); return usage(r); } });

    // Cursor's own login was refreshed by cursor-agent; Honeybee's copy is 10 minutes from expiry.
    cursor.state.raw = authDoc(fresh, "FAKE-CURSOR-REFRESH-2");
    const [row] = await svc.refreshLimits([account.id]);
    assert.equal(row!.readable, true);
    assert.deepEqual(seen, [`Bearer ${fresh}`], "the probe used the re-captured token");
    assert.equal(homeToken(account), fresh);
    assert.equal(vaultToken(r, account), fresh);
    assert.equal(svc.credentialEnvOf(account).CURSOR_AUTH_TOKEN, fresh, "the spawn env carries the new token");
    assert.ok(r.log.some((line) => line.startsWith(`account.cursor.recaptured account=${account.id} source=keychain`)));
    assert.ok(!r.log.join("\n").includes(fresh) && !r.log.join("\n").includes("FAKE-CURSOR-REFRESH"), "no token in the log");

    // Now fresh (3h left): probes and spawns do not read the machine-wide store.
    const reads = cursor.state.reads;
    await svc.refreshLimits([account.id]);
    await svc.activateForSpawn(account, { cwd: r.dir });
    assert.equal(cursor.state.reads, reads, "no store read while the token is fresh");

    // Within the window again: the spawn path re-captures before launching.
    r.setNow(r.now() + 3 * HOUR - CURSOR_RECAPTURE_AHEAD_MS + MIN);
    const later = fakeJwt("auth0|user_a", r.now() + 4 * HOUR, "later");
    cursor.state.raw = authDoc(later);
    await svc.activateForSpawn(account, { cwd: r.dir });
    assert.equal(homeToken(account), later);
    assert.equal(svc.credentialEnvOf(account).CURSOR_AUTH_TOKEN, later);

    // Cursor's login now belongs to someone else: nothing is taken.
    r.setNow(r.now() + 4 * HOUR - CURSOR_RECAPTURE_AHEAD_MS + MIN);
    cursor.state.raw = authDoc(fakeJwt("auth0|user_b", r.now() + 5 * HOUR, "other"));
    assert.equal(await svc.recaptureCursor(r.store.getAccount(account.id)!), "different_account");
    assert.equal(homeToken(account), later);
    assert.equal(vaultToken(r, account), later);
  } finally {
    r.cleanup();
  }
});

test("cursor 401: one forced re-capture and a second probe keep the account ok; with nothing newer, auth_needed offers capture again before login", async () => {
  const r = rig("401");
  try {
    const cursor = fakeCursorStore();
    // Revoked server-side while its exp is still far away: only the 401 says so.
    const revoked = fakeJwt("auth0|user_a", r.now() + 6 * HOUR, "revoked");
    const fresh = fakeJwt("auth0|user_a", r.now() + 8 * HOUR, "fresh");
    const account = addCursor(r, "a", authDoc(revoked));
    const seen: string[] = [];
    const svc = service(r, cursor, {
      postJson: async (_url, headers) => {
        seen.push(headers.Authorization!);
        if (headers.Authorization === `Bearer ${fresh}`) return usage(r);
        throw new Error("/aiserver.v1.DashboardService/GetCurrentPeriodUsage: HTTP 401");
      },
    });
    cursor.state.raw = authDoc(fresh);
    const [row] = await svc.refreshLimits([account.id]);
    assert.equal(row!.readable, true, "the retry with the re-captured token answered");
    assert.deepEqual(seen, [`Bearer ${revoked}`, `Bearer ${fresh}`]);
    assert.equal(r.store.getAccount(account.id)!.status, "ok", "a 401 with a refresh possible does not mark auth_needed");
    assert.ok(r.log.some((line) => line === `account.cursor.probe_auth_failed account=${account.id} recapture=recaptured`));
    assert.equal(homeToken(account), fresh);

    // Cursor's login holds nothing newer: auth_needed, and the reason says capture first.
    const second = addCursor(r, "b", authDoc(fakeJwt("auth0|user_b", r.now() + 6 * HOUR, "b-revoked")));
    cursor.state.raw = authDoc(fakeJwt("auth0|user_b", r.now() + 6 * HOUR, "b-revoked"));
    await svc.refreshLimits([second.id]);
    const after = r.store.getAccount(second.id)!;
    assert.equal(after.status, "auth_needed");
    assert.match(after.statusReason ?? "", /HTTP 401; capture again if Cursor on this computer is signed in as this account's user: hive account capture cursor-b; else log in: hive account login cursor-b$/);
    const readiness = svc.credentialReadiness(after);
    assert.equal(readiness.ready, false);
    assert.match(readiness.ready ? "" : readiness.message, /hive account capture cursor-b; else log in: hive account login cursor-b/);
  } finally {
    r.cleanup();
  }
});

test("cursor lease: the authority re-captures and leases an access-only token; the fake satellite installs it, spawns with it and never reads its own Cursor login", async () => {
  const authority = rig("authority");
  const satellite = rig("satellite");
  try {
    const cursor = fakeCursorStore();
    const old = fakeJwt("auth0|user_a", authority.now() + 2 * MIN, "old");
    const fresh = fakeJwt("auth0|user_a", authority.now() + 2 * HOUR, "fresh");
    const account = addCursor(authority, "a", authDoc(old));
    cursor.state.raw = authDoc(fresh, "FAKE-CURSOR-REFRESH-2");
    const lease: EphemeralCredential = await service(authority, cursor).mintLease(account);
    assert.equal(lease.files.length, 1);
    assert.equal(lease.files[0]!.homeRelPath, "auth.json");
    const shipped = JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(shipped, { accessToken: fresh }, "access token only; the refresh token stays on the authority");
    assert.equal(lease.expiresAt, Math.floor((authority.now() + 2 * HOUR) / 1000));
    assert.ok(!JSON.stringify(lease).includes("FAKE-CURSOR-REFRESH"));
    assert.ok(!authority.log.join("\n").includes(fresh));

    // The satellite's own machine-wide Cursor login holds another (fresher) token: it must never be read.
    const satelliteCursor = fakeCursorStore();
    satelliteCursor.state.raw = authDoc(fakeJwt("auth0|user_a", satellite.now() + 9 * HOUR, "satellite-own"));
    const sat = service(satellite, satelliteCursor);
    const installed = await sat.installLease({ id: account.id, harness: "cursor", label: "a", shareId: "share-cursor-0001", authorityNodeId: "authority-test", epoch: 1, expiresAt: Math.floor((satellite.now() + HOUR) / 1000), files: lease.files });
    const leased = installed.account;
    assert.equal(leased.source, "leased");
    assert.equal(sat.credentialEnvOf(leased).CURSOR_AUTH_TOKEN, fresh, "the satellite spawns with the leased token");
    assert.equal(parseCursorAuth(readFileSync(join(leased.homePath, "auth.json"), "utf8"))?.refreshToken, undefined, "no refresh token on the satellite");
    assert.equal(await sat.recaptureCursor(leased, { force: true }), "skipped");
    satellite.setNow(satellite.now() + 2 * HOUR - MIN);
    await sat.activateForSpawn(leased, { cwd: satellite.dir });
    assert.equal(satelliteCursor.state.reads, 0, "a leased account never reads the satellite's Cursor login");
    await assert.rejects(sat.captureAccount(leased), (error: unknown) => error instanceof RpcError && error.code === "account_leased", "no capture on a satellite");
    await assert.rejects(sat.mintLease(leased), (error: unknown) => error instanceof RpcError && error.code === "account_leased");

    // A dying token with nothing newer in Cursor's login is refused, never shipped.
    const dying = addCursor(authority, "dying", authDoc(fakeJwt("auth0|user_c", authority.now() + 2 * MIN, "dying")));
    cursor.state.raw = null;
    await assert.rejects(service(authority, cursor).mintLease(dying), /expired or near expiry.*hive account capture cursor-dying/);
  } finally {
    authority.cleanup();
    satellite.cleanup();
  }
});

test("cursor identity at capture: another user's login is refused with a reason and changes nothing; --replace-account takes it", async () => {
  const r = rig("identity");
  try {
    const cursor = fakeCursorStore();
    const mine = fakeJwt("auth0|user_a", r.now() + HOUR, "mine");
    const account = addCursor(r, "a", authDoc(mine));
    const svc = service(r, cursor);
    const other = fakeJwt("auth0|user_b", r.now() + 5 * HOUR, "other");
    cursor.state.raw = authDoc(other);
    await assert.rejects(svc.captureAccount(account), (error: unknown) =>
      error instanceof CredentialAuthorityError && error.reason === "different_account"
      && /belongs to a different Cursor user than cursor-a; nothing was changed/.test(error.message));
    assert.equal(homeToken(account), mine);
    assert.equal(vaultToken(r, account), mine);

    cursor.state.raw = authDoc("opaque-token");
    await assert.rejects(svc.captureAccount(account), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "identity_unverified");
    assert.equal(vaultToken(r, account), mine);

    const same = fakeJwt("auth0|user_a", r.now() + 7 * HOUR, "same");
    cursor.state.raw = authDoc(same);
    assert.equal((await svc.captureAccount(account)).source, "external");
    assert.equal(vaultToken(r, account), same);

    cursor.state.raw = authDoc(other);
    await svc.captureAccount(account, { replaceAccount: true });
    assert.equal(vaultToken(r, account), other, "an explicit replace takes the other user's login");

    // A first capture into an empty account has nothing to compare against.
    const empty = r.store.createAccount({ id: "cursor-new", harness: "cursor", homePath: join(r.homes, "cursor-new"), label: "new", status: "auth_needed" });
    mkdirSync(empty.homePath, { recursive: true });
    await svc.captureAccount(empty);
    assert.ok(existsSync(join(r.vault, "cursor", "cursor-new", "auth.json")));
  } finally {
    r.cleanup();
  }
});
