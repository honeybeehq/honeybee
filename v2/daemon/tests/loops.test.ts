/**
 * WP4 unit tier: the DaemonCore loop cores under a controllable fake driver
 * and a virtual clock (spec 04 test plan: "loops against SimDriver — fast,
 * deterministic"). The full six-invariant proof of the shared executor/
 * delivery/boot-recovery logic lives in `v2:harness` / `v2:harness:real`, which drive
 * this same DaemonCore through the SimDaemon wrapper; here we pin the WP4
 * additions: scale-to-zero, flag policy, degraded-runtime policy, pid-at-
 * spawn recording, and I1 telemetry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beeTaskList, openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { DaemonCore, type DaemonPolicy, type I1ViolationEvent } from "../src/loops.ts";
import type { PerformanceRecorder } from "../src/performance.ts";
import { HsrDriver } from "../../driver-hsr/src/index.ts";
import { stubAdapter } from "../../adapters/src/index.ts";
import { AGENT_PATH, FakeDriver, sleep, waitFor } from "./helpers.ts";
import { BUZ_INJECTION_MARKER } from "../src/envelope.ts";

// Real child startup is load-dependent; assertions below still bound retries
// and verify admission. Match the runner-host tests' process wait ceiling.
const PROCESS_WAIT_TIMEOUT_MS = 60_000;

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

interface CapturedStepSnapshot {
  work: unknown[];
  i1: unknown[] | null;
}

function isStepSnapshot(value: unknown): value is CapturedStepSnapshot {
  return value !== null
    && typeof value === "object"
    && "work" in value
    && Array.isArray(value.work)
    && "i1" in value
    && (value.i1 === null || Array.isArray(value.i1));
}

function makeRig(policy: Partial<DaemonPolicy> = {}, performance?: PerformanceRecorder): Rig {
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
    performance,
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

function spawnIdleBee(rig: Rig, id = "bee-1"): void {
  rig.store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
  rig.store.enqueueCommand("spawn", id);
  rig.core.step(); // execute spawn (driver auto-boots: booted + turn_ended queued)
  rig.core.step(); // drain observations → running → idle
  rig.core.step();
  assert.equal(rig.store.currentRuntime(id)?.state, "idle");
}

function legacyI1Oracle(store: CoreStore, bound: number, now: number): I1ViolationEvent[] {
  const pendingByBee = new Map<string, ReturnType<CoreStore["listUndeliveredMessages"]>>();
  for (const message of store.listUndeliveredMessages()) {
    const pending = pendingByBee.get(message.beeId);
    if (pending) pending.push(message);
    else pendingByBee.set(message.beeId, [message]);
  }
  const violations: I1ViolationEvent[] = [];
  for (const { bee, runtime, view } of store.listBeeViewRows()) {
    if (view.flags.length > 0) continue;
    const pending = pendingByBee.get(bee.id) ?? [];
    pending.forEach((message, position) => {
      let base = message.enqueuedAt;
      if (message.urgency === "idle") {
        if (runtime?.state === "running" && runtime.bootEvidence === "real") return;
        base = Math.max(base, runtime?.updatedAt ?? message.enqueuedAt);
      }
      const deadline = base + (position + 1) * bound;
      if (now <= deadline) return;
      violations.push({
        detectedAt: now,
        beeId: bee.id,
        messageId: message.id,
        enqueuedAt: message.enqueuedAt,
        deadline,
        detail: `message ${message.id} undelivered past deadline (enqueued=${message.enqueuedAt} urgency=${message.urgency} pos=${position} deadline=${deadline} now=${now})`,
      });
    });
  }
  return violations;
}

test("model change waits when idle becomes working before command execution", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    const before = rig.store.currentRuntime("bee-1");
    const result = rig.store.reconfigureBee("bee-1", ["--model", "new", "--effort", "high"]);
    assert.equal(result.outcome, "queued");
    if (result.outcome !== "queued") throw new Error("expected queued change");
    // Apiary saw idle, but input was admitted before the command ran.
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_started", synthetic: true });
    rig.core.step();
    assert.equal(rig.driver.hasProcess("bee-1", 1), true, "must not stop the admitted turn");
    assert.equal(rig.store.getBee("bee-1")?.args, null, "must not change args during the turn");
    assert.equal(rig.store.getCommand(result.commandId)?.status, "queued");
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, before?.generation);
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.deepEqual(rig.store.getBee("bee-1")?.args, ["--model", "new", "--effort", "high"]);
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(rig.store.getCommand(result.commandId)?.status, "done");
  } finally {
    rig.cleanup();
  }
});

test("model admission folds a delivered turn before refusing without mutation", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_started", synthetic: true });
    assert.equal(rig.store.view("bee-1").working, false, "mirror still sees idle");
    rig.core.observe();
    const before = rig.store.dumpState();
    assert.throws(() => rig.store.reconfigureBee("bee-1", ["--model", "new"]), /is working/);
    assert.deepEqual(rig.store.dumpState(), before);
    assert.equal(rig.driver.hasProcess("bee-1", 1), true);
    assert.equal(rig.driver.starts.length, 1);
  } finally {
    rig.cleanup();
  }
});

test("deferred model change does not block other commands and stale generations do not change args", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    spawnIdleBee(rig, "other");
    const result = rig.store.reconfigureBee("bee-1", ["--model", "new"]);
    assert.equal(result.outcome, "queued");
    if (result.outcome !== "queued") throw new Error("expected queued change");
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_started" });
    rig.store.enqueueCommand("archive", "other");
    rig.core.step();
    assert.equal(rig.store.getBee("other")?.lifecycle, "archived");
    assert.equal(rig.store.getCommand(result.commandId)?.status, "queued");
    // A different operator action replaces this generation before idle.
    rig.driver.stop("bee-1", 1, "stopped_by_user");
    rig.store.updateRuntimeState("bee-1", 1, "stopped", { exitCause: "stopped_by_user" });
    rig.store.reviveBee("bee-1");
    rig.core.step();
    assert.equal(rig.store.getCommand(result.commandId)?.status, "done");
    assert.equal(rig.store.getBee("bee-1")?.args, null);
    assert.ok(rig.store.auditRows().some((r) => r.kind === "command.moot" && r.payload.commandId === result.commandId));
  } finally {
    rig.cleanup();
  }
});

for (const point of ["before_effect", "after_effect"] as const) {
  test(`model change recovers after executor crash ${point}`, () => {
    const rig = makeRig();
    let reopened: CoreStore | null = null;
    try {
      spawnIdleBee(rig);
      rig.store.reconfigureBee("bee-1", ["--model", "new"]);
      const crashing = new DaemonCore({
        store: rig.store, driver: rig.driver, now: () => rig.clock.now,
        log: (op) => rig.ops.push(op),
        policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
        faults: { executorCrash: () => point, driverTimeout: () => false },
      });
      assert.throws(() => crashing.step(), /executor crash/);
      rig.store.close();
      reopened = openCoreStore(join(rig.dir, "core.sqlite3"), { now: () => rig.clock.now, ephemeral: true });
      const recovered = new DaemonCore({
        store: reopened, driver: rig.driver, now: () => rig.clock.now,
        policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
        log: (op) => rig.ops.push(op),
      });
      recovered.boot();
      recovered.step();
      recovered.step();
      recovered.step();
      assert.deepEqual(reopened.getBee("bee-1")?.args, ["--model", "new"]);
      assert.equal(reopened.currentRuntime("bee-1")?.state, "idle");
      assert.equal(reopened.currentRuntime("bee-1")?.generation, 2);
      assert.equal(rig.driver.starts.length, 2, "one replacement runtime");
    } finally {
      reopened?.close();
      rig.cleanup();
    }
  });
}

test("model change resumes after daemon restart between settled stop and observed exit", () => {
  const rig = makeRig();
  let reopened: CoreStore | null = null;
  try {
    spawnIdleBee(rig);
    const result = rig.store.reconfigureBee("bee-1", ["--model", "new"]);
    assert.equal(result.outcome, "queued");
    if (result.outcome !== "queued") throw new Error("expected queued change");
    rig.core.step(); // stop completed, exit has not been folded
    assert.equal(rig.store.getCommand(result.commandId)?.status, "done");
    rig.driver.events = []; // the new driver has no old in-memory observations
    rig.store.close();
    reopened = openCoreStore(join(rig.dir, "core.sqlite3"), { now: () => rig.clock.now, ephemeral: true });
    const recovered = new DaemonCore({
      store: reopened, driver: rig.driver, now: () => rig.clock.now,
      policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
      log: (op) => rig.ops.push(op),
    });
    recovered.boot();
    recovered.step();
    recovered.step();
    assert.deepEqual(reopened.getBee("bee-1")?.args, ["--model", "new"]);
    assert.equal(reopened.currentRuntime("bee-1")?.state, "idle");
    assert.equal(reopened.currentRuntime("bee-1")?.generation, 2);
    assert.equal(rig.driver.starts.length, 2);
  } finally {
    reopened?.close();
    rig.cleanup();
  }
});

test("model change defers across real HSR input admission before the turn observation is folded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-model-admission-"));
  const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true });
  const starts: Array<string[] | null> = [];
  const driver = new HsrDriver({
    sessionLogDir: join(dir, "logs"), stopKillGraceMs: 300,
    resolve: (beeId) => {
      const args = store.getBee(beeId)?.args ?? null;
      starts.push(args);
      return { adapter: stubAdapter, command: process.execPath, args: [AGENT_PATH, ...(args ?? [])], cwd: dir };
    },
  });
  const policy: DaemonPolicy = { bootHangTimeoutSteps: 5000, commandsPerStep: 8 };
  const core = new DaemonCore({ store, driver, policy, now: Date.now, log: () => {} });
  try {
    store.createBee({ id: "b", name: "b", agent: "stub", substrate: "hsr", cwd: dir });
    store.enqueueCommand("spawn", "b");
    await waitFor(() => { core.step(); return store.currentRuntime("b")?.state === "idle"; }, "real stub idle", PROCESS_WAIT_TIMEOUT_MS);
    const result = store.reconfigureBee("b", ["--model", "new", "--effort", "high"]);
    assert.equal(result.outcome, "queued");
    if (result.outcome !== "queued") throw new Error("expected queued change");
    store.send("b", "@hang");
    // Keep the executor disabled until the runner socket admits the input.
    // The driver opens a turn synchronously on that delivery, but its
    // observation is still queued until the next core step.
    policy.commandsPerStep = 0;
    await waitFor(() => {
      core.step();
      assert.equal(store.getCommand(result.commandId)?.status, "queued", "model change stays deferred");
      assert.equal(store.getBee("b")?.args, null, "pending model args stay unapplied");
      assert.equal(driver.hasProcess("b", 1), true, "admission wait preserves generation 1");
      return store.undeliveredMessages("b").length === 0;
    }, "real HSR input admitted", PROCESS_WAIT_TIMEOUT_MS);
    assert.equal(store.view("b").working, false, "turn observation remains queued in the admission tick");
    policy.commandsPerStep = 8;
    core.step();
    assert.equal(store.view("b").working, true);
    assert.equal(store.getCommand(result.commandId)?.status, "queued");
    assert.equal(store.getBee("b")?.args, null);
    assert.equal(driver.hasProcess("b", 1), true);
    assert.deepEqual(starts, [null]);
    // Finish the fixture turn, then let the deferred command apply.
    await waitFor(() => driver.interrupt("b", 1).interrupted, "fixture accepts interrupt");
    await waitFor(() => {
      core.step();
      const rt = store.currentRuntime("b");
      return rt?.generation === 2 && rt.state === "idle";
    }, "new model runtime idle");
    assert.deepEqual(starts, [null, ["--model", "new", "--effort", "high"]]);
  } finally {
    driver.disposeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit.0: a tick uses bounded batch reads, independent of bee count, re-read only after a write", () => {
  const rig = makeRig();
  try {
    for (let i = 0; i < 50; i++) {
      const id = `batch-${i}`;
      rig.store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
    }

    let workReads = 0;
    const readDaemonWork = rig.store.readDaemonWork.bind(rig.store);
    rig.store.readDaemonWork = () => {
      workReads++;
      return readDaemonWork();
    };

    rig.core.step();
    // A quiet tick changes nothing between the policy and delivery phases, so
    // the delivery phase reuses the policy snapshot (audit seq unchanged).
    assert.equal(workReads, 1, "an unchanged tick takes one sparse work snapshot");

    // A queued command is claimed and executed between the policy and
    // delivery phases — a store write (audited) after the policy snapshot —
    // so delivery re-reads exactly once on that tick.
    rig.store.enqueueCommand("stop", "batch-0", { cause: "stopped_by_system", reason: "test" });
    workReads = 0;
    rig.core.step();
    assert.equal(workReads, 2, "a tick whose command phase wrote re-reads sparse work before delivery");
  } finally {
    rig.cleanup();
  }
});

test("unit.0a: the empty proof skips full snapshots and returns fresh containers without skipping flag expiry", () => {
  const captured: CapturedStepSnapshot[] = [];
  const performance: PerformanceRecorder = {
    startSpan: () => ({ end: () => undefined }),
    measureSync: <T>(_name: string, operation: () => T): T => {
      const result = operation();
      if (isStepSnapshot(result)) captured.push(result);
      return result;
    },
  };
  const rig = makeRig({ i1DeadlineSteps: 10 }, performance);
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "quiet-archived",
      name: "quiet-archived",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    rig.store.archiveBee(bee.id);
    rig.store.setFlag(bee.id, "resource_blocked", "expires before the snapshot", {
      resetsAt: rig.clock.now,
    });

    rig.store.listBeeViewRows = () => {
      throw new Error("empty proof unexpectedly read full bee views");
    };
    rig.store.listUndeliveredMessages = () => {
      throw new Error("empty proof unexpectedly read full mailbox rows");
    };
    rig.store.readDaemonWork = () => {
      throw new Error("enabled empty proof unexpectedly read sparse work");
    };
    rig.store.readDaemonStepInputs = () => {
      throw new Error("enabled empty proof unexpectedly read combined inputs");
    };
    rig.store.readI1PendingSnapshot = () => {
      throw new Error("unchanged enabled empty proof unexpectedly refreshed I1");
    };

    rig.core.step();
    assert.deepEqual(rig.store.activeFlags(bee.id), [], "flag expiry remains ahead of snapshot acquisition");
    rig.core.step();

    assert.equal(captured.length, 2, "each tick acquires its own empty snapshot");
    assert.deepEqual(captured.map((snapshot) => snapshot.work), [[], []]);
    assert.deepEqual(captured.map((snapshot) => snapshot.i1), [[], []]);
    assert.notEqual(captured[0]?.work, captured[1]?.work, "empty work arrays are fresh across ticks");
    assert.notEqual(captured[0]?.i1, captured[1]?.i1, "empty I1 arrays are fresh across ticks");
  } finally {
    rig.cleanup();
  }
});

test("unit.0a-disabled: an I1-disabled empty proof carries null instead of an unused array", () => {
  const captured: CapturedStepSnapshot[] = [];
  const performance: PerformanceRecorder = {
    startSpan: () => ({ end: () => undefined }),
    measureSync: <T>(_name: string, operation: () => T): T => {
      const result = operation();
      if (isStepSnapshot(result)) captured.push(result);
      return result;
    },
  };
  const rig = makeRig({}, performance);
  try {
    rig.core.step();
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0]?.work, []);
    assert.equal(captured[0]?.i1, null);
  } finally {
    rig.cleanup();
  }
});

test("unit.0b: a revive command refreshes an initially empty snapshot in the same tick", () => {
  const rig = makeRig({ i1DeadlineSteps: 10 });
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "revive-refresh",
      name: "revive-refresh",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    rig.store.enqueueCommand("revive", bee.id);

    let workReads = 0;
    let combinedReads = 0;
    let freshI1Reads = 0;
    const seenRuntimeStates: Array<string | null> = [];
    const readDaemonWork = rig.store.readDaemonWork.bind(rig.store);
    const readDaemonStepInputs = rig.store.readDaemonStepInputs.bind(rig.store);
    const readI1PendingSnapshot = rig.store.readI1PendingSnapshot.bind(rig.store);
    rig.store.readDaemonWork = () => {
      workReads += 1;
      return readDaemonWork();
    };
    rig.store.readDaemonStepInputs = () => {
      combinedReads += 1;
      const inputs = readDaemonStepInputs();
      seenRuntimeStates.push(inputs.work.find((row) => row.runtime.beeId === bee.id)?.runtime.state ?? null);
      return inputs;
    };
    rig.store.readI1PendingSnapshot = () => {
      freshI1Reads += 1;
      return readI1PendingSnapshot();
    };

    rig.core.step();

    assert.equal(rig.store.currentRuntime(bee.id)?.generation, 2);
    assert.equal(rig.store.currentRuntime(bee.id)?.state, "booting");
    assert.deepEqual(seenRuntimeStates, ["booting"], "the post-command acquisition sees the revived runtime");
    assert.equal(combinedReads, 1, "the post-command refresh replaces work and I1 together");
    assert.equal(workReads, 0, "I1-enabled acquisition does not take the standalone work path");
    assert.equal(freshI1Reads, 0, "the unchanged final phase reuses post-command I1");
  } finally {
    rig.cleanup();
  }
});

test("unit.0c: an outer rollback and reused audit sequence cannot preserve an uncommitted snapshot", () => {
  const rig = makeRig({ commandsPerStep: 0, bootHangTimeoutSteps: 50 });
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "rollback-refresh",
      name: "rollback-refresh",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    const committedSeq = rig.store.lastAuditSeq();
    let uncommittedSeq = -1;

    assert.throws(
      () => rig.store.transact(() => {
        rig.store.updateRuntimeState(bee.id, runtime.generation, "running", { synthetic: true });
        rig.core.step();
        assert.equal(rig.store.currentRuntime(bee.id)?.state, "running");
        uncommittedSeq = rig.store.lastAuditSeq();
        throw new Error("rollback after successful nested step");
      }),
      /rollback after successful nested step/,
    );

    assert.equal(rig.store.currentRuntime(bee.id)?.state, "booting");
    assert.equal(rig.store.lastAuditSeq(), committedSeq);
    rig.store.renameBee(bee.id, "sequence-reused");
    assert.equal(rig.store.lastAuditSeq(), uncommittedSeq, "SQLite reused the rolled-back audit sequence");

    rig.clock.now = runtime.startedAt + 51;
    rig.core.step();
    const hangStops = rig.store.listCommands({ beeId: bee.id, status: "queued" })
      .filter((command) => command.verb === "stop" && command.args.reason === "hang_policy");
    assert.equal(hangStops.length, 1, "the next tick reads fresh booting state and applies the hang policy");
  } finally {
    rig.cleanup();
  }
});

test("unit.0d: I1 sees stopped-runtime and absent-runtime mail", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-step-snapshot-mail-"));
  const path = join(dir, "core.sqlite3");
  const clock = { now: 1_000 };
  const now = (): number => clock.now;
  let store: CoreStore | null = openCoreStore(path, { now, ephemeral: true });
  try {
    const stopped = store.createBee({
      id: "stopped-runtime",
      name: "stopped-runtime",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    store.updateRuntimeState(stopped.bee.id, stopped.runtime.generation, "stopped", { exitCause: "clean" });
    const stoppedMessage = store.send(stopped.bee.id, "pending while stopped").message;

    const absent = store.createBee({
      id: "absent-runtime",
      name: "absent-runtime",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    const absentMessage = store.send(absent.bee.id, "pending without a runtime").message;
    store.close();

    const fixture = new DatabaseSync(path);
    try {
      fixture.prepare("DELETE FROM runtimes WHERE bee_id = ?").run(absent.bee.id);
    } finally {
      fixture.close();
    }

    store = openCoreStore(path, { now, ephemeral: true });
    const driver = new FakeDriver(now);
    const violations: I1ViolationEvent[] = [];
    const core = new DaemonCore({
      store,
      driver,
      policy: { bootHangTimeoutSteps: 50, commandsPerStep: 0, i1DeadlineSteps: 10 },
      now,
      log: () => undefined,
      onI1Violation: (violation) => violations.push(violation),
    });
    core.boot();
    assert.equal(store.currentRuntime(stopped.bee.id)?.state, "stopped");
    assert.equal(store.currentRuntime(absent.bee.id), null);

    clock.now = 1_011;
    core.step();
    assert.deepEqual(
      violations.map((violation) => violation.messageId).sort((a, b) => a - b),
      [stoppedMessage.id, absentMessage.id].sort((a, b) => a - b),
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit.0e: task supply refreshes the snapshot before I1 in the same tick", () => {
  const rig = makeRig({ i1DeadlineSteps: 1 });
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "task-refresh",
      name: "task-refresh",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    rig.store.setTaskSupply(bee.id, { on: true });
    const task = rig.store.addTask({
      list: beeTaskList(bee.id),
      title: "same-tick snapshot refresh",
      originKind: "user",
      originSender: "operator",
    }).task;

    let viewReads = 0;
    let mailboxReads = 0;
    let workReads = 0;
    let combinedReads = 0;
    let freshI1Reads = 0;
    const listBeeViewRows = rig.store.listBeeViewRows.bind(rig.store);
    const listUndeliveredMessages = rig.store.listUndeliveredMessages.bind(rig.store);
    const readDaemonWork = rig.store.readDaemonWork.bind(rig.store);
    const readDaemonStepInputs = rig.store.readDaemonStepInputs.bind(rig.store);
    const readI1PendingSnapshot = rig.store.readI1PendingSnapshot.bind(rig.store);
    rig.store.listBeeViewRows = () => {
      viewReads += 1;
      return listBeeViewRows();
    };
    rig.store.listUndeliveredMessages = () => {
      mailboxReads += 1;
      return listUndeliveredMessages();
    };
    rig.store.readDaemonWork = () => {
      workReads += 1;
      return readDaemonWork();
    };
    rig.store.readDaemonStepInputs = () => {
      combinedReads += 1;
      return readDaemonStepInputs();
    };
    rig.store.readI1PendingSnapshot = () => {
      freshI1Reads += 1;
      return readI1PendingSnapshot();
    };
    const tryFeedTaskSupply = rig.store.tryFeedTaskSupply.bind(rig.store);
    rig.store.tryFeedTaskSupply = (beeId) => {
      const result = tryFeedTaskSupply(beeId);
      if (result !== null) rig.clock.now += 2;
      return result;
    };

    rig.core.step();

    const fed = rig.store.getTask(task.id);
    assert.equal(fed?.status, "queued");
    assert.ok(fed?.mailboxMessageId != null);
    assert.equal(rig.store.currentRuntime(bee.id)?.state, "stopped");
    assert.equal(rig.store.undeliveredMessages(bee.id).length, 1);
    assert.equal(viewReads, 0, "neither the initial empty branch nor final I1 hydrates bee rows");
    assert.equal(mailboxReads, 0, "final I1 reads metadata instead of full mailbox rows");
    assert.equal(workReads, 0, "task supply runs after delivery, so only the fresh final I1 sees its mail");
    assert.equal(combinedReads, 0, "the initial enabled empty proof allocates fresh empty containers only");
    assert.equal(freshI1Reads, 1, "task supply's audit change forces one final I1-only read");
    assert.deepEqual(
      rig.violations.map((violation) => violation.messageId),
      [fed?.mailboxMessageId],
      "the final acquisition includes mail added after delivery by task supply",
    );
  } finally {
    rig.cleanup();
  }
});

test("unit.0f: fresh final I1 re-ranks the queue after delivery", () => {
  const rig = makeRig({ i1DeadlineSteps: 10 });
  try {
    spawnIdleBee(rig, "rerank-after-delivery");
    const first = rig.store.send("rerank-after-delivery", "deliver first").message;
    const second = rig.store.send("rerank-after-delivery", "becomes head").message;
    rig.clock.now = second.enqueuedAt + 11;

    let combinedReads = 0;
    let freshI1Reads = 0;
    const readDaemonStepInputs = rig.store.readDaemonStepInputs.bind(rig.store);
    const readI1PendingSnapshot = rig.store.readI1PendingSnapshot.bind(rig.store);
    rig.store.readDaemonStepInputs = () => {
      combinedReads += 1;
      return readDaemonStepInputs();
    };
    rig.store.readI1PendingSnapshot = () => {
      freshI1Reads += 1;
      return readI1PendingSnapshot();
    };

    rig.core.step();

    assert.equal(rig.store.getMessage(first.id)?.deliveredGeneration, 1);
    assert.equal(rig.store.getMessage(second.id)?.deliveredAt, null);
    assert.equal(combinedReads, 1);
    assert.equal(freshI1Reads, 1, "delivery's audit change forces a fresh final I1-only read");
    const deadline = second.enqueuedAt + 10;
    assert.deepEqual(rig.violations, [{
      detectedAt: rig.clock.now,
      beeId: "rerank-after-delivery",
      messageId: second.id,
      enqueuedAt: second.enqueuedAt,
      deadline,
      detail: `message ${second.id} undelivered past deadline (enqueued=${second.enqueuedAt} urgency=next pos=0 deadline=${deadline} now=${rig.clock.now})`,
    }]);
  } finally {
    rig.cleanup();
  }
});

test("unit.0g: linear I1 metadata matches the full-snapshot oracle exactly", () => {
  const rig = makeRig({ commandsPerStep: 0, i1DeadlineSteps: 10 });
  try {
    const running = rig.store.createBee({
      id: "a-running-archived",
      name: "a-running-archived",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(running.bee.id, running.runtime.generation, "running", {
      pid: 101,
      pidStartedAt: 100,
    });
    const heldIdle = rig.store.send(running.bee.id, "held idle", { urgency: "idle" }).message;
    rig.store.send(running.bee.id, "eligible behind idle", { urgency: "next" });
    rig.store.archiveBee(running.bee.id);

    const stopped = rig.store.createBee({
      id: "b-stopped",
      name: "b-stopped",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(stopped.bee.id, stopped.runtime.generation, "stopped", { exitCause: "clean" });
    rig.store.send(stopped.bee.id, "stopped pending", { urgency: "now" });

    const synthetic = rig.store.createBee({
      id: "c-synthetic-running",
      name: "c-synthetic-running",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(synthetic.bee.id, synthetic.runtime.generation, "running", { synthetic: true });
    rig.store.send(synthetic.bee.id, "synthetic idle is eligible", { urgency: "idle" });

    const booting = rig.store.createBee({
      id: "d-booting",
      name: "d-booting",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.send(booting.bee.id, "booting pending", { urgency: "next" });

    const flagged = rig.store.createBee({
      id: "e-flagged",
      name: "e-flagged",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.send(flagged.bee.id, "suppressed by flag", { urgency: "next" });
    rig.store.setFlag(flagged.bee.id, "resource_blocked", "declared boundary");

    const combinedSnapshots: Array<ReturnType<CoreStore["readDaemonStepInputs"]>> = [];
    let freshI1Reads = 0;
    const readDaemonStepInputs = rig.store.readDaemonStepInputs.bind(rig.store);
    const readI1PendingSnapshot = rig.store.readI1PendingSnapshot.bind(rig.store);
    rig.store.readDaemonStepInputs = () => {
      const inputs = readDaemonStepInputs();
      combinedSnapshots.push(inputs);
      return inputs;
    };
    rig.store.readI1PendingSnapshot = () => {
      freshI1Reads += 1;
      return readI1PendingSnapshot();
    };

    rig.clock.now += 31;
    const expected = legacyI1Oracle(rig.store, 10, rig.clock.now);
    rig.core.step();

    assert.ok(expected.length > 0);
    assert.equal(expected.some((violation) => violation.messageId === heldIdle.id), false);
    assert.match(expected[0]?.detail ?? "", /pos=1 /, "the held idle predecessor still consumes position zero");
    assert.deepEqual(rig.violations, expected);
    assert.equal(combinedSnapshots.length, 1);
    assert.equal(freshI1Reads, 0, "an unchanged tick reuses the combined I1 projection");
    assert.deepEqual(
      rig.ops.filter((op) => op.startsWith("i1.violation ")),
      expected.map((violation) =>
        `i1.violation bee=${violation.beeId} msg=${violation.messageId} deadline=${violation.deadline}`,
      ),
    );

    rig.core.step();
    assert.deepEqual(rig.violations, expected, "reported message ids remain deduplicated on later ticks");
    assert.equal(combinedSnapshots.length, 2, "each step acquires new combined inputs");
    assert.equal(freshI1Reads, 0);
    assert.notStrictEqual(combinedSnapshots[0], combinedSnapshots[1]);
    assert.notStrictEqual(combinedSnapshots[0]?.i1, combinedSnapshots[1]?.i1);
  } finally {
    rig.cleanup();
  }
});

test("unit.0i: same-tick I1 reuse cannot cross an outer rollback and reused audit sequence", () => {
  const rig = makeRig({ commandsPerStep: 0, i1DeadlineSteps: 10 });
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "rollback-shared-i1",
      name: "rollback-shared-i1",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    const message = rig.store.send(bee.id, "pending across rollback").message;
    const committedSeq = rig.store.lastAuditSeq();
    let rolledBackSeq = -1;
    const combinedSnapshots: Array<ReturnType<CoreStore["readDaemonStepInputs"]>> = [];
    let freshI1Reads = 0;
    const readDaemonStepInputs = rig.store.readDaemonStepInputs.bind(rig.store);
    const readI1PendingSnapshot = rig.store.readI1PendingSnapshot.bind(rig.store);
    rig.store.readDaemonStepInputs = () => {
      const inputs = readDaemonStepInputs();
      combinedSnapshots.push(inputs);
      return inputs;
    };
    rig.store.readI1PendingSnapshot = () => {
      freshI1Reads += 1;
      return readI1PendingSnapshot();
    };
    rig.clock.now = message.enqueuedAt + 11;

    assert.throws(
      () => rig.store.transact(() => {
        rig.store.setFlag(bee.id, "resource_blocked", "uncommitted boundary");
        rolledBackSeq = rig.store.lastAuditSeq();
        rig.core.step();
        assert.deepEqual(rig.violations, [], "the same-tick flagged snapshot suppresses I1");
        throw new Error("rollback shared I1 snapshot");
      }),
      /rollback shared I1 snapshot/,
    );

    assert.equal(rig.store.lastAuditSeq(), committedSeq);
    assert.deepEqual(rig.store.activeFlags(bee.id), []);
    rig.store.renameBee(bee.id, "sequence-reused");
    assert.equal(rig.store.lastAuditSeq(), rolledBackSeq);

    rig.core.step();

    const deadline = message.enqueuedAt + 10;
    assert.deepEqual(rig.violations, [{
      detectedAt: rig.clock.now,
      beeId: bee.id,
      messageId: message.id,
      enqueuedAt: message.enqueuedAt,
      deadline,
      detail: `message ${message.id} undelivered past deadline (enqueued=${message.enqueuedAt} urgency=next pos=0 deadline=${deadline} now=${rig.clock.now})`,
    }]);
    assert.equal(combinedSnapshots.length, 2, "the next step acquires again despite the reused sequence value");
    assert.notStrictEqual(combinedSnapshots[0], combinedSnapshots[1]);
    assert.equal(freshI1Reads, 0, "both steps were internally unchanged after their own acquisition");
  } finally {
    rig.cleanup();
  }
});

test("unit.1: scale-to-zero — idle past the window stops with stopped_by_system; send revives (Q4 + Q3)", () => {
  const rig = makeRig({ idleWindowSteps: 100 });
  try {
    spawnIdleBee(rig);
    // Within the window: nothing happens.
    rig.clock.now += 90;
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    // Past the window: stop enqueued, executed, exit cause stopped_by_system.
    rig.clock.now += 20;
    rig.core.step(); // enqueue + execute stop
    rig.core.step(); // drain exited observation
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "stopped_by_system");
    // Revive-on-message undoes it.
    const res = rig.store.send("bee-1", "wake up");
    assert.ok(res.wakeCommand, "send to a stopped bee must enqueue send_wake");
    rig.core.step(); // execute send_wake → revive gen 2
    rig.core.step(); // observations → idle
    rig.core.step(); // delivery
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.2: scale-to-zero never stops an idle bee with undelivered mail", () => {
  const rig = makeRig({ idleWindowSteps: 100 });
  try {
    spawnIdleBee(rig);
    rig.driver.acceptDeliveries = false; // keep the message pending
    rig.store.send("bee-1", "pending");
    rig.clock.now += 500;
    rig.core.step();
    rig.core.step();
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "idle", "idle bee with pending mail must not be scale-to-zero'd");
    // The moment the mail drains, the window applies again.
    rig.driver.acceptDeliveries = true;
    rig.core.step(); // deliver
    rig.clock.now += 200;
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
  } finally {
    rig.cleanup();
  }
});

test("unit.0h: delivery hydrates bodies only for the selected target", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig, "b-idle-target");
    spawnIdleBee(rig, "c-running-target");
    startTurn(rig, "c-running-target");

    const booting = rig.store.createBee({
      id: "a-booting-target",
      name: "a-booting-target",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    const bootingMessage = rig.store.send(booting.bee.id, "unselected booting body").message;
    const selected = rig.store.send("b-idle-target", "selected body").message;
    const queuedBehind = rig.store.send("b-idle-target", "unselected queued body").message;
    const heldIdle = rig.store.send("c-running-target", "unselected held idle body", {
      urgency: "idle",
    }).message;
    const interrupting = rig.store.send("c-running-target", "unselected interrupt body", {
      urgency: "now",
    }).message;

    const fetched: number[] = [];
    const getMessage = rig.store.getMessage.bind(rig.store);
    rig.store.getMessage = (messageId) => {
      fetched.push(messageId);
      return getMessage(messageId);
    };

    rig.core.step();

    assert.ok(fetched.length > 0, "the chosen idle-runtime delivery hydrates its body");
    assert.deepEqual([...new Set(fetched)], [selected.id]);
    assert.deepEqual(rig.driver.deliveredIds.slice(-1), [selected.id]);
    assert.equal(getMessage(selected.id)?.deliveredGeneration, 1);
    for (const message of [bootingMessage, queuedBehind, heldIdle, interrupting]) {
      assert.equal(getMessage(message.id)?.deliveredAt, null);
      assert.equal(fetched.includes(message.id), false, `message ${message.id} was not selected for hydration`);
    }
    assert.deepEqual(rig.driver.interrupts.slice(-1), [{ beeId: "c-running-target", generation: 1 }]);
  } finally {
    rig.cleanup();
  }
});

test("unit.time-boundaries: archived boot hang, idle stop, and I1 remain strict", () => {
  const bootRig = makeRig({ bootHangTimeoutSteps: 50, commandsPerStep: 0 });
  try {
    const { bee, runtime } = bootRig.store.createBee({
      id: "archived-booting",
      name: "archived-booting",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    bootRig.store.archiveBee(bee.id);
    bootRig.clock.now = runtime.startedAt + 50;
    bootRig.core.step();
    assert.equal(
      bootRig.store.listCommands({ beeId: bee.id, status: "queued" }).filter((command) => command.verb === "stop").length,
      0,
      "boot hang does not fire at equality",
    );
    bootRig.clock.now = runtime.startedAt + 51;
    bootRig.core.step();
    assert.equal(
      bootRig.store.listCommands({ beeId: bee.id, status: "queued" }).filter((command) => command.verb === "stop").length,
      1,
      "archiving does not hide a live runtime after the strict boundary",
    );
  } finally {
    bootRig.cleanup();
  }

  const idleRig = makeRig({ idleWindowSteps: 100 });
  try {
    spawnIdleBee(idleRig);
    const runtime = idleRig.store.currentRuntime("bee-1");
    assert.ok(runtime);
    idleRig.clock.now = runtime.updatedAt + 100;
    idleRig.core.step();
    assert.equal(idleRig.ops.filter((op) => op.startsWith("policy.idle_stop bee=bee-1")).length, 0);
    idleRig.clock.now = runtime.updatedAt + 101;
    idleRig.core.step();
    assert.equal(idleRig.ops.filter((op) => op.startsWith("policy.idle_stop bee=bee-1")).length, 1);
  } finally {
    idleRig.cleanup();
  }

  const i1Rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    spawnIdleBee(i1Rig);
    i1Rig.driver.acceptDeliveries = false;
    const message = i1Rig.store.send("bee-1", "strict I1 boundary").message;
    i1Rig.clock.now = message.enqueuedAt + 200;
    i1Rig.core.step();
    assert.equal(i1Rig.violations.length, 0, "I1 does not fire at equality");
    i1Rig.clock.now = message.enqueuedAt + 201;
    i1Rig.core.step();
    assert.deepEqual(i1Rig.violations.map((violation) => violation.messageId), [message.id]);
  } finally {
    i1Rig.cleanup();
  }
});

test("unit.3: flag policy — adapter evidence sets flags and contrary evidence clears them (spec 03)", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.driver.evidence.push({
      beeId: "bee-1",
      generation: 1,
      flag: "auth_needed",
      action: "set",
      detail: "Not logged in",
    });
    rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["auth_needed"]);
    // Contrary evidence: a successful authenticated turn clears it.
    rig.driver.evidence.push({
      beeId: "bee-1",
      generation: 1,
      flag: "auth_needed",
      action: "clear",
      detail: "successful authenticated turn",
    });
    rig.core.step();
    assert.equal(rig.store.activeFlags("bee-1").length, 0);
    // Evidence for a deleted bee is skipped, never a crash.
    rig.driver.evidence.push({
      beeId: "ghost",
      generation: 1,
      flag: "resource_blocked",
      action: "set",
      detail: "429",
    });
    rig.core.step();
    assert.ok(rig.ops.some((o) => o.includes("flag.skip bee=ghost")));
  } finally {
    rig.cleanup();
  }
});

test("unit.4: pid-at-spawn recording — procOf lands on the booting runtime row (WP2 amendment)", () => {
  const rig = makeRig();
  try {
    rig.driver.autoBoot = false; // stay in booting: the pid must already be recorded
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.core.step();
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.state, "booting");
    assert.ok(rt?.pid != null && rt.pid > 0, "pid recorded at spawn, before booted");
    assert.ok(rt?.pidStartedAt != null);
    assert.deepEqual(rig.driver.procOf("bee-1", 1), { pid: rt.pid, pidStartedAt: rt.pidStartedAt });
  } finally {
    rig.cleanup();
  }
});

test("unit.5: degraded-runtime policy — mail for a re-adopted runtime rotates the generation", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.driver.markDegraded("bee-1");
    // No mail: a degraded runtime is left alone.
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 1);
    // Mail arrives: deliver refuses (degraded), policy stops, wake revives gen 2, message lands there.
    const res = rig.store.send("bee-1", "hello survivor");
    rig.core.step(); // degraded policy enqueues stop; executor stops gen 1
    rig.core.step(); // exited observation → stopped → wake enqueued
    rig.core.step(); // send_wake → revive gen 2
    rig.core.step(); // boot observations → idle
    rig.core.step(); // delivery
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.generation, 2);
    assert.equal(rig.store.getMessage(res.message.id)?.deliveredGeneration, 2);
    const gen1 = rig.store.listRuntimes("bee-1").find((r) => r.generation === 1);
    assert.equal(gen1?.exitCause, "stopped_by_system");
    // Zero failed commands, zero flags: rotation is policy, not failure.
    assert.ok(rig.store.listCommands({ status: "failed" }).length === 0);
    assert.equal(rig.store.activeFlags("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.6: I1 telemetry — a message undelivered past the deadline is recorded exactly once", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    spawnIdleBee(rig);
    rig.driver.acceptDeliveries = false;
    const res = rig.store.send("bee-1", "will be late");
    rig.clock.now += 150;
    rig.core.step();
    assert.equal(rig.violations.length, 0, "no violation inside the deadline");
    rig.clock.now += 100;
    rig.core.step();
    rig.core.step();
    assert.equal(rig.violations.length, 1, "breach recorded once, not per tick");
    const v = rig.violations[0];
    assert.equal(v?.beeId, "bee-1");
    assert.equal(v?.messageId, res.message.id);
    assert.equal(v?.enqueuedAt, res.message.enqueuedAt);
    assert.ok((v?.detectedAt ?? 0) > (v?.deadline ?? Infinity - 1));
  } finally {
    rig.cleanup();
  }
});

test("unit.7: I1 telemetry — the clock is suspended while a closed-list flag is active", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    spawnIdleBee(rig);
    rig.driver.acceptDeliveries = false;
    rig.store.setFlag("bee-1", "resource_blocked", "429 storm");
    rig.store.send("bee-1", "blocked at the boundary");
    rig.clock.now += 1000;
    rig.core.step();
    assert.equal(rig.violations.length, 0, "a visibly blocked bee is not an I1 breach");
    rig.store.clearFlag("bee-1", "resource_blocked", "provider recovered");
    rig.driver.acceptDeliveries = true;
    rig.core.step();
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
    assert.equal(rig.violations.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.8: continuity (spec 07 §F) — a booted session id is recorded on the bee for the CURRENT generation only; stale/no-bee evidence is skipped", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig, "bee-s");
    rig.driver.sessions.push({ beeId: "bee-s", generation: 1, sessionId: "sid-gen1" });
    rig.core.step();
    assert.equal(rig.store.getBee("bee-s")?.providerSessionId, "sid-gen1");
    assert.ok(rig.ops.some((o) => o.startsWith("session.recorded bee=bee-s gen=1")));
    // same value again → no audit spam
    const auditBefore = rig.store.lastAuditSeq();
    rig.driver.sessions.push({ beeId: "bee-s", generation: 1, sessionId: "sid-gen1" });
    rig.core.step();
    assert.equal(rig.store.lastAuditSeq(), auditBefore);
    // stale generation and unknown bee are skipped
    rig.driver.sessions.push({ beeId: "bee-s", generation: 0, sessionId: "sid-stale" });
    rig.driver.sessions.push({ beeId: "ghost", generation: 1, sessionId: "sid-ghost" });
    rig.core.step();
    assert.equal(rig.store.getBee("bee-s")?.providerSessionId, "sid-gen1");
    assert.ok(rig.ops.some((o) => o.includes("session.skip bee=bee-s gen=0 reason=stale_generation")));
    assert.ok(rig.ops.some((o) => o.includes("session.skip bee=ghost gen=1 reason=no_bee")));
    // revive keeps the id on the bee (the driver's resolve reads it for --resume)
    rig.store.enqueueCommand("stop", "bee-s", { cause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-s")?.state, "stopped");
    rig.store.send("bee-s", "wake");
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-s")?.generation, 2);
    assert.equal(rig.store.getBee("bee-s")?.providerSessionId, "sid-gen1");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Spawn-failure budget (the WP7 importer hazard): a runtime that dies during
// boot must revive on a bounded, backed-off schedule and end in spawn_failed —
// never crash → wake → revive at tick speed forever.
// ---------------------------------------------------------------------------

/** Run steps until the wake backoff elapses each time; returns the op log slice. */
function stepUntilQuiet(rig: Rig, maxSteps: number): void {
  for (let i = 0; i < maxSteps; i++) {
    rig.core.step();
    const pending = rig.store.listCommands({ beeId: "bee-1", status: "queued" });
    // Jump the clock to the next deferred wake (the real daemon just waits).
    const next = pending.reduce((acc, c) => Math.max(acc, c.nextAttemptAt), 0);
    if (next > rig.clock.now) rig.clock.now = next;
  }
}

