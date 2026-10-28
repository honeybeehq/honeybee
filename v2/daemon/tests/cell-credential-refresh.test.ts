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
  let clock=1000;
  const store = openCoreStore(join(root,"core.sqlite"), {now:()=>clock, ephemeral:true});
  t.after(()=> {store.close(); const r=spawnSync("trash",["--trash-dir",resolve(".cache/t11g-trash"),root],{encoding:"utf8"});assert.equal(r.status,0,r.stderr);});
  const daemon = new HiveDaemon({...loadNodeConfig(root),nodeKind:"satellite"},{cellCredentialNow:()=>clock});
  const internal = daemon as any;
  internal.store=store; internal.resolveCellSpec=()=>({sandbox:true});
  let material={kind:"central",scope:"codex-fixture",epoch:0,generation:1,authorityInstanceId:"studio"};
  internal.accounts={authDeathMaterial:()=>material};
  let raw=JSON.stringify({tokens:{access_token:"synthetic-1",refresh_token:""}});
  writeFileSync(join(root,"auth.json"),raw);
  const home=join(root,"home");mkdirSync(home);writeFileSync(join(home,"auth.json"),raw);
  const account=store.createAccount({id:"codex-fixture",harness:"codex",label:"fixture",homePath:home});
  internal.resolveCellSandboxHarnessHome=()=>({harness:"codex",path:home});
  internal.accounts.credentialRevision=()=>"synthetic";
  store.putAccountCredentialAuthority({account:account.id,authorityInstanceId:"studio",phase:"ready",generation:1,expiresAt:3_601_000,operationKey:null});
  material={...material,authorityInstanceId:store.getAccountCredentialAuthority(account.id)!.authorityInstanceId!};
  internal.accounts.authorityFor=()=>({status:()=>store.getAccountCredentialAuthority(account.id)});
  internal.accounts.accountForGeneration=()=>store.getAccount(account.id);
  internal.accounts.centralCredentialInDoubt=()=>false;
  function bee(name:string,expiry=3_601_000) {
    const {bee}=store.createBee({name,agent:"codex",substrate:"cell",account:account.id,cwd:root});
    store.recordCellCredentialProjection(bee.id,1,{material:{...material,kind:"central"},revision:"synthetic",account:account.id,agent:"codex",cwd:root,cellId:null,controlFence:0,cellProjection:{digests:{"auth.json":createHash("sha256").update(raw).digest("hex")},expiresAt:expiry,preparedAt:1000}});
    store.mountCellCredentialProjection(bee.id,1);
    store.updateRuntimeState(bee.id,1,"running");
    return bee.id;
  }
  return {store,internal,bee,advance:(at:number)=>{clock=at;},renew:(unchanged=false)=>{material={...material,generation:material.generation+1};store.putAccountCredentialAuthority({...store.getAccountCredentialAuthority(account.id)!,generation:material.generation}); if(!unchanged) {raw=JSON.stringify({tokens:{access_token:`synthetic-${material.generation}`,refresh_token:""}});writeFileSync(join(home,"auth.json"),raw);}}};
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
  const r=fixture(t), id=r.bee("expired");r.advance(3_601_001);
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
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.authenticationHintAt,undefined);
  r.store.mountCellCredentialProjection(id,1);
  r.store.authenticateCellCredentialProjection(id,1);
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.authenticationHintAt,1000);
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
  const core=new DaemonCore({store:r.store,driver,policy:{commandsPerStep:8,bootHangTimeoutSteps:50},now:()=>1000,log:()=>{}});
  core.step();assert.equal(driver.starts.length,0);assert.equal(r.store.currentRuntime(id)?.generation,1);
  r.store.updateRuntimeState(id,1,"idle");
  for(let i=0;i<4;i++) core.step();
  assert.equal(r.store.currentRuntime(id)?.generation,2);assert.equal(driver.starts.length,1);
  assert.equal(r.store.undeliveredMessages(id).length,1);
});


test("mooted refresh intent can be replaced without silently wedging the runtime",t=>{
  const r=fixture(t),id=r.bee("mooted");r.renew();r.internal.reconcileCellCredentials();
  const first=r.store.listCommands().find(c=>c.args.reason==="cell_credentials")!;
  r.store.cancelAuthDeathRecovery(id);r.store.updateRuntimeState(id,1,"idle");
  assert.equal(r.store.claimNextCommand(),null);
  assert.equal(r.store.getCommand(first.id)?.args.thenRevive,false);
  assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  const replacements=r.store.listCommands().filter(c=>c.args.reason==="cell_credentials");
  assert.equal(replacements.length,2);assert.equal(replacements[1]?.status,"queued");
  assert.notEqual(replacements[0]?.idempotencyKey,replacements[1]?.idempotencyKey);
});

