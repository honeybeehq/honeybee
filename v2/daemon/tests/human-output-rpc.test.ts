import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "../src/rpc.ts";
import { PeerCredentials } from "../src/peerCredentials.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError } from "../src/protocol.ts";

const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;
for (const mode of ["disabled", "missing-key", "degraded", "ready"] as const) test(`human output registered service and principal boundary: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "ho-")), keyFile = mode === "missing-key" ? join(root, "..", "forbidden") : join(root, "private", "key");
  const seen: string[] = [], clients: RpcClient[] = [];
  const server = new RpcServer({ socketPath: join(root, "rpc.sock"), dataDir: root,
    peerCredentials: mode === "degraded" ? new PeerCredentials({ directory: join(root, "no-artifact") }) : undefined,
    localTrust: { requireObservationCaller: mode !== "disabled", registrationKeyFile: keyFile }, log: () => {},
    dispatch: (verb, _params, conn) => { seen.push(verb); return { beeId: conn.authenticatedBeeId ?? null, management: conn.humanOutputManagement === true }; },
  });
  try {
    await server.listen(); const client = await RpcClient.connect(join(root, "rpc.sock")); clients.push(client);
    for (const capability of ["bee.tell.v1", "bee.react.v1", "bee.human_output_mode.v1"] as const) assert.equal(client.capabilities.includes(capability), mode === "ready");
    const context = { sessionPrincipal: { beeId: "champion" } };
    if (mode !== "ready") {
      for (const verb of ["bee.tell", "bee.react", "bee.setHumanOutputMode"] as const) await assert.rejects(client.request(verb, { beeId: "champion" }, 1000, context), code("capability_missing"));
      assert.equal(seen.length, 0); return;
    }
    await assert.rejects(client.request("bee.tell", { beeId: "champion" }, 1000, context), code("caller_not_trusted"));
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const secret = readFileSync(keyFile), token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex"); secret.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    for (const verb of ["bee.tell", "bee.react"] as const) {
      await assert.rejects(client.request(verb, { beeId: "champion" }), code("caller_not_trusted"));
      await assert.rejects(client.request(verb, { beeId: "other" }, 1000, context), code("caller_not_trusted"));
      const forged = { sessionPrincipal: { beeId: "champion", root: true } };
      await assert.rejects(client.request(verb, { beeId: "champion" }, 1000, forged), code("caller_not_trusted"));
      assert.deepEqual(await client.request(verb, { beeId: "champion" }, 1000, context), { beeId: "champion", management: false });
    }
    await assert.rejects(client.request("bee.setHumanOutputMode", { beeId: "champion" }, 1000, context), code("caller_not_trusted"));
    assert.deepEqual(await client.request("bee.setHumanOutputMode", { beeId: "champion" }), { beeId: null, management: true });
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(join(root, "rpc.sock"), 1000, lane); clients.push(relay);
      for (const verb of ["bee.tell", "bee.react", "bee.setHumanOutputMode"] as const) await assert.rejects(relay.request(verb, { beeId: "champion" }, 1000, context), code("caller_not_trusted"));
    }
    assert.deepEqual(seen, ["bee.tell", "bee.react", "bee.setHumanOutputMode"]);
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(root, { recursive: true, force: true }); }
});
