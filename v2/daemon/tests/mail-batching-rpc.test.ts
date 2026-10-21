import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { RpcServer, assertAutomationSend, type RpcConn } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { PeerCredentials } from "../src/peerCredentials.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError, type RpcVerb } from "../src/protocol.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { openCoreStore, type CoreStore } from "../../core/src/store.ts";

const code = (expected: string) => (error: unknown) => error instanceof RpcError && error.code === expected;
const kinds = ["tell-reprompt", "tell-mode", "role-refresh", "obligation-notice", "proof-notice", "context-notice", "blocking_decision", "actionable_warning"];
const connection: RpcConn = { ingress: "local_unix", automationAuthority: true, send() {}, subscribeWatch() {}, alignWatch() {} };

for (const enabled of [false, true]) test(`batching RPC requires registered direct authority, trust=${enabled}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "batch-rpc-"));
  const socketPath = relative(process.cwd(), join(root, "rpc.sock"));
  const keyFile = join(root, "private", "key");
  const seen: unknown[] = [];
  const peers = {
    status: { state: "ready" },
    connect: () => ({ state: "verified", peer: { uid: process.geteuid!(), pid: process.pid, processBirth: "fixture-birth" }, current: () => true, close() {} }),
    close() {},
  } as unknown as PeerCredentials;
  const server = new RpcServer({ socketPath, dataDir: root, peerCredentials: peers,
    localTrust: { requireObservationCaller: enabled, registrationKeyFile: keyFile }, log: () => {},
    dispatch: (verb, params, conn) => { const result = { verb, params, authority: conn.automationAuthority ?? false }; seen.push(result); return result; } });
  const clients: RpcClient[] = [];
  try {
    await server.listen();
    const c = await RpcClient.connect(socketPath); clients.push(c);
    assert.equal(c.capabilities.includes("mail.batching.v1"), enabled);
    const params = { beeId: "fixture", body: "hello", idempotencyKey: "key" };
    const automation = { ...params, automationKind: "context-notice" };
    await assert.rejects(c.request("send", automation), code("automation_unauthorized"));
    for (const verb of ["mail.batching.set", "mail.batching.get"] as const) await assert.rejects(c.request(verb, { beeId: "fixture", enabled: true }), code("automation_unauthorized"));
    const ordinary = await c.request<{ authority: boolean }>("send", { ...params, senderKind: "automation", automationAuthority: true });
    assert.equal(ordinary.authority, false);
    if (!enabled) return;
    const challenge = await c.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const key = readFileSync(keyFile);
    const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex"); key.fill(0);
    await c.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    for (const automationKind of kinds) {
      const result = await c.request<{ authority: boolean; params: unknown }>("send", { ...params, automationKind, automationRef: "owner:fixture" });
      assert.equal(result.authority, true);
      assert.deepEqual(result.params, { ...params, automationKind, automationRef: "owner:fixture" });
    }
    for (const extra of [{ automationKind: "invented" }, { automationKind: null }, { automationRef: "owner" }, { automationKind: "blocking_decision" }, { automationKind: "actionable_warning" }, { automationKind: "blocking_decision", automationRef: " " }, { automationKind: "context-notice", automationRef: "x".repeat(513) }]) await assert.rejects(c.request("send", { ...params, ...extra }), code("automation_invalid"));
    for (const context of [{ sessionPrincipal: { beeId: "forged" } }, { humanChat: {} }, { phoneLane: "interim-v1" }, { phoneOrigin: {} }]) await assert.rejects(c.request("send", automation, 1000, context as never), code("automation_unauthorized"));
    for (const verb of ["mail.batching.set", "mail.batching.get"] as const) {
      assert.equal((await c.request<{ authority: boolean }>(verb, { beeId: "fixture", enabled: true })).authority, true);
      await assert.rejects(c.request(verb, { beeId: "fixture", enabled: true }, 1000, { sessionPrincipal: { beeId: "forged" } }), code("automation_unauthorized"));
    }
    const accepted = seen.length;
    for (const lane of ["remote", "node_relay"] as const) {
      const relay = await RpcClient.connect(socketPath, 1000, lane); clients.push(relay);
      await assert.rejects(relay.request("send", automation), code("automation_unauthorized"));
      await assert.rejects(relay.request("mail.batching.set", { beeId: "fixture", enabled: true }), code("automation_unauthorized"));
    }
    assert.equal(seen.length, accepted);
    peers.status.state = "peer_credentials_unavailable";
    assert.equal(server.capabilities.includes("mail.batching.v1"), false);
  } finally { for (const c of clients) c.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("daemon automation guard rejects forged authority and mixed origins", () => {
  for (const conn of [{}, { ingress: "local_unix" }, { ...connection, ingress: "node_relay" }, { ...connection, authenticatedBeeId: "forged" }, { ...connection, phoneLane: "interim-v1" }, { ...connection, humanChat: {} }]) {
    assert.throws(() => assertAutomationSend({ automationKind: "context-notice" }, conn as RpcConn), code("automation_unauthorized"));
  }
  assert.doesNotThrow(() => assertAutomationSend({ senderKind: "automation" }, {} as RpcConn));
  assert.doesNotThrow(() => assertAutomationSend({ automationKind: "blocking_decision", automationRef: "x".repeat(512) }, connection));
});

function daemonFixture() {
  const root = mkdtempSync(join(tmpdir(), "batch-daemon-"));
  const store = openCoreStore(join(root, "core.sqlite"), { ephemeral: true });
  const daemon = new HiveDaemon(loadNodeConfig(root));
  const internal = daemon as unknown as { store: CoreStore; dispatch(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): unknown };
  internal.store = store;
  const bee = store.createBee({ name: "fixture", agent: "stub", substrate: "hsr", cwd: root }).bee;
  return { store, bee, call: (verb: RpcVerb, params: Record<string, unknown>, conn = connection) => internal.dispatch(verb, params, conn), close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("daemon keeps policy off by default, protects policy, and rejects tmux enable", () => {
  const r = daemonFixture();
  try {
    assert.equal((r.call("mail.batching.get", { beeId: r.bee.id }) as { enabled: boolean }).enabled, false);
    assert.throws(() => r.call("mail.batching.set", { beeId: r.bee.id, enabled: true }, { ...connection, automationAuthority: undefined }), code("automation_unauthorized"));
    const first = r.call("mail.batching.set", { beeId: r.bee.id, enabled: true, idempotencyKey: "policy" });
    assert.equal((first as { enabled: boolean }).enabled, true);
    const snapshot = r.call("snapshot", {}) as { mailBatchingPolicies: unknown[]; mailBatches: unknown[] };
    assert.deepEqual(snapshot.mailBatchingPolicies, r.store.listMailBatchingPolicies());
    assert.deepEqual(snapshot.mailBatches, r.store.listMailBatches());
    assert.equal((r.call("mail.batching.set", { beeId: r.bee.id, enabled: true, idempotencyKey: "policy" }) as { deduped: boolean }).deduped, true);
    assert.throws(() => r.call("mail.batching.set", { beeId: r.bee.id, enabled: "true" }), code("invalid_request"));
    const tmux = r.store.createBee({ name: "legacy", agent: "stub", substrate: "tmux", cwd: r.bee.cwd }).bee;
    assert.throws(() => r.call("mail.batching.set", { beeId: tmux.id, enabled: true }), code("mail_batching_unsupported"));
    assert.equal((r.call("mail.batching.set", { beeId: tmux.id, enabled: false }) as { enabled: boolean }).enabled, false);
  } finally { r.close(); }
});

test("daemon sends metadata once and rejects replay classification changes before effect", () => {
  const r = daemonFixture();
  try {
    const params = { beeId: r.bee.id, body: "fixture", idempotencyKey: "send", automationKind: "blocking_decision", automationRef: "question:fixture" };
    const first = r.call("send", params) as { messageId: number };
    assert.equal(r.store.getMessage(first.messageId)?.automationKind, "blocking_decision");
    assert.equal(r.store.getMessage(first.messageId)?.automationRef, "question:fixture");
    assert.equal((r.call("send", params) as { deduped: boolean }).deduped, true);
    for (const change of [{ automationKind: "context-notice" }, { automationRef: "question:other" }, { automationKind: undefined, automationRef: undefined }]) assert.throws(() => r.call("send", { ...params, ...change }), code("idempotency_conflict"));
    assert.throws(() => r.call("send", params, { ...connection, automationAuthority: undefined }), code("automation_unauthorized"));
    const plain = { beeId: r.bee.id, body: "ordinary", idempotencyKey: "plain" };
    r.call("send", plain, { ...connection, automationAuthority: undefined });
    assert.throws(() => r.call("send", { ...plain, automationKind: "context-notice" }), code("idempotency_conflict"));
    assert.equal(r.store.listMessages(r.bee.id).length, 2);
    assert.equal(r.store.mailBatchingPolicy(r.bee.id).enabled, false);
  } finally { r.close(); }
});

test("batch reads validate paging before accessing the bee-scoped core reader", () => {
  const r = daemonFixture();
  try {
    for (const page of [{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 16385 }, { limit: 1.5 }, { offset: null }, { limit: null }]) assert.throws(() => r.call("mail.batch.read", { beeId: r.bee.id, batchId: "fixture", messageId: 1, ...page }), code("invalid_request"));
    assert.throws(() => r.call("mail.batch.read", { beeId: "absent", batchId: "fixture", messageId: 1 }), code("bee_not_found"));
    const reads: unknown[][] = [];
    r.store.readMailBatch = (...args) => { reads.push(args); return { batchId: args[1], messageId: args[2], body: "fixture", offset: 0, nextOffset: null, totalBytes: 7 }; };
    r.call("mail.batch.read", { beeId: r.bee.id, batchId: "fixture", messageId: 1 });
    assert.deepEqual(reads, [[r.bee.id, "fixture", 1, 0, 16384]]);
  } finally { r.close(); }
});


test("frozen group mutation refusals remain typed at the RPC boundary", () => {
  const r = daemonFixture();
  try {
    r.store.cancelMessage = () => ({ canceled: false, reason: "batch_frozen" });
    r.store.expediteMessage = () => ({ applied: false, reason: "batch_frozen" });
    assert.throws(() => r.call("mail.cancel", { beeId: r.bee.id, messageId: 1 }), code("batch_frozen"));
    assert.throws(() => r.call("mail.expedite", { beeId: r.bee.id, messageId: 1, urgency: "now" }), code("batch_frozen"));
  } finally { r.close(); }
});
