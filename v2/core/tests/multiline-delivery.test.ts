import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceMultilineUnsupported } from "../src/multilineDelivery.ts";

test("unsupported versions never hold; supported off expires after three attempts", () => {
  assert.equal(advanceMultilineUnsupported(null, "multiline_bracketed_paste_version_unsupported", 0).hold, false);
  const first = advanceMultilineUnsupported(null, "multiline_bracketed_paste_disabled", 0);
  const second = advanceMultilineUnsupported(first, "multiline_bracketed_paste_disabled", 100);
  const third = advanceMultilineUnsupported(second, "multiline_bracketed_paste_disabled", 200);
  assert.equal(first.hold, false);
  assert.equal(second.hold, false);
  assert.equal(third.hold, true);
});

test("unsupported time holds at thirty seconds; ordinary busy does not count", () => {
  const first = advanceMultilineUnsupported(null, "multiline_bracketed_paste_disabled", 0);
  assert.equal(advanceMultilineUnsupported(first, "multiline_bracketed_paste_disabled", 30_000).hold, true);
  const busy = advanceMultilineUnsupported(first, undefined, 100_000);
  assert.equal(busy.hold, false);
  assert.equal(busy.attempts, 1);
  assert.equal(busy.unsupportedMs, 0);
  const next = advanceMultilineUnsupported(busy, "multiline_bracketed_paste_disabled", 200_000);
  assert.equal(next.hold, false);
  assert.equal(next.unsupportedMs, 0);
  assert.equal(next.attempts, 2);
});

test("busy bracketed-on recipient never accumulates unsupported attempts", () => {
  let state = advanceMultilineUnsupported(null, undefined, 0);
  for (let index = 1; index <= 10; index++) state = advanceMultilineUnsupported(state, undefined, index * 30_000);
  assert.equal(state.hold, false);
  assert.equal(state.attempts, 0);
  assert.equal(state.unsupportedMs, 0);
});

import { harness, makeBee, bootToRunning } from "./helpers.ts";
import { replayAudit } from "../src/audit.ts";

test("durable bounded wait preserves FIFO, stays visible and replays across reopen", () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const first = store.send(bee.id, "one\ntwo").message;
    const second = store.send(bee.id, "later-one").message;
    const third = store.send(bee.id, "later-two").message;
    const generation = store.currentRuntime(bee.id)!.generation;
    const one = store.recordMultilineDeliveryRefusal(first.id, generation, "multiline_bracketed_paste_disabled")!;
    const two = store.recordMultilineDeliveryRefusal(first.id, generation, "multiline_bracketed_paste_disabled")!;
    assert.equal(one.stage, "waiting");
    assert.equal(two.stage, "waiting");
    const held = store.recordMultilineDeliveryRefusal(first.id, generation, "multiline_bracketed_paste_disabled")!;
    assert.equal(held.stage, "expired");
    assert.equal(held.notice, null);
    assert.deepEqual(store.readDaemonWork()[0]!.pending.map(row => row.id), [first.id, second.id, third.id]);
    assert.deepEqual(store.readDaemonStepInputs().work[0]!.pending.map(row => row.id), [first.id, second.id, third.id]);
    assert.equal(store.getMessage(first.id)!.deliveryHold?.code, "delivery_unsupported_multiline");
    assert.equal(store.pendingMail(bee.id).messages.find(row => row.id === first.id)?.deliveryHold?.code, "delivery_unsupported_multiline");
    assert.equal(store.mailHistory().messages.find(row => row.messageId === first.id)?.deliveryHold?.code, "delivery_unsupported_multiline");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = h.open();
    assert.deepEqual(store.multilineDelivery(first.id), held);
    store.markDelivered(first.id, generation);
    assert.equal(store.multilineDelivery(first.id)?.stage, "delivered");
    store.markDelivered(second.id, generation);
    assert.equal(store.multilineDelivery(first.id)?.notice, null);
    assert.deepEqual(store.readDaemonWork()[0]!.pending.map(row => row.id), [third.id]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

test("static unsupported never holds; busy never holds and inline acceptance completes progress", () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const generation = store.currentRuntime(bee.id)!.generation;
    const immediate = store.send(bee.id, "one\ntwo").message;
    assert.equal(store.recordMultilineDeliveryRefusal(immediate.id, generation, "multiline_bracketed_paste_version_unsupported"), undefined);
    const waiting = store.send(bee.id, "three\nfour").message;
    for (let index = 0; index < 5; index++) assert.equal(store.recordMultilineDeliveryRefusal(waiting.id, generation, undefined), undefined);
    assert.equal(store.recordMultilineDeliveryRefusal(waiting.id, generation, "multiline_type_mode")?.attempts, 1);
    assert.equal(store.recordMultilineDeliveryRefusal(waiting.id, generation, undefined)?.attempts, 1);
    assert.equal(store.recordMultilineDeliveryRefusal(waiting.id, generation, "multiline_type_mode")?.attempts, 2);
    store.markDelivered(waiting.id, generation);
    assert.equal(store.multilineDelivery(waiting.id)?.stage, "delivered");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

import { DatabaseSync } from "node:sqlite";

for (const malformed of ["not-json", "{}", '{"stage":"waiting","attempts":"bad"}']) test(`malformed hold projection is lazy unknown on reopen: ${malformed}`, () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_bracketed_paste_disabled");
    store.close();
    const db = new DatabaseSync(h.path);
    db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(malformed, message.id);
    db.close();
    store = h.open();
    assert.equal(store.getMessage(message.id)?.deliveryHold?.detail, "delivery_hold_state_unknown");
    assert.equal(store.multilineDelivery(message.id)?.stage, "expired");
  } finally { store.close(); h.cleanup(); }
});

test("reorder notice requires an actual later delivery and a still-undelivered original", () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const first = store.send(bee.id, "one\ntwo").message;
    const later = store.send(bee.id, "later").message;
    for (let index = 0; index < 3; index++) store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode");
    assert.equal(store.multilineDelivery(first.id)?.notice, null);
    store.markDelivered(later.id, 1);
    assert.equal(store.multilineDelivery(first.id)?.notice, "delivered later messages; this one is held");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

test("type hold emits one local sender mail receipt atomically and survives reopen", () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store);
    const sender = store.createBee({ name: "sender", agent: "inbox", substrate: "hsr", cwd: "/tmp/sender" }).bee;
    bootToRunning(store, bee.id, 100, 1);
    const original = store.send(bee.id, "one\ntwo", { sender: sender.id }).message;
    for (let index = 0; index < 3; index++) store.recordMultilineDeliveryRefusal(original.id, 1, "multiline_type_mode");
    const hold = store.multilineDelivery(original.id)!;
    assert.equal(hold.stage, "held");
    assert.equal(hold.receipt?.code, "delivery_unsupported_multiline");
    assert.equal(hold.receipt?.delivered, false);
    assert.equal(hold.receipt?.channel, "mail");
    assert.equal(hold.receipt?.heldSince, hold.heldSince);
    const notices = store.listMessages(sender.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.body.includes("\n"), false);
    assert.equal(store.multilineSenderReceipt(notices[0]!.id)?.messageId, original.id);
    assert.deepEqual(store.readDaemonWork()[0]!.pending, []);
    assert.deepEqual(store.readDaemonStepInputs().work[0]!.pending, []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close(); store = h.open();
    store.recordMultilineDeliveryRefusal(original.id, 1, "multiline_type_mode");
    assert.deepEqual(store.multilineDelivery(original.id), hold);
    assert.equal(store.listMessages(sender.id).length, 1);
  } finally { store.close(); h.cleanup(); }
});

