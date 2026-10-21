import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMailBatch } from "../../core/src/mailBatch.ts";
import { replayAudit } from "../../core/src/audit.ts";
import { openCoreStore } from "../../core/src/store.ts";
import type { DeliveryConfirmationPlan, DeliveryConfirmationResult } from "../../harness/src/driver.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

class ReceiptDriver extends FakeDriver {
  result: DeliveryConfirmationResult = "pending_ack";
  writes = 0;
  planDeliveryConfirmation(_beeId: string, _generation: number, messageId: number, body: string): DeliveryConfirmationPlan {
    const wireLine = JSON.stringify({messageId,body});
    return { wireLine, digest: createHash("sha256").update(wireLine).digest("hex"), host: {pid:123,birth:"linux:123",bootId:"11111111-1111-1111-1111-111111111111"}, supported:true };
  }
  reconcileDeliveryConfirmation(): DeliveryConfirmationResult { return this.result; }
  override deliver(_beeId: string, _generation: number, messageId: number, body: string) {
    this.writes++;
    this.deliveredIds.push(messageId);
    this.deliveredBodies.push(body);
    return { accepted:false, reason:"not_ready" as const };
  }
}

function rig(receipts = false) {
  const root = mkdtempSync(join(tmpdir(), "batching-"));
  let time = 1000;
  const now = () => time;
  let store = openCoreStore(join(root,"core.sqlite"),{now,ephemeral:true});
  const driver = receipts ? new ReceiptDriver(now) : new FakeDriver(now);
  const violations: unknown[] = [];
  const options = () => ({store,driver,now,log:()=>{},onI1Violation:(v:unknown)=>violations.push(v),policy:{commandsPerStep:8,idleWindowSteps:null,i1DeadlineSteps:50,bootHangTimeoutSteps:1000000}});
  let core = new DaemonCore(options()); core.boot();
  const bee = store.createBee({name:"fixture",agent:"stub",substrate:"hsr",cwd:root}).bee;
  store.enqueueCommand("spawn",bee.id);
  for (let i=0;i<4;i++) core.step();
  store.setMailBatchingPolicy(bee.id,true);
  return {
    bee,driver,violations,get store(){return store;},get core(){return core;},
    human(body="human",key=body){return store.send(bee.id,body,{humanChat:{version:1,authorityId:"apiary",admissionId:key,beeId:bee.id,bodySha256:createHash("sha256").update(body).digest("hex"),idempotencyKey:key}}).message;},
    peer(body:string,urgency:"now"|"next"|"idle"="next"){return store.send(bee.id,body,{sender:"bee-fixture",urgency}).message;},
    end(){driver.events.push({beeId:bee.id,generation:1,kind:"turn_ended"});core.step();},
    start(){driver.events.push({beeId:bee.id,generation:1,kind:"turn_started"});core.step();},
    advance(ms:number){time+=ms;core.step();},
    restart(){store.close();store=openCoreStore(join(root,"core.sqlite"),{now,ephemeral:true});core=new DaemonCore(options());core.boot();},
    replay(){assert.deepEqual(replayAudit(store.auditRows()),store.dumpState());},
    close(){store.close();},
  };
}

test("active-human holds unmarked urgent peers then releases one deterministic digest",()=>{
  const r=rig();try {
    r.start(); const human=r.human();
    const peers=Array.from({length:12},(_,i)=>r.peer(`peer ${i} urgent instructions`,i===0?"now":"next"));
    r.core.step();assert.deepEqual(r.driver.deliveredIds,[]);
    r.end();assert.deepEqual(r.driver.deliveredIds,[human.id]);
    r.start();r.end();r.advance(119999);assert.equal(r.store.listMailBatches().length,0);
    r.advance(1);assert.deepEqual(r.driver.deliveredIds,[human.id,peers[0]!.id]);
    const batch=r.store.listMailBatches()[0]!;
    assert.deepEqual(batch.memberIds,peers.map(p=>p.id));assert.ok(batch.deliveredAt!==null);
    assert.match(r.driver.deliveredBodies[1]!,/^Background digest/);
    for(const peer of peers){assert.match(r.driver.deliveredBodies[1]!,new RegExp(peer.body));assert.equal(r.store.getMessage(peer.id)?.deliveredGeneration,1);}
    assert.deepEqual(r.violations,[]);r.replay();
  }finally{r.close();}
});

