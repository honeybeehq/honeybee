import { quietReply } from "../src/quiet.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { HumanOutputError, IdempotencyConflictError, openCoreStore, reactionEmoji, replayAudit, tellText, type CoreStore } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

function setup(store: CoreStore) {
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 7, 7);
  store.setHumanOutputMode(bee.id, "explicit", "mode");
  return bee;
}
function human(store: CoreStore, beeId: string) {
  const { message } = store.send(beeId, "hello", { sender: "operator", senderKind: "human" });
  store.markDelivered(message.id, store.currentRuntime(beeId)!.generation, { kind: "human", from: "operator" });
  return message;
}
const failure = (code: string) => (error: unknown) => error instanceof HumanOutputError && error.code === code;

test("human output: UTF-8 byte limit and exactly one RGI emoji grapheme", () => {
  for (const emoji of ["👍", "👍🏽", "👩‍💻", "🇳🇴", "1️⃣", "❤️", "🏳️‍🌈"]) assert.equal(reactionEmoji(emoji), emoji);
  for (const emoji of ["ok", "a", "1", "#", "👍👍", "👍hello", "", "\ud800", "👍\0", "🏽", "a\u200d👍"]) assert.throws(() => reactionEmoji(emoji), failure("react_emoji_invalid"));
  assert.equal(tellText("ø".repeat(8192)), "ø".repeat(8192));
  for (const value of ["ø".repeat(8193), "x\0", "\ud800", " "]) assert.throws(() => tellText(value), failure("tell_text_invalid"));
});

test("human output: H1/tell/H2 same turn, oldest pending, targeted react and cross-turn plain tell", t => {
  const h = harness(); t.after(h.cleanup); const store = h.open(); t.after(() => store.close());
  const bee = setup(store);
  const one = human(store, bee.id);
  const tell = store.tellHuman({ beeId: bee.id, text: "first reply", idempotencyKey: "tell-1" }).tell;
  assert.ok(tell.acknowledgedDeliveryRange);
  const two = human(store, bee.id), three = human(store, bee.id);
  assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.humanAt, one.deliveredAt ?? store.getMessage(one.id)!.deliveredAt);
  assert.equal(store.view(bee.id).unansweredHumanMessage!.messageId, two.id);
  const outputAt = store.getBee(bee.id)!.lastHumanOutputAt;
  store.reactHuman({ beeId: bee.id, messageId: three.id, emoji: "👍", idempotencyKey: "react" });
  assert.equal(store.getBee(bee.id)!.lastHumanOutputAt, outputAt);
  assert.equal(store.view(bee.id).unansweredHumanMessage!.messageId, two.id);
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  assert.equal(store.getBee(bee.id)!.lastHumanOutputAt, outputAt, "transcript completion is not explicit output");
  store.updateRuntimeState(bee.id, 1, "running");
  store.tellHuman({ beeId: bee.id, text: "automation re-prompt reply", idempotencyKey: "tell-2" });
  assert.equal(store.view(bee.id).unansweredHumanMessage, null);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
});

test("human output: same-ms delivery sequence and targeted tell frontier", t => {
  const h = harness(); t.after(h.cleanup); const store = openCoreStore(h.path, { now: () => 42, ephemeral: true }); t.after(() => store.close());
  const bee = setup(store), one = human(store, bee.id), two = human(store, bee.id);
  store.tellHuman({ beeId: bee.id, text: "one", replyTo: one.id, idempotencyKey: "one" });
  assert.equal(store.view(bee.id).unansweredHumanMessage!.messageId, two.id);
  store.tellHuman({ beeId: bee.id, text: "two", idempotencyKey: "two" });
  const three = human(store, bee.id);
  assert.equal(store.view(bee.id).unansweredHumanMessage!.messageId, three.id);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
});

test("human output: replay survives restart and opt-out, conflicting keys and targets refuse", t => {
  const h = harness(); t.after(h.cleanup); let store = h.open(); const bee = setup(store), target = human(store, bee.id);
  const params = { beeId: bee.id, text: "answer", replyTo: target.id, idempotencyKey: "same" };
  const original = store.tellHuman(params);
  const reactionParams = { beeId: bee.id, messageId: target.id, emoji: "👍", idempotencyKey: "same" };
  const reaction = store.reactHuman(reactionParams);
  store.setHumanOutputMode(bee.id, "legacy", "off");
  store.close(); store = h.open(); t.after(() => store.close());
  const seq = store.lastAuditSeq();
  assert.deepEqual(store.tellHuman(params), { ...original, deduped: true });
  assert.deepEqual(store.reactHuman(reactionParams), { ...reaction, deduped: true });
  assert.equal(store.lastAuditSeq(), seq);
  assert.throws(() => store.tellHuman({ ...params, text: "changed" }), IdempotencyConflictError);
  assert.throws(() => store.tellHuman({ ...params, idempotencyKey: "new" }), failure("human_output_mode_legacy"));
  const replayMode = store.setHumanOutputMode(bee.id, "explicit", "mode");
  assert.equal(replayMode.humanOutputMode, "explicit", "receipt retains original outcome");
  assert.equal(store.getBee(bee.id)!.humanOutputMode, "legacy", "replayed enable cannot undo later disable");
  store.setHumanOutputMode(bee.id, "explicit", "on-again");
  const peer = store.send(bee.id, "agent mail", { sender: "peer", senderKind: "automation" }).message;
  store.markDelivered(peer.id, 1, { kind: "mail", from: "peer" });
  const queued = store.send(bee.id, "undelivered", { senderKind: "human" }).message;
  for (const messageId of [peer.id, queued.id, 999999]) assert.throws(() => store.reactHuman({ ...reactionParams, messageId, idempotencyKey: `bad-${messageId}` }), failure("human_output_target_invalid"));
  const other = makeBee(store, "other").bee;
  store.setHumanOutputMode(other.id, "explicit", "mode");
  assert.throws(() => store.tellHuman({ ...params, beeId: other.id }), failure("human_output_target_invalid"));
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
});

