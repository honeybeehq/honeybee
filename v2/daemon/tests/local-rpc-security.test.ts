import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "../src/rpc.ts";
import { PeerCredentials, type PeerCredentialBridge } from "../src/peerCredentials.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";
import { currentRpcCaller } from "../../core/src/rpcAuditContext.ts";
const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;

for (const mode of ["foreign_uid", "lookup_failed", "load_failed"] as const) test(`local connection policy: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-policy-"));
  const events: Array<{kind: string; data: Record<string, unknown>}> = [];
  const bridge: PeerCredentialBridge = {inspect: () => mode === "lookup_failed" ? null : {uid: process.geteuid!() + 1, pid: process.pid, birth: "birth"}, pin: () => -1, alive: () => true};
  const credentials = new PeerCredentials({load: () => { if (mode === "load_failed") throw new Error("load"); return bridge; }, degraded: status => events.push({kind: "degraded", data: {...status}})});
  let dispatches = 0;
  const server = new RpcServer({socketPath: join(root, "rpc.sock"), peerCredentials: credentials, log: () => {}, securityAudit: (kind, data) => events.push({kind, data}), dispatch: () => { dispatches++; return {ok: true}; }});
  let client: RpcClient | undefined;
  try {
    await server.listen(); client = await RpcClient.connect(join(root, "rpc.sock"));
    if (mode === "foreign_uid") {
      await assert.rejects(client.request("health"), code("local_peer_uid_mismatch"));
      await assert.rejects(client.request("spawn", {}), code("local_peer_uid_mismatch"));
      await assert.rejects(client.request("question.dismiss", {questionId: "q", idempotencyKey: "existing-key"}), code("local_peer_uid_mismatch"));
      assert.equal(dispatches, 0);
    } else if (mode === "lookup_failed") {
      assert.deepEqual(await client.request("health"), {ok: true});
      await assert.rejects(client.request("spawn", {}), code("local_peer_credentials_unavailable"));
      await assert.rejects(client.request("question.dismiss", {questionId: "q", idempotencyKey: "existing-key"}), code("local_peer_credentials_unavailable"));
      assert.equal(dispatches, 1);
    } else {
      assert.deepEqual(await client.request("health"), {ok: true});
      assert.deepEqual(await client.request("spawn", {}), {ok: true});
      assert.equal(events.filter(row => row.kind === "degraded").length, 1);
    }
  } finally { client?.close(); await server.close(); rmSync(root, {recursive: true, force: true}); }
});

test("actual local RPC registers without cache and gates only the trusted observation handlers", async () => {
  const root = mkdtempSync(join(tmpdir(), "rpc-registration-"));
  const keyFile = join(root, "private", "key");
  const callers: unknown[] = [];
  const server = new RpcServer({socketPath: join(root, "rpc.sock"), dataDir: root, localTrust: {requireObservationCaller: true, registrationKeyFile: keyFile}, log: () => {}, dispatch: async () => {
    await new Promise(resolve => setImmediate(resolve));
    callers.push(currentRpcCaller()); return {ok: true};
  }});
  let client: RpcClient | undefined;
  let relay: RpcClient | undefined;
  try {
    await server.listen(); client = await RpcClient.connect(join(root, "rpc.sock"));
    await assert.rejects(client.request("account.limits.observe", {}), code("caller_not_trusted"));
    assert.deepEqual(await client.request("account.limits.observation", {}), {ok: true});
    assert.deepEqual(await client.request("account.pause", {}), {ok: true});
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge", {});
    assert.equal(challenge.pid, process.pid);
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", {pid: process.pid, challengeId: challenge.challengeId, token});
    assert.deepEqual(await client.request("account.limits.observe", {}), {ok: true});
    await assert.rejects(client.request("rpc.localTrust.register", {pid: process.pid, challengeId: challenge.challengeId, token}), code("caller_not_trusted"));
    relay = await RpcClient.connect(join(root, "rpc.sock"), 3000, "node_relay");
    await assert.rejects(relay.request("account.limits.observe", {}), code("caller_not_trusted"));
    assert.ok(callers.every(caller => (caller as {pid: number}).pid === process.pid));
  } finally { client?.close(); relay?.close(); await server.close(); rmSync(root, {recursive: true, force: true}); }
});

test("RPC audit attribution stops at the daemon tick boundary", {timeout: 30_000}, async t => {
  const {makeDaemonDir, startDaemon, forceStopTestDaemon, waitFor} = await import("./helpers.ts");
  const root = makeDaemonDir();
  const daemon = await startDaemon(root.dir, {platform: process.platform === "darwin" ? "linux" : "darwin"});
  const client = await daemon.client();
  t.after(async () => { client.close(); await forceStopTestDaemon(daemon); root.cleanup(); });
  const spawned = await client.request<{beeId: string}>("spawn", {name: "caller-boundary", agent: "stub", substrate: "hsr", cwd: root.dir});
  await waitFor(async () => {
    const result = await client.request<{view: {runtimeState: string}}>("view", {beeId: spawned.beeId});
    return result.view.runtimeState === "idle";
  }, "fake bee idle");
  const {rows} = await client.request<{rows: Array<{kind: string; beeId: string | null; payload: Record<string, unknown>}>}>("audit.tail", {limit: 1000});
  const created = rows.find(row => row.kind === "bee.created" && row.beeId === spawned.beeId);
  assert.equal((created?.payload.rpcCaller as {pid?: number})?.pid, process.pid);
  const background = rows.filter(row => row.beeId === spawned.beeId && ["runtime.started", "runtime.state", "command.done", "command.claimed"].includes(row.kind));
  assert.ok(background.length > 0);
  assert.ok(background.every(row => row.payload.rpcCaller === undefined));
  const health = await client.request<any>("health");
  const deploy = await client.request<any>("deployInfo");
  assert.equal(health.localSecurity.peerCredentials.state, "ready");
  assert.equal("deliveryPrepareAuditUnknown" in health, false);
  assert.equal("deliveryFileHelper" in health, false);
  const doctorHealth = await client.request<any>("health", {includeDeliveryPrepareAuditUnknown: true});
  assert.equal(doctorHealth.deliveryPrepareAuditUnknown, 0);
  assert.equal(deploy.localSecurity.peerCredentials.target, `${process.platform}-${process.arch}`);
});

for (const present of [true, false]) test(`RPC doctor reports delivery native helper ${present ? "ready for the matching target" : "unavailable for an absent target"}`, {timeout: 30_000}, async t => {
  const {makeDaemonDir, startDaemon, forceStopTestDaemon} = await import("./helpers.ts");
  const root = makeDaemonDir(), platform = present ? process.platform : process.platform === "darwin" ? "linux" : "darwin";
  const daemon = await startDaemon(root.dir, {platform});
  const client = await daemon.client();
  t.after(async () => {client.close(); await forceStopTestDaemon(daemon); root.cleanup();});
  const health = await client.request<any>("health", {includeDeliveryPrepareAuditUnknown: true});
  assert.equal(health.deliveryFileHelper.target, `${platform}-${process.arch}`);
  assert.equal(existsSync(health.deliveryFileHelper.artifactPath), present);
  assert.equal(health.deliveryFileHelper.state, present ? "ready" : "delivery_file_helper_unavailable");
});
