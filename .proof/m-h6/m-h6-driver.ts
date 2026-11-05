// M-H6 scratch-daemon driver (proof evidence, not a test). Run from the repo root:
//   HB_M_H6_LOG=.proof/m-h6/recorded-run.md node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/m-h6/m-h6-driver.ts
// Every daemon has its own data dir, socket and HOME under the fixture base; nothing touches ~/.hive, ~/.claude or ~/.codex.
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { runV2Cli } from "../../v2/cli/src/main.ts";
import { RpcError, type AccountAddResult, type AccountImportResult, type AccountLeaseBatchResult, type AccountLeaseGrantResult, type AccountLeaseInstallResult, type DeployInfoResult, type MirrorAccountRow, type ViewResult } from "../../v2/daemon/src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../../v2/daemon/src/localRpcTrust.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, waitFor, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIMI_CODE_HOME", "OPENCODE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HIVE_V2_DATA_DIR", "HIVE_V2_SOCKET_PATH"]) delete process.env[key]; // the scratch daemons must resolve vendor homes under their own HOME, never this session's
const log = process.env.HB_M_H6_LOG;
const note = (line: string) => { console.log(line); if (log) appendFileSync(log, `${line}\n`); };
const show = (label: string, value: unknown) => note(`\n## ${label}\n\`\`\`json\n${JSON.stringify(value, (k, v) => k === "contentB64" || k === "material" || k === "files" && Array.isArray(v) && v.some(x => typeof x === "object") ? "<secret material elided>" : v, 2)}\n\`\`\``);
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof RpcError ? `${e.code}${e.details?.reason ? ` (${String(e.details.reason)})` : ""}` : String(e); } };
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
const fakeJwt = (expSeconds: number): string => { const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`; };
const trustOn = (dir: string) => { const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")); cfg.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: join(dir, "rpc-private", "registration.key") }; writeFileSync(join(dir, "config.json"), JSON.stringify(cfg)); };
const register = async (client: RpcClient, dir: string, nodeId: string) => {
  const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(join(dir, "rpc-private", "registration.key"));
  const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  await client.request("rpc.localTrust.register", { pid: challenge.pid, challengeId: challenge.challengeId, token, nodeId });
};
const row = async (client: RpcClient, id: string) => (await client.request<{ account: MirrorAccountRow }>("account.get", { id })).account;
const shareOf = (a: MirrorAccountRow) => ({ id: a.id, source: a.source, shareId: a.shareId, shareEpoch: a.shareEpoch, lease: a.leasedFrom ? { shareId: a.leasedFrom.shareId, epoch: a.leasedFrom.epoch, authorityNodeId: a.leasedFrom.authorityNodeId, expiresAt: a.leasedFrom.expiresAt } : null });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

if (log) writeFileSync(log, `# M-H6 recorded run ${new Date().toISOString()}\nscratch daemons under the fixture base, each with its own data dir, socket and HOME\n`);
const dirs: Array<{ dir: string; cleanup: () => void }> = [], handles: DaemonHandle[] = [], clients: RpcClient[] = [];
let server: ReturnType<typeof createServer> | null = null;
const cleanup = async () => { clients.forEach(c => c.close()); await Promise.allSettled(handles.map(forceStopTestDaemon)); server?.closeAllConnections(); await new Promise<void>(r => server ? server.close(() => r()) : r()); dirs.forEach(d => d.cleanup()); };

try {
  // ───────────────────────────── A. share and epoch derived on the owner ─────────────────────────────
  note("\n# A. account.lease.grant derives share and epoch from the account row (A owner, B target, trust on)");
  const [da, db] = [makeDaemonDir(), makeDaemonDir()]; dirs.push(da, db); trustOn(da.dir); trustOn(db.dir);
  const a = await startDaemon(da.dir, { stopTimeoutMs: 30_000 }), b = await startDaemon(db.dir, { stopTimeoutMs: 30_000 }); handles.push(a, b);
  const A = await a.client(), B = await b.client(); clients.push(A, B);
  const infoA = await A.request<DeployInfoResult>("deployInfo");
  assert.ok(infoA.capabilities.includes("account.share.v1"), "the new capability tag is advertised");
  const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
  const seedCodex = (dir: string, id: string) => { const vault = join(dir, "vault", "codex", id); mkdirSync(vault, { recursive: true }); writeFileSync(join(vault, "auth.json"), JSON.stringify({ tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: `FIXTURE-REFRESH-${id}`, account_id: "acct" } })); };
  await A.request<AccountAddResult>("account.add", { harness: "codex", label: "lx" }); seedCodex(da.dir, "codex-lx");
  await register(A, da.dir, "apiary-node-a"); await register(B, db.dir, "apiary-node-b");
  const fresh = await row(A, "codex-lx");
  assert.equal(fresh.shareId, null); assert.equal(fresh.shareEpoch, null);
  const g1 = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b" });
  const afterG1 = await row(A, "codex-lx");
  show("A1 first grant without shareId/epoch: minted share, epoch 1, persisted on the row", { grant: { shareId: g1.grant.shareId, epoch: g1.grant.epoch, nodeId: g1.grant.nodeId, expiresAt: g1.grant.expiresAt }, install: { id: g1.install.id, shareId: g1.install.shareId, epoch: g1.install.epoch, nodeId: g1.install.nodeId }, row: shareOf(afterG1) });
  assert.match(g1.grant.shareId, UUID); assert.equal(g1.grant.epoch, 1); assert.equal(afterG1.shareId, g1.grant.shareId); assert.equal(afterG1.shareEpoch, 1); assert.equal(g1.install.shareId, g1.grant.shareId);
  const g2 = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b", ttlMs: 48 * 3_600_000 });
  const outcomes: Record<string, string> = {
    "second grant, no params: same share and epoch, later window": g2.grant.shareId === g1.grant.shareId && g2.grant.epoch === 1 && g2.grant.expiresAt > g1.grant.expiresAt ? "ok" : "MISMATCH",
    "caller passes the row's own shareId + epoch 1": await code(A.request("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b", shareId: g1.grant.shareId, epoch: 1 })),
    "caller passes another shareId": await code(A.request("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b", shareId: "share-somebody-else", epoch: 1 })),
    "caller passes epoch 2 (row is at 1)": await code(A.request("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b", epoch: 2 })),
    "caller passes epoch 0": await code(A.request("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b", epoch: 0 })),
  };
  show("A2 caller-supplied share facts must agree with the row", outcomes);
  assert.equal(outcomes["caller passes the row's own shareId + epoch 1"], "ok"); assert.equal(outcomes["caller passes another shareId"], "invalid_request (share_id)"); assert.equal(outcomes["caller passes epoch 2 (row is at 1)"], "invalid_request (epoch)"); assert.equal(outcomes["caller passes epoch 0"], "invalid_request (epoch)");
  const mismatch = await A.request("account.lease.grant", { id: "codex-lx", nodeId: "apiary-node-b", shareId: "share-somebody-else" }).catch(e => e as RpcError);
  assert.ok(mismatch instanceof RpcError && mismatch.details?.shareId === g1.grant.shareId && mismatch.details?.epoch === 1, "the refusal names the owned facts");
  const installed = await B.request<AccountLeaseInstallResult>("account.lease.install", g2.install, 60_000);
  const bRow = await row(B, installed.account.id);
  show("A3 B installs the payload: the leased row carries the same share and epoch", shareOf(bRow));
  assert.equal(bRow.id, `codex-lx@${g1.grant.shareId.slice(0, 8)}`); assert.equal(bRow.shareId, g1.grant.shareId); assert.equal(bRow.shareEpoch, 1); assert.equal(bRow.leasedFrom?.shareId, g1.grant.shareId);
  const items = [{ op: "grant", id: "codex-lx", nodeId: "apiary-node-b" }, { op: "grant", id: "codex-lx", nodeId: "node-c", ttlMs: 96 * 3_600_000 }];
  const batch1 = await A.request<AccountLeaseBatchResult>("account.lease.batch", { items, idempotencyKey: "m-h6-row-codex-lx" }, 60_000);
  const batch2 = await A.request<AccountLeaseBatchResult>("account.lease.batch", { items, idempotencyKey: "m-h6-row-codex-lx" }, 60_000);
  const facts = (r: AccountLeaseBatchResult) => r.results.map(x => x.ok && x.op === "grant" ? { nodeId: x.nodeId, shareId: x.result.grant.shareId, epoch: x.result.grant.epoch, expiresAt: x.result.grant.expiresAt } : { ok: false });
  show("A4 batch without share facts, then its replay: deduped, same facts and windows", { first: facts(batch1), replay: { deduped: batch2.deduped, items: facts(batch2) } });
  assert.equal(batch2.deduped, true); assert.deepEqual(facts(batch1), facts(batch2)); assert.ok(facts(batch1).every(f => "shareId" in f && f.shareId === g1.grant.shareId && f.epoch === 1));
  await A.request<AccountAddResult>("account.add", { harness: "codex", label: "old" }); seedCodex(da.dir, "codex-old");
  const seeded = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-old", nodeId: "apiary-node-b", shareId: "share-codex-old", epoch: 3 });
  const seededAgain = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-old", nodeId: "apiary-node-b" });
  show("A5 a pre-H6 carrier still passing its own facts seeds a row that has none (Apiary before C5)", { seeded: { shareId: seeded.grant.shareId, epoch: seeded.grant.epoch }, next: { shareId: seededAgain.grant.shareId, epoch: seededAgain.grant.epoch }, row: shareOf(await row(A, "codex-old")) });
  assert.equal(seeded.grant.shareId, "share-codex-old"); assert.equal(seeded.grant.epoch, 3); assert.equal(seededAgain.grant.shareId, "share-codex-old"); assert.equal(seededAgain.grant.epoch, 3);
  await a.stop(); await b.stop();
  const a2 = await startDaemon(da.dir, { stopTimeoutMs: 30_000 }); handles.push(a2); const A2 = await a2.client(); clients.push(A2);
  const persisted = await row(A2, "codex-lx");
  show("A6 share facts survive a daemon restart", shareOf(persisted));
  assert.equal(persisted.shareId, g1.grant.shareId); assert.equal(persisted.shareEpoch, 1);
  await a2.stop();

  // ───────────────────────────── B. a take-over bumps the epoch ─────────────────────────────
  note("\n# B. a take-over through the credential handoff plane raises the epoch; the new owner grants at epoch 2 under the same share (owner X, new owner Y, satellite Z; fake codex token server)");
  const valid = new Set<string>(), refreshes: string[] = [];
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const body = req.headers["content-type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
    refreshes.push(body.refresh_token);
    if (!valid.has(body.refresh_token)) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "invalid_grant" })); return; }
    valid.delete(body.refresh_token); const refresh = randomUUID(); valid.add(refresh);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: refresh, expires_in: 3600 }));
  });
  await new Promise<void>(r => server!.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  const [dx, dy, dz] = [makeDaemonDir({ accounts: { centralRefreshAheadMs: 0, centralRefreshRetryBaseMs: 60_000 } }), makeDaemonDir({ accounts: { centralRefreshAheadMs: 0, centralRefreshRetryBaseMs: 60_000 } }), makeDaemonDir()]; dirs.push(dx, dy, dz);
  for (const d of [dx, dy, dz]) trustOn(d.dir);
  const envFor = (dir: string) => ({ HOME: join(dir, "empty-user-home"), CODEX_HOME: join(dir, "unused-codex"), HIVE_GATEWAYS_DISABLE: "1", HIVE_CODEX_OAUTH_TOKEN_URL: endpoint, HIVE_NO_KEYCHAIN: "1" });
  const x = await startDaemon(dx.dir, { env: envFor(dx.dir), stopTimeoutMs: 30_000 }), y = await startDaemon(dy.dir, { env: envFor(dy.dir), stopTimeoutMs: 30_000 }), z = await startDaemon(dz.dir, { stopTimeoutMs: 30_000 }); handles.push(x, y, z);
  const X = await x.client(), Y = await y.client(), Z = await z.client(); clients.push(X, Y, Z);
  await register(X, dx.dir, "node-x"); await register(Y, dy.dir, "node-y"); await register(Z, dz.dir, "node-z");
  const from = { nodeId: "node-x", deviceKey: "device-x" }, to = { nodeId: "node-y", deviceKey: "device-y" };
  await X.request("account.credentials.handoffIdentitySet", { identity: from }); await Y.request("account.credentials.handoffIdentitySet", { identity: to });
  const id = "codex-shared-example.com", firstRefresh = randomUUID(); valid.add(firstRefresh);
  const vault = join(dx.dir, "vault", "codex", id); mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "auth.json"), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: fakeJwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: firstRefresh, id_token: "fixture", account_id: "fixture" } }), { mode: 0o600 });
  await X.request("account.add", { id, harness: "codex", label: "shared-example.com", importExisting: true });
  await waitFor(async () => { try { return await X.request("account.credentials.enable", { id, idempotencyKey: randomUUID() }, 60_000); } catch (error) { if (error instanceof RpcError && error.message.includes("native credential refresh")) return null; throw error; } }, "central authority enabled on X", 30_000);
  const gx = await X.request<AccountLeaseGrantResult>("account.lease.grant", { id, nodeId: "node-z" });
  const zRow1 = (await Z.request<AccountLeaseInstallResult>("account.lease.install", gx.install, 60_000)).account;
  show("B1 X owns the share at epoch 1 and leases it to Z", { owner: shareOf(await row(X, id)), z: shareOf(zRow1) });
  assert.equal(gx.grant.epoch, 1);
  await Y.request("account.add", { id, harness: "codex", label: "shared-example.com" });
  const handoffId = randomUUID();
  const exported = await X.request<{ receipt: { binding: { epoch: number; shareId?: string; sourceKey: string } }; material: unknown }>("account.credentials.export", { account: id, handoffId, from, to }, 60_000);
  show("B2 export without an epoch param: the binding carries row epoch + 1 and the share id", { epoch: exported.receipt.binding.epoch, shareId: exported.receipt.binding.shareId });
  assert.equal(exported.receipt.binding.epoch, 2); assert.equal(exported.receipt.binding.shareId, gx.grant.shareId);
  const prepared = await waitFor(async () => { try { return await Y.request<{ receipt: { binding: { targetKey: string; claimId: string } } }>("account.credentials.adoptPrepare", { account: id, handoffId, from, to, authenticatedPeer: from, sourceKey: exported.receipt.binding.sourceKey, exportReceipt: exported.receipt, material: exported.material }, 60_000); } catch (error) { if (error instanceof RpcError && error.code === "credential_handoff_unavailable") return null; throw error; } }, "Y prepared", 30_000);
  await X.request("account.credentials.exportPrepare", { handoffId, preparedReceipt: prepared.receipt, targetKey: prepared.receipt.binding.targetKey, authenticatedPeer: to }, 60_000);
  const committed = await X.request<{ receipt: unknown }>("account.credentials.exportCommit", { handoffId, claimId: prepared.receipt.binding.claimId }, 60_000);
  await Y.request("account.credentials.adopt", { account: id, handoffId, commitReceipt: committed.receipt }, 60_000);
  const yRow = await row(Y, id), xRow = await row(X, id);
  show("B3 after adoption: Y's row is the authority at epoch 2 under the same share; X's row is stood down", { y: shareOf(yRow), x: { ...shareOf(xRow), status: xRow.status } });
  assert.equal(yRow.source, "local"); assert.equal(yRow.shareEpoch, 2); assert.equal(yRow.shareId, gx.grant.shareId);
  const gy = await Y.request<AccountLeaseGrantResult>("account.lease.grant", { id, nodeId: "node-z" });
  const takeover: Record<string, unknown> = {
    "Y grants without params": { shareId: gy.grant.shareId, epoch: gy.grant.epoch, authorityNodeId: gy.grant.authorityNodeId },
    "X (old owner) grants now": await code(X.request("account.lease.grant", { id, nodeId: "node-z" })),
    "Z installs Y's epoch-2 payload over X's epoch-1 lease": await code(Z.request("account.lease.install", gy.install, 60_000)),
    "Z installs X's stale epoch-1 payload again": await code(Z.request("account.lease.install", gx.install, 60_000)),
    "z row": shareOf(await row(Z, zRow1.id)),
  };
  show("B4 the new owner grants at epoch 2; the old owner cannot; the satellite moves to epoch 2 and refuses the stale epoch", takeover);
  assert.equal(gy.grant.epoch, 2); assert.equal(gy.grant.shareId, gx.grant.shareId); assert.notEqual(takeover["X (old owner) grants now"], "ok"); assert.equal(takeover["Z installs Y's epoch-2 payload over X's epoch-1 lease"], "ok"); assert.ok(String(takeover["Z installs X's stale epoch-1 payload again"]).startsWith("account_lease_conflict"));
  const zRow2 = await row(Z, zRow1.id); assert.equal(zRow2.shareEpoch, 2); assert.equal(zRow2.leasedFrom?.epoch, 2); assert.equal(zRow2.leasedFrom?.authorityNodeId, gy.grant.authorityNodeId);
  await x.stop(); await y.stop(); await z.stop();

  // ───────────────────────────── C. account.import adopts a stand-in CLI login ─────────────────────────────
  note("\n# C. account.import adopts stand-in claude and codex logins in a scratch HOME; the files stay byte-identical and the bee runs on the machine's own home");
  const dd = makeDaemonDir(); dirs.push(dd); trustOn(dd.dir);
  const machineHome = join(dd.dir, "machine-home"); mkdirSync(join(machineHome, ".claude"), { recursive: true }); mkdirSync(join(machineHome, ".codex"), { recursive: true });
  const claudeCred = join(machineHome, ".claude", ".credentials.json"), claudeJson = join(machineHome, ".claude.json"), codexAuth = join(machineHome, ".codex", "auth.json");
  writeFileSync(claudeCred, JSON.stringify({ claudeAiOauth: { accessToken: `sk-ant-oat01-STANDIN-${randomUUID()}`, refreshToken: `sk-ant-ort01-STANDIN-${randomUUID()}`, expiresAt: Date.now() + 3_600_000, scopes: ["user:inference"] } }), { mode: 0o600 });
  writeFileSync(claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
  writeFileSync(codexAuth, JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: fakeJwt(exp), refresh_token: `STANDIN-CODEX-${randomUUID()}`, id_token: "fixture", account_id: "fixture" } }), { mode: 0o600 });
  const argvLog = join(dd.dir, "fake-claude-argv.log");
  { const cfgPath = join(dd.dir, "config.json"), cfg = JSON.parse(readFileSync(cfgPath, "utf8")); cfg.agents.claude = { command: process.execPath, args: [join(process.cwd(), "v2/driver-hsr/test-agent/fake-claude.mjs")], adapter: "claude", env: { FAKE_CLAUDE_ARGV_LOG: argvLog } }; writeFileSync(cfgPath, JSON.stringify(cfg)); }
  const before = { claudeCred: sha(claudeCred), claudeJson: sha(claudeJson), codexAuth: sha(codexAuth) };
  const d = await startDaemon(dd.dir, { env: { HOME: machineHome, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1" }, stopTimeoutMs: 30_000 }); handles.push(d);
  const D = await d.client(); clients.push(D);
  const imported = await D.request<AccountImportResult>("account.import", { harness: "claude" });
  const again = await D.request<AccountImportResult>("account.import", { harness: "claude" });
  const codex = await D.request<AccountImportResult>("account.import", { harness: "codex" });
  const nothing = await D.request("account.import", { harness: "grok" }).catch(e => e as RpcError);
  const relay = await RpcClient.connect(d.socketPath, 3000, "node_relay"); clients.push(relay);
  show("C1 import results", {
    claude: { created: imported.created, id: imported.account.id, homePath: imported.account.homePath, status: imported.account.status, credentialHealth: imported.credentialHealth, nativeLogin: imported.account.nativeLogin, source: imported.source },
    claudeAgain: { created: again.created, id: again.account.id },
    codex: { created: codex.created, id: codex.account.id, homePath: codex.account.homePath, status: codex.account.status, source: codex.source },
    grokWithNoLogin: nothing instanceof RpcError ? { code: nothing.code, checked: nothing.details?.checked } : "unexpected ok",
    "relay lane": await code(relay.request("account.import", { harness: "claude" })),
    "isolated add of the vendor home is redirected to import": await code(D.request("account.add", { harness: "claude", label: "copy", homePath: join(machineHome, ".claude") })),
  });
  assert.equal(imported.created, true); assert.equal(imported.account.homePath, join(machineHome, ".claude")); assert.equal(imported.account.status, "ok"); assert.deepEqual(imported.source.files.sort(), [".claude.json", ".credentials.json"]);
  assert.equal(again.created, false); assert.equal(again.account.id, imported.account.id); assert.equal(codex.created, true); assert.equal(codex.account.homePath, join(machineHome, ".codex")); assert.equal(codex.account.status, "ok");
  assert.ok(nothing instanceof RpcError && nothing.code === "no_credentials_to_import");
  const spawned = await D.request<{ beeId: string }>("spawn", { name: "native-claude", agent: "claude", cwd: dd.dir, account: imported.account.id, tags: ["autoswap=false"] });
  await waitFor(async () => ["running", "idle"].includes((await D.request<ViewResult>("view", { beeId: spawned.beeId })).view.runtimeState ?? "") ? true : null, "bee on the imported login running", 30_000);
  await D.request("send", { beeId: spawned.beeId, body: "hello from M-H6" });
  await waitFor(async () => (await D.request<ViewResult>("view", { beeId: spawned.beeId })).view.lastOutputAt ? true : null, "turn produced output", 30_000);
  const booted = readFileSync(argvLog, "utf8").trim().split("\n").map(l => JSON.parse(l) as { env: Record<string, string | null> });
  const after = { claudeCred: sha(claudeCred), claudeJson: sha(claudeJson), codexAuth: sha(codexAuth) };
  show("C2 a bee on the imported account ran the harness on the machine's own home (no CLAUDE_CONFIG_DIR); the stand-in login files are byte-identical before and after", { beeEnv: booted.map(b => ({ CLAUDE_CONFIG_DIR: b.env.CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: b.env.CLAUDE_CODE_OAUTH_TOKEN })), hashesBefore: before, hashesAfter: after, vaultCopyExists: existsSync(join(dd.dir, "vault", "claude", imported.account.id)), homesCopyExists: existsSync(join(dd.dir, "homes", imported.account.id)) });
  assert.deepEqual(before, after); assert.ok(booted.length >= 1 && booted.every(b => b.env.CLAUDE_CONFIG_DIR === null)); assert.equal(existsSync(join(dd.dir, "vault", "claude", imported.account.id)), false);
  await D.request("stop", { beeId: spawned.beeId });
  const out: string[] = [], err: string[] = [];
  const rc = await runV2Cli(["--data-dir", dd.dir, "account", "import", "codex"], { out: l => out.push(l), err: l => err.push(l) });
  show("C3 CLI: hive account import codex (already adopted)", { rc, out, err });
  assert.equal(rc, 0);
  await register(D, dd.dir, "node-d");
  const leaseNative = await code(D.request("account.lease.grant", { id: imported.account.id, nodeId: "node-q" }));
  note(`\nC4 a native (imported) account is never leased: account.lease.grant → ${leaseNative}`);
  await d.stop();
  note("\nALL CHECKS PASSED");
} finally { await cleanup(); }