test("budget.5: immediate-exit runtime → bounded revives with backoff, spawn_failed at the budget, no further wakes", () => {
  // maxAttempts 3 / backoffBaseMs 1 in the rig: failures 1,2 defer the next
  // wake by 1 and 2 ms; failure 3 sets the flag.
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    rig.driver.bootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/nope" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.store.send("bee-1", "hello?"); // pending mail is what makes revives happen
    stepUntilQuiet(rig, 40);

    const bee = rig.store.getBee("bee-1")!;
    assert.equal(bee.spawnFailures, 3, "one budget across wake-driven revives");
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    // Exactly the budget's worth of starts (spawn + 2 revives), not 40.
    assert.equal(rig.driver.starts.length, 3, `starts: ${JSON.stringify(rig.driver.starts)}`);
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 3);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    // Wakes were deferred on the backoff table: each revive's wake had a
    // nextAttemptAt strictly after its enqueue.
    const wakes = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "send_wake");
    assert.equal(wakes.length, 2, "one wake per revive below the budget; none once flagged");
    for (const w of wakes) assert.ok(w.nextAttemptAt > w.enqueuedAt, `wake ${w.id} was not deferred`);
    assert.equal(rig.store.listCommands({ beeId: "bee-1", status: "queued" }).length, 0, "no wake pending");
    assert.ok(rig.ops.some((o) => o.startsWith("wake.suppressed bee=bee-1")), "suppression is logged");
    // Steady state: more steps + more mail change nothing but the mailbox.
    const startsBefore = rig.driver.starts.length;
    rig.store.send("bee-1", "anyone?");
    rig.clock.now += 10_000;
    for (let i = 0; i < 20; i++) rig.core.step();
    assert.equal(rig.driver.starts.length, startsBefore, "no revive while spawn_failed is set");
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 2, "mail stays durable");
    assert.equal(rig.store.view("bee-1").reachable, true);
    assert.equal(rig.store.view("bee-1").blocked, true);
    assert.equal(rig.violations.length, 0, "flagged = visibly blocked; the I1 clock is suspended");
    // A fresh DaemonCore over the same store (daemon restart) sweeps no wake for it either.
    const core2 = new DaemonCore({
      store: rig.store,
      driver: rig.driver,
      policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
      now: () => rig.clock.now,
      log: (op) => rig.ops.push(op),
    });
    const report = core2.boot();
    assert.equal(report.wakesEnqueued, 0, "boot sweep respects spawn_failed");
    for (let i = 0; i < 5; i++) core2.step();
    assert.equal(rig.driver.starts.length, startsBefore);
  } finally {
    rig.cleanup();
  }
});

