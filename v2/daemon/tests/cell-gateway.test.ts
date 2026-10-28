import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, renameSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { authorizeCellGateway, CellGatewayLimits, CELL_GATEWAY_LIMITS, type CellGatewayPolicy } from "../src/cellGateway.ts";
import { RPC_VERBS, RpcError } from "../src/protocol.ts";
import { PeerCredentials, type PeerConnection } from "../src/peerCredentials.ts";
import { RpcServer } from "../src/rpc.ts";
import { RpcClient } from "../../cli/src/client.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { openCoreStore } from "../../core/src/index.ts";
import { inspectProcess } from "../../harness/src/processIdentity.ts";
import { resolveDaemonTarget } from "../../cli/src/target.ts";
import { runV2Cli } from "../../cli/src/main.ts";

const peer = { uid: process.geteuid!(), pid: process.pid, processBirth: "fixture" };
const policy: CellGatewayPolicy = {
  identity: Object.freeze({ beeId: "self", generation: 3 }),
  limits: new CellGatewayLimits(),
  current: value => value === peer,
  canSend: target => target === "parent",
};
const accepted = {
  view: { beeId: "self" },
  "bee.transcript": { beeId: "self" },
  list: {},
  send: { beeId: "parent", body: "hello" },
  "question.ask": { beeId: "self", text: "ready?" },
  "seal.create": { beeId: "self", title: "done", body: "evidence" },
};
const refused = (error: unknown): boolean => error instanceof RpcError && error.code === "caller_not_trusted";

test("gateway authorizes only the enumerated verbs; every other protocol verb is denied", () => {
  for (const verb of RPC_VERBS) {
    if (Object.hasOwn(accepted, verb)) {
      const params = accepted[verb as keyof typeof accepted];
      assert.doesNotThrow(() => authorizeCellGateway(policy, peer, verb, params, undefined), verb);
    } else {
      assert.throws(() => authorizeCellGateway(policy, peer, verb, { beeId: "self" }, undefined), refused, verb);
    }
  }
  for (const params of [{ cwd: "/tmp" }, { substrate: "hsr" }, { substrate: "tmux" }, { node: "other" }, {}]) {
    assert.throws(() => authorizeCellGateway(policy, peer, "spawn", params, undefined), refused);
  }
});

test("identity, generation, authority context and sender cannot be supplied by the caller", () => {
  for (const verb of ["view", "bee.transcript", "question.ask", "seal.create"] as const) {
    assert.throws(() => authorizeCellGateway(policy, peer, verb, { beeId: "other" }, undefined), refused);
    assert.equal(authorizeCellGateway(policy, peer, verb, {}, undefined).beeId, "self");
  }
  for (const context of [{ sessionPrincipal: { beeId: "self" } }, { humanChat: {} }, { phoneOrigin: {} }, {}]) {
    assert.throws(() => authorizeCellGateway(policy, peer, "view", {}, context), refused);
  }
  for (const extra of [{ authenticatedBeeId: "other" }, { generation: 4 }, { automationKind: "tell-mode" }, { revealEnv: true }]) {
    assert.throws(() => authorizeCellGateway(policy, peer, "view", extra, undefined), refused);
  }
  assert.throws(() => authorizeCellGateway(policy, undefined, "view", {}, undefined), refused);
  assert.throws(() => authorizeCellGateway(policy, { ...peer }, "view", {}, undefined), refused);
  assert.throws(() => authorizeCellGateway({ ...policy, current: () => false }, peer, "view", {}, undefined), refused);
  assert.throws(() => authorizeCellGateway(policy, peer, "send", { beeId: "parent", sender: "operator" }, undefined), refused);
  assert.throws(() => authorizeCellGateway(policy, peer, "send", { beeId: "foreign" }, undefined), refused);
  assert.throws(() => authorizeCellGateway(policy, peer, "thread.transcript", { operationId: "foreign" }, undefined), refused);
  assert.throws(() => authorizeCellGateway(policy, peer, "thread.transcript", { operationId: "own-operation" }, undefined), refused);
  const result = authorizeCellGateway(policy, peer, "send", { beeId: "parent", urgency: "now", idempotencyKey: "key" }, undefined);
  assert.equal(result.sender, "self");
  assert.equal(result.urgency, "next");
  assert.notEqual(result.idempotencyKey, "key");
  assert.notEqual(result.idempotencyKey, authorizeCellGateway({ ...policy, identity: { beeId: "other", generation: 3 } }, peer, "send", { beeId: "parent", idempotencyKey: "key" }, undefined).idempotencyKey);
  assert.equal(result.idempotencyKey, authorizeCellGateway({ ...policy, identity: { beeId: "self", generation: 4 } }, peer, "send", { beeId: "parent", idempotencyKey: "key" }, undefined).idempotencyKey);
});

