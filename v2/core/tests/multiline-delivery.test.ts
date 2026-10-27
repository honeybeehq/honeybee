import { test } from "node:test";
import * as jsoncRuntime from "jsonc-parser";
import assert from "node:assert/strict";
import { advanceMultilineUnsupported, MULTILINE_JSON_TOKEN, MULTILINE_JSON_SCAN_ERROR_NONE, MULTILINE_UNKNOWN_SQL, readMultilineDelivery, readDeliveryFallback, type DeliveryFallback } from "../src/multilineDelivery.ts";

test("duplicate scanner token constants match the installed jsonc-parser runtime", () => {
  const runtime = jsoncRuntime as unknown as {SyntaxKind: Record<string, number>; ScanError: Record<string, number>};
  for (const [name, value] of Object.entries(MULTILINE_JSON_TOKEN)) assert.equal(value, runtime.SyntaxKind[name], name);
  assert.equal(MULTILINE_JSON_SCAN_ERROR_NONE, runtime.ScanError.None);
});

test("unsupported versions expire immediately; supported off expires after three attempts", () => {
  assert.equal(advanceMultilineUnsupported(null, "multiline_bracketed_paste_version_unsupported", 0).hold, true);
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

test("static unsupported expires immediately; busy never holds and inline acceptance completes progress", () => {
  const h = harness(), store = h.open();
  try {
    const { bee } = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const generation = store.currentRuntime(bee.id)!.generation;
    const immediate = store.send(bee.id, "one\ntwo").message;
    assert.equal(store.recordMultilineDeliveryRefusal(immediate.id, generation, "multiline_bracketed_paste_version_unsupported")?.stage, "expired");
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
    store.markDelivered(later.id, 1, undefined, store.multilineReorderNotice(bee.id, later.id).messageIds);
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

for (const malformed of ["not-json", "{}", '{"stage":"waiting","attempts":"bad"}']) test(`malformed waiting reopen becomes visible UNKNOWN without reattempt and lets later mail flow: ${malformed}`, () => {
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
    assert.equal(held.receipt, null);
    assert.equal(store.countUnknownMultilineHolds(), 1);
    assert.equal(held.detail, "delivery_hold_state_unknown"); assert.equal(held.fallback?.state, "unknown");
    assert.deepEqual(store.readDaemonWork()[0]!.pending.map(row => row.id), [later.id]);
    for (let index = 0; index < 3; index++) assert.deepEqual(store.recordMultilineDeliveryRefusal(first.id, 1, "multiline_type_mode"), held);
    assert.equal(store.listMessages(sender.id).length, 0);
    assert.equal(store.auditRows().filter(row => row.kind === "mail.delivery_fallback_unknown").length, 1);
    store.markDelivered(later.id, 1, undefined, store.multilineReorderNotice(bee.id, later.id).messageIds);
    assert.equal(store.getMessage(first.id)?.deliveredAt, null);
    assert.equal(store.multilineDelivery(first.id)?.notice, "state unknown, may have been delivered");
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

for (const invalid of ["zero_generation", "negative_generation", "mismatched_generation", "pane", "socket", "identity", "phase", "attempts", "negative_since", "negative_cleared"] as const) test(`malformed pane fence ${invalid} projects UNKNOWN without an identity or automatic-clear authority`, () => {
  const row: DeliveryFallback = {code: "delivery_file_fallback", state: "unknown", id: "00000000-0000-4000-8000-000000000000", ownerStoreId: "owner", root: "/data", worktrees: [], path: "/data/content", pointer: "full text: /data/content", digest: "a".repeat(64), bytes: 10, generation: 1, detail: "pane_input_unknown", senderNoticeMessageId: null, attempts: 1, attemptPhase: "before_enter_unknown", paneInput: {code: "pane_input_unknown", generation: 1, since: 1000, reason: "unverified_clear", socketPath: "/runtime/t.sock", paneId: "%1", serverIdentity: "1:2:3.5:4:5.5"}};
  assert.equal(readDeliveryFallback(row), row);
  switch (invalid) {
    case "zero_generation": row.paneInput!.generation = 0; break;
    case "negative_generation": row.paneInput!.generation = -1; break;
    case "mismatched_generation": row.paneInput!.generation = 2; break;
    case "pane": row.paneInput!.paneId = "recycled"; break;
    case "socket": row.paneInput!.socketPath = "relative.sock"; break;
    case "identity": row.paneInput!.serverIdentity = "unknown"; break;
    case "phase": row.attemptPhase = "before_enter_cleared"; break;
    case "attempts": row.attempts = 0; break;
    case "negative_since": row.paneInput!.since = -1; break;
    case "negative_cleared": row.paneInput!.clearedAt = -1; break;
  }
  const held = readDeliveryFallback(row)!;
  assert.equal(held.state, "unknown"); assert.equal(held.id, ""); assert.equal(held.generation, null); assert.equal(held.paneInput, undefined);
});

for (const content of ["{}", "nested", "valid"]) test(`unknown count matches projection immediately after reopen before normalization: ${content}`, () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    store.close();
    const db = new DatabaseSync(h.path);
    const raw = db.prepare("SELECT row_json FROM multiline_delivery WHERE message_id = ?").get(message.id) as {row_json: string};
    const body = JSON.parse(raw.row_json);
    if (content === "nested") body.fallback = {state: "ready"};
    db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(content === "{}" ? "{}" : JSON.stringify(body), message.id); db.close();
    store = h.open();
    assert.equal(store.countUnknownMultilineHolds(), content === "valid" ? 0 : 1);
    assert.equal(store.multilineDelivery(message.id)?.detail === "delivery_hold_state_unknown", content !== "valid");
  } finally {store.close(); h.cleanup();}
});

test("SQL unknown count agrees with decoder for outer and fallback shape boundaries without normalization", () => {
  const h = harness(); const store = h.open();
  try {
    const {bee} = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    for (let index = 0; index < 3; index++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    store.close();
    const db = new DatabaseSync(h.path);
    try {
      const raw = db.prepare("SELECT * FROM multiline_delivery WHERE message_id = ?").get(message.id) as {row_json: string; held_at: number; held_since: number};
      const base = JSON.parse(raw.row_json);
      const fallback: DeliveryFallback = {code: "delivery_file_fallback", state: "ready", id: "00000000-0000-4000-8000-000000000000", ownerStoreId: "owner", root: "/data", worktrees: [], path: "/data/content", pointer: "full text: /data/content", digest: "a".repeat(64), bytes: 10, generation: 1, detail: null, senderNoticeMessageId: null};
      const pane = {code: "pane_input_unknown", generation: 1, since: 1000, reason: "unverified_clear", socketPath: "/runtime/t.sock", paneId: "%1", serverIdentity: "1:2:3.5:4:5.5"};
      const cases: unknown[] = [base, {...base, fallback}, {...base, fallback: {...fallback, state: "held", attempts: 1, attemptPhase: "before_enter_cleared", paneInput: pane}}];
      for (const key of Object.keys(base)) {
        const missing = {...base}; delete missing[key]; cases.push(missing);
        for (const value of [null, true, 0, "", [], {}]) cases.push({...base, [key]: value});
      }
      for (const key of Object.keys(fallback)) {
        const missing = {...fallback} as Record<string, unknown>; delete missing[key]; cases.push({...base, fallback: missing});
        for (const value of [null, true, -1, 0, "", [], {}]) cases.push({...base, fallback: {...fallback, [key]: value}});
      }
      for (const key of Object.keys(pane)) for (const value of [null, true, -1, 0, "", [], {}]) cases.push({...base, fallback: {...fallback, state: "held", attempts: 1, attemptPhase: "before_enter_cleared", paneInput: {...pane, [key]: value}}});
      for (const key of ["id", "digest"]) for (const suffix of ["\x00", "\n", "\r", "\u2028", "\u2029"]) cases.push({...base, fallback: {...fallback, [key]: String(fallback[key as "id" | "digest"]) + suffix}});
      for (const key of ["reason", "paneId", "serverIdentity"]) for (const suffix of ["\x00", "\n", "\r", "\u2028", "\u2029"]) cases.push({...base, fallback: {...fallback, state: "held", attempts: 1, attemptPhase: "before_enter_cleared", paneInput: {...pane, [key]: pane[key as "reason" | "paneId" | "serverIdentity"] + suffix}}});
      const jsonVectors = cases.map(candidate => JSON.stringify(candidate));
      const numericBase = {...base, fallback: {...fallback, state: "held", attempts: 1, attemptPhase: "before_enter_cleared", paneInput: {...pane, clearedAt: 0}}};
      const numericPaths = ["messageId", "heldAt", "heldSince", "attempts", "unsupportedMs", "lastAttemptAt", "receipt.messageId", "receipt.heldSince", "receipt.senderNoticeMessageId", "fallback.bytes", "fallback.generation", "fallback.attempts", "fallback.senderNoticeMessageId", "fallback.paneInput.since", "fallback.paneInput.generation", "fallback.paneInput.clearedAt"];
      for (const path of numericPaths) for (const literal of ["-9223372036854775808", "9223372036854775807", "1e309", "-1e309", "-0"]) {
        const row = JSON.parse(JSON.stringify(numericBase));
        const parts = path.split("."); let parent = row;
        for (const key of parts.slice(0, -1)) parent = parent[key];
        parent[parts[parts.length - 1]!] = "numeric-literal";
        jsonVectors.push(JSON.stringify(row).replace('"numeric-literal"', literal));
      }
      const original = JSON.stringify(base);
      const append = (raw: string): string => original.slice(0, -1) + "," + raw + "}";
      const semanticStart = jsonVectors.length;
      jsonVectors.push(
        append('"detail":"delivery_hold_state_unknown"'),
        original.replace('"detail":"multiline_type_mode"', '"detail":"delivery_hold_state_unknown","detail":"multiline_type_mode"'),
        append('"fallback":' + JSON.stringify(fallback) + ',"fallback":{"state":"ready"}'),
        append('"fallback":{"state":"ready"},"fallback":' + JSON.stringify(fallback)),
        append('"fallback":' + JSON.stringify(fallback).replace('"generation":1', '"generation":1,"generation":"wrong"')),
        append('"fallback":' + JSON.stringify(fallback).replace('"generation":1', '"generation":"wrong","generation":1')),
        append('"extra":[{"a":1,"a":2}]'),
        append('"extra":[{"a":2,"a":1}]'),
        append('"extra":{"a":1,"b":{"a":2}}'),
        append('"extra":[{"a":1},{"a":2}]'),
        append(String.raw`"extra":{"a":1,"\u0061":2}`),
        append(String.raw`"extra":{"\u0061":2,"a":1}`),
        append('"extra":NaN'), append('"extra":/*comment*/0'), append('"extra":[0,]'),
        append('"extra":"' + String.fromCharCode(1) + '"'),
      );
      assert.equal(db.prepare("SELECT sqlite_version() AS version").get()!.version, process.versions.sqlite);
      assert.deepEqual(db.prepare("SELECT key FROM json_tree(?) WHERE parent = 0").all(String.raw`{"a":1,"\u0061":2}`).map(row => row.key), ["a", "a"]);
      for (const depth of [1000, 1001]) {
        const raw = "[".repeat(depth) + "0" + "]".repeat(depth);
        assert.equal((db.prepare("SELECT json_valid(?) AS valid").get(raw) as {valid: number}).valid, depth === 1000 ? 1 : 0);
        const parent = append('"extra":' + "[".repeat(depth - 1) + "0" + "]".repeat(depth - 1));
        jsonVectors.push(parent);
      }
      for (const [vectorIndex, json] of jsonVectors.entries()) {
        db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(json, message.id);
        const decoded = readMultilineDelivery(json, message.id, bee.id, raw.held_at, raw.held_since);
        const expected = decoded.detail === "delivery_hold_state_unknown" || decoded.fallback?.state === "unknown";
        if (vectorIndex >= semanticStart && vectorIndex < semanticStart + 16) assert.equal(expected, ![semanticStart + 8, semanticStart + 9].includes(vectorIndex), json);
        if (vectorIndex >= semanticStart + 16) assert.equal(expected, vectorIndex === semanticStart + 17, json);
        let count: number | undefined;
        assert.doesNotThrow(() => {count = Number((db.prepare(`SELECT COUNT(*) AS count FROM multiline_delivery WHERE ${MULTILINE_UNKNOWN_SQL}`).get() as {count: number}).count);}, json);
        assert.equal(count, expected ? 1 : 0, json);
      }
    } finally {db.close();}
  } finally {h.cleanup();}
});

for (const order of ["first", "last"] as const) test(`duplicate descriptors stay unknown across acting selectors: ${order}`, () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    store.close();
    let db = new DatabaseSync(h.path);
    const raw = db.prepare("SELECT row_json FROM multiline_delivery WHERE message_id = ?").get(message.id) as {row_json: string};
    const base = JSON.parse(raw.row_json);
    const fallback: DeliveryFallback = {code: "delivery_file_fallback", state: "in_flight", id: "00000000-0000-4000-8000-000000000000", ownerStoreId: "owner", root: "/data", worktrees: [], path: "/data/content", pointer: "full text: /data/content", digest: "a".repeat(64), bytes: 10, generation: 1, detail: null, senderNoticeMessageId: 999};
    for (const state of ["removed", "held", "delivered", "in_flight", "notice", "nested", "pane"]) {
      const pane = {code: "pane_input_unknown", generation: 1, since: 1000, reason: "unverified_clear", socketPath: "/runtime/t.sock", paneId: "%1", serverIdentity: "1:2:3.5:4:5.5"};
      const good = JSON.stringify({...fallback, state: state === "notice" || state === "nested" || state === "pane" ? "in_flight" : state, ...(state === "pane" ? {attempts: 1, attemptPhase: "injecting", paneInput: pane} : {})});
      let duplicate = order === "first" ? good.slice(0, -1) + ',"state":"ready"}' : good.replace('"state":' + JSON.stringify(state), '"state":"ready","state":' + JSON.stringify(state));
      if (state === "notice") duplicate = good.replace('"senderNoticeMessageId":999', order === "first" ? '"senderNoticeMessageId":999,"senderNoticeMessageId":998' : '"senderNoticeMessageId":998,"senderNoticeMessageId":999');
      if (state === "nested") duplicate = good.slice(0, -1) + ',"extra":{"a":1,"a":2}}';
      if (state === "pane") duplicate = good.replace('"paneId":"%1"', order === "first" ? '"paneId":"%1","paneId":"%2"' : '"paneId":"%2","paneId":"%1"');
      db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(JSON.stringify({...base, fallback}).replace(JSON.stringify(fallback), duplicate), message.id);
      db.close();
      store = h.open();
      assert.equal(store.multilineDelivery(message.id)?.detail, "delivery_hold_state_unknown");
      assert.equal(store.heldMultilineMail().get(bee.id)?.[0]?.fallback?.state, "unknown");
      assert.equal(store.multilineSenderNotice(999), false);
      assert.deepEqual(store.multilinePaneQuarantines(), []);
      const before = store.auditRows();
      store.recoverInFlightMultilineFallbacks();
      assert.deepEqual(store.auditRows(), before);
      assert.equal(store.multilineDelivery(message.id)?.fallback?.id, "");
      store.close();
      db = new DatabaseSync(h.path);
    }
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE multiline_delivery SET bee_id = ? WHERE message_id = ?").run("deleted-bee", message.id);
    db.close();
    store = h.open();
    assert.equal(store.deletedMultilineFiles()[0]?.fallback?.state, "unknown");
    assert.equal(store.deletedMultilineFiles()[0]?.fallback?.path, null);
  } finally {store.close(); h.cleanup();}
});

test("metadata byte cap agrees in decoder and SQL before parsing", () => {
  const h = harness(); const store = h.open();
  try {
    const {bee} = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    const base = store.multilineDelivery(message.id)!;
    store.close();
    const db = new DatabaseSync(h.path);
    try {
      assert.equal(db.prepare("PRAGMA encoding").get()!.encoding, "UTF-8");
      for (const [bytes, marker] of [[1024 * 1024, ""], [1024 * 1024 + 1, ""], [1024 * 1024, "😀"], [1024 * 1024 + 1, "😀"]] as const) {
        const prefix = JSON.stringify({...base, extra: ""});
        const json = prefix.replace('"extra":""', '"extra":"' + marker + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(marker)) + '"');
        assert.equal(Buffer.byteLength(json), bytes);
        db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(json, message.id);
        assert.equal(readMultilineDelivery(json, message.id, bee.id, base.heldAt, base.heldSince).detail === "delivery_hold_state_unknown", bytes > 1024 * 1024);
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM multiline_delivery WHERE ${MULTILINE_UNKNOWN_SQL}`).get()!.count, bytes > 1024 * 1024 ? 1 : 0);
      }
      const valid = JSON.stringify(base);
      db.prepare("INSERT INTO multiline_delivery VALUES(?,?,?,?,?,?)").run(message.id + 1, bee.id, base.heldAt, base.heldSince, null, valid.replace('"messageId":' + message.id, '"messageId":' + (message.id + 1)));
      db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run("not-json", message.id);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM multiline_delivery WHERE ${MULTILINE_UNKNOWN_SQL}`).get()!.count, 1);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM multiline_delivery WHERE CASE WHEN ${MULTILINE_UNKNOWN_SQL} THEN 0 ELSE 1 END`).get()!.count, 1);
      const oversized = '{"extra":"' + "é".repeat(600_000) + '"';
      db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(oversized, message.id);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM multiline_delivery WHERE ${MULTILINE_UNKNOWN_SQL}`).get()!.count, 1);
    } finally {db.close();}
  } finally {h.cleanup();}
});

