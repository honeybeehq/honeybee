// lease-enrolled-renewal scratch-daemon driver (proof evidence, not a test). Run from the repo root with every HIVE_* variable unset:
//   HB_LEASE_RENEWAL_LOG=.proof/lease-enrolled-renewal/run-after.md node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/lease-enrolled-renewal/driver.ts --expect after
//   (--expect before against the code without the fix: the same-authority renewal must be refused unknown_material)
// Three daemons with their own data dirs, sockets and HOMEs and local trust enabled: A is the authority (the Studio),
// B the satellite (a mini) holding a row enrolled the old way, F another node that forges a payload for B's share.
// Provider URLs point at 127.0.0.1:9 (startDaemon's stand-ins), the Keychain bridge is off, nothing touches ~/.hive.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcClient } from "../../v2/cli/src/client.ts";
import { RpcError, type AccountAddResult, type AccountGetResult, type AccountLeaseGrantResult, type AccountLeaseInstallResult, type AccountLeaseRemoveResult, type DeployInfoResult } from "../../v2/daemon/src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../../v2/daemon/src/localRpcTrust.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, type DaemonHandle } from "../../v2/daemon/tests/helpers.ts";

for (const key of Object.keys(process.env)) if (key.startsWith("HIVE_") || ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].includes(key)) delete process.env[key];
const expect = process.argv.includes("--expect") ? process.argv[process.argv.indexOf("--expect") + 1] : "after";
if (expect !== "before" && expect !== "after") throw new Error("--expect before|after");
const log = process.env.HB_LEASE_RENEWAL_LOG;
if (log) writeFileSync(log, `# lease-enrolled-renewal recorded run (${expect} the fix) ${new Date().toISOString()}\n`);
const note = (line: string) => { console.log(line); if (log) appendFileSync(log, `${line}\n`); };
const SECRETS: string[] = [];
const redact = (k: string, v: unknown) => k === "files" || k === "contentB64" ? "<secret material elided>" : typeof v === "string" && SECRETS.some(s => v.includes(s)) ? "<secret elided>" : v;
const show = (label: string, value: unknown) => note(`\n## ${label}\n\`\`\`json\n${JSON.stringify(value, redact, 2)}\n\`\`\``);
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof RpcError ? `${e.code}${e.details?.reason ? ` (${String(e.details.reason)})` : ""}: ${e.message}` : String(e); } };
const credential = (refreshToken: string) => { const accessToken = `fixture-access-${randomUUID()}`; SECRETS.push(accessToken); if (refreshToken) SECRETS.push(refreshToken); return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 8 * 24 * 3_600_000, scopes: ["user:inference"], subscriptionType: "max" } }); };
const b64 = (raw: string) => Buffer.from(raw, "utf8").toString("base64");

