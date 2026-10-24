import assert from "node:assert/strict";
import {test} from "node:test";
import {openCoreStore} from "../../core/src/index.ts";
import {harness} from "../../core/tests/helpers.ts";
import {DaemonCore} from "../src/loops.ts";
import {FakeDriver} from "./helpers.ts";

function rig() {
  const h = harness();
  let now = 1000;
  let store = openCoreStore(h.path, {now: () => now, ephemeral: true});
  const {bee, runtime} = store.createBee({name: "recovered", agent: "stub", substrate: "hsr", cwd: "/tmp"});
  store.recordRuntimeProc(bee.id, runtime.generation, {pid: 123, pidStartedAt: now});
  const driver = new FakeDriver(() => now);
  driver.procs.set(bee.id, {generation: runtime.generation, pid: 123, pidStartedAt: now, degraded: false});
  let stops = 0;
  const stop = driver.stop.bind(driver);
  driver.stop = (...args) => {stops++; return stop(...args);};
  const makeCore = () => new DaemonCore({store, driver, now: () => now, log() {}, policy: {bootHangTimeoutSteps: 50, commandsPerStep: 8}});
  let core = makeCore();
  core.boot([{beeId: bee.id, generation: runtime.generation}]);
  now = 100000;
  core.step();
  assert.equal(stops, 0);
  return {
    bee, runtime, driver,
    get store() { return store; },
    get core() { return core; },
    get stops() { return stops; },
    at(value: number) { now = value; },
    bind() {
      assert.equal(store.runtimeIdentityHooks().bindPendingStart!(bee.id, runtime.generation, 1000, {pid: 123, birth: "darwin:1:0", bootId: ""}), true);
      core.resolveProcessIdentity(bee.id, runtime.generation);
    },
    restart() { store.close(); store = openCoreStore(h.path, {now: () => now, ephemeral: true}); core = makeCore(); core.boot(); },
    cleanup() { store.close(); h.cleanup(); },
  };
}

for (const staleStop of [false, true]) test(`authenticated pending recovery gets a durable readiness budget (stale stop=${staleStop})`, () => {
  const r = rig();
  try {
    const oldStop = staleStop ? r.store.enqueueCommand("stop", r.bee.id, {cause: "stopped_by_system", reason: "hang_policy"}) : null;
    r.bind(); r.core.step();
    assert.equal(r.stops, 0);
    assert.equal(r.store.currentRuntime(r.bee.id)!.state, "booting");
    assert.equal(r.store.currentRuntime(r.bee.id)!.startedAt, r.runtime.startedAt);
    if (oldStop) {
      assert.equal(r.store.getCommand(oldStop.id)!.status, "queued");
      assert.equal(r.store.getCommand(oldStop.id)!.nextAttemptAt, 100051);
      assert.equal(r.store.getCommand(oldStop.id)!.attempts, 0);
    }
    r.at(100020); r.restart(); r.core.step();
    assert.equal(r.stops, 0);
    r.core.resolveProcessIdentity(r.bee.id, r.runtime.generation);
    r.at(100040);
    r.driver.events.push({beeId: r.bee.id, generation: r.runtime.generation, kind: "booted", pid: 123, pidStartedAt: 1000});
    r.driver.events.push({beeId: r.bee.id, generation: r.runtime.generation, kind: "turn_ended"});
    const sent = r.store.send(r.bee.id, "queued during recovery", {urgency: "idle"});
    r.core.step();
    assert.equal(r.store.getMessage(sent.message.id)!.deliveredGeneration, r.runtime.generation);
    r.at(100100); r.core.step();
    assert.equal(r.stops, 0);
    assert.equal(r.store.currentRuntime(r.bee.id)!.pid, 123);
    assert.equal(r.store.currentRuntime(r.bee.id)!.generation, r.runtime.generation);
    if (oldStop) {
      assert.equal(r.store.getCommand(oldStop.id)!.status, "done");
      assert.equal(r.store.getCommand(oldStop.id)!.args.hangPolicySkipped, true);
    }
  } finally {r.cleanup();}
});

test("a recovered but never-ready generation times out once after the same budget across restart", () => {
  const r = rig();
  try {
    const oldStop = r.store.enqueueCommand("stop", r.bee.id, {cause: "stopped_by_system", reason: "hang_policy"});
    r.bind(); r.core.step();
    assert.equal(r.stops, 0);
    r.at(100020); r.restart();
    r.at(100050); r.core.step();
    assert.equal(r.stops, 0);
    r.at(100051); r.core.step(); r.core.step();
    assert.equal(r.stops, 1);
    assert.equal(r.store.getCommand(oldStop.id)!.status, "done");
    assert.equal(r.store.getCommand(oldStop.id)!.attempts, 0);
    assert.equal(r.store.currentRuntime(r.bee.id)!.state, "stopped");
    assert.equal(r.store.getBee(r.bee.id)!.spawnFailures, 1);
  } finally {r.cleanup();}
});

test("a deferred hang stop cannot block an explicit stop or cross into a new generation", () => {
  const r = rig();
  try {
    const oldStop = r.store.enqueueCommand("stop", r.bee.id, {cause: "stopped_by_system", reason: "hang_policy"});
    r.bind(); r.core.step();
    const userStop = r.store.enqueueCommand("stop", r.bee.id, {cause: "stopped_by_user"});
    r.at(100010); r.core.step(); r.core.step();
    assert.equal(r.stops, 1);
    assert.equal(r.store.getCommand(userStop.id)!.status, "done");
    assert.equal(r.store.getBee(r.bee.id)!.spawnFailures, 0);
    const next = r.store.reviveBee(r.bee.id, {proc: {pid: 124, pidStartedAt: 100010}});
    r.driver.procs.set(r.bee.id, {generation: next.generation, pid: 124, pidStartedAt: 100010, degraded: false});
    r.at(100051); r.core.step();
    assert.equal(r.stops, 1);
    assert.equal(r.store.getCommand(oldStop.id)!.status, "done");
    r.at(100061); r.core.step(); r.core.step();
    assert.equal(r.stops, 2);
    assert.equal(r.store.currentRuntime(r.bee.id)!.generation, next.generation);
    assert.equal(r.store.currentRuntime(r.bee.id)!.state, "stopped");
  } finally {r.cleanup();}
});

test("skipping a hang stop on synthetic readiness does not miscount a later system stop as a boot failure", () => {
  const r = rig();
  try {
    const oldStop = r.store.enqueueCommand("stop", r.bee.id, {cause: "stopped_by_system", reason: "hang_policy"});
    r.bind(); r.core.step();
    r.driver.events.push({beeId: r.bee.id, generation: r.runtime.generation, kind: "booted", pid: 123, pidStartedAt: 1000, synthetic: true});
    r.at(100051); r.core.step();
    assert.equal(r.stops, 0);
    assert.equal(r.store.getCommand(oldStop.id)!.args.hangPolicySkipped, true);
    r.store.enqueueCommand("stop", r.bee.id, {cause: "stopped_by_system", reason: "idle_window"});
    r.core.step(); r.core.step();
    assert.equal(r.stops, 1);
    assert.equal(r.store.getBee(r.bee.id)!.spawnFailures, 0);
  } finally {r.cleanup();}
});
