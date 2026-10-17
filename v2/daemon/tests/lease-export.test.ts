import { knownAccountLease } from "../../core/src/accountLease.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, lstatSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, replayAudit, recipeFor, type AccountLeaseOrigin, type CredentialHandoffRecord } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";
import { AuthResume } from "../src/authResume.ts";
import { RpcError } from "../src/protocol.ts";
import { hasRefreshGrant } from "../src/leaseMaterial.ts";
import { assertLocalHandoffRpc, type RpcConn } from "../src/rpc.ts";

const at = Date.parse("2026-10-14T00:00:00Z"), hour = 3_600_000;
function fixture(harness = "claude", local = false) {
  const dir = mkdtempSync(join(tmpdir(), "hb-lease-export-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { now: () => at });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0 } }));
  const cfg = loadNodeConfig(dir);
  let forbiddenCalls = 0;
  const forbidden = async (): Promise<never> => { forbiddenCalls++; throw new Error("Export must not invoke a provider or publisher"); };
  const accounts = new AccountsService({ store, cfg, now: () => at, log: () => {}, platform: "linux", keychainReader: forbidden, keychainStateReader: forbidden, keychainWriter: forbidden,
    fetchers: { claudeRefresh: forbidden, claudeIdentity: forbidden, codexRateLimits: forbidden } });
  accounts.mintLease = forbidden;
  for (const harness of ["claude", "codex", "grok"]) accounts.authorityFor({ harness })!.ensure = forbidden;
  const token = randomUUID();
  const jwt = `e30.${Buffer.from(JSON.stringify({ sub: token, exp: Math.floor((at + hour) / 1000) })).toString("base64url")}.test`;
  const docs = new Map<string, Record<string, unknown>>([
    ["claude", { claudeAiOauth: { accessToken: token, refreshToken: "", expiresAt: at + hour } }],
    ["codex", { OPENAI_API_KEY: null, tokens: { access_token: jwt, refresh_token: "", id_token: "test" } }],
    ["grok", { "https://auth.x.ai::client": { auth_mode: "oidc", oidc_issuer: "https://auth.x.ai", oidc_client_id: "client", key: token, expires_at: new Date(at + hour).toISOString() } }],
    ["kimi", { api_key: token }], ["muse", { schema_version: 1, providers: { meta: { api_key: token } } }],
  ]);
  const account = store.createAccount({ id: `${harness}-holder`, harness, label: "holder", homePath: join(dir, "homes", `${harness}-holder`), status: "ok" });
  const primary = recipeFor(harness)!.credentialFiles[0]!;
  const document = docs.get(harness)!;
  const put = (root: string, value: unknown) => { mkdirSync(join(root, primary, ".."), { recursive: true }); writeFileSync(join(root, primary), JSON.stringify(value)); };
  for (const root of [account.homePath, accounts.vaultDirOf(account)]) put(root, document);
  const origin: AccountLeaseOrigin = { authorityNodeId: "original-authority", authorityInstanceId: randomUUID(), shareId: "original-share", epoch: 4, generation: 9, expiresAt: Math.floor((at + hour) / 1000), materialPublished: true, adoptedAt: null, revokedAt: null, viaNodeId: "original-via" };
  if (!local) store.setAccountLease(account.id, origin);
  const snapshot = () => [account.homePath, accounts.vaultDirOf(account)].map(root => readdirSync(root, { recursive: true }).map(String).filter(rel => lstatSync(join(root, rel)).isFile()).sort().map(rel => [rel, createHash("sha256").update(readFileSync(join(root, rel))).digest("hex").slice(0, 12)]));
  const handoff = (role: CredentialHandoffRecord["role"], state: CredentialHandoffRecord["state"], retained = false) => store.putCredentialHandoff({ handoffId: "held-claim", role, state, account: account.id, binding: { handoffId: "held-claim", sourceAccount: account.id, targetAccount: account.id, harness, generation: 9, epoch: 4, from: { nodeId: "source", deviceKey: "source-identity" }, to: { nodeId: "target", deviceKey: "target-identity" }, sourceKey: "source-public-key", targetKey: "target-public-key", materialDigest: "test-digest", since: at, prepareBy: at + hour, claimId: "test-claim" }, receipt: null, generation: null, expiresAt: null, scrubbed: false, ...(retained ? { adoptionRecovery: { retainedGeneration: 10, retainedUnusableCount: 1 } } : {}) });
  return { dir, store, accounts, account, primary, document, origin, token, put, snapshot, handoff, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); assert.equal(forbiddenCalls, 0, "no provider, mint or publisher call"); } };
}
const refusal = (reason: string, state?: string) => (error: unknown) => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === reason && (state === undefined || error.details?.state === state);