test("human followup and authenticated controls each get own clean turn ahead of background",()=>{
  const r=rig();try {
    const peers=[r.peer("a"),r.peer("b")];const human=r.human();
    const reprompt=r.store.send(r.bee.id,"followup",{automationKind:"tell-reprompt",urgency:"now"}).message;
    const control=r.store.send(r.bee.id,"context",{automationKind:"context-notice",urgency:"now"}).message;
    r.core.step();assert.deepEqual(r.driver.deliveredIds,[human.id]);
    r.advance(120001);assert.deepEqual(r.driver.deliveredIds,[human.id]);
    r.start();r.end();assert.deepEqual(r.driver.deliveredIds,[human.id,reprompt.id]);
    r.start();r.core.step();assert.deepEqual(r.driver.deliveredIds,[human.id,reprompt.id]);
    r.end();assert.deepEqual(r.driver.deliveredIds,[human.id,reprompt.id,control.id]);
    r.start();r.end();assert.deepEqual(r.driver.deliveredIds,[human.id,reprompt.id,control.id,peers[0]!.id]);
    r.replay();
  }finally{r.close();}
});

test("restart before and after freeze preserves membership and newer mail joins later group",()=>{
  const r=rig();try {
    r.human();r.core.step();r.start();r.end();const a=r.peer("a"),b=r.peer("b");
    r.restart();r.driver.acceptDeliveries=false;r.advance(120000);
    const frozen=r.store.listMailBatches()[0]!;assert.deepEqual(frozen.memberIds,[a.id,b.id]);
    r.restart();const c=r.peer("c");r.driver.acceptDeliveries=true;r.advance(30000);
    assert.deepEqual(r.store.listMailBatches()[0]?.memberIds,[a.id,b.id]);
    assert.equal(r.store.getMessage(c.id)?.deliveredAt,null);
    r.start();r.end();assert.equal(r.store.listMailBatches().length,2);
    assert.equal(r.store.getMessage(c.id)?.deliveredGeneration,1);r.replay();
    r.restart();r.advance(30000);assert.equal(r.driver.deliveredIds.filter(id=>id===a.id).length,1);
  }finally{r.close();}
});

test("unknown written group reconciles same members atomically across restart",()=>{
  const r=rig(true);try {
    const d=r.driver as ReceiptDriver;const a=r.peer("a"),b=r.peer("b");r.core.step();
    const batch=r.store.listMailBatches()[0]!;assert.equal(d.writes,1);
    const intent=r.store.getDeliveryConfirmationIntent(a.id)!;assert.deepEqual(intent.wireLine!==null&&intent.settlement?.batchMemberIds,[a.id,b.id]);
    r.restart();d.result="unknown";r.advance(31000);assert.equal(d.writes,1);
    r.peer("later");r.human();r.core.step();assert.equal(d.deliveredIds.filter(id=>id===a.id).length,1);
    assert.equal(r.store.getMessage(a.id)?.deliveredAt,null);assert.equal(r.store.getMessage(b.id)?.deliveredAt,null);
    d.result="accepted";r.advance(31000);
    assert.equal(r.store.getMessage(a.id)?.deliveredGeneration,1);assert.equal(r.store.getMessage(b.id)?.deliveredGeneration,1);
    assert.equal(r.store.listMailBatches()[0]?.id,batch.id);r.replay();
    r.restart();r.advance(31000);assert.equal(d.deliveredIds.filter(id=>id===a.id).length,1);
  }finally{r.close();}
});

