import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type AccountLeaseExportResult, type AccountLeaseInstallResult, type AccountAddResult, type AccountNativeBackupRestoreResult, type AuditTailResult } from "../src/protocol.ts";
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
    const { retiredAuthorityInstanceIds, authorityGenerationFloor, fencesForwarded, viaNodeId, ...plain } = downstream;
    const plainRemote = await RpcClient.connect(b.daemon.socketPath, 3000, "remote"); clients.push(plainRemote);
    await plainRemote.request("account.lease.install", { ...plain, generation: 4 }, 60_000);
    for (const origin of [{ epoch: 2 }, { epoch: 2, authorityNodeId: "new-authority" }]) await assert.rejects(plainRemote.request("account.lease.install", { ...plain, ...origin, generation: 5, localIngress: true }, 60_000), error => error instanceof RpcError && error.details?.reason === "local_required");
    const changed = await b.client.request<AccountLeaseInstallResult>("account.lease.install", { ...plain, authorityNodeId: "new-authority", epoch: 2, authorityInstanceId: "instance-C", generation: 1 }, 60_000);
    assert.deepEqual(changed.account.leasedFrom?.retiredAuthorityInstanceIds, ["instance-A", "instance-B"]);
    for (const old of ["instance-A", "instance-B"]) await assert.rejects(b.client.request("account.lease.install", { ...plain, authorityNodeId: "new-authority", epoch: 2, authorityInstanceId: old, generation: 50 }, 60_000), error => error instanceof RpcError && error.details?.reason === "retired_instance");
    await b.client.request("account.lease.remove", { id: installed.account.id });
    for (const lane of ["remote", "node_relay"] as const) {
      const remote = await RpcClient.connect(b.daemon.socketPath, 3000, lane); clients.push(remote);
      await assert.rejects(remote.request("account.remove", { id: installed.account.id }), error => error instanceof RpcError && error.code === "account_lease_conflict" && error.details?.reason === "local_required");
    }
    await b.client.request("account.remove", { id: installed.account.id });
    const reset = await b.client.request<AccountLeaseInstallResult>("account.lease.install", { ...plain, authorityInstanceId: "instance-A", generation: 7, viaNodeId: "replacement-issuer" }, 60_000);
    assert.equal(reset.account.leasedFrom?.fencesForwarded, undefined); assert.equal(reset.account.leasedFrom?.retiredAuthorityInstanceIds, undefined);
    const resetExport = await b.client.request<AccountLeaseExportResult>("account.lease.export", { id: reset.account.id });
    assert.equal(resetExport.fencesForwarded, false);
    await a.client.request("account.lease.remove", { id: first.account.id });
    const remoteA = await RpcClient.connect(a.daemon.socketPath, 3000, "remote"); clients.push(remoteA);
    await assert.rejects(remoteA.request("account.remove", { id: first.account.id }), error => error instanceof RpcError && error.details?.reason === "local_required");
    const marker = await b.client.request<AccountLeaseInstallResult>("account.lease.install", { ...base, id: "claude-marker-only", authorityInstanceId: "instance-marker", generation: 1, fencesForwarded: false }, 60_000);
    assert.equal(marker.account.leasedFrom?.retiredAuthorityInstanceIds, undefined);
    await b.client.request("account.lease.remove", { id: marker.account.id });
    const remoteB = await RpcClient.connect(b.daemon.socketPath, 3000, "remote"); clients.push(remoteB);
    await assert.rejects(remoteB.request("account.remove", { id: marker.account.id }), error => error instanceof RpcError && error.details?.reason === "local_required");
    await b.client.request("account.remove", { id: marker.account.id });
    const unfenced = { ...base, id: "claude-unfenced", shareId: "unfenced-share", viaNodeId: undefined, authorityInstanceId: "unfenced-A", generation: 1 };
    await b.client.request("account.lease.install", unfenced, 60_000);
    const baseline = await remoteB.request<AccountLeaseInstallResult>("account.lease.install", { ...unfenced, authorityNodeId: "another-authority", epoch: 2, authorityInstanceId: "unfenced-B" }, 60_000);
    assert.equal(baseline.account.leasedFrom?.authorityNodeId, "another-authority");
    assert.deepEqual(baseline.account.leasedFrom?.retiredAuthorityInstanceIds, ["unfenced-A"]);
    for (const fenced of [true, false]) {
      const added = await b.client.request<AccountAddResult>("account.add", { id: `claude-native-restore-${fenced}`, harness: "claude", label: `native-restore-${fenced}` });
      const nativeRefresh = randomUUID();
      const native = JSON.stringify({ claudeAiOauth: { accessToken: randomUUID(), refreshToken: nativeRefresh, expiresAt: expiresAt * 1000 } });
      for (const dir of [added.account.homePath, join(roots[1]!.dir, "vault", "claude", added.account.id)]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, ".credentials.json"), native); }
      const adopted = await b.client.request<AccountLeaseInstallResult>("account.lease.install", { ...base, id: added.account.id, label: added.account.label, adopt: "explicit", authorityInstanceId: `native-instance-${fenced}`, generation: 1, ...(fenced ? { fencesForwarded: false } : {}) }, 60_000);
      assert.equal(adopted.account.leasedFrom?.fencesForwarded === true, fenced);
      await b.client.request("account.lease.remove", { id: adopted.account.id });
      if (fenced) await assert.rejects(remoteB.request("account.credentials.restoreNative", { id: adopted.account.id, localIngress: true }), error => error instanceof RpcError && error.details?.reason === "local_required");
      const restored = await (fenced ? b.client : remoteB).request<AccountNativeBackupRestoreResult>("account.credentials.restoreNative", { id: adopted.account.id }, 60_000);
      assert.equal(restored.account.source, "local"); assert.equal(restored.account.leasedFrom, null);
      assert.ok(JSON.parse(readFileSync(join(restored.account.homePath, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken === nativeRefresh, "genuine native backup restored without exposing it");
    }
  } finally { await cleanup(); }
});
