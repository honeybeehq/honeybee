import {test} from "node:test";
import assert from "node:assert/strict";
import {openCoreStore} from "../src/store.ts";
import {replayAudit} from "../src/audit.ts";
import {harness, makeBee, bootToRunning} from "./helpers.ts";

test("in-flight age follows the durable pointer claim, warns at five minutes and never settles mail", () => {
  const h = harness();
  let now = 1_000_000;
  let store = openCoreStore(h.path, {now: () => now, ephemeral: true});
  try {
    const {bee} = makeBee(store);
    bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo").message;
    for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    store.prepareMultilineFallback(message.id, "/tmp/data", []);
    store.transitionMultilineFallback(message.id, "preparing", "ready", {path: "/tmp/data/content", pointer: "full text: /tmp/data/content", digest: "a".repeat(64), bytes: 7});
    now += 900_000;
    store.transitionMultilineFallback(message.id, "ready", "in_flight", {generation: 1});
    assert.equal(store.multilineDelivery(message.id)?.lastAttemptAt, now);
    const claimed = store.multilineDelivery(message.id)!;
    assert.equal(claimed.stage, "held");
    assert.notEqual(claimed.heldSince, null);
    assert.deepEqual(store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode"), claimed);
    assert.deepEqual(store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_bracketed_paste_disabled"), claimed);
    assert.deepEqual(store.multilineInFlightDiagnostics(), {count: 1, overdue: 0, oldestAgeMs: 0, thresholdMs: 300_000});
    now += 299_999;
    assert.equal(store.multilineInFlightDiagnostics().overdue, 0);
    now++;
    const seq = store.lastAuditSeq();
    assert.deepEqual(store.multilineInFlightDiagnostics(), {count: 1, overdue: 1, oldestAgeMs: 300_000, thresholdMs: 300_000});
    assert.equal(store.lastAuditSeq(), seq);
    assert.equal(store.getMessage(message.id)?.deliveredAt, null);
    assert.equal(store.multilineDelivery(message.id)?.fallback?.state, "in_flight");
    store.close();
    store = openCoreStore(h.path, {now: () => now, ephemeral: true});
    assert.equal(store.multilineInFlightDiagnostics().oldestAgeMs, 300_000);
    store.transitionMultilineFallback(message.id, "in_flight", "ready");
    now += 10_000;
    store.transitionMultilineFallback(message.id, "ready", "in_flight", {generation: 1});
    assert.equal(store.multilineInFlightDiagnostics().oldestAgeMs, 0);
    assert.equal(store.multilineInFlightDiagnostics(now - 10_000).oldestAgeMs, 0);
    store.recoverInFlightMultilineFallbacks();
    assert.deepEqual(store.multilineInFlightDiagnostics(), {count: 0, overdue: 0, oldestAgeMs: 0, thresholdMs: 300_000});
    assert.equal(store.multilineDelivery(message.id)?.fallback?.state, "unknown");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {store.close(); h.cleanup();}
});

test("unsupported pane-options hold sends one truthful sender notice and never re-enters unsupported progress", () => {
  const h = harness(), store = h.open();
  try {
    const {bee} = makeBee(store);
    const sender = makeBee(store, "sender").bee;
    bootToRunning(store, bee.id, 100, 1);
    const message = store.send(bee.id, "one\ntwo", {sender: sender.id}).message;
    for (let i = 0; i < 3; i++) store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode");
    store.prepareMultilineFallback(message.id, "/tmp/data", []);
    store.transitionMultilineFallback(message.id, "preparing", "ready", {path: "/tmp/data/content", pointer: "full text: /tmp/data/content", digest: "a".repeat(64), bytes: 7});
    store.transitionMultilineFallback(message.id, "ready", "in_flight", {generation: 1});
    const held = store.transitionMultilineFallback(message.id, "in_flight", "held", {detail: "pane_options_unsupported", attempts: 1, attemptPhase: "before_enter_cleared"})!;
    assert.ok(held.senderNoticeMessageId);
    const notice = store.getMessage(held.senderNoticeMessageId!)!;
    assert.ok(notice.body.includes("is held"));
    assert.ok(notice.body.includes("pane_options_unsupported"));
    assert.ok(notice.body.includes("full text: /tmp/data/content"));
    const row = store.multilineDelivery(message.id)!;
    assert.deepEqual(store.recordMultilineDeliveryRefusal(message.id, 1, "multiline_type_mode"), row);
    assert.deepEqual(store.transitionMultilineFallback(message.id, "in_flight", "held"), held);
    assert.equal(store.listMessages(sender.id).filter(mail => mail.body.includes("pane_options_unsupported")).length, 1);
    assert.equal(store.getMessage(message.id)?.deliveryFallback?.state, "held");
    assert.equal(store.getMessage(message.id)?.deliveredAt, null);
  } finally {store.close(); h.cleanup();}
});
