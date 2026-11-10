import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/store.ts";
import type { DeliverOutcome, DeliveryConfirmationPlan, DeliveryConfirmationResult } from "../../harness/src/driver.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

const TICK_MS = 200;
const STATUS_ROUND_TRIP_MS = 2;
const MINUTE_MS = 60_000;
const HELD_POLL_MS = 30_000;
const SETTLE_STEPS = 5;
const IDLE_BASELINE_STEPS = 25;

class StatusHostDriver extends FakeDriver {
  hostAnswer: DeliveryConfirmationResult = "unknown";
  reconciles = 0;
  readonly queriedAt = new Map<number, number[]>();
  readonly writes: number[] = [];
  private readonly asked = new Set<number>();
  private readonly answers = new Map<number, DeliveryConfirmationResult>();
  private readonly acknowledged = new Set<number>();
  private readonly clock: () => number;

  constructor(now: () => number) {
    super(now);
    this.clock = now;
  }

  planDeliveryConfirmation(_beeId: string, _generation: number, messageId: number, body: string): DeliveryConfirmationPlan {
    const wireLine = JSON.stringify({ messageId, body });
    return { wireLine, digest: createHash("sha256").update(wireLine).digest("hex"), host: { pid: 123, birth: "linux:123", bootId: "11111111-1111-1111-1111-111111111111" }, supported: true };
  }

  override deliveryReadiness(beeId: string, generation: number, messageId: number, includeStatusReply = true): string {
    return JSON.stringify([super.deliveryReadiness(beeId, generation, messageId), this.acknowledged.has(messageId),
      includeStatusReply ? this.answers.get(messageId) ?? null : null]);
  }

  deliveryStatusAnswered(_beeId: string, _generation: number, messageId: number): boolean {
    return this.answers.has(messageId);
  }

  reconcileDeliveryConfirmation(_beeId: string, _generation: number, messageId: number): DeliveryConfirmationResult {
    this.reconciles += 1;
    if (this.acknowledged.delete(messageId)) return "accepted";
    const answer = this.answers.get(messageId);
    if (answer) {
      this.answers.delete(messageId);
      return answer;
    }
    if (!this.asked.has(messageId)) {
      this.asked.add(messageId);
      this.queriedAt.set(messageId, [...this.queriesFor(messageId), this.clock()]);
    }
    return "pending_ack";
  }

  override deliver(_beeId: string, _generation: number, messageId: number): DeliverOutcome {
    this.writes.push(messageId);
    return { accepted: false, reason: "not_ready", pendingConfirmation: true };
  }

  queriesFor(messageId: number): number[] {
    return this.queriedAt.get(messageId) ?? [];
  }

  queries(): number {
    return [...this.queriedAt.values()].reduce((total, times) => total + times.length, 0);
  }

  socketDeliversAnswers(): boolean {
    if (this.asked.size === 0) return false;
    for (const messageId of this.asked) this.answers.set(messageId, this.hostAnswer);
    this.asked.clear();
    return true;
  }

  journalAcknowledges(messageId: number): void {
    this.acknowledged.add(messageId);
  }
}