for (const harness of ["claude", "codex", "grok"]) test(`leased export ${harness}: ephemeral current access only, original scope/expiry, one redacted audit per call`, async () => {
  const r = fixture(harness);
  try {
    const before = r.snapshot();
    const first = await r.accounts.exportLeasedMaterial(r.account.id);
    const second = await r.accounts.exportLeasedMaterial(r.account.id);
    assert.ok(first !== second, "fresh result object per call"); assert.ok(first.files !== second.files, "fresh file array per call");
    for (const result of [first, second]) {
      assert.equal(result.authorityNodeId, r.origin.authorityNodeId); assert.equal(result.authorityInstanceId, r.origin.authorityInstanceId);
      assert.equal(result.shareId, r.origin.shareId); assert.equal(result.epoch, 4); assert.equal(result.generation, 9); assert.equal(result.expiresAt, r.origin.expiresAt);
      assert.equal(result.files.length, 1); assert.equal(result.files[0]!.homeRelPath, r.primary); assert.equal(result.files[0]!.mode, 0o600);
      const doc = JSON.parse(Buffer.from(result.files[0]!.contentB64, "base64").toString("utf8"));
      assert.equal(hasRefreshGrant(doc), false);
      assert.ok(r.accounts.authorityFor(r.account)!.parseDocument(doc)?.accessToken === r.accounts.authorityFor(r.account)!.parseDocument(r.document)?.accessToken, "same published access token");
    }
    assert.deepEqual(r.snapshot(), before);
    const audits = r.store.auditRows().filter(row => row.kind === "account.lease.exported");
    assert.equal(audits.length, 2);
    assert.ok(!JSON.stringify(audits).includes(r.token), "no access bytes in ledger");
    assert.ok(!JSON.stringify(audits).includes(first.files[0]!.contentB64), "no artifact in ledger");
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

for (const reason of ["revoked", "expired", "publication_pending", "generation_missing", "instance_missing", "unbounded_expiry", "paused", "account_auth_needed"]) test(`leased export refuses ${reason} without effects`, async () => {
  const r = fixture();
  try {
    const changes: Record<string, Partial<AccountLeaseOrigin>> = { revoked: { revokedAt: at }, expired: { expiresAt: at / 1000 }, publication_pending: { materialPublished: false }, generation_missing: { generation: undefined }, instance_missing: { authorityInstanceId: undefined }, unbounded_expiry: { expiresAt: null } };
    if (changes[reason]) r.store.setAccountLease(r.account.id, { ...r.origin, ...changes[reason] });
    if (reason === "paused") r.store.pauseAccount(r.account.id, { by: "quota", owner: "test" });
    if (reason === "account_auth_needed") r.store.setAccountStatus(r.account.id, "auth_needed");
    const before = r.store.dumpState(), files = r.snapshot();
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal(reason === "unbounded_expiry" ? "unsupported" : reason, reason === "unbounded_expiry" ? reason : undefined));
    assert.deepEqual(r.store.dumpState(), before); assert.deepEqual(r.snapshot(), files);
    assert.equal(r.store.auditRows().filter(row => row.kind === "account.lease.exported").length, 0);
  } finally { r.close(); }
});

for (const harness of ["claude", "kimi", "muse"]) test(`leased export refuses local/native/central/static ${harness}`, async () => {
  const r = fixture(harness, true);
  try {
    if (harness === "claude") r.store.putAccountCredentialAuthority({ account: r.account.id, phase: "ready", generation: 9, expiresAt: at + hour, operationKey: null });
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("not_leased"));
  } finally { r.close(); }
});

for (const shape of ["missing", "corrupt", "mismatch", "refresh", "symlink", "expiry"]) test(`leased export fails closed on ${shape} primary`, async () => {
  const r = fixture();
  try {
    const path = join(r.account.homePath, r.primary);
    if (shape === "missing") rmSync(path);
    if (shape === "corrupt") writeFileSync(path, "{bad");
    if (shape === "mismatch") r.put(r.account.homePath, { claudeAiOauth: { accessToken: randomUUID(), expiresAt: at + hour } });
    if (shape === "refresh") r.put(r.account.homePath, { ...r.document, nested: { refresh_token: randomUUID() } });
    if (shape === "symlink") { rmSync(path); symlinkSync(join(r.accounts.vaultDirOf(r.account), r.primary), path); }
    if (shape === "expiry") for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) r.put(root, { claudeAiOauth: { accessToken: r.token, expiresAt: at + hour / 2 } });
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("material_unavailable"));
  } finally { r.close(); }
});

