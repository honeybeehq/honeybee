import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openCoreStore, replayAudit, parseMuseUsage } from "../../core/src/index.ts";
import { applyObservation, readObservation, discardObservation, observationReadRequest } from "../src/limitsObservation.ts";
import { RpcError } from "../src/protocol.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";
function rig() {
  const dir=mkdtempSync(join(tmpdir(),"limits-observation-")), db=join(dir,"core.sqlite3");
  let now=1_800_000_000_000;
  let store=openCoreStore(db,{now:()=>now});
  const account=store.createAccount({id:"muse-studio",harness:"muse",label:"studio",homePath:join(dir,"home"),status:"ok"});
  writeFileSync(join(dir,"config.json"),JSON.stringify({accounts:{homesDir:join(dir,"homes"),vaultDir:join(dir,"vault"),limitsRefreshMs:0},naming:{auto:false}}));
  const service=()=>new AccountsService({store,cfg:loadNodeConfig(dir),now:()=>now,log:()=>{},platform:"linux",env:{},home:join(dir,"own-home")});
  const payload=(at=now,fields:Record<string,unknown>={})=>({id:account.id,harness:"muse",observedAtMs:at,observation:{fiveHour:{usedPercent:0,resetsAtMs:now+1000,windowMinutes:300},weekly:{usedPercent:112,resetsAtMs:now+10000},tier:"opaque-TIER 123",source:"MSP usage/read"},provenance:{observerNodeId:"node-holder",currentHolder:true,path:{kind:"direct",holderExpiresAtMs:now+3_600_000}},...fields});
  return {dir,db,account,get store(){return store;},service,payload,now:()=>now,advance:(ms:number)=>now+=ms,reopen:()=>{store.close();store=openCoreStore(db,{now:()=>now});},close:()=>{store.close();rmSync(dir,{recursive:true,force:true});}};
}
const refusal=(reason:string)=>(e:unknown)=>e instanceof RpcError && e.code==="account_limits_observation_refused" && e.details?.reason===reason;
const invalid=(e:unknown)=>e instanceof RpcError && e.code==="invalid_request";

test("remote observed limits: opaque tier/source, exact account, durable provenance, newest and quiet replay",()=>{
 const r=rig();try{
  const result=applyObservation(r.store,r.payload(),r.account.id);assert.equal(result.applied,true);
  const selected=readObservation(r.store,r.account.id);assert.equal(selected.selected?.limits.plan,"opaque-TIER 123");assert.equal(selected.selected?.source,"MSP usage/read");assert.equal(selected.selected?.limits.weeklyPct,112);assert.equal(selected.lastLocal,null);
  const audit=r.store.auditRows().length;
  for(const at of [r.now(),r.now()-1]) assert.equal(applyObservation(r.store,r.payload(at),r.account.id).applied,false);
  assert.equal(r.store.auditRows().length,audit);
  r.reopen();assert.deepEqual(readObservation(r.store,r.account.id),selected);
  r.advance(1);assert.equal(applyObservation(r.store,r.payload(),r.account.id).applied,true);
  assert.deepEqual(replayAudit(r.store.auditRows()),r.store.dumpState());
 }finally{r.close();}
});

test("local baseline survives remote selection; CAS discard restores it, blocks replay and permits a newer holder",()=>{
 const r=rig();try{
  const svc=r.service();
  svc.observeLimits(r.account,{observedAt:r.now()-100,usage:{observedAtMs:r.now()-100,tier:"local tier",source:"local source",weekly:{usedPercent:12,resetsAtMs:r.now()+1000}}});
  applyObservation(r.store,r.payload(),r.account.id);
  svc.observeLimits(r.account,{observedAt:r.now()-50,usage:{observedAtMs:r.now()-50,tier:"new local tier",source:"local MSP",weekly:{usedPercent:15}}});
  assert.equal(readObservation(r.store,r.account.id).selected?.limits.weeklyPct,112);
  assert.equal(readObservation(r.store,r.account.id).lastLocal?.limits.weeklyPct,15);
  assert.equal(discardObservation(r.store,{id:r.account.id,expectedObservedAtMs:r.now()-1},r.account.id).discarded,false);
  const discarded=discardObservation(r.store,{id:r.account.id,expectedObservedAtMs:r.now()},r.account.id);assert.equal(discarded.discarded,true);assert.equal(discarded.selected?.limits.plan,"new local tier");assert.equal(discarded.selected?.source,"local MSP");assert.equal(discarded.highWatermarkMs,r.now());
  r.reopen();const audit=r.store.auditRows().length;assert.equal(applyObservation(r.store,r.payload(),r.account.id).applied,false);assert.equal(r.store.auditRows().length,audit);
  r.advance(1);assert.equal(applyObservation(r.store,r.payload(),r.account.id).applied,true);
  assert.deepEqual(replayAudit(r.store.auditRows()),r.store.dumpState());
 }finally{r.close();}
});