test("Cell expiry preserves a genuine harness authentication failure",t=>{
  const r=fixture(t),id=r.bee("real-auth-failure");r.advance(3_601_001);
  r.store.setFlag(id,"auth_needed","Provider rejected synthetic fixture");
  const seq=r.store.lastAuditSeq();
  r.internal.admitCellCredentialTurn(id,1);r.internal.admitCellCredentialTurn(id,1);
  assert.equal(r.store.lastAuditSeq(),seq);
  assert.equal(r.store.activeFlags(id)[0]?.detail,"Provider rejected synthetic fixture");
});


test("operator parking holds replacement without stopping a running Cell",t=>{
  const r=fixture(t),id=r.bee("parked");r.renew();r.internal.reconcileCellCredentials();
  r.store.pauseAccount(r.store.listAccounts()[0]!.id,{by:"operator",owner:null});
  r.store.updateRuntimeState(id,1,"idle");assert.equal(r.store.claimNextCommand(),null);
  r.store.updateRuntimeState(id,1,"running");
  assert.equal(r.internal.admitCellCredentialTurn(id,1),true);
  assert.equal(r.store.listCommands().filter(c=>c.verb==="stop" && c.status==="queued").length,0);
  assert.equal(r.store.activeFlags(id)[0]?.detail,"cell_replacement_held: operator control");
  assert.equal(r.store.currentRuntime(id)?.state,"running");
  r.advance(3_601_000);assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  assert.match(r.store.activeFlags(id)[0]!.detail,/cell_access_expired/);
  assert.equal(r.store.currentRuntime(id)?.state,"running");
});


test("changed non-access-only material refuses visibly without replacing or interrupting",t=>{
  const r=fixture(t),id=r.bee("unsafe-publication");r.renew();
  writeFileSync(join(r.store.listAccounts()[0]!.homePath,"auth.json"),JSON.stringify({tokens:{access_token:"synthetic",refresh_token:"synthetic-refresh"}}));
  assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  assert.equal(r.store.activeFlags(id)[0]?.detail,"cell_access_only_required");
  assert.equal(r.store.currentRuntime(id)?.state,"running");
  assert.equal(r.store.latestCellCredentialReplacement(id,1),null);
  const seq=r.store.lastAuditSeq();assert.equal(r.internal.admitCellCredentialTurn(id,1),false);assert.equal(r.store.lastAuditSeq(),seq);
});

test("the next tick refreshes digest cache after material changes without lease installation",t=>{
  const r=fixture(t),id=r.bee("tick-refresh");r.renew(true);
  assert.equal(r.internal.admitCellCredentialTurn(id,1),true);
  writeFileSync(join(r.store.listAccounts()[0]!.homePath,"auth.json"),JSON.stringify({tokens:{access_token:"synthetic-published-later",refresh_token:""}}));
  r.internal.reconcileCellCredentials();
  assert.equal(r.store.latestCellCredentialReplacement(id,1)?.status,"queued");
});


test("one missing Cell row cannot stop healthy core work or account maintenance",t=>{
  const r=fixture(t),bad=r.bee("missing-cell");
  delete r.internal.resolveCellSpec;
  const {bee:healthy}=r.store.createBee({name:"healthy",agent:"stub",substrate:"hsr",cwd:"/fixture"});
  let steps=0,accountTicks=0;
  r.internal.accounts.periodicRefreshTick=()=>{accountTicks++;};
  r.internal.accounts.credentialHandoff={reconcile:async()=>{}};
  r.internal.accounts.centralRefreshRetryTick=()=>{};r.internal.accounts.centralEarlyRefreshTick=()=>{};
  r.internal.accounts.claudeKeychainRepairTick=async()=>{};
  r.internal.enforceWeeklyCeilings=()=>{};
  const core={step:()=>{steps++;if(r.store.currentRuntime(healthy.id)?.state === "booting") r.store.updateRuntimeState(healthy.id,1,"running");}};
  const errors=r.internal.tickErrors;
  r.internal.tickProfiled(core);r.internal.tickProfiled(core);
  assert.equal(steps,2);assert.equal(accountTicks,2);assert.equal(r.internal.tickErrors,errors);
  assert.match(r.store.activeFlags(bad)[0]!.detail,/cell_reconciliation_failed/);
  assert.equal(r.store.currentRuntime(healthy.id)?.state,"running");
  assert.equal(r.internal.admitCellCredentialTurn(bad,1),false);
});


