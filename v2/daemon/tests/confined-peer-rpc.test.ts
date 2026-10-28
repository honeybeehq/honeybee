import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { localTrustMessage } from "../src/localRpcTrust.ts";
import { fileURLToPath } from "node:url";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";
import type { SpawnResult, HealthResult } from "../src/protocol.ts";

const exec = promisify(execFile);
test("real unshare peer is refused by a disposable daemon while host CLI still spawns", {skip: process.platform !== "linux", timeout: 60000}, async t => {
  const rig = makeDaemonDir({nodeKind: "satellite", cells: {sandbox: true}});
  const keyFile = join(rig.dir, "rpc-private", "registration.key");
  const configPath = join(rig.dir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.rpcLocalTrust = {requireObservationCaller: true, registrationKeyFile: keyFile};
  const harness = join(rig.dir, "confined.mjs");
  config.agents.confined = {command: process.execPath, args: [harness], adapter: "stub"};
  writeFileSync(configPath, JSON.stringify(config));
  const daemon = await startDaemon(rig.dir);
  t.after(() => daemon.stop());
  const client = await daemon.client();
  t.after(() => client.close());
  const health = await client.request<HealthResult>("health", {});
  assert.equal(health.confinement?.strict, false);
  for (const lane of ["remote", "node_relay"] as const) {
    const relay = await (await import("../../cli/src/client.ts")).RpcClient.connect(daemon.socketPath, 3000, lane);
    try { assert.equal((await relay.request<HealthResult>("health", {})).confinement?.strict, false); }
    finally { relay.close(); }
  }
  for (const params of [{substrate: "hsr"}, {substrate: "tmux"}, {cwd: rig.dir}]) {
    const result = await client.request<SpawnResult>("spawn", {name: `host-${Math.random()}`, agent: "stub", account: null, cwd: rig.dir, ...params});
    assert.equal(typeof result.commandId, "number");
  }
  const module = fileURLToPath(new URL("../../cli/src/client.ts", import.meta.url));
  const script = `import {RpcClient} from ${JSON.stringify(module)};
const c = await RpcClient.connect(${JSON.stringify(daemon.socketPath)});
try {
 const requests = [
  ['spawn',{name:'escape',agent:'stub'}],
  ['spawn',{name:'escape',agent:'stub',substrate:'hsr'}],
  ['spawn',{name:'escape',agent:'stub',substrate:'tmux'}],
  ['spawn',{name:'escape',agent:'stub',substrate:'cell',cell:{sandbox:false}}],
  ['spawn',{name:'escape',agent:'stub',substrate:'cell',cwd:'/tmp'}],
  ['spawn',{name:'escape',agent:'stub',substrate:'cell',node:'other'}],
  ['rpc.localTrust.challenge',{}], ['rpc.localTrust.register',{}],
  ['account.lease.export',{}], ['account.credentials.status',{}]
 ];
 const codes = [];
 for (const [verb,params] of requests) {try {await c.request(verb,params); codes.push('ALLOWED');} catch(e) {codes.push(e.code);}}
 let inbox; try {await c.request('spawn',{name:'safe-inbox',agent:'inbox'}); inbox = 'ALLOWED';} catch(e) {inbox = e.code;}
 console.log(JSON.stringify({codes,inbox}));
} finally {c.close();}`;
  const {stdout} = await exec("unshare", ["-U", process.execPath, "--input-type=module", "-e", script], {timeout: 20000});
  const result = JSON.parse(stdout);
  assert.deepEqual(result.codes, Array(10).fill("confined_peer_refused"));
  assert.equal(result.inbox, "confined_peer_refused");
  const challenge = await client.request<import("../src/localRpcTrust.ts").LocalTrustChallenge>("rpc.localTrust.challenge", {});
  const secret = readFileSync(keyFile);
  const token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex");
  secret.fill(0);
  await client.request("rpc.localTrust.register", {pid: process.pid, challengeId: challenge.challengeId, token});
  const parent = await client.request<SpawnResult>("spawn", {name: "trusted-parent", agent: "stub", cwd: rig.dir, account: null});
  const output = join(rig.dir, "confined-output.json");
  const ownScript = `import {RpcClient} from ${JSON.stringify(module)};
const c = await RpcClient.connect(${JSON.stringify(daemon.socketPath)});
const results = {};
try {
 for (const [name,verb,params,context] of [
  ['own','view',{}], ['list','list',{}],
  ['question','question.ask',{text:'test?',options:['yes','no']}],
  ['seal','seal.create',{title:'test seal',body:'fixture'}],
  ['send','send',{beeId:${JSON.stringify(parent.beeId)},body:'child receipt',urgency:'now'}],
  ['foreign','view',{beeId:${JSON.stringify(parent.beeId)}}],
  ['thread','thread.transcript',{operationId:'other'}],
  ['transcript','bee.transcript',{}], ['fork','bee.fork',{}],
  ['context','view',{}, {sessionPrincipal:{beeId:${JSON.stringify(parent.beeId)}}}]
 ]) {try {results[name] = await c.request(verb,params,5000,context);} catch(e) {results[name] = e.code;}}
 console.log(JSON.stringify(results));
} finally {c.close();}`;
  writeFileSync(harness, `import {createInterface} from 'node:readline';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
console.log(JSON.stringify({event:'ready',sessionId:'confined-'+process.pid}));
createInterface({input:process.stdin}).on('line', line => {
 const msg=JSON.parse(line); if(msg.type!=='message') return;
 console.log(JSON.stringify({event:'turn_started',messageId:msg.id}));
 const result=spawnSync('unshare',['-U',${JSON.stringify(process.execPath)},'--input-type=module','-e',${JSON.stringify(ownScript)}],{encoding:'utf8',timeout:15000});
 writeFileSync(${JSON.stringify(output)},JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr}));
 console.log(JSON.stringify({event:'turn_ended',messageId:msg.id,ok:true}));
});`);
  const child = await client.request<SpawnResult>("spawn", {name: "confined-child", agent: "confined", cwd: rig.dir, account: null, parentId: parent.beeId});
  await waitFor(async () => {
    const view = await client.request<{runtime:{state:string}}>("view", {beeId:child.beeId});
    return view.runtime?.state === "idle" || view.runtime?.state === "running";
  }, "child boot", 10000);
  await client.request("send", {beeId: child.beeId, body: "probe"});
  await waitFor(() => existsSync(output), "confined child receipt", 20000);
  const receipt = JSON.parse(readFileSync(output,"utf8"));
  assert.equal(receipt.status, 0, receipt.stderr);
  const own = JSON.parse(receipt.stdout);
  assert.equal(own.own.bee.id, child.beeId);
  assert.deepEqual(own.list.views.map((row: {bee:{id:string}}) => row.bee.id), [child.beeId]);
  assert.equal(own.question.question.beeId, child.beeId);
  assert.equal(own.seal.seal.beeId, child.beeId);
  assert.equal(typeof own.send.messageId, "number");
  for (const key of ["foreign", "thread", "fork", "context"]) assert.equal(own[key], "confined_peer_refused");
  assert.equal(own.transcript, "confined_peer_refused");

});

test("strict host with trust disabled cannot treat an unattributed host peer as registered", {skip: process.platform !== "linux", timeout: 30000}, async t => {
  const rig = makeDaemonDir({cells: {sandbox: false}});
  const daemon = await startDaemon(rig.dir);
  t.after(() => daemon.stop());
  const client = await daemon.client();
  t.after(() => client.close());
  for (const [verb, params] of [["spawn", {name:"escape",agent:"inbox"}], ["rpc.localTrust.challenge", {}], ["account.lease.export", {}], ["account.credentials.status", {}], ["health", {}]] as const) {
    await assert.rejects(client.request(verb as "spawn", params), error => (error as {code:string}).code === "confined_peer_refused");
  }
  for (const lane of ["remote", "node_relay"] as const) {
    const relay = await (await import("../../cli/src/client.ts")).RpcClient.connect(daemon.socketPath, 3000, lane);
    try { await assert.rejects(relay.request("health", {}), error => (error as {code:string}).code === "confined_peer_refused"); }
    finally { relay.close(); }
  }
  assert.match(readFileSync(join(rig.dir, "hived.log"), "utf8"), /security\.confinement strict=true/);
});

for (const mode of ["degraded", "lookup_failed"] as const) test(`missing Linux peer credentials fail closed with a diagnostic error: ${mode}`, {skip: process.platform !== "linux"}, async t => {
  const {mkdtempSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const {RpcServer} = await import("../src/rpc.ts");
  const {PeerCredentials} = await import("../src/peerCredentials.ts");
  const {RpcClient} = await import("../../cli/src/client.ts");
  const dir = mkdtempSync(join(tmpdir(), "hb-confined-degraded-"));
  const socketPath = join(dir, "rpc.sock");
  const peerCredentials = new PeerCredentials({load: () => {
    if (mode === "degraded") throw new Error("fixture unavailable");
    return {inspect: () => null, pin: () => -1, alive: () => true};
  }});
  let dispatched = false;
  const server = new RpcServer({socketPath, peerCredentials, peerConfinement: () => "confined", log: () => {}, dispatch: () => {dispatched = true;}});
  await server.listen();
  t.after(() => server.close());
  const client = await RpcClient.connect(socketPath);
  t.after(() => client.close());
  for (const verb of ["health", "spawn", "rpc.localTrust.challenge"] as const) await assert.rejects(client.request(verb, {}), error => (error as {code:string}).code === "local_peer_credentials_unavailable");
  assert.equal(dispatched, false);
});
