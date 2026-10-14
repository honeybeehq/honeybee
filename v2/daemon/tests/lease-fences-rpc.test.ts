import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type AccountLeaseExportResult, type AccountLeaseInstallResult, type AuditTailResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, type DaemonHandle } from "./helpers.ts";

test("lease fences RPC: own stored export, authenticated first hop, durable history and no second hop", { timeout: 120_000 }, async t => {
  const roots = [makeDaemonDir(), makeDaemonDir()];
  const handles: DaemonHandle[] = [], clients: RpcClient[] = [];
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    for (const client of clients) client.close();
    const results = await Promise.allSettled(handles.map(forceStopTestDaemon));
    for (const root of roots) root.cleanup();
    for (const result of results) if (result.status === "rejected") throw result.reason;
  })();
  t.after(cleanup); t.signal.addEventListener("abort", () => { void cleanup(); }, { once: true });
  const open = async (index: number) => {
    const daemon = await startDaemon(roots[index]!.dir, { env: { HIVE_NO_KEYCHAIN: "1" }, stopTimeoutMs: 30_000 });
    handles.push(daemon); const client = await daemon.client(); clients.push(client); return { daemon, client };
  };
  const expiresAt = Math.floor(Date.now() / 1000) + 3600, token = randomUUID();
  const files = [{ homeRelPath: ".credentials.json", mode: 0o600, contentB64: Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "", expiresAt: expiresAt * 1000 } })).toString("base64") }];
  const base = { id: "claude-fence-holder", harness: "claude", label: "holder", authorityNodeId: "original-authority", shareId: "original-share", epoch: 1, expiresAt, files, viaNodeId: "original-authority" };
  try {
    const a = await open(0); let b = await open(1);
    assert.ok(a.client.capabilities.includes("account.lease.fence_forwarding.v1"));
    const first = await a.client.request<AccountLeaseInstallResult>("account.lease.install", { ...base, authorityInstanceId: "instance-A", generation: 5 }, 60_000);
    await a.client.request("account.lease.install", { ...base, authorityInstanceId: "instance-B", generation: 3 }, 60_000);
    const exported = await a.client.request<AccountLeaseExportResult>("account.lease.export", { id: first.account.id, retiredAuthorityInstanceIds: ["instance-B"], authorityGenerationFloor: 99, fencesForwarded: true });
    assert.equal(exported.fencesForwarded, false); assert.deepEqual(exported.retiredAuthorityInstanceIds, ["instance-A"]); assert.equal(exported.authorityGenerationFloor, 3);
    const downstream = { ...base, id: "claude-satellite", authorityNodeId: "workstation-issuer", shareId: "satellite-share", viaNodeId: "workstation-issuer", authorityInstanceId: exported.authorityInstanceId, generation: exported.generation, expiresAt: exported.expiresAt, files: exported.files, retiredAuthorityInstanceIds: exported.retiredAuthorityInstanceIds, authorityGenerationFloor: exported.authorityGenerationFloor, fencesForwarded: exported.fencesForwarded };
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(b.daemon.socketPath, 3000, lane); clients.push(relay);
      await assert.rejects(relay.request("account.lease.install", downstream), error => error instanceof RpcError && error.code === "account_lease_conflict" && error.details?.reason === "local_required");
    }
    const installed = await b.client.request<AccountLeaseInstallResult>("account.lease.install", downstream, 60_000);
    assert.equal(installed.account.leasedFrom?.fencesForwarded, true); assert.deepEqual(installed.account.leasedFrom?.retiredAuthorityInstanceIds, ["instance-A"]);
    await b.daemon.stop(); b = await open(1);
    await assert.rejects(b.client.request("account.lease.install", { ...downstream, authorityInstanceId: "instance-A", generation: 99, retiredAuthorityInstanceIds: [] }, 60_000), error => error instanceof RpcError && error.details?.reason === "retired_instance");
    await assert.rejects(b.client.request("account.lease.export", { id: installed.account.id }), error => error instanceof RpcError && error.code === "account_lease_export_refused" && error.details?.reason === "forwarding_depth_exceeded");
    await assert.rejects(a.client.request("account.lease.install", { ...base, authorityInstanceId: "instance-B", generation: 4, fencesForwarded: true }, 60_000), error => error instanceof RpcError && error.details?.reason === "forwarding_depth_exceeded");
    const audit = await b.client.request<AuditTailResult>("audit.tail", { limit: 1000 });
    assert.ok(!JSON.stringify(audit).includes(token), "no credential bytes in audit");
    assert.ok(!JSON.stringify(audit).includes(files[0]!.contentB64), "no credential artifact in audit");
    assert.ok(handles.every(handle => !handle.output().includes(token)), "no credential bytes in daemon output");
  } finally { await cleanup(); }
});
