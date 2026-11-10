import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { replayAudit } from "../../core/src/audit.ts";
import { openCoreStore } from "../../core/src/store.ts";
import { codexAdapter } from "../../adapters/src/index.ts";
import { RuntimeHost } from "../../driver-hsr/src/driver.ts";
import type { DeliverOutcome, DeliveryConfirmationPlan, DeliveryConfirmationResult, InterruptOutcome } from "../../harness/src/driver.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

const FAKE_CODEX = fileURLToPath(new URL("../../driver-hsr/test-agent/fake-codex.mjs", import.meta.url));

function opsFor(logs: readonly string[], messageId: number): string[] {
  return logs.filter(line => line.split(" ").includes(`msg=${messageId}`)).map(line => line.split(" ")[0]!);
}

async function codexRigWithStallableJournal(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hd-")));
  const work = join(root, "work"), rpcLog = join(root, "rpc.jsonl");
  for (const path of [work, join(root, "s")]) mkdirSync(path, { mode: 0o700 });
  let now = 1_000_000;
  const clock = () => now;
  const driver = new RuntimeHost({
    sessionLogDir: join(root, "logs"), socketDir: join(root, "s"), stopKillGraceMs: 100,
    resolve: () => ({ command: process.execPath, args: [FAKE_CODEX], cwd: work, env: { ...process.env, FAKE_CODEX_RPC_LOG: rpcLog }, adapter: codexAdapter({ cwd: work }) }),
  });
  const store = openCoreStore(join(root, "core.sqlite3"), { now: clock, ephemeral: true });
  const logs: string[] = [];
  const core = new DaemonCore({ store, driver, now: clock, log: line => logs.push(line), policy: { commandsPerStep: 8, idleWindowSteps: null, bootHangTimeoutSteps: 10_000_000 } });
  t.after(() => { driver.disposeAll(); store.close(); rmSync(root, { recursive: true, force: true }); });
  core.boot();
  const bee = store.createBee({ name: "held-delivery", agent: "stub", substrate: "hsr", cwd: work }).bee;
  store.enqueueCommand("spawn", bee.id);

  const tail = driver as unknown as { pumpHostTail(proc: object): void; procs: Map<string, { turnId: string | null }> };
  const readJournal = tail.pumpHostTail.bind(driver);
  let journalStalled = false;
  tail.pumpHostTail = proc => { if (!journalStalled) readJournal(proc); };

  const tick = async (): Promise<void> => {
    now += 20;
    for (const proc of tail.procs.values()) tail.pumpHostTail(proc);
    core.step();
    await new Promise(resolve => setTimeout(resolve, 5));
  };
  const state = (): string => JSON.stringify({
    runtime: store.currentRuntime(bee.id)?.state,
    intents: store.listDeliveryConfirmationIntents(bee.id).map(row => ({ id: row.messageId, state: row.state, reason: row.reason })),
    undelivered: store.undeliveredMessages(bee.id).map(row => row.id),
  });
  const until = async (condition: () => boolean, label: string, ticks = 6000): Promise<void> => {
    for (let i = 0; i < ticks; i++) { if (condition()) return; await tick(); }
    assert.fail(`${label}: not reached in ${ticks} ticks; ${state()}`);
  };
  const delivered = (id: number): boolean => store.getMessage(id)?.deliveredAt != null;
  const requests = (): { method: string; text: string }[] => !existsSync(rpcLog) ? [] : readFileSync(rpcLog, "utf8").trim().split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { method: string; params?: { input?: { text?: string }[] } })
    .map(row => ({ method: row.method, text: row.params?.input?.[0]?.text ?? "" }));

  await until(() => store.currentRuntime(bee.id)?.state === "idle", "fake codex booted to idle");
  return {
    store, bee, logs, tick, until, delivered, requests,
    sessionLog: () => readFileSync(driver.sessionLogPath(bee.id), "utf8"),
    writesOf: (marker: string) => requests().filter(row => row.text.includes(marker)).map(row => row.method),
    stallJournal(): void { journalStalled = true; },
    releaseJournal(): void { journalStalled = false; },
    async ticks(count: number): Promise<void> { for (let i = 0; i < count; i++) await tick(); },
    async startTurn(body: string): Promise<void> {
      const message = store.send(bee.id, body).message;
      await until(() => delivered(message.id) && tail.procs.get(bee.id)?.turnId != null && store.currentRuntime(bee.id)?.state === "running", "codex turn running");
    },
  };
}

