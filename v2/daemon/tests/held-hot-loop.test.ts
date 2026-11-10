import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/store.ts";
import type { DeliverOutcome, DeliveryConfirmationPlan, DeliveryConfirmationResult } from "../../harness/src/driver.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

/** A driver whose detached host fails host auth while `authFailed` is set. */
class AuthFailingDriver extends FakeDriver {
  authFailed = false;
  issueChecks = 0;
  deliveryIssue(beeId: string, generation: number): "host_auth_failed" | null {
    this.issueChecks += 1;
    const p = this.procs.get(beeId);
    return this.authFailed && p?.generation === generation ? "host_auth_failed" : null;
  }
  deliveryLaneReady(beeId: string, generation: number): boolean {
    return !this.authFailed && this.procs.get(beeId)?.generation === generation;
  }
}

/** A confirming harness: every write waits for a receipt, and the planned bytes follow the accept point. */
class ConfirmingDriver extends AuthFailingDriver {
  acceptPoint = "idle";
  receipt: DeliveryConfirmationResult = "pending_ack";
  readonly writes: number[] = [];
  planDeliveryConfirmation(_beeId: string, _generation: number, messageId: number, body: string): DeliveryConfirmationPlan {
    const wireLine = JSON.stringify({ messageId, body, acceptPoint: this.acceptPoint });
    return { wireLine, digest: createHash("sha256").update(wireLine).digest("hex"), host: { pid: 123, birth: "linux:123", bootId: "11111111-1111-1111-1111-111111111111" }, supported: true };
  }
  override deliveryReadiness(): string {
    return this.acceptPoint;
  }
  reconcileDeliveryConfirmation(): DeliveryConfirmationResult {
    return this.receipt;
  }
  override deliver(_beeId: string, _generation: number, messageId: number): DeliverOutcome {
    this.writes.push(messageId);
    return { accepted: false, reason: "not_ready", pendingConfirmation: true };
  }
}

function rig<Driver extends AuthFailingDriver = AuthFailingDriver>(beforeTurn?: (beeId: string, generation: number) => boolean, makeDriver: (now: () => number) => Driver = now => new AuthFailingDriver(now) as Driver) {
  const root = mkdtempSync(join(tmpdir(), "held-hot-loop-"));
  let time = 1000;
  const now = () => time;
  const store = openCoreStore(join(root, "core.sqlite"), { now, ephemeral: true });
  const driver = makeDriver(now);
  const logs: string[] = [];
  const core = new DaemonCore({ store, driver, now, log: (line: string) => logs.push(line), onI1Violation: () => {}, ...(beforeTurn ? { beforeTurn } : {}), policy: { idleWindowSteps: null, commandsPerStep: 8, i1DeadlineSteps: 1_000_000, bootHangTimeoutSteps: 100000 } });
  core.boot();
  const bee = store.createBee({ name: "fixture", agent: "stub", substrate: "hsr", cwd: root }).bee;
  store.enqueueCommand("spawn", bee.id);
  for (let i = 0; i < 4; i++) { time += 20; core.step(); }
  return { store, driver, core, bee, logs, tick(n: number, ms = 22) { for (let i = 0; i < n; i++) { time += ms; core.step(); } } };
}

test("a host_auth_failed hold is written and logged once, re-checked on a cadence, and delivers FIFO exactly once after recovery", () => {
  const r = rig();
  try {
    r.store.archiveBee(r.bee.id);
    r.driver.authFailed = true;
    const msg = r.store.send(r.bee.id, "held while host auth fails").message;
    const behind = r.store.send(r.bee.id, "queued behind the held head").message;
    const auditBefore = r.store.auditRows().length;
    r.driver.issueChecks = 0;
    // ~1 minute of daemon ticks at the production cadence.
    r.tick(2700);
    const held = r.logs.filter(line => line.startsWith("deliver.held") && line.includes("host_auth_failed"));
    const auditDuring = r.store.auditRows().slice(auditBefore);
    const kinds = new Map<string, number>();
    for (const row of auditDuring) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
    console.log(`held-log-lines/min=${held.length} delivery-passes/min=${r.driver.issueChecks} audit-rows/min=${auditDuring.length} kinds=${JSON.stringify([...kinds])}`);
    assert.equal(r.store.getDeliveryConfirmationIntent(msg.id)?.reason, "host_auth_failed");
    assert.deepEqual(r.driver.deliveredIds, []);
    assert.ok(held.length <= 1, `held logged ${held.length} times in a minute`);
    assert.ok(auditDuring.length <= 2, `audit rows written: ${auditDuring.length}`);
    assert.ok(r.driver.issueChecks <= 120, `delivery re-evaluated ${r.driver.issueChecks} times in a minute`);
    r.driver.authFailed = false;
    r.tick(50);
    assert.deepEqual(r.driver.deliveredIds, [msg.id, behind.id]);
    r.tick(200);
    assert.deepEqual(r.driver.deliveredIds, [msg.id, behind.id]);
    assert.equal(r.store.getDeliveryConfirmationIntent(msg.id), null);
  } finally { r.store.close(); }
});

const MINUTE_OF_STEPS = 2700;

function confirmingRig() {
  let admissions = 0;
  const r = rig(() => { admissions += 1; return true; }, now => new ConfirmingDriver(now));
  const write = (messageId: number): void => {
    const plan = r.driver.planDeliveryConfirmation(r.bee.id, 1, messageId, "refused bytes");
    r.store.prepareDeliveryConfirmationIntent({ beeId: r.bee.id, messageId, generation: 1, wireLine: plan.wireLine, digest: plan.digest, host: plan.host });
  };
  return { ...r, write, admissions: () => admissions, forget: () => { admissions = 0; } };
}

