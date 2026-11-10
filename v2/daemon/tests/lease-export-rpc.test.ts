import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcClient } from "../../cli/src/client.ts";
import { runV2Cli } from "../../cli/src/main.ts";
import { RpcError, type AccountLeaseExportResult, type AccountLeaseInstallResult, type AuditTailResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, type DaemonHandle } from "./helpers.ts";
import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import type { AccountAddResult, AccountLeaseBatchResult, AccountLeaseGrantResult, DeployInfoResult } from "../src/protocol.ts";

test("leased export RPC: scoped original artifact is transient, local-only, uncached, restart-safe and revoke-fenced", { timeout: 120_000 }, async t => {
  const root = makeDaemonDir();
  const handles: DaemonHandle[] = [];
  const clients: RpcClient[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    for (const client of clients) client.close();
    const results = await Promise.allSettled(handles.map(forceStopTestDaemon)); root.cleanup();
    for (const result of results) if (result.status === "rejected") throw result.reason;
  })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  let daemon: DaemonHandle;
  let client: RpcClient;
  const open = async () => {
    daemon = await startDaemon(root.dir, { env: { HOME: join(root.dir, "empty-home"), HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1" }, stopTimeoutMs: 30_000 });
    handles.push(daemon); client = await daemon.client(); clients.push(client);
  };
  const token = randomUUID(), instance = randomUUID(), expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const contentB64 = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "", expiresAt: expiresAt * 1000 } })).toString("base64");
  const install = { id: "claude-export-holder", harness: "claude", label: "holder", shareId: "original-share", authorityNodeId: "original-authority", authorityInstanceId: instance, viaNodeId: "upstream-route", epoch: 7, generation: 12, expiresAt, files: [{ homeRelPath: ".credentials.json", contentB64, mode: 0o600 }] };
  const fingerprint = (roots: string[]) => roots.map(base => readdirSync(base, { recursive: true }).map(String).filter(path => lstatSync(join(base, path)).isFile()).sort().map(path => [path, createHash("sha256").update(readFileSync(join(base, path))).digest("hex").slice(0, 12)]));
  try {
    await open();
    assert.ok(client!.capabilities.includes("account.lease.export.v1"));
    const installed = await client!.request<AccountLeaseInstallResult>("account.lease.install", install, 60_000);
    const id = installed.account.id;
    const dirs = [installed.account.homePath, join(root.dir, "vault", "claude", id)];
    const before = fingerprint(dirs);
    const params = { id, idempotencyKey: "export-is-not-cached" };
    const first = await client!.request<AccountLeaseExportResult>("account.lease.export", params);
    assert.equal(first.authorityNodeId, install.authorityNodeId); assert.equal(first.authorityInstanceId, instance);
    assert.equal(first.shareId, install.shareId); assert.equal(first.epoch, 7); assert.equal(first.generation, 12); assert.equal(first.expiresAt, expiresAt);
    const decoded = Buffer.from(first.files[0]!.contentB64, "base64").toString("utf8");
    assert.ok(JSON.parse(decoded).claudeAiOauth.accessToken === token, "same installed access token");
    assert.ok(JSON.parse(decoded).claudeAiOauth.refreshToken === "", "refresh grant stays blank");
    const relay = await RpcClient.connect(daemon!.socketPath, 3000, "node_relay"); clients.push(relay);
    await assert.rejects(relay.request("account.lease.export", params), error => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === "local_required");
    const remote = await RpcClient.connect(daemon!.socketPath, 3000, "remote"); clients.push(remote);
    await assert.rejects(remote.request("account.lease.export", params), error => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === "local_required");
    const out: string[] = [], err: string[] = [];
    assert.equal(await runV2Cli(["--data-dir", root.dir, "--json", "account", "lease", "export", id], { out: line => out.push(line), err: line => err.push(line) }), 0);
    assert.equal((JSON.parse(out.at(-1)!) as AccountLeaseExportResult).authorityInstanceId, instance);
    out.length = 0;
    assert.equal(await runV2Cli(["--data-dir", root.dir, "account", "lease", "export", id], { out: line => out.push(line), err: line => err.push(line) }), 1);
    assert.equal(out.length, 0);
    assert.equal(await runV2Cli(["--data-dir", root.dir, "--json", "account", "lease", "export"], { out: line => out.push(line), err: line => err.push(line) }), 1);
    assert.ok(err.some(line => line.includes("usage:")));
    await daemon!.stop(); await open();
    const second = await client!.request<AccountLeaseExportResult>("account.lease.export", params);
    assert.equal(second.generation, first.generation); assert.equal(second.authorityInstanceId, instance); assert.equal(second.expiresAt, expiresAt);
    assert.deepEqual(fingerprint(dirs), before);
    const audit = await client!.request<AuditTailResult>("audit.tail", { limit: 1000 });
    assert.equal(audit.rows.filter(row => row.kind === "account.lease.exported").length, 3);
    assert.ok(!JSON.stringify(audit).includes(token), "no access token in ledger"); assert.ok(!JSON.stringify(audit).includes(first.files[0]!.contentB64), "no payload in ledger");
    await client!.request("account.lease.remove", { id });
    await assert.rejects(client!.request("account.lease.export", { id }), error => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === "revoked");
    await daemon!.stop();
    const db = new DatabaseSync(join(root.dir, "core.sqlite3"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM rpc_idempotency").all();
      assert.ok(!JSON.stringify(rows).includes(token), "no credential bytes in RPC result cache");
      assert.ok(!JSON.stringify(rows).includes(first.files[0]!.contentB64), "no exported artifact in RPC result cache");
    } finally { db.close(); }
    assert.ok(!handles.some(handle => handle.output().includes(token)), "no token in daemon output");
  } finally { await cleanup(); }
});
const CODEX_REFRESH = "FIXTURE-CODEX-REFRESH-TOKEN-fix-x1y2";
const fakeJwt = (expSeconds: number): string => { const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expSeconds, sub: "fixture" })}.FIXTURESIG`; };
const proofLog = process.env.HB_LEASE_PROOF_LOG;
const note = (line: string) => { if (proofLog) appendFileSync(proofLog, `${line}\n`); };
const show = (label: string, value: unknown) => note(`\n## ${label}\n${JSON.stringify(value, (k, v) => k === "files" || k === "contentB64" ? "<secret material elided>" : v, 2)}`);
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return "ok"; } catch (e) { return e instanceof RpcError ? `${e.code}${e.details?.reason ? ` (${String(e.details.reason)})` : ""}` : String(e); } };

