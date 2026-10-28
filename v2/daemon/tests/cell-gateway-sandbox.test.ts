import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { sandboxEnvironment, wrapWithSandbox } from "../../driver-cell/src/sandbox.ts";
import { inspectProcess } from "../../harness/src/processIdentity.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { RpcServer } from "../src/rpc.ts";

test("joint Cell gateway and launcher fixture allows self, masks host sockets and refuses escapes", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hb-gjoint-"));
  const cellDir = join(root, "cell");
  mkdirSync(cellDir);
  const store = openCoreStore(join(root, "fixture.sqlite"));
  const config = loadNodeConfig(root);
  const daemon = new HiveDaemon(config);
  const internal = daemon as unknown as { store: typeof store; cellGateway(id: string, generation: number): { socketPath: string }; cellGateways: Map<string, { server: RpcServer }>; cellGatewaySweep: NodeJS.Timeout | null };
  internal.store = store;
  const inbox = store.createBee({ name: "inbox-parent", agent: "inbox", substrate: "hsr", cwd: root }).bee;
  const { bee, runtime } = store.createBee({ name: "confined-self", agent: "stub", substrate: "cell", cwd: cellDir, parentId: inbox.id });
  const gateway = internal.cellGateway(bee.id, runtime.generation);
  const main = new RpcServer({ socketPath: config.socketPath, dataDir: root, log() {}, dispatch() { assert.fail("confined fixture reached the host daemon"); } });
  main.listenFresh();
  const probe = join(cellDir, "probe.mjs");
  const ready = join(cellDir, "ready");
  const script = `
import {createConnection} from 'node:net';
import {existsSync,lstatSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const rpc=(verb,params)=>new Promise((resolve,reject)=>{
 const socket=createConnection('/run/honeybee/gateway.sock');let buffer='',hello=false;
 socket.setEncoding('utf8');socket.on('error',reject);
 socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const frame=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(!hello){hello=true;socket.write(JSON.stringify({protocol:frame.protocol})+'\\n'+JSON.stringify({id:1,verb,params})+'\\n');}else if(frame.id===1){socket.end();resolve(frame);}}});
});
const until=Date.now()+10000;while(!existsSync(${JSON.stringify(ready)})){if(Date.now()>until)throw Error('fixture identity was not bound');await new Promise(r=>setTimeout(r,10));}
const self=await rpc('view',{beeId:${JSON.stringify(bee.id)}});
const other=await rpc('view',{beeId:${JSON.stringify(inbox.id)}});
const cwd=await rpc('spawn',{agent:'stub',cwd:'/tmp'});
const inbox=await rpc('send',{beeId:${JSON.stringify(inbox.id)},body:'must not forward'});
const missing=path=>{try{lstatSync(path);return 'VISIBLE';}catch(error){return error.code;}};
const cli=spawnSync('/run/honeybee/bin/hive',['view',${JSON.stringify(bee.id)},'--json','--data-dir',${JSON.stringify(root)}],{encoding:'utf8',timeout:10000});
console.log(JSON.stringify({self:self.ok&&self.result.bee.id,other:other.error?.code,cwd:cwd.error?.code,inbox:inbox.error?.code,hostSocket:missing(${JSON.stringify(config.socketPath)}),liveSocket:missing(${JSON.stringify(join(homedir(), ".hive/v2/hived.sock"))}),store:missing(${JSON.stringify(join(root, "fixture.sqlite"))}),sharedLogs:missing(${JSON.stringify(config.sessionLogDir)}),gateway:lstatSync('/run/honeybee/gateway.sock').isSocket(),gatewayEnv:process.env.HIVE_CELL_GATEWAY_SOCKET,cliCode:cli.status,cliOut:cli.stdout,cliError:cli.stderr}));
`;
  writeFileSync(probe, script);
  const policy = { cellDir, writablePaths: [], gatewaySocketPath: gateway.socketPath };
  assert.throws(() => wrapWithSandbox({ ...policy, gatewaySocketPath: undefined }, process.execPath, [probe], join(cellDir, "sandbox.sb")), /gateway is required/);
  assert.throws(() => wrapWithSandbox({ ...policy, gatewaySocketPath: join(root, "missing.sock") }, process.execPath, [probe], join(cellDir, "sandbox.sb")), /gateway is missing or unsafe/);
  const wrapped = wrapWithSandbox(policy, process.execPath, [probe], join(cellDir, "sandbox.sb"));
  const child = spawn(wrapped.command, wrapped.args, { cwd: cellDir, env: sandboxEnvironment(cellDir, process.env as Record<string, string>), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const finished = once(child, "close");
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20_000);
  try {
    await once(child, "spawn");
    const identity = inspectProcess(child.pid!);
    assert.equal(identity.kind, "present", "fixture launcher identity must be bound before requests");
    if (identity.kind !== "present") throw new Error("fixture launcher identity unavailable");
    store.recordRuntimeProc(bee.id, runtime.generation, { pid: identity.pid, pidStartedAt: identity.startedAtMs, processIdentity: { pid: identity.pid, birth: identity.birth, bootId: identity.bootId } });
    writeFileSync(ready, "ready");
    const [code] = await finished;
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout.trim());
    assert.equal(result.self, bee.id);
    for (const key of ["other", "cwd", "inbox"]) assert.equal(result[key], "caller_not_trusted", key);
    for (const key of ["hostSocket", "liveSocket", "store", "sharedLogs"]) assert.equal(result[key], "ENOENT", key);
    assert.equal(result.gateway, true);
    assert.equal(result.gatewayEnv, "/run/honeybee/gateway.sock");
    assert.equal(result.cliCode, 0, result.cliError);
    assert.equal(JSON.parse(result.cliOut).bee.id, bee.id);
    assert.equal(store.listMessages(inbox.id).length, 0);
    console.log(JSON.stringify({ fixture: "joint-gateway-launcher", passed: true, self: true, other: result.other, cwdSpawn: result.cwd, inboxForward: result.inbox, hostSocket: result.hostSocket, liveSocket: result.liveSocket, store: result.store, sharedLogs: result.sharedLogs, gateway: result.gateway, cli: true, missingGateway: "refused" }));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await finished; }
    if (internal.cellGatewaySweep) clearInterval(internal.cellGatewaySweep);
    await Promise.all([...internal.cellGateways.values()].map(item => item.server.close()));
    await main.close();
    store.close();
    const trash = join(tmpdir(), "honeybee-test-trash");
    mkdirSync(trash, { recursive: true });
    renameSync(root, join(trash, root.split("/").at(-1)!));
  }
});
