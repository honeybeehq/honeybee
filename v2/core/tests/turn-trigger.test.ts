import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { replayAudit, type CoreStore, type TurnTriggerSource } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

const HUMAN: TurnTriggerSource = { kind: "human", from: "operator" };
const PEER: TurnTriggerSource = { kind: "mail", from: "peer-bee" };

function idleBee(store: CoreStore) {
  const { bee } = makeBee(store);
  bootToRunning(store, bee.id, 7, 7);
  store.updateRuntimeState(bee.id, 1, "idle");
  return bee;
}

function deliver(store: CoreStore, beeId: string, source: TurnTriggerSource) {
  const { message } = store.send(beeId, `from ${source.from}`, { sender: source.from ?? "operator" });
  store.markDelivered(message.id, store.currentRuntime(beeId)!.generation, source);
  return message;
}

test("turn-trigger.1: an idle delivery opens the turn with its trigger; only human turns move lastHumanOutputAt", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const bee = idleBee(store);
  assert.equal(store.getBee(bee.id)!.lastTurnTrigger, null);

  const prompt = deliver(store, bee.id, HUMAN);
  const opened = store.getBee(bee.id)!.lastTurnTrigger!;
  assert.deepEqual(
    { ...opened, startedAt: 0, humanAt: opened.humanAt === opened.startedAt },
    { kind: "human", from: "operator", messageId: prompt.id, generation: 1, startedAt: 0, humanAt: true, endedAt: null },
  );
  store.updateRuntimeState(bee.id, 1, "running");
  assert.deepEqual(store.getBee(bee.id)!.lastTurnTrigger, opened, "the turn_started edge keeps the delivery's trigger");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  const humanTurn = store.getBee(bee.id)!;
  assert.equal(humanTurn.lastHumanOutputAt, humanTurn.lastOutputAt);
  assert.equal(humanTurn.lastTurnTrigger!.endedAt, humanTurn.lastOutputAt);

  const mail = deliver(store, bee.id, PEER);
  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  const mailTurn = store.getBee(bee.id)!;
  assert.equal(mailTurn.lastTurnTrigger!.kind, "mail");
  assert.equal(mailTurn.lastTurnTrigger!.from, "peer-bee");
  assert.equal(mailTurn.lastTurnTrigger!.messageId, mail.id);
  assert.equal(mailTurn.lastTurnTrigger!.humanAt, null);
  assert.ok(mailTurn.lastOutputAt! > humanTurn.lastOutputAt!);
  assert.equal(mailTurn.lastHumanOutputAt, humanTurn.lastHumanOutputAt, "mail-triggered output never moves lastHumanOutputAt");

  const rows = store.auditRows();
  const delivered = rows.filter((r) => r.kind === "mail.delivered").map((r) => (r.payload.turnTrigger as { kind: string }).kind);
  assert.deepEqual(delivered, ["human", "mail"]);
  const outputs = rows.filter((r) => r.kind === "output.recorded").map((r) => r.payload.lastHumanOutputAt);
  assert.deepEqual(outputs, [humanTurn.lastHumanOutputAt, humanTurn.lastHumanOutputAt]);
  assert.deepEqual(replayAudit(rows), store.dumpState());
  store.close();
});

