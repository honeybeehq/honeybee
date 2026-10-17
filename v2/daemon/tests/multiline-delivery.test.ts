import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCoreStore } from "../../core/src/store.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";
import type { DeliverOutcome } from "../../harness/src/driver.ts";

class MultilineDriver extends FakeDriver {
  refusal: string | null | undefined = undefined;
  readonly calls: number[] = [];
  override deliver(beeId: string, generation: number, messageId: number, body: string, options?: { multilineWaitExpired?: boolean }): DeliverOutcome {
    this.calls.push(messageId);
    if (body.includes("\n") && this.refusal !== null && (!options?.multilineWaitExpired || this.refusal === "multiline_type_mode") && this.refusal !== "multiline_bracketed_paste_version_unsupported" && this.refusal !== "multiline_bracketed_paste_unknown") return { accepted: false, reason: "not_ready", ...(this.refusal ? { detail: this.refusal } : {}) };
    return super.deliver(beeId, generation, messageId, body);
  }
}

function rig(telemetry: boolean) {
  const root = mkdtempSync(join(tmpdir(), "multiline-loops-"));
  const clock = { now: 1000 };
  const store = openCoreStore(join(root, "core.sqlite3"), { now: () => clock.now, ephemeral: true });
  const driver = new MultilineDriver(() => clock.now);
  const core = new DaemonCore({ store, driver, log: () => {}, now: () => clock.now, policy: { idleWindowSteps: null, commandsPerStep: 8, bootHangTimeoutSteps: 50 }, ...(telemetry ? { onI1Violation: () => {} } : {}) });
  core.boot();
  const bee = store.createBee({ name: "multiline", agent: "stub", substrate: "tmux", cwd: root }).bee;
  store.enqueueCommand("spawn", bee.id);
  for (let index = 0; index < 4; index++) core.step();
  assert.equal(store.currentRuntime(bee.id)?.state, "idle");
  return { store, driver, core, clock, bee, cleanup: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const telemetry of [false, true]) {
  test(`multiline busy waits without fallback and delivers inline; telemetry=${telemetry}`, () => {
    const r = rig(telemetry);
    try {
      const mail = r.store.send(r.bee.id, "first\nsecond").message;
      for (let index = 0; index < 5; index++) { r.clock.now += 60_000; r.core.step(); }
      assert.equal(r.store.multilineDelivery(mail.id), undefined);
      assert.equal(r.store.getMessage(mail.id)?.deliveredAt, null);
      r.driver.refusal = null;
      r.core.step();
      assert.notEqual(r.store.getMessage(mail.id)?.deliveredAt, null);
      assert.deepEqual(r.driver.deliveredIds, [mail.id]);
    } finally { r.cleanup(); }
  });

  test(`mixed busy and unsupported counts only unsupported then resumes main FIFO; telemetry=${telemetry}`, () => {
    const r = rig(telemetry);
    try {
      const first = r.store.send(r.bee.id, "one\ntwo").message;
      const second = r.store.send(r.bee.id, "second").message;
      const third = r.store.send(r.bee.id, "third").message;
      r.core.step();
      assert.equal(r.store.multilineDelivery(first.id), undefined);
      r.driver.refusal = "multiline_bracketed_paste_disabled";
      r.core.step();
      assert.equal(r.store.multilineDelivery(first.id)?.attempts, 1);
      r.driver.refusal = undefined;
      r.clock.now += 100_000;
      r.core.step();
      assert.equal(r.store.multilineDelivery(first.id)?.attempts, 1);
      r.driver.refusal = "multiline_bracketed_paste_disabled";
      r.clock.now += 100_000;
      r.core.step();
      assert.equal(r.store.multilineDelivery(first.id)?.stage, "waiting");
      assert.equal(r.store.multilineDelivery(first.id)?.unsupportedMs, 0);
      r.core.step();
      assert.equal(r.store.multilineDelivery(first.id)?.stage, "expired");
      assert.equal(r.store.multilineDelivery(first.id)?.notice, null);
      r.core.step(); r.core.step(); r.core.step();
      assert.deepEqual(r.driver.deliveredIds, [first.id, second.id, third.id]);
      assert.equal(r.store.multilineDelivery(first.id)?.stage, "delivered");
      assert.equal(r.store.multilineDelivery(first.id)?.notice, null);
    } finally { r.cleanup(); }
  });

  for (const detail of ["multiline_bracketed_paste_version_unsupported", "multiline_bracketed_paste_unknown"]) test(`unsupported or unknown retains main delivery: ${detail}; telemetry=${telemetry}`, () => {
    const r = rig(telemetry);
    try {
      const first = r.store.send(r.bee.id, "one\ntwo").message;
      r.driver.refusal = detail;
      r.core.step();
      assert.equal(r.store.multilineDelivery(first.id), undefined);
      assert.notEqual(r.store.getMessage(first.id)?.deliveredAt, null);
      assert.deepEqual(r.driver.deliveredIds, [first.id]);
    } finally { r.cleanup(); }
  });
}

for (const telemetry of [false, true]) test(`thirty-second type expiry holds accepted mail without further driver calls; telemetry=${telemetry}`, () => {
  const r = rig(telemetry);
  try {
    const message = r.store.send(r.bee.id, "one\ntwo").message;
    r.driver.refusal = "multiline_type_mode";
    r.core.step();
    assert.equal(r.store.multilineDelivery(message.id)?.stage, "waiting");
    r.clock.now += 30_000;
    r.core.step();
    assert.equal(r.store.multilineDelivery(message.id)?.stage, "held");
    assert.equal(r.store.multilineDelivery(message.id)?.heldSince, r.clock.now);
    const before = r.store.auditRows().filter(row => row.kind.startsWith("mail.")).length;
    const calls = r.driver.calls.length;
    for (let index = 0; index < 5; index++) r.core.step();
    assert.equal(r.store.getMessage(message.id)?.body, "one\ntwo");
    assert.equal(r.store.getMessage(message.id)?.deliveredAt, null);
    assert.equal(r.store.auditRows().filter(row => row.kind.startsWith("mail.")).length, before);
    assert.equal(r.driver.calls.length, calls);
    assert.equal(r.store.multilineDelivery(message.id)?.stage, "held");
    assert.equal(r.store.multilineDelivery(message.id)?.heldSince, r.clock.now);
  } finally { r.cleanup(); }
});

for (const telemetry of [false,true]) test(`long busy turn produces no extra multiline writes or audit; telemetry=${telemetry}`,()=>{
 const r=rig(telemetry);
 try {
  const message=r.store.send(r.bee.id,"one\ntwo").message;
  r.driver.refusal="multiline_type_mode";r.core.step();
  const before=r.store.multilineDelivery(message.id);const audits=r.store.auditRows().filter(row=>row.kind.startsWith("mail."));
  r.driver.refusal=undefined;
  for(let index=0;index<1000;index++){r.clock.now+=1000;r.core.step();}
  assert.deepEqual(r.store.multilineDelivery(message.id),before);
  assert.deepEqual(r.store.auditRows().filter(row=>row.kind.startsWith("mail.")),audits);
  r.driver.refusal="multiline_type_mode";r.core.step();
  assert.equal(r.store.multilineDelivery(message.id)?.stage,"waiting");assert.equal(r.store.multilineDelivery(message.id)?.unsupportedMs,0);
 }finally{r.cleanup();}
});
