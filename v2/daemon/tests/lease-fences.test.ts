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
  const dir = mkdtempSync(join(tmpdir(), "hb-lease-fences-"));
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

const conflict = (reason?: string) => (error: unknown) => error instanceof RpcError && error.code === "account_lease_conflict" && (reason === undefined || error.details?.reason === reason);
const invalid = (error: unknown) => error instanceof RpcError && error.code === "invalid_request";
function delivery(r: ReturnType<typeof rig>, instance: string, generation: number, fields: Partial<AccountLeaseInstallParams> = {}): AccountLeaseInstallParams {
  return { ...r.input(generation), authorityInstanceId: instance, ...fields };
}

for (const order of ["old-before-new", "new-before-old"]) test(`forwarded fences refuse late old material ${order}, with restart and no file effects`, async () => {
  const r = rig();
  try {
    await r.accounts.installLease(delivery(r, "instance-A", 5)); r.reopen();
    if (order === "new-before-old") await r.accounts.installLease(delivery(r, "instance-B", 3, { retiredAuthorityInstanceIds: ["instance-A"], fencesForwarded: false }));
    const before = r.store.dumpState(), raw = r.hash(r.account.homePath, r.primary);
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-A", 6, { retiredAuthorityInstanceIds: ["instance-A"], fencesForwarded: false })), invalid);
    assert.deepEqual(r.store.dumpState(), before); assert.equal(r.hash(r.account.homePath, r.primary), raw);
    if (order === "old-before-new") await r.accounts.installLease(delivery(r, "instance-B", 3, { retiredAuthorityInstanceIds: ["instance-A"], fencesForwarded: false }));
    r.reopen();
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-A", 99)), conflict("retired_instance"));
    assert.equal(r.store.getAccount(r.account.id)?.leasedFrom?.authorityInstanceId, "instance-B");
    assert.ok(r.store.getLeaseMaterialProof(r.account.id), "forwarded publication records private T23 issuance proof");
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

test("forwarded floors clamp to carried generation, ignore foreign floors and never lower local fences", async () => {
  const r = rig();
  try {
    await r.accounts.installLease(delivery(r, "instance-A", 5));
    const result = await r.accounts.installLease(delivery(r, "instance-B", 3, { retiredAuthorityInstanceIds: ["instance-A"], authorityGenerationFloor: 99, legacyAuthorityInstanceId: "foreign-instance", legacyAuthorityGenerationFloor: 100 }));
    assert.equal(result.account.leasedFrom?.authorityGenerationFloor, 3);
    assert.equal(result.account.leasedFrom?.legacyAuthorityInstanceId, undefined);
    r.reopen();
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-B", 2, { authorityGenerationFloor: 0 })), conflict("generation_floor"));
    const raised = await r.accounts.installLease(delivery(r, "instance-B", 7, { authorityGenerationFloor: 1, legacyAuthorityInstanceId: "instance-B", legacyAuthorityGenerationFloor: 99 }));
    assert.equal(raised.account.leasedFrom?.authorityGenerationFloor, 7);
    assert.equal(raised.account.leasedFrom?.legacyAuthorityGenerationFloor, undefined);
    const newInstance = await r.accounts.installLease(delivery(r, "instance-C", 1));
    assert.equal(newInstance.account.leasedFrom?.authorityGenerationFloor, 1);
  } finally { r.close(); }
});

test("forwarded union compares full history before cap, keeps deterministic newest eight and cannot self-retire", async () => {
  const r = rig();
  try {
    const local = ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6"];
    await r.accounts.installLease(delivery(r, "instance-A", 5, { retiredAuthorityInstanceIds: local }));
    const incoming = ["old-5", "old-6", "old-7", "old-8", "old-9", "old-10"];
    const result = await r.accounts.installLease(delivery(r, "instance-B", 3, { retiredAuthorityInstanceIds: incoming }));
    assert.deepEqual(result.account.leasedFrom?.retiredAuthorityInstanceIds, ["old-4", "old-5", "old-6", "old-7", "old-8", "old-9", "old-10", "instance-A"]);
    r.reopen();
    const before = r.store.dumpState();
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "old-4", 99, { retiredAuthorityInstanceIds: ["extra-1", "extra-2", "extra-3", "extra-4", "extra-5", "extra-6", "extra-7", "extra-8"] })), conflict("retired_instance"));
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-B", 4, { retiredAuthorityInstanceIds: ["instance-B"] })), invalid);
    assert.deepEqual(r.store.dumpState(), before);
  } finally { r.close(); }
});