function rig(beeCount: number) {
  const root = mkdtempSync(join(tmpdir(), "held-poll-"));
  let time = 1_000;
  const now = () => time;
  const store = openCoreStore(join(root, "core.sqlite"), { now, ephemeral: true });
  const driver = new StatusHostDriver(now);
  const logs: string[] = [];
  let storeCalls = 0;
  const countedStore = new Proxy(store, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return (...args: unknown[]): unknown => { storeCalls += 1; return member.apply(target, args); };
    },
  });
  const core = new DaemonCore({ store: countedStore, driver, now, log: (line: string) => logs.push(line), onI1Violation: () => {}, policy: { idleWindowSteps: null, commandsPerStep: 8, i1DeadlineSteps: 1_000_000, bootHangTimeoutSteps: 100_000 } });
  core.boot();
  const bees = Array.from({ length: beeCount }, (_, index) => store.createBee({ name: `fixture-${index}`, agent: "stub", substrate: "hsr", cwd: root }).bee.id);
  for (const beeId of bees) store.enqueueCommand("spawn", beeId);
  for (let i = 0; i < 8; i++) { time += 20; core.step(); }
  for (const beeId of bees) {
    assert.equal(store.currentRuntime(beeId)?.state, "idle");
    store.archiveBee(beeId);
  }
  let steps = 0;
  let holdWrites = 0;
  const holdInStore = store.holdDeliveryConfirmation.bind(store);
  store.holdDeliveryConfirmation = (messageId, reason) => { holdWrites += 1; return holdInStore(messageId, reason); };
  const storeCallsByStep: number[] = [];
  const step = (untilStep: number): void => {
    time += untilStep;
    const before = storeCalls;
    core.step();
    steps += 1;
    storeCallsByStep.push(storeCalls - before);
  };
  for (let i = 0; i < SETTLE_STEPS + IDLE_BASELINE_STEPS; i++) step(TICK_MS);
  const idleStepStoreCalls = Math.max(...storeCallsByStep.slice(-IDLE_BASELINE_STEPS));
  return {
    store, driver, core, bees, logs, now, step,
    close(): void { store.close(); rmSync(root, { recursive: true, force: true }); },
    run(ms: number): void {
      const end = time + ms;
      for (;;) {
        const untilNextStep = driver.socketDeliversAnswers() ? STATUS_ROUND_TRIP_MS : TICK_MS;
        if (time + untilNextStep > end) break;
        step(untilNextStep);
      }
      time = end;
    },
    holdHeadWithUnknownOutcome(beeId: string): number {
      const head = store.send(beeId, "written, outcome never learned").message;
      store.send(beeId, "queued behind the held head");
      const plan = driver.planDeliveryConfirmation(beeId, 1, head.id, "written, outcome never learned");
      store.prepareDeliveryConfirmationIntent({ beeId, messageId: head.id, generation: 1, wireLine: plan.wireLine, digest: plan.digest, host: plan.host });
      holdInStore(head.id, "unknown");
      return head.id;
    },
    measure<T>(work: () => T): { steps: number; stepsReadingTheStoreForAHead: number; storeCalls: number; idleStoreCalls: number; queries: number; reconciles: number; holdWrites: number; auditRows: number; logLines: number; result: T } {
      const before = { steps, queries: driver.queries(), reconciles: driver.reconciles, holdWrites, auditRows: store.auditRows().length, logLines: logs.length };
      const result = work();
      const measured = storeCallsByStep.slice(before.steps);
      return { steps: steps - before.steps, queries: driver.queries() - before.queries, reconciles: driver.reconciles - before.reconciles,
        stepsReadingTheStoreForAHead: measured.filter(calls => calls > idleStepStoreCalls).length,
        storeCalls: measured.reduce((total, calls) => total + calls, 0), idleStoreCalls: measured.length * idleStepStoreCalls,
        holdWrites: holdWrites - before.holdWrites, auditRows: store.auditRows().length - before.auditRows, logLines: logs.length - before.logLines, result };
    },
  };
}

test("two held heads with an unknown outcome on live idle runtimes are each asked twice a minute and add no steps, writes or logs", () => {
  const r = rig(2);
  try {
    const first = r.holdHeadWithUnknownOutcome(r.bees[0]!);
    r.step(TICK_MS);
    const second = r.holdHeadWithUnknownOutcome(r.bees[1]!);
    r.run(5_000);
    const minute = r.measure(() => r.run(MINUTE_MS));
    console.log(`steps/min=${minute.steps} status-queries/min=${minute.queries} reconciles/min=${minute.reconciles} hold-writes/min=${minute.holdWrites} audit-rows/min=${minute.auditRows} log-lines/min=${minute.logLines}`);
    console.log(`store-calls/min=${minute.storeCalls} idle-daemon-store-calls/min=${minute.idleStoreCalls} steps-reading-the-store-for-a-head/min=${minute.stepsReadingTheStoreForAHead}`);
    assert.ok(minute.idleStoreCalls > 0, "an idle daemon step is expected to call the store, or the idle baseline measures nothing");
    assert.ok(minute.stepsReadingTheStoreForAHead <= minute.reconciles, `steps that read the store for a held head in a minute: ${minute.stepsReadingTheStoreForAHead}, polls: ${minute.reconciles}`);
    const ticks = MINUTE_MS / TICK_MS;
    const exchangesPerHead = MINUTE_MS / HELD_POLL_MS;
    assert.ok(minute.queries <= 2 * exchangesPerHead, `status queries in a minute: ${minute.queries}`);
    assert.ok(minute.queries >= 2, `a held head is still asked: ${minute.queries}`);
    assert.ok(minute.reconciles <= 2 * minute.queries, `driver reconciles in a minute: ${minute.reconciles}`);
    assert.ok(minute.steps <= ticks + minute.queries, `steps in a minute: ${minute.steps}, ticks alone are ${ticks}`);
    assert.equal(minute.holdWrites, 0, "re-holding the same state reaches the store");
    assert.equal(minute.auditRows, 0);
    assert.equal(minute.logLines, 0);
    for (const head of [first, second]) {
      const intent = r.store.getDeliveryConfirmationIntent(head);
      assert.deepEqual([intent?.state, intent?.reason], ["held", "unknown"]);
      assert.equal(r.store.getMessage(head)?.deliveredAt, null);
    }
    assert.deepEqual(r.driver.writes, []);
  } finally { r.close(); }
});

