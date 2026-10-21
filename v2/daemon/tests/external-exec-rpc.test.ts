import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";

const refused = (error: unknown) => error instanceof RpcError && error.code === "caller_not_trusted";

test("external spawn requires default-off capability, registered management and workspace context", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(tmpdir(), "hb-external-rpc-")), keyFile = join(root, "management.key");
  const socketPath = join(root, "hived.sock");
  writeFileSync(keyFile, Buffer.alloc(32, 5), {mode: 0o600});
  let admitted = 0;
  const server = new RpcServer({ socketPath, dataDir: root, externalExecEnabled: true,
    instance: {id: "test-daemon-instance", dataDir: root}, externalWorkspaces: ["ur", "other"],
    externalManagement: {root, keyFile, socketPath, endpointFile: join(root, "endpoint.json")},
    localTrust: { requireObservationCaller: true, registrationKeyFile: join(root, "observation.key") }, log: () => {},
    dispatch: (_verb, _params, conn) => { admitted++; return { workspace: conn.externalExecWorkspace }; } });
  const clients: RpcClient[] = [];
  try {
    await server.listen();
    const client = await RpcClient.connect(socketPath); clients.push(client);
    assert.equal(client.capabilities.includes("external-exec.v1"), true);
    const params = { agent: "external-exec-v1", name: "test" };
    await assert.rejects(client.request("spawn", params, 1000, { externalExecWorkspace: "ur" }), refused);
    const challenge = await client.request<LocalTrustChallenge>("rpc.externalManagement.challenge", {workspace: "ur"});
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await assert.rejects(client.request("rpc.externalManagement.register", {workspace: "other", pid: process.pid, challengeId: challenge.challengeId, token}), refused);
    await client.request("rpc.externalManagement.register", { workspace: "ur", pid: process.pid, challengeId: challenge.challengeId, token });
    assert.equal(challenge.workspace, "ur");
    assert.equal(challenge.daemonInstanceId, "test-daemon-instance");
    assert.deepEqual(await client.request("spawn", params, 1000, { externalExecWorkspace: "spoofed" }), { workspace: "ur" });
    const observer = await RpcClient.connect(socketPath); clients.push(observer);
    const obs = await observer.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const obsKey = readFileSync(join(root, "observation.key"));
    const obsToken = createHmac("sha256", obsKey).update(localTrustMessage(obs)).digest("hex"); obsKey.fill(0);
    await observer.request("rpc.localTrust.register", {pid: process.pid, challengeId: obs.challengeId, token: obsToken});
    await assert.rejects(observer.request("spawn", params, 1000, {externalExecWorkspace: "ur"}), refused);
    assert.deepEqual(await client.request("spawn", params), {workspace: "ur"});
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(socketPath, 1000, lane); clients.push(relay);
      await assert.rejects(relay.request("spawn", params, 1000, { externalExecWorkspace: "ur" }), refused);
    }
    assert.equal(admitted, 2);
  } finally { clients.forEach(client => client.close()); await server.close(); }
});

test("unconfigured RPC owner never advertises external execution", () => {
  const server = new RpcServer({ socketPath: "/not-listening", log: () => {}, dispatch: () => null });
  assert.equal(server.capabilities.includes("external-exec.v1"), false);
});

test("daemon keeps public RPC usable while management uses its own protected listener", async () => {
  const {makeDaemonDir, startDaemon, forceStopTestDaemon} = await import("./helpers.ts");
  const {loadNodeConfig} = await import("../src/config.ts");
  const {chmodSync} = await import("node:fs");
  const owner = mkdtempSync(join(tmpdir(), "hb-listener-owner-")), ownerFile = join(owner, "owner.json");
  writeFileSync(ownerFile, JSON.stringify({schema: "honeybee.external-owner.v1", externalExec: {bridges: {}, workspaces: {ur: {capabilities: ["external-exec.v1"], bridges: []}}}}), {mode: 0o600});
  writeFileSync(join(owner, "management.key"), Buffer.alloc(32, 8), {mode: 0o600});
  const node = makeDaemonDir({externalOwnerFile: ownerFile, naming: {auto: false}});
  const daemon = await startDaemon(node.dir);
  const clients: RpcClient[] = [];
  try {
    const publicClient = await daemon.client(); clients.push(publicClient);
    const management = await RpcClient.connect(join(owner, "hived.sock")); clients.push(management);
    assert.equal(publicClient.capabilities.includes("external-exec.v1"), false);
    assert.equal(management.capabilities.includes("external-exec.v1"), true);
    await assert.rejects(publicClient.request("rpc.externalManagement.challenge", {workspace: "ur"}), refused);
    const challenge = await management.request<LocalTrustChallenge>("rpc.externalManagement.challenge", {workspace: "ur"});
    assert.equal(challenge.daemonInstanceId, publicClient.instance?.id);
    chmodSync(join(owner, "management.key"), 0o000);
    assert.equal(loadNodeConfig(node.dir).socketPath, join(node.dir, "hived.sock"));
    assert.ok(await publicClient.request("health"));
    assert.throws(() => loadNodeConfig(node.dir, undefined, "management"));
    await assert.rejects(management.request("list"), refused);
  } finally {clients.forEach(client => client.close()); await forceStopTestDaemon(daemon);}
});
