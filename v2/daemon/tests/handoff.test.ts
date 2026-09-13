/**
 * v23 session handoff — loop tier: DaemonCore under the FakeDriver + virtual
 * clock. Same- and cross-family handoffs of idle, working and stopped
 * sources; the stopping → summarizing → starting → complete graph; seed-first
 * delivery with queued user mail preserved in order; crash/restart at every
 * phase; stale-generation session callbacks; target boot failure; operator
 * supersede; mirror shapes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDOFF_SEED_MARKER,
  MIRROR_BEE_HANDOFF_KEYS,
  MIRROR_BEE_ROW_KEYS,
  MIRROR_HANDOFF_CONTEXT_KEYS,
  MIRROR_TRANSCRIPT_SEGMENT_KEYS,
  beeHandoffReviveKey,
  hashBeeHandoffRequest,
  openCoreStore,
  type BeeHandoffRow,
  type CoreStore,
  type HandoffContext,
} from "../../core/src/index.ts";
import { DaemonCore, type DaemonCoreOptions } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

interface Rig {
  dir: string;
  store: CoreStore;
  driver: FakeDriver;
  core: DaemonCore;
  clock: { now: number };
  ops: string[];
  /** Reopen the store + a fresh core/driver over the same file (daemon crash + restart). */
  restart: (extra?: Partial<DaemonCoreOptions>) => void;
  cleanup: () => void;
}