test("paged digest keeps all UTF8 originals and frozen mutations refuse",()=>{
  const r=rig();try {
    const body="a😀".repeat(20000);const p=r.peer(body);r.driver.acceptDeliveries=false;r.core.step();
    const batch=r.store.listMailBatches()[0]!;
    assert.deepEqual(r.store.cancelMessage(r.bee.id,p.id),{canceled:false,reason:"batch_frozen"});
    assert.deepEqual(r.store.expediteMessage(r.bee.id,p.id,"now"),{applied:false,reason:"batch_frozen"});
    let offset=0,reconstructed="";
    for(;;){const page=r.store.readMailBatch(r.bee.id,batch.id,p.id,offset,16384);reconstructed+=page.body;if(page.nextOffset===null)break;offset=page.nextOffset;}
    assert.equal(reconstructed,body);r.driver.acceptDeliveries=true;r.advance(30000);
    const digest=r.driver.deliveredBodies[0]!;assert.ok(Buffer.byteLength(digest)<=32768);assert.match(digest,/mail.batch.read/);assert.ok(!digest.includes(body));r.replay();
  }finally{r.close();}
});

test("policy off keeps individual legacy now and next delivery",()=>{
  const r=rig();try {
    r.store.setMailBatchingPolicy(r.bee.id,false);r.start();const a=r.peer("a"),b=r.peer("b");r.core.step();r.core.step();
    assert.deepEqual(r.driver.deliveredIds,[a.id,b.id]);assert.equal(r.store.listMailBatches().length,0);r.replay();
  }finally{r.close();}
});

test("held stopped mail defers wake until release and restart enqueues one wake",()=>{
  const r=rig();try {
    r.human();r.core.step();r.start();r.end();
    r.store.enqueueCommand("stop",r.bee.id);for(let i=0;i<4;i++)r.core.step();
    assert.equal(r.store.currentRuntime(r.bee.id)?.state,"stopped");
    const a=r.peer("held"),b=r.peer("held too","now");
    assert.equal(r.store.listCommands({beeId:r.bee.id}).filter(c=>c.verb==="send_wake"&&["queued","running"].includes(c.status)).length,0);
    r.restart();r.advance(119999);
    assert.equal(r.store.currentRuntime(r.bee.id)?.state,"stopped");
    r.advance(1);r.core.step();r.core.step();
    assert.equal(r.store.listCommands({beeId:r.bee.id}).filter(c=>c.verb==="send_wake").length,1);
    assert.deepEqual(r.store.listMailBatches()[0]?.memberIds,[a.id,b.id]);r.replay();
  }finally{r.close();}
});

test("a new human holds a frozen but unwritten batch until next window closes",()=>{
  const r=rig();try {
    r.driver.acceptDeliveries=false;const a=r.peer("old");r.core.step();
    const batch=r.store.listMailBatches()[0]!;
    const human=r.human();r.driver.acceptDeliveries=true;r.advance(30000);
    assert.deepEqual(r.driver.deliveredIds,[human.id]);assert.equal(r.store.getMessage(a.id)?.deliveredAt,null);
    r.start();r.end();r.advance(89999);assert.equal(r.store.getMessage(a.id)?.deliveredAt,null);
    r.advance(1);assert.equal(r.store.listMailBatches()[0]?.id,batch.id);assert.equal(r.store.listMailBatches()[0]?.releaseReason,"window-close");assert.equal(r.store.getMessage(a.id)?.deliveredGeneration,1);r.replay();
  }finally{r.close();}
});

