import { enrollReferences } from "./human-ref-fixture.ts";
/**
 * v23 session handoff aggregate: admission (CAS, idempotency, fence), the
 * stopping → summarizing → starting → complete graph, the switch tx (segments,
 * bee flip, seed mail, fenced revive), generation-fenced provider sessions,
 * typed failure + recovery, operator supersede, audit replay, migration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  HANDOFF_SEED_MARKER,
  HANDOFF_SEED_SENDER,
  HandoffInProgressError,
  IdempotencyConflictError,
  IllegalTransitionError,
  SCHEMA_VERSION,
  StaleGenerationError,
  beeHandoffReviveKey,
  beeHandoffStopKey,
  buildExtractiveHandoffContext,
  hashBeeHandoffRequest,
  openCoreStore,
  renderHandoffSeed,
  replayAudit,
  segmentSessionLogPath,
  type CoreStore,
  type HandoffContext,
} from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

function admit(store: CoreStore, beeId: string, opts: { key?: string; agent?: string; stopAt?: "idle" | "now"; instruction?: string | null } = {}) {
  const bee = store.getBee(beeId)!;
  const rt = store.currentRuntime(beeId);
  const target = { agent: opts.agent ?? "codex", args: null, account: null };
  const request = { beeId, expected: { generation: rt?.generation ?? 0 }, target, instruction: opts.instruction ?? null, stopAt: opts.stopAt ?? "idle" as const };
  return store.admitBeeHandoff({
    ...request,
    idempotencyKey: opts.key ?? "h1",
    requestHash: hashBeeHandoffRequest(request),
    target: { ...target, env: { CODEX_HOME: "/tmp/codex-home" } },
  });
}

function contextFor(store: CoreStore, beeId: string, handoffId: string): HandoffContext {
  const bee = store.getBee(beeId)!;
  const handoff = store.getBeeHandoff(handoffId)!;
  return buildExtractiveHandoffContext({
    bee: { id: bee.id, name: bee.name, title: bee.title, cwd: bee.cwd, substrate: bee.substrate, agent: bee.agent, args: bee.args, cellId: bee.cellId },
    target: { agent: handoff.to.agent, args: handoff.to.args },
    instruction: handoff.instruction,
    turns: [{ role: "user", text: "build the widget" }, { role: "assistant", text: "I decided to use the existing parser instead of a new one. Done with step one." }],
    transcriptTruncated: false,
    segments: store.listTranscriptSegments(bee.id),
    messages: store.listMessages(bee.id),
    seals: store.listSeals({ beeId: bee.id }),
    tasks: store.listTasks({ beeId: bee.id }),
    questions: store.listQuestions({ beeId: bee.id }),
    now: 5,
  });
}

test("handoff.segment0: every bee is born with transcript segment 0 on its spawn harness and log path", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "s", agent: "claude", substrate: "hsr", cwd: "/tmp/w", sessionLogPath: "/tmp/logs/b.jsonl" });
    const segments = store.listTranscriptSegments(bee.id);
    assert.equal(segments.length, 1);
    assert.deepEqual(
      { ordinal: segments[0]!.ordinal, harness: segments[0]!.harness, path: segments[0]!.path, from: segments[0]!.fromGeneration, to: segments[0]!.toGeneration, handoffId: segments[0]!.handoffId },
      { ordinal: 0, harness: "claude", path: "/tmp/logs/b.jsonl", from: 1, to: null, handoffId: null },
    );
    assert.equal(segmentSessionLogPath("/tmp/logs/b.jsonl", 1), "/tmp/logs/b.s1.jsonl");
    assert.equal(segmentSessionLogPath("/tmp/logs/b.s1.jsonl", 2), "/tmp/logs/b.s2.jsonl");
    assert.equal(segmentSessionLogPath(null, 3), null);
    // The open segment learns the provider thread the bee reports.
    store.recordProviderSessionId(bee.id, "thread-a", 1);
    assert.equal(store.currentTranscriptSegment(bee.id)?.providerSessionId, "thread-a");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.deleteBee(bee.id);
    assert.deepEqual(store.listTranscriptSegments(bee.id), []);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.admit: CAS on generation, idempotent by key, conflict on a different request, one in flight, fence", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store, "w");
    store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    store.send(bee.id, "queued before");
    const admitted = admit(store, bee.id);
    assert.equal(admitted.phase, "stopping");
    assert.equal(admitted.sourceGeneration, 1);
    assert.equal(admitted.from.agent, "claude");
    assert.equal(admitted.to.agent, "codex");
    assert.equal(admitted.sourceWasLive, true);
    assert.equal(store.getBee(bee.id)?.activeHandoffId, admitted.id);
    assert.equal(admitted.targetSessionLogPath, null);
    // The fenced stop carries the key and waits for idle.
    const stop = store.getCommandByIdempotencyKey(beeHandoffStopKey(admitted.id, 1));
    assert.ok(stop);
    assert.equal(stop.verb, "stop");
    assert.equal(stop.args.waitForIdle, true);
    assert.equal(stop.args.reason, "bee.handoff");
    // Replay: same key + same request → the same receipt; a different request → conflict.
    assert.equal(admit(store, bee.id).id, admitted.id);
    assert.throws(() => admit(store, bee.id, { agent: "grok" }), IdempotencyConflictError);
    assert.throws(() => admit(store, bee.id, { key: "h2" }), HandoffInProgressError);
    // Stale CAS.
    assert.throws(
      () => store.admitBeeHandoff({ beeId: bee.id, idempotencyKey: "h3", requestHash: "x", expected: { generation: 7 }, target: { agent: "codex", args: null, account: null, env: {} }, instruction: null, stopAt: "idle" }),
      HandoffInProgressError,
    );
    // Fence: a wake for fenced mail is refused, spawn/send_wake are not claimable, send still inserts.
    assert.equal(store.enqueueWake(bee.id).outcome, "fenced");
    const sent = store.send(bee.id, "queued during");
    assert.equal(sent.wakeCommand, null);
    assert.equal(store.undeliveredMessages(bee.id).length, 2);
    // stopAt=idle: the stop is not claimable while the source turn runs …
    assert.equal(store.claimNextCommand(), null, "stop waits for the running turn to end");
    store.updateRuntimeState(bee.id, 1, "idle");
    // … and claims at the idle boundary.
    assert.equal(store.claimNextCommand()?.idempotencyKey, beeHandoffStopKey(admitted.id, 1));
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.stale: a second admission after generation moved is stale_generation; archived bees are refused", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store, "w");
    assert.throws(
      () => store.admitBeeHandoff({ beeId: bee.id, idempotencyKey: "k", requestHash: "x", expected: { generation: 3 }, target: { agent: "codex", args: null, account: null, env: {} }, instruction: null, stopAt: "idle" }),
      StaleGenerationError,
    );
    assert.throws(
      () => store.admitBeeHandoff({ beeId: bee.id, idempotencyKey: "k", requestHash: "x", expected: { generation: 1, agent: "codex" }, target: { agent: "codex", args: null, account: null, env: {} }, instruction: null, stopAt: "idle" }),
      StaleGenerationError,
    );
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
    store.archiveBee(bee.id);
    assert.throws(() => admit(store, bee.id), IllegalTransitionError);
    assert.equal(store.getBee(bee.id)?.activeHandoffId, null);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.switch: segments close/open, bee flips with no provider thread, seed mail first, fenced revive, complete", () => {
  const h = harness();
  const store = h.open();
  enrollReferences(store);
  try {
    const { bee } = store.createBee({ name: "w", agent: "claude", substrate: "hsr", cwd: "/tmp/w", sessionLogPath: "/tmp/logs/w.jsonl", args: ["--model", "opus"], env: { CLAUDE_CONFIG_DIR: "/tmp/claude-home", KEEP: "1" } });
    store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    store.recordProviderSessionId(bee.id, "claude-thread", 1);
    store.updateRuntimeState(bee.id, 1, "idle", { recordOutput: true });
    const before = store.send(bee.id, "first queued").message;
    const admitted = admit(store, bee.id, { instruction: "continue on codex" });
    assert.equal(admitted.targetSessionLogPath, "/tmp/logs/w.s1.jsonl");
    assert.equal(admitted.from.providerSessionId, "claude-thread");
    // summarizing requires the source generation stopped.
    assert.throws(() => store.setBeeHandoffPhase(admitted.id, "summarizing"), IllegalTransitionError);
    const stop = store.claimNextCommand();
    assert.equal(stop?.idempotencyKey, beeHandoffStopKey(admitted.id, 1));
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    store.completeCommand(stop!.id);
    store.setBeeHandoffPhase(admitted.id, "summarizing");
    assert.equal(store.enqueueWake(bee.id).outcome, "fenced");
    const context = contextFor(store, bee.id, admitted.id);
    assert.equal(context.summarizer, "extractive");
    assert.equal(context.task, "build the widget", "no delivered operator message: the first user turn is the task");
    assert.ok(context.decisions.some((d) => /decided/.test(d)));
    assert.deepEqual(context.mailbox.queuedMessageIds, [before.id]);
    assert.deepEqual(context.mailbox.summarizedMessageIds, []);
    const switched = store.switchBeeHandoff(admitted.id, context);
    assert.equal(switched.phase, "starting");
    assert.equal(switched.targetGeneration, 2);
    assert.ok(switched.seedMessageId);
    assert.deepEqual(switched.context, context);
    // Segments: source closed at gen 1 carrying its thread; target open from gen 2 on its own file.
    const segments = store.listTranscriptSegments(bee.id);
    assert.equal(segments.length, 2);
    assert.deepEqual(
      segments.map((s) => ({ ordinal: s.ordinal, harness: s.harness, sid: s.providerSessionId, from: s.fromGeneration, to: s.toGeneration, path: s.path, handoffId: s.handoffId })),
      [
        { ordinal: 0, harness: "claude", sid: "claude-thread", from: 1, to: 1, path: "/tmp/logs/w.jsonl", handoffId: null },
        { ordinal: 1, harness: "codex", sid: null, from: 2, to: null, path: "/tmp/logs/w.s1.jsonl", handoffId: admitted.id },
      ],
    );
    assert.equal(switched.to.segmentId, segments[1]!.id);
    // Bee: identity kept; harness/args/account/env/log switched; NO provider thread (never another provider's id).
    const after = store.getBee(bee.id)!;
    assert.equal(after.id, bee.id);
    assert.equal(after.name, "w");
    assert.equal(after.handle, bee.handle);
    assert.equal(after.human_ref, bee.human_ref);
    assert.equal(after.issuing_namespace, "k7");
    assert.equal(after.agent, "codex");
    assert.equal(after.args, null);
    assert.equal(after.providerSessionId, null);
    assert.equal(after.forkSeed, null);
    assert.equal(after.sessionLogPath, "/tmp/logs/w.s1.jsonl");
    assert.deepEqual(after.env, { CODEX_HOME: "/tmp/codex-home" });
    assert.equal(after.activeHandoffId, admitted.id);
    // Seed: a durable mailbox row of its own origin, delivered before older user mail.
    const seed = store.getMessage(switched.seedMessageId!)!;
    assert.equal(seed.sender, HANDOFF_SEED_SENDER);
    assert.ok(seed.body.startsWith(HANDOFF_SEED_MARKER));
    assert.ok(seed.body.includes("continue on codex"));
    assert.ok(seed.id > before.id, "the seed is inserted at the switch, after older user mail");
    assert.equal(store.pendingHandoffSeedMessageId(bee.id), seed.id);
    assert.equal(seed.body, renderHandoffSeed(context, { beeName: "w", fromAgent: "claude", toAgent: "codex" }));
    const enqueued = store.auditRows().find((r) => r.kind === "mail.enqueued" && (r.payload.message as { id: number }).id === seed.id);
    assert.equal(enqueued?.payload.origin, "handoff.seed");
    // Only the handoff's own revive is claimable while starting.
    const revive = store.claimNextCommand();
    assert.equal(revive?.verb, "revive");
    assert.equal(revive?.idempotencyKey, beeHandoffReviveKey(admitted.id));
    const gen2 = store.reviveBee(bee.id);
    assert.equal(gen2.generation, 2);
    store.completeCommand(revive!.id);
    // A late session id from the closed source generation lands on segment 0, never on the bee.
    assert.equal(store.recordProviderSessionId(bee.id, "claude-thread-late", 1).applied, false);
    assert.equal(store.getBee(bee.id)?.providerSessionId, null);
    assert.equal(store.listTranscriptSegments(bee.id)[0]!.providerSessionId, "claude-thread-late");
    assert.ok(store.auditRows().some((r) => r.kind === "bee.provider_session_fenced"));
    // The target's own thread lands on the bee and the open segment.
    assert.equal(store.recordProviderSessionId(bee.id, "codex-thread", 2).applied, true);
    assert.equal(store.getBee(bee.id)?.providerSessionId, "codex-thread");
    assert.equal(store.currentTranscriptSegment(bee.id)?.providerSessionId, "codex-thread");
    // Seed delivered → complete; the fence lifts; user mail still queued in order.
    store.updateRuntimeState(bee.id, 2, "running", { pid: 2, pidStartedAt: 2 });
    store.markDelivered(seed.id, 2);
    assert.equal(store.pendingHandoffSeedMessageId(bee.id), null);
    const done = store.completeBeeHandoff(admitted.id);
    assert.equal(done.phase, "complete");
    assert.equal(store.getBee(bee.id)?.activeHandoffId, null);
    assert.deepEqual(store.undeliveredMessages(bee.id).map((m) => m.id), [before.id]);
    assert.equal(store.latestHandoffOf(bee.id)?.id, admitted.id);
    assert.equal(store.listBeeViewRows().find((r) => r.bee.id === bee.id)?.handoff?.phase, "complete");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    // A second handoff (same family reset) after completion is admissible with the new generation.
    const second = store.admitBeeHandoff({
      beeId: bee.id, idempotencyKey: "h2", requestHash: "h2", expected: { generation: 2, agent: "codex" },
      target: { agent: "codex", args: ["--model", "gpt-5"], account: null, env: {} }, instruction: null, stopAt: "now",
    });
    assert.equal(second.targetSessionLogPath, "/tmp/logs/w.s2.jsonl");
    assert.equal(store.getCommandByIdempotencyKey(beeHandoffStopKey(second.id, 2))?.args.waitForIdle, undefined);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.fail-before-switch: source untouched on its old harness, wake re-armed for fenced mail, live source revived", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store, "w");
    store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    store.recordProviderSessionId(bee.id, "sid", 1);
    store.updateRuntimeState(bee.id, 1, "idle");
    const admitted = admit(store, bee.id);
    const stop = store.claimNextCommand()!;
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
    store.completeCommand(stop.id);
    store.setBeeHandoffPhase(admitted.id, "summarizing");
    const failed = store.failBeeHandoff(admitted.id, { stage: "context", code: "transcript_unreadable", detail: "boom" });
    assert.equal(failed.phase, "failed");
    assert.deepEqual(failed.failure, { stage: "context", code: "transcript_unreadable", detail: "boom" });
    const after = store.getBee(bee.id)!;
    assert.equal(after.agent, "claude");
    assert.equal(after.providerSessionId, "sid");
    assert.equal(after.activeHandoffId, null);
    assert.equal(store.listTranscriptSegments(bee.id).length, 1);
    // Recovery: the source was live at admission → a revive on the OLD harness is enqueued automatically.
    const recovery = store.listCommands({ beeId: bee.id, status: "queued" }).find((c) => c.verb === "revive");
    assert.ok(recovery, "durable recovery revive");
    assert.equal(recovery.args.reason, "handoff_recovery");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());

    // Variant: fenced mail present → the wake is re-armed instead.
    const { bee: b2 } = makeBee(store, "w2");
    store.updateRuntimeState(b2.id, 1, "stopped", { exitCause: "clean" });
    const a2 = store.admitBeeHandoff({ beeId: b2.id, idempotencyKey: "k2", requestHash: "k2", expected: { generation: 1 }, target: { agent: "codex", args: null, account: null, env: {} }, instruction: null, stopAt: "idle" });
    assert.equal(store.send(b2.id, "hello").wakeCommand, null, "fenced");
    store.failBeeHandoff(a2.id, { stage: "stop", code: "handoff_failed", detail: "x" });
    assert.equal(store.listCommands({ beeId: b2.id, status: "queued" }).some((c) => c.verb === "send_wake"), true);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.supersede: operator stop/delete during an in-flight handoff fails it as superseded and moots its commands", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store, "w");
    store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
    const admitted = admit(store, bee.id);
    const operatorStop = store.enqueueCommand("stop", bee.id, { cause: "stopped_by_user" });
    const receipt = store.getBeeHandoff(admitted.id)!;
    assert.equal(receipt.phase, "failed");
    assert.equal(receipt.failure?.code, "superseded");
    assert.equal(store.getBee(bee.id)?.activeHandoffId, null);
    assert.equal(store.getCommandByIdempotencyKey(beeHandoffStopKey(admitted.id, 1))?.status, "done");
    assert.equal(store.getCommand(operatorStop.id)?.status, "queued");
    assert.equal(store.getBee(bee.id)?.agent, "claude");

    const { bee: b2 } = makeBee(store, "w2");
    const a2 = store.admitBeeHandoff({ beeId: b2.id, idempotencyKey: "k2", requestHash: "k2", expected: { generation: 1 }, target: { agent: "codex", args: null, account: null, env: {} }, instruction: null, stopAt: "now" });
    store.deleteBee(b2.id);
    assert.equal(store.getBeeHandoff(a2.id)?.phase, "failed");
    assert.equal(store.getBeeHandoff(a2.id)?.failure?.detail, "bee deleted");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.move-exclusion: an in-flight move refuses a handoff and vice versa", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = store.createBee({ name: "c", agent: "claude", substrate: "cell", cwd: "/tmp/cell-space" });
    admit(store, bee.id);
    const cell = store.putCell({
      sourceBeeId: bee.id, originRepo: "/tmp/origin", sha: "abc", wrapper: "w", spaceName: "repo-space-c1", spaceDir: bee.cwd,
      gitCommonDirRealpath: "/tmp/origin/.git", objectFormat: "sha1",
    });
    assert.throws(
      () => store.admitBeeMove({ beeId: bee.id, idempotencyKey: "m", requestHash: "m", expected: { placementVersion: 0, cellId: cell.id }, destinationCwd: "/tmp/checkout" }),
      /handoff|move/,
    );
  } finally {
    store.close();
    h.cleanup();
  }
});

test("handoff.migration: a v22 store gains segment 0 per bee, the handoff tables, and the widened mail-history origin", () => {
  const h = harness();
  let store = h.open();
  const { bee } = store.createBee({ name: "old", agent: "codex", substrate: "hsr", cwd: "/tmp/w", sessionLogPath: "/tmp/logs/old.jsonl", providerSessionId: "t-1" });
  store.send(bee.id, "hi");
  store.close();
  // Downgrade the file to a v22 shape: drop the v23 tables/column facts, restamp.
  const db = new DatabaseSync(h.path);
  db.exec("DROP TABLE transcript_segments; DROP TABLE bee_handoffs;");
  db.exec("UPDATE meta SET value = '22' WHERE key = 'schema_version'");
  db.exec("ALTER TABLE mail_history_enqueues RENAME TO mail_history_enqueues_old");
  db.exec(`CREATE TABLE mail_history_enqueues (
    seq INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE, bee_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('mail.send','spawn.prompt','legacy.unknown')),
    sender BLOB NOT NULL, sender_truncated INTEGER NOT NULL CHECK (sender_truncated IN (0, 1)),
    body BLOB NOT NULL, body_truncated INTEGER NOT NULL CHECK (body_truncated IN (0, 1)),
    priority INTEGER NOT NULL, urgency TEXT NOT NULL CHECK (urgency IN ('now','next','idle')), enqueued_at INTEGER NOT NULL) STRICT`);
  db.exec("INSERT INTO mail_history_enqueues SELECT * FROM mail_history_enqueues_old; DROP TABLE mail_history_enqueues_old");
  db.close();
  store = h.open();
  store.close();
  const check = new DatabaseSync(h.path, { readOnly: true });
  assert.equal(Number((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
  assert.ok(String((check.prepare("SELECT sql FROM sqlite_master WHERE name = 'mail_history_enqueues'").get() as { sql: string }).sql).includes("handoff.seed"));
  assert.equal((check.prepare("SELECT count(*) AS n FROM mail_history_enqueues").get() as { n: number }).n, 1);
  check.close();
  store = h.open();
  try {
    const segments = store.listTranscriptSegments(bee.id);
    assert.equal(segments.length, 1);
    assert.deepEqual(
      { ordinal: segments[0]!.ordinal, harness: segments[0]!.harness, sid: segments[0]!.providerSessionId, path: segments[0]!.path, createdAt: segments[0]!.createdAt },
      { ordinal: 0, harness: "codex", sid: "t-1", path: "/tmp/logs/old.jsonl", createdAt: bee.createdAt },
    );
    assert.equal(store.getBee(bee.id)?.activeHandoffId, null);
    // The migrated bee hands off like any other.
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
    const admitted = admit(store, bee.id, { agent: "claude" });
    assert.equal(admitted.from.segmentId, segments[0]!.id);
  } finally {
    store.close();
    h.cleanup();
  }
});
