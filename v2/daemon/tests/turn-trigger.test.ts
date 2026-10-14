import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, replayAudit, type CoreStore } from "../../core/src/index.ts";
import { DaemonCore } from "../src/loops.ts";
import { ANSWER_INJECTION_MARKER, turnTriggerSource } from "../src/envelope.ts";
import { FakeDriver } from "./helpers.ts";

interface Rig {
  store: CoreStore;
  driver: FakeDriver;
  core: DaemonCore;
  clock: { now: number };
  cleanup: () => void;
}

function makeRig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-turn-trigger-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, ephemeral: true });
  const driver = new FakeDriver(now);
  const core = new DaemonCore({ store, driver, policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 }, now, log: () => {} });
  core.boot();
  return { store, driver, core, clock, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function spawnIdle(rig: Rig, id: string): void {
  rig.store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
  rig.store.enqueueCommand("spawn", id);
  for (let i = 0; i < 3; i++) rig.core.step();
  assert.equal(rig.store.currentRuntime(id)?.state, "idle");
}

function runTurn(rig: Rig, beeId: string, messageId: number): void {
  rig.clock.now += 1000;
  rig.core.step();
  assert.equal(rig.driver.deliveredIds.at(-1), messageId);
  rig.driver.events.push({ beeId, generation: 1, kind: "turn_started", synthetic: true, messageId });
  rig.core.step();
  rig.driver.events.push({ beeId, generation: 1, kind: "turn_ended" });
  rig.core.step();
}

test("turn-trigger.daemon.1: the delivery loop records human for operator mail and mail with the sender for peer mail", () => {
  const rig = makeRig();
  try {
    const peer = "b7cd0186-d02e-4337-87af-e6679402aa65";
    spawnIdle(rig, "champion");
    rig.store.createBee({ id: peer, name: "worker", agent: "stub", substrate: "hsr", cwd: "/tmp" });

    const prompt = rig.store.send("champion", "hello", { sender: "operator" }).message;
    runTurn(rig, "champion", prompt.id);
    const human = rig.store.getBee("champion")!;
    assert.equal(human.lastTurnTrigger!.kind, "human");
    assert.equal(human.lastTurnTrigger!.from, "operator");
    assert.equal(human.lastTurnTrigger!.messageId, prompt.id);
    assert.equal(human.lastHumanOutputAt, human.lastOutputAt);

    const mail = rig.store.send("champion", "done", { sender: peer }).message;
    runTurn(rig, "champion", mail.id);
    const after = rig.store.getBee("champion")!;
    assert.equal(after.lastTurnTrigger!.kind, "mail");
    assert.equal(after.lastTurnTrigger!.from, peer);
    assert.equal(after.lastTurnTrigger!.messageId, mail.id);
    assert.ok(after.lastOutputAt! > human.lastOutputAt!);
    assert.equal(after.lastHumanOutputAt, human.lastHumanOutputAt);

    const remote = rig.store.send("champion", "relay", { sender: "remote:mac/abc" }).message;
    runTurn(rig, "champion", remote.id);
    assert.deepEqual([rig.store.getBee("champion")!.lastTurnTrigger!.kind, rig.store.getBee("champion")!.lastTurnTrigger!.from], ["mail", "remote:mac/abc"]);
    assert.deepEqual(replayAudit(rig.store.auditRows()), rig.store.dumpState());
  } finally {
    rig.cleanup();
  }
});

test("turn-trigger.daemon.2: a driver-opened turn keeps its opener when the store has not folded the previous turn_ended", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "champion");
    const mail = rig.store.send("champion", "work", { sender: "CL.a3f2" }).message;
    rig.core.step();
    rig.driver.events.push({ beeId: "champion", generation: 1, kind: "turn_started", synthetic: true, messageId: mail.id });
    rig.core.step();
    assert.equal(rig.store.currentRuntime("champion")?.state, "running");

    const prompt = rig.store.send("champion", "are you there?", { sender: "operator" }).message;
    rig.core.step();
    assert.equal(rig.driver.deliveredIds.at(-1), prompt.id);
    rig.driver.events.push({ beeId: "champion", generation: 1, kind: "turn_ended" });
    rig.driver.events.push({ beeId: "champion", generation: 1, kind: "turn_started", synthetic: true, messageId: prompt.id });
    rig.core.step();
    const trigger = rig.store.getBee("champion")!.lastTurnTrigger!;
    assert.equal(trigger.kind, "human");
    assert.equal(trigger.messageId, prompt.id);
    assert.equal(trigger.endedAt, null);

    rig.driver.events.push({ beeId: "champion", generation: 1, kind: "turn_started" });
    rig.driver.events.push({ beeId: "champion", generation: 1, kind: "turn_ended" });
    rig.core.step();
    rig.driver.events.push({ beeId: "champion", generation: 1, kind: "turn_started" });
    rig.core.step();
    const selfWoken = rig.store.getBee("champion")!.lastTurnTrigger!;
    assert.deepEqual([selfWoken.kind, selfWoken.from, selfWoken.messageId], ["other", null, null]);
    assert.deepEqual(replayAudit(rig.store.auditRows()), rig.store.dumpState());
  } finally {
    rig.cleanup();
  }
});