function makeRig(extra: Partial<DaemonCoreOptions> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-handoff-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const ops: string[] = [];
  const open = (opts: Partial<DaemonCoreOptions>) => {
    const store = openCoreStore(join(dir, "core.sqlite3"), { now, maxAttempts: 3, backoffBaseMs: 1, ephemeral: true });
    const driver = new FakeDriver(now);
    const core = new DaemonCore({
      store,
      driver,
      policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
      now,
      log: (op) => ops.push(op),
      ...opts,
    });
    core.boot();
    return { store, driver, core };
  };
  const first = open(extra);
  const rig: Rig = {
    dir,
    store: first.store,
    driver: first.driver,
    core: first.core,
    clock,
    ops,
    restart: (more = {}) => {
      rig.store.close();
      const next = open({ ...extra, ...more });
      rig.store = next.store;
      rig.driver = next.driver;
      rig.core = next.core;
    },
    cleanup: () => {
      rig.store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

function spawnIdle(rig: Rig, id: string, agent = "codex"): void {
  rig.store.createBee({ id, name: id, agent, substrate: "hsr", cwd: "/tmp", sessionLogPath: `/tmp/logs/${id}.jsonl` });
  rig.store.enqueueCommand("spawn", id);
  rig.core.step();
  rig.core.step();
  rig.core.step();
  assert.equal(rig.store.currentRuntime(id)?.state, "idle");
}

function admit(rig: Rig, beeId: string, opts: { key?: string; agent?: string; stopAt?: "idle" | "now"; instruction?: string } = {}): BeeHandoffRow {
  const rt = rig.store.currentRuntime(beeId);
  const target = { agent: opts.agent ?? "claude", args: null, account: null };
  const request = { beeId, expected: { generation: rt?.generation ?? 0 }, target, instruction: opts.instruction ?? null, stopAt: opts.stopAt ?? ("idle" as const) };
  return rig.store.admitBeeHandoff({ ...request, idempotencyKey: opts.key ?? `${beeId}-h`, requestHash: hashBeeHandoffRequest(request), target: { ...target, env: {} } });
}

function steps(rig: Rig, n: number): void {
  for (let i = 0; i < n; i += 1) {
    rig.clock.now += 1;
    rig.core.step();
  }
}

function handoff(rig: Rig, id: string): BeeHandoffRow {
  const row = rig.store.getBeeHandoff(id);
  if (!row) throw new Error(`handoff ${id} missing`);
  return row;
}

test("handoff.loop.cross-family: idle codex source → claude target; seed delivered first, queued mail follows in order", () => {
  const rig = makeRig({
    readHandoffTranscript: () => ({ turns: [{ role: "user", text: "ship the parser" }, { role: "assistant", text: "Parser shipped. I chose recursion instead of a table." }], truncated: false }),
  });
  try {
    spawnIdle(rig, "b1", "codex");
    rig.driver.sessions.push({ beeId: "b1", generation: 1, sessionId: "codex-thread-1" });
    steps(rig, 1);
    assert.equal(rig.store.getBee("b1")?.providerSessionId, "codex-thread-1");
    const m1 = rig.store.send("b1", "queued one").message;
    steps(rig, 2);
    assert.equal(rig.store.getMessage(m1.id)?.deliveredAt != null, true, "pre-handoff mail delivers normally");
    const admitted = admit(rig, "b1", { instruction: "continue on claude" });
    const q1 = rig.store.send("b1", "queued during handoff A").message;
    const q2 = rig.store.send("b1", "queued during handoff B", { urgency: "now" }).message;
    assert.equal(handoff(rig, admitted.id).phase, "stopping");
    steps(rig, 1); // stop claimed + executed (fake driver: exited immediately)
    steps(rig, 3); // exit observed → summarizing → context → switch → revive claimed → gen 2 started
    const switched = handoff(rig, admitted.id);
    assert.ok(["starting", "complete"].includes(switched.phase), switched.phase);
    assert.equal(rig.store.getBee("b1")?.agent, "claude");
    assert.equal(rig.store.getBee("b1")?.providerSessionId, null, "no provider thread is carried across harnesses");
    assert.equal(rig.store.getBee("b1")?.sessionLogPath, "/tmp/logs/b1.s1.jsonl");
    assert.equal(rig.driver.starts.at(-1)?.generation, 2);
    steps(rig, 4);
    const done = handoff(rig, admitted.id);
    assert.equal(done.phase, "complete", JSON.stringify(done.failure));
    assert.equal(done.targetGeneration, 2);
    assert.equal(rig.store.getBee("b1")?.activeHandoffId, null);
    // Delivery order on the target: seed first, then the queued user mail FIFO (the `now` message did not jump the seed).
    const gen2Deliveries = rig.driver.deliveredIds.slice(rig.driver.deliveredIds.indexOf(done.seedMessageId!));
    assert.deepEqual(gen2Deliveries, [done.seedMessageId, q1.id, q2.id]);
    const seedBody = rig.driver.deliveredBodies[rig.driver.deliveredIds.indexOf(done.seedMessageId!)]!;
    assert.ok(seedBody.startsWith(HANDOFF_SEED_MARKER));
    assert.ok(seedBody.includes("continue on claude"));
    assert.ok(seedBody.includes("Parser shipped"));
    assert.ok(seedBody.includes("codex-thread-1"), "transcript references name the source thread");
    assert.deepEqual(done.context?.mailbox.queuedMessageIds, [q1.id, q2.id]);
    assert.deepEqual(done.context?.mailbox.summarizedMessageIds, [m1.id]);
    assert.ok(done.context?.decisions.some((d) => /chose recursion/.test(d)));
    // Every queued message was delivered exactly once, to the target generation.
    for (const id of [q1.id, q2.id]) assert.equal(rig.store.getMessage(id)?.deliveredGeneration, 2);
    assert.equal(rig.driver.deliveredIds.filter((id) => id === q1.id).length, 1);
    // Segments: source closed on gen 1 with its thread, target open from gen 2.
    const segments = rig.store.listTranscriptSegments("b1");
    assert.deepEqual(
      segments.map((s) => [s.ordinal, s.harness, s.providerSessionId, s.fromGeneration, s.toGeneration, s.path]),
      [[0, "codex", "codex-thread-1", 1, 1, "/tmp/logs/b1.jsonl"], [1, "claude", null, 2, null, "/tmp/logs/b1.s1.jsonl"]],
    );
    // The target's own thread lands on the bee and the open segment; a late source callback lands on the closed one.
    rig.driver.sessions.push({ beeId: "b1", generation: 1, sessionId: "codex-thread-late" });
    rig.driver.sessions.push({ beeId: "b1", generation: 2, sessionId: "claude-thread-2" });
    steps(rig, 1);
    assert.equal(rig.store.getBee("b1")?.providerSessionId, "claude-thread-2");
    assert.equal(rig.store.listTranscriptSegments("b1")[0]?.providerSessionId, "codex-thread-late");
    assert.equal(rig.store.listTranscriptSegments("b1")[1]?.providerSessionId, "claude-thread-2");
    // Mirror shapes: the locked view keys.
    const row = rig.store.listBeeViewRows().find((r) => r.bee.id === "b1")!;
    assert.deepEqual(Object.keys(row).sort(), [...MIRROR_BEE_ROW_KEYS].sort());
    assert.deepEqual(Object.keys(row.handoff as object).sort(), [...MIRROR_BEE_HANDOFF_KEYS].sort());
    assert.deepEqual(Object.keys(row.handoff!.context as object).sort(), [...MIRROR_HANDOFF_CONTEXT_KEYS].sort());
    assert.deepEqual(Object.keys(segments[0] as object).sort(), [...MIRROR_TRANSCRIPT_SEGMENT_KEYS].sort());
  } finally {
    rig.cleanup();
  }
});

test("handoff.loop.working: stopAt=idle waits for the running turn; the source takes no new turn; stopAt=now stops mid-turn", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "w1", "claude");
    rig.driver.events.push({ beeId: "w1", generation: 1, kind: "turn_started" });
    steps(rig, 1);
    assert.equal(rig.store.currentRuntime("w1")?.state, "running");
    const admitted = admit(rig, "w1", { agent: "claude" }); // same-family context reset
    const urgent = rig.store.send("w1", "interrupt me", { urgency: "now" }).message;
    steps(rig, 3);
    assert.equal(handoff(rig, admitted.id).phase, "stopping", "stop waits for the turn to end");
    assert.equal(rig.driver.hasProcess("w1", 1), true, "source still running its turn");
    assert.equal(rig.driver.interrupts.length, 0, "fenced: the now-message did not interrupt the quiescing source");
    assert.equal(rig.store.getMessage(urgent.id)?.deliveredAt, null);
    rig.driver.events.push({ beeId: "w1", generation: 1, kind: "turn_ended" });
    steps(rig, 8);
    const done = handoff(rig, admitted.id);
    assert.equal(done.phase, "complete", JSON.stringify(done.failure));
    assert.equal(rig.store.getMessage(urgent.id)?.deliveredGeneration, 2);
    assert.equal(rig.driver.deliveredIds.indexOf(done.seedMessageId!) < rig.driver.deliveredIds.indexOf(urgent.id), true);

    // stopAt=now on a working source stops it immediately.
    spawnIdle(rig, "w2", "claude");
    rig.driver.events.push({ beeId: "w2", generation: 1, kind: "turn_started" });
    steps(rig, 1);
    const now = admit(rig, "w2", { agent: "codex", stopAt: "now" });
    steps(rig, 1);
    assert.equal(rig.driver.hasProcess("w2", 1), false, "stopped mid-turn");
    steps(rig, 8);
    assert.equal(handoff(rig, now.id).phase, "complete");
    assert.equal(rig.store.getBee("w2")?.agent, "codex");
  } finally {
    rig.cleanup();
  }
});

