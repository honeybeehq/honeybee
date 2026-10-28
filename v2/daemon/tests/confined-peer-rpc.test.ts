import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeDaemonDir, startDaemon } from "./helpers.ts";
import type { SpawnResult, HealthResult } from "../src/protocol.ts";

const exec = promisify(execFile);
test("real unshare peer is refused by a disposable daemon while host CLI still spawns", {skip: process.platform !== "linux", timeout: 60000}, async t => {
  const rig = makeDaemonDir({cells: {sandbox: true}});
  const daemon = await startDaemon(rig.dir);
  t.after(() => daemon.stop());
  const client = await daemon.client();
  t.after(() => client.close());
  const health = await client.request<HealthResult>("health", {});
  assert.equal(health.confinement?.strict, false);
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
 const inbox = await c.request('spawn',{name:'safe-inbox',agent:'inbox'});
 console.log(JSON.stringify({codes,inbox}));
} finally {c.close();}`;
  const {stdout} = await exec("unshare", ["-U", process.execPath, "--input-type=module", "-e", script], {timeout: 20000});
  const result = JSON.parse(stdout);
  assert.deepEqual(result.codes, [...Array(6).fill("confined_spawn_refused"), ...Array(4).fill("confined_peer_refused")]);
  assert.equal(result.inbox.commandId, null);
});
