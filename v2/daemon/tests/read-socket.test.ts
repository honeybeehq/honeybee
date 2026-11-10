import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { INBOX_AGENT, openCoreStore, storeWriterLockHeld } from "../../core/src/index.ts";
import { restoreStoreOffline, type StoreBackupReceipt } from "../../core/src/storeBackup.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { RpcError, type AuditTailResult, type ListResult, type RpcVerb, type TranscriptSegmentsResult, type ViewResult, type WatchFrame } from "../src/protocol.ts";
import { readSocketPath } from "../src/readServer.ts";
import { READ_SOCKET_VERBS } from "../src/storeReads.ts";
import { DAEMON_BIN, makeDaemonDir, ownerBoundEnv, startDaemon, waitFor, type DaemonHandle } from "./helpers.ts";

const segment = (beeId: string, ordinal: number) => ({
  beeId, ordinal, firstLine: ordinal * 3 + 1, lastLine: ordinal * 3 + 3, byteStart: ordinal * 30, byteEnd: ordinal * 30 + 30, harness: "stub",
  rawRef: "a".repeat(64), rawSize: 100, rawBytes: 60, projectedRef: "b".repeat(64), projectedSize: 200, projectedBytes: 90,
  projectionVersion: 7, digest: "c".repeat(64), closedAt: 5, epoch: null, path: "/logs/bee.jsonl", logSegmentId: null,
});

async function failure(run: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await run; }
  catch (error) {
    assert.ok(error instanceof RpcError, String(error));
    return { code: error.code, message: error.message };
  }
  throw new Error("request was answered");
}

async function sameOnBothSockets(main: RpcClient, reader: RpcClient, verb: RpcVerb, params: Record<string, unknown>): Promise<{ result: unknown; seq: number }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = await reader.read(verb, params);
    const expected = await main.read(verb, params);
    const second = await reader.read(verb, params);
    assert.equal(typeof first.seq, "number", `${verb}: a read-socket reply carries its seq`);
    assert.equal(expected.seq, null, `${verb}: a main-socket reply is unchanged`);
    if (first.seq !== second.seq) continue;
    assert.deepEqual(first.result, expected.result, `${verb} ${JSON.stringify(params)}`);
    return { result: first.result, seq: first.seq! };
  }
  throw new Error(`${verb}: the store never held still`);
}

test("read socket path sits beside the main socket", () => {
  assert.equal(readSocketPath("/home/x/.hive/v2/hived.sock"), "/home/x/.hive/v2/hived.read.sock");
  assert.equal(readSocketPath("/run/hive/custom"), "/run/hive/custom.read");
  assert.deepEqual([...READ_SOCKET_VERBS].sort(), ["audit.tail", "commands", "list", "mail.history", "mail.pending", "mailbox", "transcript.segments", "view"]);
});