test("budget.5auth: pre-init agy auth exits consume the budget and suppress churn", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    rig.driver.authBootFailure = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "agy", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.store.send("bee-1", "hello?");
    stepUntilQuiet(rig, 40);

    assert.equal(rig.driver.starts.length, 3, "only the budget's three generations may start");
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 3, "each pre-real-boot exit counts");
    assert.deepEqual(
      rig.store.activeFlags("bee-1").map((flag) => flag.flag).sort(),
      ["auth_needed", "spawn_failed"],
    );
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    assert.equal(rig.store.currentRuntime("bee-1")?.exitCause, "clean");
    assert.notEqual(rig.store.currentRuntime("bee-1")?.bootEvidence, "real");
    const resets = rig.store.auditRows().filter(
      (row) => row.kind === "bee.spawn_failures" && row.payload.spawnFailures === 0,
    );
    assert.equal(resets.length, 0, "auth flag evidence must not reset the boot budget");

    const startsAtSuppression = rig.driver.starts.length;
    rig.clock.now += 10_000;
    rig.store.send("bee-1", "still there?");
    for (let i = 0; i < 20; i++) rig.core.step();
    assert.equal(rig.driver.starts.length, startsAtSuppression, "spawn_failed suppresses further generations");

    rig.store.clearFlag("bee-1", "auth_needed", "operator completed agy login");
    rig.driver.authBootFailure = false;
    rig.store.enqueueCommand("revive", "bee-1");
    for (let i = 0; i < 4; i++) rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0, "operator revive grants a fresh budget");
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(rig.store.currentRuntime("bee-1")?.bootEvidence, "real");
  } finally {
    rig.cleanup();
  }
});

