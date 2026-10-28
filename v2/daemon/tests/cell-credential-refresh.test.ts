import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openCoreStore } from "../../core/src/index.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";

function fixture(t: import("node:test").TestContext) {
  mkdirSync(resolve(".cache/t11g-trash"), {recursive:true});
  const root = mkdtempSync(resolve(".cache/hb-refresh-"));
  const store = openCoreStore(join(root,"core.sqlite"), {now:()=>1000, ephemeral:true});
  t.after(()=> {store.close(); const r=spawnSync("trash",["--trash-dir",resolve(".cache/t11g-trash"),root],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);});
  const daemon = new HiveDaemon({...loadNodeConfig(root),nodeKind:"satellite"});
  const internal = daemon as any;
  internal.store=store; internal.resolveCellSpec=()=>({sandbox:true});
  let material={kind:"lease",scope:"studio:share",epoch:1,generation:1,authorityInstanceId:"studio"};
  internal.accounts={authDeathMaterial:()=>material};
  let raw=JSON.stringify({tokens:{access_token:"synthetic-1",refresh_token:""}});
  writeFileSync(join(root,"auth.json"),raw);
  const account=store.createAccount({id:"codex-fixture",harness:"codex",label:"fixture",homePath:root});
  function bee(name:string,expiry=Date.now()+3_600_000) {
    const {bee}=store.createBee({name,agent:"codex",substrate:"cell",account:account.id,cwd:root});
    store.recordCellCredentialProjection(bee.id,1,{material:{...material,kind:"lease"},revision:"synthetic",account:account.id,agent:"codex",cwd:root,cellId:null,controlFence:0,cellProjection:{digests:[createHash("sha256").update(raw).digest("hex")],expiresAt:expiry,preparedAt:1000}});
    store.updateRuntimeState(bee.id,1,"running");
    return bee.id;
  }
  return {store,internal,bee,renew:(unchanged=false)=>{material={...material,generation:material.generation+1}; if(!unchanged) {raw=JSON.stringify({tokens:{access_token:`synthetic-${material.generation}`,refresh_token:""}});writeFileSync(join(root,"auth.json"),raw);}}};
}

test("lease publication queues one replacement per Bee, waits for a safe boundary and preserves mail", t=>{
  const r=fixture(t), first=r.bee("first"),second=r.bee("second");
  r.store.send(first,"durable mail");
  assert.equal(r.internal.admitCellCredentialTurn(first,1),true);
  r.renew(); r.internal.reconcileCellCredentials(); r.internal.reconcileCellCredentials();
  const stops=r.store.listCommands().filter(c=>c.verb==="stop");
  assert.equal(stops.length,2);
  assert.ok(stops.every(c=>c.args.waitForIdle===true && c.args.thenRevive===true && c.targetGeneration===1));
  assert.equal(r.store.claimNextCommand(),null);
  assert.equal(r.store.undeliveredMessages(first).length,1);
  r.store.updateRuntimeState(first,1,"idle");
  const stop=r.store.claimNextCommand(); assert.equal(stop?.beeId,first); assert.equal(stop?.verb,"stop");
  assert.equal(r.store.currentRuntime(second)?.state,"running");
  const before=r.store.lastAuditSeq();r.internal.reconcileCellCredentials();assert.equal(r.store.lastAuditSeq(),before);
});

test("unchanged material does not churn; expiry and unknown projections are visible auth_needed",t=>{
  const r=fixture(t), id=r.bee("expired",Date.now()-1);
  for(let i=0;i<3;i++) assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  assert.equal(r.store.listCommands().filter(c=>c.verb==="stop").length,0);
  assert.ok(r.store.activeFlags(id).some(f=>f.flag==="auth_needed"));
  r.renew(true);r.internal.admitCellCredentialTurn(id,1);
  assert.equal(r.store.listCommands().filter(c=>c.verb==="stop").length,0);
  r.renew();assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  assert.equal(r.store.claimNextCommand(),null);
  assert.equal(r.store.currentRuntime(id)?.state,"running");
  assert.equal(r.internal.admitCellCredentialTurn(id,2),false);
});

test("projection and authentication receipts are generation-fenced and survive store reads",t=>{
  const r=fixture(t), id=r.bee("receipt");
  r.store.authenticateCellCredentialProjection(id,2);
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.authenticatedAt,undefined);
  r.store.mountCellCredentialProjection(id,1);
  r.store.authenticateCellCredentialProjection(id,1);
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.authenticatedAt,1000);
  const before=r.store.lastAuditSeq();r.store.authenticateCellCredentialProjection(id,1);assert.equal(r.store.lastAuditSeq(),before);
  assert.throws(()=>r.store.recordCellCredentialProjection(id,2,r.store.currentRuntime(id)!.credentialStamp!));
});
