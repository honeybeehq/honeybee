import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import { RpcServer, type RpcConn } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { type AuditRow } from "../../core/src/index.ts";
import type { WatchFrame } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, sleep, waitFor } from "./helpers.ts";

const row = (seq: number, body = "generated"): AuditRow => ({ seq, ts: 1, beeId: null, kind: "test.generated", payload: { body } });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hb-watch-overflow-"));
  let head = 0;
  const connections: RpcConn[] = [];
  const clients: RpcClient[] = [];
  const server = new RpcServer({ socketPath: join(dir, "rpc.sock"), dataDir: dir, log: () => {}, dispatch: (verb, _params, conn) => {
    if (verb === "watch") { conn.subscribeWatch(head); connections.push(conn); }
    if (verb === "snapshot") conn.alignWatch(head);
    return { seq: head };
  } });
  await server.listen();
  return {
    server, connections,
    async idle() { const client = await RpcClient.connect(join(dir, "rpc.sock")); clients.push(client); return client; },
    setHead: (seq: number) => { head = seq; }, head: () => head,
    async watch(capabilities: string[] = []) {
      const client = await RpcClient.connect(join(dir, "rpc.sock"), 3000, undefined, { capabilities }); clients.push(client);
      const frames: WatchFrame[] = [];
      client.onEvent = frame => frames.push(frame);
      await client.request("watch");
      return { client, frames };
    },
    async close() { clients.forEach(client => client.close()); await server.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("retained overflow stays contiguous, bounded and paced while new rows arrive", async () => {
  const rig = await fixture();
  try {
    const { client, frames } = await rig.watch();
    const rows = Array.from({ length: 1024 }, (_, i) => row(i + 1));
    rig.setHead(1024);
    const onEvent = client.onEvent;
    client.onEvent = frame => {
      onEvent?.(frame);
      if (frames.length === 1) { rows.push(row(1025)); rig.setHead(1025); }
    };
    let reads = 0;
    rig.server.flushWatch(rig.head, cursor => { reads++; return rows.filter(row => row.seq > cursor).slice(0, 257); }, 256);
    assert.equal(reads, 1);
    await waitFor(() => frames.at(-1)?.seq === 1025, "new head reached without another tick");
    let cursor = 0;
    for (const frame of frames) {
      assert.equal(frame.type, "delta");
      if (frame.type !== "delta") continue;
      assert.equal(frame.baseSeq, cursor);
      assert.ok(frame.events.length <= 256);
      for (const event of frame.events) assert.deepEqual(event, rows[cursor++]);
      assert.equal(frame.seq, cursor);
    }
    assert.equal(cursor, 1025);
    assert.ok(reads <= 5);
  } finally { await rig.close(); }
});

test("legacy hidden delivery audits retain their negotiated gap behavior", async () => {
  const rig = await fixture();
  try {
    const legacy = await rig.watch(), capable = await rig.watch(["mail.delivery.confirmation.v1"]);
    const hidden = { ...row(1), kind: "mail.confirmation_prepared" };
    rig.setHead(1);
    rig.server.flushWatch(rig.head, () => [hidden], 256);
    await waitFor(() => legacy.frames.length === 1 && capable.frames.length === 1, "negotiated hidden audit");
    assert.deepEqual(legacy.frames, [{ type: "gap", seq: 1 }]);
    assert.deepEqual(capable.frames, [{ type: "delta", baseSeq: 0, seq: 1, events: [hidden] }]);
  } finally { await rig.close(); }
});

test("regressed store head disconnects for a fresh watch", async () => {
  const rig = await fixture();
  try {
    rig.setHead(2);
    const { client, frames } = await rig.watch();
    rig.setHead(1);
    rig.server.flushWatch(rig.head, () => [], 256);
    await waitFor(() => (client as unknown as { socket: Socket }).socket.destroyed, "regressed head closes connection");
    assert.deepEqual(frames, []);
    const fresh = await rig.watch();
    rig.setHead(2);
    rig.server.flushWatch(rig.head, () => [row(2)], 256);
    await waitFor(() => fresh.frames.at(-1)?.seq === 2, "fresh snapshot resumes");
  } finally { await rig.close(); }
});

test("more watchers than a turn budget all make progress with shared-cursor reads", async () => {
  const rig = await fixture();
  try {
    const watchers: Awaited<ReturnType<typeof rig.watch>>[] = [];
    for (let i = 0; i < 20; i++) watchers.push(await rig.watch());
    const rows = Array.from({ length: 768 }, (_, i) => row(i + 1)); rig.setHead(768);
    let reads = 0;
    rig.server.flushWatch(rig.head, cursor => { reads++; return rows.filter(row => row.seq > cursor).slice(0, 257); }, 1000);
    await waitFor(() => watchers.every(watcher => watcher.frames.at(-1)?.seq === 768), "all watchers converge");
    for (const watcher of watchers) {
      assert.equal(watcher.frames.length, 3);
      assert.ok(watcher.frames.every(frame => frame.type === "delta" && frame.events.length === 256));
    }
    assert.ok(reads < 60);
  } finally { await rig.close(); }
});

test("idle RPC connections do not delay the first normal watch pass", async () => {
  const rig = await fixture();
  try {
    for (let i = 0; i < 64; i++) await rig.idle();
    const { frames } = await rig.watch();
    rig.setHead(1);
    let reads = 0;
    rig.server.flushWatch(rig.head, () => { reads++; return [row(1)]; }, 256);
    assert.equal(reads, 1);
    await waitFor(() => frames.length === 1, "normal delta");
    assert.deepEqual(frames[0], { type: "delta", baseSeq: 0, seq: 1, events: [row(1)] });
  } finally { await rig.close(); }
});

test("the normalized row limit bounds the source read as well as the emitted frame", async () => {
  for (const configured of [-1, 0, 1.5, 1024]) {
    const rig = await fixture();
    try {
      const { frames } = await rig.watch();
      const expected = Math.min(256, Math.max(1, Math.floor(configured)));
      const rows = [row(1), row(2), row(3)]; rig.setHead(3);
      rig.server.flushWatch(rig.head, (cursor, limit) => {
        assert.equal(limit, expected);
        return rows.filter(row => row.seq > cursor).slice(0, limit);
      }, configured);
      await waitFor(() => frames.at(-1)?.seq === 3, "normalized source limit catches up");
      assert.ok(frames.every(frame => frame.type === "delta" && frame.events.length <= expected));
    } finally { await rig.close(); }
  }
});

test("real daemon catch-up preserves account health and private thread operation enrichment", async () => {
  const rig = makeDaemonDir({ tickMs: 50, watchMaxBatch: 2 });
  let daemon, watcher;
  const control = join(rig.dir, "watch-control.json");
  try {
    daemon = await startDaemon(rig.dir, { env: { HIVE_TEST_WATCH_AUDIT_CONTROL: control, NODE_OPTIONS: `--import=${fileURLToPath(new URL("./fixtures/watch-audit-control.mjs", import.meta.url))}` } });
    watcher = await daemon.client();
    const frames: WatchFrame[] = [];
    watcher.onEvent = frame => frames.push(frame);
    const initial = await watcher.request<{ seq: number }>("watch");
    writeFileSync(control, JSON.stringify({ kind: "thread-operation" }));
    for (let i = 0; i < 5; i++) await watcher.request("account.add", { id: `generated-${i}`, harness: "codex", label: `Generated ${i}`, homePath: join(rig.dir, `account-${i}`) });
    await waitFor(() => frames.some(frame => frame.type === "delta" && frame.events.some(event => event.kind === "thread_operation.put")) && frames.flatMap(frame => frame.type === "delta" ? frame.events : []).filter(event => event.kind === "account.put").length === 5, "enriched thread operation arrives");
    let cursor = initial.seq;
    const accounts = [];
    for (const frame of frames) {
      assert.equal(frame.type, "delta");
      if (frame.type !== "delta") continue;
      assert.equal(frame.baseSeq, cursor); cursor = frame.seq;
      assert.ok(frame.events.length <= 2);
      for (const event of frame.events) {
        if (event.kind === "account.put") accounts.push(event.payload.account);
        if (event.kind === "thread_operation.put") assert.deepEqual(event.payload, { operation: { id: "generated-operation", phase: "done" } });
      }
    }
    const snapshot = await watcher.request<{ accounts: unknown[] }>("snapshot");
    assert.equal(accounts.length, 5);
    for (const account of accounts) assert.deepEqual(account, snapshot.accounts.find(value => (value as { id: string }).id === (account as { id: string }).id));
    assert.ok(accounts.every(account => typeof account === "object" && account !== null && "credentialHealth" in account));
    assert.doesNotMatch(JSON.stringify(frames), /private-worker|private-generated-path/);
  } finally {
    watcher?.close(); await daemon?.stop(); rig.cleanup();
  }
});

test("encoded UTF-8 byte cap permits only an indivisible oversized singleton", async () => {
  const rig = await fixture();
  try {
    const { frames } = await rig.watch();
    const rows = [row(1, "ø".repeat(45000)), row(2, "ø".repeat(45000)), row(3, "🦋".repeat(100000)), row(4)];
    rig.setHead(4);
    rig.server.flushWatch(rig.head, cursor => rows.filter(row => row.seq > cursor), 256);
    await waitFor(() => frames.at(-1)?.seq === 4, "byte-limited catch-up");
    assert.equal(frames.length, 4);
    for (const frame of frames) {
      assert.equal(frame.type, "delta");
      if (frame.type !== "delta") continue;
      const bytes = Buffer.byteLength(JSON.stringify(frame) + "\n");
      assert.ok(bytes <= 128 * 1024 || frame.events.length === 1);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(frames[2])) > 128 * 1024);
  } finally { await rig.close(); }
});

for (const missing of ["first", "interior", "tail"] as const) test(`missing ${missing} history emits one real gap and waits for snapshot`, async () => {
  const rig = await fixture();
  try {
    const { client, frames } = await rig.watch();
    rig.setHead(3);
    const rows = missing === "first" ? [row(2), row(3)] : missing === "interior" ? [row(1), row(3)] : [row(1), row(2)];
    rig.server.flushWatch(rig.head, cursor => rows.filter(row => row.seq > cursor), 256);
    await waitFor(() => frames.at(-1)?.type === "gap", "real gap");
    const expected = missing === "tail" ? [{ type: "delta", baseSeq: 0, seq: 2, events: [row(1), row(2)] }, { type: "gap", seq: 3 }] : [{ type: "gap", seq: 3 }];
    assert.deepEqual(frames, expected);
    await sleep(30); assert.equal(frames.length, expected.length);
    await client.request("snapshot");
    rig.setHead(4);
    rig.server.flushWatch(rig.head, () => [row(4)], 256);
    await waitFor(() => frames.length === expected.length + 1, "snapshot realigned watch");
    assert.deepEqual(frames.at(-1), { type: "delta", baseSeq: 3, seq: 4, events: [row(4)] });
  } finally { await rig.close(); }
});

test("paused reader blocks catch-up behind other writes while healthy watcher advances; realignment supersedes backlog", async () => {
  const rig = await fixture();
  try {
    const slow = await rig.watch(), healthy = await rig.watch();
    const socket = (rig.connections[0] as unknown as { socket: Socket }).socket;
    const reader = (slow.client as unknown as { socket: Socket }).socket;
    reader.pause();
    rig.connections[0]!.send({ padding: "x".repeat(8 * 1024 * 1024) });
    assert.ok(socket.writableNeedDrain);
    const rows = Array.from({ length: 1024 }, (_, i) => row(i + 1));
    rig.setHead(1024);
    let reads = 0;
    rig.server.flushWatch(rig.head, cursor => { reads++; return rows.filter(row => row.seq > cursor).slice(0, 257); }, 256);
    await waitFor(() => healthy.frames.at(-1)?.seq === 1024, "healthy watcher catches up");
    const heldBytes = socket.writableLength;
    await sleep(40);
    assert.equal(socket.writableLength, heldBytes);
    assert.equal(reads, 4);
    rig.connections[0]!.alignWatch(1024);
    reader.resume();
    await waitFor(() => !socket.writableNeedDrain, "queued response drains");
    rows.push(row(1025)); rig.setHead(1025);
    rig.server.flushWatch(rig.head, cursor => rows.filter(row => row.seq > cursor).slice(0, 257), 256);
    await waitFor(() => slow.frames.at(-1)?.seq === 1025, "realigned watcher resumes");
    assert.deepEqual(slow.frames, [{ type: "delta", baseSeq: 1024, seq: 1025, events: [row(1025)] }]);
  } finally { await rig.close(); }
});

test("snapshot alignment and disconnect cancel outstanding paced catch-up", async () => {
  const rig = await fixture();
  try {
    const first = await rig.watch(), second = await rig.watch();
    const rows = Array.from({ length: 4096 }, (_, i) => row(i + 1)); rig.setHead(4096);
    let reads = 0;
    rig.server.flushWatch(rig.head, cursor => { reads++; return rows.filter(row => row.seq > cursor).slice(0, 257); }, 256);
    await waitFor(() => first.frames.length > 0, "catch-up starts");
    await first.client.request("snapshot"); second.client.close();
    await sleep(30);
    const settled = reads;
    await sleep(30); assert.equal(reads, settled);
    assert.ok(first.frames.length < 16);
  } finally { await rig.close(); }
});

test("oversized watch write is accepted once on false, stays bounded while paused, and snapshot cancels pending rows", async () => {
  const rig = await fixture();
  try {
    const { client, frames } = await rig.watch();
    const connection = rig.connections[0] as unknown as { socket: Socket; watchCursor: number };
    const reader = (client as unknown as { socket: Socket }).socket;
    reader.pause();
    const rows = [row(1, "x".repeat(8 * 1024 * 1024)), ...Array.from({ length: 512 }, (_, i) => row(i + 2))];
    rig.setHead(513);
    let reads = 0;
    rig.server.flushWatch(rig.head, cursor => { reads++; return rows.filter(row => row.seq > cursor).slice(0, 257); }, 256);
    await waitFor(() => connection.socket.writableNeedDrain, "oversized singleton backpressures");
    assert.equal(connection.watchCursor, 1);
    const heldBytes = connection.socket.writableLength;
    const samples = [];
    for (let i = 0; i < 10; i++) {
      await sleep(10);
      samples.push({ writableLength: connection.socket.writableLength, ...process.memoryUsage() });
    }
    assert.ok(samples.every(sample => sample.writableLength === heldBytes));
    assert.equal(reads, 1);
    assert.ok(heldBytes <= Buffer.byteLength(JSON.stringify({ type: "delta", baseSeq: 0, seq: 1, events: [rows[0]] }) + "\n"));
    rig.connections[0]!.alignWatch(513);
    reader.resume();
    await waitFor(() => !connection.socket.writableNeedDrain && frames.length === 1, "accepted singleton drains once");
    assert.deepEqual(frames[0], { type: "delta", baseSeq: 0, seq: 1, events: [rows[0]] });
    rows.push(row(514)); rig.setHead(514);
    rig.server.flushWatch(rig.head, cursor => rows.filter(row => row.seq > cursor).slice(0, 257), 256);
    await waitFor(() => frames.length === 2, "new event after aligned snapshot");
    assert.deepEqual(frames[1], { type: "delta", baseSeq: 513, seq: 514, events: [row(514)] });
    if (process.env.HIVE_WATCH_PRESSURE_RECEIPT) writeFileSync(process.env.HIVE_WATCH_PRESSURE_RECEIPT, JSON.stringify({ heldBytes, readsWhilePaused: reads, singletonBytes: Buffer.byteLength(JSON.stringify(rows[0])), samples, scope: "in-process generated RpcServer + receiver; sampled process memory is a lower bound, includes fixture and client" }, null, 2) + "\n");
  } finally { await rig.close(); }
});