test("forwarded issuer binding and one-hop marker persist through direct renewals and restart", async () => {
  const r = rig();
  try {
    await r.accounts.installLease(delivery(r, "instance-A", 5));
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-B", 1, { retiredAuthorityInstanceIds: ["instance-A"], viaNodeId: "wrong-issuer" })), conflict("issuer_conflict"));
    const forwarded = await r.accounts.installLease(delivery(r, "instance-B", 1, { retiredAuthorityInstanceIds: ["instance-A"], fencesForwarded: false }));
    assert.equal(forwarded.account.leasedFrom?.fencesForwarded, true);
    r.reopen();
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), error => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === "forwarding_depth_exceeded");
    await r.accounts.installLease(delivery(r, "instance-B", 2, { enrol: undefined, viaNodeId: "authority-test" }));
    assert.equal(r.store.getAccount(r.account.id)?.leasedFrom?.fencesForwarded, true);
    assert.deepEqual(r.store.getAccount(r.account.id)?.leasedFrom?.retiredAuthorityInstanceIds, ["instance-A"]);
    await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-B", 3, { fencesForwarded: true, viaNodeId: "authority-test" })), conflict("forwarding_depth_exceeded"));
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), error => error instanceof RpcError && error.details?.reason === "forwarding_depth_exceeded");
    await r.accounts.removeLease(r.account.id);
    const reinstalled = await r.accounts.installLease(delivery(r, "instance-C", 1, { enrol: undefined, authorityNodeId: "new-authority", viaNodeId: "new-authority", epoch: 2 }));
    assert.equal(reinstalled.account.leasedFrom?.fencesForwarded, true, "revocation and new authority do not erase the row's one-hop boundary");
    r.reopen();
    await assert.rejects(r.accounts.exportLeasedMaterial(r.account.id), error => error instanceof RpcError && error.details?.reason === "forwarding_depth_exceeded");
  } finally { r.close(); }
});

test("every forwarded field requires local ingress independently of via and validates bounded input", async () => {
  for (const field of ["retiredAuthorityInstanceIds", "authorityGenerationFloor", "legacyAuthorityInstanceId", "legacyAuthorityGenerationFloor", "fencesForwarded"]) {
    for (const ingress of [undefined, "remote", "node_relay"] as const) assert.throws(() => assertLocalHandoffRpc("account.lease.install", { [field]: false }, { ingress } as RpcConn), conflict("local_required"));
    assert.doesNotThrow(() => assertLocalHandoffRpc("account.lease.install", { [field]: false }, { ingress: "local_unix" } as RpcConn));
  }
  const r = rig();
  try {
    for (const fields of [{ retiredAuthorityInstanceIds: Array.from({length:9}, (_,i) => `old-${i}`) }, { authorityGenerationFloor: -1 }, { generation: undefined, fencesForwarded: false }, { legacyAuthorityGenerationFloor: 1 }, { retiredAuthorityInstanceIds: ["duplicate", "duplicate"] }]) await assert.rejects(async () => r.accounts.installLease(delivery(r, "instance-A", 5, fields)), invalid);
    assert.equal(r.store.getAccount(r.account.id)?.source, "local");
  } finally { r.close(); }
});

test("forwarded retirement fences a stale T15 verdict without claiming dead material", async () => {
  const r = rig();
  try {
    await r.accounts.installLease(delivery(r, "instance-A", 5));
    const bee = r.store.createBee({ name: "held", agent: "claude", substrate: "hsr", cwd: r.dir, account: r.account.id }).bee;
    const stamp = { material: { kind: "lease" as const, scope: "authority-test:share-enrol-test", epoch: 1, generation: 5, authorityInstanceId: "instance-A" }, revision: "old", account: r.account.id, agent: bee.agent, cwd: r.dir, cellId: bee.cellId, controlFence: bee.authControlFence ?? 0 };
    r.store.stampRuntimeCredential(bee.id, 1, stamp);
    r.store.updateRuntimeState(bee.id, 1, "running");
    r.store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
    const row = r.store.recordAuthInterruption({ beeId: bee.id, account: r.account.id, generation: 1, messageIds: [], turnProgress: "unknown", credentialRevision: "old", detail: "auth" });
    r.store.setAuthDeathRecovery(row.id, { admitted: stamp, deathAt: at, deadline: at + 600_000, claimedAt: null, replacement: null, commandId: null });
    await r.accounts.installLease(delivery(r, "instance-B", 3, { retiredAuthorityInstanceIds: ["instance-A"], authorityGenerationFloor: 3 }));
    assert.equal(r.store.claimAuthDeathRecovery(row.id, { ...stamp.material, generation: 99 }, "stale", "continue"), false);
    assert.equal(r.store.listCommands().filter(command => command.args.authDeathRecoveryId === row.id).length, 0);
    assert.equal(r.store.getAccount(r.account.id)?.leasedFrom?.authorityInstanceId, "instance-B");
  } finally { r.close(); }
});