for (const held of [false, true]) for (const corruption of ["malformed", "ready-first", "ready-last"] as const) test(`batch skips 65 unknown descriptors before its cap and releases later mail: ${corruption}, held=${held}`, () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    store.setMailBatchingPolicy(bee.id, true);
    const ids: number[] = [];
    for (let i = 0; i < 65; i++) {
      const message = store.send(bee.id, "one\ntwo").message;
      ids.push(message.id);
      for (let attempt = 0; attempt < (held ? 3 : 1); attempt++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    }
    for (let i = 0; i < 650; i++) h.now();
    const later = store.send(bee.id, "later").message;
    store.close();
    const db = new DatabaseSync(h.path);
    for (const id of ids) {
      const raw = db.prepare("SELECT row_json FROM multiline_delivery WHERE message_id = ?").get(id) as {row_json: string};
      const fallback: DeliveryFallback = {code: "delivery_file_fallback", state: "ready", id: "00000000-0000-4000-8000-000000000000", ownerStoreId: "owner", root: "/data", worktrees: [], path: "/data/content", pointer: "full text: /data/content", digest: "a".repeat(64), bytes: 10, generation: 1, detail: null, senderNoticeMessageId: null};
      let json = JSON.stringify({...JSON.parse(raw.row_json), fallback});
      json = corruption === "malformed" ? "not-json" : json.replace('"state":"ready"', corruption === "ready-first" ? '"state":"ready","state":"removed"' : '"state":"removed","state":"ready"');
      db.prepare("UPDATE multiline_delivery SET row_json = ? WHERE message_id = ?").run(json, id);
    }
    db.close(); store = h.open();
    assert.equal(store.countUnknownMultilineHolds(), 65);
    for (const id of ids) assert.equal(store.mailBatchCandidate(id), false);
    assert.equal(store.mailBatchReleaseReason(bee.id), "idle");
    const bodyReads: number[] = [];
    const getMessage = store.getMessage.bind(store);
    store.getMessage = id => {bodyReads.push(id); return getMessage(id);};
    assert.deepEqual(store.freezeMailBatch(bee.id)?.memberIds, [later.id]);
    assert.deepEqual(bodyReads, [later.id]);
    store.getMessage = getMessage;
    for (const id of ids) assert.equal(store.mailBatchForMessage(id), null);
    if (held) assert.equal(store.readDaemonWork()[0]?.pending.some(row => ids.includes(row.id)), false);
  } finally {store.close(); h.cleanup();}
});

