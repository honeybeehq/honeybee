import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RpcClient } from "../../cli/src/client.ts";
import { PROTOCOL, RpcError, type AccountAddResult } from "../src/protocol.ts";
import { makeDaemonDir, startDaemon, forceStopTestDaemon, type DaemonHandle } from "./helpers.ts";
const exec=promisify(execFile);

test("observation RPC: local Unix trust, exact account, opaque data, restart and guarded CLI",{timeout:60_000},async t=>{
 const root=makeDaemonDir();const handles:DaemonHandle[]=[];const clients:RpcClient[]=[];
 t.after(async()=>{for(const c of clients)c.close();await Promise.all(handles.map(forceStopTestDaemon));root.cleanup();});
 const open=async()=>{const d=await startDaemon(root.dir,{env:{HIVE_NO_KEYCHAIN:"1"}});handles.push(d);const c=await d.client();clients.push(c);return {d,c};};
 let {d,c}=await open();
 const added=await c.request<AccountAddResult>("account.add",{harness:"muse",label:"observation",idempotencyKey:"observation-add"});
 const id=added.account.id;const at=Date.now();
 const payload={id,harness:"muse",observedAtMs:at,observation:{fiveHour:{usedPercent:0,resetsAtMs:at+3600_000,windowMinutes:300},weekly:{usedPercent:12,resetsAtMs:at+86400_000},tier:"provider opaque tier",source:"MSP usage/changed"},provenance:{observerNodeId:"current-holder",currentHolder:true,path:{kind:"one_hop",viaNodeId:"sub-lessor",shareId:"peer-share",epoch:1,observerExpiresAtMs:at+86400_000,viaExpiresAtMs:at+86400_000}}};
 assert.deepEqual(await c.request("account.limits.observation",{}),{harnesses:["muse"]});
 for(const lane of ["remote","node_relay"] as const){
  const remote=await RpcClient.connect(d.socketPath,3000,lane);clients.push(remote);
  for(const verb of ["account.limits.observe","account.limits.observation","account.limits.observation.discard"] as const)
   await assert.rejects(remote.request(verb,{...payload,ingress:"local_unix",clientLane:"local_unix"}),e=>e instanceof RpcError&&e.code==="account_limits_observation_refused"&&e.details?.reason==="local_required");
 }
 const result=await c.request<{applied:boolean}>("account.limits.observe",payload);assert.equal(result.applied,true);
 const selected=await c.request<any>("account.limits.observation",{id});assert.equal(selected.selected.limits.plan,"provider opaque tier");assert.equal(selected.selected.limits.weeklyPct,12);assert.equal(selected.selected.source,"MSP usage/changed");assert.equal(selected.lastLocal,null);
 const account=await c.request<any>("account.get",{id});assert.equal(account.account.status,added.account.status,"usage cannot validate the credential");
 await d.stop();({d,c}=await open());assert.deepEqual(await c.request("account.limits.observation",{id}),selected);
 const replay=await c.request<{applied:boolean}>("account.limits.observe",payload);assert.equal(replay.applied,false);
 const discarded=await c.request<any>("account.limits.observation.discard",{id,expectedObservedAtMs:at});assert.equal(discarded.discarded,true);assert.equal(discarded.selected,null);
 assert.equal((await c.request<{applied:boolean}>("account.limits.observe",payload)).applied,false);
 const cli=join(import.meta.dirname,"..","..","cli","src","bin.ts");
 const cliResult=await exec(process.execPath,[cli,"--socket",d.socketPath,"--json","account","observation","harnesses"],{env:{...process.env,HOME:join(root.dir,"cli-home"),XDG_CONFIG_HOME:join(root.dir,"cli-config"),XDG_DATA_HOME:join(root.dir,"cli-data"),XDG_CACHE_HOME:join(root.dir,"cli-cache"),XDG_STATE_HOME:join(root.dir,"cli-state")},timeout:10_000});
 assert.deepEqual(JSON.parse(cliResult.stdout),{harnesses:["muse"]});
});


test("observation CLI refuses an old daemon before issuing any observation RPC",async t=>{
 const root=makeDaemonDir();const sockets:Socket[]=[];let mutations=0;
 const socket=join(root.dir,"old.sock");
 const server=createServer(s=>{sockets.push(s);s.write(JSON.stringify({protocol:PROTOCOL,capabilities:[]})+"\n");s.on("data",chunk=>{for(const line of chunk.toString().trim().split("\n")){const frame=JSON.parse(line);if(frame.verb)mutations++;}});});
 await new Promise<void>(resolve=>server.listen(socket,resolve));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));root.cleanup();});
 const cli=join(import.meta.dirname,"..","..","cli","src","bin.ts");
 await assert.rejects(exec(process.execPath,[cli,"--socket",socket,"--json","account","observation","harnesses"],{env:{...process.env,HOME:join(root.dir,"cli-home"),XDG_CONFIG_HOME:join(root.dir,"config"),XDG_DATA_HOME:join(root.dir,"data"),XDG_CACHE_HOME:join(root.dir,"cache"),XDG_STATE_HOME:join(root.dir,"state")},timeout:10_000}),e=>e instanceof Error && /capability_missing/.test(String((e as Error&{stderr?:string}).stderr)));
 assert.equal(mutations,0);
});