test("batch size is bounded and a held core seed preserves precedence",()=>{
  const r=rig();try {
    const seed=r.store.send(r.bee.id,"role",{origin:"spawn.prompt",urgency:"idle"}).message;
    const peers=Array.from({length:66},(_,i)=>r.peer(`p${i}`));r.start();r.core.step();
    assert.equal(r.store.listMailBatches().length,0);r.end();assert.deepEqual(r.driver.deliveredIds,[seed.id]);
    r.start();r.end();assert.equal(r.store.listMailBatches()[0]?.memberIds.length,64);
    r.start();r.end();assert.equal(r.store.listMailBatches()[1]?.memberIds.length,2);
    assert.equal(r.store.getMessage(peers[65]!.id)?.deliveredGeneration,1);r.replay();
  }finally{r.close();}
});

test("oversized overview shrinks before freeze and sender paging preserves originals",()=>{
  const r=rig();try {
    const sender="human:"+"😀".repeat(10000);
    const messages=Array.from({length:64},(_,i)=>r.store.send(r.bee.id,"z".repeat(2000),{sender:i===0?sender:"x".repeat(200)}).message);
    r.driver.acceptDeliveries=false;r.core.step();const batch=r.store.listMailBatches()[0]!;
    assert.ok(batch.memberIds.length>0&&batch.memberIds.length<64);
    let next:number|null=0,original="";
    while(next!==null){const page=r.store.readMailBatch(r.bee.id,batch.id,messages[0]!.id,next,16384,"sender");original+=page.body;next=page.nextOffset;}
    assert.equal(original,sender);r.driver.acceptDeliveries=true;r.advance(30000);assert.ok(Buffer.byteLength(r.driver.deliveredBodies[0]!)<=32768);r.replay();
  }finally{r.close();}
});

test("a generation-changed unknown group requires explicit whole-group recovery",()=>{
  const r=rig(true);try {
    const d=r.driver as ReceiptDriver,a=r.peer("a"),b=r.peer("b");r.core.step();const batch=r.store.listMailBatches()[0]!;
    d.result="unknown";r.advance(31000);assert.equal(d.writes,1);
    r.store.enqueueCommand("stop",r.bee.id);for(let i=0;i<4;i++)r.core.step();
    r.store.enqueueCommand("revive",r.bee.id);for(let i=0;i<4;i++)r.core.step();
    const gen=r.store.currentRuntime(r.bee.id)!.generation;assert.equal(gen,2);
    r.store.resolveMailBatch(r.bee.id,batch.id,gen,"resend_anyway","resolution");
    r.core.step();assert.equal(d.writes,2);assert.deepEqual(r.store.listMailBatches()[0]?.memberIds,[a.id,b.id]);
    d.result="accepted";r.advance(31000);assert.equal(r.store.getMessage(a.id)?.deliveredGeneration,2);assert.equal(r.store.getMessage(b.id)?.deliveredGeneration,2);r.replay();
  }finally{r.close();}
});

test("whole-group drop is explicit, idempotent and unblocks later background",()=>{
  const r=rig(true);try {
    const d=r.driver as ReceiptDriver,a=r.peer("a");r.core.step();const batch=r.store.listMailBatches()[0]!;d.result="unknown";r.advance(31000);
    const dropped=r.store.resolveMailBatch(r.bee.id,batch.id,1,"drop","drop");assert.ok(dropped.droppedAt!==undefined);
    assert.deepEqual(r.store.resolveMailBatch(r.bee.id,batch.id,1,"drop","drop"),dropped);
    assert.equal(r.store.getMessage(a.id),null);assert.equal(r.store.mailHistory().messages[0]?.lifecycle.state,"canceled");r.replay();
    r.peer("new");r.core.step();assert.equal(r.store.listMailBatches().length,2);
  }finally{r.close();}
});

