import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcClient } from "../../cli/src/client.ts";
import { runV2Cli } from "../../cli/src/main.ts";
import { DEFAULT_LEASE_GRANT_TTL_MS, RpcError, type AccountAddResult, type AccountGetResult, type AccountLeaseBatchResult, type AccountLeaseGrantResult, type AccountLeaseInstallResult, type AccountLeaseRemoveResult, type AuditTailResult, type DeployInfoResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, type DaemonHandle } from "./helpers.ts";

const CODEX_REFRESH = "FIXTURE-CODEX-REFRESH-TOKEN-grant-x1y2";
const fakeJwt = (expSeconds: number): string => {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`;
};
const proofLog = process.env.HB_LEASE_PROOF_LOG;
const note = (line: string) => { if (proofLog) appendFileSync(proofLog, `${line}\n`); };
const show = (label: string, value: unknown) => note(`\n## ${label}\n${JSON.stringify(value, (key, v) => key === "files" || key === "contentB64" ? "<secret material elided>" : v, 2)}`);

test("account.lease.grant / account.lease.batch: two daemons — grant, install, renew, release, move, bulk with one key, typed refusals, ingress gates, capability tag", { timeout: 240_000 }, async t => {
  const owner = makeDaemonDir(), target = makeDaemonDir();
  const handles: DaemonHandle[] = [], clients: RpcClient[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => { clients.forEach(c => c.close()); await Promise.allSettled(handles.map(forceStopTestDaemon)); owner.cleanup(); target.cleanup(); })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  if (proofLog) writeFileSync(proofLog, `# hb-lease-verbs end-to-end run ${new Date().toISOString()}\nowner daemon (node A) data dir: ${owner.dir}\ntarget daemon (node B) data dir: ${target.dir}\n`);
  try {
    const a = await startDaemon(owner.dir, { stopTimeoutMs: 30_000 }); handles.push(a);
    const b = await startDaemon(target.dir, { stopTimeoutMs: 30_000 }); handles.push(b);
    const A = await a.client(), B = await b.client(); clients.push(A, B);
    const infoA = await A.request<DeployInfoResult>("deployInfo"), infoB = await B.request<DeployInfoResult>("deployInfo");
    assert.ok(infoA.capabilities.includes("account.lease.grant.v1") && A.capabilities.includes("account.lease.grant.v1"), "the hello and deployInfo advertise the tag");
    assert.ok(infoB.capabilities.includes("account.lease.grant.v1"));
    note(`node A advertises account.lease.grant.v1: ${A.capabilities.includes("account.lease.grant.v1")}; node B: ${B.capabilities.includes("account.lease.grant.v1")}`);

    const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
    await A.request<AccountAddResult>("account.add", { harness: "codex", label: "lx" });
    const vaultDir = join(owner.dir, "vault", "codex", "codex-lx");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "auth.json"), JSON.stringify({ tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct" } }));
    await A.request<AccountAddResult>("account.add", { harness: "stub", label: "s" });
    // grant on the owner
    const before = Date.now();
    const granted = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-lx", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1 });
    show("A: account.lease.grant codex-lx → node-b (default window)", granted);
    assert.equal(granted.grant.account, "codex-lx"); assert.equal(granted.grant.nodeId, "node-b"); assert.equal(granted.grant.ttlMs, DEFAULT_LEASE_GRANT_TTL_MS);
    assert.ok(granted.grant.expiresAt * 1000 >= before + DEFAULT_LEASE_GRANT_TTL_MS - 1000 && granted.grant.expiresAt * 1000 <= Date.now() + DEFAULT_LEASE_GRANT_TTL_MS);
    assert.equal(granted.grant.materialExpiresAt, exp);
    assert.equal(granted.install.id, "codex-lx"); assert.equal(granted.install.harness, "codex"); assert.equal(granted.install.shareId, "share-codex-lx"); assert.equal(granted.install.epoch, 1);
    assert.equal(granted.install.authorityNodeId, granted.grant.authorityNodeId); assert.equal(granted.install.expiresAt, granted.grant.expiresAt);
    const shipped = JSON.parse(Buffer.from(granted.install.files[0]!.contentB64, "base64").toString("utf8")) as { tokens: Record<string, unknown> };
    assert.equal(shipped.tokens.refresh_token, ""); assert.equal(shipped.tokens.access_token, fakeJwt(exp));

    // install on the target with the payload as returned
    const installed = await B.request<AccountLeaseInstallResult>("account.lease.install", { ...granted.install }, 60_000);
    show("B: account.lease.install (payload from A)", { account: installed.account.id, source: installed.account.source, status: installed.account.status, leasedFrom: installed.account.leasedFrom });
    assert.equal(installed.account.source, "leased"); assert.equal(installed.account.leasedFrom?.authorityNodeId, granted.grant.authorityNodeId); assert.equal(installed.account.leasedFrom?.expiresAt, granted.grant.expiresAt);

    // renew: same share and epoch, later window
    const renewed = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-lx", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1, ttlMs: 48 * 3_600_000 });
    assert.ok(renewed.grant.expiresAt > granted.grant.expiresAt);
    const reinstalled = await B.request<AccountLeaseInstallResult>("account.lease.install", { ...renewed.install }, 60_000);
    show("B: renew = install again with the later window", { expiresAt: reinstalled.account.leasedFrom?.expiresAt });
    assert.equal(reinstalled.account.leasedFrom?.expiresAt, renewed.grant.expiresAt);
    const shorter = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-lx", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1, ttlMs: 3_600_000 });
    await assert.rejects(B.request("account.lease.install", { ...shorter.install }, 60_000), (e: unknown) => e instanceof RpcError && e.code === "account_lease_conflict");
    note("B: a shorter window at the same epoch is refused account_lease_conflict (a lease window never regresses)");

    // typed refusals on the owner
    const refusals: Record<string, string> = {};
    for (const [label, params] of Object.entries({
      "unknown account": { id: "nope", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1 },
      "harness without a lease strategy": { id: "stub-s", nodeId: "node-b", shareId: "share-stub-s", epoch: 1 },
      "self grant": { id: "codex-lx", nodeId: granted.grant.authorityNodeId, shareId: "share-codex-lx", epoch: 1 },
      "bad window": { id: "codex-lx", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1, ttlMs: 10 },
      "bad share": { id: "codex-lx", nodeId: "node-b", shareId: "x", epoch: 1 },
    })) {
      await assert.rejects(A.request("account.lease.grant", params), (e: unknown) => { refusals[label] = e instanceof RpcError ? `${e.code}${e.details?.reason ? ` (${String(e.details.reason)})` : ""}` : String(e); return e instanceof RpcError; });
    }
    await assert.rejects(B.request("account.lease.grant", { id: "codex-lx", nodeId: "node-c", shareId: "share-codex-lx", epoch: 1 }), (e: unknown) => { refusals["grant from a node that only holds a leased copy"] = e instanceof RpcError ? e.code : String(e); return e instanceof RpcError && e.code === "account_leased"; });
    await A.request("account.pause", { id: "codex-lx" });
    await assert.rejects(A.request("account.lease.grant", { id: "codex-lx", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1 }), (e: unknown) => { refusals["paused account"] = e instanceof RpcError ? e.code : String(e); return e instanceof RpcError && e.code === "account_paused"; });
    await A.request("account.unpause", { id: "codex-lx" });
    show("A: typed refusals", refusals);
    assert.equal(refusals["unknown account"], "account_not_found"); assert.equal(refusals["harness without a lease strategy"], "lease_unsupported"); assert.equal(refusals["self grant"], "invalid_request (self_grant)");

    // bulk on the owner under one key: every item answers, refusals are per item
    const items = [
      { op: "grant", id: "codex-lx", nodeId: "node-b", shareId: "share-codex-lx", epoch: 1, ttlMs: 72 * 3_600_000 },
      { op: "grant", id: "codex-lx", nodeId: "node-c", shareId: "share-codex-lx", epoch: 1, ttlMs: 72 * 3_600_000 },
      { op: "grant", id: "stub-s", nodeId: "node-b", shareId: "share-stub-s", epoch: 1 },
      { op: "grant", id: "nope", nodeId: "node-b", shareId: "share-nope", epoch: 1 },
    ];
    const batch = await A.request<AccountLeaseBatchResult>("account.lease.batch", { items, idempotencyKey: "grid-all-row-codex-lx" }, 60_000);
    show("A: account.lease.batch (4 grants, one key)", batch);
    assert.deepEqual(batch.results.map(r => r.ok), [true, true, false, false]); assert.deepEqual(batch.counts, { ok: 2, failed: 2 }); assert.equal(batch.deduped, undefined);
    assert.equal((batch.results[2] as { error: { code: string } }).error.code, "lease_unsupported"); assert.equal((batch.results[3] as { error: { code: string } }).error.code, "account_not_found");
    const replay = await A.request<AccountLeaseBatchResult>("account.lease.batch", { items, idempotencyKey: "grid-all-row-codex-lx" }, 60_000);
    show("A: same key replayed", { deduped: replay.deduped, counts: replay.counts, sameWindows: replay.results.map((r, i) => r.ok && r.op === "grant" ? r.result.grant.expiresAt === (batch.results[i] as { result: AccountLeaseGrantResult }).result.grant.expiresAt : null) });
    assert.equal(replay.deduped, true); assert.deepEqual(replay.results.map(r => r.ok), [true, true, false, false]);
    for (const [i, r] of replay.results.entries()) if (r.ok && r.op === "grant") { const first = batch.results[i] as { result: AccountLeaseGrantResult }; assert.equal(r.result.grant.expiresAt, first.result.grant.expiresAt); assert.equal(r.result.grant.grantedAt, first.result.grant.grantedAt); assert.ok(r.result.install.files.length > 0, "a replayed grant is minted again"); }
    await assert.rejects(A.request("account.lease.batch", { items, idempotencyKey: "grid-all-row-codex-lx" }).then(() => A.request("account.pause", { id: "codex-lx", idempotencyKey: "grid-all-row-codex-lx" })), (e: unknown) => e instanceof RpcError && e.code === "idempotency_conflict");

    // bulk on the target: install the two grants, then release everything; move = release here + grant/install elsewhere
    const installs = batch.results.filter(r => r.ok && r.op === "grant").map(r => ({ op: "install", ...(r as { result: AccountLeaseGrantResult }).result.install }));
    const installBatch = await B.request<AccountLeaseBatchResult>("account.lease.batch", { items: installs, idempotencyKey: "grid-install-node-b" }, 60_000);
    show("B: account.lease.batch (installs from the grants)", { counts: installBatch.counts, ops: installBatch.results.map(r => `${r.op}:${r.id}:${r.ok}${r.ok ? "" : ` ${r.error.code}: ${r.error.message}`}`) });
    assert.equal(installBatch.counts.failed, 0);
    const leasedId = installed.account.id;
    assert.notEqual(leasedId, "codex-lx", "a leased copy gets its own companion row id on the target");
    assert.ok(installBatch.results.every(r => r.id === leasedId), "install items report the installed row id");
    const releaseBatch = await B.request<AccountLeaseBatchResult>("account.lease.batch", { items: [{ op: "release", id: leasedId }, { op: "release", id: "absent-account" }], idempotencyKey: "grid-release-node-b" }, 60_000);
    show("B: account.lease.batch (release)", releaseBatch);
    assert.equal(releaseBatch.results[0]!.ok, true); assert.equal((releaseBatch.results[0] as { result: AccountLeaseRemoveResult }).result.disposition, "revoked"); assert.ok((releaseBatch.results[0] as { result: AccountLeaseRemoveResult }).result.revokedAt);
    assert.equal((releaseBatch.results[1] as { result: AccountLeaseRemoveResult }).result.disposition, "absent");
    const releasedRow = await B.request<AccountGetResult>("account.get", { id: leasedId });
    assert.ok(releasedRow.account.leasedFrom?.revokedAt, "the leased row records its revocation");
    const releaseReplay = await B.request<AccountLeaseBatchResult>("account.lease.batch", { items: [{ op: "release", id: leasedId }, { op: "release", id: "absent-account" }], idempotencyKey: "grid-release-node-b" }, 60_000);
    assert.equal(releaseReplay.deduped, true); assert.deepEqual(releaseReplay.results, releaseBatch.results);
    const moved = await A.request<AccountLeaseGrantResult>("account.lease.grant", { id: "codex-lx", nodeId: "node-c", shareId: "share-codex-lx", epoch: 1, ttlMs: 96 * 3_600_000 });
    const movedIn = await B.request<AccountLeaseInstallResult>("account.lease.install", { ...moved.install }, 60_000);
    show("move: release on the old node, grant for the new node, install there (B stands in for node-c)", { account: movedIn.account.id, source: movedIn.account.source, revokedAt: movedIn.account.leasedFrom?.revokedAt, expiresAt: movedIn.account.leasedFrom?.expiresAt });
    assert.equal(movedIn.account.leasedFrom?.revokedAt, null); assert.equal(movedIn.account.leasedFrom?.expiresAt, moved.grant.expiresAt);

    // ingress gates reach into batch items
    const relay = await RpcClient.connect(b.socketPath, 3000, "node_relay"); clients.push(relay);
    await assert.rejects(relay.request("account.lease.batch", { items: [{ op: "install", ...moved.install, viaNodeId: "upstream" }] }), (e: unknown) => e instanceof RpcError && e.code === "account_lease_enrol_refused" && e.details?.reason === "local_required");
    await assert.rejects(relay.request("account.lease.batch", { items: [{ op: "release", id: leasedId, discardNative: true, confirm: true }] }), (e: unknown) => e instanceof RpcError && e.code === "account_lease_remove_unavailable");
    const relayed = await relay.request<AccountLeaseBatchResult>("account.lease.batch", { items: [{ op: "install", ...moved.install }] }, 60_000);
    assert.equal(relayed.counts.failed, 0);
    note("B: node_relay ingress — forwarded-fence/enrol and native-discard items are refused local_required; a plain install item is admitted");

    // an older client (no tag in its hello) keeps every existing verb; the new verbs are unknown to it and ignored
    const older = await RpcClient.connect(a.socketPath, 3000, undefined, { capabilities: ["account.lease.v1", "account.lease.install.v1"] }); clients.push(older);
    const olderList = await older.request<{ accounts: Array<{ id: string }> }>("account.list", {});
    assert.ok(olderList.accounts.some(acc => acc.id === "codex-lx"));
    const olderLease = await older.request<{ files: unknown[] }>("account.lease", { account: "codex-lx" });
    assert.equal(olderLease.files.length, 1);
    note("A: a client whose hello lacks account.lease.grant.v1 still runs account.list and account.lease unchanged");

    // CLI edge
    const out: string[] = [], err: string[] = [];
    assert.equal(await runV2Cli(["--data-dir", owner.dir, "--json", "account", "lease", "grant", "codex-lx", "--node", "node-b", "--share", "share-codex-lx", "--epoch", "1", "--ttl-ms", String(2 * 3_600_000)], { out: l => out.push(l), err: l => err.push(l) }), 0, err.join("\n"));
    const cliGrant = JSON.parse(out.at(-1)!) as AccountLeaseGrantResult;
    assert.equal(cliGrant.grant.ttlMs, 2 * 3_600_000);
    show("CLI: hive account lease grant codex-lx --node node-b --share share-codex-lx --epoch 1 --ttl-ms 7200000 --json", cliGrant.grant);
    const file = join(owner.dir, "items.json");
    writeFileSync(file, JSON.stringify([{ op: "grant", id: "codex-lx", nodeId: "node-d", shareId: "share-codex-lx", epoch: 1 }]));
    out.length = 0;
    assert.equal(await runV2Cli(["--data-dir", owner.dir, "--json", "account", "lease", "batch", "--file", file, "--idempotency-key", "cli-batch-1"], { out: l => out.push(l), err: l => err.push(l) }), 0, err.join("\n"));
    const cliBatch = JSON.parse(out.at(-1)!) as AccountLeaseBatchResult;
    assert.deepEqual(cliBatch.counts, { ok: 1, failed: 0 });
    show("CLI: hive account lease batch --file items.json --idempotency-key cli-batch-1 --json", { counts: cliBatch.counts });
    out.length = 0;
    assert.equal(await runV2Cli(["--data-dir", owner.dir, "account", "lease", "grant", "codex-lx", "--node", "node-b", "--share", "share-codex-lx", "--epoch", "1"], { out: l => out.push(l), err: l => err.push(l) }), 1, "grant without --json is a usage error");

    // secrets stay in verb results only
    const auditA = await A.request<AuditTailResult>("audit.tail", { limit: 2000 });
    const grants = auditA.rows.filter(row => row.kind === "account.lease.granted");
    show("A: audit rows account.lease.granted (secret-free)", grants.map(row => row.payload));
    assert.ok(grants.length >= 6, `grant audit rows: ${grants.length}`);
    assert.ok(grants.every(row => (row.payload as { nodeId: string }).nodeId !== undefined));
    for (const haystack of [JSON.stringify(auditA.rows), a.output(), b.output()]) { assert.ok(!haystack.includes(CODEX_REFRESH)); assert.ok(!haystack.includes(fakeJwt(exp))); assert.ok(!haystack.includes(granted.install.files[0]!.contentB64)); }
    await a.stop(); await b.stop();
    for (const dir of [owner.dir, target.dir]) {
      const db = new DatabaseSync(join(dir, "core.sqlite3"), { readOnly: true });
      try { const rows = JSON.stringify(db.prepare("SELECT * FROM rpc_idempotency").all()); assert.ok(!rows.includes(fakeJwt(exp)) && !rows.includes(granted.install.files[0]!.contentB64), "no credential bytes in the idempotency receipts"); } finally { db.close(); }
    }
    note("\nno refresh token, access token or payload bytes in the audit stream, daemon output, or the rpc_idempotency receipts of either node");
  } finally { await cleanup(); }
});