test("codex: `now` mail interrupts, waits for the interrupted turn to end, then is delivered once with the queue behind it", async t => {
  const r = await codexRigWithStallableJournal(t);
  await r.startTurn("long work @slow:600000");
  r.stallJournal();
  const urgent = r.store.send(r.bee.id, "urgent-now", { urgency: "now" }).message;
  const behind = r.store.send(r.bee.id, "behind-next").message;
  await r.until(() => r.requests().some(row => row.method === "turn/interrupt"), "interrupt written");
  await r.until(() => r.sessionLog().includes('"status":"interrupted"'), "runner host journaled the interrupted turn");
  await r.ticks(100);
  assert.deepEqual(r.writesOf("urgent-now"), [], "nothing is written between the interrupt and the observed turn end");
  assert.deepEqual(r.writesOf("behind-next"), []);
  assert.deepEqual(r.store.listDeliveryConfirmationIntents(r.bee.id), []);
  assert.equal(r.store.currentRuntime(r.bee.id)?.state, "running");

  r.releaseJournal();
  await r.until(() => r.delivered(urgent.id) && r.delivered(behind.id), "urgent mail and the mail behind it delivered");
  assert.deepEqual(r.writesOf("urgent-now"), ["turn/start"]);
  assert.equal(r.requests().filter(row => row.method === "turn/interrupt").length, 1);
  assert.deepEqual(opsFor(r.logs, urgent.id), ["deliver.interrupt", "deliver.pending", "deliver.confirmed"]);
  assert.equal(r.store.deliveryHoldCounts().total, 0);
});