test("max age releases ordinary group after ten minutes despite a renewed human window",()=>{
  const r=rig();try {
    const peer=r.peer("old");r.human("h1");r.core.step();r.start();r.end();
    for(let i=2;i<=6;i++){r.advance(100000);r.human(`h${i}`);r.core.step();r.start();r.end();}
    r.advance(100000);r.human("h7");r.core.step();r.start();r.end();
    assert.equal(r.store.getMessage(peer.id)?.deliveredAt,null);r.advance(1);
    const batch=r.store.listMailBatches()[0]!;assert.equal(batch.releaseReason,"max-age");assert.equal(r.store.getMessage(peer.id)?.deliveredGeneration,1);r.replay();
  }finally{r.close();}
});

test("release reasons distinguish idle and window close and raw sender metadata is untrusted",()=>{
  const r=rig();try {
    r.store.send(r.bee.id,"urgent blocking_decision",{sender:"human:forged",senderKind:"automation"});r.core.step();
    assert.equal(r.store.listMailBatches()[0]?.releaseReason,"idle");assert.match(r.driver.deliveredBodies[0]!,/"kindTrust":"unverified"/);assert.match(r.driver.deliveredBodies[0]!,/"senderTrust":"unverified"/);
    r.start();r.end();r.human();r.core.step();r.start();r.end();r.peer("after human");r.advance(120000);
    assert.equal(r.store.listMailBatches()[1]?.releaseReason,"window-close");r.replay();
  }finally{r.close();}
});

test("held-only mail never causes release wake churn",()=>{
  const r=rig();try {
    const message=r.peer("held\nmail");for(let i=0;i<3;i++)r.store.recordMultilineDeliveryRefusal(message.id,1,"multiline_type_mode");
    assert.equal(r.store.getMessage(message.id)?.deliveryHold?.stage,"held");
    r.store.enqueueCommand("stop",r.bee.id);for(let i=0;i<4;i++)r.core.step();
    assert.equal(r.store.currentRuntime(r.bee.id)?.state,"stopped");r.restart();r.advance(700000);
    assert.equal(r.store.currentRuntime(r.bee.id)?.generation,1);assert.equal(r.store.currentRuntime(r.bee.id)?.state,"stopped");
    assert.equal(r.store.listCommands({beeId:r.bee.id}).filter(command=>command.verb==="send_wake").length,0);r.replay();
  }finally{r.close();}
});


test("a ready file fallback head joins the digest and settles with its immutable original",()=>{
  const r=rig();try {
    const a=r.peer("a\noriginal");for(let i=0;i<3;i++)r.store.recordMultilineDeliveryRefusal(a.id,1,"multiline_type_mode");
    r.store.prepareMultilineFallback(a.id,r.bee.cwd,[]);
    r.store.transitionMultilineFallback(a.id,"preparing","ready",{path:join(r.bee.cwd,"prepared"),pointer:"prepared",digest:"a".repeat(64),bytes:10});
    assert.throws(()=>r.store.transitionMultilineFallback(a.id,"ready","delivered"),/Invalid/);
    const b=r.peer("b");r.driver.acceptDeliveries=false;r.core.step();
    assert.deepEqual(r.store.listMailBatches()[0]?.memberIds,[a.id,b.id]);
    r.driver.acceptDeliveries=true;r.advance(30000);assert.equal(r.store.getMessage(a.id)?.deliveredGeneration,1);assert.equal(r.store.multilineDelivery(a.id)?.fallback?.state,"delivered");r.replay();
  }finally{r.close();}
});