class FixturePeers extends PeerCredentials {
  live = true;
  constructor() { super({ directory: "/nonexistent-gateway-fixture" }); }
  override connect(): PeerConnection {
    return { state: "verified", peer, current: () => this.live, close() {} };
  }
}

test("gateway RPC intercepts privileged handlers and refuses degraded or expired peers", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-gateway-"));
  const peers = new FixturePeers();
  const calls: string[] = [];
  const server = new RpcServer({ socketPath: join(root, "g.sock"), dataDir: root, peerCredentials: peers, cellGateway: policy, log() {},
    dispatch(verb, params, conn) { calls.push(verb); return { params, caller: conn.authenticatedBeeId }; } });
  let client: RpcClient | undefined;
  try {
    server.listenFresh();
    client = await RpcClient.connect(join(root, "g.sock"));
    assert.deepEqual(await client.request("view", { beeId: "self" }), { params: { beeId: "self" }, caller: "self" });
    for (const verb of ["rpc.localTrust.challenge", "account.credentials.export", "cell.exec", "config.patch", "spawn"] as const) {
      await assert.rejects(client.request(verb, { beeId: "other", cwd: root }), /Cell gateway operation refused/);
    }
    await assert.rejects(client.request("view", {}, 3000, { sessionPrincipal: { beeId: "self" } }), /Cell gateway operation refused/);
    peers.live = false;
    await assert.rejects(client.request("view", {}), /current verified local peer/);
    assert.deepEqual(calls, ["view"]);
  } finally { client?.close(); await server.close(); }
  const degraded = new RpcServer({ socketPath: join(root, "d.sock"), peerCredentials: new PeerCredentials({ directory: join(root, "missing") }), cellGateway: policy, log() {}, dispatch() { assert.fail("degraded peer dispatched"); } });
  try {
    degraded.listenFresh();
    client = await RpcClient.connect(join(root, "d.sock"));
    await assert.rejects(client.request("view", {}), /current verified local peer/);
  } finally { client?.close(); await degraded.close(); trash(root); }
});

function trash(path: string): void {
  const destination = join(tmpdir(), "honeybee-test-trash");
  mkdirSync(destination, { recursive: true });
  renameSync(path, join(destination, path.split("/").at(-1)!));
}