for (const [role, state, retained] of [["source", "exported", false], ["source", "prepared", false], ["source", "committed", false], ["destination", "preparing", false], ["destination", "prepared", false], ["destination", "adopting", false], ["destination", "adopting", true], ["destination", "failed", false]] as const) test(`leased export refuses handoff ${role}/${state}/${retained}`, async () => {
  const r = fixture();
  try { r.handoff(role, state, retained); await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("handoff", retained ? "retained_unusable" : state)); }
  finally { r.close(); }
});

test("leased export refuses a live authority lane then succeeds after it settles", async () => {
  const r = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = r.accounts.authorityFor(r.account)!.handoffLane(r.account, "adopt:held", () => gate, { kind: "adopt", handoffId: "held" });
  try {
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("authority_busy", "adopt"));
    release(); await held;
    assert.equal((await r.accounts.exportLeasedMaterial(r.account.id)).generation, 9);
  } finally { release(); await held; r.close(); }
});

test("leased export waits for install publication and remove, and never reads their stale pre-lane origin", async () => {
  const r = fixture();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const keychain = r.accounts.leaseMaterialCodecs.get("claude")!.keychain!;
  const original = keychain.publish;
  let install: Promise<unknown> | undefined;
  let exported: Promise<unknown> | undefined;
  try {
    keychain.read = async () => ({ status: "unavailable" });
    keychain.publish = async account => { entered(); await gate; for (const root of [account.homePath, r.accounts.vaultDirOf(account)]) r.put(root, r.document); return false; };
    install = r.accounts.installLease({ id: r.account.id, adopt: true, harness: "claude", label: "holder", shareId: r.origin.shareId, authorityNodeId: r.origin.authorityNodeId, authorityInstanceId: r.origin.authorityInstanceId, epoch: 4, generation: 10, expiresAt: r.origin.expiresAt, files: [{ homeRelPath: r.primary, contentB64: Buffer.from(JSON.stringify(r.document)).toString("base64"), mode: 0o600 }] }, account => { r.store.setAccountStatus(account.id, "ok"); });
    await ready;
    exported = r.accounts.exportLeasedMaterial(r.account.id);
    let resolved = false; void exported.then(() => { resolved = true; }, () => { resolved = true; });
    await Promise.resolve(); assert.equal(resolved, false);
    release(); await install;
    const result = await exported as { generation: number }; assert.equal(result.generation, 10);
    keychain.publish = original;
    keychain.remove = async () => false;
    const removed = r.accounts.removeLease(r.account.id);
    const next = r.accounts.exportLeasedMaterial(r.account.id);
    await removed; await assert.rejects(next, refusal("revoked"));
  } finally { release(); await Promise.allSettled([install, exported]); r.close(); }
});

test("leased export refuses unclaimed auth recovery, permits claimed idle or spawn-failed receipt and deadline-released legacy", async () => {
  const r = fixture();
  try {
    const bee = r.store.createBee({ name: "auth", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id }).bee;
    const material = r.accounts.authDeathMaterial(r.store.getAccount(r.account.id)!)!;
    r.store.stampRuntimeCredential(bee.id, 1, { material, revision: "old", account: r.account.id, agent: bee.agent, cwd: bee.cwd, cellId: bee.cellId, controlFence: 0 });
    r.store.updateRuntimeState(bee.id, 1, "running");
    const resume = new AuthResume({ store: r.store, now: () => at, log: () => {}, accountForGeneration: () => r.store.getAccount(r.account.id), credentialRevision: () => "new", material: account => r.accounts.authDeathMaterial(account) });
    resume.interrupted({ beeId: bee.id, generation: 1, flag: "auth_needed", action: "set", detail: "auth" });
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("auth_recovery", "waiting_for_exit"));
    r.store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" }); resume.reconcile();
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("auth_recovery", "waiting_for_material"));
    r.store.setAccountLease(r.account.id, { ...r.origin, generation: 10 }); resume.reconcile();
    assert.notEqual(r.store.liveAuthInterruption(bee.id)?.deathRecovery?.claimedAt, null);
    assert.equal((await r.accounts.exportLeasedMaterial(r.account.id)).generation, 10);
    r.store.setFlag(bee.id, "spawn_failed", "fake blocked start");
    assert.equal((await r.accounts.exportLeasedMaterial(r.account.id)).generation, 10);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

test("leased export ingress is direct local Unix only, missing facts fail closed", () => {
  for (const ingress of [undefined, "remote", "node_relay"] as const) assert.throws(() => assertLocalHandoffRpc("account.lease.export", {}, { ingress } as RpcConn), refusal("local_required"));
  assert.doesNotThrow(() => assertLocalHandoffRpc("account.lease.export", {}, { ingress: "local_unix" } as RpcConn));
});

for (const versioned of [false, true]) test(`leased export enrolled live row ${versioned ? "scoped" : "generationless"} coverage pending`, async () => {
  const r = fixture();
  try {
    r.store.setAccountLease(r.account.id, { ...r.origin, ...(versioned ? {} : { generation: undefined }), enrolment: { id: randomUUID(), at, liveRuntimeCoveragePending: 1 } });
    if (versioned) assert.equal((await r.accounts.exportLeasedMaterial(r.account.id)).generation, 9);
    else await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("generation_missing"));
  } finally { r.close(); }
});