test("handoff.loop.stopped: a stopped source admits, the stop moots, the switch and target boot proceed", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "s1", "codex");
    rig.store.enqueueCommand("stop", "s1", { cause: "stopped_by_user" });
    steps(rig, 3);
    assert.equal(rig.store.currentRuntime("s1")?.state, "stopped");
    const admitted = admit(rig, "s1");
    steps(rig, 8);
    const done = handoff(rig, admitted.id);
    assert.equal(done.phase, "complete", JSON.stringify(done.failure));
    assert.equal(rig.store.currentRuntime("s1")?.generation, 2);
    assert.equal(rig.store.currentRuntime("s1")?.state, "idle");
    assert.equal(rig.store.getBee("s1")?.agent, "claude");
  } finally {
    rig.cleanup();
  }
});

test("handoff.loop.restart: a daemon crash at every phase resumes from durable state; replaying the key returns the same receipt", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "r1", "codex");
    const admitted = admit(rig, "r1", { key: "restart-key" });
    // Crash while stopping (the stop command may be running: boot requeues it).
    rig.restart();
    assert.equal(rig.store.admitBeeHandoff({
      beeId: "r1", idempotencyKey: "restart-key", requestHash: admitted.requestHash,
      expected: { generation: 1 }, target: { agent: "claude", args: null, account: null, env: {} }, instruction: null, stopAt: "idle",
    }).id, admitted.id, "the original operation is returned after restart");
    assert.equal(handoff(rig, admitted.id).phase, "stopping");
    // One step: boot reconciled the (process-less) source stopped; the stop moots; summarizing → switch → starting.
    steps(rig, 1);
    let current = handoff(rig, admitted.id);
    assert.equal(current.phase, "starting", current.phase);
    assert.equal(rig.store.getBee("r1")?.agent, "claude");
    assert.equal(rig.store.getCommandByIdempotencyKey(beeHandoffReviveKey(admitted.id))?.status, "queued", "revive not yet claimed");
    // Crash right after the switch (starting; revive queued, target not started).
    rig.restart();
    assert.equal(rig.store.getBee("r1")?.agent, "claude", "the switch is durable");
    steps(rig, 1);
    assert.equal(rig.driver.starts.some((s) => s.beeId === "r1" && s.generation === 2), true, "target generation started after restart");
    // Crash after the target booted, before the seed delivered.
    rig.driver.acceptDeliveries = false;
    steps(rig, 2);
    current = handoff(rig, admitted.id);
    assert.equal(current.phase, "starting");
    assert.equal(rig.store.getMessage(current.seedMessageId!)?.deliveredAt, null);
    rig.restart();
    // The target process is gone in this rig (fake driver) → reconciled stopped(machine_restart); the seed's wake brings the next generation, seed still first.
    steps(rig, 6);
    const done = handoff(rig, admitted.id);
    assert.equal(done.phase, "complete", JSON.stringify(done.failure));
    assert.equal(rig.driver.deliveredIds[0], done.seedMessageId);
    assert.ok((rig.store.currentRuntime("r1")?.generation ?? 0) >= 2);
    assert.equal(rig.store.getBee("r1")?.agent, "claude");
    assert.equal(rig.store.listTranscriptSegments("r1").length, 2);
    assert.equal(rig.store.listTranscriptSegments("r1")[1]?.fromGeneration, 2, "the target segment starts at the first post-switch generation");
  } finally {
    rig.cleanup();
  }
});

