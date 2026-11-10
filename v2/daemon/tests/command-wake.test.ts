import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore } from "../../core/src/store.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "command-wake-"));
  let time = 1000;
  const now = () => time;
  const store = openCoreStore(join(root, "core.sqlite"), { now, ephemeral: true });
  const driver = new FakeDriver(now);
  const core = new DaemonCore({ store, driver, now, log: () => {}, onI1Violation: () => {}, policy: { idleWindowSteps: null, commandsPerStep: 8, i1DeadlineSteps: 1_000_000, bootHangTimeoutSteps: 100000 } });
  core.boot();
  const bee = store.createBee({ name: "fixture", agent: "stub", substrate: "hsr", cwd: root }).bee;
  store.enqueueCommand("spawn", bee.id);
  const tick = (count: number, ms = 22): void => { for (let i = 0; i < count; i++) { time += ms; core.step(); } };
  tick(4);
  assert.equal(store.currentRuntime(bee.id)?.state, "idle");
  let claims = 0;
  const claim = store.claimNextCommand.bind(store);
  store.claimNextCommand = (options) => { claims += 1; return claim(options); };
  return { store, driver, core, bee, tick, advance: (ms: number) => { time += ms; }, claims: () => claims, forget: () => { claims = 0; } };
}

test("a step claims commands only when a command row was written or came due", () => {
  const r = rig();
  try {
    r.tick(500);
    assert.equal(r.claims(), 0, "quiet steps claim nothing");

    r.store.tagBee(r.bee.id, { add: ["unrelated"] });
    r.driver.events.push({ beeId: r.bee.id, generation: 1, kind: "turn_started" }, { beeId: r.bee.id, generation: 1, kind: "turn_ended" });
    r.tick(50);
    assert.equal(r.store.currentRuntime(r.bee.id)?.state, "idle");
    assert.equal(r.claims(), 0, "a bee change that writes no command row claims nothing");

    const stop = r.store.enqueueCommand("stop", r.bee.id);
    r.tick(1);
    assert.ok(r.claims() >= 1, "an enqueued command is claimed on the next step");
    assert.notEqual(r.store.getCommand(stop.id)?.status, "queued");
  } finally { r.store.close(); }
});

test("a requeued command is claimed again when its retry time comes, with no other change", () => {
  const r = rig();
  try {
    const stop = r.store.enqueueCommand("stop", r.bee.id);
    const claimed = r.store.claimNextCommand();
    assert.equal(claimed?.id, stop.id);
    r.store.holdIdentityCommand(stop.id);
    assert.equal(r.store.getCommand(stop.id)?.status, "queued");
    r.tick(1);
    r.forget();
    r.tick(20);
    assert.equal(r.claims(), 0, "nothing is claimed before the retry time");
    assert.equal(r.store.getCommand(stop.id)?.status, "queued");
    r.advance(1_000);
    r.tick(2);
    assert.ok(r.claims() >= 1, "the retry time alone wakes the claim");
    assert.notEqual(r.store.getCommand(stop.id)?.status, "queued");
  } finally { r.store.close(); }
});

test("a due command that stays blocked is offered on every step until it can be claimed", () => {
  const r = rig();
  try {
    r.core.retainProcessIdentity(r.bee.id, 1);
    const stop = r.store.enqueueCommand("stop", r.bee.id);
    r.tick(1);
    r.forget();
    r.tick(10);
    assert.equal(r.store.getCommand(stop.id)?.status, "queued");
    assert.equal(r.claims(), 10, "a blocked due command keeps the claim awake");
  } finally { r.store.close(); }
});