for (const sender of ["operator", "remote:node-a/phone-0123456789abcdef"]) test(`operator and remote hold receipt is exposed on original projections: ${sender}`, () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo", { sender }).message;
    for (let index = 0; index < 3; index++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    const receipt = store.getMessage(message.id)?.deliveryHold?.receipt;
    assert.equal(receipt?.code, "delivery_unsupported_multiline");
    assert.equal(receipt?.channel, "mail.history+audit");
    assert.equal(receipt?.senderNoticeMessageId, null);
    assert.deepEqual(store.pendingMail(bee.id).messages[0]?.deliveryHold?.receipt, receipt);
    assert.deepEqual(store.mailHistory().messages[0]?.deliveryHold?.receipt, receipt);
    assert.ok(store.auditRows().some(row => row.kind === "mail.delivery_unsupported_multiline"));
    assert.equal(store.listMessages(bee.id).length, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

for (const malformed of ["not-json", "{}", '{"stage":"waiting","attempts":"bad"}']) test(`malformed waiting reopen becomes type HOLD once without restarting counters: ${malformed}`, () => {
  const h = harness(); let store = h.open();
  try {
    const { bee } = makeBee(store);
    const sender = store.createBee({ name: "sender", agent: "inbox", substrate: "hsr", cwd: "/tmp/sender" }).bee;
    bootToRunning(store, bee.id, 100, 1);
    const first = store.send(bee.id, "one\ntwo", { sender: sender.id }).message;
    const later = store.send(bee.id, "later").message;
    store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode");
    store.close();
    const db = new DatabaseSync(h.path); db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(malformed, first.id); db.close();
    store = h.open();
    const previous = store.multilineDelivery(first.id)!;
    assert.equal(previous.stage, "expired");
    const held = store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode")!;
    assert.equal(held.stage, "held");
    assert.deepEqual([held.attempts, held.unsupportedMs, held.lastAttemptAt], [previous.attempts, previous.unsupportedMs, previous.lastAttemptAt]);
    assert.equal(held.receipt?.code, "delivery_unsupported_multiline");
    assert.deepEqual(store.readDaemonWork()[0]!.pending.map(row => row.id), [later.id]);
    for (let index = 0; index < 3; index++) assert.deepEqual(store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode"), held);
    assert.equal(store.listMessages(sender.id).length, 1);
    assert.equal(store.auditRows().filter(row => row.kind === "mail.delivery_unsupported_multiline").length, 1);
    store.markDelivered(later.id, 1);
    assert.equal(store.getMessage(first.id)?.deliveredAt, null);
    assert.equal(store.multilineDelivery(first.id)?.notice, "delivered later messages; this one is held");
  } finally { store.close(); h.cleanup(); }
});

test("long ordinary busy wait writes no progress or audits and pauses unsupported time", () => {
  const h = harness(); const store = h.open();
  try {
    const { bee } = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    const first = store.send(bee.id, "one\ntwo").message;
    store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode");
    const before = store.multilineDelivery(first.id)!; const audit = store.auditRows();
    for (let index = 0; index < 1000; index++) {
      h.now();
      assert.deepEqual(store.recordMultilineDeliveryRefusal(first.id, 1, undefined), before);
    }
    assert.deepEqual(store.auditRows(), audit);
    const next = store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode")!;
    assert.equal(next.stage, "waiting"); assert.equal(next.attempts, 2); assert.equal(next.unsupportedMs, 0);
  } finally { store.close(); h.cleanup(); }
});

test("retained holds for cancelled or delivered messages are inert", () => {
 const h = harness(); const store = h.open();
 try {
  const {bee}=makeBee(store);bootToRunning(store,bee.id,100,1);
  const cancelled=store.send(bee.id,"one\ntwo").message;const delivered=store.send(bee.id,"three\nfour").message;
  for(const message of [cancelled,delivered])for(let i=0;i<3;i++)store.recordMultilineDeliveryRefusal(message.id,1,"multiline_type_mode");
  store.cancelMessage(bee.id,cancelled.id);store.markDelivered(delivered.id,1);
  assert.equal(store.getMessage(cancelled.id),null);
  assert.equal(store.recordMultilineDeliveryRefusal(cancelled.id,1,"multiline_type_mode"),undefined);
  assert.equal(store.recordMultilineDeliveryRefusal(delivered.id,1,"multiline_type_mode"),undefined);
  assert.deepEqual(store.readDaemonWork()[0]!.pending,[]);assert.deepEqual(store.readDaemonStepInputs().work[0]!.pending,[]);
  assert.equal(store.pendingMail(bee.id).messages.length,0);
  assert.equal(store.pendingMultilineReorderNotice(bee.id,delivered.id+1),null);
  assert.equal(store.multilineDelivery(cancelled.id)?.stage,"held");
  assert.equal(store.multilineDelivery(delivered.id)?.stage,"delivered");
  store.deleteBee(bee.id);
  assert.deepEqual(store.readDaemonWork(),[]);
  assert.equal(store.recordMultilineDeliveryRefusal(delivered.id,1,"multiline_type_mode"),undefined);
  assert.deepEqual(replayAudit(store.auditRows()),store.dumpState());
 }finally{store.close();h.cleanup();}
});

test("reopen never charges unobserved downtime as unsupported wait",()=>{
 const h=harness();let store=h.open();
 try{
  const {bee}=makeBee(store);bootToRunning(store,bee.id,100,1);const m=store.send(bee.id,"one\ntwo").message;
  store.recordMultilineDeliveryRefusal(m.id,1,"multiline_type_mode");store.close();
  for(let i=0;i<100;i++)h.now();store=h.open();
  const next=store.recordMultilineDeliveryRefusal(m.id,1,"multiline_type_mode")!;
  assert.equal(next.stage,"waiting");assert.equal(next.attempts,2);assert.equal(next.unsupportedMs,0);
 }finally{store.close();h.cleanup();}
});

test("same-store runtime stop and new generation cannot charge stopped time",()=>{
 const h=harness();const store=h.open();
 try{
  const {bee}=makeBee(store);bootToRunning(store,bee.id,100,1);const m=store.send(bee.id,"one\ntwo").message;
  store.recordMultilineDeliveryRefusal(m.id,1,"multiline_type_mode");
  store.updateRuntimeState(bee.id,1,"stopped",{exitCause:"stopped_by_user"});
  for(let i=0;i<100;i++)h.now();
  const rt=store.reviveBee(bee.id);bootToRunning(store,bee.id,101,2);
  const next=store.recordMultilineDeliveryRefusal(m.id,rt.generation,"multiline_type_mode")!;
  assert.equal(next.stage,"waiting");assert.equal(next.attempts,2);assert.equal(next.unsupportedMs,0);
  assert.equal(store.recordMultilineDeliveryRefusal(m.id,rt.generation,"multiline_type_mode")!.stage,"held");
 }finally{store.close();h.cleanup();}
});