test("positive selector prefilters preserve escaped keys and reject duplicate descriptors", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store); bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    const base = store.multilineDelivery(message.id)!;
    const fallback: DeliveryFallback = {code: "delivery_file_fallback", state: "in_flight", id: "00000000-0000-4000-8000-000000000000", ownerStoreId: "owner", root: "/data", worktrees: [], path: "/data/content", pointer: "full text: /data/content", digest: "a".repeat(64), bytes: 10, generation: 1, detail: null, senderNoticeMessageId: 999, attempts: 1, attemptPhase: "injecting", paneInput: {code: "pane_input_unknown", generation: 1, since: 1000, reason: "unverified_clear", socketPath: "/runtime/t.sock", paneId: "%1", serverIdentity: "1:2:3.5:4:5.5"}};
    store.close();
    const corrupt = new DatabaseSync(h.path);
    for (const [offset, json] of [[1, "not-json"], [2, '{"extra":"' + "x".repeat(1024 * 1024)]] as const) {
      corrupt.prepare("INSERT INTO multiline_delivery VALUES(?,?,?,?,?,?)").run(message.id + offset, bee.id, base.heldAt, base.heldSince, null, json);
    }
    corrupt.close();
    const escaped = JSON.stringify({...base, fallback}).replace('"fallback":', String.raw`"\u0066allback":`).replace('"state":', String.raw`"\u0073tate":`).replace('"senderNoticeMessageId":999', String.raw`"\u0073enderNoticeMessageId":999`).replace('"paneInput":', String.raw`"\u0070aneInput":`);
    for (const duplicate of [false, true]) {
      const db = new DatabaseSync(h.path);
      db.prepare("UPDATE multiline_delivery SET row_json=? WHERE message_id=?").run(duplicate ? escaped.slice(0, -1) + ',"extra":{"a":1,"a":2}}' : escaped, message.id);
      db.close(); store = h.open();
      assert.equal(store.multilineSenderNotice(999), !duplicate);
      assert.equal(store.multilinePaneQuarantines().length, duplicate ? 0 : 1);
      store.recoverInFlightMultilineFallbacks();
      assert.equal(store.multilineDelivery(message.id)?.fallback?.detail, duplicate ? "delivery_hold_state_unknown" : "delivery_pointer_daemon_restarted");
      store.close();
    }
  } finally {store.close(); h.cleanup();}
});
