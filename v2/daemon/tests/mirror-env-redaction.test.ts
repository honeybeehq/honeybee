import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type RpcRequestContext, type SnapshotResult, type WatchFrame } from "../src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { makeDaemonDir, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

test("env privacy: full RPC bytes, old replay rows, public and registered private mirrors", async () => {
  const { dir, cleanup } = makeDaemonDir({ rpcLocalTrust: { requireObservationCaller: true } });
  const canary = `harmless-${randomUUID()}`;
  const env = { SETTING: canary, CODEX_HOME: join(dir, "codex-fixture"), CLAUDE_CONFIG_DIR: join(dir, "claude-fixture"), GROK_HOME: join(dir, "grok-fixture") };
  const keys = Object.keys(env).sort();
  const safe = (value: unknown): void => { const bytes = JSON.stringify(value); for (const value of Object.values(env)) assert.equal(bytes.includes(value), false); };
  const clients: RpcClient[] = [];
  let daemon: DaemonHandle | null = null;
  try {
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    const { bee } = store.createBee({ id: "parent", name: "parent", agent: "stub", substrate: "hsr", cwd: dir, env });
    store.createBee({ id: "child", name: "child", parentId: bee.id, agent: "stub", substrate: "hsr", cwd: dir, env });
    store.setBeeEnv(bee.id, { ...env, NEW_SETTING: canary });
    store.enqueueCommand("stop", bee.id, { nested: { env } });
    store.recordRpcResult("old-replay", "bee.rename", null, { bee, applied: true });
    store.close();
    const seed = new DatabaseSync(join(dir, "core.sqlite3"));
    for (const payload of [{ move: { previousEnv: env } }, { handoff: { targetEnv: env } }, { command: { payload: { env } } }]) {
      seed.prepare("INSERT INTO audit(ts,kind,bee_id,payload) VALUES(?,?,?,?)").run(1, "bee.fixture", bee.id, JSON.stringify(payload));
    }
    seed.close();
    daemon = await startDaemon(dir);
    const client = await daemon.client(); clients.push(client);
    for (const [verb, params] of [
      ["view", { beeId: "parent" }], ["view", { beeId: "child" }], ["list", {}], ["bee.children", { beeId: "parent" }],
      ["audit.tail", { limit: 1000 }], ["commands", { beeId: "parent" }], ["snapshot", {}],
      ["bee.rename", { beeId: "parent", name: "no-op-replay", idempotencyKey: "old-replay" }],
      ["bee.rename", { beeId: "child", name: "renamed", idempotencyKey: "new-replay" }],
      ["bee.rename", { beeId: "child", name: "renamed", idempotencyKey: "new-replay" }],
      ["bee.tag", { beeId: "child", add: ["fixture"] }], ["bee.setArgs", { beeId: "child", args: [] }],
    ] as const) safe(await client.request(verb, params));
    for (const lane of ["remote", "node_relay"] as const) {
      const remote = await RpcClient.connect(daemon.socketPath, 1000, lane); clients.push(remote);
      for (const verb of ["view", "mirror.local.snapshot", "mirror.local.watch"] as const) safe(await remote.request(verb, verb === "view" ? { beeId: "parent" } : {}));
      await assert.rejects(remote.request("view", { beeId: "parent", revealEnv: true }), error => error instanceof RpcError && error.code === "caller_not_trusted");
    }
    safe(await client.request("mirror.local.snapshot"));
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const secret = readFileSync(join(dir, "rpc-private", "registration.key"));
    const token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex"); secret.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    for (const context of [{ sessionPrincipal: { beeId: "parent" } }, { sessionPrincipal: { beeId: "child" } }, { humanChat: {} }, { phoneLane: "interim-v1" }, { automationReference: {} }]) {
      safe(await client.request("mirror.local.snapshot", {}, 1000, context as RpcRequestContext));
      await assert.rejects(client.request("view", { beeId: "parent", revealEnv: true }, 1000, context as RpcRequestContext), error => error instanceof RpcError && error.code === "caller_not_trusted");
    }
    const frames: WatchFrame[] = [];
    client.onEvent = frame => { frames.push(frame); };
    const privateSnapshot = await client.request<SnapshotResult>("mirror.local.watch");
    const privateBee = privateSnapshot.views.find(row => row.bee?.id === "child")?.bee as unknown as Record<string, unknown>;
    assert.deepEqual(privateBee.operatorLocalHomes, { codexHome: env.CODEX_HOME, claudeConfigDir: env.CLAUDE_CONFIG_DIR, grokHome: env.GROK_HOME });
    assert.deepEqual(privateBee.envKeys, keys);
    assert.equal(JSON.stringify(privateSnapshot).includes(canary), false);
    const publicSnapshot = await client.request<SnapshotResult>("snapshot");
    const publicBee = publicSnapshot.views.find(row => row.bee?.id === "child")?.bee;
    assert.deepEqual(Object.keys(privateBee).sort(), [...Object.keys(publicBee!), "operatorLocalHomes"].sort());
    safe(publicSnapshot);
    const spawned = await client.request<{beeId:string}>("spawn", { name: "after-public-switch", agent: "stub", cwd: dir, env });
    await waitFor(() => frames.some(frame => frame.type === "delta" && frame.events.some(event => event.beeId === spawned.beeId)), "public watch delta after private switch");
    safe(frames);
    clients.forEach(item => item.close());
    await daemon.stop(); daemon = null;
    const stored = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
    assert.deepEqual(stored.getBee("child")?.env, env);
    stored.close();
  } finally { clients.forEach(client => client.close()); await daemon?.stop(); cleanup(); }
});
