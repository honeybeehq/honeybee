import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "../src/rpc.ts";
import { PeerCredentials } from "../src/peerCredentials.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";

const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;
for (const mode of ["disabled", "missing-key", "degraded", "ready"] as const) test(`withdrawal capability and authenticated session boundary: ${mode}`, async () => {
  const base = join(homedir(), ".cache", "honeybee-question-withdraw-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "rpc-"));
  const keyFile = mode === "missing-key" ? join(root, "..", "forbidden") : join(root, "private", "key");
  const credentials = mode === "degraded" ? new PeerCredentials({ directory: join(root, "no-artifact") }) : undefined;
  const seen: string[] = [];
  const server = new RpcServer({ socketPath: join(root, "rpc.sock"), dataDir: root, peerCredentials: credentials,
    localTrust: { requireObservationCaller: mode !== "disabled", registrationKeyFile: keyFile },
    log: () => {}, dispatch: (_verb, _params, conn) => { seen.push(conn.authenticatedBeeId!); return { beeId: conn.authenticatedBeeId }; } });
  const clients: RpcClient[] = [];
  try {
    await server.listen();
    const client = await RpcClient.connect(join(root, "rpc.sock")); clients.push(client);
    assert.equal(client.capabilities.includes("question.withdraw.v1"), mode === "ready");
    const call = (c: RpcClient, context = { sessionPrincipal: { beeId: "asker" } }) => c.request("question.withdraw", {}, 1000, context);
    if (mode !== "ready") {
      await assert.rejects(call(client), code("question_withdraw_unsupported"));
      assert.equal(seen.length, 0);
      return;
    }
    await assert.rejects(call(client), code("caller_not_trusted"));
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    await assert.rejects(client.request("question.withdraw", { beeId: "asker" }), code("caller_not_trusted"));
    assert.deepEqual(await call(client), { beeId: "asker" });
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(join(root, "rpc.sock"), 1000, lane); clients.push(relay);
      await assert.rejects(call(relay), code("caller_not_trusted"));
    }
    assert.deepEqual(seen, ["asker"]);
  } finally { clients.forEach(c => c.close()); await server.close(); rmSync(root, { recursive: true, force: true }); }
});