test("leased export permits a deadline-released unclaimed candidate and does not require historical auth receipt settlement", async () => {
  const r = fixture();
  try {
    const bee = r.store.createBee({ name: "released", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id }).bee;
    const stamp = { material: r.accounts.authDeathMaterial(r.store.getAccount(r.account.id)!)!, revision: "old", account: r.account.id, agent: bee.agent, cwd: bee.cwd, cellId: bee.cellId, controlFence: 0 };
    r.store.stampRuntimeCredential(bee.id, 1, stamp);
    const row = r.store.recordAuthInterruption({ beeId: bee.id, account: r.account.id, generation: 1, messageIds: [], turnProgress: "unknown", credentialRevision: "old", detail: "auth" });
    r.store.setAuthDeathRecovery(row.id, { admitted: stamp, deathAt: at - 600_000, deadline: at, claimedAt: null, replacement: null, commandId: null });
    r.store.releaseAuthDeathRecovery(row.id, "deadline_expired");
    assert.equal((await r.accounts.exportLeasedMaterial(r.account.id)).generation, 9);
  } finally { r.close(); }
});

test("leased export refuses the current known-failed legacy revision, then permits a changed publication", async () => {
  const r = fixture();
  try {
    const bee = r.store.createBee({ name: "blocked", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id }).bee;
    const revision = r.accounts.credentialRevision(r.account);
    const input = { beeId: bee.id, account: r.account.id, generation: 1, messageIds: [], turnProgress: "unknown" as const, credentialRevision: revision, detail: "auth" };
    const row = r.store.recordAuthInterruption(input);
    r.store.restoreAuthInterruption(row.id, { revision, by: "credentials_restored" });
    r.store.resumeAuthInterruption(row.id, "continue");
    r.store.recordAuthInterruption(input);
    assert.equal(r.store.liveAuthInterruption(bee.id)?.blockedRevision, revision);
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("account_auth_needed", "blocked_revision"));
    const next = { claudeAiOauth: { accessToken: randomUUID(), refreshToken: "", expiresAt: at + hour } };
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) r.put(root, next);
    r.store.setAccountLease(r.account.id, { ...r.origin, generation: 10 });
    assert.equal((await r.accounts.exportLeasedMaterial(r.account.id)).generation, 10);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

test("leased export copies only stored bounded fence provenance and refuses a forwarded row", async () => {
  const r = fixture();
  try {
    r.store.setAccountLease(r.account.id, { ...r.origin, retiredAuthorityInstanceIds: ["older-A", "older-B"], authorityGenerationFloor: 9, legacyAuthorityInstanceId: "remembered-instance", legacyAuthorityGenerationFloor: 12 });
    const exported = await r.accounts.exportLeasedMaterial(r.account.id);
    assert.deepEqual(exported.retiredAuthorityInstanceIds, ["older-A", "older-B"]);
    assert.equal(exported.authorityGenerationFloor, 9);
    assert.equal(exported.legacyAuthorityInstanceId, "remembered-instance");
    assert.equal(exported.legacyAuthorityGenerationFloor, 12);
    assert.equal(exported.fencesForwarded, false);
    r.store.setAccountLease(r.account.id, { ...knownAccountLease(r.store.getAccount(r.account.id)!)!, fencesForwarded: true });
    const seq = r.store.lastAuditSeq();
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), refusal("forwarding_depth_exceeded"));
    assert.equal(r.store.lastAuditSeq(), seq);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});