test("budget.5a: prompt-less spawn boot failures still retry to the visible bounded terminal", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    rig.driver.bootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "cell", cwd: "/cells/w/repo-space-1" });
    rig.store.enqueueCommand("spawn", "bee-1");
    stepUntilQuiet(rig, 40);

    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
    assert.equal(rig.driver.starts.length, 3, "boot retry is not conditional on mailbox work");
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 3);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((flag) => flag.flag), ["spawn_failed"]);
    assert.equal(
      rig.store.listCommands({ beeId: "bee-1" }).filter((command) => command.verb === "send_wake").length,
      2,
    );
  } finally {
    rig.cleanup();
  }
});

test("budget.5b: a driver that THROWS from start (cell provisioning failed) is a spawn failure on the B5 table — retried with backoff, spawn_failed at the budget, never a wedged command or a loop error", () => {
  const rig = makeRig();
  try {
    rig.driver.startError = "provision: origin /gone has no .git";
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "cell", cwd: "/cells/w/repo-space-1" });
    const cmd = rig.store.enqueueCommand("spawn", "bee-1");
    // No step throws: the failure is reported, not propagated.
    stepUntilQuiet(rig, 40);
    const settled = rig.store.getCommand(cmd.id)!;
    assert.equal(settled.status, "failed");
    assert.equal(settled.failureCause, "spawn_failed");
    assert.equal(settled.attempts, 3, "maxAttempts 3 in the rig: 1 attempt + 2 retries");
    assert.equal(rig.driver.starts.length, 3, "one start per attempt");
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    assert.ok(rig.ops.some((o) => o.includes("start_failed") && o.includes("origin /gone")), "the driver's reason is logged");
    assert.equal(rig.store.listCommands({ beeId: "bee-1", status: "running" }).length, 0, "nothing wedged in running");
    // Fixing the driver + an operator revive recovers (budget.6 semantics apply).
    rig.driver.startError = null;
    rig.store.enqueueCommand("revive", "bee-1");
    stepUntilQuiet(rig, 20);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
  } finally {
    rig.cleanup();
  }
});

