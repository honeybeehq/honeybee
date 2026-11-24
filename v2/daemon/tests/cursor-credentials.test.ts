/**
 * Cursor credentials: Honeybee re-captures Cursor's own machine-wide login
 * (which cursor-agent keeps fresh) instead of refreshing tokens itself.
 *  - a cached token near its JWT exp is re-captured before a probe / spawn;
 *    a fresh one costs no store read
 *  - a 401 triggers one forced re-capture and a second probe before
 *    auth_needed; with nothing newer the reason says log in
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
import { CursorStoreUnavailableError, cursorIdentityVerdict, cursorTokenIdentity, parseCursorAuth, readCursorLiveAuth, type CursorAuthSnapshot } from "../src/cursorAuth.ts";
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
  assert.deepEqual(cursorTokenIdentity({ accessToken: a }), { iss: ISS, sub: "auth0|user_a" });
  assert.equal(cursorTokenIdentity({ accessToken: "not-a-jwt" }), null);
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "none" })}.${b64({ iss: ISS, sub: "auth0|user_a", exp })}.sig` }), null, "alg none");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "NONE" })}.${b64({ iss: ISS, sub: "auth0|user_a", exp })}.sig` }), null, "alg NONE");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ iss: ISS, sub: "auth0|user_a", exp })}.` }), null, "unsigned");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ sub: "auth0|user_a", exp })}.sig` }), null, "no iss");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ iss: ISS, exp })}.sig` }), null, "no sub");
  assert.equal(cursorTokenIdentity({ accessToken: `${b64({ alg: "RS256" })}.${b64({ iss: ISS, sub: "auth0|user_a" })}.sig` }), null, "no exp");
  const held = { hasCredentials: true, identity: cursorTokenIdentity({ accessToken: a }) };
  assert.equal(cursorIdentityVerdict(held, authDoc(a2)), "same");
  assert.equal(cursorIdentityVerdict(held, authDoc(b)), "different");
  assert.equal(cursorIdentityVerdict(held, authDoc("opaque-token")), "unverified");
  // iss and sub are separate fields: the same sub from another issuer is another user.
  const otherIssuer = `${b64({ alg: "RS256" })}.${b64({ iss: "https://other-issuer.test", sub: "auth0|user_a", exp })}.sig`;
  assert.equal(cursorIdentityVerdict(held, authDoc(otherIssuer)), "different");
  assert.equal(cursorIdentityVerdict({ hasCredentials: false, identity: null }, authDoc(b)), "first", "first only with no credential at all");
  assert.equal(cursorIdentityVerdict({ hasCredentials: true, identity: null }, authDoc(b)), "unverified", "an identity-less credential is not a first capture");
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

test("cursor 401: one forced re-capture and a second probe keep the account ok; with nothing newer, auth_needed says log in", async () => {
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

    // Cursor's login holds nothing newer: auth_needed, and the reason says log in.
    const second = addCursor(r, "b", authDoc(fakeJwt("auth0|user_b", r.now() + 6 * HOUR, "b-revoked")));
    cursor.state.raw = authDoc(fakeJwt("auth0|user_b", r.now() + 6 * HOUR, "b-revoked"));
    await svc.refreshLimits([second.id]);
    const after = r.store.getAccount(second.id)!;
    assert.equal(after.status, "auth_needed");
    assert.ok(!(after.statusReason ?? "").includes("secret-body"), "no response body in the status reason");
    assert.ok(!r.log.join("\n").includes("secret-body"), "no response body in the log");
    assert.match(after.statusReason ?? "", /^limits probe: Cursor usage probe: HTTP 401; Cursor on this computer has no newer sign-in for this account; log in: hive account login cursor-b$/);
    const readiness = svc.credentialReadiness(after);
    assert.equal(readiness.ready, false);
    assert.match(readiness.ready ? "" : readiness.message, /log in: hive account login cursor-b/);
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
    await assert.rejects(service(authority, cursor).mintLease(dying), /expired or near expiry.*hive account login cursor-dying/);
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
    cursor.state.raw = authDoc(fakeJwt("auth0|user_c", r.now() + 7 * HOUR, "new-user"));
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
    assert.deepEqual(cursorTokenIdentity(shipped), { iss: ISS, sub: "auth0|user_a" });
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

test("cursor live store: the global auth.json is read for its access token only", async () => {
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
    assert.equal(live?.refreshToken, undefined, "the refresh token is never taken");
    assert.equal(live?.apiKey, undefined);
    assert.ok(!live!.raw.includes("FAKE-API-KEY") && !live!.raw.includes("FAKE-R"));
  } finally {
    if (saved.path === undefined) delete process.env.HIVE_CURSOR_AUTH_PATH; else process.env.HIVE_CURSOR_AUTH_PATH = saved.path;
    if (saved.nokc === undefined) delete process.env.HIVE_NO_KEYCHAIN; else process.env.HIVE_NO_KEYCHAIN = saved.nokc;
    r.cleanup();
  }
});

test("cursor Keychain: only the access-token item is read; never the refresh token or API key", { skip: process.platform !== "darwin" }, async () => {
  const r = rig("keychain");
  const saved = { bin: process.env.HIVE_TEST_SECURITY_BIN, nokc: process.env.HIVE_NO_KEYCHAIN };
  try {
    const calls = join(r.dir, "security-calls");
    const token = fakeJwt("auth0|user_a", r.now() + HOUR, "kc");
    const shim = join(r.dir, "security");
    writeFileSync(shim, `#!/bin/sh
echo "$*" | sed -n 's/.*-s \\([a-z-]*\\).*/\\1/p' >> ${calls}
case "$*" in
  *cursor-access-token*) echo "${token}" ;;
  *cursor-refresh-token*) echo "FAKE-R" ;;
  *cursor-api-key*) echo "FAKE-API-KEY" ;;
  *) exit 44 ;;