test("hb-lease-fix: trusted-caller gate, owner-signed authority, node-bound payloads, key bound to items/principal, audited replays, redacted CLI", { timeout: 240_000 }, async t => {
  const dirs = [makeDaemonDir(), makeDaemonDir(), makeDaemonDir()];
  const handles: DaemonHandle[] = [], clients: RpcClient[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => { clients.forEach(c => c.close()); await Promise.allSettled(handles.map(forceStopTestDaemon)); dirs.forEach(d => d.cleanup()); })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  for (const d of dirs) { const cfg = JSON.parse(readFileSync(join(d.dir, "config.json"), "utf8")); cfg.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: join(d.dir, "rpc-private", "registration.key") }; writeFileSync(join(d.dir, "config.json"), JSON.stringify(cfg)); }
  if (proofLog) writeFileSync(proofLog, `# hb-lease-fix recorded run ${new Date().toISOString()}\nthree scratch daemons with local trust enabled: A (owner), B (target), C (CLI check)\n`);
  const register = async (client: RpcClient, dir: string, nodeId: string) => {
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(join(dir, "rpc-private", "registration.key"));
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", { pid: challenge.pid, challengeId: challenge.challengeId, token, nodeId });
  };
  try {
    const [a, b, c] = await Promise.all(dirs.map(d => startDaemon(d.dir, { stopTimeoutMs: 30_000 }))); handles.push(a!, b!, c!);
    const A = await a!.client(), B = await b!.client(); clients.push(A, B);
    const infoA = await A.request<DeployInfoResult>("deployInfo"), infoB = await B.request<DeployInfoResult>("deployInfo");
    assert.ok(infoA.nodeId && infoB.nodeId, "deployInfo carries the node id");
    const exp = Math.floor(Date.now() / 1000) + 8 * 24 * 3600;
    await A.request<AccountAddResult>("account.add", { harness: "codex", label: "Lx personal", id: "codex-lx" });
    const vaultDir = join(dirs[0]!.dir, "vault", "codex", "codex-lx"); mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "auth.json"), JSON.stringify({ tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct" } }));
    const grantFor = (nodeId: string, extra: Record<string, unknown> = {}) => ({ id: "codex-lx", nodeId, shareId: "share-codex-lx", epoch: 1, ...extra });

    // M3: only the registered local authority may grant or batch
    const gates: Record<string, string> = {};
    gates["unregistered local client: grant"] = await code(A.request("account.lease.grant", grantFor("node-b")));
    gates["unregistered local client: batch"] = await code(A.request("account.lease.batch", { items: [{ op: "grant", ...grantFor("node-b") }] }));
    const relay = await RpcClient.connect(a!.socketPath, 3000, "node_relay"); clients.push(relay);
    gates["node_relay lane: grant"] = await code(relay.request("account.lease.grant", grantFor("node-b")));
    const remote = await RpcClient.connect(a!.socketPath, 3000, "remote"); clients.push(remote);
    gates["remote lane: batch"] = await code(remote.request("account.lease.batch", { items: [{ op: "release", id: "codex-lx" }] }));
    await register(A, dirs[0]!.dir, "apiary-node-a"); await register(B, dirs[1]!.dir, "apiary-node-b");
    gates["registered local authority: grant"] = await code(A.request("account.lease.grant", grantFor("apiary-node-b")));
    show("M3 caller gate", gates);
    assert.equal(gates["unregistered local client: grant"], "caller_not_trusted (registration_required)"); assert.equal(gates["unregistered local client: batch"], "caller_not_trusted (registration_required)");
    assert.equal(gates["node_relay lane: grant"], "caller_not_trusted"); assert.equal(gates["remote lane: batch"], "caller_not_trusted"); assert.equal(gates["registered local authority: grant"], "ok");

    // M2: authorityNodeId is this node or its registered alias, nothing else
    const authority: Record<string, string> = {};
    authority["foreign authorityNodeId"] = await code(A.request("account.lease.grant", grantFor("apiary-node-b", { authorityNodeId: "node-q" })));
    authority["authorityNodeId = B's id (another node)"] = await code(A.request("account.lease.grant", grantFor("apiary-node-b", { authorityNodeId: infoB.nodeId })));
    authority["authorityNodeId = own store id"] = await code(A.request("account.lease.grant", grantFor("apiary-node-b", { authorityNodeId: infoA.nodeId })));
    authority["authorityNodeId = own registered alias"] = await code(A.request("account.lease.grant", grantFor("apiary-node-b", { authorityNodeId: "apiary-node-a" })));
    authority["self grant to the registered alias"] = await code(A.request("account.lease.grant", grantFor("apiary-node-a")));
    authority["self grant to the store id"] = await code(A.request("account.lease.grant", grantFor(infoA.nodeId!)));
    show("M2 authority binding", authority);
    assert.equal(authority["foreign authorityNodeId"], "invalid_request (authority_node_id)"); assert.equal(authority["authorityNodeId = B's id (another node)"], "invalid_request (authority_node_id)");
    assert.equal(authority["authorityNodeId = own store id"], "ok"); assert.equal(authority["authorityNodeId = own registered alias"], "ok");
    assert.equal(authority["self grant to the registered alias"], "invalid_request (self_grant)"); assert.equal(authority["self grant to the store id"], "invalid_request (self_grant)");

    // L1: the payload names its node; the receiving node refuses a payload addressed elsewhere
    const granted = await A.request<AccountLeaseGrantResult>("account.lease.grant", grantFor("apiary-node-b"));
    assert.equal(granted.install.nodeId, "apiary-node-b"); assert.equal(granted.grant.authorityNodeId, infoA.nodeId);
    assert.equal(granted.install.label, "Lx personal", "grant carries the owner's human label");
    const bound: Record<string, string> = {};
    bound["payload for B installed on B (registered alias)"] = await code(B.request("account.lease.install", { ...granted.install }, 60_000));
    const forStore = await A.request<AccountLeaseGrantResult>("account.lease.grant", grantFor(infoB.nodeId!, { ttlMs: 48 * 3_600_000 }));
    bound["payload for B's store id installed on B"] = await code(B.request("account.lease.install", { ...forStore.install }, 60_000));
    const forX = await A.request<AccountLeaseGrantResult>("account.lease.grant", grantFor("node-x", { ttlMs: 72 * 3_600_000 }));
    bound["payload for node-x installed on B"] = await code(B.request("account.lease.install", { ...forX.install }, 60_000));
    bound["payload for B installed on A (the owner)"] = await code(A.request("account.lease.install", { ...granted.install, id: "codex-lx-copy", label: "copy" }, 60_000));
    show("L1 node-bound payloads", bound);
    assert.equal(bound["payload for B installed on B (registered alias)"], "ok"); assert.deepEqual((await B.request<{ accounts: Array<{ id: string; label: string }> }>("account.list")).accounts.map(row => row.label), ["Lx personal"], "B installs the human label"); assert.equal(bound["payload for B's store id installed on B"], "ok");
    assert.equal(bound["payload for node-x installed on B"], "account_lease_conflict (node_mismatch)"); assert.equal(bound["payload for B installed on A (the owner)"], "account_lease_conflict (node_mismatch)");

    // M1: the key is bound to the items digest and the principal; replays re-mint under the recorded window and audit replay:true
    const items = [{ op: "grant", ...grantFor("apiary-node-b", { ttlMs: 96 * 3_600_000 }) }, { op: "grant", ...grantFor("node-c", { ttlMs: 96 * 3_600_000 }) }, { op: "grant", id: "nope", nodeId: "node-c", shareId: "share-nope", epoch: 1 }];
    const first = await A.request<AccountLeaseBatchResult>("account.lease.batch", { items, idempotencyKey: "grid-row-codex-lx" }, 60_000);
    assert.deepEqual(first.results.map(r => r.ok), [true, true, false]);
    const auditBefore = (await A.request<AuditTailResult>("audit.tail", { limit: 2000 })).rows.filter(r => r.kind === "account.lease.granted");
    const replay = await A.request<AccountLeaseBatchResult>("account.lease.batch", { items, idempotencyKey: "grid-row-codex-lx" }, 60_000);
    const auditAfter = (await A.request<AuditTailResult>("audit.tail", { limit: 2000 })).rows.filter(r => r.kind === "account.lease.granted");
    const keyed: Record<string, unknown> = {
      "same key + same items": { deduped: replay.deduped, okPattern: replay.results.map(r => r.ok), sameWindows: replay.results.map((r, i) => r.ok && r.op === "grant" ? r.result.grant.expiresAt === (first.results[i] as { result: AccountLeaseGrantResult }).result.grant.expiresAt : null), freshMaterial: replay.results.every(r => !r.ok || r.op !== "grant" || r.result.install.files.length > 0) },
      "audit rows account.lease.granted before/after replay": { before: auditBefore.length, after: auditAfter.length, replayRows: auditAfter.slice(auditBefore.length).map(r => (r.payload as { replay?: boolean; nodeId: string }).replay === true ? `${(r.payload as { nodeId: string }).nodeId}:replay` : "not-replay") },
      "same key + different items": await code(A.request("account.lease.batch", { items: items.slice(0, 1), idempotencyKey: "grid-row-codex-lx" }, 60_000)),
      "same key + items reordered": await code(A.request("account.lease.batch", { items: [items[1], items[0], items[2]], idempotencyKey: "grid-row-codex-lx" }, 60_000)),
      "same key + another verb": await code(A.request("account.pause", { id: "codex-lx", idempotencyKey: "grid-row-codex-lx" })),
    };
    show("M1 key binding", keyed);
    assert.equal(replay.deduped, true); assert.deepEqual(replay.results.map(r => r.ok), [true, true, false]);
    assert.equal(auditAfter.length, auditBefore.length + 2, "every replayed mint audits"); assert.ok(auditAfter.slice(auditBefore.length).every(r => (r.payload as { replay?: boolean }).replay === true));
    assert.equal(keyed["same key + different items"], "idempotency_conflict (items)"); assert.equal(keyed["same key + items reordered"], "idempotency_conflict (items)"); assert.equal(keyed["same key + another verb"], "idempotency_conflict");

    // L3: the receipt is reserved before items run and settles after; its stored form is secret-free
    await a!.stop();
    const db = new DatabaseSync(join(dirs[0]!.dir, "core.sqlite3"), { readOnly: true });
    try {
      const row = db.prepare("SELECT result FROM rpc_idempotency WHERE key = ?").get("grid-row-codex-lx") as { result: string };
      const receipt = JSON.parse(row.result) as { principal: string; itemsDigest: string; pending?: boolean; entries?: unknown[] };
      show("L3 receipt shape (secret-free)", { principal: receipt.principal, itemsDigest: receipt.itemsDigest.slice(0, 16) + "…", pending: receipt.pending ?? false, entries: receipt.entries?.length });
      assert.equal(receipt.pending, undefined); assert.equal(receipt.entries?.length, 3); assert.match(receipt.principal, /^\d+:apiary-node-a$/);
      assert.ok(!row.result.includes(fakeJwt(exp)) && !row.result.includes(granted.install.files[0]!.contentB64), "no credential bytes in the receipt");
    } finally { db.close(); }

    // L4: the CLI writes material to --out (0600) and prints a redacted result; --register makes the CLI the trusted caller on a scratch node
    const C = await c!.client(); clients.push(C);
    await C.request<AccountAddResult>("account.add", { harness: "codex", label: "lx" }); C.close();
    const vaultC = join(dirs[2]!.dir, "vault", "codex", "codex-lx"); mkdirSync(vaultC, { recursive: true });
    writeFileSync(join(vaultC, "auth.json"), JSON.stringify({ tokens: { id_token: "id-fixture", access_token: fakeJwt(exp), refresh_token: CODEX_REFRESH, account_id: "acct" } }));
    const outFile = join(dirs[2]!.dir, "material.json"), out: string[] = [], err: string[] = [];
    assert.equal(await runV2Cli(["--data-dir", dirs[2]!.dir, "--json", "account", "lease", "grant", "codex-lx", "--node", "node-b", "--share", "share-codex-lx", "--epoch", "1"], { out: l => out.push(l), err: l => err.push(l) }), 1, "without --register the CLI is an unregistered local peer");
    assert.ok(err.join("\n").includes("caller_not_trusted"), err.join("\n"));
    out.length = 0; err.length = 0;
    assert.equal(await runV2Cli(["--data-dir", dirs[2]!.dir, "--json", "account", "lease", "grant", "codex-lx", "--node", "node-b", "--share", "share-codex-lx", "--epoch", "1", "--register", "--out", outFile], { out: l => out.push(l), err: l => err.push(l) }), 0, err.join("\n"));
    const printed = out.at(-1)!, written = readFileSync(outFile, "utf8");
    const writtenMaterial = (JSON.parse(written) as AccountLeaseGrantResult).install.files.map(file => Buffer.from(file.contentB64, "base64").toString("utf8")).join();
    show("L4 CLI stdout (redacted) vs --out file", { stdout: JSON.parse(printed), outMode: (statSync(outFile).mode & 0o777).toString(8), outHasMaterial: writtenMaterial.includes(fakeJwt(exp)) });
    assert.ok(!printed.includes(fakeJwt(exp)) && !printed.includes("contentB64"), "stdout carries no material"); assert.ok(writtenMaterial.includes(fakeJwt(exp))); assert.equal(statSync(outFile).mode & 0o777, 0o600);
    assert.equal((JSON.parse(printed) as { materialWrittenTo: string }).materialWrittenTo, outFile);

    for (const haystack of [a!.output(), b!.output(), c!.output()]) { assert.ok(!haystack.includes(CODEX_REFRESH)); assert.ok(!haystack.includes(fakeJwt(exp))); }
    note("\nno refresh token or access token in any daemon's output; receipts and audit rows are secret-free");
  } finally { await cleanup(); }
});