test("budget.6: an explicit operator revive retries regardless of spawn_failed and clears it on success; the mail then flows", () => {
  const rig = makeRig();
  try {
    rig.driver.bootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "stub", substrate: "hsr", cwd: "/nope" });
    rig.store.enqueueCommand("spawn", "bee-1");
    const sent = rig.store.send("bee-1", "deliver me eventually");
    stepUntilQuiet(rig, 30);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    const startsBefore = rig.driver.starts.length;

    // Still broken: revive tries once more (fresh budget), fails, and the
    // budget runs down again from zero — bounded, then flagged again.
    rig.store.enqueueCommand("revive", "bee-1");
    rig.core.step(); // executes revive: reset + start (crashes at boot)
    assert.ok(rig.ops.some((o) => o.startsWith("spawn.budget_reset bee=bee-1 by=revive")));
    assert.equal(rig.driver.starts.length, startsBefore + 1, "revive retried despite the flag");
    stepUntilQuiet(rig, 30);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"], "flagged again after a fresh budget");
    assert.equal(rig.driver.starts.length, startsBefore + 3, "fresh budget of maxAttempts (3) starts, no more");

    // Fixed (cwd restored, binary present): revive boots, the flag clears on
    // booted (contrary evidence), the counter resets, the mail is delivered.
    rig.driver.bootCrash = false;
    rig.store.enqueueCommand("revive", "bee-1");
    for (let i = 0; i < 4; i++) rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.deepEqual(rig.driver.deliveredIds, [sent.message.id]);
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("budget.7: a runtime that reached running/idle and then crashed is not a spawn failure — revive is immediate and uncounted", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig); // gen 1 idle
    rig.driver.acceptDeliveries = false; // keep mail pending so the crash triggers a wake
    rig.store.send("bee-1", "pending");
    // Crash mid-life, three times over — more than the budget of 3.
    for (let gen = 1; gen <= 3; gen++) {
      const rt = rig.store.currentRuntime("bee-1")!;
      assert.equal(rt.generation, gen);
      rig.driver.procs.delete("bee-1");
      rig.driver.events.push({ beeId: "bee-1", generation: gen, kind: "exited", exitCause: "crashed" });
      rig.core.step(); // exit → stopped(crashed) → wake (immediate)
      const wake = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "send_wake").at(-1)!;
      assert.equal(wake.nextAttemptAt, wake.enqueuedAt, "no backoff for a post-boot crash");
      rig.core.step(); // wake → revive → booted + turn_ended
      rig.core.step(); // drain → idle
      assert.equal(rig.store.currentRuntime("bee-1")?.generation, gen + 1);
      assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0);
    }
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    // Hang-policy stops of a booting runtime are not boot failures either.
    rig.driver.autoBoot = false;
    rig.driver.procs.delete("bee-1");
    rig.driver.events.push({ beeId: "bee-1", generation: 4, kind: "exited", exitCause: "crashed" });
    rig.core.step(); // → wake
    rig.core.step(); // → revive gen 5, booting forever
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "booting");
    rig.clock.now += 100; // past bootHangTimeoutSteps (50)
    rig.core.step(); // hang policy enqueues stop
    rig.core.step(); // stop executes → exited(stopped_by_system)
    rig.core.step(); // drain (→ wake → gen 6 booting again; slow loop, bounded by the hang timeout)
    const gen5 = rig.store.listRuntimes("bee-1").find((r) => r.generation === 5);
    assert.equal(gen5?.state, "stopped");
    assert.equal(gen5?.exitCause, "stopped_by_system");
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0, "a boot hang stopped by policy is not a spawn failure");
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// v9 synthetic-boot budget (the 2026-08-18 soak finding): a readyAtSpawn
// harness (claude stream-json) that spawns fine but dies instantly with ZERO
// output gets a driver-minted SYNTHETIC booted. REGRESSION: before the fix
// that booted was indistinguishable from a real one, so every generation went
// booting → running (budget reset!) → crashed (not counted: "post-running"),
// and the bee looped crash → wake → revive UNBOUNDED at wake speed — the
// exact command.enqueued → command.claimed → runtime.created → flag.clear_noop
// → command.completed → runtime.updated audit loop the operator's first soak
// surfaced, hundreds of times over.
// ---------------------------------------------------------------------------

test("budget.8 (soak regression): readyAtSpawn instant death — the synthetic booted must NOT reset the budget; exactly maxAttempts generations, backoff, spawn_failed, wakes suppressed", () => {
  const rig = makeRig({ i1DeadlineSteps: 100_000 }); // generous: the flag lands first; the I1 clock then suspends
  try {
    rig.driver.synthBootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "claude", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.store.send("bee-1", "hello?"); // pending mail is what makes revives happen
    stepUntilQuiet(rig, 40);

    // Bounded: exactly the budget's worth of generations (maxAttempts 3), not 40.
    assert.equal(rig.driver.starts.length, 3, `starts: ${JSON.stringify(rig.driver.starts)}`);
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 3, "every synthetic-boot crash counted");
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.generation, 3);
    assert.equal(rt?.state, "stopped");
    assert.equal(rt?.exitCause, "crashed");
    assert.equal(rt?.bootEvidence, "synthetic", "the generation never produced real output");
    // The wakes between generations sat on the B5 backoff table.
    const wakes = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "send_wake");
    assert.equal(wakes.length, 2, "one wake per revive below the budget; none once flagged");
    for (const w of wakes) assert.ok(w.nextAttemptAt > w.enqueuedAt, `wake ${w.id} was not deferred`);
    // THE regression assertion: the budget was never reset by a synthetic
    // booted (pre-fix, one bee.spawn_failures reset row appeared per
    // generation and the loop never converged).
    const resets = rig.store.auditRows().filter((r) => r.kind === "bee.spawn_failures" && r.payload.spawnFailures === 0);
    assert.equal(resets.length, 0, "no budget reset without real evidence");
    // Steady state: suppressed — more time and more mail change nothing.
    rig.store.send("bee-1", "anyone?");
    rig.clock.now += 100_000;
    for (let i = 0; i < 20; i++) rig.core.step();
    assert.equal(rig.driver.starts.length, 3, "no further generations while spawn_failed is set");
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 2, "mail stays durable, never delivered to a dying runtime");
    assert.equal(rig.store.view("bee-1").blocked, true, "visibly blocked");
    assert.equal(rig.violations.length, 0, "flagged bee: the I1 clock is suspended");

    // Operator revive: fresh budget; with the harness fixed it boots for real
    // (real booted = contrary evidence), the flag clears, the mail flows.
    rig.driver.synthBootCrash = false;
    rig.store.enqueueCommand("revive", "bee-1");
    for (let i = 0; i < 4; i++) rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.equal(rig.store.currentRuntime("bee-1")?.bootEvidence, "real");
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("budget.9 (I1): a message that never reaches a real runtime violates while the loop retries, and the spawn_failed flag is the legal terminal that suspends the clock", () => {
  // Tight deadline: the breach is detected while the bounded retry loop is
  // still running (pre-fix this also fired for `next` urgency — the deadline
  // base is enqueue time — but the loop itself never terminated).
  const rig = makeRig({ i1DeadlineSteps: 5 });
  try {
    rig.driver.synthBootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "claude", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    const sent = rig.store.send("bee-1", "am I alive?");
    rig.core.step(); // spawn → synthetic booted + crash observed next step
    rig.core.step(); // crash counted (1), wake deferred
    rig.clock.now += 50; // far past the 5-step deadline, before the budget is exhausted
    rig.core.step();
    assert.equal(rig.violations.length, 1, "undelivered message past deadline must violate");
    assert.equal(rig.violations[0]?.messageId, sent.message.id);
    // Run the loop to exhaustion: flag set, no second report, clock suspended.
    stepUntilQuiet(rig, 30);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    rig.clock.now += 100_000;
    for (let i = 0; i < 10; i++) rig.core.step();
    assert.equal(rig.violations.length, 1, "flagged = visibly blocked; no further I1 reports");
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 1, "the message was never marked delivered to a dying generation");
  } finally {
    rig.cleanup();
  }
});