test("handoff.loop.target-boot-failure: the target exhausting its spawn budget fails the handoff at stage start; revive retries with the seed still first", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "f1", "codex");
    const admitted = admit(rig, "f1");
    steps(rig, 1);
    rig.driver.bootCrash = true;
    steps(rig, 40);
    const failed = handoff(rig, admitted.id);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.stage, "start");
    assert.equal(failed.failure?.code, "spawn_failed");
    assert.equal(rig.store.getBee("f1")?.agent, "claude", "post-switch failure stays on the target harness");
    assert.equal(rig.store.getBee("f1")?.activeHandoffId, null);
    assert.equal(rig.store.getMessage(failed.seedMessageId!)?.deliveredAt, null, "seed still queued");
    rig.driver.bootCrash = false;
    rig.store.enqueueCommand("revive", "f1");
    steps(rig, 6);
    assert.equal(rig.store.getMessage(failed.seedMessageId!)?.deliveredAt != null, true, "operator revive delivers the seed");
    assert.equal(rig.driver.deliveredIds.at(-1), failed.seedMessageId);
  } finally {
    rig.cleanup();
  }
});

test("handoff.loop.context-failure: a transcript read failure fails the handoff before the switch and revives the source on its old harness", () => {
  const rig = makeRig({ readHandoffTranscript: () => { throw new Error("disk gone"); } });
  try {
    spawnIdle(rig, "c1", "codex");
    const admitted = admit(rig, "c1");
    steps(rig, 6);
    const failed = handoff(rig, admitted.id);
    assert.equal(failed.phase, "failed");
    assert.equal(failed.failure?.stage, "context");
    assert.match(failed.failure?.detail ?? "", /disk gone/);
    assert.equal(rig.store.getBee("c1")?.agent, "codex", "source untouched");
    assert.equal(rig.store.listTranscriptSegments("c1").length, 1);
    steps(rig, 4);
    assert.equal(rig.store.currentRuntime("c1")?.generation, 2, "recovery revive brought the source back");
    assert.equal(rig.store.currentRuntime("c1")?.state, "idle");
  } finally {
    rig.cleanup();
  }
});

