import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type AccountLeaseInstallResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, type DaemonHandle } from "./helpers.ts";

test("authority instance RPC: scoped lease survives restart; legacy holder upgrades, lower same-instance and retired replay refuse", { timeout: 120_000 }, async t => {
  const root = makeDaemonDir();
  const handles: DaemonHandle[] = [];
  const clients: RpcClient[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    for (const client of clients) client.close();
    const results = await Promise.allSettled(handles.map(forceStopTestDaemon));
    root.cleanup();
    for (const result of results) if (result.status === "rejected") throw result.reason;
  })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  let daemon: DaemonHandle;
  let client: RpcClient;
  const open = async () => {
    daemon = await startDaemon(root.dir, { env: { HOME: join(root.dir, "empty-home"), HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1" }, stopTimeoutMs: 30_000 });
    handles.push(daemon); client = await daemon.client(); clients.push(client);
  };
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const token = randomUUID();
  const base = { id: "claude-holder", harness: "claude", label: "holder", shareId: "share-instance", authorityNodeId: "authority-node", epoch: 1, expiresAt,
    files: [{ homeRelPath: ".credentials.json", contentB64: Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "", expiresAt: expiresAt * 1000 } })).toString("base64"), mode: 0o600 }] };
  const a = randomUUID(), b = randomUUID();
  try {
    await open();
    assert.ok(client!.capabilities.includes("account.credentials.authority_instance.v1"));
    const install = (params: Record<string, unknown>) => client!.request<AccountLeaseInstallResult>("account.lease.install", params, 60_000);
    const first = await install({ ...base, generation: 10 });
    const upgraded = await install({ ...base, generation: 2, authorityInstanceId: a });
    assert.equal(upgraded.account.id, first.account.id);
    assert.equal(upgraded.account.leasedFrom?.authorityInstanceId, a);
    await daemon!.stop(); await open();
    const lower = (error: unknown) => error instanceof RpcError && error.code === "account_lease_conflict";
    await assert.rejects(install({ ...base, generation: 1, authorityInstanceId: a }), lower);
    const replacement = await install({ ...base, generation: 1, authorityInstanceId: b });
    assert.equal(replacement.account.leasedFrom?.generation, 1);
    assert.equal(replacement.account.leasedFrom?.authorityInstanceId, b);
    await assert.rejects(install({ ...base, generation: 99, authorityInstanceId: a }), lower);
    const replay = await install({ ...base, generation: 1, authorityInstanceId: b });
    assert.equal(replay.account.leasedFrom?.authorityInstanceId, b);
    for (const value of ["", "unsafe instance", 12]) await assert.rejects(install({ ...base, generation: 2, authorityInstanceId: value }), error => error instanceof RpcError && error.code === "invalid_request");
    assert.ok(!daemon!.output().includes(token), "daemon output contains no credential bytes");
  } finally { await cleanup(); }
});
