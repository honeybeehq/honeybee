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
import { cursorIdentityVerdict, cursorTokenIdentity, parseCursorAuth, readCursorLiveAuth, type CursorAuthSnapshot } from "../src/cursorAuth.ts";
import { CredentialAuthorityError } from "../src/claudeCredentialAuthority.ts";
import { RpcError } from "../src/protocol.ts";
import { ProviderHttpError } from "../src/providerLimits.ts";

const MIN = 60_000;
const ISS = "https://fake-cursor-issuer.test";
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
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: ISS, sub, exp: Math.floor(expMs / 1000), nonce })}.fake-signature`;
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

test("cursor identity: iss + sub of a signed-shape JWT name the user; alg none, unsigned, or missing iss/sub/exp carry no identity", () => {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const a = fakeJwt("auth0|user_a", Date.now() + HOUR, "1");
  const a2 = fakeJwt("auth0|user_a", Date.now() + 2 * HOUR, "2");
  const b = fakeJwt("auth0|user_b", Date.now() + HOUR, "3");
  const exp = Math.floor((Date.now() + HOUR) / 1000);
  assert.equal(cursorTokenIdentity({ accessToken: a }), `${ISS}#auth0|user_a`);
  assert.equal(cursorTokenIdentity({ accessToken: "not-a-jwt" }), null);
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "none" })}.${b64({ iss: ISS, sub: "auth0|user_a", exp })}.sig` }), null, "alg none");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "NONE" })}.${b64({ iss: ISS, sub: "auth0|user_a", exp })}.sig` }), null, "alg NONE");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ iss: ISS, sub: "auth0|user_a", exp })}.` }), null, "unsigned");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ sub: "auth0|user_a", exp })}.sig` }), null, "no iss");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ iss: ISS, exp })}.sig` }), null, "no sub");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ iss: ISS, sub: "auth0|user_a" })}.sig` }), null, "no exp");
  const held = cursorTokenIdentity({ accessToken: a });
  assert.equal(cursorIdentityVerdict(held, authDoc(a2)), "same");
  assert.equal(cursorIdentityVerdict(held, authDoc(b)), "different");
  assert.equal(cursorIdentityVerdict(held, authDoc("opaque-token")), "unverified");
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
        throw new ProviderHttpError("/aiserver.v1.DashboardService/GetCurrentPeriodUsage: HTTP 401 — {\"error\":\"secret-body\"}", 401);
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
    assert.ok(!(after.statusReason ?? "").includes("secret-body"), "no response body in the status reason");
    assert.ok(!r.log.join("\n").includes("secret-body"), "no response body in the log");
    assert.match(after.statusReason ?? "", /^limits probe: Cursor usage probe: HTTP 401; capture again if Cursor on this computer is signed in as this account's user: hive account capture cursor-b; else log in: hive account login cursor-b$/);
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

test("cursor read gate: only a known exp within 15 minutes or an exact HTTP 401 reads Cursor's login; other statuses and opaque tokens never do, and errors carry the status only", async () => {
  const r = rig("gate");
  try {
    const cursor = fakeCursorStore();
    cursor.state.raw = authDoc(fakeJwt("auth0|user_a", r.now() + 9 * HOUR, "live"));
    // An opaque cached token has no known exp: spawns and probes never read the store for it.
    const opaque = addCursor(r, "opaque", authDoc("opaque-token"));
    const statuses: number[] = [403, 500];
    const svc = service(r, cursor, {
      postJson: async () => {
        const status = statuses.shift() ?? 200;
        if (status !== 200) throw new ProviderHttpError(`/usage: HTTP ${status} — unauthorized revoked secret-body`, status);
        return usage(r);
      },
    });
    await svc.activateForSpawn(opaque, { cwd: r.dir });
    assert.equal(cursor.state.reads, 0, "no read for an opaque token at spawn");
    // A 403 whose body says "unauthorized revoked" is not a 401: no re-capture, not auth_needed, no body kept.
    const fresh = addCursor(r, "a", authDoc(fakeJwt("auth0|user_a", r.now() + 6 * HOUR, "held")));
    const [forbidden] = await svc.refreshLimits([fresh.id]);
    assert.equal(forbidden!.unreadableReason, "provider_error");
    assert.equal(forbidden!.error, "Cursor usage probe: HTTP 403");
    const [failed] = await svc.refreshLimits([fresh.id]);
    assert.equal(failed!.error, "Cursor usage probe: HTTP 500");
    assert.equal(cursor.state.reads, 0, "no read for non-401 statuses");
    assert.equal(r.store.getAccount(fresh.id)!.status, "ok");
    assert.ok(!r.log.join("\n").includes("secret-body"));
  } finally {
    r.cleanup();
  }
});

test("cursor re-capture compare-and-swap: a newer token or another user written while Cursor's login is read is never overwritten", async () => {
  const r = rig("cas");
  try {
    const old = fakeJwt("auth0|user_a", r.now() + 5 * MIN, "old");
    const account = addCursor(r, "a", authDoc(old));
    const vaultPath = join(r.vault, "cursor", account.id, "auth.json");
    const newer = fakeJwt("auth0|user_a", r.now() + 10 * HOUR, "newer");
    const live = fakeJwt("auth0|user_a", r.now() + 2 * HOUR, "live");
    // While the store is read, an explicit capture lands a newer token for the same user.
    const racing = { state: { raw: null as string | null, reads: 0 }, reader: async (): Promise<CursorAuthSnapshot | null> => {
      writeFileSync(vaultPath, authDoc(newer));
      writeFileSync(join(account.homePath, "auth.json"), authDoc(newer));
      return parseCursorAuth(authDoc(live), "keychain");
    } };
    assert.equal(await service(r, racing).recaptureCursor(account, { force: true }), "unchanged");
    assert.equal(vaultToken(r, account), newer, "an older exp is never written over a newer one");

    // While the store is read, the account is replaced with another user's login.
    const other = fakeJwt("auth0|user_b", r.now() + 3 * HOUR, "other");
    const swapped = { state: { raw: null as string | null, reads: 0 }, reader: async (): Promise<CursorAuthSnapshot | null> => {
      writeFileSync(vaultPath, authDoc(other));
      writeFileSync(join(account.homePath, "auth.json"), authDoc(other));
      return parseCursorAuth(authDoc(fakeJwt("auth0|user_a", r.now() + 20 * HOUR, "late-a")), "keychain");
    } };
    assert.equal(await service(r, swapped).recaptureCursor(r.store.getAccount(account.id)!, { force: true }), "unchanged");
    assert.equal(vaultToken(r, account), other, "a different sub is never written over the account's new identity");
  } finally {
    r.cleanup();
  }
});

test("cursor copies: an identity-less copy never makes a capture 'first'; home/vault selection requires the account's sub", async () => {
  const r = rig("copies");
  try {
    const cursor = fakeCursorStore();
    const mine = fakeJwt("auth0|user_a", r.now() + HOUR, "mine");
    const account = addCursor(r, "a", authDoc(mine));
    // The vault copy lost its identity; the home copy still names user_a.
    writeFileSync(join(r.vault, "cursor", account.id, "auth.json"), authDoc("opaque-token"));
    cursor.state.raw = authDoc(fakeJwt("auth0|user_b", r.now() + 5 * HOUR, "other"));
    await assert.rejects(service(r, cursor).captureAccount(account), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "different_account");

    // A home copy with another user's later token is ignored; the lease ships the account's own user.
    const lease = addCursor(r, "lease", authDoc(fakeJwt("auth0|user_a", r.now() + 2 * HOUR, "vault-a")));
    writeFileSync(join(lease.homePath, "auth.json"), authDoc(fakeJwt("auth0|user_b", r.now() + 9 * HOUR, "home-b")));
    const minted = await service(r, cursor).mintLease(lease);
    const shipped = JSON.parse(Buffer.from(minted.files[0]!.contentB64, "base64").toString("utf8")) as { accessToken: string };
    assert.equal(cursorTokenIdentity(shipped), `${ISS}#auth0|user_a`);
  } finally {
    r.cleanup();
  }
});

test("cursor lease schema: mint ships exactly {accessToken}; install refuses extra fields, API keys, alg-none tokens and extra files; API-key-only accounts are not leased", async () => {
  const authority = rig("schema-a");
  const satellite = rig("schema-s");
  try {
    const cursor = fakeCursorStore();
    const keyOnly = addCursor(authority, "key", `${JSON.stringify({ apiKey: "FAKE-API-KEY" })}\n`);
    await assert.rejects(service(authority, cursor).mintLease(keyOnly), /API keys are not leased/);

    const sat = service(satellite, fakeCursorStore());
    const token = fakeJwt("auth0|user_a", satellite.now() + 2 * HOUR, "lease");
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: ISS, sub: "auth0|user_a", exp: Math.floor((satellite.now() + HOUR) / 1000) })).toString("base64url")}.x`;
    const base = { id: "cursor-a", harness: "cursor", label: "a", shareId: "share-cursor-0002", authorityNodeId: "authority-test", epoch: 1, expiresAt: Math.floor((satellite.now() + HOUR) / 1000) };
    for (const [label, files] of [
      ["extra field", [{ homeRelPath: "auth.json", contentB64: b64({ accessToken: token, note: "x" }), mode: 0o600 }]],
      ["api key", [{ homeRelPath: "auth.json", contentB64: b64({ accessToken: token, apiKey: "FAKE-API-KEY" }), mode: 0o600 }]],
      ["api key only", [{ homeRelPath: "auth.json", contentB64: b64({ apiKey: "FAKE-API-KEY" }), mode: 0o600 }]],
      ["alg none", [{ homeRelPath: "auth.json", contentB64: b64({ accessToken: unsigned }), mode: 0o600 }]],
      ["extra file", [{ homeRelPath: "auth.json", contentB64: b64({ accessToken: token }), mode: 0o600 }, { homeRelPath: "cli-config.json", contentB64: b64({}), mode: 0o600 }]],
    ] as const) {
      await assert.rejects(sat.installLease({ ...base, files: [...files] }), (error: unknown) => error instanceof RpcError && error.code === "invalid_request", label);
    }
    const ok = await sat.installLease({ ...base, files: [{ homeRelPath: "auth.json", contentB64: b64({ accessToken: token }), mode: 0o600 }] });
    assert.equal(ok.account.source, "leased");
  } finally {
    authority.cleanup();
    satellite.cleanup();
  }
});

test("cursor live store: the global auth.json is read without its API key", async () => {
  const r = rig("live");
  const saved = { path: process.env.HIVE_CURSOR_AUTH_PATH, nokc: process.env.HIVE_NO_KEYCHAIN };
  try {
    const path = join(r.dir, "global-auth.json");
    const token = fakeJwt("auth0|user_a", r.now() + HOUR, "g");
    writeFileSync(path, JSON.stringify({ accessToken: token, refreshToken: "FAKE-R", apiKey: "FAKE-API-KEY" }));
    process.env.HIVE_CURSOR_AUTH_PATH = path;
    process.env.HIVE_NO_KEYCHAIN = "1";
    const live = await readCursorLiveAuth();
    assert.equal(live?.accessToken, token);
    assert.equal(live?.refreshToken, "FAKE-R");
    assert.equal(live?.apiKey, undefined);
    assert.ok(!live!.raw.includes("FAKE-API-KEY"));
  } finally {
    if (saved.path === undefined) delete process.env.HIVE_CURSOR_AUTH_PATH; else process.env.HIVE_CURSOR_AUTH_PATH = saved.path;
    if (saved.nokc === undefined) delete process.env.HIVE_NO_KEYCHAIN; else process.env.HIVE_NO_KEYCHAIN = saved.nokc;
    r.cleanup();
  }
});

test("cursor Keychain snapshot: a token rotated between item reads is re-read, never paired with another login's refresh token", { skip: process.platform !== "darwin" }, async () => {
  const r = rig("keychain");
  const saved = { bin: process.env.HIVE_TEST_SECURITY_BIN, nokc: process.env.HIVE_NO_KEYCHAIN };
  try {
    // A fake `security` shim: the access token changes after its first read (a rotation mid-snapshot).
    const counter = join(r.dir, "access-reads");
    writeFileSync(counter, "0");
    const t1 = fakeJwt("auth0|user_a", r.now() + HOUR, "t1");
    const t2 = fakeJwt("auth0|user_a", r.now() + 2 * HOUR, "t2");
    const shim = join(r.dir, "security");
    writeFileSync(shim, `#!/bin/sh
