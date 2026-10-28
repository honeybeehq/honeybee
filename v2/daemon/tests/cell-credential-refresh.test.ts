import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openCoreStore } from "../../core/src/index.ts";
import { prepareSandboxHarnessHome } from "../../driver-cell/src/harnessHome.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";
import { HiveDaemon } from "../src/daemon.ts";
import { loadNodeConfig } from "../src/config.ts";

function fixture(t: import("node:test").TestContext) {
  mkdirSync(resolve(".cache/t11g-trash"), {recursive:true});
  const root = mkdtempSync(resolve(".cache/hb-refresh-"));
  const store = openCoreStore(join(root,"core.sqlite"), {now:()=>1000, ephemeral:true});
  t.after(()=> {store.close(); const r=spawnSync("trash",["--trash-dir",resolve(".cache/t11g-trash"),root],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);});
  const daemon = new HiveDaemon({...loadNodeConfig(root),nodeKind:"satellite"},{cellCredentialNow:()=>1000});
  const internal = daemon as any;
  internal.store=store; internal.resolveCellSpec=()=>({sandbox:true});
  let material={kind:"lease",scope:"studio:share",epoch:1,generation:1,authorityInstanceId:"studio"};
  internal.accounts={authDeathMaterial:()=>material};
  let raw=JSON.stringify({tokens:{access_token:"synthetic-1",refresh_token:""}});
  writeFileSync(join(root,"auth.json"),raw);
  const home=join(root,"home");mkdirSync(home);writeFileSync(join(home,"auth.json"),raw);
  const account=store.createAccount({id:"codex-fixture",harness:"codex",label:"fixture",homePath:home});
  internal.resolveCellSandboxHarnessHome=()=>({harness:"codex",path:home});
  internal.accounts.credentialRevision=()=>"synthetic";
  internal.accounts.authorityFor=()=>({status:()=>({expiresAt:3_601_000})});
  function bee(name:string,expiry=3_601_000) {
    const {bee}=store.createBee({name,agent:"codex",substrate:"cell",account:account.id,cwd:root});
    store.recordCellCredentialProjection(bee.id,1,{material:{...material,kind:"lease"},revision:"synthetic",account:account.id,agent:"codex",cwd:root,cellId:null,controlFence:0,cellProjection:{digests:{"auth.json":createHash("sha256").update(raw).digest("hex")},expiresAt:expiry,preparedAt:1000}});
    store.updateRuntimeState(bee.id,1,"running");
    return bee.id;
  }
  return {store,internal,bee,renew:(unchanged=false)=>{material={...material,generation:material.generation+1}; if(!unchanged) {raw=JSON.stringify({tokens:{access_token:`synthetic-${material.generation}`,refresh_token:""}});writeFileSync(join(home,"auth.json"),raw);}}};
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
  const r=fixture(t), id=r.bee("expired",999);
  assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  const seq = r.store.lastAuditSeq();
  for(let i=0;i<3;i++) assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  assert.equal(r.store.lastAuditSeq(),seq);
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


test("async boot window is quiet and operator control cancels a queued refresh",t=>{
  const r=fixture(t);
  const account=r.store.listAccounts()[0]!;
  const {bee}=r.store.createBee({name:"boot-window",agent:"codex",substrate:"cell",account:account.id,cwd:account.homePath});
  const seq=r.store.lastAuditSeq();assert.equal(r.internal.admitCellCredentialTurn(bee.id,1),false);assert.equal(r.store.lastAuditSeq(),seq);
  assert.equal(r.store.activeFlags(bee.id).length,0);
  const id=r.bee("operator");r.renew();r.internal.reconcileCellCredentials();
  r.store.enqueueCommand("stop",id,{cause:"stopped_by_user"});
  r.store.updateRuntimeState(id,1,"idle");
  const command=r.store.claimNextCommand();assert.equal(command?.args.cause,"stopped_by_user");
  assert.equal(r.store.hasStopThenReviveRequest(id,1),false);
});


test("real input projection records the boot receipt and clears only Cell-owned attention",t=>{
  const r=fixture(t), account=r.store.listAccounts()[0]!;
  const cell=join(account.homePath,"..","cell");mkdirSync(cell);
  const {bee}=r.store.createBee({name:"real-projection",agent:"codex",substrate:"cell",account:account.id,cwd:cell});
  assert.equal(r.internal.admitCellCredentialTurn(bee.id,1),false);
  const projection=prepareSandboxHarnessHome(cell,"codex",account.homePath);
  r.store.setFlag(bee.id,"auth_needed","cell_projection_unknown: old receipt");
  const sources=projection.files.filter(file=>file.credentialPath!==undefined).map(file=>({path:file.credentialPath!,source:file.source}));
  r.internal.recordCellCredentialProjection(bee.id,1,sources);
  assert.ok(r.store.currentRuntime(bee.id)?.credentialStamp?.cellProjection?.digests["auth.json"]);
  assert.equal(r.store.activeFlags(bee.id).length,0);
  r.store.setFlag(bee.id,"auth_needed","operator login required");
  r.internal.recordCellCredentialProjection(bee.id,1,sources);
  assert.equal(r.store.activeFlags(bee.id)[0]?.detail,"operator login required");
});


test("safe boundary replacement reaches exactly one successor and keeps the pending mailbox",t=>{
  const r=fixture(t), id=r.bee("successor");
  r.store.send(id,"pending original");r.renew();r.internal.reconcileCellCredentials();
  const driver=new FakeDriver(()=>1000);driver.autoBoot=false;
  const core=new DaemonCore({store:r.store,driver,policy:{commandsPerStep:8},now:()=>1000,log:()=>{}});
  core.step();assert.equal(driver.starts.length,0);assert.equal(r.store.currentRuntime(id)?.generation,1);
  r.store.updateRuntimeState(id,1,"idle");
  for(let i=0;i<4;i++) core.step();
  assert.equal(r.store.currentRuntime(id)?.generation,2);assert.equal(driver.starts.length,1);
  assert.equal(r.store.undeliveredMessages(id).length,1);
});