const dirs = [makeDaemonDir(), makeDaemonDir(), makeDaemonDir()];
for (const d of dirs) { const cfg = JSON.parse(readFileSync(join(d.dir, "config.json"), "utf8")); cfg.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: join(d.dir, "rpc-private", "registration.key") }; writeFileSync(join(d.dir, "config.json"), JSON.stringify(cfg)); }
const handles: DaemonHandle[] = [], clients: RpcClient[] = [];
const register = async (client: RpcClient, dir: string, nodeId: string) => {
  const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(join(dir, "rpc-private", "registration.key"));
  const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
  await client.request("rpc.localTrust.register", { pid: challenge.pid, challengeId: challenge.challengeId, token, nodeId });
};
const rowOf = async (client: RpcClient, id: string) => {
  const got = await client.request<AccountGetResult>("account.get", { id });
  const { account } = got;
  const lease = account.leasedFrom as Record<string, unknown> | null;
  return { id: account.id, source: account.source, status: account.status, statusReason: account.statusReason, shareId: account.shareId, shareEpoch: account.shareEpoch, leasedFrom: lease && { shareId: lease.shareId, authorityNodeId: lease.authorityNodeId, viaNodeId: lease.viaNodeId, epoch: lease.epoch, expiresAt: lease.expiresAt, revokedAt: lease.revokedAt, materialPublished: lease.materialPublished, enrolment: lease.enrolment, installedFiles: lease.installedFiles, generation: lease.generation } };
};
const SHARE = "polytext-share-0001", ID = "claude-polytext", LABEL = "polytext";
try {
  const [a, b, f] = await Promise.all(dirs.map(d => startDaemon(d.dir, { stopTimeoutMs: 30_000 }))); handles.push(a!, b!, f!);
  let B = await b!.client(); const A = await a!.client(), F = await f!.client(); clients.push(A, B, F);
  const infoB = await B.request<DeployInfoResult>("deployInfo");
  await register(A, dirs[0]!.dir, "apiary-studio"); await register(B, dirs[1]!.dir, "apiary-mini"); await register(F, dirs[2]!.dir, "apiary-foreign");
  note(`capability account.lease.enrolled_renewal.v1 on the satellite: ${B.capabilities.includes("account.lease.enrolled_renewal.v1")}`);
  if (expect === "after") assert.ok(B.capabilities.includes("account.lease.enrolled_renewal.v1"));

  // A and F own a claude login each (vault material with a refresh chain; the mint blanks it).
  for (const [client, dir] of [[A, dirs[0]!.dir], [F, dirs[2]!.dir]] as const) {
    await client.request<AccountAddResult>("account.add", { harness: "claude", label: LABEL });
    const vault = join(dir, "vault", "claude", ID); mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, ".credentials.json"), credential(`fixture-refresh-${randomUUID()}`));
  }

  // B: the old scheme. The mini already holds the login as its own access-only row; Apiary enrols it in place.
  const homeB = join(dirs[1]!.dir, "homes", ID), vaultB = join(dirs[1]!.dir, "vault", "claude", ID);
  const accessOnly = credential("");
  for (const root of [homeB, vaultB]) { mkdirSync(root, { recursive: true }); writeFileSync(join(root, ".credentials.json"), accessOnly); }
  writeFileSync(join(homeB, "settings.json"), '{"localProfile":"preserved"}');
  await B.request("account.add", { id: ID, harness: "claude", label: LABEL, importExisting: true });
  const windowAt = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;
  const enrol = { id: ID, harness: "claude", label: LABEL, shareId: SHARE, authorityNodeId: "apiary-studio", viaNodeId: "apiary-studio", epoch: 1, expiresAt: windowAt(36), enrol: true, files: [{ homeRelPath: ".credentials.json", contentB64: b64(accessOnly), mode: 0o600 }] };
  const enrolled = await B.request<AccountLeaseInstallResult>("account.lease.install", enrol, 60_000);
  show("1. satellite row after the old-scheme enrolment", await rowOf(B, ID));
  assert.equal(enrolled.account.source, "leased"); assert.ok(enrolled.enrolment);

  // The mini06 state: the lease was revoked and its material swept, and the row's last publication is unknown
  // (installLease writes materialPublished: false first and never completed its final write on that node).
  const removed = await B.request<AccountLeaseRemoveResult>("account.lease.remove", { id: ID });
  assert.equal(removed.disposition, "revoked");
  B.close(); await b!.stop();
  const db = new DatabaseSync(join(dirs[1]!.dir, "core.sqlite3"));
  try { db.prepare("UPDATE accounts SET leased_from = json_set(leased_from, '$.materialPublished', json('false')) WHERE id = ?").run(ID); } finally { db.close(); }
  handles[1] = await startDaemon(dirs[1]!.dir, { stopTimeoutMs: 30_000 }); B = await handles[1].client(); clients.push(B);
  await register(B, dirs[1]!.dir, "apiary-mini");
  const stuck = await rowOf(B, ID);
  show("2. satellite row as mini06 held it: revoked, publication unknown, local material gone", { ...stuck, localMaterial: { home: existsSync(join(homeB, ".credentials.json")), vault: existsSync(join(vaultB, ".credentials.json")), profile: existsSync(join(homeB, "settings.json")) } });
  assert.equal(stuck.leasedFrom?.materialPublished, false); assert.ok(stuck.leasedFrom?.revokedAt); assert.ok(stuck.leasedFrom?.enrolment);

  // F forges a payload for B's share at the row's epoch: refused before and after.
  const foreign = await F.request<AccountLeaseGrantResult>("account.lease.grant", { id: ID, nodeId: "apiary-mini", authorityNodeId: "apiary-foreign", shareId: SHARE, epoch: 1 });
  const foreignRefusal = await code(B.request("account.lease.install", foreign.install, 60_000));
  note(`\nforeign authority (apiary-foreign) at the same share and epoch: ${foreignRefusal}`);
  assert.match(foreignRefusal, /^account_lease_conflict/);

  // The authority renews after its re-login: a plain install from the same share and authority.
  const grant = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: ID, nodeId: "apiary-mini", authorityNodeId: "apiary-studio", shareId: SHARE, epoch: 1 });
  assert.equal(grant.install.authorityNodeId, "apiary-studio"); assert.equal(grant.install.files.length, 1);
  const renewal = await code(B.request("account.lease.install", { ...grant.install, viaNodeId: "apiary-studio" }, 60_000));
  show("3. same-authority renewal into the stuck row", { outcome: renewal, payload: { shareId: grant.install.shareId, authorityNodeId: grant.install.authorityNodeId, epoch: grant.install.epoch, nodeId: grant.install.nodeId, files: grant.install.files.map(file => file.homeRelPath) } });
  if (expect === "before") {
    assert.equal(renewal, "account_lease_enrol_refused (unknown_material): No existing access-only primary credential can be proved; enrolment does not create a native account.");
    const still = await rowOf(B, ID); show("4. the row stays stuck", still);
    assert.equal(still.leasedFrom?.materialPublished, false); assert.ok(still.leasedFrom?.revokedAt);
    note("\nBEFORE THE FIX: the authority's renewal is refused for the enrolled row; Apiary retries it forever.");
  } else {
    assert.equal(renewal, "ok");
    const after = await rowOf(B, ID); show("4. the row after the renewal", { ...after, localMaterial: { home: existsSync(join(homeB, ".credentials.json")), vault: existsSync(join(vaultB, ".credentials.json")), profile: readFileSync(join(homeB, "settings.json"), "utf8") } });
    assert.equal(after.id, ID); assert.equal(after.source, "leased"); assert.equal(after.leasedFrom?.revokedAt, null); assert.equal(after.leasedFrom?.materialPublished, true);
    assert.deepEqual(after.leasedFrom?.enrolment, stuck.leasedFrom?.enrolment); assert.equal(after.leasedFrom?.authorityNodeId, "apiary-studio"); assert.equal(after.leasedFrom?.epoch, 1);
    assert.ok(existsSync(join(homeB, ".credentials.json")) && existsSync(join(vaultB, ".credentials.json")));
    assert.equal(readFileSync(join(homeB, "settings.json"), "utf8"), '{"localProfile":"preserved"}');
    assert.ok(readFileSync(join(dirs[1]!.dir, "hived.log"), "utf8").includes(`account.lease.enrolment_republished account=${ID}`), "the daemon logs the republish without a local primary");
    note(`\nhived.log on the satellite: ${readFileSync(join(dirs[1]!.dir, "hived.log"), "utf8").split("\n").filter(line => line.includes("account.lease.enrolment_republished")).map(line => JSON.parse(line).op).join("; ")}`);

    const again = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: ID, nodeId: "apiary-mini", authorityNodeId: "apiary-studio", ttlMs: 48 * 3_600_000 });
    const renewed = await code(B.request("account.lease.install", { ...again.install, viaNodeId: "apiary-studio" }, 60_000));
    const foreignAgain = await code(B.request("account.lease.install", (await F.request<AccountLeaseGrantResult>("account.lease.grant", { id: ID, nodeId: "apiary-mini", authorityNodeId: "apiary-foreign", ttlMs: 72 * 3_600_000 })).install, 60_000));
    show("5. the next renewal and another foreign attempt", { sameAuthorityRenewal: renewed, foreignAuthority: foreignAgain, row: await rowOf(B, ID) });
    assert.equal(renewed, "ok"); assert.match(foreignAgain, /^account_lease_conflict/);

    // The protective refusals stay: a refresh chain that appears locally while the publication is unknown is never replaced.
    await B.request("account.lease.remove", { id: ID }); B.close(); await handles[1]!.stop();
    const db2 = new DatabaseSync(join(dirs[1]!.dir, "core.sqlite3"));
    try { db2.prepare("UPDATE accounts SET leased_from = json_set(leased_from, '$.materialPublished', json('false')) WHERE id = ?").run(ID); } finally { db2.close(); }
    handles[1] = await startDaemon(dirs[1]!.dir, { stopTimeoutMs: 30_000 }); B = await handles[1].client(); clients.push(B);
    await register(B, dirs[1]!.dir, "apiary-mini");
    writeFileSync(join(homeB, ".credentials.json"), credential(`fixture-native-refresh-${randomUUID()}`));
    const third = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: ID, nodeId: "apiary-mini", authorityNodeId: "apiary-studio", ttlMs: 96 * 3_600_000 });
    const refreshChain = await code(B.request("account.lease.install", { ...third.install, viaNodeId: "apiary-studio" }, 60_000));
    rmSync(join(homeB, ".credentials.json"));
    const cleared = await code(B.request("account.lease.install", { ...third.install, viaNodeId: "apiary-studio" }, 60_000));
    show("6. refusals kept on the republish path", { localRefreshChainPresent: refreshChain, afterItIsGone: cleared, row: await rowOf(B, ID) });
    assert.match(refreshChain, /^account_lease_enrol_refused \(refresh_chain\)/); assert.equal(cleared, "ok");

    // Install after remove: the Apiary take-back then give sequence lands in the same row.
    await B.request("account.lease.remove", { id: ID });
    const fourth = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: ID, nodeId: "apiary-mini", authorityNodeId: "apiary-studio", ttlMs: 120 * 3_600_000 });
    const afterRemove = await code(B.request("account.lease.install", { ...fourth.install, viaNodeId: "apiary-studio" }, 60_000));
    show("7. install after lease.remove", { outcome: afterRemove, row: await rowOf(B, ID) });
    assert.equal(afterRemove, "ok");
    note(`\nnode ${infoB.nodeId} (the satellite) renewed its enrolled row from its authority; no foreign payload installed.`);
    note("AFTER THE FIX: ALL CHECKS PASSED");
  }
  for (const [name, handle] of [["A", handles[0]!], ["B", handles[1]!], ["F", handles[2]!]] as const) for (const secret of SECRETS) assert.ok(!handle.output().includes(secret), `no credential bytes in daemon ${name} output`);
  note("no access or refresh token appears in any daemon's output");
} finally {
  for (const client of clients) client.close();
  await Promise.allSettled(handles.map(forceStopTestDaemon));
  for (const d of dirs) d.cleanup();
}
