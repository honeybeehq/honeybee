import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { replayAudit } from "../../core/src/audit.ts";
import { openCoreStore } from "../../core/src/store.ts";
import type { HumanChatAdmission } from "../../core/src/types.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "human-first-"));
  let time = 1000;
  const now = () => ++time;
  let store = openCoreStore(join(root, "core.sqlite"), { now, ephemeral: true });
  const driver = new FakeDriver(now);
  const violations: unknown[] = [];
  const options = () => ({ store, driver, now, log: () => {}, onI1Violation: (event: unknown) => violations.push(event), policy: { idleWindowSteps: null, commandsPerStep: 8, i1DeadlineSteps: 50, bootHangTimeoutSteps: 100000 } });
  let core = new DaemonCore(options());
  core.boot();
  const bee = store.createBee({ name: "fixture", agent: "stub", substrate: "hsr", cwd: root }).bee;
  store.enqueueCommand("spawn", bee.id);
  for (let i = 0; i < 4; i++) core.step();
  const event = (kind: "turn_started" | "turn_ended") => { driver.events.push({ beeId: bee.id, generation: 1, kind }); core.step(); };
  return {
    get store() { return store; }, get core() { return core; }, driver, bee,
    event, violations,
    advance(amount: number) { time += amount; core.step(); },
    human(body: string, key = body, humanFirst: boolean | undefined = true, urgency: "next" | "idle" | "now" = "next") {
      const humanChat: HumanChatAdmission = { version: 1, authorityId: "fixture-apiary", admissionId: key, beeId: bee.id, bodySha256: createHash("sha256").update(body).digest("hex"), idempotencyKey: key, ...(humanFirst === undefined ? {} : { humanFirst }) };
      return store.send(bee.id, body, { humanChat, urgency }).message;
    },
    restart() { store.close(); store = openCoreStore(join(root, "core.sqlite"), { now, ephemeral: true }); core = new DaemonCore(options()); core.boot(); },
    close() { store.close(); },
  };
}

test("human-first holds tool-turn input, then runs humans FIFO one turn each before background", () => {
  const r = rig();
  try {
    r.event("turn_started");
    const background = r.store.send(r.bee.id, "older background", { urgency: "idle", senderKind: "automation" }).message;
    const human1 = r.human("human 1");
    const human2 = r.human("human 2");
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, []);
    assert.equal(r.store.getBee(r.bee.id)?.lastTurnTrigger?.humanAt, null);
    r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [human1.id]);
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [human1.id]);
    r.event("turn_started");
    assert.deepEqual(r.driver.deliveredIds, [human1.id]);
    r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [human1.id, human2.id]);
    assert.equal(r.store.getMessage(background.id)?.deliveredAt, null);
    r.event("turn_started"); r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [human1.id, human2.id, background.id]);
  } finally { r.close(); }
});

test("unique admission keeps one row and timestamp; conflicting key/body/authority refuses", () => {
  const r = rig();
  try {
    const first = r.human("hello", "stable");
    const policy = r.store.humanFirstPolicy(r.bee.id);
    assert.deepEqual(r.human("hello", "stable"), first);
    assert.deepEqual(r.store.humanFirstPolicy(r.bee.id), policy);
    assert.equal(r.store.listMessages(r.bee.id).length, 1);
    assert.throws(() => r.human("different", "stable"), /bound/);
    assert.throws(() => r.store.assertHumanChatBinding(undefined, "hello", r.bee.id, "stable"), /authenticated human/);
    r.restart();
    assert.deepEqual(r.human("hello", "stable"), first);
    assert.deepEqual(r.store.humanFirstPolicy(r.bee.id), policy);
  } finally { r.close(); }
});

test("daemon/store restart while waiting preserves pending order and policy", () => {
  const r = rig();
  try {
    r.event("turn_started");
    const background = r.store.send(r.bee.id, "background", { urgency: "idle" }).message;
    const h1 = r.human("one"); const h2 = r.human("two");
    r.core.step(); r.restart(); r.core.step();
    assert.deepEqual(r.driver.deliveredIds, []);
    r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [h1.id]);
    r.restart(); r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [h1.id]);
    r.event("turn_started"); r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [h1.id, h2.id]);
    assert.equal(r.store.getMessage(background.id)?.deliveredAt, null);
  } finally { r.close(); }
});

test("policy off retains native next accept point and eligible FIFO; senderKind grants no priority", () => {
  const r = rig();
  try {
    r.event("turn_started");
    const bg = r.store.send(r.bee.id, "background").message;
    const h = r.human("human", "human", false);
    r.core.step(); r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [bg.id, h.id]);
    r.event("turn_ended");
    r.event("turn_started");
    r.store.setHumanFirstPolicy(r.bee.id, true);
    const fake = r.store.send(r.bee.id, "forged human", { senderKind: "human" }).message;
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [bg.id, h.id, fake.id]);
  } finally { r.close(); }
});