test("a head that cannot be sent in this step is never offered for turn admission", () => {
  const holds: Record<string, (r: ReturnType<typeof confirmingRig>, messageId: number) => void> = {
    unknown: (r, id) => { r.write(id); r.store.holdDeliveryConfirmation(id, "unknown"); },
    generation_changed: (r, id) => { r.write(id); r.store.holdDeliveryConfirmation(id, "generation_changed"); },
    never_written: (r, id) => { r.store.prepareUnknownDeliveryConfirmationIntent({ beeId: r.bee.id, messageId: id, generation: 1 }); },
    awaiting_confirmation: (r, id) => { r.write(id); },
    interrupting: (r) => { r.core.interruptAccepted(r.bee.id, 1); },
  };
  for (const [kind, hold] of Object.entries(holds)) {
    const r = confirmingRig();
    try {
      const head = r.store.send(r.bee.id, "held head").message;
      r.store.send(r.bee.id, "queued behind the held head");
      hold(r, head.id);
      r.forget();
      r.tick(MINUTE_OF_STEPS);
      console.log(`hold=${kind} admissions/min=${r.admissions()}`);
      assert.equal(r.admissions(), 0, `${kind}: admission asked ${r.admissions()} times in a minute for a head that cannot be sent`);
      assert.deepEqual(r.driver.writes, [], `${kind}: nothing is written`);
      assert.equal(r.store.getMessage(head.id)?.deliveredAt, null);
    } finally { r.store.close(); }
  }
});

test("a refused head asks for admission once, when its re-plan yields different bytes", () => {
  const r = confirmingRig();
  try {
    const head = r.store.send(r.bee.id, "refused head").message;
    const plan = r.driver.planDeliveryConfirmation(r.bee.id, 1, head.id, "refused head");
    r.store.prepareDeliveryConfirmationIntent({ beeId: r.bee.id, messageId: head.id, generation: 1, wireLine: plan.wireLine, digest: plan.digest, host: plan.host });
    r.store.holdDeliveryConfirmation(head.id, "refused");
    r.forget();
    r.tick(MINUTE_OF_STEPS);
    assert.equal(r.admissions(), 0, `admission asked ${r.admissions()} times in a minute at an unchanged accept point`);
    assert.deepEqual(r.driver.writes, []);
    r.driver.acceptPoint = "next turn";
    r.tick(200);
    assert.equal(r.admissions(), 1);
    assert.deepEqual(r.driver.writes, [head.id]);
    assert.equal(r.store.getDeliveryConfirmationIntent(head.id)?.state, "awaiting_confirmation");
    r.driver.receipt = "accepted";
    r.tick(50, 1_000);
    assert.notEqual(r.store.getMessage(head.id)?.deliveredAt, null);
    assert.equal(r.admissions(), 1);
  } finally { r.store.close(); }
});

test("a turn that is refused admission writes nothing and leaves no delivery intent", () => {
  let admit = false;
  let admissions = 0;
  const r = rig(() => { admissions += 1; return admit; }, now => new ConfirmingDriver(now));
  try {
    const head = r.store.send(r.bee.id, "waits for admission").message;
    r.tick(20);
    assert.ok(admissions > 0);
    assert.deepEqual(r.driver.writes, []);
    assert.equal(r.store.getDeliveryConfirmationIntent(head.id), null);
    admit = true;
    r.tick(20);
    assert.deepEqual(r.driver.writes, [head.id]);
    assert.equal(r.store.getDeliveryConfirmationIntent(head.id)?.state, "awaiting_confirmation");
  } finally { r.store.close(); }
});

test("a head held on an unresolved confirmation is not offered for turn admission until the hold is resolved", () => {
  for (const reason of ["refused", "unknown"] as const) {
    let admissions = 0;
    const r = rig(() => { admissions += 1; return true; });
    try {
      const held = r.store.send(r.bee.id, "held head").message;
      const behind = r.store.send(r.bee.id, "queued behind the held head").message;
      const wireLine = "fixture";
      r.store.prepareDeliveryConfirmationIntent({ beeId: r.bee.id, messageId: held.id, generation: 1, wireLine, digest: createHash("sha256").update(wireLine).digest("hex"), host: { pid: 123, birth: "linux:123", bootId: "11111111-1111-1111-1111-111111111111" } });
      r.store.holdDeliveryConfirmation(held.id, reason);
      admissions = 0;
      r.tick(2700);
      console.log(`reason=${reason} admissions/min=${admissions}`);
      assert.equal(admissions, 0, `admission asked ${admissions} times in a minute for a head that cannot be delivered`);
      assert.deepEqual(r.driver.deliveredIds, []);
      assert.equal(r.store.getDeliveryConfirmationIntent(held.id)?.state, "held");
      const resolved = r.store.resolveDeliveryConfirmation({ beeId: r.bee.id, messageId: held.id, generation: 1, action: "resend_anyway", idempotencyKey: `resend-${reason}` });
      r.tick(50);
      assert.ok(admissions > 0, "admission is asked again once the head can be delivered");
      assert.deepEqual(r.driver.deliveredIds, [resolved.replacementMessageId, behind.id]);
    } finally { r.store.close(); }
  }
});

test("a refused admission still stops a deliverable head", () => {
  let admissions = 0;
  let admit = false;
  const r = rig(() => { admissions += 1; return admit; });
  try {
    const msg = r.store.send(r.bee.id, "waits for admission").message;
    r.tick(20);
    assert.ok(admissions > 0);
    assert.deepEqual(r.driver.deliveredIds, []);
    admit = true;
    r.tick(20);
    assert.deepEqual(r.driver.deliveredIds, [msg.id]);
  } finally { r.store.close(); }
});