test("budget.9b (I1, idle urgency): pre-fix the churn re-based the idle clock forever — post-fix the bee lands flagged (the 'or the bee is flagged' arm)", () => {
  // An `idle`-urgency message's I1 clock re-bases on every runtime state
  // change (rt.updatedAt). Pre-fix the crash → revive churn bumped it each
  // generation faster than any deadline, so the message NEVER violated and
  // the loop ran forever silently. The budget is what guarantees the legal
  // terminal now: spawn_failed, visibly blocked.
  const rig = makeRig({ i1DeadlineSteps: 1_000 });
  try {
    rig.driver.synthBootCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "claude", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.store.send("bee-1", "whenever", { urgency: "idle" });
    stepUntilQuiet(rig, 40);
    assert.deepEqual(rig.store.activeFlags("bee-1").map((f) => f.flag), ["spawn_failed"]);
    assert.equal(rig.driver.starts.length, 3, "bounded");
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 1);
    assert.equal(rig.store.view("bee-1").blocked, true, "the bee is flagged — the message's fate is visible");
    assert.equal(rig.violations.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("budget.10: real evidence (the late init a readyAtSpawn harness emits) resets the counter — a generation that spoke and then crashed is a normal post-running crash", () => {
  const rig = makeRig();
  try {
    rig.driver.synthBootEvidenceCrash = true;
    rig.store.createBee({ id: "bee-1", name: "bee-1", agent: "claude", substrate: "hsr", cwd: "/tmp" });
    rig.store.enqueueCommand("spawn", "bee-1");
    rig.store.send("bee-1", "hello?");
    // Far more cycles than the budget (3): never counted, never flagged.
    stepUntilQuiet(rig, 40);
    assert.ok(rig.driver.starts.length > 6, `real-evidence crashes revive unbudgeted (starts: ${rig.driver.starts.length})`);
    assert.equal(rig.store.getBee("bee-1")?.spawnFailures, 0, "real evidence resets the counter every generation");
    assert.deepEqual(rig.store.activeFlags("bee-1"), []);
    // Wakes are immediate — no backoff without boot failures.
    const wakes = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "send_wake");
    assert.ok(wakes.length > 0);
    for (const w of wakes) assert.equal(w.nextAttemptAt, w.enqueuedAt, `wake ${w.id} must not back off`);
    // Every settled generation carries the real-evidence mark.
    const settled = rig.store.listRuntimes("bee-1").filter((r) => r.state === "stopped");
    assert.ok(settled.length > 6);
    for (const r of settled) assert.equal(r.bootEvidence, "real", `generation ${r.generation}`);
  } finally {
    rig.cleanup();
  }
});

test("budget.11 (end-to-end repro): a REAL readyAtSpawn process that spawns fine, emits zero output and dies ~60ms later — bounded generations over wall time; fixed harness + operator revive recovers", async () => {
  // The operator's first-soak audit shape: command.enqueued → command.claimed
  // → runtime.created → … → command.completed → runtime.updated, repeating
  // unbounded. Pre-fix the driver's spawn-event synthetic booted reset the
  // budget every generation; this pins the bounded post-fix behavior against
  // real OS processes and the real HsrDriver.
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-synthboot-"));
  const ops: string[] = [];
  const store = openCoreStore(join(dir, "core.sqlite3"), { maxAttempts: 3, backoffBaseMs: 30, ephemeral: true });
  let fixed = false;
  const driver = new HsrDriver({
    sessionLogDir: join(dir, "logs"),
    stopKillGraceMs: 300,
    resolve: () => ({
      // The claude shape without claude: a readyAtSpawn adapter over a child
      // that spawns cleanly, writes NOTHING, and exits 9 after ~60ms. The
      // "fixed" harness is the ordinary stub agent (its ready line is real
      // parsed output — boot evidence).
      adapter: { ...stubAdapter, readyAtSpawn: true },
      command: process.execPath,
      args: fixed ? [AGENT_PATH] : ["-e", "setTimeout(() => process.exit(9), 60)"],
      cwd: dir,
      env: { ...process.env, STUB_TURN_MS: "5" },
    }),
  });
  const core = new DaemonCore({
    store,
    driver,
    policy: { bootHangTimeoutSteps: 5000, commandsPerStep: 8 },
    now: Date.now,
    log: (op) => ops.push(op),
  });
  core.boot();
  try {
    store.createBee({ id: "bee-x", name: "bee-x", agent: "claude", substrate: "hsr", cwd: dir });
    store.enqueueCommand("spawn", "bee-x");
    store.send("bee-x", "hello?");
    // The doomed phase is BOUNDED whichever way the spawn/delivery race falls
    // (deliver-at-spawn is legal for readyAtSpawn). Boot retry is independent
    // of mailbox state, so both arms reach the same visible spawn_failed
    // terminal at maxAttempts instead of sometimes parking silently below it.
    const deadline = Date.now() + PROCESS_WAIT_TIMEOUT_MS;
    for (;;) {
      core.step();
      const flagged = store.activeFlags("bee-x").some((f) => f.flag === "spawn_failed");
      const stopped = store.currentRuntime("bee-x")?.state === "stopped";
      if (flagged && stopped) break;
      assert.ok(Date.now() < deadline, `never bounded; ops tail: ${ops.slice(-25).join(" | ")}`);
      await sleep(40);
    }
    // Settle: nothing further may start.
    for (let i = 0; i < 5; i++) {
      await sleep(40);
      core.step();
    }
    const runtimes = store.listRuntimes("bee-x");
    assert.ok(
      runtimes.length <= 3,
      `at most maxAttempts generations: ${JSON.stringify(runtimes.map((r) => [r.generation, r.state, r.exitCause, r.bootEvidence]))}`,
    );
    for (const r of runtimes) {
      assert.equal(r.state, "stopped");
      assert.equal(r.exitCause, "crashed");
      assert.equal(r.bootEvidence, "synthetic", `generation ${r.generation} never produced real output`);
    }
    assert.equal(store.getBee("bee-x")?.spawnFailures, runtimes.length, "every generation counted against the budget");
    assert.equal(store.getBee("bee-x")?.spawnFailures, 3);
    const pending = store.undeliveredMessages("bee-x").length;
    assert.equal(
      store.enqueueWake("bee-x").outcome,
      pending > 0 ? "suppressed" : "no_mail",
      "mailbox wakes are gated while spawn_failed is set",
    );
    assert.equal(
      store.auditRows().filter((r) => r.kind === "bee.spawn_failures" && r.payload.spawnFailures === 0).length,
      0,
      "REGRESSION: no synthetic-booted budget reset, ever",
    );
    // Operator revive with the harness fixed: real output → evidence → flag
    // clears, counter resets, the mail finally flows. If the original mail was
    // consumed by a doomed generation, prove the flow with a fresh message.
    fixed = true;
    if (store.undeliveredMessages("bee-x").length === 0) store.send("bee-x", "hello again?");
    store.enqueueCommand("revive", "bee-x");
    const ok = Date.now() + PROCESS_WAIT_TIMEOUT_MS;
    for (;;) {
      core.step();
      if (store.undeliveredMessages("bee-x").length === 0 && store.currentRuntime("bee-x")?.state === "idle") break;
      assert.ok(Date.now() < ok, `revive did not recover; ops tail: ${ops.slice(-25).join(" | ")}`);
      await sleep(20);
    }
    assert.deepEqual(store.activeFlags("bee-x"), []);
    assert.equal(store.getBee("bee-x")?.spawnFailures, 0);
    assert.equal(store.currentRuntime("bee-x")?.bootEvidence, "real");
  } finally {
    driver.disposeAll();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit.9 (spec 08 swap): a `stop {thenRevive}` command revives the NEXT generation once the runtime is observed stopped — durable, once, and never while a wake is already pending; the account policy hook sees every applied evidence", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_system", reason: "swap_account:test", thenRevive: true });
    rig.core.step(); // execute stop → process dying (exited queued)
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle", "the stop is async: exited not yet observed");
    rig.core.step(); // exited observed → stopped → revive enqueued (after_stop) → executed in the same step
    const revives = rig.store.listCommands({ beeId: "bee-1" }).filter((c) => c.verb === "revive");
    assert.equal(revives.length, 1, "exactly one revive");
    assert.equal(revives[0]?.args.reason, "after_stop");
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.ok(rig.ops.some((o) => o.startsWith("revive.after_stop bee=bee-1 gen=1")));
    // a plain stop (no thenRevive) never revives
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 2);
    // thenRevive with mail already pending: the send_wake carries the revive; no duplicate
    rig.store.enqueueCommand("revive", "bee-1");
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 3);
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_system", thenRevive: true });
    rig.core.step(); // stop executed, process dying
    rig.store.send("bee-1", "mail during the swap"); // runtime still 'idle' in the store → no wake yet
    rig.core.step(); // exited → stopped; ensureWake enqueues send_wake; thenRevive sees it pending → no revive
    const cmds = rig.store.listCommands({ beeId: "bee-1" });
    assert.equal(cmds.filter((c) => c.verb === "revive").length, 2, "no third revive: the wake covers it");
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.generation, 4);
    assert.equal(rig.store.undeliveredMessages("bee-1").length, 0, "the mail rode the swap onto generation 4");
  } finally {
    rig.cleanup();
  }
});

test("D05 boot command probes avoid full history and keep strict thenRevive and future-wake behavior", () => {
  const rig = makeRig();
  try {
    const falseRequest = rig.store.createBee({
      id: "d05-false-request",
      name: "d05-false-request",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(falseRequest.bee.id, falseRequest.runtime.generation, "stopped", {
      exitCause: "clean",
    });
    for (const args of [
      {},
      { thenRevive: null },
      { thenRevive: false },
      { thenRevive: 1 },
      { thenRevive: "true" },
    ]) {
      const command = rig.store.enqueueCommand("stop", falseRequest.bee.id, args);
      assert.equal(rig.store.claimNextCommand()?.id, command.id);
      rig.store.completeCommand(command.id);
    }

    const coveredRequest = rig.store.createBee({
      id: "d05-covered-request",
      name: "d05-covered-request",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.store.updateRuntimeState(coveredRequest.bee.id, coveredRequest.runtime.generation, "stopped", {
      exitCause: "clean",
    });
    const request = rig.store.enqueueCommand("stop", coveredRequest.bee.id, { thenRevive: true });
    assert.equal(rig.store.claimNextCommand()?.id, request.id);
    rig.store.completeCommand(request.id);
    const pendingWake = rig.store.enqueueCommand("send_wake", coveredRequest.bee.id);
    assert.equal(rig.store.claimNextCommand()?.id, pendingWake.id);
    const retry = rig.store.reportCommandFailure(pendingWake.id, "node_unreachable");
    assert.equal(retry.status, "queued");
    assert.ok(retry.nextAttemptAt != null && retry.nextAttemptAt > rig.clock.now);

    const falseHistory = rig.store.listCommands({ beeId: falseRequest.bee.id });
    const coveredHistory = rig.store.listCommands({ beeId: coveredRequest.bee.id });
    const auditBefore = rig.store.lastAuditSeq();
    const listCommands = rig.store.listCommands.bind(rig.store);
    const reports: ReturnType<DaemonCore["boot"]>[] = [];
    rig.store.listCommands = () => {
      throw new Error("D05 daemon path materialized command history");
    };
    try {
      reports.push(rig.core.boot(), rig.core.boot());
    } finally {
      rig.store.listCommands = listCommands;
    }

    for (const report of reports) {
      assert.deepEqual(report, {
        adopted: 0,
        stoppedByReconcile: 0,
        requeuedCommands: 0,
        orphansReaped: 0,
        wakesEnqueued: 0,
      });
    }
    assert.deepEqual(rig.store.listCommands({ beeId: falseRequest.bee.id }), falseHistory);
    assert.deepEqual(rig.store.listCommands({ beeId: coveredRequest.bee.id }), coveredHistory);
    assert.equal(rig.store.getCommand(pendingWake.id)?.status, "queued");
    assert.equal(rig.store.getCommand(pendingWake.id)?.nextAttemptAt, retry.nextAttemptAt);
    assert.equal(rig.store.currentRuntime(falseRequest.bee.id)?.state, "stopped");
    assert.equal(rig.store.currentRuntime(coveredRequest.bee.id)?.state, "stopped");
    assert.deepEqual(rig.driver.starts, []);
    assert.deepEqual(rig.driver.events, []);
    const bootAudit = rig.store.auditRows(auditBefore);
    assert.equal(bootAudit.length, 2);
    assert.ok(bootAudit.every((row) => row.kind === "boot.reconciled"));
  } finally {
    rig.cleanup();
  }
});

test("D05 pending-stop probe treats a future retry as pending and remains a repeated-step no-op", () => {
  const rig = makeRig({ bootHangTimeoutSteps: 50, commandsPerStep: 0 });
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "d05-pending-stop",
      name: "d05-pending-stop",
      agent: "stub",
      substrate: "hsr",
      cwd: "/tmp",
    });
    rig.clock.now = runtime.startedAt + 51;
    const stop = rig.store.enqueueCommand("stop", bee.id, {
      cause: "stopped_by_system",
      reason: "hang_policy",
    });
    assert.equal(rig.store.claimNextCommand()?.id, stop.id);
    const retry = rig.store.reportCommandFailure(stop.id, "node_unreachable");
    assert.equal(retry.status, "queued");
    assert.ok(retry.nextAttemptAt != null && retry.nextAttemptAt > rig.clock.now);

    const historyBefore = rig.store.listCommands({ beeId: bee.id });
    const stateBefore = rig.store.dumpState();
    const auditBefore = rig.store.lastAuditSeq();
    const listCommands = rig.store.listCommands.bind(rig.store);
    rig.store.listCommands = () => {
      throw new Error("D05 daemon path materialized command history");
    };
    try {
      rig.core.step();
      rig.core.step();
    } finally {
      rig.store.listCommands = listCommands;
    }

    assert.equal(rig.store.lastAuditSeq(), auditBefore);
    assert.deepEqual(rig.store.dumpState(), stateBefore);
    assert.deepEqual(rig.store.listCommands({ beeId: bee.id }), historyBefore);
    assert.equal(rig.store.getCommand(stop.id)?.status, "queued");
    assert.equal(rig.store.getCommand(stop.id)?.nextAttemptAt, retry.nextAttemptAt);
    assert.equal(rig.store.currentRuntime(bee.id)?.state, "booting");
    assert.deepEqual(rig.driver.starts, []);
    assert.deepEqual(rig.driver.events, []);
    assert.equal(rig.ops.filter((op) => op.startsWith("policy.hang_stop bee=d05-pending-stop")).length, 0);
  } finally {
    rig.cleanup();
  }
});

test("unit.10 (spec 08): the onFlagEvidence hook fires after each applied evidence and a throwing hook never stalls the loop", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-loops-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const store = openCoreStore(join(dir, "core.sqlite3"), { now, ephemeral: true });
  const driver = new FakeDriver(now);
  const seen: string[] = [];
  const ops: string[] = [];
  const core = new DaemonCore({
    store,
    driver,
    policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
    now,
    log: (op) => ops.push(op),
    onFlagEvidence: (ev) => {
      seen.push(`${ev.flag}:${ev.action}`);
      if (ev.detail === "boom") throw new Error("policy bug");
    },
  });
  try {
    core.boot();
    store.createBee({ id: "b", name: "b", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.enqueueCommand("spawn", "b");
    core.step();
    core.step();
    driver.evidence.push({ beeId: "b", generation: 1, flag: "resource_blocked", action: "set", detail: "boom" });
    driver.evidence.push({ beeId: "b", generation: 1, flag: "auth_needed", action: "set", detail: "not logged in" });
    core.step();
    assert.deepEqual(seen, ["resource_blocked:set", "auth_needed:set"]);
    assert.deepEqual(store.activeFlags("b").map((f) => f.flag).sort(), ["auth_needed", "resource_blocked"], "both flags applied despite the throwing hook");
    assert.ok(ops.some((o) => o.startsWith("account.policy_error bee=b flag=resource_blocked")));
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Delivery urgency (schema v8 — spec 01 Q2 amendment 2026-08-18): the delivery
// loop's eligibility rule, the mid-turn interrupt for `now`, the FIFO-among-
// eligible ordering, and the I1 clock that starts at eligibility for `idle`.
// ---------------------------------------------------------------------------

/** Drive an idle bee into a turn (store state `running`). */
function startTurn(rig: Rig, id = "bee-1"): void {
  const rt = rig.store.currentRuntime(id);
  assert.equal(rt?.state, "idle", "startTurn wants an idle runtime");
  rig.driver.events.push({ beeId: id, generation: rt!.generation, kind: "turn_started" });
  rig.core.step();
  assert.equal(rig.store.currentRuntime(id)?.state, "running");
}

test("runtime policy: a running turn is never stopped because time elapsed", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const generation = rig.store.currentRuntime("bee-1")?.generation;

    rig.clock.now += 24 * 60 * 60 * 1000;
    rig.core.step();
    rig.core.step();

    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.generation, generation);
    assert.equal(rt?.state, "running");
    assert.equal(
      rig.store.listCommands({ beeId: "bee-1" }).some((c) => c.verb === "stop"),
      false,
      "elapsed time must not manufacture stop intent",
    );
    assert.equal(
      rig.ops.some((op) => op.includes("policy.hang_stop") && op.includes("state=running")),
      false,
    );
  } finally {
    rig.cleanup();
  }
});

test("recovered completion checkpoints last, preserves output, and unlocks idle mail", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    rig.store.recordRuntimeProc("bee-1", 1, {
      pid: rig.driver.procOf("bee-1", 1)!.pid,
      pidStartedAt: rig.driver.procOf("bee-1", 1)!.pidStartedAt,
      observationCursor: 7,
    });
    const message = rig.store.send("bee-1", "after recovery", { urgency: "idle" }).message;

    // The runner persisted this edge and cursor; the restarted daemon drains
    // it through the same observation path as live output.
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.driver.recoveryCursors.push({ beeId: "bee-1", generation: 1, cursor: 41 });
    rig.core.step();

    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.ok(rig.store.getBee("bee-1")?.lastOutputAt != null);
    assert.equal(rig.store.runtimeObservationCursor("bee-1", 1), 41);
    assert.equal(rig.store.getMessage(message.id)?.deliveredGeneration, 1);
    assert.deepEqual(rig.driver.deliveredIds, [message.id]);

    const outputRows = () => rig.store.auditRows().filter((row) => row.kind === "output.recorded");
    assert.equal(outputRows().length, 2, "boot completion plus recovered completion");

    // Crash after the state fold but before the cursor checkpoint: replaying
    // the already-applied completion is a state/output no-op.
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.driver.recoveryCursors.push({ beeId: "bee-1", generation: 1, cursor: 41 });
    rig.core.step();
    assert.equal(outputRows().length, 2);
    assert.equal(rig.store.runtimeObservationCursor("bee-1", 1), 41);
  } finally {
    rig.cleanup();
  }
});