test("temporary daemon home binds the socket to its own live generation with real peer credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-cg-"));
  const store = openCoreStore(join(root, "fixture.sqlite"));
  const daemon = new HiveDaemon(loadNodeConfig(root));
  const internal = daemon as unknown as { store: typeof store; cellGateway(id: string, generation: number): { socketPath: string }; cellGateways: Map<string, { server: RpcServer }>; cellGatewaySweep: NodeJS.Timeout | null };
  internal.store = store;
  const parent = store.createBee({ name: "parent", agent: "stub", substrate: "hsr", cwd: root }).bee;
  mkdirSync(join(root, "session-logs"));
  const log = join(root, "session-logs", "self.jsonl");
  writeFileSync(log, "fixture transcript\n");
  const { bee, runtime } = store.createBee({ name: "self", agent: "stub", substrate: "cell", cwd: root, parentId: parent.id, sessionLogPath: log });
  const own = inspectProcess(process.pid);
  assert.equal(own.kind, "present", "native peer credentials are required for this integration test");
  if (own.kind !== "present") throw new Error("native process identity unavailable");
  store.recordRuntimeProc(bee.id, runtime.generation, { pid: own.pid, pidStartedAt: own.startedAtMs, processIdentity: { pid: own.pid, birth: own.birth, bootId: own.bootId } });
  const gateway = internal.cellGateway(bee.id, runtime.generation);
  let client: RpcClient | undefined;
  try {
    client = await RpcClient.connect(gateway.socketPath);
    const view = await client.request<{ bee: { id: string } }>("view", { beeId: bee.id });
    assert.equal(view.bee.id, bee.id);
    const transcript = await client.request<{ bytesBase64: string; nextOffset: number; eof: boolean }>("bee.transcript", { beeId: bee.id, offset: 0, limitBytes: 7 });
    assert.equal(Buffer.from(transcript.bytesBase64, "base64").toString(), "fixture");
    assert.equal(transcript.nextOffset, 7);
    assert.equal(transcript.eof, false);
    await assert.rejects(client.request("bee.transcript", { beeId: parent.id }), /Cell gateway operation refused/);
    await assert.rejects(client.request("view", { beeId: parent.id }), /Cell gateway operation refused/);
    await assert.rejects(client.request("cell.exec", { beeId: parent.id, command: "stdin" }), /Cell gateway operation refused/);
    await assert.rejects(client.request("spawn", { agent: "stub", cwd: root }), /Cell gateway operation refused/);
    await client.request("question.ask", { beeId: bee.id, text: "fixture question" });
    assert.equal(store.listQuestions({ beeId: bee.id }).length, 1);
    const inbox = store.createBee({ name: "remote-proxy-parent", agent: "inbox", substrate: "hsr", cwd: root }).bee;
    const child = store.createBee({ name: "proxy-child", agent: "stub", substrate: "cell", cwd: root, parentId: inbox.id });
    store.recordRuntimeProc(child.bee.id, child.runtime.generation, { pid: own.pid, pidStartedAt: own.startedAtMs, processIdentity: { pid: own.pid, birth: own.birth, bootId: own.bootId } });
    const proxyGateway = internal.cellGateway(child.bee.id, child.runtime.generation);
    const proxyClient = await RpcClient.connect(proxyGateway.socketPath);
    try {
      await assert.rejects(proxyClient.request("send", { beeId: inbox.id, body: "must not forward" }), /Cell gateway operation refused/);
      assert.equal(store.listMessages(inbox.id).length, 0);
    } finally { proxyClient.close(); }
    const priorGateway = process.env.HIVE_CELL_GATEWAY_SOCKET;
    process.env.HIVE_CELL_GATEWAY_SOCKET = gateway.socketPath;
    try {
      const output: string[] = [];
      const errors: string[] = [];
      const io = { out: (line: string) => output.push(line), err: (line: string) => errors.push(line) };
      assert.equal(await runV2Cli(["transcript", bee.id, "--raw", "--json", "--data-dir", root], io), 0, errors.join("\n"));
      assert.deepEqual(JSON.parse(output.at(-1)!).lines, ["fixture transcript"]);
      output.length = 0;
      assert.equal(await runV2Cli(["send", parent.id, "fixture mail", "--json", "--data-dir", root], io), 0, errors.join("\n"));
      assert.equal(store.listMessages(parent.id).at(-1)?.sender, bee.id);
      process.env.HIVE_CELL_GATEWAY_SOCKET = join(root, "down.sock");
      output.length = 0;
      assert.equal(await runV2Cli(["view", bee.id, "--json", "--data-dir", root], io), 1);
      assert.equal(JSON.parse(output.at(-1)!).error.code, "socket_unreachable");
    } finally {
      if (priorGateway === undefined) delete process.env.HIVE_CELL_GATEWAY_SOCKET;
      else process.env.HIVE_CELL_GATEWAY_SOCKET = priorGateway;
    }
    store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    await assert.rejects(client.request("view", {}), /Cell gateway operation refused/);
    const next = store.reviveBee(bee.id);
    store.recordRuntimeProc(bee.id, next.generation, { pid: own.pid, pidStartedAt: own.startedAtMs, processIdentity: { pid: own.pid, birth: own.birth, bootId: own.bootId } });
    await assert.rejects(client.request("view", {}), /Cell gateway operation refused/);
    const fresh = await RpcClient.connect(internal.cellGateway(bee.id, next.generation).socketPath);
    try {
      assert.equal((await fresh.request<{ bee: { id: string } }>("view", {})).bee.id, bee.id);
    } finally { fresh.close(); }
    assert.ok(store.auditTail(0, 1000).some(row => row.kind === "rpc.local_refused" && row.payload.beeId === bee.id && String(row.payload.reason).includes("cell.exec")));
  } finally {
    if (internal.cellGatewaySweep) clearInterval(internal.cellGatewaySweep);
    client?.close();
    await Promise.all([...internal.cellGateways.values()].map(item => item.server.close()));
    store.close();
    trash(root);
  }
});