test("turn-trigger.daemon.3: system origins and automation are other, a child's spawn prompt is mail from its parent, people are human", () => {
  const from = (sender: string, senderKind?: "human" | "automation") => ({ sender, ...(senderKind ? { senderKind } : {}) });
  assert.deepEqual(turnTriggerSource(from("operator"), "action.dispatch", false, null), { kind: "other", from: "operator" });
  assert.deepEqual(turnTriggerSource(from("operator"), "handoff.seed", false, null), { kind: "other", from: "operator" });
  assert.deepEqual(turnTriggerSource(from("hive:auth-resume"), "auth.resume", false, null), { kind: "other", from: "hive:auth-resume" });
  assert.deepEqual(turnTriggerSource(from("hive:action"), "auth.resume", false, null), { kind: "other", from: "hive:action" }, "a redelivered action instruction stays other");
  assert.deepEqual(turnTriggerSource(from("hive:handoff"), "auth.resume", false, null), { kind: "other", from: "hive:handoff" });
  assert.deepEqual(turnTriggerSource(from("hive"), "mail.send", false, null), { kind: "other", from: "hive" });
  assert.deepEqual(turnTriggerSource(from("operator"), "auth.resume", false, null), { kind: "human", from: "operator" }, "a redelivered human prompt stays human");
  assert.deepEqual(turnTriggerSource(from("CL.a3f2"), "auth.resume", true, null), { kind: "mail", from: "CL.a3f2" });
  assert.deepEqual(turnTriggerSource(from("task-supply"), "mail.send", true, null), { kind: "other", from: "task-supply" });
  assert.deepEqual(turnTriggerSource(from("human:pollinate"), "mail.send", false, null), { kind: "other", from: "human:pollinate" });
  assert.deepEqual(turnTriggerSource(from("operator", "automation"), "mail.send", false, null), { kind: "other", from: "operator" });
  assert.deepEqual(turnTriggerSource(from("CL.a3f2", "automation"), "mail.send", true, null), { kind: "mail", from: "CL.a3f2" }, "an agent's mail is mail");
  assert.deepEqual(turnTriggerSource(from("operator", "human"), "mail.send", false, null), { kind: "human", from: "operator" });
  assert.deepEqual(turnTriggerSource(from("operator"), "spawn.prompt", false, "parent-bee"), { kind: "mail", from: "parent-bee" });
  assert.deepEqual(turnTriggerSource(from("operator"), "spawn.prompt", false, null), { kind: "human", from: "operator" });
  assert.deepEqual(turnTriggerSource(from("human:tormod"), "mail.send", false, null), { kind: "human", from: "human:tormod" });
  assert.deepEqual(turnTriggerSource(from("CL.a3f2"), "legacy.unknown", true, null), { kind: "mail", from: "CL.a3f2" });
});

test("turn-trigger.daemon.answer: a question answer is delivered with the answer marker, mail.delivered names the question, and the turn is human", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "champion");
    const question = rig.store.askQuestion("champion", { text: "merge or rebase?", options: ["merge", "rebase"] });
    const answer = rig.store.answerQuestion(question.id, "rebase", { answeredBy: "tormod" }).send.message;
    runTurn(rig, "champion", answer.id);

    const lines = rig.driver.deliveredBodies.at(-1)!.split("\n");
    assert.equal(lines[0], ANSWER_INJECTION_MARKER);
    const meta = JSON.parse(lines[1]!) as Record<string, unknown>;
    assert.deepEqual([meta.kind, meta.questionId, meta.from, meta.id], ["answer", question.id, "tormod", String(answer.id)]);
    assert.ok(lines.slice(3).join("\n").startsWith(`[answer to question ${question.id}] rebase`));

    const delivered = rig.store.auditRows().filter((row) => row.kind === "mail.delivered" && row.payload.messageId === answer.id);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.payload.questionId, question.id);
    assert.equal(rig.store.getQuestion(question.id)!.deliveryMessageId, answer.id);

    const bee = rig.store.getBee("champion")!;
    assert.deepEqual([bee.lastTurnTrigger!.kind, bee.lastTurnTrigger!.from, bee.lastTurnTrigger!.messageId], ["human", "tormod", answer.id]);
    assert.equal(bee.lastHumanOutputAt, bee.lastOutputAt);

    const plain = rig.store.send("champion", "thanks", { sender: "operator" }).message;
    runTurn(rig, "champion", plain.id);
    assert.equal(rig.driver.deliveredBodies.at(-1), "thanks");
    const plainDelivered = rig.store.auditRows().find((row) => row.kind === "mail.delivered" && row.payload.messageId === plain.id)!;
    assert.equal("questionId" in plainDelivered.payload, false);
    assert.deepEqual(replayAudit(rig.store.auditRows()), rig.store.dumpState());
  } finally {
    rig.cleanup();
  }
});