test("discard without a local source clears only selected limits; account deletion clears all provenance",()=>{
 const r=rig();try{
  applyObservation(r.store,r.payload(),r.account.id);
  assert.equal(discardObservation(r.store,{id:r.account.id,expectedObservedAtMs:r.now()},r.account.id).selected,null);
  assert.deepEqual(replayAudit(r.store.auditRows()),r.store.dumpState());
  r.store.removeAccount(r.account.id);
  r.store.createAccount({id:r.account.id,harness:"muse",label:"studio",homePath:r.account.homePath,status:"ok"});
  assert.equal(readObservation(r.store,r.account.id).highWatermarkMs,0);assert.equal(readObservation(r.store,r.account.id).lastLocal,null);
 }finally{r.close();}
});

for(const offset of [300_000,300_001]) test(`future observation boundary ${offset}`,()=>{
 const r=rig();try{
  const p=r.payload(r.now()+offset);
  if(offset===300_000) assert.equal(applyObservation(r.store,p,r.account.id).applied,true);
  else assert.throws(()=>applyObservation(r.store,p,r.account.id),refusal("future_observation"));
 }finally{r.close();}
});

for(const path of [
 {kind:"direct",holderExpiresAtMs:1},
 {kind:"peer",shareId:"share",epoch:1,holderExpiresAtMs:1},
 {kind:"one_hop",viaNodeId:"via",shareId:"share",epoch:1,observerExpiresAtMs:1,viaExpiresAtMs:Number.MAX_SAFE_INTEGER},
 {kind:"one_hop",viaNodeId:"via",shareId:"share",epoch:1,observerExpiresAtMs:Number.MAX_SAFE_INTEGER,viaExpiresAtMs:1}
]) test(`expired holder path ${JSON.stringify(path)}`,()=>{
 const r=rig();try{assert.throws(()=>applyObservation(r.store,r.payload(r.now(),{provenance:{observerNodeId:"holder",currentHolder:true,path}}),r.account.id),refusal("expired_holder"));assert.equal(r.store.getAccountLimits(r.account.id),null);}finally{r.close();}
});

for(const path of ["peer","one_hop"]) test(`valid ${path} path preserved verbatim and checked inside transaction`,()=>{
 const r=rig();try{
  const pth=path==="peer" ? {kind:path,shareId:"share",epoch:1,holderExpiresAtMs:r.now()+10000} : {kind:path,shareId:"share",epoch:1,viaNodeId:"via",observerExpiresAtMs:r.now()+10000,viaExpiresAtMs:r.now()+20000};
  const p=r.payload(r.now(),{provenance:{observerNodeId:"holder",currentHolder:true,path:pth}});
  applyObservation(r.store,p,r.account.id);assert.deepEqual(readObservation(r.store,r.account.id).selected?.provenance?.path,pth);
  r.advance(10000);assert.throws(()=>applyObservation(r.store,{...p,observedAtMs:r.now()},r.account.id),refusal("expired_holder"));
 }finally{r.close();}
});