test("handoff.loop.async-summarizer: the switch waits for the summarizer; its result is the seed; a rejection fails at stage context", async () => {
  let resolveIt: (() => void) | null = null;
  const rig = makeRig({
    summarizeHandoff: ({ base }) => new Promise<HandoffContext>((resolve) => { resolveIt = () => resolve({ ...base, summarizer: "llm-test", task: `${base.task ?? ""}|refined` }); }),
  });
  try {
    spawnIdle(rig, "a1", "codex");
    const admitted = admit(rig, "a1", { instruction: "refine" });
    steps(rig, 4);
    assert.equal(handoff(rig, admitted.id).phase, "summarizing", "held until the summarizer settles");
    assert.ok(resolveIt);
    (resolveIt as () => void)();
    await new Promise((r) => setImmediate(r));
    const switched = handoff(rig, admitted.id);
    assert.equal(switched.phase, "starting");
    assert.equal(switched.context?.summarizer, "llm-test");
    steps(rig, 6);
    assert.equal(handoff(rig, admitted.id).phase, "complete");
  } finally {
    rig.cleanup();
  }
  const rejecting = makeRig({ summarizeHandoff: () => Promise.reject(new Error("model unavailable")) });
  try {
    spawnIdle(rejecting, "a2", "codex");
    const admitted = admit(rejecting, "a2");
    steps(rejecting, 4);
    await new Promise((r) => setImmediate(r));
    const failed = handoff(rejecting, admitted.id);
    assert.equal(failed.phase, "failed");
    assert.deepEqual([failed.failure?.stage, failed.failure?.code], ["context", "summarizer_failed"]);
    assert.equal(rejecting.store.getBee("a2")?.agent, "codex");
  } finally {
    rejecting.cleanup();
  }
});

test("handoff.loop.supersede: an operator stop during stopping cancels the handoff; the bee keeps its harness and thread", () => {
  const rig = makeRig();
  try {
    spawnIdle(rig, "o1", "codex");
    rig.driver.sessions.push({ beeId: "o1", generation: 1, sessionId: "keep-me" });
    rig.driver.events.push({ beeId: "o1", generation: 1, kind: "turn_started" });
    steps(rig, 1);
    const admitted = admit(rig, "o1");
    steps(rig, 1);
    assert.equal(handoff(rig, admitted.id).phase, "stopping");
    rig.store.enqueueCommand("stop", "o1", { cause: "stopped_by_user" });
    steps(rig, 3);
    const superseded = handoff(rig, admitted.id);
    assert.equal(superseded.phase, "failed");
    assert.equal(superseded.failure?.code, "superseded");
    assert.equal(rig.store.getBee("o1")?.agent, "codex");
    assert.equal(rig.store.getBee("o1")?.providerSessionId, "keep-me");
    assert.equal(rig.store.getCommandByIdempotencyKey(beeHandoffReviveKey(admitted.id)), null, "no revive was ever enqueued");
    assert.equal(rig.store.currentRuntime("o1")?.state, "stopped");
  } finally {
    rig.cleanup();
  }
});
