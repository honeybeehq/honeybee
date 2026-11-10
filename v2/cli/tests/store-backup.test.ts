import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { LEGACY_PROTOCOL, RpcClient } from "../src/client.ts";
import { RpcError } from "../../daemon/src/protocol.ts";
import { makeDaemonDir, startDaemon } from "../../daemon/tests/helpers.ts";
import { runV2Cli } from "../src/main.ts";
import { openCoreStore } from "../../core/src/index.ts";
import { StoreBackupError } from "../../core/src/storeBackup.ts";
import { toRpcError } from "../../daemon/src/rpc.ts";

const capture = () => {
  const out: string[] = [], err: string[] = [];
  return { out, err, io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) } };
};

test("store maintenance CLI uses owner RPC; restore refuses live daemon and succeeds offline", async () => {
  const h = makeDaemonDir();
  const daemon = await startDaemon(h.dir);
  try {
    const backup = capture();
    assert.equal(await runV2Cli(["store", "backup", "--data-dir", h.dir, "--json"], backup.io), 0, backup.err.join("\n"));
    const receipt = JSON.parse(backup.out[0]!);
    assert.equal(receipt.integrityCheck, "ok");
    assert.equal(JSON.parse(readFileSync(receipt.receiptPath, "utf8")).sha256, receipt.sha256);
    const denied = capture();
    assert.equal(await runV2Cli(["store", "restore", "--data-dir", h.dir, "--from", receipt.receiptPath, "--json"], denied.io), 1);
    assert.equal(JSON.parse(denied.out[0]!).error.code, "store_restore_refused");
    await daemon.stop();
    const restored = capture();
    assert.equal(await runV2Cli(["store", "restore", "--data-dir", h.dir, "--from", receipt.receiptPath, "--json"], restored.io), 0, restored.err.join("\n"));
    assert.match(JSON.parse(restored.out[0]!).lossWindow, /after the backup are discarded/);
    openCoreStore(receipt.storePath).close();
  } finally { await daemon.stop(); h.cleanup(); }
});

test("store backup falls back to the offline backup only when no daemon answers the socket", async () => {
  const h = makeDaemonDir();
  const daemon = await startDaemon(h.dir);
  try {
    await daemon.stop();
    const offline = capture();
    assert.equal(await runV2Cli(["store", "backup", "--data-dir", h.dir, "--source-build", "offline-build", "--json"], offline.io), 0, offline.err.join("\n"));
    const receipt = JSON.parse(offline.out[0]!);
    assert.equal(receipt.sourceBuild, "offline-build");
    assert.equal(receipt.integrityCheck, "ok");
  } finally { await daemon.stop(); h.cleanup(); }
});

test("a store backup the running daemon has not returned in time is reported as such, without an offline backup", async () => {
  const h = makeDaemonDir();
  openCoreStore(join(h.dir, "core.sqlite3")).close();
  const requests: string[] = [];
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    socket.write(`${JSON.stringify({ protocol: LEGACY_PROTOCOL, capabilities: [] })}\n`);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const frame = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (frame.id !== undefined) requests.push(frame.verb);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(h.dir, "hived.sock"), resolve); });
  try {
    const slow = capture();
    const startedAt = Date.now();
    assert.equal(await runV2Cli(["store", "backup", "--data-dir", h.dir, "--timeout", "300", "--json"], slow.io), 1);
    const { error, daemonTarget } = JSON.parse(slow.out[0]!);
    assert.equal(error.code, "store_backup_failed");
    assert.match(error.message, /running daemon did not return the store backup within 300 ms \(rpc timeout on store\.backup\)/);
    assert.equal(daemonTarget.connected, true);
    assert.deepEqual(requests, ["store.backup"]);
    assert.ok(Date.now() - startedAt >= 300);
    assert.equal(existsSync(`${join(h.dir, "core.sqlite3")}.backups`), false, "no offline backup was written beside the daemon-owned store");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    h.cleanup();
  }
});