test("observation gating: local vault/home source and central source accepted; native, leased and probe harness refused",()=>{
 const r=rig();try{
  applyObservation(r.store,r.payload(),r.account.id);
  const native=r.store.createAccount({id:"muse-this-mac",harness:"muse",label:"This Mac",homePath:join(r.dir,"native"),native:true,status:"ok"});
  assert.throws(()=>applyObservation(r.store,{...r.payload(),id:native.id},native.id),refusal("not_authority"));
  const codex=r.store.createAccount({id:"codex-other",harness:"codex",label:"other",homePath:join(r.dir,"codex"),status:"ok"});
  assert.throws(()=>applyObservation(r.store,{...r.payload(),id:codex.id,harness:"codex"},codex.id),refusal("unsupported_harness"));
  assert.throws(()=>applyObservation(r.store,r.payload(r.now()+1,{harness:"codex"}),r.account.id),refusal("harness_mismatch"));
  r.store.setAccountLease(r.account.id,{shareId:"share-12345",authorityNodeId:"authority",epoch:1,expiresAt:r.now()+10000,revokedAt:null,adoptedAt:null});
  assert.throws(()=>applyObservation(r.store,r.payload(r.now()+1),r.account.id),refusal("not_authority"));
  assert.equal(r.store.getAccountLimits(native.id),null);assert.equal(r.store.getAccount(native.id)?.status,"ok");
 }finally{r.close();}
});

for(const fields of [
 {observation:{weekly:{usedPercent:1},tier:"bad\nvalue"}},
 {observation:{weekly:{usedPercent:-1}}},
 {observation:{weekly:{usedPercent:1},source:"a".repeat(257)}},
 {observation:{weekly:{usedPercent:1},access_token:"never-store"}},
 {observation:{weekly:{usedPercent:1},source:{raw:"never-store"}}},
 {raw:"never-store"}
]) test(`strict secret-free payload refuses ${Object.keys(fields)}`,()=>{
 const r=rig();try{assert.throws(()=>applyObservation(r.store,r.payload(r.now(),fields),r.account.id),invalid);assert.ok(!JSON.stringify(r.store.auditRows()).includes("never-store"));}finally{r.close();}
});

test("v43 migration adds only local observation metadata; parser preserves opaque tier",()=>{
 const r=rig();try{
  r.store.putAccountLimits(r.account.id,{readable:true,fetchedAt:r.now()-1,plan:"pre-upgrade tier",weekly:{usedPercent:12}});
  r.store.close();const db=new DatabaseSync(r.db);db.exec("DROP TABLE account_limit_observations; UPDATE meta SET value='43' WHERE key='schema_version'");db.close();
  const migrated=openCoreStore(r.db,{now:r.now});assert.equal(migrated.getAccountObservation(r.account.id).lastLocal?.limits.plan,"pre-upgrade tier");migrated.close();
  r.reopen();assert.equal(parseMuseUsage({observedAtMs:1,tier:"Unmapped Tier",weekly:{usedPercent:3}})?.plan,"Unmapped Tier");
 }finally{r.close();}
});

test("a newer local provider failure supersedes remote provenance and refreshes the retained local baseline",()=>{
 const r=rig();try{
  r.service().observeLimits(r.account,{observedAt:r.now()-1,usage:{observedAtMs:r.now()-1,tier:"local",weekly:{usedPercent:4}}});
  applyObservation(r.store,r.payload(),r.account.id);
  r.store.putAccountLimits(r.account.id,{readable:false,unreadableReason:"auth_failed",error:"Provider refused",fetchedAt:r.now()+1});
  const read=readObservation(r.store,r.account.id);assert.equal(read.selected?.provenance,null);assert.equal(read.selected?.limits.unreadableReason,"auth_failed");assert.equal(read.lastLocal?.limits.unreadableReason,"auth_failed");assert.deepEqual(read.lastLocal?.limits,read.selected?.limits);
  assert.equal(discardObservation(r.store,{id:r.account.id,expectedObservedAtMs:r.now()+1},r.account.id).discarded,false);
 }finally{r.close();}
});