test("Honeybee receipt notices and action instructions never become digest members",()=>{
  const r=rig();try {
    const target=r.store.createBee({name:"recipient",agent:"stub",substrate:"hsr",cwd:r.bee.cwd}).bee;
    const held=r.store.send(target.id,"held\nmail",{sender:r.bee.id}).message;
    for(let i=0;i<3;i++)r.store.recordMultilineDeliveryRefusal(held.id,1,"multiline_type_mode");
    const notice=r.store.undeliveredMessages(r.bee.id)[0]!;
    assert.equal(r.store.multilineSenderNotice(notice.id),true);
    const peer=r.peer("ordinary after receipt");r.core.step();
    assert.deepEqual(r.driver.deliveredIds,[notice.id]);assert.equal(r.driver.deliveredBodies[0],notice.body);
    assert.equal(r.store.getMessage(peer.id)?.deliveredAt,null);assert.equal(r.store.listMailBatches().length,0);
    r.start();r.end();assert.deepEqual(r.store.listMailBatches()[0]?.memberIds,[peer.id]);r.start();r.end();
    const action=r.store.enqueueActions({beeId:r.bee.id,idempotencyKey:"action",requestHash:"action",items:[{kind:"fix",inputs:{instruction:"fix fixture"}}]}).actions[0]!;
    const dispatch=r.store.dispatchAgentAction(action.id);const later=r.peer("after action");r.core.step();
    assert.equal(r.driver.deliveredIds.at(-1),dispatch.messageId);assert.equal(r.store.getMessage(dispatch.messageId!)?.mailBatchId,undefined);
    assert.equal(r.store.getMessage(later.id)?.deliveredAt,null);r.replay();
  }finally{r.close();}
});

test("legacy frozen action members cannot be removed by cancel or complete",()=>{
  for(const operation of ["cancel","complete"] as const){const r=rig();try {
    const action=r.store.enqueueActions({beeId:r.bee.id,idempotencyKey:"action",requestHash:"action",items:[{kind:"fix",inputs:{instruction:"fix fixture"}}]}).actions[0]!;
    const dispatch=r.store.dispatchAgentAction(action.id);const peer=r.peer("second member");
    const classify=r.store.mailBatchControl;r.store.mailBatchControl=()=>false;
    const batch=r.store.freezeMailBatch(r.bee.id)!;r.store.mailBatchControl=classify;assert.deepEqual(batch.memberIds,[dispatch.messageId,peer.id]);
    assert.throws(()=>operation==="cancel"?r.store.cancelAction(action.id):r.store.completeAction(action.id),/batch_frozen/);
    assert.equal(r.store.getAction(action.id)?.status,"running");assert.ok(r.store.getMessage(dispatch.messageId!));assert.ok(r.store.getMessage(peer.id));
    r.store.resolveMailBatch(r.bee.id,batch.id,1,"drop","drop");
    assert.equal(operation==="cancel"?r.store.cancelAction(action.id).applied:r.store.completeAction(action.id).applied,true);
  }finally{r.close();}}
});

test("unwritten whole groups can be retried or dropped without a confirmation intent",()=>{
  const r=rig();try {
    const peer=r.peer("unwritten");const batch=r.store.freezeMailBatch(r.bee.id)!;
    const retry=r.store.resolveMailBatch(r.bee.id,batch.id,1,"resend_anyway","retry");assert.deepEqual(retry.memberIds,[peer.id]);
    assert.deepEqual(r.store.resolveMailBatch(r.bee.id,batch.id,1,"resend_anyway","retry"),retry);
    const dropped=r.store.resolveMailBatch(r.bee.id,batch.id,1,"drop","drop");assert.ok(dropped.droppedAt!==undefined);
    r.store.setMailBatchingPolicy(r.bee.id,false);r.replay();
  }finally{r.close();}
});

test("a frozen unwritten group still reaches max age after a renewed human admission",()=>{
  const r=rig();try {
    const peer=r.peer("old frozen");const batch=r.store.freezeMailBatch(r.bee.id)!;
    r.human();r.core.step();r.start();r.end();r.driver.acceptDeliveries=false;r.advance(599999);r.human("new human");r.driver.acceptDeliveries=true;r.core.step();r.start();r.end();
    assert.equal(r.store.getMessage(peer.id)?.deliveredAt,null);r.advance(2);
    assert.equal(r.store.listMailBatches()[0]?.id,batch.id);assert.equal(r.store.listMailBatches()[0]?.releaseReason,"max-age");assert.notEqual(r.store.getMessage(peer.id)?.deliveredAt,null);r.replay();
  }finally{r.close();}
});