test("recovery applies completion followed by a newer turn start in journal order", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    rig.driver.events.push(
      { beeId: "bee-1", generation: 1, kind: "turn_ended" },
      { beeId: "bee-1", generation: 1, kind: "turn_started" },
    );
    rig.driver.recoveryCursors.push({ beeId: "bee-1", generation: 1, cursor: 73 });
    rig.core.step();

    assert.equal(rig.store.currentRuntime("bee-1")?.state, "running");
    assert.ok(rig.store.getBee("bee-1")?.lastOutputAt != null, "the intervening completion remains a fact");
    assert.equal(rig.store.runtimeObservationCursor("bee-1", 1), 73);
  } finally {
    rig.cleanup();
  }
});

test("stale-generation recovery observations and cursors cannot touch the current runtime", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.updateRuntimeState("bee-1", 1, "stopped", { exitCause: "crashed" });
    rig.store.reviveBee("bee-1");
    rig.store.updateRuntimeState("bee-1", 2, "running", { pid: 202, pidStartedAt: 2002 });
    rig.store.recordRuntimeProc("bee-1", 2, { pid: 202, pidStartedAt: 2002, observationCursor: 9 });

    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.driver.recoveryCursors.push({ beeId: "bee-1", generation: 1, cursor: 999 });
    rig.core.step();

    assert.equal(rig.store.currentRuntime("bee-1")?.state, "running");
    assert.equal(rig.store.runtimeObservationCursor("bee-1", 2), 9);
    assert.equal(rig.store.runtimeObservationCursor("bee-1", 1), null);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d1: `idle` is not delivered while the runtime is running — it lands at turn end", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const res = rig.store.send("bee-1", "when you are done", { urgency: "idle" });
    for (let i = 0; i < 5; i++) {
      rig.clock.now += 10;
      rig.core.step();
    }
    assert.deepEqual(rig.driver.deliveredIds, [], "held for the whole turn");
    assert.equal(rig.driver.interrupts.length, 0, "idle never interrupts");
    // Turn ends → same step: observation drains to idle, delivery loop delivers.
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.store.getMessage(res.message.id)?.deliveredGeneration, 1);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d2: `now` mid-turn interrupts exactly once, then delivers at the resulting accept point", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    rig.driver.acceptDeliveries = false; // the accept point is slow to open
    const res = rig.store.send("bee-1", "drop everything", { urgency: "now" });
    rig.core.step();
    assert.deepEqual(rig.driver.interrupts, [{ beeId: "bee-1", generation: 1 }], "interrupt issued");
    // Simulate the turn_ended landing slowly: swallow it and keep stepping —
    // the interrupt must NOT be re-issued for the same message.
    rig.driver.events = [];
    rig.core.step();
    rig.core.step();
    assert.equal(rig.driver.interrupts.length, 1, "one interrupt per message");
    assert.deepEqual(rig.driver.deliveredIds, [], "not delivered while refused");
    // The accept point opens (turn_ended observed, deliveries accepted).
    rig.driver.acceptDeliveries = true;
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.driver.interrupts.length, 1);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d3: `now` to an idle runtime is a plain delivery — no interrupt", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    const res = rig.store.send("bee-1", "asap", { urgency: "now" });
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.driver.interrupts.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d4: ordering — urgency governs WHEN a message is eligible; among eligible, enqueue order wins", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const m1 = rig.store.send("bee-1", "idle-1", { urgency: "idle" }).message;
    const m2 = rig.store.send("bee-1", "next-2").message;
    const m3 = rig.store.send("bee-1", "idle-3", { urgency: "idle" }).message;
    const m4 = rig.store.send("bee-1", "now-4", { urgency: "now" }).message;
    // Mid-turn: m1/m3 are held; m2 and m4 are eligible; m4's now-ness
    // interrupts the turn. Delivery waits for the resulting turn_ended so it
    // cannot race the interrupt against the old accept point.
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [], "a successful interrupt defers delivery until turn end");
    assert.deepEqual(rig.driver.interrupts, [{ beeId: "bee-1", generation: 1 }], "the pending now interrupts");
    // The interrupt's turn_ended drains → idle: everything is eligible, FIFO wins.
    rig.core.step();
    rig.core.step();
    rig.core.step();
    rig.core.step();
    assert.deepEqual(rig.driver.deliveredIds, [m1.id, m2.id, m3.id, m4.id], "enqueue order among eligible");
  } finally {
    rig.cleanup();
  }
});

test("urgency.d5: `idle` to a stopped bee still revives (revive-on-message unchanged) and delivers once idle", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.enqueueCommand("stop", "bee-1", { cause: "stopped_by_user" });
    rig.core.step();
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    const res = rig.store.send("bee-1", "for later", { urgency: "idle" });
    assert.ok(res.wakeCommand, "urgency never affects the wake");
    rig.core.step(); // send_wake → revive gen 2 (autoBoot: booted + turn_ended)
    rig.core.step(); // observations → idle; delivery in the same step
    assert.deepEqual(rig.driver.deliveredIds, [res.message.id]);
    assert.equal(rig.store.getMessage(res.message.id)?.deliveredGeneration, 2);
    assert.equal(rig.driver.interrupts.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("urgency.d6: I1 telemetry — an `idle` message's deadline clock starts at eligibility (turn end), not enqueue", () => {
  const rig = makeRig({ i1DeadlineSteps: 200 });
  try {
    spawnIdleBee(rig);
    startTurn(rig);
    const res = rig.store.send("bee-1", "patient", { urgency: "idle" });
    // Far past what would breach an enqueue-based deadline: no violation —
    // the turn is exactly what `idle` opted into waiting for.
    rig.clock.now += 5_000;
    rig.core.step();
    assert.equal(rig.violations.length, 0, "no false I1 violation during a long turn");
    // Turn ends but delivery is refused: the clock now runs from eligibility.
    rig.driver.acceptDeliveries = false;
    rig.driver.events.push({ beeId: "bee-1", generation: 1, kind: "turn_ended" });
    rig.core.step();
    const eligibleAt = rig.clock.now;
    rig.clock.now += 150; // inside the 200-step bound from ELIGIBILITY
    rig.core.step();
    assert.equal(rig.violations.length, 0, "inside the eligibility-based deadline");
    rig.clock.now += 100; // past it
    rig.core.step();
    assert.equal(rig.violations.length, 1, "breach recorded once eligible + overdue");
    assert.equal(rig.violations[0]?.messageId, res.message.id);
    assert.ok((rig.violations[0]?.deadline ?? 0) >= eligibleAt + 200, "deadline base is eligibility, not enqueue");
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// B4a sender attribution: the delivery loop envelopes bee-sent mail.
// ---------------------------------------------------------------------------

test("envelope.d1: bee-sent mail is delivered ENVELOPED; operator mail is delivered bare", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.send("bee-1", "from the operator");
    rig.core.step();
    rig.store.send("bee-1", "from a peer", { sender: "CL.9999" });
    rig.core.step();
    assert.equal(rig.driver.deliveredBodies[0], "from the operator");
    const enveloped = rig.driver.deliveredBodies[1] as string;
    assert.ok(enveloped.startsWith(BUZ_INJECTION_MARKER), "peer mail carries the marker");
    assert.ok(enveloped.includes('"from":"CL.9999"'), "meta names the sender");
    assert.ok(enveloped.endsWith("\n\nfrom a peer"), "body verbatim after the blank line");
  } finally {
    rig.cleanup();
  }
});

test("urgency.d6: idle mail DELIVERS to a synthetic-running fresh revive — no generation churn (2026-08-19 budget.11 discovery)", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.core.step();
    // Stop, then send idle-urgency mail: revive-on-message brings up a new
    // generation whose `running` rests ONLY on the driver-minted synthetic
    // booted (readyAtSpawn shape). Pre-fix the idle gate saw `running` and
    // held the mail forever: hang-stop → wake → revive, unbounded churn.
    rig.store.enqueueCommand("stop", "bee-1");
    rig.core.step(); // execute stop
    rig.core.step(); // drain the exited observation
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "stopped");
    rig.driver.synthBootAlive = true;
    const res = rig.store.send("bee-1", "when you can", { urgency: "idle" });
    rig.core.step(); // wake claims → gen 2 spawns (synthetic booted queued)
    rig.core.step(); // drain synthetic booted → running(synthetic); deliver
    rig.core.step();
    assert.ok(rig.driver.deliveredIds.includes(res.message.id), `idle mail delivered to the provisional runtime; ops tail: ${rig.ops.slice(-8).join(" | ")}`);
  } finally {
    rig.cleanup();
  }
});

