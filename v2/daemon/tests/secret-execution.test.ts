import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { admitSecretExecution, secretArgvDigest } from "../src/secretExecution.ts";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";

function admission() {
  const argv = [process.execPath, "-e", "process.stdout.write(process.env.TOKEN)"];
  const metadata = { nodeId: "node-1", beeId: "bee-1", cellId: "cell-1", executionId: "exec-1", argvDigest: secretArgvDigest(argv), expiresAt: 2000 };
  return { params: { ...metadata, argv, idempotencyKey: "exec-1" }, context: { ...metadata, env: { TOKEN: "synthetic-private-material" } } };
}

test("admission binds every execution field, argv, expiry and env shape without reflecting material", () => {
  const a = admission();
  assert.equal(admitSecretExecution(a.params, a.context, "node-1", 1000).env.TOKEN, a.context.env.TOKEN);
  for (const field of ["nodeId", "beeId", "cellId", "executionId", "argvDigest", "expiresAt"] as const) {
    assert.throws(() => admitSecretExecution(a.params, { ...a.context, [field]: field === "expiresAt" ? 2100 : "other" }, "node-1", 1000), /secret_execution_invalid/);
  }
  for (const now of [2000, 3000, -30000]) assert.throws(() => admitSecretExecution(a.params, a.context, "node-1", now), /secret_execution_invalid/);
  assert.throws(() => admitSecretExecution({ ...a.params, argv: ["other"] }, a.context, "node-1", 1000), /secret_execution_invalid/);
  assert.throws(() => admitSecretExecution({ ...a.params, env: a.context.env }, a.context, "node-1", 1000), /secret_execution_invalid/);
  assert.throws(() => admitSecretExecution(a.params, a.context, "other", 1000), /secret_execution_invalid/);
});


test("capture admission binds display metadata, bounds bytes and excludes input env", () => {
  const a = admission();
  const { env: _env, ...binding } = a.context;
  const outputCapture = { name: "Synthetic display credential", maxBytes: 16384, leaseId: "lease-1", expiresAt: 2000 };
  const context = { ...binding, outputCapture };
  const params = { ...a.params, outputCapture };
  assert.deepEqual(admitSecretExecution(params, context, "node-1", 1000).outputCapture, outputCapture);
  for (const patch of [{ name: "" }, { name: "x".repeat(121) }, { name: "nul\0name" }, { maxBytes: 16385 }, { maxBytes: 0 }, { maxBytes: 1.5 }, { leaseId: "" }, { expiresAt: 1000 }]) {
    const invalid = { ...outputCapture, ...patch };
    assert.throws(() => admitSecretExecution({ ...params, outputCapture: invalid }, { ...context, outputCapture: invalid }, "node-1", 1000), /secret_execution_invalid/);
  }
  assert.throws(() => admitSecretExecution(params, { ...context, env: a.context.env }, "node-1", 1000), /secret_execution_invalid/);
  assert.throws(() => admitSecretExecution(params, { ...context, outputCapture: { ...outputCapture, leaseId: "other" } }, "node-1", 1000), /secret_execution_invalid/);
});

test("secret RPC requires registered local process and node binding, refuses relay and unrelated context", async () => {
  const root = (await import("node:fs")).realpathSync(mkdtempSync(join(tmpdir(), "secret-rpc-")));
  const absoluteSocket = join(root, "rpc.sock");
  const socketPath = Buffer.byteLength(absoluteSocket) < 100 ? absoluteSocket : relative(process.cwd(), absoluteSocket);
  const keyFile = join(root, "private", "key");
  let accepted = 0;
  const server = new RpcServer({ socketPath: socketPath, dataDir: root, localTrust: { requireObservationCaller: true, registrationKeyFile: keyFile }, log: () => {}, dispatch: (_verb, _params, conn) => {
    accepted++;
    assert.equal(conn.secretExecutionNodeId, "node-1");
    return { safe: true };
  } });
  let client: RpcClient | undefined;
  let relay: RpcClient | undefined;
  const a = admission();
  try {
    await server.listen();
    client = await RpcClient.connect(socketPath);
    await assert.rejects(client.request("cell.execSecret", a.params, 3000, { secretExecution: a.context }));
    const register = async (nodeId?: string) => {
      const challenge = await client!.request<LocalTrustChallenge>("rpc.localTrust.challenge");
      const key = readFileSync(keyFile);
      const token = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex");
      key.fill(0);
      await client!.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token, ...(nodeId ? { nodeId } : {}) });
    };
    await register();
    await assert.rejects(client.request("cell.execSecret", a.params, 3000, { secretExecution: a.context }));
    await register("node-1");
    assert.deepEqual(await client.request("cell.execSecret", a.params, 3000, { secretExecution: a.context }), { safe: true });
    await assert.rejects(client.request("cell.execSecret", a.params, 3000, { secretExecution: a.context, sessionPrincipal: { beeId: "bee-1" } }));
    await assert.rejects(client.request("cell.exec", a.params, 3000, { secretExecution: a.context }));
    relay = await RpcClient.connect(socketPath, 3000, "node_relay");
    await assert.rejects(relay.request("cell.execSecret", a.params, 3000, { secretExecution: a.context }));
    assert.equal(accepted, 1);
  } finally { client?.close(); relay?.close(); await server.close(); rmSync(root, { recursive: true, force: true }); }
});