test("Cell mutation limits bound payload bytes and persist across generations with a deterministic window", () => {
  let now = 0;
  const limits = new CellGatewayLimits(() => now);
  const current = { ...policy, limits };
  for (const [verb, params] of [
    ["send", { beeId: "parent", body: "x".repeat(CELL_GATEWAY_LIMITS.bodyBytes + 1) }],
    ["question.ask", { text: "x".repeat(CELL_GATEWAY_LIMITS.textBytes + 1) }],
    ["question.ask", { text: "ok", options: Array(33).fill("ok") }],
    ["question.ask", { text: "ok", options: ["x".repeat(257)] }],
    ["seal.create", { title: "x".repeat(513) }],
    ["seal.create", { title: "ok", refs: Array(33).fill("ok") }],
    ["seal.create", { title: "ok", refs: ["x".repeat(1025)] }],
  ] as const) {
    assert.throws(() => authorizeCellGateway(current, peer, verb, params, undefined), error => error instanceof RpcError && error.code === "cell_gateway_payload_too_large");
  }
  for (const [verb, maximum, params] of [["send", 60, { beeId: "parent", body: "ok" }], ["question.ask", 12, { text: "ok" }], ["seal.create", 12, { title: "ok" }]] as const) {
    for (let count = 0; count < maximum; count++) authorizeCellGateway(current, peer, verb, params, undefined);
    assert.throws(() => authorizeCellGateway({ ...current, identity: { beeId: "self", generation: 4 } }, peer, verb, params, undefined), error => error instanceof RpcError && error.code === "cell_gateway_rate_limited");
  }
  now = 60_000;
  assert.doesNotThrow(() => authorizeCellGateway(current, peer, "send", { beeId: "parent", body: "ok" }, undefined));
});

test("Cell CLI target takes precedence over explicit sockets and never resolves the real socket", () => {
  const root = mkdtempSync(join(tmpdir(), "hb-gt-"));
  try {
    const target = resolveDaemonTarget({ dataDirFlag: root, socketFlag: "/forbidden-real.sock" }, { HIVE_CELL_GATEWAY_SOCKET: "/run/honeybee/gateway.sock", HIVE_V2_SOCKET_PATH: "/another.sock" });
    assert.equal(target.cfg.socketPath, "/run/honeybee/gateway.sock");
    assert.equal(target.socketSource, "env");
    for (const value of ["", "relative", "/bad\0path"]) {
      assert.throws(() => resolveDaemonTarget({ dataDirFlag: root }, { HIVE_CELL_GATEWAY_SOCKET: value }), /Invalid Cell gateway/);
    }
  } finally { trash(root); }
});

test("native gateway refuses same-uid outsiders and admits a real runtime descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-ga-"));
  const store = openCoreStore(join(root, "fixture.sqlite"));
  const daemon = new HiveDaemon(loadNodeConfig(root));
  const internal = daemon as unknown as { store: typeof store; cellGateway(id: string, generation: number): { socketPath: string }; cellGateways: Map<string, { server: RpcServer }>; cellGatewaySweep: NodeJS.Timeout | null };
  internal.store = store;
  const { bee, runtime } = store.createBee({ name: "ancestry", agent: "stub", substrate: "cell", cwd: root });
  const clientScript = `const {RpcClient}=await import(process.argv[1]); const c=await RpcClient.connect(process.argv[2]); try { const r=await c.request('view',{}); console.log(JSON.stringify({beeId:r.bee.id})); } finally {c.close();}`;
  const runtimeScript = `import {spawn} from 'node:child_process'; process.on('message',message=>{ const child=spawn(process.execPath,['--input-type=module','-e',message.code,message.client,message.socket],{stdio:['ignore','pipe','pipe']}); let out='',err=''; child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('exit',code=>process.send({code,out,err})); });process.send('ready');`;
  const ownedRuntime = spawn(process.execPath, ["--input-type=module", "-e", runtimeScript], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let outsider: RpcClient | undefined;
  try {
    await once(ownedRuntime, "message");
    const identity = inspectProcess(ownedRuntime.pid!);
    assert.equal(identity.kind, "present");
    if (identity.kind !== "present") throw new Error("fixture runtime identity unavailable");
    store.recordRuntimeProc(bee.id, runtime.generation, { pid: identity.pid, pidStartedAt: identity.startedAtMs, processIdentity: { pid: identity.pid, birth: identity.birth, bootId: identity.bootId } });
    const gateway = internal.cellGateway(bee.id, runtime.generation);
    outsider = await RpcClient.connect(gateway.socketPath);
    await assert.rejects(outsider.request("view", {}), error => error instanceof RpcError && error.code === "caller_not_trusted");
    const response = once(ownedRuntime, "message");
    ownedRuntime.send!({ code: clientScript, client: new URL("../../cli/src/client.ts", import.meta.url).href, socket: gateway.socketPath });
    const [result] = await response as [{ code: number; out: string; err: string }];
    assert.equal(result.code, 0, result.err);
    assert.equal(JSON.parse(result.out).beeId, bee.id);
  } finally {
    outsider?.close();
    const exited = once(ownedRuntime, "exit");
    ownedRuntime.kill("SIGTERM");
    await exited;
    if (internal.cellGatewaySweep) clearInterval(internal.cellGatewaySweep);
    await Promise.all([...internal.cellGateways.values()].map(item => item.server.close()));
    store.close();
    trash(root);
  }
});
