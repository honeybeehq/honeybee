import { knownAccountLease } from "../../core/src/accountLease.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, replayAudit, recipeFor, type AccountRow } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";
import { AuthResume } from "../src/authResume.ts";
import { RpcError, type AccountLeaseInstallParams } from "../src/protocol.ts";
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
  const service = () => new AccountsService({ store, cfg, platform: "linux", now: () => clock, log: () => {}, keychainStateReader: async () => keychain, keychainReader: async () => null, keychainWriter: async (_home, raw) => { writes++; if (keychain.status !== "unavailable") keychain = { status: "present", raw }; return keychain.status !== "unavailable"; }, keychainRemover: async () => { keychain = { status: "absent" }; return true; } });
  let accounts = service();
  const account = store.createAccount({ id: `${harness}-test-example.com`, harness, label: "test-example.com", homePath: join(cfg.accounts.homesDir, `${harness}-test-example.com`), status: "ok" });
  const primary = recipeFor(harness)!.credentialFiles[0]!;
  const raw = JSON.stringify(documentFor(harness));
  const put = (root: string, rel: string, value: string) => { mkdirSync(join(root, rel, ".."), { recursive: true }); writeFileSync(join(root, rel), value); };
  for (const root of [account.homePath, accounts.vaultDirOf(account)]) put(root, primary, raw);
  const input = (generation?: number): AccountLeaseInstallParams => ({ id: account.id, harness, label: account.label, shareId: "share-enrol-test", authorityNodeId: "authority-test", viaNodeId: "via-test", epoch: 1, ...(generation !== undefined ? { generation } : {}), expiresAt: Math.floor((clock + hour) / 1000), enrol: true, files: [{ homeRelPath: primary, contentB64: Buffer.from(JSON.stringify(documentFor(harness))).toString("base64"), mode: 0o600 }] });
  const hash = (root: string, rel: string) => existsSync(join(root, rel)) ? createHash("sha256").update(readFileSync(join(root, rel))).digest("hex").slice(0, 12) : null;
  const reopen = () => { store.close(); store = openCoreStore(join(dir, "core.sqlite3"), { now: () => clock }); accounts = service(); };
  return { dir, account, primary, input, put, hash, get store() { return store; }, get accounts() { return accounts; }, get writes() { return writes; }, setKeychain: (state: KeychainState) => { keychain = state; }, getKeychain: () => keychain, reopen, advance: (ms: number) => { clock += ms; }, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const refused = (reason: string) => (error: unknown) => error instanceof RpcError && error.code === "account_lease_enrol_refused" && error.details?.reason === reason;

for (const harness of ["claude", "codex", "grok", "kimi", "opencode", "muse"]) test(`lease enrol ${harness}: same live row, stable receipt, renewal route continuity, revoke preserves profiles`, async () => {
  const r = rig(harness);
  try {
    const bee = r.store.createBee({ name: "existing", agent: harness, substrate: "hsr", cwd: r.dir, account: r.account.id }).bee;
    r.store.updateRuntimeState(bee.id, 1, "running", { pid: 123, pidStartedAt: 1 });
    r.store.recordProviderSessionId(bee.id, "test-session", 1);
    if (harness === "claude") for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) {
      r.put(root, "settings.json", '{"theme":"test"}'); r.put(root, ".claude.json", '{"profile":"test"}');
    }
    const before = r.store.currentRuntime(bee.id);
    const input = r.input(1);
    const result = await r.accounts.installLease(input);
    assert.equal(result.account.id, r.account.id); assert.equal(result.account.source, "leased");
    assert.deepEqual(r.store.currentRuntime(bee.id), before);
    assert.equal(r.store.getBee(bee.id)?.providerSessionId, "test-session");
    assert.equal(result.enrolment?.liveRuntimeCoveragePending, 1); assert.equal(knownAccountLease(result.account)?.materialPublished, true);
    assert.equal(result.adopted, false); assert.equal(result.backupPath, null);
    const seq = r.store.lastAuditSeq();
    const replay = await r.accounts.installLease(input);
    assert.deepEqual(replay.enrolment, result.enrolment); assert.equal(r.store.lastAuditSeq(), seq);
    r.reopen();
    const renewed = await r.accounts.installLease({ ...r.input(2), enrol: undefined, viaNodeId: undefined, epoch: 2 });
    assert.equal(renewed.account.id, r.account.id); assert.equal(knownAccountLease(renewed.account)?.viaNodeId, "via-test");
    assert.deepEqual(renewed.enrolment, result.enrolment);
    const rerouted = await r.accounts.installLease({ ...r.input(3), enrol: undefined, viaNodeId: "another-via", epoch: 2 });
    assert.equal(knownAccountLease(rerouted.account)?.viaNodeId, "another-via"); assert.deepEqual(rerouted.enrolment, result.enrolment);
    await r.accounts.removeLease(r.account.id);
    assert.equal(knownAccountLease(r.store.getAccount(r.account.id))?.revokedAt !== null, true);
    assert.equal(r.store.getBee(bee.id)?.account, r.account.id); assert.deepEqual(r.store.currentRuntime(bee.id), before);
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) {
      assert.equal(existsSync(join(root, r.primary)), false);
      if (harness === "claude") { assert.equal(readFileSync(join(root, "settings.json"), "utf8"), '{"theme":"test"}'); assert.equal(readFileSync(join(root, ".claude.json"), "utf8"), '{"profile":"test"}'); }
    }
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

for (const location of ["home", "vault", "mirror", "keychain", "profile", "temporary"]) test(`lease enrol refuses ${location} refresh grant before effects`, async () => {
  const r = rig(location === "mirror" ? "codex" : "claude");
  try {
    const native = JSON.stringify({ ...documentFor(r.account.harness), nested: { refresh_token: randomUUID() } });
    const vault = r.accounts.vaultDirOf(r.account);
    if (location === "home") r.put(r.account.homePath, r.primary, native);
    if (location === "vault") r.put(vault, r.primary, native);
    if (location === "mirror") r.put(r.account.homePath, ".codex/auth.json", native);
    if (location === "temporary") r.put(vault, `${r.primary}.tmp.${randomUUID()}`, native);
    if (location === "profile") r.put(r.account.homePath, "settings.json", native);
    if (location === "keychain") r.setKeychain({ status: "present", raw: native });
    const before = r.store.dumpState();
    const hashes = [r.hash(r.account.homePath, r.primary), r.hash(vault, r.primary)];
    await assert.rejects(r.accounts.installLease(r.input(1)), refused("refresh_chain"));
    assert.deepEqual(r.store.dumpState(), before); assert.equal(r.writes, 0);
    assert.deepEqual([r.hash(r.account.homePath, r.primary), r.hash(vault, r.primary)], hashes);
  } finally { r.close(); }
});

test("lease enrol refuses unknown JSON, symlinks, private authority, active operation and native rows", async () => {
  for (const reason of ["invalid", "unknown", "symlink", "authority", "busy", "native"] as const) {
    const r = rig();
    try {
      if (reason === "invalid") r.put(r.account.homePath, "settings.json", "{invalid");
      if (reason === "unknown") r.put(r.account.homePath, r.primary, "{}");
      if (reason === "symlink") { rmSync(join(r.account.homePath, r.primary)); symlinkSync(join(r.accounts.vaultDirOf(r.account), r.primary), join(r.account.homePath, r.primary)); }
      if (reason === "authority") r.put(join(r.dir, "vault", ".credential-authorities"), `${r.account.id}.previous.json`, "{}");
      if (reason === "busy") { const bee = r.store.createBee({ name: "busy", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id }).bee; r.store.updateRuntimeState(bee.id, 1, "running"); (r.accounts as unknown as { nativeKeychainSeeds: Map<string, Set<Promise<unknown>>> }).nativeKeychainSeeds.set(r.account.id, new Set()); }
      if (reason === "native") (r.accounts as unknown as { isNative: (account: AccountRow) => boolean }).isNative = () => true;
      const before = r.store.dumpState();
      await assert.rejects(r.accounts.installLease(r.input()), (error: unknown) => error instanceof RpcError && ["account_lease_enrol_refused", "invalid_request"].includes(error.code));
      assert.deepEqual(r.store.dumpState(), before); assert.equal(r.writes, 0);
    } finally { r.close(); }
  }
});

test("lease enrol serializes a plain install racing first enrolment before provenance is written", async () => {
  const r = rig();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let enrol: ReturnType<AccountsService["installLease"]> | undefined;
  let plain: ReturnType<AccountsService["installLease"]> | undefined;
  try {
    const keychain = r.accounts.leaseMaterialCodecs.get("claude")!.keychain!;
    const read = keychain.read;
    let first = true;
    keychain.read = async home => {
      if (first) { first = false; entered(); await held; }
      return read(home);
    };
    const input = r.input(1);
    enrol = r.accounts.installLease(input);
    await ready;
    assert.equal(r.store.getAccount(r.account.id)?.source, "local");
    plain = r.accounts.installLease({ ...input, enrol: undefined, viaNodeId: undefined });
    release();
    const results = await Promise.all([enrol, plain]);
    for (const result of results) assert.equal(result.account.id, r.account.id);
    assert.deepEqual(results[0]!.enrolment, results[1]!.enrolment);
    assert.equal(r.store.listAccounts().length, 1);
    assert.equal(r.store.getAccount(`${r.account.id}@${input.shareId.slice(0, 8)}`), null);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally {
    release();
    await Promise.allSettled([enrol, plain]);
    r.close();
  }
});

test("lease enrol refuses a prior companion lease and leaves both rows untouched", async () => {
  const r = rig();
  try {
    const input = r.input(1);
    const companion = await r.accounts.installLease({ ...input, enrol: undefined, viaNodeId: undefined });
    assert.notEqual(companion.account.id, r.account.id);
    const before = r.store.dumpState();
    await assert.rejects(r.accounts.installLease(input), (error: unknown) => error instanceof RpcError && error.code === "account_lease_conflict");
    assert.deepEqual(r.store.dumpState(), before);
  } finally { r.close(); }
});

test("lease enrol resolution queue does not fence an unrelated local base during companion publication", async () => {
  const r = rig();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  let install: ReturnType<AccountsService["installLease"]> | undefined;
  try {
    const keychain = r.accounts.leaseMaterialCodecs.get("claude")!.keychain!;
    const publish = keychain.publish;
    keychain.publish = async (...args) => { entered(); await held; return publish(...args); };
    install = r.accounts.installLease({ ...r.input(), enrol: undefined, viaNodeId: undefined });
    await ready;
    assert.doesNotThrow(() => r.accounts.assertLocalAccount(r.account));
    release(); await install;
  } finally { release(); await Promise.allSettled([install]); r.close(); }
});

test("lease enrol publication fence and receipt survive failure/restart without a generation", async () => {
  const r = rig();
  try {
    const codec = r.accounts.leaseMaterialCodecs.get("claude")!;
    const publish = codec.keychain!.publish;
    codec.keychain!.publish = async () => { throw new Error("test publication failure"); };
    const input = r.input();
    await assert.rejects(r.accounts.installLease(input), (error: unknown) => error instanceof RpcError && error.code === "lease_unavailable");
    const partial = r.store.getAccount(r.account.id)!;
    assert.equal(partial.source, "leased"); assert.equal(knownAccountLease(partial)?.materialPublished, false);
    assert.ok(knownAccountLease(partial)?.enrolment);
    codec.keychain!.publish = publish;
    r.reopen();
    const completed = await r.accounts.installLease(input);
    assert.deepEqual(completed.enrolment, knownAccountLease(partial)?.enrolment);
    assert.equal(knownAccountLease(completed.account)?.materialPublished, true);
    assert.equal(r.accounts.authDeathMaterial(completed.account), null, "legacy enrolment cannot invent a generation");
  } finally { r.close(); }
});

test("lease enrol local-only provenance, and ordinary remote lease install remains unchanged", () => {
  for (const ingress of [undefined, "remote", "node_relay"] as const) {
    assert.throws(() => assertLocalHandoffRpc("account.lease.install", { enrol: true }, { ingress } as RpcConn), refused("local_required"));
    assert.throws(() => assertLocalHandoffRpc("account.lease.install", { viaNodeId: "via" }, { ingress } as RpcConn), refused("local_required"));
    assert.doesNotThrow(() => assertLocalHandoffRpc("account.lease.install", {}, { ingress } as RpcConn));
  }
  assert.doesNotThrow(() => assertLocalHandoffRpc("account.lease.install", { enrol: true }, { ingress: "local_unix" } as RpcConn));
});

test("lease enrol live unstamped death keeps legacy continuation; next physical admission uses T15", async () => {
  const r = rig();
  try {
    const bee = r.store.createBee({ name: "existing", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id }).bee;
    r.store.updateRuntimeState(bee.id, 1, "running");
    const resume = new AuthResume({ store: r.store, now: () => at, log: () => {}, accountForGeneration: row => r.store.getAccount(row.account!), credentialRevision: account => r.accounts.credentialRevision(account), material: account => r.accounts.authDeathMaterial(account) });
    const onInstalled = (account: AccountRow) => resume.credentialValidated(account, "credentials_restored");
    await r.accounts.installLease(r.input(1), onInstalled);
    assert.equal(r.store.currentRuntime(bee.id)?.credentialStamp, undefined);
    resume.interrupted({ beeId: bee.id, generation: 1, flag: "auth_needed", action: "set", detail: "Provider authentication failed", turn: { messageIds: [], progress: "some" } });
    r.store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
    await r.accounts.installLease({ ...r.input(2), enrol: undefined }, onInstalled);
    assert.equal(r.store.liveAuthInterruption(bee.id)?.state, "resumed");
    assert.equal(r.store.liveAuthInterruption(bee.id)?.deathRecovery, undefined);
    assert.equal(r.store.undeliveredMessages(bee.id).length, 1);
    r.store.reviveBee(bee.id);
    const account = r.store.getAccount(r.account.id)!;
    r.store.stampRuntimeCredential(bee.id, 2, { material: r.accounts.authDeathMaterial(account)!, revision: r.accounts.credentialRevision(account), account: account.id, agent: "claude", cwd: r.dir, cellId: null, controlFence: r.store.getBee(bee.id)?.authControlFence ?? 0 });
    r.store.updateRuntimeState(bee.id, 2, "running"); resume.turnSucceeded(bee.id);
    resume.interrupted({ beeId: bee.id, generation: 2, flag: "auth_needed", action: "set", detail: "Provider authentication failed", turn: { messageIds: [], progress: "unknown" } });
    r.store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "crashed" }); resume.reconcile();
    assert.equal(resume.waitingForMaterial(bee.id), true);
    await r.accounts.installLease({ ...r.input(3), enrol: undefined }, onInstalled);
    assert.notEqual(r.store.liveAuthInterruption(bee.id)?.deathRecovery?.claimedAt, null);
    assert.equal(r.store.auditRows().filter(row => row.kind === "auth_death.resumed").length, 1);
  } finally { r.close(); }
});


test("lease enrol preserves operator pause, proves Keychain material and checks again after waiting", async () => {
  const r = rig();
  try {
    r.store.setAccountStatus(r.account.id, "paused");
    r.setKeychain({ status: "present", raw: JSON.stringify(documentFor("claude")) });
    const installed = await r.accounts.installLease(r.input(1));
    assert.equal(installed.account.status, "paused");
    assert.equal(installed.keychainPublished, true);
    assert.equal(r.getKeychain().status, "present");
    assert.equal(r.accounts.authDeathMaterial(installed.account), null);
  } finally { r.close(); }
  const other = rig();
  try {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    other.accounts.leaseMaterialCodecs.get("claude")!.keychain!.read = async () => { entered(); await held; return { status: "unavailable" }; };
    const pending = other.accounts.installLease(other.input(1));
    await waiting;
    other.put(other.account.homePath, other.primary, JSON.stringify({ ...documentFor("claude"), refresh_token: randomUUID() }));
    release();
    await assert.rejects(pending, refused("refresh_chain"));
    assert.equal(other.store.getAccount(other.account.id)?.source, "local"); assert.equal(other.writes, 0);
  } finally { other.close(); }
});

test("lease enrol receipt survives authority epoch changes, stale input refuses and renewed material remains access-only", async () => {
  const r = rig();
  try {
    const first = await r.accounts.installLease(r.input(1));
    const next = await r.accounts.installLease({ ...r.input(1), enrol: undefined, authorityNodeId: "new-authority", epoch: 2 });
    assert.deepEqual(next.enrolment, first.enrolment); assert.equal(knownAccountLease(next.account)?.authorityNodeId, "new-authority");
    await assert.rejects(r.accounts.installLease(r.input(1)), (error: unknown) => error instanceof RpcError && error.code === "account_lease_conflict");
    const before = r.store.dumpState();
    const incoming = { ...r.input(2), enrol: undefined, authorityNodeId: "new-authority", epoch: 2, files: [{ homeRelPath: r.primary, contentB64: Buffer.from(JSON.stringify({ ...documentFor("claude"), refresh_token: randomUUID() })).toString("base64"), mode: 0o600 }] };
    await assert.rejects(r.accounts.installLease(incoming), refused("unknown_material"));
    assert.deepEqual(r.store.dumpState(), before);
  } finally { r.close(); }
});


test("lease enrol captures uncovered admissions at conversion after the Keychain wait", async () => {
  const r = rig();
  try {
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    r.accounts.leaseMaterialCodecs.get("claude")!.keychain!.read = async () => { entered(); await held; return { status: "unavailable" }; };
    const pending = r.accounts.installLease(r.input(1));
    await waiting;
    r.store.createBee({ name: "admission-already-in-flight", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id });
    release();
    const result = await pending;
    assert.equal(result.enrolment?.liveRuntimeCoveragePending, 1);
  } finally { r.close(); }
});


test("lease enrol requires a current canonical primary, not only an abandoned access-only temp", async () => {
  const r = rig();
  try {
    for (const root of [r.account.homePath, r.accounts.vaultDirOf(r.account)]) rmSync(join(root, r.primary));
    r.put(r.accounts.vaultDirOf(r.account), `${r.primary}.tmp.${randomUUID()}`, JSON.stringify(documentFor("claude")));
    const before = r.store.dumpState();
    await assert.rejects(r.accounts.installLease(r.input(1)), refused("unknown_material"));
    assert.deepEqual(r.store.dumpState(), before); assert.equal(r.writes, 0);
  } finally { r.close(); }
});

for (const harness of ["claude", "codex", "grok"]) test(`lease instance ${harness}: lower new scoped generation replaces legacy once, retired instances never return`, async () => {
  const r = rig(harness);
  try {
    const first = await r.accounts.installLease(r.input(9));
    const a = randomUUID(), b = randomUUID();
    const scoped = { ...r.input(2), enrol: undefined, authorityInstanceId: a };
    const upgraded = await r.accounts.installLease(scoped);
    assert.equal(upgraded.account.id, first.account.id);
    assert.equal(knownAccountLease(upgraded.account)?.generation, 2);
    assert.equal(knownAccountLease(upgraded.account)?.authorityInstanceId, a);
    const seq = r.store.lastAuditSeq();
    await r.accounts.installLease(scoped);
    assert.equal(r.store.lastAuditSeq(), seq);
    await assert.rejects(r.accounts.installLease({ ...scoped, generation: 1 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    await assert.rejects(r.accounts.installLease({ ...scoped, generation: 1, epoch: 2 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    const next = await r.accounts.installLease({ ...scoped, authorityInstanceId: b, generation: 1 });
    assert.equal(knownAccountLease(next.account)?.authorityInstanceId, b);
    assert.ok(knownAccountLease(next.account)?.retiredAuthorityInstanceIds?.includes(a));
    r.reopen();
    const before = r.store.dumpState();
    for (const change of [{ authorityInstanceId: a, generation: 100 }, { epoch: 0, authorityInstanceId: randomUUID(), generation: 1 }, { authorityNodeId: "foreign", authorityInstanceId: randomUUID(), generation: 1 }, { shareId: "foreign-share", authorityInstanceId: randomUUID(), generation: 1 }]) {
      await assert.rejects(r.accounts.installLease({ ...scoped, ...change }), error => error instanceof RpcError && error.code === "account_lease_conflict");
      assert.deepEqual(r.store.dumpState(), before);
    }
    const legacy = await r.accounts.installLease({ ...scoped, authorityInstanceId: undefined, generation: 3 });
    assert.equal(knownAccountLease(legacy.account)?.authorityInstanceId, undefined);
    await assert.rejects(r.accounts.installLease({ ...scoped, authorityInstanceId: undefined, generation: 2 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    await assert.rejects(r.accounts.installLease({ ...scoped, authorityInstanceId: a, generation: 200 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

for (const mode of ["return", "new", "advance", "generationless"]) test(`lease instance: remembered legacy floor ${mode} survives restart without stale scoped rollback`, async () => {
  const r = rig();
  try {
    const a = randomUUID(), b = randomUUID();
    const scoped = { ...r.input(5), authorityInstanceId: a };
    await r.accounts.installLease(scoped);
    const legacy = await r.accounts.installLease({ ...scoped, enrol: undefined, authorityInstanceId: undefined, generation: mode === "generationless" ? undefined : 6 });
    assert.equal(knownAccountLease(legacy.account)?.authorityInstanceId, undefined);
    assert.equal(knownAccountLease(legacy.account)?.legacyAuthorityInstanceId, a);
    assert.equal(knownAccountLease(legacy.account)?.legacyAuthorityGenerationFloor, mode === "generationless" ? 5 : 6);
    r.reopen();
    const before = r.store.dumpState();
    await assert.rejects(r.accounts.installLease({ ...scoped, enrol: undefined, generation: 5 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    assert.deepEqual(r.store.dumpState(), before);
    if (mode === "advance") {
      await r.accounts.installLease({ ...scoped, enrol: undefined, authorityInstanceId: undefined, generation: 7 });
      r.reopen();
      await assert.rejects(r.accounts.installLease({ ...scoped, enrol: undefined, generation: 7 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    }
    const result = await r.accounts.installLease({ ...scoped, enrol: undefined, authorityInstanceId: mode === "new" ? b : a, generation: mode === "new" ? 3 : mode === "advance" ? 8 : 7 });
    assert.equal(knownAccountLease(result.account)?.authorityInstanceId, mode === "new" ? b : a);
    assert.equal(knownAccountLease(result.account)?.legacyAuthorityInstanceId, undefined);
    assert.equal(knownAccountLease(result.account)?.legacyAuthorityGenerationFloor, undefined);
    if (mode === "new") await assert.rejects(r.accounts.installLease({ ...scoped, enrol: undefined, generation: 100 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

test("lease instance: a generationless delivery from the same declared instance cannot erase its monotonic floor", async () => {
  const r = rig();
  try {
    const id = randomUUID();
    const input = { ...r.input(5), authorityInstanceId: id };
    await r.accounts.installLease(input);
    const legacy = await r.accounts.installLease({ ...input, enrol: undefined, generation: undefined });
    assert.equal(knownAccountLease(legacy.account)?.generation, undefined);
    assert.equal(knownAccountLease(legacy.account)?.authorityInstanceId, id);
    assert.equal(knownAccountLease(legacy.account)?.authorityGenerationFloor, 5);
    r.reopen();
    await assert.rejects(r.accounts.installLease({ ...input, enrol: undefined, generation: 4 }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    const restored = await r.accounts.installLease({ ...input, enrol: undefined, generation: 5 });
    assert.equal(knownAccountLease(restored.account)?.generation, 5);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});


test("lease instance retirement keeps the newest eight ids across restart", async () => {
  const r = rig();
  try {
    const ids = Array.from({ length: 10 }, () => randomUUID());
    for (const authorityInstanceId of ids) await r.accounts.installLease({ ...r.input(1), enrol: undefined, authorityInstanceId });
    r.reopen();
    const installed = r.store.listAccounts().find(account => knownAccountLease(account)?.authorityInstanceId === ids[9])!;
    assert.deepEqual(knownAccountLease(installed)?.retiredAuthorityInstanceIds, ids.slice(1, 9));
    for (const authorityInstanceId of ids.slice(1, 9)) await assert.rejects(r.accounts.installLease({ ...r.input(1), enrol: undefined, authorityInstanceId }), error => error instanceof RpcError && error.code === "account_lease_conflict");
    const old = await r.accounts.installLease({ ...r.input(1), enrol: undefined, authorityInstanceId: ids[0] });
    assert.equal(knownAccountLease(old.account)?.authorityInstanceId, ids[0]);
    assert.equal(knownAccountLease(old.account)?.retiredAuthorityInstanceIds?.length, 8);
  } finally { r.close(); }
});