test("codex: a steer refused because its turn had already ended is re-planned at the next accept point instead of holding the queue", async t => {
  const r = await codexRigWithStallableJournal(t);
  await r.startTurn("short work @slow:300");
  r.stallJournal();
  const turnEndedBy = Date.now() + 10_000;
  while (!r.sessionLog().includes('"status":"completed"')) {
    assert.ok(Date.now() < turnEndedBy, "fake codex turn did not complete");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const late = r.store.send(r.bee.id, "late-next").message;
  const behind = r.store.send(r.bee.id, "behind-next").message;
  await r.until(() => r.store.getDeliveryConfirmationIntent(late.id)?.state === "held", "refused twice against the stale turn");
  await r.ticks(100);
  assert.deepEqual(r.writesOf("late-next"), ["turn/steer", "turn/steer"]);
  assert.equal(r.store.getDeliveryConfirmationIntent(late.id)?.reason, "refused");
  assert.deepEqual(r.store.deliveryHoldCounts(), { total: 1, unknownOutcome: 0, byReason: { refused: 1 }, oldestSince: r.store.getDeliveryConfirmationIntent(late.id)!.since });
  assert.deepEqual(opsFor(r.logs, late.id), ["deliver.pending", "deliver.pending", "deliver.held"]);

  r.releaseJournal();
  await r.until(() => r.delivered(late.id) && r.delivered(behind.id), "refused mail and the mail behind it delivered");
  assert.deepEqual(r.writesOf("late-next"), ["turn/steer", "turn/steer", "turn/start"]);
  assert.deepEqual(opsFor(r.logs, late.id).slice(3), ["deliver.replanned", "deliver.pending", "deliver.confirmed"]);
  assert.equal(r.store.deliveryHoldCounts().total, 0);
});

class ConfirmingDriver extends FakeDriver {
  acceptPoint = "idle";
  receipt: DeliveryConfirmationResult = "pending_ack";
  receiptPolls = 0;
  interruptEndsTurn = true;
  readonly writes: { messageId: number; generation: number; acceptPoint: string }[] = [];

  planDeliveryConfirmation(_beeId: string, _generation: number, messageId: number, body: string): DeliveryConfirmationPlan {
    const wireLine = JSON.stringify({ messageId, body, acceptPoint: this.acceptPoint });
    return { wireLine, digest: createHash("sha256").update(wireLine).digest("hex"), host: { pid: 123, birth: "linux:123", bootId: "11111111-1111-1111-1111-111111111111" }, supported: true };
  }

  override deliveryReadiness(): string {
    return this.acceptPoint;
  }

  reconcileDeliveryConfirmation(): DeliveryConfirmationResult {
    this.receiptPolls += 1;
    return this.receipt;
  }

  override deliver(_beeId: string, generation: number, messageId: number): DeliverOutcome {
    this.writes.push({ messageId, generation, acceptPoint: this.acceptPoint });
    return { accepted: false, reason: "not_ready", pendingConfirmation: true };
  }

  override interrupt(beeId: string, generation: number): InterruptOutcome {
    if (this.interruptEndsTurn) return { ...super.interrupt(beeId, generation), closesAcceptPoint: true };
    this.interrupts.push({ beeId, generation });
    return { interrupted: true, closesAcceptPoint: true };
  }
}

class QueueingDriver extends FakeDriver {
  override interrupt(beeId: string, generation: number): InterruptOutcome {
    this.interrupts.push({ beeId, generation });
    return { interrupted: true };
  }
}

function coreRig<Driver extends FakeDriver>(t: TestContext, makeDriver: (clock: () => number) => Driver) {
  const root = mkdtempSync(join(tmpdir(), "held-delivery-"));
  let now = 1_000_000;
  const clock = () => now;
  const store = openCoreStore(join(root, "core.sqlite"), { now: clock, ephemeral: true });
  const driver = makeDriver(clock);
  const logs: string[] = [];
  const core = new DaemonCore({ store, driver, now: clock, log: line => logs.push(line), policy: { idleWindowSteps: null, commandsPerStep: 8, bootHangTimeoutSteps: 10_000_000 } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  core.boot();
  const bee = store.createBee({ name: "fixture", agent: "stub", substrate: "hsr", cwd: root }).bee;
  store.enqueueCommand("spawn", bee.id);
  const ticks = (count: number, ms = 100): void => { for (let i = 0; i < count; i++) { now += ms; core.step(); } };
  ticks(4);
  assert.equal(store.currentRuntime(bee.id)?.state, "idle");
  return { store, driver, core, bee, logs, ticks };
}

function confirmingRig(t: TestContext) {
  const r = coreRig(t, clock => new ConfirmingDriver(clock));
  return {
    ...r,
    intent: (id: number) => r.store.getDeliveryConfirmationIntent(id),
    holdRefused(id: number): void {
      r.driver.receipt = "refused";
      for (let i = 0; i < 200 && r.store.getDeliveryConfirmationIntent(id)?.state !== "held"; i++) r.ticks(1);
      assert.equal(r.store.getDeliveryConfirmationIntent(id)?.reason, "refused");
    },
  };
}

test("a twice-refused delivery stays held and counted at an unchanged accept point, then is re-planned and delivered once the accept point moves", t => {
  const r = confirmingRig(t);
  const head = r.store.send(r.bee.id, "head").message;
  const behind = r.store.send(r.bee.id, "behind").message;
  r.holdRefused(head.id);
  assert.deepEqual(r.driver.writes.map(write => write.messageId), [head.id, head.id], "one bounded retry");

  const pollsWhenHeld = r.driver.receiptPolls;
  r.driver.receipt = "unknown";
  r.ticks(100, 1_000_000);
  assert.equal(r.intent(head.id)?.reason, "refused", "a known refusal is never downgraded to unknown");
  assert.equal(r.driver.receiptPolls, pollsWhenHeld, "a refused hold has nothing left to ask the host");
  assert.equal(r.driver.writes.length, 2, "the same bytes are not written again at the same accept point");
  assert.deepEqual(r.store.deliveryHoldCounts(), { total: 1, unknownOutcome: 0, byReason: { refused: 1 }, oldestSince: r.intent(head.id)!.since });

  r.driver.acceptPoint = "next-turn";
  r.driver.receipt = "accepted";
  r.ticks(20);
  assert.deepEqual(r.driver.writes.map(write => [write.messageId, write.acceptPoint]), [[head.id, "idle"], [head.id, "idle"], [head.id, "next-turn"], [behind.id, "next-turn"]]);
  assert.equal(r.store.getMessage(head.id)?.deliveredGeneration, 1);
  assert.equal(r.store.getMessage(behind.id)?.deliveredGeneration, 1);
  assert.deepEqual(opsFor(r.logs, head.id), ["deliver.pending", "deliver.pending", "deliver.held", "deliver.replanned", "deliver.pending", "deliver.confirmed"]);
  assert.equal(r.store.deliveryHoldCounts().total, 0);
  assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
});

test("a refused hold is released when its runtime exits and the message is delivered to the next generation", t => {
  const r = confirmingRig(t);
  const head = r.store.send(r.bee.id, "head").message;
  r.holdRefused(head.id);
  r.driver.receipt = "accepted";
  r.driver.procs.delete(r.bee.id);
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "exited", exitCause: "crashed" });
  for (let i = 0; i < 400 && r.store.getMessage(head.id)?.deliveredAt == null; i++) r.ticks(1, 1_000);
  assert.equal(r.store.getMessage(head.id)?.deliveredGeneration, 2);
  assert.equal(r.store.auditRows().some(row => row.kind === "mail.confirmation_held" && (row.payload as { row: { reason: string } }).row.reason === "generation_changed"), false);
  assert.deepEqual(opsFor(r.logs, head.id).slice(-3), ["deliver.released", "deliver.pending", "deliver.confirmed"]);
  assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
});

test("a refused multiline pointer or batch write keeps its generation hold for an operator when the runtime exits", t => {
  const r = confirmingRig(t);
  r.driver.receipt = "pending_ack";
  const head = r.store.send(r.bee.id, "head").message;
  const plan = r.driver.planDeliveryConfirmation(r.bee.id, 1, head.id, "pointer");
  r.store.prepareDeliveryConfirmationIntent({ beeId: r.bee.id, messageId: head.id, generation: 1, wireLine: plan.wireLine, digest: plan.digest, host: plan.host, settlement: { multilineFallbackId: "fallback-1", reorderMessageIds: [], placementMoveId: null, handoffId: null } });
  r.store.holdDeliveryConfirmation(head.id, "refused");
  r.driver.procs.delete(r.bee.id);
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "exited", exitCause: "crashed" });
  for (let i = 0; i < 50; i++) r.ticks(1, 1_000);
  assert.equal(r.store.currentRuntime(r.bee.id)?.generation, 2);
  assert.equal(r.intent(head.id)?.reason, "generation_changed");
  assert.equal(r.store.getMessage(head.id)?.deliveredAt, null);
  assert.equal(r.driver.writes.length, 0);
  assert.deepEqual(r.store.deliveryHoldCounts().byReason, { generation_changed: 1 });
});