test("the store backup request waits long enough for a large store by default", async () => {
  const h = makeDaemonDir();
  const receipt = { format: 1, receiptPath: join(h.dir, "receipt.json"), integrityCheck: "ok", sourceBuild: "slow" };
  const sockets: Socket[] = [];
  const server = createServer(socket => {
    sockets.push(socket);
    socket.write(`${JSON.stringify({ protocol: LEGACY_PROTOCOL, capabilities: [] })}\n`);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const frame = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (frame.id !== undefined) setTimeout(() => socket.write(`${JSON.stringify({ id: frame.id, ok: true, result: receipt })}\n`), 10_500);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(h.dir, "hived.sock"), resolve); });
  try {
    const slow = capture();
    assert.equal(await runV2Cli(["store", "backup", "--data-dir", h.dir, "--json"], slow.io), 0, slow.out.join("\n"));
    const { daemonTarget: _target, ...reported } = JSON.parse(slow.out[0]!);
    assert.deepEqual(reported, receipt);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    h.cleanup();
  }
});

test("backup failures preserve their typed RPC error", () => {
  assert.equal(toRpcError(new StoreBackupError("disk full")).code, "store_backup_failed");
});

test("store backup and deploy-info cross the v2/1 daemon boundary; everything else stays refused", async () => {
  const h = makeDaemonDir();
  const receipt = { format: 1, receiptPath: join(h.dir, "receipt.json"), integrityCheck: "ok", sourceBuild: JSON.stringify({ sourceRevision: "old" }) };
  const identity = { protocol: LEGACY_PROTOCOL, identity: { sourceRevision: "old" }, nodeVersion: process.version, pid: 4242, startedAt: 7 };
  const verbs: string[] = [];
  const server = createServer(socket => {
    socket.write(`${JSON.stringify({ protocol: LEGACY_PROTOCOL, capabilities: [] })}\n`);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const frame = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (frame.id === undefined) { assert.equal(frame.protocol, LEGACY_PROTOCOL, "the client answers the hello in the daemon's own protocol"); continue; }
        verbs.push(frame.verb);
        const result = frame.verb === "store.backup" ? receipt : frame.verb === "deployInfo" ? identity : null;
        socket.write(`${JSON.stringify(result ? { id: frame.id, ok: true, result } : { id: frame.id, ok: false, error: { code: "invalid_request", message: `unexpected ${frame.verb}` } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(h.dir, "hived.sock"), resolve); });
  try {
    const backup = capture();
    assert.equal(await runV2Cli(["store", "backup", "--data-dir", h.dir, "--source-build", "unused: daemon owns the backup", "--json"], backup.io), 0, backup.err.join("\n"));
    const { daemonTarget, ...reported } = JSON.parse(backup.out[0]!);
    assert.deepEqual(reported, receipt);
    assert.equal(daemonTarget.connected, true);
    const info = capture();
    assert.equal(await runV2Cli(["deploy-info", "--data-dir", h.dir, "--json"], info.io), 0, info.err.join("\n"));
    assert.equal(JSON.parse(info.out[0]!).daemonIdentity.sourceRevision, "old");
    assert.equal(JSON.parse(info.out[0]!).pid, 4242);
    const health = capture();
    assert.equal(await runV2Cli(["health", "--data-dir", h.dir, "--json"], health.io), 1);
    assert.equal(JSON.parse(health.out[0]!).error.code, "protocol_mismatch");
    assert.deepEqual(verbs, ["store.backup", "deployInfo"], "no verb reaches a legacy daemon without an explicit allowance");

    const client = await RpcClient.connect(join(h.dir, "hived.sock"), 3000, undefined, { legacyProtocolVerbs: ["store.backup"] });
    try {
      assert.deepEqual(await client.request("store.backup"), receipt);
      await assert.rejects(client.request("deployInfo"), (error: unknown) => error instanceof RpcError && error.code === "protocol_mismatch");
      await assert.rejects(client.request("health"), (error: unknown) => error instanceof RpcError && error.code === "protocol_mismatch");
    } finally { client.close(); }
    await assert.rejects(RpcClient.connect(join(h.dir, "hived.sock")), (error: unknown) => error instanceof RpcError && error.code === "protocol_mismatch");
    await assert.rejects(RpcClient.connect(join(h.dir, "hived.sock"), 3000, undefined, { legacyProtocolVerbs: [] }), (error: unknown) => error instanceof RpcError && error.code === "protocol_mismatch");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    h.cleanup();
  }
});
