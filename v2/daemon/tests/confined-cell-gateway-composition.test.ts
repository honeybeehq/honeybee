import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { sandboxEnvironment, wrapWithSandbox } from "../../driver-cell/src/sandbox.ts";
import { inspectProcess } from "../../harness/src/processIdentity.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { peerConfinement } from "../src/confinedPeer.ts";
import type { LocalPeer } from "../src/peerCredentials.ts";
import { RpcServer, type RpcConn } from "../src/rpc.ts";
import type { RpcVerb } from "../src/protocol.ts";

test("same sandboxed Cell preserves the raw hived five verbs and gateway six verbs", {skip: process.platform !== "linux", timeout: 30000}, async () => {
  const customRoot = process.env.HIVE_TEST_GATEWAY_CUSTOM_ROOT === "1";
  const root = mkdtempSync(join(customRoot ? "/mnt" : tmpdir(), "hb-dual-"));
  const cellDir = join(root, "cell");
  mkdirSync(cellDir);
  const store = openCoreStore(join(root, "fixture.sqlite"));
  const config = loadNodeConfig(root);
  mkdirSync(config.sessionLogDir);
  const ownLog = join(config.sessionLogDir, "own.jsonl");
  writeFileSync(ownLog, "own fixture transcript\n");
  const daemon = new HiveDaemon(config);
  const internal = daemon as unknown as {
    store: typeof store;
    cellGateway(id: string, generation: number): {socketPath: string};
    cellGateways: Map<string, {server: RpcServer}>;
    cellGatewaySweep: NodeJS.Timeout | null;
    spawnPeerBee(peer: LocalPeer): string | null;
    admitConfined(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): Record<string, unknown>;
    dispatch(verb: RpcVerb, params: Record<string, unknown>, conn: RpcConn): unknown;
  };
  internal.store = store;
  const parent = store.createBee({name: "parent", agent: "stub", substrate: "hsr", cwd: root}).bee;
  const inbox = store.createBee({name: "inbox", agent: "inbox", substrate: "hsr", cwd: root}).bee;
  const {bee, runtime} = store.createBee({name: "self", agent: "stub", substrate: "cell", cwd: cellDir, parentId: parent.id, sessionLogPath: ownLog});
  const gateway = internal.cellGateway(bee.id, runtime.generation);
  const main = new RpcServer({
    socketPath: config.socketPath, dataDir: root, log() {},
    peerConfinement: (peer, registered) => peerConfinement(peer, {registered, substrate: () => {
      const id = peer ? internal.spawnPeerBee(peer) : null;
      return id ? store.getBee(id)?.substrate ?? null : null;
    }}),
    admitConfined: (verb, params, conn) => internal.admitConfined(verb, params, conn),
    dispatch: (verb, params, conn) => internal.dispatch(verb, params, conn),
  });
  main.listenFresh();
  const ready = join(cellDir, "ready");
  const probe = join(cellDir, "probe.mjs");
  writeFileSync(probe, `
import {createConnection} from 'node:net';
import {existsSync} from 'node:fs';
const rpc=(path,verb,params,context)=>new Promise((resolve,reject)=>{
 const socket=createConnection(path);let buffer='',hello=false;
 socket.setEncoding('utf8');socket.on('error',reject);
 socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const frame=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(!hello){hello=true;socket.write(JSON.stringify({protocol:frame.protocol})+'\\n'+JSON.stringify({id:1,verb,params,...(context===undefined?{}:{context})})+'\\n');}else if(frame.id===1){socket.end();resolve(frame);}}});
});
const deadline=Date.now()+10000;while(!existsSync(${JSON.stringify(ready)})){if(Date.now()>deadline)throw Error('identity not bound');await new Promise(r=>setTimeout(r,10));}
const results={pid:process.pid};
for(const [name,path] of [['hived','/run/honeybee/test-hived.sock'],['gateway','/run/honeybee/gateway.sock']]){
 const rows={};
 for(const [label,verb,params,context] of [
  ['view','view',{}],['list','list',{}],
  ['ask','question.ask',{text:'fixture question?',options:['yes','no']}],
  ['seal','seal.create',{title:'fixture seal',body:'fixture evidence'}],
  ['send','send',{beeId:${JSON.stringify(parent.id)},body:name+' receipt',urgency:'now'}],
  ['transcript','bee.transcript',{}],
  ['foreign','view',{beeId:${JSON.stringify(inbox.id)}}],
  ['inbox','send',{beeId:${JSON.stringify(inbox.id)},body:'must not forward'}],
  ['spawn','spawn',{name:'escape',agent:'stub',substrate:'hsr',cwd:'/tmp'}],
  ['cellSpawn','spawn',{name:'escape',agent:'stub',substrate:'cell'}],
  ['revive','revive',{beeId:${JSON.stringify(parent.id)}}],
  ['cellExec','cell.exec',{cellId:'other',argv:['true']}],
  ['credentials','account.credentials.status',{}],
  ['service','rpc.localTrust.challenge',{}],
  ['thread','thread.transcript',{operationId:'foreign'}],
  ['context','view',{}, {sessionPrincipal:{beeId:${JSON.stringify(inbox.id)}}}]
 ]) rows[label]=await rpc(path,verb,params,context);
 results[name]=rows;
}
console.log(JSON.stringify(results));
`);
  const wrapped = wrapWithSandbox({cellDir, writablePaths: [], gatewaySocketPath: gateway.socketPath, protectedPaths: [root]}, process.execPath, [probe], join(cellDir, "sandbox.sb"));
  const separator = wrapped.args.findIndex((value, index) => value === "--remount-ro" && wrapped.args[index + 1] === "/run");
  assert.ok(separator >= 0);
  wrapped.args.splice(separator, 0, "--ro-bind", config.socketPath, "/run/honeybee/test-hived.sock");
  const child = spawn(wrapped.command, wrapped.args, {cwd: cellDir, env: sandboxEnvironment(cellDir, process.env as Record<string, string>), stdio: ["ignore", "pipe", "pipe"]});
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => {stdout += chunk;});
  child.stderr.on("data", chunk => {stderr += chunk;});
  const finished = new Promise<number | null>(resolve => child.once("close", resolve));
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20000);
  try {
    await once(child, "spawn");
    const identity = inspectProcess(child.pid!);
    assert.equal(identity.kind, "present");
    if (identity.kind !== "present") throw new Error("fixture identity unavailable");
    store.recordRuntimeProc(bee.id, runtime.generation, {pid: identity.pid, pidStartedAt: identity.startedAtMs, processIdentity: {pid: identity.pid, birth: identity.birth, bootId: identity.bootId}});
    writeFileSync(ready, "ready");
    assert.equal(await finished, 0, stderr);
    const result = JSON.parse(stdout.trim());
    assert.ok(Number.isSafeInteger(result.pid));
    for (const name of ["hived", "gateway"]) {
      const rows = result[name];
      for (const verb of ["view", "list", "ask", "seal", "send"]) assert.equal(rows[verb].ok, true, `${name}:${verb}`);
      assert.equal(rows.view.result.bee.id, bee.id);
      assert.deepEqual(rows.list.result.views.map((row: {bee: {id: string}}) => row.bee.id), [bee.id]);
      for (const verb of ["foreign", "inbox", "spawn", "cellSpawn", "revive", "cellExec", "credentials", "service", "thread", "context"]) {
        assert.equal(rows[verb].ok, false, `${name}:${verb}`);
        assert.equal(rows[verb].error.code, name === "hived" ? "confined_peer_refused" : "caller_not_trusted", `${name}:${verb}`);
      }
    }
    assert.equal(result.hived.transcript.ok, false);
    assert.equal(result.hived.transcript.error.code, "confined_peer_refused");
    assert.equal(result.gateway.transcript.ok, true);
    assert.equal(Buffer.from(result.gateway.transcript.result.bytesBase64, "base64").toString(), "own fixture transcript\n");
    const mail = store.listMessages(parent.id);
    assert.equal(mail.length, 2);
    assert.ok(mail.every(message => message.sender === bee.id && message.urgency === "next"));
    assert.equal(store.listMessages(inbox.id).length, 0);
    console.log(JSON.stringify({fixture: "same-cell-hived5-gateway6", customRoot, sameProcess: true, hivedAllowed: 5, gatewayAllowed: 6, transcriptHived: "confined_peer_refused", transcriptGateway: true, privilegedDeniedBoth: true, passed: true}));
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGTERM"); await finished;}
    if (internal.cellGatewaySweep) clearInterval(internal.cellGatewaySweep);
    await Promise.all([...internal.cellGateways.values()].map(value => value.server.close()));
    await main.close();
    store.close();
    const trash = join(customRoot ? "/mnt" : tmpdir(), "honeybee-test-trash");
    mkdirSync(trash, {recursive: true});
    renameSync(root, join(trash, root.split("/").at(-1)!));
  }
});
