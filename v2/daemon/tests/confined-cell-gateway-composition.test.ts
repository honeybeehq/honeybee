import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/index.ts";
import { sandboxEnvironment, wrapWithSandbox } from "../../driver-cell/src/sandbox.ts";
import { inspectProcess } from "../../harness/src/processIdentity.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";
import { randomBytes } from "node:crypto";
import { peerConfinement } from "../src/confinedPeer.ts";
import type { LocalPeer } from "../src/peerCredentials.ts";
import { RpcServer, type RpcConn } from "../src/rpc.ts";
import type { BeeRow } from "../../core/src/index.ts";
import type { AgentSpecConfig } from "../src/config.ts";
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
    runtimeEnvOf(bee: BeeRow, spec: AgentSpecConfig, label: string): Record<string, string>;
  };
  internal.store = store;
  const parent = store.createBee({name: "parent", agent: "stub", substrate: "hsr", cwd: root}).bee;
  const inbox = store.createBee({name: "inbox", agent: "inbox", substrate: "hsr", cwd: root}).bee;
  const {bee, runtime} = store.createBee({name: "self", agent: "stub", substrate: "cell", cwd: cellDir, parentId: parent.id, sessionLogPath: ownLog});
  const gateway = internal.cellGateway(bee.id, runtime.generation);
  const hostXdg = join(root,"host-home","xdg");
  mkdirSync(hostXdg,{recursive:true});
  writeFileSync(join(hostXdg,"host-only"),"fixture");
  const worktree = join(cellDir,"worktree");
  mkdirSync(worktree);
  execFileSync("git",["init","-q",worktree],{env:{PATH:process.env.PATH,HOME:cellDir,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_SYSTEM:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"},stdio:"ignore"});
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
import {spawnSync} from 'node:child_process';
const rpc=(path,verb,params,context)=>new Promise((resolve,reject)=>{
 const socket=createConnection(path);let buffer='',hello=false;
 socket.setEncoding('utf8');socket.on('error',reject);
 socket.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\\n'))>=0){const frame=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);if(!hello){hello=true;socket.write(JSON.stringify({protocol:frame.protocol})+'\\n'+JSON.stringify({id:1,verb,params,...(context===undefined?{}:{context})})+'\\n');}else if(frame.id===1){socket.end();resolve(frame);}}});
});
const deadline=Date.now()+10000;while(!existsSync(${JSON.stringify(ready)})){if(Date.now()>deadline)throw Error('identity not bound');await new Promise(r=>setTimeout(r,10));}
const hostRoutes=['HIVE_SOCKET','HIVE_DATA_DIR','HIVE_V2_SOCKET_PATH','HIVE_V2_DATA_DIR','HIVE_TMUX_SOCKET','HIVE_TMUX_SOCKET_PATH'];
const gitNames=['GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL'];
const deniedAmbient=['GIT_CONFIG','GIT_CONFIG_GLOBAL','GIT_CONFIG_SYSTEM','GIT_CONFIG_PARAMETERS','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_SSH','GIT_SSH_COMMAND','GIT_ASKPASS','GIT_DIR','SSH_AUTH_SOCK','SSH_AGENT_PID','SSH_CONNECTION','SESSION_TOKEN'];
const results={onlyGitIdentity:Object.keys(process.env).filter(name=>name.startsWith('GIT_')).every(name=>gitNames.includes(name)),ambientControlsAbsent:deniedAmbient.every(name=>!Object.hasOwn(process.env,name)),explicitXdgPreserved:process.env.XDG_CONFIG_HOME===${JSON.stringify(hostXdg)},hostXdgAbsent:!existsSync(process.env.XDG_CONFIG_HOME),pid:process.pid,canaryAbsent:!Object.hasOwn(process.env,'T11J_CANARY_SECRET'),identity:process.env.HIVE_BEE_ID===${JSON.stringify(bee.id)},explicitEnv:['APIARY_GATEWAY_URL','APIARY_SESSION_ID','APIARY_AGENT_TOKEN','OPENAI_API_KEY'].every(name=>Object.hasOwn(process.env,name)),hostRoutesAbsent:hostRoutes.every(name=>!Object.hasOwn(process.env,name)),gatewayOnly:process.env.HIVE_CELL_GATEWAY_SOCKET==='/run/honeybee/gateway.sock',privateHome:process.env.HOME?.startsWith(${JSON.stringify(cellDir)}+'/sandbox-state/')};
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
const commit=spawnSync('git',['-C',${JSON.stringify(worktree)},'commit','--allow-empty','-qm','fixture env identity'],{stdio:'ignore',timeout:10000});
const gitIdentity=spawnSync('git',['-C',${JSON.stringify(worktree)},'show','-s','--format=%an%n%ae%n%cn%n%ce','HEAD'],{encoding:'utf8',timeout:10000});
results.gitIdentity=commit.status===0&&gitIdentity.status===0&&gitIdentity.stdout.trim()==='fixture-author\\nfixture-author@example.invalid\\nfixture-committer\\nfixture-committer@example.invalid';
const cli=spawnSync('/run/honeybee/bin/hive',['transcript',${JSON.stringify(bee.id)},'--raw','--json','--socket','/run/honeybee/test-hived.sock'],{encoding:'utf8',timeout:10000});
results.cliGatewayOnly=cli.status===0&&JSON.parse(cli.stdout).lines[0]==='own fixture transcript';
console.log(JSON.stringify(results));
`);
  const wrapped = wrapWithSandbox({cellDir, writablePaths: [], gatewaySocketPath: gateway.socketPath, protectedPaths: [root]}, process.execPath, [probe], join(cellDir, "sandbox.sb"));
  const separator = wrapped.args.findIndex((value, index) => value === "--remount-ro" && wrapped.args[index + 1] === "/run");
  assert.ok(separator >= 0);
  wrapped.args.splice(separator, 0, "--ro-bind", config.socketPath, "/run/honeybee/test-hived.sock");
  const inheritedFixture = {T11J_CANARY_SECRET:randomBytes(24).toString("hex"),GIT_AUTHOR_NAME:"fixture-author",GIT_AUTHOR_EMAIL:"fixture-author@example.invalid",GIT_COMMITTER_NAME:"fixture-committer",GIT_COMMITTER_EMAIL:"fixture-committer@example.invalid",GIT_CONFIG_GLOBAL:"fixture-forbidden",GIT_SSH_COMMAND:"fixture-forbidden",GIT_ASKPASS:"fixture-forbidden",GIT_DIR:"fixture-forbidden",SSH_AUTH_SOCK:"fixture-forbidden",SESSION_TOKEN:"fixture-forbidden"};
  const saved = Object.fromEntries(Object.keys(inheritedFixture).map(name=>[name,process.env[name]]));
  Object.assign(process.env,inheritedFixture);
  let env: Record<string,string>;
  try {
    env = internal.runtimeEnvOf(bee,{command:process.execPath,env:{APIARY_GATEWAY_URL:"fixture",APIARY_SESSION_ID:"fixture",APIARY_AGENT_TOKEN:"fixture",OPENAI_API_KEY:"fixture",HIVE_V2_SOCKET_PATH:config.socketPath,XDG_CONFIG_HOME:hostXdg}},"fixture");
  } finally {for(const[name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
  const child = spawn(wrapped.command, wrapped.args, {cwd: cellDir, env: sandboxEnvironment(cellDir, env), stdio: ["ignore", "pipe", "pipe"]});
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
    for (const name of ["canaryAbsent","identity","explicitEnv","hostRoutesAbsent","gatewayOnly","privateHome","cliGatewayOnly","explicitXdgPreserved","hostXdgAbsent","gitIdentity","onlyGitIdentity","ambientControlsAbsent"]) assert.equal(result[name],true,name);
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
    console.log(JSON.stringify({fixture: "same-cell-hived5-gateway6", customRoot, sameProcess: true, hivedAllowed: 5, gatewayAllowed: 6, transcriptHived: "confined_peer_refused", transcriptGateway: true, privilegedDeniedBoth: true, envCanaryAbsent: true, hostEnvRoutesAbsent: true, explicitEnvPreserved: true, gitIdentity: true, onlyGitIdentity: true, ambientControlsAbsent: true, explicitXdgNotBound: true, privateHome: true, passed: true}));
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