test("obs.synthetic-turn_ended: a readyAtSpawn boot-to-ready edge idles the store without an output fact; evidence stays synthetic (2026-09-02 swap-revive stall)", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    const outputBefore = rig.store.getBee("bee-1")?.lastOutputAt ?? null;
    // Revive with an empty mailbox (the swap_account shape): the HsrDriver
    // mints booted{synthetic} then turn_ended{synthetic} for a claude that
    // sits silently at its prompt.
    rig.store.enqueueCommand("stop", "bee-1");
    rig.core.step(); // execute stop
    rig.core.step(); // drain exited
    rig.driver.synthBootAlive = true;
    rig.store.enqueueCommand("revive", "bee-1");
    rig.core.step(); // gen 2 spawns: booted{synthetic} queued
    rig.driver.events.push({ beeId: "bee-1", generation: 2, kind: "turn_ended", synthetic: true });
    rig.core.step(); // drain booted → running(synthetic) → idle
    const rt = rig.store.currentRuntime("bee-1");
    assert.equal(rt?.generation, 2);
    assert.equal(rt?.state, "idle", `store idles on the synthetic edge; ops tail: ${rig.ops.slice(-6).join(" | ")}`);
    assert.equal(rt?.bootEvidence, "synthetic", "a phase fact is not boot evidence");
    assert.equal(rig.store.getBee("bee-1")?.lastOutputAt ?? null, outputBefore, "no output fact: the agent produced nothing");
    assert.ok(rig.ops.some((o) => o === "obs.turn_ended bee=bee-1 gen=2 synthetic"), "the fold names the synthetic edge");
    const view = rig.store.listBeeViewRows().find((r) => r.view.beeId === "bee-1")!.view;
    assert.equal(view.working, false, "never 'working' with nothing in flight");
    // A real turn on top still records output as before.
    rig.clock.now += 1000;
    rig.store.send("bee-1", "go");
    rig.core.step(); // deliver → turn_started (synthetic, driver-opened)
    rig.driver.events.push({ beeId: "bee-1", generation: 2, kind: "turn_started", synthetic: true });
    rig.core.step();
    rig.driver.events.push({ beeId: "bee-1", generation: 2, kind: "turn_ended" });
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle");
    assert.ok((rig.store.getBee("bee-1")?.lastOutputAt ?? 0) > (outputBefore ?? 0), "the real turn_ended records output");
  } finally {
    rig.cleanup();
  }
});

test("obs.synthetic-turn_ended with mail waiting: the boot-to-ready edge is skipped (mail_pending) — no one-step idle under a turn about to start", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    rig.store.enqueueCommand("stop", "bee-1");
    rig.core.step(); // execute stop
    rig.core.step(); // drain exited
    rig.driver.synthBootAlive = true;
    // revive-on-message: the wake spawns gen 2 with the mail still undelivered.
    const res = rig.store.send("bee-1", "go");
    rig.core.step(); // wake claims → gen 2 spawns: booted{synthetic} queued
    rig.driver.events.push({ beeId: "bee-1", generation: 2, kind: "turn_ended", synthetic: true });
    rig.core.step(); // drain: running(synthetic); synthetic idle SKIPPED; deliver
    assert.ok(rig.ops.some((o) => o === "obs.skip bee=bee-1 gen=2 kind=turn_ended reason=mail_pending"), `skip logged; ops tail: ${rig.ops.slice(-6).join(" | ")}`);
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "running", "stays provisionally running until the real result");
    assert.ok(rig.driver.deliveredIds.includes(res.message.id), "mail delivered into the provisional runtime");
    rig.driver.events.push({ beeId: "bee-1", generation: 2, kind: "turn_ended" });
    rig.core.step();
    assert.equal(rig.store.currentRuntime("bee-1")?.state, "idle", "the real result idles it");
  } finally {
    rig.cleanup();
  }
});

test("unit.flag-expiry: a provider-declared reset lifts resource_blocked at the instant — never before, never by silence", () => {
  const rig = makeRig();
  try {
    spawnIdleBee(rig);
    const blockedView = (): boolean => rig.store.listBeeViewRows().find((r) => r.view.beeId === "bee-1")!.view.blocked;
    const resetsAt = rig.clock.now + 10_000;
    rig.driver.evidence.push({
      beeId: "bee-1",
      generation: 1,
      flag: "resource_blocked",
      action: "set",
      detail: "claude rate limit rejected, resets soon",
      resetsAt,
    });
    rig.core.step();
    assert.equal(rig.store.activeFlags("bee-1")[0]?.resetsAt, resetsAt, "the declared instant is durable on the flag row");
    assert.equal(blockedView(), true);
    assert.ok(rig.ops.some((o) => o.startsWith("flag.set bee=bee-1 flag=resource_blocked") && o.includes("resetsAt=")));

    rig.clock.now = resetsAt - 1;
    rig.core.step();
    assert.equal(rig.store.activeFlags("bee-1").length, 1, "not a millisecond before the provider's instant");
    assert.equal(blockedView(), true);

    rig.clock.now = resetsAt;
    rig.core.step();
    assert.deepEqual(rig.store.activeFlags("bee-1"), [], "cleared at the declared instant, with no turn served");
    assert.equal(blockedView(), false, "the bee no longer reads as blocked");
    assert.ok(rig.ops.some((o) => o.startsWith("flag.expire bee=bee-1 flag=resource_blocked resetsAt=")));

    // An open-ended wall (no declared reset) is untouched by any amount of time.
    rig.driver.evidence.push({ beeId: "bee-1", generation: 1, flag: "resource_blocked", action: "set", detail: "API Error: 529 Overloaded" });
    rig.core.step();
    rig.clock.now += 7 * 24 * 3_600_000;
    rig.core.step();
    assert.equal(rig.store.activeFlags("bee-1").length, 1, "silence never clears a flag without a declared reset");
    assert.equal(blockedView(), true);
  } finally {
    rig.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Z01 unit 1 — committed global zero-pending pruning of the delivery dedup sets
// ---------------------------------------------------------------------------

/** Test-only view of DaemonCore's in-memory dedup sets (TS-private, runtime-visible). */
function dedupSets(core: DaemonCore): { reportedI1: Set<number>; interruptRequested: Set<number> } {
  const reportedI1: unknown = Reflect.get(core, "reportedI1");
  const interruptRequested: unknown = Reflect.get(core, "interruptRequested");
  assert.ok(reportedI1 instanceof Set, "DaemonCore.reportedI1 moved or changed shape");
  assert.ok(interruptRequested instanceof Set, "DaemonCore.interruptRequested moved or changed shape");
  return { reportedI1, interruptRequested };
}

test("z01.a: an outer rollback never loses dedup state and a committed clear follows", () => {
  const rig = makeRig({ i1DeadlineSteps: 10 });
  try {
    spawnIdleBee(rig, "z01-roll");
    rig.driver.acceptDeliveries = false;
    const msg = rig.store.send("z01-roll", "urgent work", { urgency: "now" }).message;
    rig.driver.events.push({ beeId: "z01-roll", generation: 1, kind: "turn_started" });
    rig.clock.now += 100;
    rig.core.step(); // running turn → one interrupt; overdue → one violation
    assert.equal(rig.driver.interrupts.length, 1);
    assert.deepEqual(rig.violations.map((v) => v.messageId), [msg.id]);
    assert.equal(dedupSets(rig.core).interruptRequested.has(msg.id), true);
    assert.equal(dedupSets(rig.core).reportedI1.has(msg.id), true);
    rig.core.step(); // fold the interrupt's turn_ended; refused delivery keeps the message pending
    assert.equal(rig.driver.interrupts.length, 1);
    assert.equal(rig.violations.length, 1);

    const terminalPaths: ReadonlyArray<readonly [string, () => void]> = [
      ["markDelivered", () => assert.deepEqual(rig.store.markDelivered(msg.id, 1), { applied: true })],
      ["cancelMessage", () => assert.deepEqual(rig.store.cancelMessage("z01-roll", msg.id), { canceled: true })],
      ["deleteBee", () => assert.equal(rig.store.deleteBee("z01-roll").beeId, "z01-roll")],
    ];
    for (const [name, terminal] of terminalPaths) {
      assert.throws(
        () => rig.store.transact(() => {
          terminal(); // uncommitted terminal fact
          rig.core.step(); // prune must skip: inTransaction
          throw new Error(`outer rollback ${name}`);
        }),
        new RegExp(`outer rollback ${name}`),
      );
      assert.equal(dedupSets(rig.core).interruptRequested.has(msg.id), true, `${name} rollback must not lose interrupt dedup`);
      assert.equal(dedupSets(rig.core).reportedI1.has(msg.id), true, `${name} rollback must not lose I1 dedup`);
      assert.equal(rig.store.undeliveredMessages("z01-roll").length, 1, `${name} rollback restored the pending message`);
    }

    rig.driver.events.push({ beeId: "z01-roll", generation: 1, kind: "turn_started" });
    rig.clock.now += 100;
    rig.core.step(); // running again with the message still pending
    assert.equal(rig.driver.interrupts.length, 1, "retained dedup prevents a duplicate interrupt");
    assert.equal(rig.violations.length, 1, "retained dedup prevents a duplicate violation");

    assert.deepEqual(rig.store.markDelivered(msg.id, 1), { applied: true }); // committed terminal
    rig.core.step();
    assert.equal(dedupSets(rig.core).reportedI1.size, 0, "committed zero pending clears reportedI1");
    assert.equal(dedupSets(rig.core).interruptRequested.size, 0, "committed zero pending clears interruptRequested");
    assert.equal(rig.violations.length, 1);
  } finally {
    rig.cleanup();
  }
});

test("z01.b: a live-runtime hive with zero pending still clears (mail-only probe)", () => {
  const rig = makeRig({ i1DeadlineSteps: 10 });
  try {
    spawnIdleBee(rig, "z01-live");
    rig.driver.acceptDeliveries = false;
    const msg = rig.store.send("z01-live", "overdue next", { urgency: "next" }).message;
    rig.clock.now += 100;
    rig.core.step();
    rig.core.step();
    assert.deepEqual(rig.violations.map((v) => v.messageId), [msg.id]);
    assert.equal(dedupSets(rig.core).reportedI1.size, 1);
    assert.equal(dedupSets(rig.core).interruptRequested.size, 0, "next urgency never interrupts");

    assert.deepEqual(rig.store.markDelivered(msg.id, 1), { applied: true });
    rig.core.step();
    assert.equal(rig.store.currentRuntime("z01-live")?.state, "idle", "the runtime stays live");
    assert.equal(dedupSets(rig.core).reportedI1.size, 0, "live runtime must not block the zero-pending clear");
    rig.clock.now += 1_000;
    rig.core.step();
    assert.equal(rig.violations.length, 1);
  } finally {
    rig.cleanup();
  }
});

test("z01.c: with I1 disabled an interrupted-then-canceled id is cleared without hydration", () => {
  const rig = makeRig({});
  try {
    spawnIdleBee(rig, "z01-noi1");
    const msg = rig.store.send("z01-noi1", "urgent then gone", { urgency: "now" }).message;
    rig.driver.events.push({ beeId: "z01-noi1", generation: 1, kind: "turn_started" });
    rig.core.step();
    assert.equal(rig.driver.interrupts.length, 1);
    assert.equal(dedupSets(rig.core).interruptRequested.has(msg.id), true);
    assert.equal(dedupSets(rig.core).reportedI1.size, 0, "reportedI1 never grows with I1 disabled");

    assert.deepEqual(rig.store.cancelMessage("z01-noi1", msg.id), { canceled: true });
    rig.core.step();
    assert.equal(dedupSets(rig.core).interruptRequested.size, 0, "canceled id cleared with I1 disabled");
    rig.driver.events.push({ beeId: "z01-noi1", generation: 1, kind: "turn_started" });
    rig.core.step();
    assert.equal(rig.driver.interrupts.length, 1, "no interrupt without pending mail");
    assert.equal(rig.violations.length, 0);
  } finally {
    rig.cleanup();
  }
});

test("z01.d: stopped-target pending mail is retained until the bee is deleted", () => {
  const rig = makeRig({ i1DeadlineSteps: 10, commandsPerStep: 0 });
  try {
    const { bee, runtime } = rig.store.createBee({
      id: "z01-stop", name: "z01-stop", agent: "stub", substrate: "hsr", cwd: "/tmp",
    });
    rig.store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    const msg = rig.store.send(bee.id, "parked mail", { urgency: "next" }).message;
    rig.clock.now += 100;
    rig.core.step();
    assert.deepEqual(rig.violations.map((v) => v.messageId), [msg.id]);
    for (let i = 0; i < 3; i++) rig.core.step();
    assert.equal(dedupSets(rig.core).reportedI1.has(msg.id), true, "pending stopped-target mail is never pruned");
    assert.equal(rig.violations.length, 1, "dedup holds while the message stays pending");

    rig.store.deleteBee(bee.id);
    rig.core.step();
    assert.equal(dedupSets(rig.core).reportedI1.size, 0, "cascade deletion terminalizes the id");
    assert.equal(rig.violations.length, 1);
  } finally {
    rig.cleanup();
  }
});
