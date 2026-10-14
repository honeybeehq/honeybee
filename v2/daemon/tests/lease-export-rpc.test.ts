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