test("an expired or superseded Cell 401 stays scoped to its Bee",t=>{
  const r=fixture(t), expired=r.bee("expired-401",999), sibling=r.bee("sibling");
  r.internal.applyAccountPolicy({beeId:expired,generation:1,flag:"auth_needed",action:"set",detail:"synthetic 401"});
  assert.equal(r.store.listAccounts()[0]!.status,"ok");assert.ok(r.store.activeFlags(expired).some(f=>f.flag==="auth_needed"));
  assert.equal(r.store.activeFlags(sibling).length,0);
  const superseded=r.bee("superseded-401");r.renew();
  r.internal.applyAccountPolicy({beeId:superseded,generation:1,flag:"auth_needed",action:"set",detail:"synthetic stale 401"});
  assert.equal(r.store.listAccounts()[0]!.status,"ok");assert.equal(r.store.currentRuntime(sibling)?.state,"running");
});

test("same-byte extension updates only the fenced expiry without restart",t=>{
  const r=fixture(t),id=r.bee("extended-expiry");
  const account=r.store.listAccounts()[0]!;
  r.store.putAccountCredentialAuthority({...r.store.getAccountCredentialAuthority(account.id)!,expiresAt:7_201_000});
  const digests=r.store.currentRuntime(id)!.credentialStamp!.cellProjection!.digests;
  assert.equal(r.internal.admitCellCredentialTurn(id,1),true);
  assert.equal(r.store.latestCellCredentialReplacement(id,1),null);
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.expiresAt,7_201_000);
  assert.deepEqual(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.digests,digests);
});


test("a distinct second account replacement round is guarded for six durable hours",t=>{
  const r=fixture(t),first=r.bee("round-a");r.renew();r.internal.reconcileCellCredentials();
  assert.equal(r.store.latestCellCredentialReplacement(first,1)?.status,"queued");
  const second=r.bee("round-b");r.renew();
  const logs:string[]=[];r.internal.log=(line:string)=>logs.push(line);
  r.internal.reconcileCellCredentials();r.internal.reconcileCellCredentials();
  assert.equal(r.store.latestCellCredentialReplacement(second,1),null);
  assert.ok(r.store.activeFlags(second).some(f=>f.detail.startsWith("cell_replacement_rate_limited")));
  assert.equal(logs.filter(line=>line.includes("code=replacement_rate_limited")).length,1);
  r.advance(6*60*60_000+1001);r.internal.reconcileCellCredentials();
  assert.equal(r.store.latestCellCredentialReplacement(second,1)?.status,"queued");
});

test("expiry extension is monotonic, source-bounded and refused by placement or control fences",t=>{
  const r=fixture(t),id=r.bee("extension-fences"),account=r.store.listAccounts()[0]!;
  r.store.putAccountCredentialAuthority({...r.store.getAccountCredentialAuthority(account.id)!,expiresAt:7_201_000});
  const stamp=r.store.currentRuntime(id)!.credentialStamp!;
  const input={account:account.id,controlFence:0,hostDigests:stamp.cellProjection!.digests,expiresAt:7_201_000,material:stamp.material};
  assert.equal(r.store.extendCellCredentialExpiry(id,2,input),false);
  assert.equal(r.store.extendCellCredentialExpiry(id,1,{...input,expiresAt:8_000_000}),false);
  assert.equal(r.store.extendCellCredentialExpiry(id,1,{...input,expiresAt:1_000}),false);
  const original=r.store.getBee.bind(r.store);
  for(const field of ["activeMoveId","activeHandoffId"]) {
    r.store.getBee=(value:string)=>{const bee=original(value);return bee ? {...bee,[field]:"fixture-operation"}:null;};
    assert.equal(r.store.extendCellCredentialExpiry(id,1,input),false);
  }
  r.store.getBee=original;r.store.cancelAuthDeathRecovery(id);
  assert.equal(r.store.extendCellCredentialExpiry(id,1,input),false);
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.expiresAt,3_601_000);
});


test("a between-tick publication cannot extend expiry using stale cached digests",t=>{
  const r=fixture(t),id=r.bee("cache-publication-fence"),account=r.store.listAccounts()[0]!;
  r.renew(true);assert.equal(r.internal.admitCellCredentialTurn(id,1),true);
  r.renew();r.store.putAccountCredentialAuthority({...r.store.getAccountCredentialAuthority(account.id)!,expiresAt:7_201_000});
  assert.equal(r.internal.admitCellCredentialTurn(id,1),false);
  assert.equal(r.store.currentRuntime(id)?.credentialStamp?.cellProjection?.expiresAt,3_601_000);
  assert.equal(r.store.latestCellCredentialReplacement(id,1)?.status,"queued");
});