test("observer assertions are bounded and expiry cannot predate an ahead-of-clock observation",()=>{
 const r=rig();try{
  assert.throws(()=>applyObservation(r.store,r.payload(r.now(),{provenance:{observerNodeId:"holder",currentHolder:false,path:{kind:"direct",holderExpiresAtMs:r.now()+10000}}}),r.account.id),refusal("holder_assertion_required"));
  assert.throws(()=>applyObservation(r.store,r.payload(r.now()+100,{provenance:{observerNodeId:"holder",currentHolder:true,path:{kind:"direct",holderExpiresAtMs:r.now()+50}}}),r.account.id),refusal("expired_holder"));
  assert.throws(()=>applyObservation(r.store,r.payload(r.now(),{observation:{weekly:{usedPercent:2},tier:"a".repeat(5000)}}),r.account.id),invalid);
 }finally{r.close();}
});

for(const readable of [true,false]) test(`discard restores every local limits column exactly (readable=${readable})`,()=>{
 const r=rig();try{
  r.store.observeAccountLimits(r.account.id,{readable,unreadableReason:readable?null:"timeout",error:readable?null:"local timeout",fetchedAt:r.now()-1,plan:"local plan",fiveHour:{usedPercent:2,resetsAt:123,windowMinutes:300},weekly:{usedPercent:3,resetsAt:456,windowMinutes:10080},fableWeekly:{usedPercent:4,resetsAt:789,windowMinutes:10080},displayWindows:[{key:"extra",label:"extra",usedPercent:5,resetsAt:1000,windowMinutes:60}],rateLimitResetCredits:{availableCount:2,credits:[]}},"local source",null,()=>{});
  const local=r.store.getAccountLimits(r.account.id);
  applyObservation(r.store,r.payload(),r.account.id);
  discardObservation(r.store,{id:r.account.id,expectedObservedAtMs:r.now()},r.account.id);
  assert.deepEqual(r.store.getAccountLimits(r.account.id),local);
  assert.deepEqual(replayAudit(r.store.auditRows()),r.store.dumpState());
 }finally{r.close();}
});

test("a remote snapshot cannot become a local quota observation or echo back as lastLocal",()=>{
 const r=rig();try{
  applyObservation(r.store,r.payload(),r.account.id);
  const before=readObservation(r.store,r.account.id);
  assert.equal(r.service().observeLimits(r.account,{observedAt:r.now()+1,quota:{limitKind:"tierLimit",resetsAtMs:r.now()+1000}}),null);
  assert.deepEqual(readObservation(r.store,r.account.id),before);
 }finally{r.close();}
});


test("holder read accepts a retained companion account id and exposes only its local provider reading",()=>{
 const r=rig();try{
  const holder=r.store.createAccount({id:"muse-holder@12345678",harness:"muse",label:"holder",homePath:join(r.dir,"holder"),status:"ok"});
  r.service().observeLimits(holder,{observedAt:r.now(),usage:{observedAtMs:r.now(),tier:"holder tier",source:"holder MSP",weekly:{usedPercent:12}}});
  const result=observationReadRequest(r.store,{id:holder.id});
  assert.ok("lastLocal" in result);if("lastLocal" in result)assert.equal(result.lastLocal?.limits.plan,"holder tier");
  for(const id of ["auto","rr","bad/selector"])assert.throws(()=>observationReadRequest(r.store,{id}),invalid);
 }finally{r.close();}
});


for(const provenance of [undefined,{}, {observerNodeId:"holder",currentHolder:true,path:{}}, {observerNodeId:"holder",currentHolder:true,path:[]}, {observerNodeId:"holder",currentHolder:true,path:{kind:"peer",shareId:"share",epoch:1,holderExpiresAtMs:"forever"}}, {observerNodeId:"holder",currentHolder:true,path:{kind:"direct"}}]) test("missing or malformed holder assertion is a typed refusal",()=>{
 const r=rig();try{assert.throws(()=>applyObservation(r.store,r.payload(r.now(),{provenance}),r.account.id),refusal("holder_assertion_required"));assert.equal(r.store.getAccountLimits(r.account.id),null);}finally{r.close();}
});