test("read socket: same hello and replies as the main socket, stamped with the store seq, with no write path", { timeout: 180_000 }, async () => {
  const { dir, cleanup } = makeDaemonDir({ rpcLocalTrust: { requireObservationCaller: true } });
  const clients: RpcClient[] = [];
  let daemon: DaemonHandle | null = null;
  try {
    let clock = 1_000_000;
    const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true, now: () => (clock += 10) });
    for (let i = 0; i < 6; i++) {
      const { bee } = store.createBee({ id: `bee-${i}`, name: `worker-${i}`, agent: "stub", substrate: "hsr", cwd: dir });
      store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
      store.createSeal(bee.id, { id: `seal-${i}`, title: `result ${i}`, body: "body" });
    }
    for (const [index, id] of ["bee-5", "bee-1", "bee-3"].entries()) {
      clock = 2_000_000 + index * 1_000;
      store.archiveBee(id);
    }
    store.createBee({ id: "inbox", name: "inbox", agent: INBOX_AGENT, substrate: "hsr", cwd: "" });
    for (let i = 0; i < 4; i++) store.send("inbox", `queued ${i}`, { sender: "bee-0" });
    for (let ordinal = 0; ordinal < 7; ordinal++) {
      store.putTranscriptSegmentObject(segment("bee-0", ordinal), { path: "/logs/bee.jsonl", lineNo: ordinal * 3 + 3, byteOffset: ordinal * 30 + 30, epoch: null, projectorCheckpoint: null });
    }
    store.close();

    daemon = await startDaemon(dir);
    const main = await daemon.client(); clients.push(main);
    const readPath = join(dir, "hived.read.sock");
    assert.equal(main.readSocket, readPath, "the main hello names the read socket");
    assert.equal(statSync(readPath).mode & 0o777, statSync(daemon.socketPath).mode & 0o777);
    const reader = await RpcClient.connect(readPath); clients.push(reader);
    assert.equal(reader.readSocket, readPath, "the read socket names itself");
    assert.deepEqual(reader.capabilities, main.capabilities);
    assert.deepEqual(reader.instance, main.instance);

    const requests: Array<[RpcVerb, Record<string, unknown>]> = [
      ["view", { beeId: "bee-0" }],
      ["view", { beeId: "bee-3" }],
      ["view", { beeId: "nobody" }],
      ["list", {}],
      ["list", { lifecycle: "active" }],
      ["list", { lifecycle: "archived" }],
      ["list", { lifecycle: "archived", limit: 2 }],
      ["list", { refs: ["worker-3", "bee-0"] }],
      ["mailbox", { beeId: "inbox" }],
      ["mailbox", { beeId: "inbox", unread: true, sinceId: 2 }],
      ["mail.pending", { beeId: "inbox" }],
      ["mail.pending", { beeId: "inbox", limit: 2 }],
      ["mail.history", { limit: 3 }],
      ["transcript.segments", { beeId: "bee-0" }],
      ["transcript.segments", { beeId: "bee-0", afterOrdinal: 2, limit: 2 }],
      ["transcript.segments", { beeId: "bee-0", last: 3 }],
      ["transcript.segments", { beeId: "bee-0", last: 2, beforeOrdinal: 4 }],
      ["commands", { beeId: "bee-0" }],
      ["audit.tail", { limit: 5 }],
      ["audit.tail", { beeId: "inbox", afterSeq: 3, limit: 50 }],
    ];
    const seqs: number[] = [];
    for (const [verb, params] of requests) seqs.push((await sameOnBothSockets(main, reader, verb, params)).seq);
    assert.ok(seqs.every(seq => Number.isSafeInteger(seq) && seq > 0));
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! >= seqs[i - 1]!, "seq never goes back on one connection");

    const page = await reader.request<ListResult>("list", { lifecycle: "archived", limit: 2 });
    assert.deepEqual(page.views.map(row => row.bee!.id), ["bee-3", "bee-1"]);
    const rest = await reader.request<ListResult>("list", { lifecycle: "archived", limit: 2, after: page.next });
    assert.deepEqual([rest.views.map(row => row.bee!.id), rest.next], [["bee-5"], null]);

    const newest = await reader.request<TranscriptSegmentsResult>("transcript.segments", { beeId: "bee-0", last: 3 });
    assert.deepEqual(newest.segments.map(row => row.ordinal), [4, 5, 6]);
    assert.equal(newest.cursor?.lineNo, 21);
    assert.equal(newest.historyStartLine, 1);
    const everything = await reader.request<TranscriptSegmentsResult>("transcript.segments", { beeId: "bee-0", last: 10_000 });
    assert.deepEqual(everything.segments.map(row => row.ordinal), [0, 1, 2, 3, 4, 5, 6]);
    for (const client of [main, reader]) {
      for (const params of [{ last: 0 }, { last: 10_001 }, { last: 1.5 }, { last: "3" }, { last: 2, limit: 1 }, { last: 2, afterOrdinal: 0 }, { beforeOrdinal: 3 }, { last: 2, beforeOrdinal: -1 }]) {
        assert.equal((await failure(client.request("transcript.segments", { beeId: "bee-0", ...params }))).code, "invalid_request", JSON.stringify(params));
      }
    }

    for (const [verb, params] of [["mailbox", { beeId: "nobody" }], ["list", { lifecycle: "deleted" }], ["list", { limit: 2 }], ["view", {}]] satisfies Array<[RpcVerb, Record<string, unknown>]>) {
      assert.deepEqual(await failure(reader.request(verb, params)), await failure(main.request(verb, params)), `${verb} ${JSON.stringify(params)}`);
    }

    const before = (await reader.read("view", { beeId: "inbox" })).seq!;
    for (const [verb, params] of [["send", { beeId: "inbox", body: "through the reader" }], ["archive", { beeId: "bee-0" }], ["bee.rename", { beeId: "bee-0", name: "renamed" }], ["watch", {}], ["snapshot", {}], ["health", {}], ["store.backup", {}], ["spawn", { name: "x", agent: "stub" }], ["delete", { beeId: "bee-5" }]] satisfies Array<[RpcVerb, Record<string, unknown>]>) {
      const refused = await failure(reader.request(verb, params));
      assert.equal(refused.code, "invalid_request", verb);
      assert.match(refused.message, new RegExp(`use the main socket for ${verb.replace(".", "\\.")}`));
    }
    assert.equal((await reader.read("view", { beeId: "inbox" })).seq, before, "a refused verb writes nothing");
    assert.equal((await reader.request<ViewResult>("view", { beeId: "bee-0" })).bee!.name, "worker-0");

    const frames: WatchFrame[] = [];
    main.onEvent = frame => { frames.push(frame); };
    await main.request("watch");
    const sent = await main.request<{ messageId: number }>("send", { beeId: "inbox", body: "after the watch", sender: "bee-0" });
    const afterSend = await reader.read<{ messages: Array<{ id: number; body: string }> }>("mail.pending", { beeId: "inbox" });
    assert.equal(afterSend.result.messages.at(-1)?.id, sent.messageId, "a read made after a write was acknowledged reflects it");
    const delta = await waitFor(() => frames.find((frame): frame is Extract<WatchFrame, { type: "delta" }> => frame.type === "delta" && frame.events.some(event => event.kind === "mail.enqueued")) ?? null, "the send's delta");
    const enqueued = delta.events.find(event => event.kind === "mail.enqueued")!;
    assert.ok(afterSend.seq! >= enqueued.seq, "the read's seq is at or past the write's audit row");
    const atDelta = await reader.read<AuditTailResult>("audit.tail", { afterSeq: delta.baseSeq, limit: 1000 });
    assert.ok(atDelta.seq! >= delta.seq);
    assert.deepEqual(atDelta.result.rows.filter(row => row.seq <= delta.seq), delta.events, "the reader serves the same audit rows the delta carried");
    assert.ok(atDelta.result.rows.every(row => row.seq <= atDelta.seq!), "no row is newer than the seq the reply names");

    const untrusted = await failure(reader.request("mirror.local.snapshot"));
    assert.equal(untrusted.code, "invalid_request");
    const challenge = await reader.request<LocalTrustChallenge>("rpc.localTrust.challenge");
    const secret = readFileSync(join(dir, "rpc-private", "registration.key"));
    const token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex"); secret.fill(0);
    await reader.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
    await sameOnBothSockets(main, reader, "list", { lifecycle: "active" });

    let reading = true;
    let reads = 0;
    const hammer = (async () => {
      while (reading) {
        const reply = await reader.read<ListResult>("list", { lifecycle: "active" });
        assert.equal(typeof reply.seq, "number");
        reads += 1;
      }
    })();
    const receipt = await main.request<StoreBackupReceipt>("store.backup", {}, 60_000);
    const snapshot = new DatabaseSync(receipt.backupPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM bees").get()?.n, 7);
      assert.equal(snapshot.prepare("SELECT body FROM mailbox WHERE id = ?").get(sent.messageId)?.body, "after the watch");
    } finally { snapshot.close(); }
    await waitFor(() => reads > 20, "reads continue after the backup");
    reading = false;
    await hammer;

    assert.equal(storeWriterLockHeld(daemon.storePath), true);
    assert.throws(() => openCoreStore(daemon!.storePath), /already held by another writer/);
    assert.throws(() => restoreStoreOffline(daemon!.storePath, receipt.receiptPath), /already held by another writer/);
    const attached = openCoreStore(daemon.storePath, { readOnly: true });
    try { assert.equal(attached.getBee("inbox")?.name, "inbox"); }
    finally { attached.close(); }

    const second = spawn(process.execPath, [DAEMON_BIN, "--data-dir", dir, "--socket", join(dir, "second.sock")], {
      env: { ...process.env, HOME: join(dir, "second-home"), HIVE_NODE_PATH: process.execPath, HIVE_V2_DATA_DIR: dir, HIVE_NO_KEYCHAIN: "1", HIVE_GATEWAYS_DISABLE: "1", ...ownerBoundEnv(process.env.NODE_OPTIONS) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    second.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    second.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
    const code = await new Promise<number | null>(resolve => second.once("exit", exitCode => resolve(exitCode)));
    assert.notEqual(code, 0);
    assert.match(output, /already held by another writer/);
    assert.equal(existsSync(join(dir, "second.sock")), false);
    await sameOnBothSockets(main, reader, "view", { beeId: "inbox" });
    assert.equal(typeof (await main.request<{ messageId: number }>("send", { beeId: "inbox", body: "still the only writer", sender: "bee-0" })).messageId, "number");

    clients.splice(0).forEach(client => client.close());
    await daemon.kill();
    assert.equal(storeWriterLockHeld(daemon.storePath), false, "a killed daemon leaves the store open to its successor");
    assert.equal(existsSync(readPath), true);
    daemon = await startDaemon(dir);
    const successor = await daemon.client(); clients.push(successor);
    assert.equal(successor.readSocket, readPath, "the successor replaces the dead read socket");
    const successorReader = await RpcClient.connect(readPath); clients.push(successorReader);
    const survived = await sameOnBothSockets(successor, successorReader, "mail.pending", { beeId: "inbox" });
    assert.equal((survived.result as { messages: Array<{ body: string }> }).messages.at(-1)?.body, "still the only writer");

    clients.splice(0).forEach(client => client.close());
    await daemon.stop();
    const stopped = daemon;
    daemon = null;
    assert.equal(existsSync(readPath), false, "shutdown removes the read socket");
    assert.equal(storeWriterLockHeld(stopped.storePath), false);
    assert.doesNotMatch(stopped.output(), /read\.socket\.(unavailable|lost)/);
    const restored = restoreStoreOffline(stopped.storePath, receipt.receiptPath);
    assert.match(restored.lossWindow, /after the backup are discarded/);
    const reopened = openCoreStore(stopped.storePath);
    try { assert.equal(reopened.undeliveredMessages("inbox").at(-1)?.body, "after the watch"); }
    finally { reopened.close(); }
  } finally { clients.forEach(client => client.close()); await daemon?.stop(); cleanup(); }
});