test("turn-trigger.2: a human message delivered mid-turn marks the turn human; mid-turn mail changes nothing", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const bee = idleBee(store);

  deliver(store, bee.id, PEER);
  store.updateRuntimeState(bee.id, 1, "running");
  const before = store.getBee(bee.id)!.lastTurnTrigger!;
  deliver(store, bee.id, { kind: "mail", from: "other-bee" });
  assert.deepEqual(store.getBee(bee.id)!.lastTurnTrigger, before, "mid-turn mail keeps the opener");
  deliver(store, bee.id, HUMAN);
  const joined = store.getBee(bee.id)!.lastTurnTrigger!;
  assert.equal(joined.kind, "mail", "the opener stays the trigger");
  assert.ok(joined.humanAt !== null && joined.humanAt > joined.startedAt);
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  const after = store.getBee(bee.id)!;
  assert.equal(after.lastHumanOutputAt, after.lastOutputAt);

  deliver(store, bee.id, HUMAN);
  store.updateRuntimeState(bee.id, 1, "running");
  const humanAt = store.getBee(bee.id)!.lastTurnTrigger!.humanAt;
  deliver(store, bee.id, PEER);
  deliver(store, bee.id, HUMAN);
  assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.humanAt, humanAt, "a second human message keeps the first humanAt");
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("turn-trigger.3: a turn with no delivery is other; a driver opener replaces a stale open turn; a second idle delivery does not reopen", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const bee = idleBee(store);

  store.updateRuntimeState(bee.id, 1, "running");
  const selfWoken = store.getBee(bee.id)!.lastTurnTrigger!;
  assert.deepEqual({ ...selfWoken, startedAt: 0 }, { kind: "other", from: null, messageId: null, generation: 1, startedAt: 0, humanAt: null, endedAt: null });
  const runtimeRow = store.auditRows().filter((r) => r.kind === "runtime.updated").at(-1)!;
  assert.deepEqual(runtimeRow.payload.turnTrigger, selfWoken, "the runtime.updated edge carries the trigger");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  assert.equal(store.getBee(bee.id)!.lastHumanOutputAt, null);

  const first = deliver(store, bee.id, PEER);
  deliver(store, bee.id, PEER);
  assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.messageId, first.id, "still idle: the second delivery joins the open turn");
  store.updateRuntimeState(bee.id, 1, "running");
  assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.messageId, first.id);
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });

  deliver(store, bee.id, PEER);
  store.updateRuntimeState(bee.id, 1, "running");
  const raced = store.send(bee.id, "late", { sender: "operator" }).message;
  store.markDelivered(raced.id, 1, HUMAN);
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  store.updateRuntimeState(bee.id, 1, "running", { turnOpener: { ...HUMAN, messageId: raced.id } });
  const reopened = store.getBee(bee.id)!.lastTurnTrigger!;
  assert.equal(reopened.kind, "human");
  assert.equal(reopened.messageId, raced.id);
  assert.equal(reopened.endedAt, null);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("turn-trigger.6: a confirmed delivery that arrives after its driver-opened turn ended does not reopen it", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const bee = idleBee(store);
  const { message } = store.send(bee.id, "codex prompt", { sender: "operator" });
  store.updateRuntimeState(bee.id, 1, "running", { turnOpener: { ...HUMAN, messageId: message.id } });
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  const ended = store.getBee(bee.id)!;
  assert.ok(ended.lastTurnTrigger!.endedAt !== null);
  store.markDelivered(message.id, 1, HUMAN);
  assert.deepEqual(store.getBee(bee.id)!.lastTurnTrigger, ended.lastTurnTrigger, "the late confirmation leaves the ended turn alone");
  const delivered = store.auditRows().filter((r) => r.kind === "mail.delivered").at(-1)!;
  assert.equal(delivered.payload.turnTrigger, undefined);

  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
  const selfWoken = store.getBee(bee.id)!;
  assert.equal(selfWoken.lastTurnTrigger!.kind, "other");
  assert.equal(selfWoken.lastHumanOutputAt, ended.lastHumanOutputAt, "a later self-started turn is not human output");
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("turn-trigger.4: a new generation never inherits the previous generation's human turn", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  const bee = idleBee(store);
  deliver(store, bee.id, HUMAN);
  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "crashed" });
  const human = store.getBee(bee.id)!.lastHumanOutputAt;
  store.reviveBee(bee.id);
  bootToRunning(store, bee.id, 8, 8);
  store.updateRuntimeState(bee.id, 2, "idle", { recordOutput: true });
  const after = store.getBee(bee.id)!;
  assert.equal(after.lastTurnTrigger!.generation, 1);
  assert.equal(after.lastHumanOutputAt, human);

  const { message } = store.send(bee.id, "boot prompt", { sender: "operator" });
  store.updateRuntimeState(bee.id, 2, "running");
  store.markDelivered(message.id, 2, HUMAN);
  assert.equal(store.getBee(bee.id)!.lastTurnTrigger!.kind, "other", "the open turn has no opener");
  assert.ok(store.getBee(bee.id)!.lastTurnTrigger!.humanAt !== null);
  assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  store.close();
});

test("turn-trigger.5: a store without the columns gains them on open; existing bees read null", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const first = h.open({ ephemeral: false });
  const { bee } = makeBee(first);
  first.close();
  const db = new DatabaseSync(h.path);
  db.exec("ALTER TABLE bees DROP COLUMN last_turn_trigger");
  db.exec("ALTER TABLE bees DROP COLUMN last_human_output_at");
  db.close();
  const store = h.open({ ephemeral: false });
  const row = store.getBee(bee.id)!;
  assert.equal(row.lastTurnTrigger, null);
  assert.equal(row.lastHumanOutputAt, null);
  store.close();
});
