import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "../../cli/src/client.ts";
import { publicAuditRow, type AuditRow } from "../../core/src/index.ts";
import { PeerCredentials, type PeerConnection } from "../src/peerCredentials.ts";
import { RpcServer, ENV_TRANSFER_VERBS, publicBeeResponse } from "../src/rpc.ts";
import { RPC_ACCESS } from "../src/rpcAccess.ts";
import { PROTOCOL, RPC_VERBS, RpcError, type RpcRequestContext, type WatchFrame } from "../src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { waitFor } from "./helpers.ts";

class FixturePeers extends PeerCredentials {
  nextPid = process.pid;
  constructor() { super({ directory: "/nonexistent-env-fixture" }); this.status.state = "ready"; this.status.reason = null; }
  override connect(): PeerConnection {
    return { state: "verified", peer: { uid: process.geteuid!(), pid: this.nextPid++, processBirth: "fixture-birth" }, current: () => true, close() {} };
  }
}

test("every RPC reply is projected unless it is an explicit env transfer", () => {
  const canary = `harmless-${randomUUID()}`;
  const input = { bee: { env: { SETTING: canary } }, operatorLocalHomes: { codexHome: canary } };
  assert.deepEqual(Object.keys(RPC_ACCESS).sort(), [...RPC_VERBS].sort());
  assert.deepEqual([...ENV_TRANSFER_VERBS].sort(), ["account.lease", "template.list", "template.get", "template.put", "template.delete", "template.export", "template.import"].sort());
  for (const verb of RPC_VERBS) {
    if (ENV_TRANSFER_VERBS.has(verb)) { assert.equal(publicBeeResponse(verb, input), input); continue; }
    const output = publicBeeResponse(verb, input);
    assert.equal(JSON.stringify(output).includes(canary), false, verb);
    assert.deepEqual(publicBeeResponse(verb, output), output, verb);
  }
});

