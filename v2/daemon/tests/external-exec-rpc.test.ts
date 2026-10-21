import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";

const refused = (error: unknown) => error instanceof RpcError && error.code === "caller_not_trusted";

test("external spawn requires default-off capability, registered management and workspace context", async () => {
  const base = join(process.cwd(), ".local", "external-exec-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "rpc-")), keyFile = join(root, "private", "key");
  const socketPath = `/proc/self/cwd/.local/external-exec-tests/${basename(root)}/rpc.sock`;
  let admitted = 0;
  const server = new RpcServer({ socketPath, dataDir: root, externalExecEnabled: true,
    localTrust: { requireObservationCaller: true, registrationKeyFile: keyFile }, log: () => {},
    dispatch: (_verb, _params, conn) => { admitted++; return { workspace: conn.externalExecWorkspace }; } });
  const clients: RpcClient[] = [];
  try {
    await server.listen();
    const client = await RpcClient.connect(socketPath); clients.push(client);
    assert.equal(client.capabilities.includes("external-exec.v1"), true);
    const params = { agent: "external-exec-v1", name: "test" };
    await assert.rejects(client.request("spawn", params, 1000, { externalExecWorkspace: "ur" }), refused);
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    await assert.rejects(client.request("spawn", params), refused);
    assert.deepEqual(await client.request("spawn", params, 1000, { externalExecWorkspace: "ur" }), { workspace: "ur" });
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(socketPath, 1000, lane); clients.push(relay);
      await assert.rejects(relay.request("spawn", params, 1000, { externalExecWorkspace: "ur" }), refused);
    }
    assert.equal(admitted, 1);
  } finally { clients.forEach(client => client.close()); await server.close(); }
});

test("unconfigured RPC owner never advertises external execution", () => {
  const server = new RpcServer({ socketPath: "/not-listening", log: () => {}, dispatch: () => null });
  assert.equal(server.capabilities.includes("external-exec.v1"), false);
});