test("daemon executes active owned Cell, keeps durable bytes clean, deduplicates after reopen and cancels", async () => {
  const { mkdirSync, writeFileSync, readdirSync } = await import("node:fs");
  const { openCoreStore } = await import("../../core/src/index.ts");
  const { HiveDaemon } = await import("../src/daemon.ts");
  const { loadNodeConfig } = await import("../src/config.ts");
  const { cellPaths } = await import("../../driver-cell/src/layout.ts");
  const root = mkdtempSync(join(tmpdir(), "secret-daemon-"));
  const cellsRoot = join(root, "cells");
  writeFileSync(join(root, "config.json"), JSON.stringify({ cells: { root: cellsRoot }, naming: { auto: false } }));
  const storePath = join(root, "fixture.sqlite");
  let store = openCoreStore(storePath);
  const daemon = new HiveDaemon(loadNodeConfig(root));
  const internal = daemon as unknown as { store: typeof store; driver: unknown; dispatch: import("../src/rpc.ts").RpcDispatch };
  internal.store = store;
  internal.driver = { cell: { hasProcess: () => true } };
  const bee = store.createBee({ name: "synthetic", agent: "stub", substrate: "cell", cwd: root }).bee;
  const paths = cellPaths(cellsRoot, "wrap", "repo", "c1");
  mkdirSync(paths.spaceDir, { recursive: true });
  const cell = store.putCell({ id: "cell-fixture", sourceBeeId: bee.id, originRepo: root, sha: "a".repeat(40), wrapper: "wrap", spaceName: paths.spaceName, spaceDir: paths.spaceDir, gitCommonDirRealpath: root, objectFormat: "sha1", sandbox: false });
  const token = "synthetic-" + "durable-sentinel-92781";
  const base = { nodeId: "node-1", beeId: bee.id, cellId: cell.id };
  const absoluteSocket = join(root, "rpc.sock");
  const socketPath = Buffer.byteLength(absoluteSocket) < 100 ? absoluteSocket : relative(process.cwd(), absoluteSocket);
  const keyFile = join(root, "private", "key");
  const logs: string[] = [];
  const server = new RpcServer({ socketPath, dataDir: root, localTrust: { requireObservationCaller: true, registrationKeyFile: keyFile }, log: line => logs.push(line), securityAudit: (kind, data) => logs.push(JSON.stringify({ kind, data })), dispatch: (verb, params, conn) => internal.dispatch(verb, params, conn) });
  await server.listen();
  const client = await RpcClient.connect(socketPath);
  const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const key = readFileSync(keyFile);
  const registrationToken = createHmac("sha256", key).update(localTrustMessage(challenge)).digest("hex");
  key.fill(0);
  await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token: registrationToken, nodeId: "node-1" });
  const run = async (executionId: string, argv: string[]) => {
    const binding = { ...base, executionId, argvDigest: secretArgvDigest(argv), expiresAt: Date.now() + 30000 };
    return client.request<import("../src/protocol.ts").CellExecResult>("cell.execSecret", { ...binding, argv, idempotencyKey: executionId }, 10000, { secretExecution: { ...binding, env: { TOKEN: token } } });
  };
  let scannedFiles = 0;
  const scan = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => {
    const path = join(dir, entry.name);
    if (entry.isFile()) scannedFiles++;
    return n + (entry.isDirectory() ? scan(path) : entry.isFile() && readFileSync(path).includes(Buffer.from(token)) ? 1 : 0);
  }, 0);
  try {
    const frames: Record<string, unknown>[] = [];
    const socket = (client as unknown as { socket: import("node:net").Socket }).socket;
    const observe = (chunk: string) => { for (const line of chunk.trim().split("\n")) frames.push(JSON.parse(line)); };
    socket.on("data", observe);
    const captureArgv = [process.execPath, "-e", "process.stdout.write(Buffer.from([0,255,12,34]));process.stderr.write(Buffer.from([0,255,12,34]))"];
    const outputCapture = { name: "TOKEN", maxBytes: 8, leaseId: "capture-lease", expiresAt: Date.now() + 30000 };
    const captureBinding = { ...base, executionId: "capture-once", argvDigest: secretArgvDigest(captureArgv), expiresAt: Date.now() + 30000, outputCapture };
    const captureParams = { ...captureBinding, argv: captureArgv, idempotencyKey: "capture-once" };
    const captureContext = { secretExecution: captureBinding };
    const captured = await client.request<import("../src/protocol.ts").CellExecResult>("cell.execSecret", captureParams, 10000, captureContext);
    assert.equal(captured.stdout, "");
    assert.equal(captured.stderr, "");
    assert.deepEqual(frames.at(-1)?.secretCapture, { leaseId: "capture-lease", bytesBase64: Buffer.from([0,255,12,34]).toString("base64") });
    assert.equal(JSON.stringify(captured).includes("secretCapture"), false);
    assert.equal(JSON.stringify(store.dumpState()).includes("bytesBase64"), false);
    await client.request("cell.execSecret", captureParams, 10000, captureContext);
    assert.equal(frames.at(-1)?.secretCapture, undefined);
    socket.off("data", observe);
    const argv = [process.execPath, "-e", "const fs=require('node:fs');fs.appendFileSync('runs','1');process.stdout.write(process.env.TOKEN);process.stderr.write(process.env.TOKEN)"];
    const first = await run("exec-durable", argv);
    assert.equal(first.stdout, "[REDACTED]");
    assert.equal(first.stderr, "[REDACTED]");
    assert.equal((await run("exec-durable", argv)).id, first.id);
    assert.equal(readFileSync(join(paths.spaceDir, "runs"), "utf8"), "1");
    assert.equal(JSON.stringify(store.dumpState()).includes(token), false);
    assert.equal(scan(root), 0);
    store.close();
    store = openCoreStore(storePath); internal.store = store;
    assert.equal((await run("exec-durable", argv)).id, first.id);
    assert.equal(readFileSync(join(paths.spaceDir, "runs"), "utf8"), "1");
    const foreign = store.createBee({ name: "foreign", agent: "stub", substrate: "hsr", cwd: root }).bee;
    const binding = { ...base, beeId: foreign.id, executionId: "foreign", argvDigest: secretArgvDigest(argv), expiresAt: Date.now() + 30000 };
    await assert.rejects(client.request("cell.execSecret", { ...binding, argv, idempotencyKey: "foreign" }, 3000, { secretExecution: { ...binding, env: { TOKEN: token } } }), /secret_execution_refused/);
    const pending = run("exec-cancel", [process.execPath, "-e", "process.stdout.write(process.env.TOKEN);setInterval(()=>{},1000)"]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await client.request("cell.execSecret.cancel", { ...base, executionId: "exec-cancel" }, 3000, {}), { cancelled: true });
    const cancelled = await pending;
    assert.equal(cancelled.status, "failed");
    assert.equal(store.getCellOpByKey("exec-cancel")?.failure, "interrupted");
    assert.deepEqual(await client.request("cell.execSecret.cancel", { ...base, executionId: "cancel-before-spawn" }, 3000, {}), { cancelled: true });
    store.close(); store = openCoreStore(storePath); internal.store = store;
    await assert.rejects(run("cancel-before-spawn", argv), /idempotency key/);
    await assert.rejects(run("exec-durable", [process.execPath, "-e", "0"]), /idempotency key/);
    assert.equal(JSON.stringify(cancelled).includes(token), false);
    assert.equal(scan(root), 0);
    assert.equal(logs.join("\n").includes(token), false);
    assert.equal(JSON.stringify(first).includes(token), false);
    console.log(`synthetic scan: ${scannedFiles} raw fixture file reads, 0 matches; ${logs.length} log records, 0 matches; 2 output results, 0 matches; duplicate command runs=1`);
  } finally { client.close(); await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