test("reorder prefixes share the digest byte budget",()=>{
  const r=rig();try {
    const held=r.peer("held\nmail");for(let i=0;i<3;i++)r.store.recordMultilineDeliveryRefusal(held.id,1,"multiline_type_mode");
    const id=held.id+1;
    const predicted={...held,id,sender:"bee-fixture",body:""};
    const template={id:`batch-${r.bee.id}-${id}`,beeId:r.bee.id,memberIds:[id],cutoff:id,policyRevision:1000,frozenAt:1000,releaseReason:"idle" as const,deliveredAt:null,deliveredGeneration:null};
    const overhead=Buffer.byteLength(renderMailBatch(template,[predicted])!);
    const peer=r.peer("x".repeat(32767-overhead));r.core.step();const wire=r.driver.deliveredBodies[0]!;
    const batch=r.store.listMailBatches()[0]!;assert.equal(Buffer.byteLength(renderMailBatch(batch,[r.store.getMessage(peer.id)!])!),32767);assert.match(wire,/bodyRef/);
    assert.match(wire,/delivery_unsupported_multiline/);assert.match(wire,/Background digest/);assert.ok(Buffer.byteLength(wire)<=32768);r.replay();
  }finally{r.close();}
});


test("internal resend strips privileged reference snapshots and preserves ordinary and control kinds",()=>{
  const r=rig();try {
    for(const kind of ["blocking_decision","actionable_warning","obligation-notice","context-notice"] as const){
      const reference={version:1 as const,workspaceId:"fixture",beeId:r.bee.id,kind:"proof" as const,id:kind,status:"open" as const};
      const original=r.store.send(r.bee.id,kind,{automationKind:kind,automationRef:`proof:${kind}`,automationReference:reference}).message;
      r.store.prepareUnknownDeliveryConfirmationIntent({beeId:r.bee.id,messageId:original.id,generation:1},"host_auth_failed");
      const resolved=r.store.resolveDeliveryConfirmation({beeId:r.bee.id,messageId:original.id,generation:1,action:"resend_anyway",idempotencyKey:kind});
      const replay=r.store.getMessage(resolved.replacementMessageId!)!;
      if(kind==="blocking_decision"||kind==="actionable_warning"){
        assert.equal(replay.automationKind,undefined);assert.equal(replay.automationRef,undefined);assert.equal(replay.automationReference,undefined);
      }else{assert.equal(replay.automationKind,kind);assert.deepEqual(replay.automationReference,reference);}
    }
    r.replay();
  }finally{r.close();}
});


test("a legacy group missing a member is recoverable and never stops another bee",()=>{
  for(const missingAnchor of [false,true]){const r=rig();try {
    const a=r.peer("a"),b=r.peer("b");const batch=r.store.freezeMailBatch(r.bee.id)!;
    const db=(r.store as unknown as {db:DatabaseSync}).db;db.prepare("DELETE FROM mailbox WHERE id=?").run(missingAnchor?a.id:b.id);
    assert.deepEqual(r.store.markMailBatchDelivered(batch.id,1),{applied:false});
    const other=r.store.createBee({name:"other",agent:"stub",substrate:"hsr",cwd:r.bee.cwd}).bee;r.store.enqueueCommand("spawn",other.id);for(let i=0;i<4;i++)r.core.step();
    const next=r.store.send(other.id,"unrelated next bee").message;r.core.step();assert.notEqual(r.store.getMessage(next.id)?.deliveredAt,null);
    r.store.resolveMailBatch(r.bee.id,batch.id,1,"drop","recover");assert.ok(r.store.listMailBatches(r.bee.id)[0]?.droppedAt!==undefined);
    const later=r.peer("after recovery");r.core.step();assert.notEqual(r.store.getMessage(later.id)?.deliveredAt,null);
  }finally{r.close();}}
});