test("explicit human now retains interrupt semantics under policy", () => {
  const r = rig();
  try {
    r.event("turn_started");
    const human = r.human("cancel", "cancel", true, "now");
    r.core.step();
    assert.equal(r.driver.interrupts.length, 1);
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [human.id]);
  } finally { r.close(); }
});

test("held oldest human blocks younger human and ordinary background", () => {
  const r = rig();
  try {
    const bg = r.store.send(r.bee.id, "background").message;
    const h1 = r.human("held"); const h2 = r.human("second");
    r.store.prepareUnknownDeliveryConfirmationIntent({ beeId: r.bee.id, generation: 1, messageId: h1.id }, "host_auth_failed");
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, []);
    assert.equal(r.store.pendingHumanChatId(r.bee.id), h1.id);
    assert.deepEqual(r.store.undeliveredMessages(r.bee.id).map(m => m.id), [bg.id, h1.id, h2.id]);
  } finally { r.close(); }
});

test("a newer explicit now interrupts without overtaking the oldest human", () => {
  const r = rig();
  try {
    r.event("turn_started");
    const h1 = r.human("oldest");
    const h2 = r.human("interrupt", "interrupt", true, "now");
    r.core.step(); r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [h1.id]);
    r.event("turn_started"); r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [h1.id, h2.id]);
  } finally { r.close(); }
});

test("a policy enabled before a substrate change holds fresh human delivery on tmux", () => {
  const r = rig();
  try {
    const human = r.human("fresh");
    const actual = r.store.getBee.bind(r.store);
    r.store.getBee = id => { const bee = actual(id); return bee ? { ...bee, substrate: "tmux" } : null; };
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, []);
    assert.equal(r.store.getMessage(human.id)?.deliveredAt, null);
  } finally { r.close(); }
});


test("schema 47 migration adds human policy without upgrading legacy senderKind provenance", () => {
  const root = mkdtempSync(join(tmpdir(), "human-migration-"));
  const path = join(root, "core.sqlite");
  let store = openCoreStore(path, { ephemeral: true });
  const bee = store.createBee({ name: "legacy", agent: "stub", substrate: "hsr", cwd: root }).bee;
  const old = store.send(bee.id, "legacy operator relay", { senderKind: "human" }).message;
  store.close();
  const db = new DatabaseSync(path);
  db.exec("DROP INDEX mailbox_fifo_pending; ALTER TABLE mailbox DROP COLUMN human_chat; DROP TABLE human_first_policies; DROP TABLE human_chat_admissions; UPDATE meta SET value='47' WHERE key='schema_version'");
  db.close();
  store = openCoreStore(path, { ephemeral: true });
  try {
    assert.equal(store.getMessage(old.id)?.humanChat, undefined);
    assert.equal(store.humanFirstPolicy(bee.id).enabled, false);
    assert.deepEqual(store.readDaemonWork()[0]?.pending.map(m => m.id), [old.id]);
    assert.deepEqual(store.listHumanFirstPolicies(), []);
  } finally { store.close(); }
});


test("human policy and admission receipts replay exactly and delete with their bee", () => {
  const r = rig();
  try {
    r.human("human", "key");
    r.store.setHumanFirstPolicy(r.bee.id, false);
    r.store.setHumanFirstPolicy(r.bee.id, true);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    r.store.deleteBee(r.bee.id);
    assert.deepEqual(r.store.listHumanFirstPolicies(), []);
    assert.deepEqual(r.store.listHumanChatAdmissions(), []);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    assert.throws(() => r.human("human", "key"), /not found/);
  } finally { r.close(); }
});

test("I1 suspends intended human-first holds then measures a genuinely eligible delivery refusal", () => {
  const r = rig();
  try {
    r.event("turn_started");
    r.store.send(r.bee.id, "background next");
    r.human("human next");
    r.advance(100000);
    assert.deepEqual(r.violations, []);
    r.event("turn_ended");
    r.advance(100000);
    assert.deepEqual(r.violations, []);
    r.event("turn_started");
    r.driver.acceptDeliveries = false;
    r.event("turn_ended");
    assert.deepEqual(r.violations, []);
    r.advance(1000);
    assert.equal(r.violations.length, 1);
  } finally { r.close(); }
});


test("trusted quota recovery delivery gate keeps precedence over pending human chat", () => {
  const r = rig();
  try {
    const continuation = r.store.send(r.bee.id, "quota continuation", { origin: "quota.resume" }).message;
    const human = r.human("human after recovery");
    r.store.quotaDeliveryGate = () => ({ held: false, messageIds: r.store.getMessage(continuation.id)?.deliveredAt === null ? [continuation.id] : [] });
    r.core.step();
    assert.deepEqual(r.driver.deliveredIds, [continuation.id]);
    assert.equal(r.store.getMessage(human.id)?.deliveredAt, null);
    r.event("turn_started");
    r.advance(100000);
    assert.deepEqual(r.violations, []);
    r.event("turn_ended");
    assert.deepEqual(r.driver.deliveredIds, [continuation.id, human.id]);
  } finally { r.close(); }
});
