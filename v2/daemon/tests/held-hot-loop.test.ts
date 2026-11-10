import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/store.ts";
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

function rig() {
  const root = mkdtempSync(join(tmpdir(), "held-hot-loop-"));
  let time = 1000;
  const now = () => time;
  const store = openCoreStore(join(root, "core.sqlite"), { now, ephemeral: true });
  const driver = new AuthFailingDriver(now);
  const logs: string[] = [];
  const core = new DaemonCore({ store, driver, now, log: (line: string) => logs.push(line), onI1Violation: () => {}, policy: { idleWindowSteps: null, commandsPerStep: 8, i1DeadlineSteps: 1_000_000, bootHangTimeoutSteps: 100000 } });
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