test("private watch rechecks registration, expires, downgrades and isolates connections", async () => {
  const root = mkdtempSync(join(tmpdir(), "env-egress-"));
  const keyFile = join(root, "private", "key");
  const peers = new FixturePeers();
  let clock = Date.now();
  let seq = 0;
  const env = { SETTING: `harmless-${randomUUID()}`, CODEX_HOME: "/tmp/private-fixture-home" };
  const homes = { codexHome: env.CODEX_HOME, claudeConfigDir: null, grokHome: null };
  const server = new RpcServer({ socketPath: join(root, "s"), dataDir: root, peerCredentials: peers,
    localTrust: { requireObservationCaller: true, registrationKeyFile: keyFile }, log() {},
    dispatch(verb, _params, conn) {
      if (verb === "view") throw new RpcError("invalid_request", "fixture error", { env, operatorLocalHomes: homes });
      if (verb === "mirror.local.watch" || verb === "watch") conn.subscribeWatch(seq, conn.operatorLocalHomes === true);
      if (verb === "snapshot") conn.alignWatch(seq);
      return { seq, views: [{ bee: { id: "fixture", env, ...(conn.operatorLocalHomes ? { operatorLocalHomes: homes } : {}) } }] };
    },
  });
  (server as unknown as { trust: { now: () => number } }).trust.now = () => clock;
  const clients: RpcClient[] = [];
  const register = async (client: RpcClient): Promise<void> => {
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await client.request("rpc.localTrust.register", { pid: challenge.pid, challengeId: challenge.challengeId, token });
  };
  try {
    await server.listen();
    let a = await RpcClient.connect(join(root, "s")); clients.push(a);
    const b = await RpcClient.connect(join(root, "s")); clients.push(b);
    const af: WatchFrame[] = [], bf: WatchFrame[] = [];
    a.onEvent = frame => { af.push(frame); }; b.onEvent = frame => { bf.push(frame); };
    const assertPublic = (result: unknown): void => { const bytes = JSON.stringify(result); assert.equal(bytes.includes(env.SETTING), false); assert.equal(bytes.includes(env.CODEX_HOME), false); assert.equal(bytes.includes("operatorLocalHomes"), false); };
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(join(root, "s"));
      const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw reveal matrix timeout")); }, 3000);
      let pending = "", greeted = false, received = 0;
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("data", chunk => {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const frame = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1);
          if (!greeted) {
            greeted = true;
            socket.write(`${JSON.stringify({ protocol: PROTOCOL })}\n`);
            for (const [id, verb] of RPC_VERBS.entries()) socket.write(`${JSON.stringify({ id, verb, params: { revealEnv: true } })}\n`);
          } else {
            try {
              assert.equal(frame.ok, false);
              assert.equal(frame.error.code, "caller_not_trusted", RPC_VERBS[frame.id]);
              assertPublic(frame);
            } catch (error) { clearTimeout(timer); socket.destroy(); reject(error); return; }
            if (++received === RPC_VERBS.length) { clearTimeout(timer); socket.destroy(); resolve(); }
          }
        }
      });
    });
    assertPublic(await a.request("mirror.local.snapshot"));
    await register(a);
    for (const context of [{ sessionPrincipal: { beeId: "fixture" } }, { humanChat: {} }, { phoneLane: "interim-v1" }, { automationReference: {} }, {}]) assertPublic(await a.request("mirror.local.snapshot", {}, 1000, context as RpcRequestContext));
    for (const verb of RPC_VERBS) await assert.rejects(a.request(verb, { revealEnv: true }, 1000), error => error instanceof RpcError && (error.code === "caller_not_trusted" || verb.startsWith("rpc.execution.") && error.code === "rpc_execution_fence_unsupported"), verb);
    await assert.rejects(a.request("view"), error => { assertPublic((error as RpcError).details); return true; });
    const privateSnapshot = await a.request("mirror.local.watch");
    assert.equal(JSON.stringify(privateSnapshot).includes(env.CODEX_HOME), true);
    assert.equal(JSON.stringify(privateSnapshot).includes(env.SETTING), false);
    await b.request("watch");
    let aClosed = false;
    a.onClose = () => { aClosed = true; };
    const reconnectA = async (): Promise<void> => {
      a = await RpcClient.connect(join(root, "s")); clients.push(a); a.onEvent = frame => { af.push(frame); }; aClosed = false; a.onClose = () => { aClosed = true; };
      await register(a); await a.request("mirror.local.watch");
    };
    const emit = async (expectClose = false): Promise<void> => {
      seq++;
      const event: AuditRow = { seq, ts: clock, beeId: "fixture", kind: "bee.env_set", payload: { env, previous: env } };
      server.flushWatch(seq, (_cursor, includeHomes) => [publicAuditRow(event, includeHomes)], 100);
      await waitFor(() => (expectClose ? aClosed : af.some(frame => frame.seq === seq)) && bf.some(frame => frame.type === "delta" && frame.seq === seq), "fixture deltas");
    };
    await emit();
    assert.equal(JSON.stringify(af.at(-1)).includes(env.CODEX_HOME), true);
    assertPublic(bf);
    await register(b);
    const beforeRevocation = af.length;
    await emit(true);
    assert.equal(af.length, beforeRevocation);
    await reconnectA();
    clock += 300_001;
    const beforeExpiry = af.length;
    await emit(true);
    assert.equal(af.length, beforeExpiry);
    await reconnectA();
    await a.request("snapshot");
    await emit(); assertPublic(af.at(-1));
    await a.request("mirror.local.watch");
    await a.request("watch");
    await emit(); assertPublic(af.at(-1));
    for (const lane of ["remote", "node_relay"] as const) {
      const remote = await RpcClient.connect(join(root, "s"), 1000, lane); clients.push(remote);
      assertPublic(await remote.request("mirror.local.snapshot"));
    }
  } finally { clients.forEach(client => client.close()); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const mode of ["disabled", "missing-key", "degraded", "lookup-failed"] as const) test(`private feed fails closed: ${mode}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "env-mode-"));
  const peers = mode === "degraded" ? new PeerCredentials({ directory: join(root, "no-bridge") }) : new FixturePeers();
  if (mode === "lookup-failed") peers.connect = () => ({ state: "lookup_failed", close() {} });
  const server = new RpcServer({ socketPath: join(root, "s"), dataDir: root, peerCredentials: peers,
    localTrust: { requireObservationCaller: mode !== "disabled", registrationKeyFile: mode === "missing-key" ? join(root, "..", "outside") : join(root, "private", "key") },
    log() {}, dispatch(_verb, _params, conn) { return { views: [{ bee: { env: { SETTING: "harmless-value" }, ...(conn.operatorLocalHomes ? { operatorLocalHomes: { codexHome: "/tmp/fixture" } } : {}) } }] }; },
  });
  let client: RpcClient | null = null;
  try {
    await server.listen(); client = await RpcClient.connect(join(root, "s"));
    assert.equal(client.capabilities.includes("mirror.local.homes.v1"), mode === "lookup-failed");
    for (const verb of ["mirror.local.snapshot", "mirror.local.watch"] as const) {
      const output: string = JSON.stringify(await client.request(verb));
      assert.equal(output.includes("operatorLocalHomes"), false);
      assert.equal(output.includes("harmless-value"), false);
    }
  } finally { client?.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});