test("human output: question.answer delivery is human with answer triggerKind", t => {
  const h = harness(); t.after(h.cleanup); const store = h.open(); t.after(() => store.close());
  const bee = setup(store);
  const question = store.askQuestion(bee.id, { text: "continue?" });
  const { send } = store.answerQuestion(question.id, "yes");
  store.markDelivered(send.message.id, 1, { kind: "mail", from: "rpc" });
  assert.equal(store.view(bee.id).unansweredHumanMessage!.triggerKind, "answer");
  store.reactHuman({ beeId: bee.id, messageId: send.message.id, emoji: "✅", idempotencyKey: "answer" });
  assert.equal(store.view(bee.id).unansweredHumanMessage, null);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
});

test("human output: audit insertion failure rolls back row, ack and timestamp", t => {
  const h = harness(); t.after(h.cleanup); let store = h.open(); const bee = setup(store); human(store, bee.id);
  const before = store.dumpState(); store.close();
  const db = new DatabaseSync(h.path);
  db.exec("CREATE TRIGGER refuse_tell BEFORE INSERT ON audit WHEN NEW.kind='bee.told' BEGIN SELECT RAISE(ABORT,'injected tell failure'); END"); db.close();
  store = h.open();
  assert.throws(() => store.tellHuman({ beeId: bee.id, text: "rollback", idempotencyKey: "rollback" }), /injected tell failure/);
  assert.deepEqual(store.dumpState(), before);
  store.close();
});

test("human output: bounded visible marker, immutable phone assurance and deletion cleanup", t => {
  const h = harness(); t.after(h.cleanup); const store = h.open(); t.after(() => store.close());
  const bee = setup(store), messageIds: number[] = [];
  for (let index = 0; index < 66; index++) messageIds.push(human(store, bee.id).id);
  const tell = store.tellHuman({ beeId: bee.id, text: "all acknowledged", idempotencyKey: "many" }).tell;
  assert.deepEqual(tell.acknowledgedMessageIds, messageIds.slice(0, 64)); assert.equal(tell.acknowledgedOverflow, 2);
  assert.equal(store.view(bee.id).unansweredHumanMessage, null);
  const phone = store.send(bee.id, "phone", { phone: { key: "phone", origin: {
    format: "honeybee.phone-origin/1", channel: "phone", issuerNodeId: "node", assigner: "listener", credentialRef: "device", target: { kind: "bee", id: bee.id }, contentKind: "message", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete",
  } } }).message;
  store.markDelivered(phone.id, 1, { kind: "other", from: "operator" });
  const fact = store.view(bee.id).unansweredHumanMessage!;
  assert.equal(fact.phoneOrigin!.humanApproval, "not-verified");
  assert.deepEqual(fact.phoneOrigin, phone.phoneInput!.envelope);
  store.tellHuman({ beeId: bee.id, text: "phone acknowledged", replyTo: phone.id, idempotencyKey: "phone" });
  assert.equal(store.getMessage(phone.id)!.phoneInput!.envelope.humanApproval, "not-verified");
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.deleteBee(bee.id);
  assert.deepEqual(store.listTells(), []); assert.deepEqual(store.listReactions(), []);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
});

test("human output: generation provenance fences stale turn references and replays old outcomes", t => {
  const h = harness(); t.after(h.cleanup); const store = h.open(); t.after(() => store.close());
  const bee = setup(store); human(store, bee.id);
  const params = { beeId: bee.id, text: "generation one", idempotencyKey: "generation-one" };
  const old = store.tellHuman(params);
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  store.reviveBee(bee.id); bootToRunning(store, bee.id, 8, 8);
  assert.deepEqual(store.tellHuman(params), { ...old, deduped: true });
  const current = store.tellHuman({ beeId: bee.id, text: "generation two", idempotencyKey: "generation-two" }).tell;
  assert.equal(current.generation, 2); assert.equal(current.turnTrigger, null);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
});


test("human output: text plus quiet token advances legacy cursor but explicit mode still requires tell", t => {
  const parsed = quietReply("Visible reply\n<quiet/>");
  assert.equal(parsed.quiet, false);
  for (const mode of ["legacy", "explicit"] as const) {
    const h = harness(); t.after(h.cleanup); const store = h.open();
    try {
      const { bee } = makeBee(store); bootToRunning(store, bee.id, 7, 7);
      store.setHumanOutputMode(bee.id, mode, "mode");
      human(store, bee.id);
      if (mode === "explicit") store.tellHuman({ beeId: bee.id, text: "previous explicit tell", idempotencyKey: "seed" });
      const pending = human(store, bee.id);
      const before = store.getBee(bee.id)!.lastHumanOutputAt;
      store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true, endedQuiet: parsed.quiet });
      const after = store.getBee(bee.id)!;
      assert.equal(after.lastTurnTrigger!.endedQuiet, false);
      assert.ok(after.lastOutputAt !== null);
      if (mode === "explicit") {
        assert.equal(after.lastHumanOutputAt, before);
        assert.equal(after.unansweredHumanMessage!.messageId, pending.id);
      } else {
        assert.equal(after.lastHumanOutputAt, after.lastOutputAt);
        assert.notEqual(after.lastHumanOutputAt, before);
      }
      assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    } finally { store.close(); }
  }
});