esac
`, { mode: 0o755 });
    process.env.HIVE_TEST_SECURITY_BIN = shim;
    delete process.env.HIVE_NO_KEYCHAIN;
    const live = await readCursorLiveAuth();
    assert.equal(live?.accessToken, token);
    assert.equal(live?.refreshToken, undefined);
    assert.equal(live?.apiKey, undefined);
    assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["cursor-access-token"], "one Keychain item read");
  } finally {
    if (saved.bin === undefined) delete process.env.HIVE_TEST_SECURITY_BIN; else process.env.HIVE_TEST_SECURITY_BIN = saved.bin;
    if (saved.nokc === undefined) delete process.env.HIVE_NO_KEYCHAIN; else process.env.HIVE_NO_KEYCHAIN = saved.nokc;
    r.cleanup();
  }
});

test("cursor capture: exactly the validated {accessToken} bytes land in vault and home; an identity-less credential needs --replace-account", async () => {
  const r = rig("bytes");
  try {
    const cursor = fakeCursorStore();
    const mine = fakeJwt("auth0|user_a", r.now() + HOUR, "mine");
    const account = addCursor(r, "a", authDoc(mine));
    const next = fakeJwt("auth0|user_a", r.now() + 4 * HOUR, "next");
    cursor.state.raw = authDoc(next, "FAKE-LIVE-REFRESH");
    await service(r, cursor).captureAccount(account);
    const expected = `${JSON.stringify({ accessToken: next }, null, 2)}\n`;
    assert.equal(readFileSync(join(r.vault, "cursor", account.id, "auth.json"), "utf8"), expected);
    assert.equal(readFileSync(join(account.homePath, "auth.json"), "utf8"), expected);

    const opaque = addCursor(r, "opaque", authDoc("opaque-token"));
    await assert.rejects(service(r, cursor).captureAccount(opaque), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "identity_unverified" && /current credential names no Cursor user/.test(error.message));
    await service(r, cursor).captureAccount(opaque, { replaceAccount: true });
    assert.equal(readFileSync(join(opaque.homePath, "auth.json"), "utf8"), expected);
  } finally {
    r.cleanup();
  }
});

test("cursor repair: an interrupted write is fixed up from the identity-bearing selection before probe, spawn and lease", async () => {
  const r = rig("repair");
  try {
    const cursor = fakeCursorStore();
    // A re-capture wrote the vault, then stopped before the home.
    const old = fakeJwt("auth0|user_a", r.now() + 2 * HOUR, "old");
    const newer = fakeJwt("auth0|user_a", r.now() + 5 * HOUR, "newer");
    const account = addCursor(r, "a", authDoc(old));
    writeFileSync(join(r.vault, "cursor", account.id, "auth.json"), `${JSON.stringify({ accessToken: newer }, null, 2)}\n`);
    const svc = service(r, cursor);
    assert.equal(svc.credentialEnvOf(account).CURSOR_AUTH_TOKEN, newer, "the spawn env uses the selection, not the stale home copy");
    await svc.activateForSpawn(account, { cwd: r.dir });
    assert.equal(homeToken(account), newer, "home repaired from the vault");
    assert.ok(r.log.some((line) => line === `account.cursor.repaired account=${account.id} copies=home from=vault`));

    // A replace wrote the vault (new user) and stopped before the home: the home follows the vault's user, never back.
    const replaced = addCursor(r, "b", authDoc(fakeJwt("auth0|user_a", r.now() + 9 * HOUR, "old-user")));
    const otherUser = fakeJwt("auth0|user_b", r.now() + HOUR, "new-user");
    writeFileSync(join(r.vault, "cursor", replaced.id, "auth.json"), `${JSON.stringify({ accessToken: otherUser }, null, 2)}\n`);
    const seen: string[] = [];
    const probing = service(r, cursor, { postJson: async (_url, headers) => { seen.push(headers.Authorization!); return usage(r); } });
    await probing.refreshLimits([replaced.id]);
    assert.deepEqual(seen, [`Bearer ${otherUser}`]);
    assert.equal(homeToken(replaced), otherUser);
  } finally {
    r.cleanup();
  }
});

test("cursor lock: the gate is judged again after taking the lock, before the store is read", async () => {
  const r = rig("lock");
  try {
    const cursor = fakeCursorStore();
    cursor.state.raw = authDoc(fakeJwt("auth0|user_a", r.now() + 9 * HOUR, "live"));
    const account = addCursor(r, "a", authDoc(fakeJwt("auth0|user_a", r.now() + 5 * MIN, "near")));
    const svc = service(r, cursor);
    let release!: () => void;
    const holding = svc.withCursorLock(account.id, () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setImmediate(resolve));
    const waiting = svc.recaptureCursor(account);
    // While the lock is held, a capture lands a fresh token.
    const fresh = `${JSON.stringify({ accessToken: fakeJwt("auth0|user_a", r.now() + 6 * HOUR, "fresh") }, null, 2)}\n`;
    writeFileSync(join(r.vault, "cursor", account.id, "auth.json"), fresh);
    writeFileSync(join(account.homePath, "auth.json"), fresh);
    release();
    await holding;
    assert.equal(await waiting, "fresh");
    assert.equal(cursor.state.reads, 0, "the store was not read once the token was fresh");
  } finally {
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

test("cursor foreign home: re-capture and repair never write a home outside Honeybee's account homes; the vault alone carries the newer token to probe, spawn and lease", async () => {
  const r = rig("foreign");
  try {
    const cursor = fakeCursorStore();
    const externalHome = join(r.dir, "external-cursor-home");
    mkdirSync(externalHome, { recursive: true });
    const old = fakeJwt("auth0|user_a", r.now() + 5 * MIN, "old");
    const homeBytes = authDoc(old);
    writeFileSync(join(externalHome, "auth.json"), homeBytes);
    const account = r.store.createAccount({ id: "cursor-ext", harness: "cursor", homePath: externalHome, label: "ext", status: "ok" });
    mkdirSync(join(r.vault, "cursor", account.id), { recursive: true });
    writeFileSync(join(r.vault, "cursor", account.id, "auth.json"), homeBytes);
    const fresh = fakeJwt("auth0|user_a", r.now() + 3 * HOUR, "fresh");
    cursor.state.raw = authDoc(fresh);
    const seen: string[] = [];
    const svc = service(r, cursor, { postJson: async (_url, headers) => { seen.push(headers.Authorization!); return usage(r); } });

    // Probe path: near expiry -> re-capture; only the vault is written.
    await svc.refreshLimits([account.id]);
    assert.deepEqual(seen, [`Bearer ${fresh}`], "the probe used the re-captured vault token");
    assert.equal(vaultToken(r, account), fresh);
    assert.equal(readFileSync(join(externalHome, "auth.json"), "utf8"), homeBytes, "the foreign home is untouched by re-capture");
    assert.ok(r.log.some((line) => line === `account.cursor.home_not_owned account=${account.id} writes=vault_only`));

    // Repair before probe, spawn env and lease: the copies differ, but the foreign home is still not written.
    await svc.refreshLimits([account.id]);
    assert.equal(svc.credentialEnvOf(account).CURSOR_AUTH_TOKEN, fresh, "spawn env uses the selection (vault)");
    const lease = await svc.mintLease(account);
    assert.deepEqual(JSON.parse(Buffer.from(lease.files[0]!.contentB64, "base64").toString("utf8")), { accessToken: fresh });
    assert.equal(readFileSync(join(externalHome, "auth.json"), "utf8"), homeBytes, "the foreign home is untouched by repair");
    assert.ok(!r.log.some((line) => line.startsWith(`account.cursor.repaired account=${account.id} copies=home`)));
  } finally {
    r.cleanup();
  }
});

test("cursor stale sign-in: capture and login refuse an expired token or the token that just got a 401, and the hint says log in", async () => {
  const r = rig("stale");
  try {
    const cursor = fakeCursorStore();
    const held = fakeJwt("auth0|user_a", r.now() + 6 * HOUR, "held");
    const account = addCursor(r, "a", authDoc(held));
    const svc = service(r, cursor, { postJson: async () => { throw new ProviderHttpError("/usage: HTTP 401", 401); } });

    const expired = fakeJwt("auth0|user_a", r.now() - MIN, "expired");
    cursor.state.raw = authDoc(expired);
    await assert.rejects(svc.captureAccount(account), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "credential_stale" && /expired/.test(error.message) && /hive account login cursor-a/.test(error.message));
    await assert.rejects(svc.captureAccount(account, { replaceAccount: true }), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "credential_stale");
    assert.equal(homeToken(account), held);
    assert.equal(vaultToken(r, account), held);
    const atExp = fakeJwt("auth0|user_a", r.now(), "at-exp");
    assert.deepEqual((({ ok, reason }) => ({ ok, reason }))(svc.persistCredentialCapture(account, "auth.json", authDoc(atExp), {}) as { ok: boolean; reason: string }), { ok: false, reason: "credential_stale" });

    cursor.state.raw = authDoc(held);
    await svc.refreshLimits([account.id]);
    const failed = r.store.getAccount(account.id)!;
    assert.equal(failed.status, "auth_needed");
    assert.match(failed.statusReason ?? "", /log in: hive account login cursor-a/);
    assert.doesNotMatch(failed.statusReason ?? "", /capture again/);
    await assert.rejects(svc.captureAccount(failed), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "credential_stale" && /just rejected/.test(error.message));
    assert.equal(r.store.getAccount(account.id)!.status, "auth_needed", "a refused capture does not report the account healthy");

    const fresh = fakeJwt("auth0|user_a", r.now() + 8 * HOUR, "fresh");
    cursor.state.raw = authDoc(fresh);
    const captured = await svc.captureAccount(failed);
    assert.equal(captured.account.status, "ok");
    assert.equal(homeToken(account), fresh);

    const absent = addCursor(r, "b", authDoc(fakeJwt("auth0|user_b", r.now() + 6 * HOUR, "b")));
    cursor.state.raw = null;
    await svc.refreshLimits([absent.id]);
    assert.match(r.store.getAccount(absent.id)!.statusReason ?? "", /log in: hive account login cursor-b/);
    assert.doesNotMatch(r.store.getAccount(absent.id)!.statusReason ?? "", /capture again/);
  } finally {
    r.cleanup();
  }
});

test("cursor first capture: a new account never silently adopts the Cursor user another local account already holds", async () => {
  const r = rig("first-dup");
  try {
    const cursor = fakeCursorStore();
    const token = fakeJwt("auth0|user_a", r.now() + 6 * HOUR, "a");
    addCursor(r, "a", authDoc(token));
    const added = r.store.createAccount({ id: "cursor-new", harness: "cursor", homePath: join(r.homes, "cursor-new"), label: "new", status: "auth_needed" });
    const svc = service(r, cursor);
    cursor.state.raw = authDoc(fakeJwt("auth0|user_a", r.now() + 7 * HOUR, "machine"));
    await assert.rejects(svc.captureAccount(added), (error: unknown) => error instanceof CredentialAuthorityError && error.reason === "different_account" && /already signed in as the Cursor user of cursor-a/.test(error.message) && /--replace-account/.test(error.message));
    assert.equal(existsSync(join(added.homePath, "auth.json")), false);
    assert.equal(existsSync(join(r.vault, "cursor", added.id, "auth.json")), false);
    assert.equal(r.store.getAccount(added.id)!.status, "auth_needed");

    const explicit = await svc.captureAccount(added, { replaceAccount: true });
    assert.equal(explicit.account.status, "ok", "--replace-account is the explicit way to share a user");

    const other = r.store.createAccount({ id: "cursor-other", harness: "cursor", homePath: join(r.homes, "cursor-other"), label: "other", status: "auth_needed" });
    cursor.state.raw = authDoc(fakeJwt("auth0|user_b", r.now() + 7 * HOUR, "b"));
    assert.equal((await svc.captureAccount(other)).account.status, "ok", "a user nobody holds is still a normal first sign-in");
  } finally {
    r.cleanup();
  }
});

test("cursor imported account: activation gives the home its cli-config.json, heals a home that already lost it, and never overwrites one", async () => {
  const r = rig("imported");
  try {
    const cursor = fakeCursorStore();
    const svc = service(r, cursor);
    const importedInto = (label: string, home: Record<string, string>): AccountRow => {
      const account = r.store.createAccount({ id: `cursor-${label}`, harness: "cursor", homePath: join(r.homes, `cursor-${label}`), label, status: "ok" });
      const vault = join(r.vault, "cursor", account.id);
      mkdirSync(vault, { recursive: true });
      mkdirSync(account.homePath, { recursive: true });
      writeFileSync(join(vault, "auth.json"), authDoc(fakeJwt(`auth0|${label}`, r.now() + 6 * HOUR, label)));
      writeFileSync(join(vault, "cli-config.json"), '{"from":"vault"}');
      for (const [file, body] of Object.entries(home)) writeFileSync(join(account.homePath, file), body);
      return account;
    };
    const config = (account: AccountRow) => readFileSync(join(account.homePath, "cli-config.json"), "utf8");

    const empty = importedInto("empty", {});
    await svc.activateForSpawn(empty, { cwd: r.dir });
    assert.equal(config(empty), '{"from":"vault"}');
    assert.ok(homeToken(empty));

    const healed = importedInto("healed", { "auth.json": authDoc(fakeJwt("auth0|healed", r.now() + 6 * HOUR, "healed")) });
    await svc.activateForSpawn(healed, { cwd: r.dir });
    assert.equal(config(healed), '{"from":"vault"}');

    const kept = importedInto("kept", { "auth.json": authDoc(fakeJwt("auth0|kept", r.now() + 6 * HOUR, "kept")), "cli-config.json": '{"from":"home"}' });
    await svc.activateForSpawn(kept, { cwd: r.dir });
    assert.equal(config(kept), '{"from":"home"}');
  } finally {
    r.cleanup();
  }
});

const settlesWithin = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`still blocked after ${ms}ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
};

