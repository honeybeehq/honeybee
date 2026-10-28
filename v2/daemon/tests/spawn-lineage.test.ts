import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcError, type AuditTailResult, type SpawnResult, type ViewResult } from "../src/protocol.ts";
import { localTrustMessage, type LocalTrustChallenge } from "../src/localRpcTrust.ts";
import { makeDaemonDir, startDaemon, waitFor } from "./helpers.ts";

const cli = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
const rpcClientModule = fileURLToPath(new URL("../../cli/src/client.ts", import.meta.url));
const localTrustModule = fileURLToPath(new URL("../src/localRpcTrust.ts", import.meta.url));
const external = "15ecdadc-f4b1-4265-9fac-9516a5ada650";
interface Output { status: number | null; stdout: string; stderr: string }

test("spawn lineage: runtime ancestry, registered Apiary principal, and local operator", { timeout: 120_000 }, async t => {
  const rig = makeDaemonDir({cells: {sandbox: true}});
  const home = join(rig.dir, "home"), harness = join(rig.dir, "lineage.mjs");
  const readyFile = join(rig.dir, "ready");
  const detachedHelper = join(rig.dir, "detached.mjs");
  const intermediate = join(rig.dir, "intermediate.mjs");
  const keyFile = join(rig.dir, "rpc-private", "registration.key");
  mkdirSync(home);
  writeFileSync(harness, `
import {createInterface} from 'node:readline';
import {spawnSync} from 'node:child_process';
import {writeFileSync,existsSync,readFileSync} from 'node:fs';
import {createHmac} from 'node:crypto';
import {localTrustMessage} from ${JSON.stringify(localTrustModule)};
import {RpcClient} from ${JSON.stringify(rpcClientModule)};
const emit = value => console.log(JSON.stringify(value));
const ready = setInterval(() => { if (existsSync(${JSON.stringify(readyFile)})) { clearInterval(ready); emit({event:'ready',sessionId:'lineage-'+process.pid}); } }, 10);
createInterface({input:process.stdin}).on('line', async line => {
  const message = JSON.parse(line);
  if (message.type !== 'message') return;
  emit({event:'turn_started',messageId:message.id});
  const {args,output,rpc,detach} = JSON.parse(message.body);
  if (detach) {
    const result = spawnSync(process.execPath, [${JSON.stringify(intermediate)}, JSON.stringify({...detach,output,runtimePid:process.pid})], {env:process.env,encoding:'utf8',timeout:5000});
    if (result.status !== 0) writeFileSync(output,JSON.stringify({error:result.stderr}));
    emit({event:'turn_ended',messageId:message.id,ok:true}); return;
  }
  if (rpc) {
    const client = await RpcClient.connect(rpc.socket,3000,rpc.lane);
    try {
      let result;
      if (rpc.register) {
        const challenge = await client.request('rpc.localTrust.challenge');
        const secret = readFileSync(rpc.keyFile);
        const token = createHmac('sha256',secret).update(localTrustMessage(challenge)).digest('hex');
        secret.fill(0);
        result = await client.request('rpc.localTrust.register',{pid:process.pid,challengeId:challenge.challengeId,token});
      } else result = await client.request('spawn',rpc.params);
      writeFileSync(output, JSON.stringify({result}));
    }
    catch (error) { writeFileSync(output,JSON.stringify({code:error.code})); }
    finally { client.close(); }
    emit({event:'turn_ended',messageId:message.id,ok:true}); return;
  }
  const env = {...process.env};
  delete env.HIVE_BEE_ID; delete env.HIVE_PARENT_BEE_ID;
  const result = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...args], {env,encoding:'utf8',timeout:15000});
  writeFileSync(output, JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr}));
  emit({event:'turn_ended',messageId:message.id,ok:true});
});
`);
  writeFileSync(intermediate, `
import {spawn} from 'node:child_process';
const payload = JSON.parse(process.argv[2]);
const child = spawn(process.execPath, [${JSON.stringify(detachedHelper)}, JSON.stringify({...payload,intermediatePid:process.pid,intermediatePpid:process.ppid})], {detached:true,stdio:'ignore',env:process.env});
child.unref();
`);
  writeFileSync(detachedHelper, `
import {spawnSync} from 'node:child_process';
import {writeFileSync,renameSync,readFileSync} from 'node:fs';
import {RpcClient} from ${JSON.stringify(rpcClientModule)};
const payload = JSON.parse(process.argv[2]);
const initialPpid = process.ppid;
const deadline = Date.now()+5000;
while (process.ppid === payload.intermediatePid && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
const detachedPpid = process.ppid;
const ancestry = [];
let pid = process.pid;
for (let n=0; pid>1 && n<64; n++) {
  const stat = readFileSync('/proc/'+pid+'/stat','utf8');
  const ppid = Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
  ancestry.push({pid,ppid}); pid=ppid;
}
const env = {...process.env}; delete env.HIVE_BEE_ID; delete env.HIVE_PARENT_BEE_ID;
const outputs = payload.commands.map(args => {
  const result = spawnSync(process.execPath,[${JSON.stringify(cli)},...args],{env,encoding:'utf8',timeout:15000});
  return {status:result.status,stdout:result.stdout,stderr:result.stderr};
});
const client = await RpcClient.connect(payload.socket);
let rpc,defaultSpawn;
try { rpc = {result:await client.request('spawn',payload.params)}; }
catch(error) { rpc = {code:error.code}; }
try { defaultSpawn = {result:await client.request('spawn',{name:'detached-default',agent:'inbox'})}; }
catch(error) { defaultSpawn = {code:error.code}; }
finally { client.close(); }
writeFileSync(payload.output+'.pending',JSON.stringify({pid:process.pid,initialPpid,detachedPpid,intermediatePid:payload.intermediatePid,intermediatePpid:payload.intermediatePpid,runtimePid:payload.runtimePid,ancestry,outputs,rpc,defaultSpawn}));
renameSync(payload.output+'.pending',payload.output);
`);
  const configPath = join(rig.dir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  config.rpcLocalTrust = { requireObservationCaller: true, registrationKeyFile: keyFile };
  config.agents.lineage = { command: process.execPath, args: [harness], adapter: "stub" };
  writeFileSync(configPath, JSON.stringify(config));
  const daemon = await startDaemon(rig.dir, { env: { HOME: home } });
  const client = await daemon.client();
  t.after(async () => {
    client.close();
    await daemon.stop();
    const trash = join(rig.dir, "..", `.trash-lineage-${process.pid}-${Date.now()}`);
    renameSync(rig.dir, trash);
  });
  const parent = await client.request<SpawnResult>("spawn", { name: "runtime-parent", agent: "lineage", cwd: rig.dir });
  await t.test("unrelated default spawn is accepted while a runtime boots", async () => {
    await waitFor(async () => (await client.request<ViewResult>("view", { beeId: parent.beeId })).runtime?.state === "booting", "runtime booting");
    const child = await client.request<SpawnResult>("spawn", { name: "unrelated-during-boot", agent: "inbox" });
    assert.equal((await client.request<ViewResult>("view", { beeId: child.beeId })).bee?.parentId, null);
  });
  writeFileSync(readyFile, "ready");
  await waitFor(async () => {
    const view = await client.request<ViewResult>("view", { beeId: parent.beeId });
    return view.runtime?.state === "idle" || view.runtime?.state === "running";
  }, "parent runtime ready");
  const other = await client.request<SpawnResult>("spawn", { name: "other-parent", agent: "inbox", cwd: rig.dir });
  let sequence = 0;
  const args = (extra: string[]) => [...extra, "--data-dir", rig.dir, "--socket", daemon.socketPath, "--json"];
  async function runtimeCli(extra: string[]): Promise<Output> {
    const output = join(rig.dir, `cli-${++sequence}.json`);
    await client.request("send", { beeId: parent.beeId, body: JSON.stringify({ args: args(extra), output }) });
    await waitFor(() => existsSync(output), "runtime CLI receipt", 25_000);
    const result = JSON.parse(readFileSync(output, "utf8")) as Output;
    console.log(JSON.stringify({ caller: "runtime", argv: extra, ...result }));
    return result;
  }
  function operatorCli(extra: string[]): Output {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, HIVE_V2_DATA_DIR: rig.dir, HIVE_NO_KEYCHAIN: "1" };
    delete env.HIVE_BEE_ID;
    const result = spawnSync(process.execPath, [cli, ...args(extra)], { env, encoding: "utf8", timeout: 15_000 });
    const output = { status: result.status, stdout: result.stdout, stderr: result.stderr };
    console.log(JSON.stringify({ caller: "operator", argv: extra, ...output }));
    return output;
  }
  async function checkProvenance(beeId: string, authority: string, callerBeeId: string | null) {
    const { rows } = await client.request<AuditTailResult>("audit.tail", { beeId, limit: 100 });
    const row = rows.find(row => row.kind === "bee.created");
    assert.ok(row, "child creation audit exists");
    const provenance = row.payload.spawnProvenance as { authority: string; callerBeeId: string | null; peerPid: number };
    assert.equal(provenance?.authority, authority);
    assert.equal(provenance?.callerBeeId, callerBeeId);
    assert.ok(Number.isSafeInteger(provenance?.peerPid) && provenance.peerPid > 0);
  }
  async function check(output: Output, expected: string | null) {
    assert.equal(output.status, 0, output.stderr || output.stdout);
    const result = JSON.parse(output.stdout) as SpawnResult;
    const view = await client.request<ViewResult>("view", { beeId: result.beeId });
    assert.equal(view.bee?.parentId, expected);
    return result.beeId;
  }
  await t.test("runtime CLI defaults to its exact process ancestor", async () => {
    const childId = await check(await runtimeCli(["spawn", "default-child", "inbox"]), parent.beeId);
    await checkProvenance(childId, "bee", parent.beeId);
  });
  for (const flags of [["--parent", other.beeId], ["--no-parent"]]) {
    await t.test(`runtime CLI refuses ${flags[0]}`, async () => {
      const result = await runtimeCli(["spawn", `denied-${++sequence}`, "inbox", ...flags]);
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /caller_not_trusted/);
    });
  }
  await t.test("unregistered operator CLI allows defaults and refuses explicit lineage", async () => {
    await check(operatorCli(["spawn", "operator-default", "inbox"]), null);
    const outputs = [["--parent", other.beeId], ["--no-parent"]].map(flags => operatorCli(["spawn", `operator-denied-${++sequence}`, "inbox", ...flags]));
    for (const result of outputs) {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /caller_not_trusted/);
    }
  });
  await t.test("detached runtime descendant cannot acquire operator lineage authority", async () => {
    const output = join(rig.dir, "detached.json");
    await client.request("send", { beeId: parent.beeId, body: JSON.stringify({ output, detach: {
      commands: [["--parent", other.beeId], ["--no-parent"]].map((flags, index) => args(["spawn", `detached-${index}`, "inbox", ...flags])),
      socket: daemon.socketPath,
      params: { name: "detached-external", agent: "inbox", parentId: external, parentExternal: true },
    } }) });
    await waitFor(() => existsSync(output), "detached helper completed", 40_000);
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    console.log(JSON.stringify({ caller: "detached", ...receipt }));
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.intermediatePpid, receipt.runtimePid);
    assert.notEqual(receipt.detachedPpid, receipt.intermediatePid);
    assert.notEqual(receipt.detachedPpid, receipt.runtimePid);
    assert.ok(receipt.ancestry.length > 0);
    assert.ok(receipt.ancestry.every((row: { pid: number }) => row.pid !== receipt.runtimePid && row.pid !== receipt.intermediatePid));
    for (const result of receipt.outputs as Output[]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /caller_not_trusted/);
    }
    assert.equal(receipt.rpc.code, "caller_not_trusted");
    const defaultBeeId = receipt.defaultSpawn.result.beeId as string;
    assert.equal((await client.request<ViewResult>("view", { beeId: defaultBeeId })).bee?.parentId, null);
    await checkProvenance(defaultBeeId, "unattributed", null);
  });
  await t.test("runtime Unix RPC refuses an external parent", async () => {
    const output = join(rig.dir, "external-rpc.json");
    await client.request("send", { beeId: parent.beeId, body: JSON.stringify({ output, rpc: { socket: daemon.socketPath, params: { name: "runtime-external", agent: "inbox", parentId: external, parentExternal: true } } }) });
    await waitFor(() => existsSync(output), "runtime external RPC receipt");
    assert.equal(JSON.parse(readFileSync(output, "utf8")).code, "caller_not_trusted");
  });
  for (const lane of ["node_relay", "remote"] as const) {
    await t.test(`runtime cannot escape lineage by declaring ${lane}`, async () => {
      const output = join(rig.dir, `${lane}.json`);
      await client.request("send", { beeId: parent.beeId, body: JSON.stringify({ output, rpc: { socket: daemon.socketPath, lane, params: { name: `forged-${lane}`, agent: "inbox" } } }) });
      await waitFor(() => existsSync(output), "claimed relay lane receipt");
      assert.equal(JSON.parse(readFileSync(output, "utf8")).code, "caller_not_trusted");
    });
  }
  await t.test("runtime cannot register as a service even with the disposable fixture key", async () => {
    const output = join(rig.dir, "runtime-register.json");
    await client.request("send", { beeId: parent.beeId, body: JSON.stringify({ output, rpc: { socket: daemon.socketPath, register: true, keyFile } }) });
    await waitFor(() => existsSync(output), "runtime registration receipt");
    assert.equal(JSON.parse(readFileSync(output, "utf8")).code, "caller_not_trusted");
  });
  await t.test("plain operator RPC refuses an external parent", async () => {
    await assert.rejects(client.request("spawn", { name: "operator-external", agent: "inbox", parentId: external, parentExternal: true }), error => error instanceof RpcError && error.code === "caller_not_trusted");
  });
  await t.test("unregistered caller cannot assert an Apiary principal", async () => {
    await assert.rejects(client.request("spawn", { name: "forged-principal", agent: "inbox" }, 5000, { sessionPrincipal: { beeId: parent.beeId } }), error => error instanceof RpcError && error.code === "caller_not_trusted");
  });
  const challenge = await client.request<LocalTrustChallenge>("rpc.localTrust.challenge");
  const secret = readFileSync(keyFile);
  const token = createHmac("sha256", secret).update(localTrustMessage(challenge)).digest("hex");
  secret.fill(0);
  await client.request("rpc.localTrust.register", { pid: process.pid, challengeId: challenge.challengeId, token });
  const context = { sessionPrincipal: { beeId: parent.beeId } };
  await t.test("replay cannot borrow another authenticated parent's spawn", async () => {
    const params = { name: "replayed-child", agent: "inbox", idempotencyKey: "lineage-replay" };
    const first = await client.request<SpawnResult>("spawn", params, 5000, context);
    assert.equal((await client.request<SpawnResult>("spawn", params, 5000, context)).beeId, first.beeId);
    await assert.rejects(client.request("spawn", params, 5000, { sessionPrincipal: { beeId: other.beeId } }), error => error instanceof RpcError && error.code === "idempotency_conflict");
    await assert.rejects(client.request("spawn", { ...params, parentId: other.beeId }, 5000, context), error => error instanceof RpcError && error.code === "caller_not_trusted");
    await client.request("delete", { beeId: first.beeId });
    assert.equal((await client.request<SpawnResult>("spawn", params, 5000, context)).beeId, first.beeId);
    await assert.rejects(client.request("spawn", params, 5000, { sessionPrincipal: { beeId: other.beeId } }), error => error instanceof RpcError && error.code === "idempotency_conflict");
  });
  await t.test("registered service defaults forwarded principal and permits matching parent", async () => {
    for (const lineage of [{}, { parentId: parent.beeId }]) {
      const child = await client.request<SpawnResult>("spawn", { name: `forwarded-${++sequence}`, agent: "inbox", ...lineage }, 5000, context);
      assert.equal((await client.request<ViewResult>("view", { beeId: child.beeId })).bee?.parentId, parent.beeId);
      await checkProvenance(child.beeId, "bee", parent.beeId);
    }
  });
  for (const lineage of [{ parentId: other.beeId }, { parentId: null }, { parentId: external, parentExternal: true }]) {
    await t.test(`forwarded principal refuses ${JSON.stringify(lineage)}`, async () => {
      await assert.rejects(client.request("spawn", { name: `denied-service-${++sequence}`, agent: "inbox", ...lineage }, 5000, context), error => error instanceof RpcError && error.code === "caller_not_trusted");
    });
  }
  await t.test("registered service without principal can delegate any lineage", async () => {
    for (const lineage of [{ parentId: other.beeId }, { parentId: null }, { parentId: external, parentExternal: true }]) {
      const child = await client.request<SpawnResult>("spawn", { name: `delegated-${++sequence}`, agent: "inbox", ...lineage });
      const view = await client.request<ViewResult>("view", { beeId: child.beeId });
      assert.equal(view.bee?.parentId, lineage.parentId);
      assert.equal(view.bee?.parentExternal, "parentExternal" in lineage);
      await checkProvenance(child.beeId, "registered_service", null);
    }
  });
});
