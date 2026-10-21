import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "../../cli/src/client.ts";
import { RpcError, type BeeTellResult, type BeeReactResult, type SnapshotResult, type SpawnResult, type SendRpcResult, type ViewResult, type WatchFrame } from "../src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;

test("human output daemon: explicit output, exact replies, strict validation, mirror reconnect and durable key replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "hd-")), socketPath = join(root, "s"), keyFile = join(root, "rpc-private", "registration.key");
  writeFileSync(join(root, "config.json"), JSON.stringify({ tickMs: 20, naming: { auto: false }, accounts: { vaultDir: join(root, "vault"), homesDir: join(root, "homes"), limitsRefreshMs: 0 }, rpcLocalTrust: { requireObservationCaller: true, registrationKeyFile: keyFile } }));
  let daemon: DaemonHandle | null = null;
  const clients: RpcClient[] = [];
  async function registered() {
    const client = await daemon!.client(); clients.push(client);
    const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const secret = readFileSync(keyFile), token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex"); secret.fill(0);
    await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    return client;
  }
  try {
    daemon = await startDaemon(root, { socketPath });
    const client = await registered();
    const { beeId } = await client.request<SpawnResult>("spawn", { name: "champion", agent: "inbox", cwd: root });
    const context = { sessionPrincipal: { beeId } };
    await assert.rejects(client.request("bee.tell", { beeId, text: "not opted in", idempotencyKey: "legacy" }, 1000, context), code("human_output_mode_legacy"));
    await client.request("bee.setHumanOutputMode", { beeId, mode: "explicit", idempotencyKey: "enable" });
    await assert.rejects(client.request("bee.setHumanOutputMode", { beeId, mode: "legacy", idempotencyKey: "self" }, 1000, context), code("caller_not_trusted"));
    const one = await client.request<SendRpcResult>("send", { beeId, body: "human one", senderKind: "human" });
    const two = await client.request<SendRpcResult>("send", { beeId, body: "human two", senderKind: "human" });
    await client.request("mail.ack", { beeId, throughId: two.messageId });
    const view = await client.request<ViewResult>("view", { beeId });
    assert.equal(view.view.unansweredHumanMessage!.messageId, one.messageId);
    for (const [extra, value] of [["at", 1], ["root", true], ["generation", 99]] as const) await assert.rejects(client.request("bee.tell", { beeId, text: "invalid", idempotencyKey: extra, [extra]: value }, 1000, context), code("invalid_request"));
    await assert.rejects(client.request("bee.react", { beeId, messageId: one.messageId, emoji: "hello", idempotencyKey: "invalid" }, 1000, context), code("react_emoji_invalid"));
    const watcher = await daemon.client(); clients.push(watcher);
    const frames: WatchFrame[] = []; watcher.onEvent = frame => frames.push(frame);
    const initial = await watcher.request<SnapshotResult>("watch");
    const params = { beeId, text: "a real response", replyTo: one.messageId, idempotencyKey: "tell" };
    const tell = await client.request<BeeTellResult>("bee.tell", params, 1000, context);
    assert.deepEqual(tell.tell.acknowledgedMessageIds, [one.messageId]);
    assert.equal(tell.tell.acknowledgedOverflow, 0);
    const reaction = await client.request<BeeReactResult>("bee.react", { beeId, messageId: two.messageId, emoji: "👍", idempotencyKey: "react" }, 1000, context);
    await waitFor(() => frames.some(frame => frame.type === "delta" && frame.events.some(event => event.kind === "bee.reacted")), "tell/react watch deltas");
    let cursor = initial.seq;
    for (const frame of frames) {
      assert.equal(frame.type, "delta");
      if (frame.type !== "delta") continue;
      assert.equal(frame.baseSeq, cursor);
      for (const event of frame.events) assert.equal(event.seq, ++cursor);
      assert.equal(frame.seq, cursor);
    }
    const events = frames.flatMap(frame => frame.type === "delta" ? frame.events : []);
    assert.deepEqual(events.find(event => event.kind === "bee.told")!.payload.tell, tell.tell);
    assert.deepEqual(events.find(event => event.kind === "bee.reacted")!.payload.reaction, reaction.reaction);
    assert.equal(events.find(event => event.kind === "bee.reacted")!.payload.unansweredHumanMessage, null);
    const snapshot = await client.request<SnapshotResult>("snapshot");
    assert.deepEqual(snapshot.tells, [tell.tell]); assert.deepEqual(snapshot.reactions, [reaction.reaction]);
    assert.equal(snapshot.views.find(row => row.view.beeId === beeId)!.view.unansweredHumanMessage, null);
    assert.equal(snapshot.views.find(row => row.view.beeId === beeId)!.bee!.lastHumanOutputAt, tell.tell.at);
    for (const c of clients) c.close();
    await daemon.stop(); assert.equal(daemon.proc.exitCode, 0); assert.equal(daemon.proc.signalCode, null);
    daemon = await startDaemon(root, { socketPath });
    const reconnect = await registered();
    assert.deepEqual(await reconnect.request("bee.tell", params, 1000, context), { ...tell, deduped: true });
    const restored = await reconnect.request<SnapshotResult>("snapshot");
    assert.deepEqual(restored.tells, snapshot.tells); assert.deepEqual(restored.reactions, snapshot.reactions);
    await assert.rejects(reconnect.request("bee.tell", { ...params, text: "different" }, 1000, context), code("idempotency_conflict"));
    await assert.rejects(reconnect.request("bee.tell", params, 1000, { sessionPrincipal: { beeId: "another" } }), code("caller_not_trusted"));
    await reconnect.request("bee.setHumanOutputMode", { beeId, mode: "legacy", idempotencyKey: "disable" });
    assert.deepEqual(await reconnect.request("bee.tell", params, 1000, context), { ...tell, deduped: true });
    await assert.rejects(reconnect.request("bee.tell", { ...params, idempotencyKey: "fresh" }, 1000, context), code("human_output_mode_legacy"));
    console.log(JSON.stringify({ tells: restored.tells?.length, reactions: restored.reactions?.length, reconnectReceiptIntact: true, oldPendingCleared: true }));
  } finally {
    clients.forEach(client => client.close());
    if (daemon) { await daemon.stop(); assert.equal(daemon.proc.exitCode, 0); assert.equal(daemon.proc.signalCode, null); }
    rmSync(root, { recursive: true, force: true });
  }
});