test("cursor locked Keychain: a store read that never answers does not block a spawn or a probe; the cached token is used", async () => {
  const r = rig("locked");
  try {
    const nearExpiry = fakeJwt("auth0|user_a", r.now() + 5 * MIN, "near");
    const account = addCursor(r, "a", authDoc(nearExpiry));
    let reads = 0;
    const seen: string[] = [];
    const svc = new AccountsService({
      store: r.store,
      cfg: r.cfg,
      log: (op) => r.log.push(op),
      now: r.now,
      platform: "linux",
      keychainReader: async () => null,
      keychainWriter: async () => false,
      cursorAuthReader: () => { reads += 1; return new Promise(() => {}); },
      providerHttp: { getJson: async () => { throw new Error("unexpected GET"); }, postJson: async (_url, headers) => { seen.push(headers.Authorization!); return usage(r); } },
    });
    await settlesWithin(svc.activateForSpawn(account, { cwd: r.dir }), 5_000);
    assert.equal(homeToken(account), nearExpiry);
    assert.equal(svc.credentialEnvOf(account).CURSOR_AUTH_TOKEN, nearExpiry);
    const [row] = await settlesWithin(svc.refreshLimits([account.id]), 5_000);
    assert.equal(row!.readable, true);
    assert.deepEqual(seen, [`Bearer ${nearExpiry}`]);
    assert.ok(reads >= 2);
    assert.ok(r.log.some((line) => line === `account.cursor.recapture_store_unavailable account=${account.id}`));
    assert.equal(r.store.getAccount(account.id)!.status, "ok");
  } finally {
    r.cleanup();
  }
});