test("an unanswered write is held as unknown, counted as an unknown outcome, and settled by a late confirmation", t => {
  const r = confirmingRig(t);
  const head = r.store.send(r.bee.id, "head").message;
  r.ticks(1);
  assert.equal(r.intent(head.id)?.state, "awaiting_confirmation");
  assert.equal(r.store.deliveryHoldCounts().total, 0, "awaiting confirmation is pending, not held");
  r.ticks(90, 1_000);
  assert.equal(r.intent(head.id)?.reason, "unknown");
  assert.deepEqual(r.store.deliveryHoldCounts(), { total: 1, unknownOutcome: 1, byReason: { unknown: 1 }, oldestSince: r.intent(head.id)!.since });
  assert.deepEqual(opsFor(r.logs, head.id), ["deliver.pending", "deliver.held"]);
  assert.equal(r.driver.writes.length, 1);

  r.driver.receipt = "accepted";
  r.ticks(40, 1_000);
  assert.equal(r.store.getMessage(head.id)?.deliveredGeneration, 1);
  assert.equal(r.driver.writes.length, 1, "an unknown outcome is never rewritten");
  assert.equal(r.store.deliveryHoldCounts().total, 0);
});

test("delivery stays closed between an accepted interrupt and the observed turn end", t => {
  const r = confirmingRig(t);
  r.driver.interruptEndsTurn = false;
  r.driver.receipt = "accepted";
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_started" });
  r.ticks(1);
  const urgent = r.store.send(r.bee.id, "urgent", { urgency: "now" }).message;
  const behind = r.store.send(r.bee.id, "behind").message;
  r.ticks(50);
  assert.equal(r.driver.interrupts.length, 1);
  assert.equal(r.driver.writes.length, 0);

  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_ended" });
  r.ticks(20);
  assert.deepEqual(r.driver.writes.map(write => write.messageId), [urgent.id, behind.id]);
  assert.equal(r.driver.interrupts.length, 1);
});

test("a harness that queues input behind its own interrupt is written to on the next step", t => {
  const r = coreRig(t, clock => new QueueingDriver(clock));
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_started" });
  r.ticks(1);
  const urgent = r.store.send(r.bee.id, "urgent", { urgency: "now" }).message;
  r.ticks(1);
  assert.equal(r.driver.interrupts.length, 1);
  assert.deepEqual(r.driver.deliveredIds, []);
  r.ticks(1);
  assert.deepEqual(r.driver.deliveredIds, [urgent.id]);
});

test("an operator interrupt closes delivery until the turn end is observed", t => {
  const r = confirmingRig(t);
  r.driver.receipt = "accepted";
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_started" });
  r.ticks(1);
  r.core.interruptAccepted(r.bee.id, 1);
  const queued = r.store.send(r.bee.id, "queued").message;
  r.ticks(50);
  assert.equal(r.driver.writes.length, 0);

  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_ended" });
  r.ticks(5);
  assert.deepEqual(r.driver.writes.map(write => write.messageId), [queued.id]);
});

test("a runtime that exits while its turn is being interrupted reopens delivery on the next generation", t => {
  const r = confirmingRig(t);
  r.driver.interruptEndsTurn = false;
  r.driver.receipt = "accepted";
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_started" });
  r.ticks(1);
  const urgent = r.store.send(r.bee.id, "urgent", { urgency: "now" }).message;
  r.ticks(5);
  assert.equal(r.driver.writes.length, 0);

  r.driver.procs.delete(r.bee.id);
  r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "exited", exitCause: "crashed" });
  for (let i = 0; i < 400 && r.store.getMessage(urgent.id)?.deliveredAt == null; i++) r.ticks(1, 1_000);
  assert.equal(r.store.getMessage(urgent.id)?.deliveredGeneration, 2);
  assert.deepEqual(r.driver.writes.map(write => write.generation), [2]);
});