test("applying to a vault-held lease source touches usage only and attributes the asserted path",()=>{
 const r=rig();try{
  const home=join(r.account.homePath,"muse","auth.json"), vault=join(r.dir,"vault","muse",r.account.id,"muse","auth.json");
  for(const file of [home,vault]){mkdirSync(join(file,".."),{recursive:true});writeFileSync(file,'{ "schema_version": 17, "providers": { "meta": { "access_token": "fixture-private-login" } } }\n');}
  const before=[readFileSync(home),readFileSync(vault)];const authority=r.store.getAccountCredentialAuthority(r.account.id);
  const payload=r.payload();applyObservation(r.store,payload,r.account.id);
  assert.ok(readFileSync(home).equals(before[0]!));assert.ok(readFileSync(vault).equals(before[1]!));assert.deepEqual(r.store.getAccountCredentialAuthority(r.account.id),authority);
  assert.equal(existsSync(join(r.dir,"vault",".credential-authorities")),false);
  const audit=r.store.auditRows().filter(row=>row.kind==="account_limits.observation");
  assert.deepEqual(audit.at(-1)?.payload.provenance,payload.provenance);
  assert.ok(!JSON.stringify(r.store.auditRows()).includes("fixture-private-login"));
 }finally{r.close();}
});

for(const odd of ["tier\nwith\u0001controls", "t".repeat(300), 123, {raw:"not a string"}]) test("local provider tier/source is bounded without losing observed usage",()=>{
 const r=rig();try{
  const row=r.service().observeLimits(r.account,{observedAt:r.now(),usage:{observedAtMs:r.now(),tier:odd,source:odd,weekly:{usedPercent:12}}});
  assert.equal(row?.weeklyPct,12);
  const expected=typeof odd==="string"?odd.replace(/[\u0000-\u001f\u007f-\u009f]/g," ").slice(0,256):null;
  assert.equal(row?.plan,expected);assert.equal(readObservation(r.store,r.account.id).lastLocal?.source,expected);
 }finally{r.close();}
});

test("a real local probe refreshes lastLocal without turning remote applies or restores into local readings",()=>{
 const r=rig();try{
  r.store.putAccountLimits(r.account.id,{readable:true,fetchedAt:r.now()-10,plan:"first probe",weekly:{usedPercent:1}});
  assert.equal(readObservation(r.store,r.account.id).lastLocal?.limits.plan,"first probe");
  applyObservation(r.store,r.payload(),r.account.id);
  assert.equal(readObservation(r.store,r.account.id).lastLocal?.limits.plan,"first probe");
  r.advance(1);r.store.putAccountLimits(r.account.id,{readable:true,fetchedAt:r.now(),plan:"latest probe",weekly:{usedPercent:2}});
  const local=r.store.getAccountLimits(r.account.id);
  r.advance(1);applyObservation(r.store,r.payload(),r.account.id);
  discardObservation(r.store,{id:r.account.id,expectedObservedAtMs:r.now()},r.account.id);
  assert.deepEqual(r.store.getAccountLimits(r.account.id),local);
  assert.deepEqual(readObservation(r.store,r.account.id).lastLocal?.limits,local);
  assert.deepEqual(replayAudit(r.store.auditRows()),r.store.dumpState());
 }finally{r.close();}
});


test("an unsupported probe placeholder never becomes or replaces local provider evidence",()=>{
 const r=rig();try{
  r.store.putAccountLimits(r.account.id,{readable:false,unreadableReason:"unsupported",fetchedAt:r.now()});
  assert.equal(readObservation(r.store,r.account.id).lastLocal,null);
  r.service().observeLimits(r.account,{observedAt:r.now()-1,usage:{observedAtMs:r.now()-1,tier:"real observation",weekly:{usedPercent:12}}});
  const baseline=readObservation(r.store,r.account.id).lastLocal;
  assert.equal(baseline?.limits.weeklyPct,12);
  r.store.putAccountLimits(r.account.id,{readable:false,unreadableReason:"unsupported",fetchedAt:r.now()+1});
  assert.deepEqual(readObservation(r.store,r.account.id).lastLocal,baseline);
 }finally{r.close();}
});