test("cursor locked Keychain: the real reader stops a hung security process at its short timeout", { skip: process.platform !== "darwin" }, async () => {
  const r = rig("hung-security");
  const saved = { bin: process.env.HIVE_TEST_SECURITY_BIN, nokc: process.env.HIVE_NO_KEYCHAIN };
  try {
    const shim = join(r.dir, "security");
    writeFileSync(shim, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    process.env.HIVE_TEST_SECURITY_BIN = shim;
    delete process.env.HIVE_NO_KEYCHAIN;
    const started = Date.now();
    await assert.rejects(settlesWithin(readCursorLiveAuth({ timeoutMs: 200 }), 5_000), CursorStoreUnavailableError);
    assert.ok(Date.now() - started < 3_000);
  } finally {
    if (saved.bin === undefined) delete process.env.HIVE_TEST_SECURITY_BIN; else process.env.HIVE_TEST_SECURITY_BIN = saved.bin;
    if (saved.nokc === undefined) delete process.env.HIVE_NO_KEYCHAIN; else process.env.HIVE_NO_KEYCHAIN = saved.nokc;
    r.cleanup();
  }
});

test("cursor expired sign-in: no spawn or probe ever starts with an expired token, whether re-capture found nothing or the Keychain did not answer; the account says log in", async () => {
  for (const shape of ["absent", "store_unavailable"] as const) {
    const r = rig(`expired-${shape}`);
    try {
      const expired = fakeJwt("auth0|user_a", r.now() - MIN, "expired");
      const account = addCursor(r, "a", authDoc(expired));
      const seen: string[] = [];
      const svc = new AccountsService({
        store: r.store,
        cfg: r.cfg,
        log: (op) => r.log.push(op),
        now: r.now,
        platform: "linux",
        keychainReader: async () => null,
        keychainWriter: async () => false,
        cursorAuthReader: shape === "absent" ? async () => null : () => new Promise(() => {}),
        providerHttp: { getJson: async () => { throw new Error("unexpected GET"); }, postJson: async (_url, headers) => { seen.push(headers.Authorization!); return usage(r); } },
      });
      await assert.rejects(settlesWithin(svc.activateForSpawn(account, { cwd: r.dir }), 5_000), (error: unknown) => error instanceof Error && /has expired; log in: hive account login cursor-a/.test(error.message), shape);
      const refused = r.store.getAccount(account.id)!;
      assert.equal(refused.status, "auth_needed", shape);
      assert.match(refused.statusReason ?? "", /log in: hive account login cursor-a/, shape);
      r.store.setAccountStatus(account.id, "ok", "test reset");
      const [row] = await settlesWithin(svc.refreshLimits([account.id]), 5_000);
      assert.equal(row!.readable, false, shape);
      assert.deepEqual(seen, [], `${shape}: the expired token never reaches Cursor`);
      assert.equal(r.store.getAccount(account.id)!.status, "auth_needed", shape);
      assert.match(r.store.getAccount(account.id)!.statusReason ?? "", /log in: hive account login cursor-a/, shape);
    } finally {
      r.cleanup();
    }
  }
});