case "$*" in
  *cursor-access-token*) n=$(cat ${counter}); echo $((n+1)) > ${counter}; if [ "$n" = "0" ]; then echo "${t1}"; else echo "${t2}"; fi ;;
  *cursor-refresh-token*) n=$(cat ${counter}); if [ "$n" = "1" ]; then echo "FAKE-R1"; else echo "FAKE-R2"; fi ;;
  *) exit 44 ;;
esac
`, { mode: 0o755 });
    process.env.HIVE_TEST_SECURITY_BIN = shim;
    delete process.env.HIVE_NO_KEYCHAIN;
    const live = await readCursorLiveAuth();
    assert.equal(live?.accessToken, t2, "the torn first snapshot was discarded");
    assert.equal(live?.refreshToken, "FAKE-R2");
    assert.equal(live?.apiKey, undefined, "the machine's Cursor API key is never read");
    assert.equal(readFileSync(counter, "utf8").trim(), "4", "four access reads: the torn pair, then the confirmed pair");
  } finally {
    if (saved.bin === undefined) delete process.env.HIVE_TEST_SECURITY_BIN; else process.env.HIVE_TEST_SECURITY_BIN = saved.bin;
    if (saved.nokc === undefined) delete process.env.HIVE_NO_KEYCHAIN; else process.env.HIVE_NO_KEYCHAIN = saved.nokc;
    r.cleanup();
  }
});

test("cursor usage URL: production unless a test harness env names an https override", async () => {
  const { cursorUsageUrl, CURSOR_USAGE_URL } = await import("../src/providerLimits.ts");
  assert.equal(CURSOR_USAGE_URL, "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage");
  assert.equal(cursorUsageUrl({ HIVE_CURSOR_USAGE_URL: "https://127.0.0.1:1/x" }), CURSOR_USAGE_URL, "ignored outside the test harness");
  assert.equal(cursorUsageUrl({ HIVE_TEST_PLATFORM: "linux", HIVE_CURSOR_USAGE_URL: "http://127.0.0.1:1/x" }), CURSOR_USAGE_URL, "refused when not https");
  assert.equal(cursorUsageUrl({ HIVE_TEST_PLATFORM: "linux", HIVE_CURSOR_USAGE_URL: "not a url" }), CURSOR_USAGE_URL);
  assert.equal(cursorUsageUrl({ HIVE_TEST_PLATFORM: "linux", HIVE_CURSOR_USAGE_URL: "https://127.0.0.1:1/x" }), "https://127.0.0.1:1/x");
});
