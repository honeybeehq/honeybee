import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const options = () => ({ store, driver, now, log: () => {}, policy: { idleWindowSteps: null, commandsPerStep: 8, bootHangTimeoutSteps: 100000 } });
  let core = new DaemonCore(options());
  core.boot();
  const bee = store.createBee({ name: "fixture", agent: "stub", substrate: "hsr", cwd: root }).bee;
  store.enqueueCommand("spawn", bee.id);
  for (let i = 0; i < 4; i++) core.step();
  const event = (kind: "turn_started" | "turn_ended") => { driver.events.push({ beeId: bee.id, generation: 1, kind }); core.step(); };
  return {
    get store() { return store; }, get core() { return core; }, driver, bee,
    event,
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
