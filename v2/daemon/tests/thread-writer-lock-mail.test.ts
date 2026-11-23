import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, THREAD_WRITER_LOCKED_RETRYING_DETAIL, type CoreStore } from "../../core/src/index.ts";
import { DaemonCore, type DaemonPolicy, type I1ViolationEvent } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

interface Rig {
  dir: string;
  store: CoreStore;
  driver: FakeDriver;
  core: DaemonCore;
  clock: { now: number };
  violations: I1ViolationEvent[];
  ops: string[];
  cleanup: () => void;
}

function makeRig(policy: Partial<DaemonPolicy> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-loops-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, maxAttempts: 3, backoffBaseMs: 1, ephemeral: true });
  const driver = new FakeDriver(now);
  const violations: I1ViolationEvent[] = [];
  const ops: string[] = [];
  const core = new DaemonCore({
    store,
    driver,
    policy: {
      bootHangTimeoutSteps: 50,
      commandsPerStep: 8,
      ...policy,
    },
    now,
    log: (op) => ops.push(op),
    onI1Violation: (v) => violations.push(v),
  });
  core.boot();
  return {
    dir,
    store,
    driver,
    core,
    clock,
    violations,
    ops,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const D = THREAD_WRITER_LOCKED_RETRYING_DETAIL;
const setup = (): Rig => { const rig = makeRig({ i1DeadlineSteps: 10_000_000, bootHangTimeoutSteps: 60 * 60_000 }); rig.driver.autoBoot = false; rig.store.createBee({ id: "b", name: "b", agent: "stub", substrate: "hsr", cwd: "/tmp" }); rig.store.enqueueCommand("spawn", "b"); rig.core.step(); return rig; };
const lock = (rig: Rig): void => { const generation = rig.store.currentRuntime("b")!.generation; rig.driver.evidence.push({ beeId: "b", generation, flag: "resource_blocked", action: "set", detail: D }); rig.core.step(); rig.core.step(); };
const human = (rig: Rig, body: string) => rig.store.send("b", body, { humanChat: { version: 1, authorityId: "apiary", admissionId: body, beeId: "b", bodySha256: createHash("sha256").update(body).digest("hex"), idempotencyKey: body } } as never).message;
const stopUser = (rig: Rig): void => { rig.store.enqueueCommand("stop", "b", { cause: "stopped_by_user" }); rig.core.step(); rig.core.step(); };
const batchedAfterHumanTurn = (): Rig => {
  const rig = makeRig({ i1DeadlineSteps: 10_000_000, bootHangTimeoutSteps: 60 * 60_000, idleWindowSteps: null } as Partial<DaemonPolicy>);
  rig.store.createBee({ id: "b", name: "b", agent: "stub", substrate: "hsr", cwd: "/tmp" });
  rig.store.enqueueCommand("spawn", "b");
  for (let i = 0; i < 4; i++) rig.core.step();
  rig.store.setMailBatchingPolicy("b", true);
  human(rig, "h1");
  rig.core.step();
  const generation = rig.store.currentRuntime("b")!.generation;
  rig.driver.events.push({ beeId: "b", generation, kind: "turn_started" });
  rig.driver.events.push({ beeId: "b", generation, kind: "turn_ended" });
  rig.core.step();
  rig.core.step();
  stopUser(rig);
  rig.driver.autoBoot = false;
  rig.store.enqueueCommand("revive", "b");
  rig.core.step();
  rig.core.step();
  return rig;
};

for (const withLock of [true, false]) test(`lock-mail.1: mail released from batching after a user stop wakes the bee the same way with lock=${withLock}`, () => {
  const rig = batchedAfterHumanTurn();
  try {
    if (withLock) lock(rig);
    stopUser(rig);
    const starts = rig.driver.starts.length;
    rig.store.send("b", "peer during window", { sender: "bee-x" });
    for (let i = 0; i < 8; i++) { rig.clock.now += 120_001; rig.core.step(); rig.core.step(); }
    assert.equal(rig.driver.starts.length - starts, 1);
    assert.equal(rig.store.auditRows().filter((row) => row.kind === "wake.suppressed").length, 0);
    assert.deepEqual(rig.store.activeFlags("b"), []);
  } finally {
    rig.cleanup();
  }
});

for (const withLock of [true, false]) test(`lock-mail.2: accepted mail still gets a wake after a user stop with lock=${withLock}`, () => {
  const rig = setup();
  try {
    rig.store.send("b", "queued before the stop", { sender: "bee-x" });
    rig.core.step();
    if (withLock) lock(rig);
    const starts = rig.driver.starts.length;
    rig.store.enqueueCommand("stop", "b", { cause: "stopped_by_user" });
    for (let i = 0; i < 3; i++) rig.core.step();
    for (let i = 0; i < 6; i++) { rig.clock.now += 10 * 60_000; rig.core.step(); rig.core.step(); }
    assert.equal(rig.driver.starts.length - starts, 1, "one wake for the held mail, as without a lock");
    assert.equal(rig.store.getBee("b")!.lifecycle, "active");
  } finally {
    rig.cleanup();
  }
});

test("lock-mail.3: an archived bee in lock back-off stays archived with held mail until fresh mail arrives", () => {
  const rig = setup();
  try {
    rig.store.send("b", "queued before the archive", { sender: "bee-x" });
    rig.core.step();
    lock(rig);
    const starts = rig.driver.starts.length;
    rig.store.enqueueCommand("archive", "b");
    for (let i = 0; i < 3; i++) rig.core.step();
    for (let i = 0; i < 6; i++) { rig.clock.now += 10 * 60_000; rig.core.step(); rig.core.step(); }
    assert.equal(rig.store.getBee("b")!.lifecycle, "archived");
    assert.equal(rig.driver.starts.length, starts);
    rig.store.send("b", "fresh mail", { sender: "bee-x" });
    rig.core.step();
    rig.core.step();
    assert.equal(rig.driver.starts.length - starts, 1);
  } finally {
    rig.cleanup();
  }
});

test("lock-mail.4: lock evidence arriving after a pending user stop ends in a quiet stopped bee", () => {
  const rig = setup();
  try {
    const stop = rig.driver.stop.bind(rig.driver);
    rig.driver.stop = () => ({ hadProcess: true });
    rig.store.enqueueCommand("stop", "b", { cause: "stopped_by_user" });
    rig.core.step();
    rig.driver.evidence.push({ beeId: "b", generation: 1, flag: "resource_blocked", action: "set", detail: D });
    rig.core.step();
    rig.driver.stop = stop;
    rig.driver.procs.delete("b");
    rig.driver.events.push({ beeId: "b", generation: 1, kind: "exited", exitCause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    const starts = rig.driver.starts.length;
    rig.clock.now += 2 * 60 * 60_000;
    rig.core.step();
    rig.core.step();
    assert.equal(rig.driver.starts.length, starts);
    assert.equal(rig.store.view("b").threadWriterLock, undefined);
    assert.deepEqual(rig.store.activeFlags("b"), []);
  } finally {
    rig.cleanup();
  }
});

test("lock-mail.5: a boot failing for another reason after an expired lock window keeps its full retry budget and drops the stale lock flag", () => {
  const rig = setup();
  try {
    lock(rig);
    rig.clock.now += 31 * 60_000;
    rig.core.step();
    lock(rig);
    assert.equal(rig.store.view("b").threadWriterLock, "retries_stopped");
    rig.clock.now += 90 * 60_000;
    rig.driver.bootCrash = true;
    const starts = rig.driver.starts.length;
    rig.store.send("b", "after the lock episode", { sender: "bee-x" });
    for (let i = 0; i < 12; i++) { rig.core.step(); rig.core.step(); rig.clock.now += 60_000; }
    assert.equal(rig.driver.starts.length - starts, 3, "the whole boot budget is used");
    assert.deepEqual(rig.store.activeFlags("b").map((flag) => flag.flag), ["spawn_failed"]);
    assert.equal(rig.store.view("b").threadWriterLock, undefined);
  } finally {
    rig.cleanup();
  }
});

const raiseLockOnEveryBoot = (rig: Rig): void => {
  const start = rig.driver.start.bind(rig.driver);
  rig.driver.start = (beeId, generation) => {
    start(beeId, generation);
    rig.driver.evidence.push({ beeId, generation, flag: "resource_blocked", action: "set", detail: D });
  };
};
const queuedWake = (rig: Rig) => rig.store.listCommands({ beeId: "b", status: "queued" }).find((command) => command.verb === "send_wake");

test("lock-mail.6: a user stop of a lock-blocked bee with queued mail waits out the back-off when the lock is still held", () => {
  const rig = setup();
  try {
    rig.store.send("b", "queued before the stop", { sender: "bee-x" });
    rig.core.step();
    raiseLockOnEveryBoot(rig);
    lock(rig);
    const starts = rig.driver.starts.length;
    const stoppedAt = rig.clock.now;
    stopUser(rig);
    assert.equal(rig.driver.starts.length, starts, "no restart at once");
    const wake = queuedWake(rig);
    assert.ok(wake, "the held mail keeps a wake");
    assert.ok(wake.nextAttemptAt >= stoppedAt + 15_000, "the wake respects the lock back-off");
    rig.clock.now = wake.nextAttemptAt;
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.driver.starts.length, starts + 1);
    assert.equal(rig.store.currentRuntime("b")!.state, "stopped", "the lock is raised again and stops the retry");
    assert.equal(rig.store.view("b").threadWriterLock, "retrying");
  } finally {
    rig.cleanup();
  }
});

test("lock-mail.7: the same user stop after the window still gives held mail one back-off-respecting wake", () => {
  const rig = setup();
  try {
    rig.store.send("b", "queued before the stop", { sender: "bee-x" });
    rig.core.step();
    raiseLockOnEveryBoot(rig);
    lock(rig);
    for (let i = 0; i < 12 && rig.store.view("b").threadWriterLock !== "retries_stopped"; i++) {
      const wake = queuedWake(rig);
      if (!wake) break;
      rig.clock.now = wake.nextAttemptAt;
      rig.core.step();
      rig.core.step();
      rig.core.step();
    }
    assert.equal(rig.store.view("b").threadWriterLock, "retries_stopped");
    assert.equal(queuedWake(rig), undefined);
    const stoppedAt = rig.clock.now;
    const starts = rig.driver.starts.length;
    stopUser(rig);
    assert.equal(rig.driver.starts.length, starts, "no restart at once");
    const wake = queuedWake(rig);
    assert.ok(wake, "the stop is not suppressed after the window");
    assert.ok(wake.nextAttemptAt >= stoppedAt + 15_000, "the wake respects the lock back-off");
  } finally {
    rig.cleanup();
  }
});

test("lock-mail.8: lock evidence that schedules no stop never raises the retrying flag", () => {
  for (const shape of ["pending_stop", "stale_generation", "not_booting"] as const) {
    const rig = setup();
    try {
      const generation = rig.store.currentRuntime("b")!.generation;
      if (shape === "pending_stop") {
        rig.driver.stop = () => ({ hadProcess: true });
        rig.store.enqueueCommand("stop", "b", { cause: "stopped_by_system", reason: "hang_policy" });
        rig.core.step();
      }
      if (shape === "not_booting") {
        rig.driver.events.push({ beeId: "b", generation, kind: "booted", pid: rig.driver.procs.get("b")!.pid, pidStartedAt: rig.clock.now });
        rig.driver.events.push({ beeId: "b", generation, kind: "turn_ended" });
        rig.core.step();
      }
      const evidenceGeneration = shape === "stale_generation" ? generation + 1 : generation;
      rig.store.transact(() => (rig.core as unknown as { applyThreadWriterLockEvidence(beeId: string, generation: number): void }).applyThreadWriterLockEvidence("b", evidenceGeneration));
      assert.equal(rig.store.view("b").threadWriterLock, undefined, shape);
      assert.deepEqual(rig.store.activeFlags("b"), [], shape);
    } finally {
      rig.cleanup();
    }
  }
});
