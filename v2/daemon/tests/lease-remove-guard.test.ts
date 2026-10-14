import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, replayAudit, recipeFor, type AccountRow } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";
import { AuthResume } from "../src/authResume.ts";
import { RpcError, type AccountLeaseRemoveResult, type AccountLeaseInstallParams } from "../src/protocol.ts";
import { assertLocalHandoffRpc, type RpcConn } from "../src/rpc.ts";
import type { KeychainState } from "../src/keychain.ts";

const hour = 3_600_000;
const at = Date.parse("2026-10-14T00:00:00Z");
function documentFor(harness: string): Record<string, unknown> {
  const token = randomUUID();
  const jwt = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor((at + hour) / 1000), sub: token })).toString("base64url")}.test`;
  const documents = new Map<string, Record<string, unknown>>([
    ["claude", { claudeAiOauth: { accessToken: token, expiresAt: at + hour, refreshToken: "" } }],
    ["codex", { tokens: { access_token: jwt, refresh_token: "", id_token: "test-id" } }],
    ["grok", { "https://auth.x.ai::test-client": { auth_mode: "oidc", oidc_issuer: "https://auth.x.ai", oidc_client_id: "test-client", key: token, expires_at: new Date(at + hour).toISOString(), refresh_token: "" } }],
    ["kimi", { api_key: token }],
    ["opencode", { "zai-coding-plan": { type: "api", key: token } }],
    ["muse", { schema_version: 1, providers: { meta: { api_key: token } } }],
  ]);
  return documents.get(harness)!;
}
function rig(harness = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "hb-lease-enrol-"));
  let clock = at;
  const config = { accounts: { vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0 } };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config));
  const cfg = loadNodeConfig(dir);
  let store = openCoreStore(join(dir, "core.sqlite3"), { now: () => clock });
  let keychain: KeychainState = { status: "unavailable" };
  let writes = 0;
  let removeFails = false;
  let beforeRead: (() => void) | undefined;
  let beforeRemove: (() => void) | undefined;
  const service = () => new AccountsService({ store, cfg, platform: "linux", now: () => clock, log: () => {}, keychainStateReader: async () => { beforeRead?.(); return keychain; }, keychainReader: async () => null, keychainWriter: async (_home, raw) => { writes++; if (keychain.status !== "unavailable") keychain = { status: "present", raw }; return keychain.status !== "unavailable"; }, keychainRemover: async () => { beforeRemove?.(); if (removeFails) return false; keychain = { status: "absent" }; return true; } });
  let accounts = service();
  const account = store.createAccount({ id: `${harness}-test-example.com`, harness, label: "test-example.com", homePath: join(cfg.accounts.homesDir, `${harness}-test-example.com`), status: "ok" });
  const primary = recipeFor(harness)!.credentialFiles[0]!;
  const raw = JSON.stringify(documentFor(harness));
  const put = (root: string, rel: string, value: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), value); };
  for (const root of [account.homePath, accounts.vaultDirOf(account)]) put(root, primary, raw);
  const input = (generation?: number): AccountLeaseInstallParams => ({ id: account.id, harness, label: account.label, shareId: "share-enrol-test", authorityNodeId: "authority-test", viaNodeId: "via-test", epoch: 1, ...(generation !== undefined ? { generation } : {}), expiresAt: Math.floor((clock + hour) / 1000), enrol: true, files: [{ homeRelPath: primary, contentB64: Buffer.from(JSON.stringify(documentFor(harness))).toString("base64"), mode: 0o600 }] });
  const hash = (root: string, rel: string) => existsSync(join(root, rel)) ? createHash("sha256").update(readFileSync(join(root, rel))).digest("hex").slice(0, 12) : null;
  const reopen = () => { store.close(); store = openCoreStore(join(dir, "core.sqlite3"), { now: () => clock }); accounts = service(); };
  return { dir, account, primary, input, put, hash, get store() { return store; }, get accounts() { return accounts; }, get writes() { return writes; }, setKeychain: (state: KeychainState) => { keychain = state; }, getKeychain: () => keychain, setRemoveFails: (value: boolean) => { removeFails = value; }, setBeforeRead: (run: () => void) => { beforeRead = run; }, setBeforeRemove: (run: () => void) => { beforeRemove = run; }, reopen, advance: (ms: number) => { clock += ms; }, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const refused = (error: unknown) => error instanceof RpcError && error.code === "account_lease_native_present" && error.details?.nativeChainPresent === true;
function nativeFor(harness: string) {
  const document = documentFor(harness);
  if (harness === "claude") (document.claudeAiOauth as Record<string, unknown>).refreshToken = randomUUID();
  else if (harness === "codex") (document.tokens as Record<string, unknown>).refresh_token = randomUUID();
  else if (harness === "grok") (Object.values(document)[0] as Record<string, unknown>).refresh_token = randomUUID();
  else return JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: randomUUID(), refresh_token: randomUUID() } } });
  return JSON.stringify(document);
}
for (const harness of ["claude", "codex", "grok", "muse"]) for (const location of ["home", "vault", "temporary", "vault-temporary"]) test(`lease remove preserves ${harness} native grant in ${location} before effects`, async () => {
  const r = rig(harness);
  try {
    await r.accounts.installLease(r.input(1));
    const root = location.startsWith("vault") ? r.accounts.vaultDirOf(r.account) : r.account.homePath;
    const rel = location.includes("temporary") ? `${r.primary}.tmp.${randomUUID()}` : r.primary;
    r.put(root, rel, nativeFor(harness));
    const before = r.hash(root, rel), snapshot = r.store.dumpState(), seq = r.store.lastAuditSeq();
    const check = await r.accounts.removeLease(r.account.id, { checkOnly: true });
    assert.equal(check.disposition, "native_preserved"); assert.equal(check.nativeChain.account, r.account.id); assert.equal(check.nativeChain.present, true);
    assert.match(check.message, /Sign the account out or back it up first/);
    await assert.rejects(r.accounts.removeLease(r.account.id), error => {
      assert.ok(refused(error)); assert.deepEqual((error as RpcError).details?.result, check); return true;
    });
    assert.equal(r.hash(root, rel), before); assert.deepEqual(r.store.dumpState(), snapshot); assert.equal(r.store.lastAuditSeq(), seq);
    assert.ok(!JSON.stringify(check).includes("refresh_token"));
  } finally { r.close(); }
});

test("lease remove sees a native mirror and Keychain independently of the vault", async () => {
  const c = rig("codex"), r = rig();
  try {
    await c.accounts.installLease(c.input(1));
    c.put(c.account.homePath, recipeFor("codex")!.activationMirrors![c.primary]!, nativeFor("codex"));
    await assert.rejects(c.accounts.removeLease(c.account.id), refused);
    await r.accounts.installLease(r.input(1));
    const raw = nativeFor("claude"); r.setKeychain({ status: "present", raw });
    const before = r.hash(r.account.homePath, r.primary);
    await assert.rejects(r.accounts.removeLease(r.account.id), refused);
    assert.equal(r.getKeychain().status, "present"); assert.equal(r.hash(r.account.homePath, r.primary), before);
  } finally { c.close(); r.close(); }
});

for (const harness of ["claude", "codex", "grok", "muse", "kimi", "opencode"]) test(`lease-only ${harness} removal and issued static proof stay compatible`, async () => {
  const r = rig(harness);
  try {
    await r.accounts.installLease(r.input(1));
    const seq = r.store.lastAuditSeq();
    const check = await r.accounts.removeLease(r.account.id, { checkOnly: true });
    assert.equal(check.disposition, "remove_allowed"); assert.equal(r.store.lastAuditSeq(), seq);
    const removed = await r.accounts.removeLease(r.account.id);
    assert.equal(removed.disposition, "revoked"); assert.equal(removed.nativeChain.present, false); assert.equal(removed.staticUnverified, undefined);
    assert.equal(existsSync(join(r.account.homePath, r.primary)), false);
    const after = r.store.lastAuditSeq(); await r.accounts.removeLease(r.account.id); assert.equal(r.store.lastAuditSeq(), after);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

for (const harness of ["muse", "kimi", "opencode"]) test(`changed issued static ${harness} key is preserved; explicit discard warns without provider revocation`, async () => {
  const r = rig(harness);
  try {
    await r.accounts.installLease(r.input(1));
    r.put(r.account.homePath, r.primary, JSON.stringify(documentFor(harness)));
    await assert.rejects(r.accounts.removeLease(r.account.id), refused);
    assert.throws(() => r.accounts.removeLease(r.account.id, { discardNative: true }), error => error instanceof RpcError && error.code === "invalid_request");
    const removed = await r.accounts.removeLease(r.account.id, { discardNative: true, confirm: true });
    assert.equal(removed.nativeChain.discarded, true); assert.equal(removed.nativeChain.present, false);
    assert.ok(removed.message.includes(r.account.id)); assert.match(removed.message, /stays valid until signed out at the provider/);
    assert.equal(r.store.auditRows().filter(row => row.kind === "account.lease.native_discard_authorised").length, 1);
    assert.equal(r.store.getLeaseMaterialProof(r.account.id)?.authorised.length, 0);
  } finally { r.close(); }
});

test("legacy static removes with explicit unverified fact; local keyed proofs never enter account mirrors or audit", async () => {
  const r = rig("muse"), p = rig("muse");
  try {
    r.store.setAccountLease(r.account.id, { shareId: "legacy", authorityNodeId: "legacy", epoch: 1, expiresAt: Math.floor((at + hour) / 1000), adoptedAt: null, revokedAt: null });
    const removed = await r.accounts.removeLease(r.account.id);
    assert.equal(removed.staticUnverified, true); assert.match(removed.message, /a user-replaced static key on a legacy row is removed/);
    await p.accounts.installLease(p.input(1));
    const proof = p.store.getLeaseMaterialProof(p.account.id)!;
    const wire = JSON.stringify({ account: p.store.getAccount(p.account.id), audit: p.store.auditRows(), dump: p.store.dumpState() });
    for (const value of Object.values(proof.issued)) assert.ok(!wire.includes(value));
    assert.ok(!wire.includes(proof.keyId));
  } finally { r.close(); p.close(); }
});

for (const missing of [true, false]) test(`keyed proof missing/rotated key ${missing} refuses without remint or deletion`, async () => {
  const r = rig("muse");
  try {
    await r.accounts.installLease(r.input(1));
    const path = join(r.accounts.vaultDirOf(r.account), "..", "..", ".lease-material-provenance.key");
    if (missing) rmSync(path); else writeFileSync(path, Buffer.alloc(32, 42));
    const before = r.hash(r.account.homePath, r.primary);
    await assert.rejects(r.accounts.removeLease(r.account.id), error => error instanceof RpcError && error.code === "account_lease_remove_unavailable" && error.details?.reason === "fingerprint_key_unavailable");
    assert.equal(r.hash(r.account.homePath, r.primary), before); if (missing) assert.equal(existsSync(path), false);
  } finally { r.close(); }
});

test("discard authorisation survives interrupted Keychain removal, retries once, new native login needs a new authorisation", async () => {
  const r = rig();
  try {
    await r.accounts.installLease(r.input(1));
    r.setKeychain({ status: "present", raw: nativeFor("claude") });
    r.put(r.account.homePath, r.primary, nativeFor("claude"));
    r.setRemoveFails(true);
    const run = () => r.accounts.removeLease(r.account.id, { discardNative: true, confirm: true });
    await assert.rejects(run()); await assert.rejects(run());
    assert.equal(r.store.auditRows().filter(row => row.kind === "account.lease.native_discard_authorised").length, 1);
    await assert.rejects(r.accounts.removeLease(r.account.id), refused);
    r.put(r.account.homePath, r.primary, nativeFor("claude"));
    await assert.rejects(run());
    assert.equal(r.store.auditRows().filter(row => row.kind === "account.lease.native_discard_authorised").length, 2);
    r.reopen(); r.setRemoveFails(false);
    const done = await run(); assert.equal(done.nativeChain.discarded, true);
    assert.equal(r.store.auditRows().filter(row => row.kind === "account.lease.native_discard_authorised").length, 2);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

test("native override ingress is direct local only; check-only remains a safe read on other lanes", () => {
  for (const ingress of [undefined, "remote", "node_relay"] as const) {
    const conn = { ingress } as RpcConn;
    for (const params of [{ id: "test", discardNative: true, confirm: true }, { id: "test", confirm: false }]) assert.throws(() => assertLocalHandoffRpc("account.lease.remove", params, conn), error => error instanceof RpcError && error.details?.reason === "local_required");
    assert.doesNotThrow(() => assertLocalHandoffRpc("account.lease.remove", { id: "test", checkOnly: true }, conn));
  }
});

test("lease proof schema migration from42 is local-only and restart durable", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-lease-proof-migration-"));
  const path = join(dir, "core.sqlite3");
  try {
    const old = openCoreStore(path); old.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE lease_material_proofs; UPDATE meta SET value = '42' WHERE key = 'schema_version'"); db.close();
    const store = openCoreStore(path);
    const account = store.createAccount({ id: "muse-test", harness: "muse", label: "test", homePath: join(dir, "home"), status: "ok" });
    assert.equal(store.getLeaseMaterialProof(account.id), null);
    store.putLeaseMaterialProof(account.id, "test-key-id", { "auth.json": "test-keyed-proof" }); store.close();
    const reopened = openCoreStore(path);
    assert.equal(reopened.getLeaseMaterialProof(account.id)?.issued["auth.json"], "test-keyed-proof");
    assert.ok(!JSON.stringify(reopened.dumpState()).includes("test-keyed-proof")); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const mode of ["issued", "changed", "legacy"]) test(`Muse OAuth without refresh token ${mode} is classified using local issuance proof`, async () => {
  const r = rig("muse");
  try {
    const raw = JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: randomUUID() } } });
    if (mode === "legacy") {
      r.store.setAccountLease(r.account.id, { shareId: "legacy", authorityNodeId: "legacy", epoch: 1, expiresAt: Math.floor((at + hour) / 1000), adoptedAt: null, revokedAt: null });
      r.put(r.account.homePath, r.primary, raw);
    } else {
      const input = r.input(1); input.files[0]!.contentB64 = Buffer.from(raw).toString("base64");
      await r.accounts.installLease(input);
      if (mode === "changed") r.put(r.account.homePath, r.primary, JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: randomUUID() } } }));
    }
    if (mode === "changed") await assert.rejects(r.accounts.removeLease(r.account.id), refused);
    else { const result = await r.accounts.removeLease(r.account.id); assert.equal(result.disposition, "revoked"); assert.equal(result.staticUnverified, mode === "legacy" ? true : undefined); }
  } finally { r.close(); }
});

test("a lost proof key does not block renewal; old rows stay protected until republished", async () => {
  const r = rig("muse");
  try {
    await r.accounts.installLease(r.input(1));
    const old = r.store.getLeaseMaterialProof(r.account.id)!;
    const path = join(r.accounts.vaultDirOf(r.account), "..", "..", ".lease-material-provenance.key");
    assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    rmSync(path);
    await r.accounts.installLease({ ...r.input(2), enrol: undefined });
    assert.notEqual(r.store.getLeaseMaterialProof(r.account.id)!.keyId, old.keyId);
    assert.equal((await r.accounts.removeLease(r.account.id)).disposition, "revoked");
  } finally { r.close(); }
});

test("native backup and unrelated enrolled profiles survive an explicit native discard", async () => {
  const r = rig();
  try {
    await r.accounts.installLease(r.input(1));
    const backup = join(r.accounts.vaultDirOf(r.account), "..", "..", ".native-backup", r.account.id);
    r.put(backup, "saved.json", nativeFor("claude")); const before = r.hash(backup, "saved.json");
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) r.put(root, "settings.json", '{"theme":"untouched"}');
    r.put(r.account.homePath, r.primary, nativeFor("claude"));
    const removed = await r.accounts.removeLease(r.account.id, { discardNative: true, confirm: true });
    assert.equal(removed.nativeBackupKept, true); assert.equal(r.hash(backup, "saved.json"), before);
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) assert.equal(readFileSync(join(root, "settings.json"), "utf8"), '{"theme":"untouched"}');
  } finally { r.close(); }
});

for (const boundary of ["read", "remove"]) test(`native login arriving at awaited Keychain ${boundary} is preserved on the final scan`, async () => {
  const r = rig();
  try {
    const input = r.input(1); await r.accounts.installLease(input);
    r.setKeychain({ status: "present", raw: Buffer.from(input.files[0]!.contentB64, "base64").toString("utf8") });
    const native = nativeFor("claude"), vaultBefore = r.hash(r.accounts.vaultDirOf(r.account), r.primary);
    const write = () => r.put(r.account.homePath, r.primary, native);
    if (boundary === "read") r.setBeforeRead(write); else r.setBeforeRemove(write);
    await assert.rejects(r.accounts.removeLease(r.account.id), error => {
      assert.ok(refused(error));
      if (boundary === "remove") { assert.equal(((error as RpcError).details?.result as AccountLeaseRemoveResult).keychainRemoved, true); assert.match((error as Error).message, /Keychain copy is already gone/); }
      return true;
    });
    assert.ok(readFileSync(join(r.account.homePath, r.primary)).equals(Buffer.from(native)), "new native material is preserved");
    assert.equal(r.hash(r.accounts.vaultDirOf(r.account), r.primary), vaultBefore);
    assert.equal(r.store.getAccount(r.account.id)?.leasedFrom?.revokedAt, null);
  } finally { r.close(); }
});

for (const kind of ["invalid", "symlink"]) test(`lease removal refuses ${kind} storage before effects`, async () => {
  const r = rig();
  try {
    await r.accounts.installLease(r.input(1)); const home = join(r.account.homePath, r.primary);
    if (kind === "invalid") writeFileSync(home, "not-json");
    else { const target = join(r.dir, "foreign.json"); writeFileSync(target, nativeFor("claude")); rmSync(home); symlinkSync(target, home); }
    const seq = r.store.lastAuditSeq(), vaultBefore = r.hash(r.accounts.vaultDirOf(r.account), r.primary);
    await assert.rejects(r.accounts.removeLease(r.account.id), error => error instanceof RpcError && ["account_lease_remove_unavailable", "invalid_request"].includes(error.code));
    assert.equal(r.store.lastAuditSeq(), seq); assert.equal(r.hash(r.accounts.vaultDirOf(r.account), r.primary), vaultBefore);
  } finally { r.close(); }
});

for (const harness of ["claude", "codex"]) test(`MCP OAuth refresh grants do not masquerade as the ${harness} provider login`, async () => {
  const r = rig(harness);
  try {
    const input = r.input(1); const doc = JSON.parse(Buffer.from(input.files[0]!.contentB64, "base64").toString("utf8"));
    doc.mcpOAuth = { linear: { accessToken: randomUUID(), refreshToken: randomUUID() } };
    await r.accounts.installLease(input);
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) r.put(root, r.primary, JSON.stringify(doc));
    assert.doesNotThrow(() => r.accounts.assertNoNewNativeTakeover(r.account));
    assert.equal((await r.accounts.removeLease(r.account.id, { checkOnly: true })).disposition, "remove_allowed");
    await r.accounts.scrubHandoff(r.store.getAccount(r.account.id)!);
    assert.equal((await r.accounts.removeLease(r.account.id)).disposition, "revoked");
  } finally { r.close(); }
});

for (const harness of ["muse", "kimi", "opencode"]) for (const missing of [true, false]) test(`confirmed ${harness} discard recovers missing or changed proof key ${missing}`, async () => {
  const r = rig(harness);
  try {
    await r.accounts.installLease(r.input(1));
    const proof = r.store.getLeaseMaterialProof(r.account.id)!;
    const path = join(r.accounts.vaultDirOf(r.account), "..", "..", ".lease-material-provenance.key");
    if (missing) rmSync(path); else writeFileSync(path, Buffer.alloc(32, 42));
    await assert.rejects(r.accounts.removeLease(r.account.id), error => error instanceof RpcError && error.details?.reason === "fingerprint_key_unavailable");
    const removed = await r.accounts.removeLease(r.account.id, { discardNative: true, confirm: true });
    assert.equal(removed.nativeChain.discarded, true); assert.match(removed.message, /stays valid until signed out/);
    assert.equal(r.store.auditRows().filter(row => row.kind === "account.lease.native_discard_authorised").length, 1);
    assert.equal(r.store.getLeaseMaterialProof(r.account.id)?.keyId, proof.keyId, "issuance key identity is not relabelled by discard authorisation");
  } finally { r.close(); }
});

test("non-JSON ancillary Claude profiles do not wedge lease removal or the handoff guard", async () => {
  const r = rig();
  try {
    const input = r.input(1); input.enrol = undefined;
    await r.accounts.installLease(r.input(1));
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) { r.put(root, "settings.json", "not-json-settings"); r.put(root, ".claude.json", "not-json-profile"); }
    assert.doesNotThrow(() => r.accounts.assertNoNewNativeTakeover(r.account));
    assert.equal((await r.accounts.removeLease(r.account.id, { checkOnly: true })).disposition, "remove_allowed");
    assert.equal((await r.accounts.removeLease(r.account.id)).disposition, "revoked");
    assert.equal(readFileSync(join(r.account.homePath, "settings.json"), "utf8"), "not-json-settings");
  } finally { r.close(); }
});

test("unrecognised Grok document shape is unavailable, never mislabelled native by a generic MCP walk", async () => {
  const r = rig("grok");
  try {
    await r.accounts.installLease(r.input(1));
    const doc = documentFor("grok"); doc.mcpOAuth = { linear: { refreshToken: randomUUID() } };
    r.put(r.account.homePath, r.primary, JSON.stringify(doc));
    assert.throws(() => r.accounts.assertNoNewNativeTakeover(r.account), error => error instanceof RpcError && error.code === "credential_handoff_unavailable");
    const before = r.hash(r.account.homePath, r.primary);
    await assert.rejects(r.accounts.removeLease(r.account.id, { checkOnly: true }), error => error instanceof RpcError && error.code === "account_lease_remove_unavailable" && error.details?.reason === "invalid_material");
    assert.equal(r.hash(r.account.homePath, r.primary), before);
  } finally { r.close(); }
});

for (const harness of ["codex", "grok"]) test(`lease-only ${harness} API-key material bypasses OAuth-null rejection and remains removable`, async () => {
  const r = rig(harness);
  try {
    const document = harness === "codex" ? { OPENAI_API_KEY: randomUUID(), tokens: null } : { "provider-api-key": { auth_mode: "api_key", key: randomUUID() } };
    const input = { ...r.input(1), enrol: undefined, files: [{ homeRelPath: r.primary, contentB64: Buffer.from(JSON.stringify(document)).toString("base64"), mode: 0o600 }] };
    const installed = await r.accounts.installLease(input);
    assert.doesNotThrow(() => r.accounts.assertNoNewNativeTakeover(installed.account));
    assert.equal((await r.accounts.removeLease(installed.account.id, { checkOnly: true })).disposition, "remove_allowed");
    assert.equal((await r.accounts.removeLease(installed.account.id)).disposition, "revoked");
  } finally { r.close(); }
});
