import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { PeerCredentials } from "../src/peerCredentials.ts";
import { withRpcCaller, withoutRpcCaller, currentRpcCaller } from "../../core/src/rpcAuditContext.ts";

test("the shipped Node Unix socket fd yields kernel credentials and a live birth-bound process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peercred-"));
  const credentials = new PeerCredentials();
  const server = createServer();
  const path = join(dir, "rpc.sock");
  server.listen(path);
  await once(server, "listening");
  const accepted = once(server, "connection");
  const client = createConnection(path);
  const [socket] = await accepted;
  try {
    const connection = credentials.connect(socket);
    assert.equal(connection.state, "verified");
    if (connection.state !== "verified") return;
    assert.equal(connection.peer.uid, process.geteuid!());
    assert.equal(connection.peer.pid, process.pid);
    assert.ok(connection.peer.processBirth);
    assert.equal(connection.current(), true);
    connection.close();
    assert.equal(connection.current(), false);
    assert.equal(socket.destroyed, false);
  } finally {
    credentials.close(); client.destroy(); socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, {recursive: true, force: true});
  }
});

test("missing metadata degrades once, and loading remains lazy", () => {
  const dir = mkdtempSync(join(tmpdir(), "peercred-missing-"));
  let reports = 0;
  let loads = 0;
  const credentials = new PeerCredentials({directory: dir, load: () => { loads++; throw new Error("unused"); }, degraded: () => reports++});
  try {
    assert.equal(credentials.status.state, "peer_credentials_unavailable");
    assert.equal(credentials.connect({}).state, "degraded");
    assert.equal(credentials.connect({}).state, "degraded");
    assert.equal(loads, 0);
    assert.equal(reports, 1);
  } finally { credentials.close(); rmSync(dir, {recursive: true, force: true}); }
});

test("interleaved awaited callers stay separate and daemon work exits attribution", async () => {
  const caller = (pid: number) => ({transport: "local_unix" as const, ingress: "local_unix" as const, uid: 123, pid, verb: "spawn"});
  const work = (pid: number) => withRpcCaller(caller(pid), async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentRpcCaller()?.pid, pid);
    await withoutRpcCaller(async () => {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(currentRpcCaller(), null);
    });
    assert.equal(currentRpcCaller()?.pid, pid);
  });
  await Promise.all([work(10), work(20)]);
  assert.equal(currentRpcCaller(), null);
});


test("wrong-target metadata degrades before loading and actual load failure is reported once", () => {
  const root = mkdtempSync(join(tmpdir(), "peercred-target-"));
  const target = `${process.platform}-${process.arch}`;
  const original = new PeerCredentials().status.artifactPath;
  cpSync(join(original, ".."), root, {recursive: true});
  let reports = 0, loads = 0;
  try {
    const path = join(root, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({...manifest, target: "wrong-target"}));
    const invalid = new PeerCredentials({directory: root, target, load: () => { loads++; throw new Error("unused"); }, degraded: () => reports++});
    assert.equal(invalid.status.reason, "artifact_invalid");
    assert.equal(loads, 0);
    invalid.close();
    writeFileSync(path, JSON.stringify(manifest));
    const failed = new PeerCredentials({directory: root, target, load: () => { loads++; throw new Error("load"); }, degraded: () => reports++});
    assert.equal(loads, 0);
    assert.equal(failed.connect({}).state, "degraded");
    assert.equal(failed.connect({}).state, "degraded");
    assert.equal(loads, 1);
    assert.equal(reports, 2);
    failed.close();
  } finally { rmSync(root, {recursive: true, force: true}); }
});