test("one held head with an unknown outcome is asked twice a minute", () => {
  const r = rig(1);
  try {
    r.holdHeadWithUnknownOutcome(r.bees[0]!);
    r.run(5_000);
    const minute = r.measure(() => r.run(MINUTE_MS));
    console.log(`steps/min=${minute.steps} status-queries/min=${minute.queries} reconciles/min=${minute.reconciles} store-calls/min=${minute.storeCalls} idle-daemon-store-calls/min=${minute.idleStoreCalls} steps-reading-the-store-for-a-head/min=${minute.stepsReadingTheStoreForAHead}`);
    assert.ok(minute.stepsReadingTheStoreForAHead <= minute.reconciles, `steps that read the store for a held head in a minute: ${minute.stepsReadingTheStoreForAHead}, polls: ${minute.reconciles}`);
    assert.ok(minute.queries >= 1 && minute.queries <= MINUTE_MS / HELD_POLL_MS, `status queries in a minute: ${minute.queries}`);
    assert.ok(minute.steps <= MINUTE_MS / TICK_MS + minute.queries, `steps in a minute: ${minute.steps}`);
    assert.equal(minute.holdWrites, 0);
  } finally { r.close(); }
});

test("a held head settles on the step its changed status answer wakes, and not before the next exchange", () => {
  const r = rig(1);
  try {
    const head = r.holdHeadWithUnknownOutcome(r.bees[0]!);
    r.run(1_000);
    assert.equal(r.driver.queriesFor(head).length, 1);
    r.driver.hostAnswer = "accepted";
    r.run(HELD_POLL_MS - 2_000);
    assert.equal(r.driver.queriesFor(head).length, 1, "the head is not asked again inside its poll interval");
    assert.equal(r.store.getMessage(head)?.deliveredAt, null);
    r.run(3_000);
    const asked = r.driver.queriesFor(head);
    assert.equal(asked.length, 2);
    assert.equal(r.store.getMessage(head)?.deliveredAt, asked[1]! + STATUS_ROUND_TRIP_MS);
    assert.equal(r.store.getDeliveryConfirmationIntent(head), null);
    assert.equal(r.logs.filter(line => line.startsWith("deliver.confirmed") && line.includes(`msg=${head}`)).length, 1);
  } finally { r.close(); }
});

test("a held head settles on the next step when the runtime's readiness changes inside the poll interval", () => {
  const r = rig(1);
  try {
    const head = r.holdHeadWithUnknownOutcome(r.bees[0]!);
    r.run(1_000);
    r.driver.journalAcknowledges(head);
    const acknowledgedAt = r.now();
    r.run(TICK_MS);
    assert.equal(r.store.getMessage(head)?.deliveredAt, acknowledgedAt + TICK_MS);
    assert.equal(r.driver.queriesFor(head).length, 1);
  } finally { r.close(); }
});

test("a held head between polls costs no store call, and a store change for its bee is acted on at the next step", () => {
  const r = rig(1);
  try {
    const bee = r.bees[0]!;
    const head = r.holdHeadWithUnknownOutcome(bee);
    r.run(5_000);
    const betweenPolls = r.measure(() => r.run(HELD_POLL_MS / 2));
    assert.equal(betweenPolls.reconciles, 0);
    assert.equal(betweenPolls.stepsReadingTheStoreForAHead, 0);
    assert.equal(betweenPolls.storeCalls, betweenPolls.idleStoreCalls);

    r.store.resolveDeliveryConfirmation({ beeId: bee, messageId: head, generation: 1, action: "drop", idempotencyKey: "drop-between-polls" });
    const queuedBehind = r.store.undeliveredMessages(bee).map(row => row.id);
    assert.equal(queuedBehind.length, 1);
    r.run(TICK_MS);
    assert.deepEqual(r.driver.writes, queuedBehind);
    assert.equal(r.store.getDeliveryConfirmationIntent(queuedBehind[0]!)?.state, "awaiting_confirmation");
  } finally { r.close(); }
});
