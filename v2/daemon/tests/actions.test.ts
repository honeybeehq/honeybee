/**
 * v24 action queue — loop tier: DaemonCore under the FakeDriver + virtual
 * clock + a scripted Cell landing executor. Proves the first acceptance
 * scenario end to end with fixtures: Commit → Land → Archive accepted while
 * the bee is mid-turn, the instruction delivered at the next accept point,
 * explicit completion naming the commit, Land using that commit through the
 * capture receipt, Archive released only by a landing receipt, conflict /
 * question holds, daemon restart at every stage (including a lost capture
 * receipt reconciled through the probe, never a blind repeat), duplicate
 * enqueue/report/stale-attempt safety, pause/resume, cancel, concurrent
 * append and invalid reorder. Real git is exercised in actions-rpc.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_DISPATCH_MARKER,
  MIRROR_ACTION_KEYS,
  hashActionEnqueueRequest,
  openCoreStore,
  type ActionRow,
  type CoreStore,
} from "../../core/src/index.ts";
import type { CaptureReport } from "../../driver-cell/src/index.ts";
import { DaemonCore, type CellCaptureExecutor, type DaemonCoreOptions } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";

/** A scripted Cell landing owner: HEAD + target branch state live in memory; `capture` mutates them like git would. */
class FakeCellCapture implements CellCaptureExecutor {
  head: string | null = "c0ffee0000000000000000000000000000000001";
  /** Commits contained by the target branch, tip first. */
  target: string[] = ["ba5e0000000000000000000000000000000000000"];
  busy = false;
  absent = false;
  /** Next capture outcome override: conflict paths, or a throw. */
  conflict: string[] | null = null;
  throwNext: string | null = null;
  /** Crash simulation: perform the effect, then throw before returning the report. */
  crashAfterEffect = false;
  readonly captures: Array<{ beeId: string; targetBranch: string; mode: string; opId: string }> = [];

  inspect(beeId: string): { cellId: string; originRepo: string; spaceDir: string; head: string | null; busy: boolean } | null {
    if (this.absent) return null;
    return { cellId: `cell-${beeId}`, originRepo: "/tmp/origin", spaceDir: "/tmp/space", head: this.head, busy: this.busy };
  }

  capture(beeId: string, opts: { targetBranch: string; mode: "merge" | "rebase"; opId: string }): CaptureReport {
    this.captures.push({ beeId, ...opts });
    if (this.throwNext) {
      const detail = this.throwNext;
      this.throwNext = null;
      throw new Error(detail);
    }
    const base = { targetBranch: opts.targetBranch, mode: opts.mode, cellHead: this.head, baseTarget: this.target[0] ?? null, resultSha: null, conflicts: [] as string[], reason: null };
    if (this.head === null) return { ...base, status: "refused", reason: "no_cell_head" };
    if (this.target.includes(this.head)) return { ...base, status: "nothing_to_capture" };
    if (this.conflict) {
      const conflicts = this.conflict;
      this.conflict = null;
      return { ...base, status: "conflict", conflicts };
    }
    const merged = `4e4e${this.head.slice(4)}`;
    this.target = [merged, this.head, ...this.target];
    if (this.crashAfterEffect) {
      this.crashAfterEffect = false;
      throw new Error("simulated daemon death after the ref advanced");
    }
    return { ...base, status: "landed", resultSha: merged };
  }

  landed(_beeId: string, opts: { targetBranch: string; cellHead: string }): { landed: boolean; targetTip: string | null } | null {
    if (this.absent) return null;
    return { landed: this.target.includes(opts.cellHead), targetTip: this.target[0] ?? null };
  }
}

interface Rig {
  dir: string;
  store: CoreStore;
  driver: FakeDriver;
  core: DaemonCore;
  cell: FakeCellCapture;
  clock: { now: number };
  ops: string[];
  restart: (extra?: Partial<DaemonCoreOptions>) => void;
  cleanup: () => void;
}

function makeRig(extra: Partial<DaemonCoreOptions> = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "hb-v2-actions-"));
  const clock = { now: 1000 };
  const now = (): number => clock.now;
  const ops: string[] = [];
  const cell = new FakeCellCapture();
  const open = (opts: Partial<DaemonCoreOptions>) => {
    const store = openCoreStore(join(dir, "core.sqlite3"), { now, maxAttempts: 3, backoffBaseMs: 1, ephemeral: true });
    const driver = new FakeDriver(now);
    const core = new DaemonCore({
      store,
      driver,
      policy: { bootHangTimeoutSteps: 50, commandsPerStep: 8 },
      now,
      log: (op) => ops.push(op),
      cellCaptureExecutor: cell,
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
    cell,
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

function steps(rig: Rig, n: number): void {
  for (let i = 0; i < n; i += 1) {
    rig.clock.now += 1;
    rig.core.step();
  }
}

/** A Cell bee whose runtime is idle (real boot evidence). */
function spawnCellBee(rig: Rig, id: string): void {
  rig.store.createBee({ id, name: id, agent: "claude", substrate: "cell", cwd: "/tmp/space", sessionLogPath: `/tmp/logs/${id}.jsonl` });
  rig.store.enqueueCommand("spawn", id);
  steps(rig, 3);
  assert.equal(rig.store.currentRuntime(id)?.state, "idle");
}

function startTurn(rig: Rig, id: string): void {
  rig.driver.events.push({ beeId: id, generation: rig.store.currentRuntime(id)!.generation, kind: "turn_started" });
  steps(rig, 1);
  assert.equal(rig.store.currentRuntime(id)?.state, "running");
}

function endTurn(rig: Rig, id: string): void {
  rig.driver.events.push({ beeId: id, generation: rig.store.currentRuntime(id)!.generation, kind: "turn_ended" });
  steps(rig, 1);
}

function ship(rig: Rig, beeId: string, key = "ship") {
  const items = [
    { kind: "commit", version: null, inputs: { message: "ship" }, clientRef: "p1", title: null },
    { kind: "land", version: null, inputs: { targetBranch: "main", commit: { $ref: { item: 0, output: "commitSha" } } }, clientRef: "p2", title: null },
    { kind: "archive", version: null, inputs: {}, clientRef: "p3", title: null },
  ];
  return rig.store.enqueueActions({ beeId, idempotencyKey: key, requestHash: hashActionEnqueueRequest({ beeId, items }), items });
}

function action(rig: Rig, id: string): ActionRow {
  const row = rig.store.getAction(id);
  if (!row) throw new Error(`action ${id} missing`);
  return row;
}

function tokenOf(body: string): { attempt: number; token: string } {
  const m = /--attempt (\d+) --token ([0-9a-f]+)/.exec(body);
  if (!m) throw new Error(`no token in body: ${body}`);
  return { attempt: Number(m[1]), token: m[2] as string };
}

function lastDeliveredBody(rig: Rig): string {
  const body = rig.driver.deliveredBodies.at(-1);
  if (!body) throw new Error("nothing delivered");
  return body;
}

test("actions.loop.ship: Commit → Land → Archive accepted mid-turn; instruction at the next accept point; explicit report → capture receipt → archive command", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "b1");
    startTurn(rig, "b1");
    const { actions } = ship(rig, "b1");
    const [commit, land, archive] = actions.map((a) => a.id) as [string, string, string];
    // Accepted durably while working; nothing dispatched until the scheduler runs, then the instruction rides the mailbox.
    steps(rig, 1);
    assert.equal(action(rig, commit).status, "running");
    assert.equal(action(rig, commit).attempt, 1);
    assert.equal(action(rig, land).status, "queued");
    const msg = rig.store.getMessage(action(rig, commit).dispatch!.messageId!)!;
    assert.equal(msg.urgency, "next");
    // `next` delivers at the harness accept point (the fake accepts mid-turn); no interrupt was requested.
    assert.equal(rig.driver.interrupts.length, 0);
    assert.equal(action(rig, commit).dispatch?.deliveredAt != null, true, "delivered");
    assert.ok(lastDeliveredBody(rig).startsWith(ACTION_DISPATCH_MARKER));
    // The turn ends without a report: NOT completion. Nothing downstream moves.
    endTurn(rig, "b1");
    steps(rig, 3);
    assert.equal(action(rig, commit).status, "running");
    assert.equal(action(rig, land).status, "queued");
    assert.equal(rig.cell.captures.length, 0);
    // The agent reports the commit it produced (the Cell HEAD moved to it).
    const { attempt, token } = tokenOf(lastDeliveredBody(rig));
    const sha = "c0ffee0000000000000000000000000000000001";
    rig.store.reportAction({ actionId: commit, attempt, token, reporter: { beeId: "b1" }, kind: "result", outcome: "succeeded", outputs: { commitSha: sha } });
    assert.equal(action(rig, commit).status, "succeeded");
    // Land: released by the commit's success, resolves the commit ref, captures through the Cell owner, settles from the receipt.
    steps(rig, 1);
    const landed = action(rig, land);
    assert.equal(landed.status, "succeeded", JSON.stringify(landed.failure));
    assert.deepEqual(landed.resolvedInputs, { targetBranch: "main", commit: sha });
    assert.equal(rig.cell.captures.length, 1);
    assert.equal(rig.cell.captures[0]?.opId, `action-${land}-a1`);
    assert.equal(landed.result?.outputs.cellHead, sha);
    assert.equal(landed.result?.outputs.targetBranch, "main");
    assert.equal(landed.result?.outputs.resultSha, rig.cell.target[0]);
    assert.equal((landed.result?.receipt as { status: string }).status, "landed");
    assert.equal(landed.dispatch?.expectedHead, sha);
    // Archive: released by the landing receipt; runs through the lifecycle command queue; settles from the command.
    steps(rig, 1);
    assert.equal(action(rig, archive).status, "running");
    assert.equal(rig.store.getCommandByIdempotencyKey(`action:${archive}:a1`)?.verb, "archive");
    steps(rig, 2);
    assert.equal(action(rig, archive).status, "succeeded");
    assert.equal(rig.store.getBee("b1")?.lifecycle, "archived");
    assert.equal(action(rig, archive).result?.outputs.archivedAt, rig.store.getBee("b1")?.archivedAt);
    const queue = rig.store.getActionQueue("b1")!;
    assert.equal(queue.activeActionId, null);
    assert.deepEqual(queue.counts, { queued: 0, running: 0, waiting: 0, succeeded: 3, failed: 0, cancelled: 0 });
    // Duplicate enqueue under the same key: the original acceptance, no new work, the bee stays archived.
    const replay = ship(rig, "b1");
    assert.equal(replay.deduped, true);
    steps(rig, 2);
    assert.equal(rig.store.listActionsOf("b1").length, 3);
    assert.equal(rig.cell.captures.length, 1);
    // Views carry exactly the locked keys and a populated hold/controls pair.
    for (const view of rig.store.listActionViews({ beeId: "b1" })) assert.deepEqual(Object.keys(view).sort(), [...MIRROR_ACTION_KEYS].sort());
    // The audit stream re-emitted successors whenever their derived hold changed (mirror needs no derivation).
    const puts = rig.store.auditTail(0, 10_000, "b1").filter((r) => r.kind === "action.put");
    assert.ok(puts.some((r) => (r.payload.action as { id: string }).id === land && (r.payload.action as { hold: unknown }).hold === null && r.payload.reason === "succeeded"));
  } finally {
    rig.cleanup();
  }
});

test("actions.loop.holds: a conflict holds Archive (retry after the fix lands); a question holds Land + Archive until answered; a failed commit holds everything", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "b2");
    const { actions } = ship(rig, "b2");
    const [commit, land, archive] = actions.map((a) => a.id) as [string, string, string];
    steps(rig, 1);
    const t1 = tokenOf(lastDeliveredBody(rig));
    // Question during Commit: the attempt waits for input; Land and Archive stay queued behind it.
    const asked = rig.store.reportAction({ actionId: commit, attempt: t1.attempt, token: t1.token, reporter: { beeId: "b2" }, kind: "question", question: { text: "include the fixture file?" } });
    steps(rig, 3);
    assert.equal(action(rig, commit).status, "waiting");
    assert.equal(action(rig, commit).waitingReason, "input");
    assert.equal(action(rig, land).status, "queued");
    assert.deepEqual(rig.store.actionView(land).hold, { reason: "predecessor_active", actionId: commit, actionStatus: "waiting" });
    assert.equal(rig.cell.captures.length, 0);
    rig.store.answerQuestion(asked.question!.id, "yes");
    steps(rig, 2);
    assert.equal(action(rig, commit).status, "running");
    assert.ok(lastDeliveredBody(rig).includes("[answer to question"), "the answer reached the bee as ordinary mail");
    rig.store.reportAction({ actionId: commit, attempt: t1.attempt, token: t1.token, reporter: { beeId: "b2" }, kind: "result", outcome: "succeeded", outputs: { commitSha: rig.cell.head! } });
    // Conflict on Land: typed failure with the receipt; Archive is held (predecessor_failed), never released.
    rig.cell.conflict = ["src/app.ts"];
    steps(rig, 1);
    const conflicted = action(rig, land);
    assert.equal(conflicted.status, "failed");
    assert.equal(conflicted.failure?.code, "conflict");
    assert.match(conflicted.failure?.detail ?? "", /src\/app\.ts/);
    assert.equal((conflicted.result?.receipt as { status: string }).status, "conflict");
    steps(rig, 3);
    assert.equal(action(rig, archive).status, "queued");
    assert.deepEqual(rig.store.actionView(archive).hold, { reason: "predecessor_failed", actionId: land, actionStatus: "failed" });
    assert.equal(rig.store.getBee("b2")?.lifecycle, "active");
    // Operator retries Land (a new attempt) after resolving: it lands, then Archive follows.
    rig.store.retryAction(land);
    steps(rig, 1);
    assert.equal(action(rig, land).status, "succeeded");
    assert.equal(action(rig, land).attempt, 2);
    assert.equal(rig.cell.captures.at(-1)?.opId, `action-${land}-a2`);
    steps(rig, 3);
    assert.equal(action(rig, archive).status, "succeeded");
    assert.equal(rig.store.getBee("b2")?.lifecycle, "archived");
    // A commit that fails holds the rest of a fresh sequence.
    rig.store.unarchiveBee("b2");
    const second = ship(rig, "b2", "ship-2");
    steps(rig, 2);
    const c2 = second.actions[0]!.id;
    const t2 = tokenOf(lastDeliveredBody(rig));
    rig.store.reportAction({ actionId: c2, attempt: t2.attempt, token: t2.token, reporter: { beeId: "b2" }, kind: "result", outcome: "failed", failure: { code: "tests_red", detail: "3 failing" } });
    steps(rig, 3);
    assert.equal(action(rig, second.actions[1]!.id).status, "queued");
    assert.equal(action(rig, second.actions[2]!.id).status, "queued");
    assert.equal(rig.cell.captures.length, 2, "no capture for the failed commit's sequence");
  } finally {
    rig.cleanup();
  }
});

test("actions.loop.preconditions: Land revalidates the Cell HEAD against the intended commit and the bee's placement before any effect", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "b3");
    const { actions } = ship(rig, "b3");
    const [commit, land] = actions.map((a) => a.id) as [string, string, string];
    steps(rig, 1);
    const t = tokenOf(lastDeliveredBody(rig));
    rig.store.reportAction({ actionId: commit, attempt: t.attempt, token: t.token, reporter: { beeId: "b3" }, kind: "result", outcome: "succeeded", outputs: { commitSha: rig.cell.head! } });
    // The work moved after the commit: the HEAD no longer matches the intended commit → typed failure, no capture.
    rig.cell.head = "aaaa0000000000000000000000000000000000002";
    steps(rig, 1);
    assert.equal(action(rig, land).status, "failed");
    assert.equal(action(rig, land).failure?.code, "precondition_failed");
    assert.equal(rig.cell.captures.length, 0);
    // A bee that is no longer on a Cell cannot land through cell.capture (typed, not retryable).
    const other = rig.store.createBee({ id: "h1", name: "h1", agent: "claude", substrate: "hsr", cwd: "/tmp" }).bee;
    const items = [{ kind: "land", version: null, inputs: { targetBranch: "main" }, clientRef: null, title: null }];
    const l2 = rig.store.enqueueActions({ beeId: other.id, idempotencyKey: "hsr-land", requestHash: hashActionEnqueueRequest({ beeId: other.id, items }), items }).actions[0]!.id;
    steps(rig, 1);
    assert.equal(action(rig, l2).status, "failed");
    assert.equal(action(rig, l2).failure?.code, "placement_changed");
    assert.equal(action(rig, l2).failure?.retryable, false);
    // A busy Cell (in-flight Cell op) holds the capture as waiting/executor and proceeds once free.
    rig.store.retryAction(land);
    rig.cell.head = "c0ffee0000000000000000000000000000000001";
    rig.cell.busy = true;
    steps(rig, 2);
    assert.equal(action(rig, land).status, "waiting");
    assert.equal(action(rig, land).waitingReason, "executor");
    rig.cell.busy = false;
    steps(rig, 1);
    assert.equal(action(rig, land).status, "succeeded");
  } finally {
    rig.cleanup();
  }
});

test("actions.loop.restart: progress survives daemon restarts at every stage; a lost capture receipt is reconciled through the probe, never repeated blindly", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "b4");
    const { actions } = ship(rig, "b4");
    const [commit, land, archive] = actions.map((a) => a.id) as [string, string, string];
    // Restart before dispatch: the accepted sequence is intact and dispatches on the new daemon.
    rig.restart();
    steps(rig, 2);
    assert.equal(action(rig, commit).status, "running");
    // The new daemon's driver has no process for gen 1 (fake rig) — the mail waits for the revived generation.
    steps(rig, 3);
    const body = lastDeliveredBody(rig);
    const t = tokenOf(body);
    assert.equal(action(rig, commit).dispatch?.deliveredAt != null, true);
    // Restart after delivery, before the report: still running; the report with the same token completes it.
    rig.restart();
    steps(rig, 1);
    assert.equal(action(rig, commit).status, "running");
    rig.store.reportAction({ actionId: commit, attempt: t.attempt, token: t.token, reporter: { beeId: "b4" }, kind: "result", outcome: "succeeded", outputs: { commitSha: rig.cell.head! } });
    // Crash mid-capture: the ref advanced but the receipt was lost. Boot marks the attempt uncertain;
    // reconciliation asks the Cell owner and settles succeeded(reconciled) — no second capture.
    rig.cell.crashAfterEffect = true;
    steps(rig, 1);
    assert.equal(action(rig, land).status, "failed", "a throw from the executor after the effect is a typed failure in-process");
    assert.equal(action(rig, land).failure?.code, "capture_error");
    // Model the crash instead: reopen the attempt as `running` exactly as a dead daemon leaves it.
    rig.store.retryAction(land);
    rig.cell.target = ["ba5e0000000000000000000000000000000000000"];
    const begun = rig.store.beginCellCaptureAttempt(land, { expectedHead: rig.cell.head });
    assert.equal(begun.action.status, "running");
    rig.cell.target = [`4e4e${rig.cell.head!.slice(4)}`, rig.cell.head!, ...rig.cell.target];
    const capturesBefore = rig.cell.captures.length;
    rig.restart();
    assert.equal(action(rig, land).status, "waiting");
    assert.equal(action(rig, land).waitingReason, "uncertain");
    assert.equal(rig.store.getActionQueue("b4")!.activeActionId, land);
    assert.equal(action(rig, archive).status, "queued", "Archive holds while the outcome is uncertain");
    steps(rig, 1);
    const reconciled = action(rig, land);
    assert.equal(reconciled.status, "succeeded");
    assert.equal(reconciled.result?.reconciled, true);
    assert.equal(reconciled.result?.outputs.resultSha, rig.cell.target[0]);
    assert.equal(rig.cell.captures.length, capturesBefore, "no repeated capture");
    // Restart during the archive command: the command replays, the action settles on the new daemon.
    steps(rig, 1);
    assert.equal(action(rig, archive).status, "running");
    rig.restart();
    steps(rig, 3);
    assert.equal(action(rig, archive).status, "succeeded");
    assert.equal(rig.store.getBee("b4")?.lifecycle, "archived");
    // The other branch of recovery: uncertain but NOT landed → the same attempt re-runs after re-checking HEAD.
    rig.store.unarchiveBee("b4");
    const items = [{ kind: "land", version: null, inputs: { targetBranch: "main" }, clientRef: null, title: null }];
    rig.cell.head = "d00d0000000000000000000000000000000000003";
    const l3 = rig.store.enqueueActions({ beeId: "b4", idempotencyKey: "l3", requestHash: hashActionEnqueueRequest({ beeId: "b4", items }), items }).actions[0]!.id;
    rig.store.beginCellCaptureAttempt(l3, { expectedHead: rig.cell.head });
    rig.restart();
    assert.equal(action(rig, l3).waitingReason, "uncertain");
    steps(rig, 1);
    assert.equal(action(rig, l3).status, "succeeded");
    assert.equal(action(rig, l3).attempt, 1, "same attempt, re-executed");
    assert.equal(rig.cell.captures.at(-1)?.opId, `action-${l3}-a1`);
  } finally {
    rig.cleanup();
  }
});

test("actions.loop.controls: pause stops releases without interrupting work; cancel withdraws undelivered instructions; concurrent appends order; invalid reorder refuses; stale reports never advance", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "b5");
    rig.store.pauseActionQueue("b5");
    const { actions } = ship(rig, "b5");
    const [commit, land, archive] = actions.map((a) => a.id) as [string, string, string];
    steps(rig, 3);
    assert.equal(action(rig, commit).status, "queued", "paused: nothing released");
    assert.deepEqual(rig.store.actionView(commit).hold, { reason: "paused", actionId: null, actionStatus: null });
    rig.store.resumeActionQueue("b5");
    steps(rig, 1);
    assert.equal(action(rig, commit).status, "running");
    // Pausing now does not touch the running attempt; it only holds the successors.
    rig.store.pauseActionQueue("b5");
    const t = tokenOf(lastDeliveredBody(rig));
    rig.store.reportAction({ actionId: commit, attempt: t.attempt, token: t.token, reporter: { beeId: "b5" }, kind: "result", outcome: "succeeded", outputs: { commitSha: rig.cell.head! } });
    steps(rig, 3);
    assert.equal(action(rig, commit).status, "succeeded");
    assert.equal(action(rig, land).status, "queued");
    assert.equal(rig.cell.captures.length, 0);
    // Concurrent appends from two clients interleave deterministically by commit order.
    const a = rig.store.enqueueActions({ beeId: "b5", idempotencyKey: "cli-a", requestHash: "ha", items: [{ kind: "fix", inputs: { instruction: "a" } }] }).actions[0]!;
    const b = rig.store.enqueueActions({ beeId: "b5", idempotencyKey: "cli-b", requestHash: "hb", items: [{ kind: "fix", inputs: { instruction: "b" } }] }).actions[0]!;
    assert.deepEqual([a.position, b.position], [4, 5]);
    // Reorder: land must stay after its ref target (already succeeded, so free), but the fixes may move ahead of archive; putting land after archive is fine too — the refusal is for FORWARD refs and wrong id sets.
    assert.throws(() => rig.store.reorderActions("b5", [a.id, b.id]), /exactly the 4 queued/);
    const c2 = rig.store.enqueueActions({ beeId: "b5", idempotencyKey: "c2", requestHash: "hc", items: [{ kind: "commit" }, { kind: "land", inputs: { targetBranch: "main", commit: { $ref: { item: 0, output: "commitSha" } } } }] }).actions;
    assert.throws(() => rig.store.reorderActions("b5", [c2[1]!.id, c2[0]!.id, land, archive, a.id, b.id]), /would run after it/);
    rig.store.reorderActions("b5", [a.id, land, archive, b.id, c2[0]!.id, c2[1]!.id]);
    assert.deepEqual(rig.store.listActionsOf("b5").filter((r) => r.status === "queued").map((r) => r.id), [a.id, land, archive, b.id, c2[0]!.id, c2[1]!.id]);
    // Cancel the queued fix `a`; cancel `b` too; resume → land runs next.
    rig.store.cancelAction(a.id);
    rig.store.cancelAction(b.id);
    rig.store.resumeActionQueue("b5");
    steps(rig, 1);
    assert.equal(action(rig, land).status, "succeeded");
    // The harness refuses deliveries from here (not_ready): the archive command still runs (no delivery involved).
    rig.driver.acceptDeliveries = false;
    steps(rig, 3);
    assert.equal(action(rig, archive).status, "succeeded");
    // The second commit dispatches (auto-unarchive via mail); cancel it while undelivered → the mail is withdrawn.
    steps(rig, 2);
    assert.equal(action(rig, c2[0]!.id).status, "running");
    const pending = action(rig, c2[0]!.id).dispatch!.messageId!;
    assert.equal(rig.store.getMessage(pending)?.deliveredAt, null);
    rig.store.cancelAction(c2[0]!.id);
    assert.equal(rig.store.getMessage(pending), null);
    rig.driver.acceptDeliveries = true;
    steps(rig, 2);
    assert.equal(action(rig, c2[1]!.id).status, "failed", "land's ref points at the cancelled commit");
    assert.equal(action(rig, c2[1]!.id).failure?.code, "input_unresolved");
    // A late report for the cancelled attempt is refused and changes nothing.
    assert.throws(() => rig.store.reportAction({ actionId: c2[0]!.id, attempt: 1, token: "0000000000", reporter: { beeId: "b5" }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } }));
    assert.equal(action(rig, c2[0]!.id).status, "cancelled");
  } finally {
    rig.cleanup();
  }
});

test("actions.loop.external: an external kind waits for its executor (no fake progress); a claim + report settles it; an unavailable internal executor waits too", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "b6");
    const items = [
      { kind: "name_branch", version: null, inputs: {}, clientRef: null, title: null },
      { kind: "open_pr", version: null, inputs: { branch: { $ref: { item: 0, output: "branch" } }, base: "main" }, clientRef: null, title: null },
    ];
    const [nb, pr] = rig.store.enqueueActions({ beeId: "b6", idempotencyKey: "pr", requestHash: hashActionEnqueueRequest({ beeId: "b6", items }), items }).actions.map((a) => a.id) as [string, string];
    steps(rig, 1);
    const t = tokenOf(lastDeliveredBody(rig));
    rig.store.reportAction({ actionId: nb, attempt: t.attempt, token: t.token, reporter: { beeId: "b6" }, kind: "result", outcome: "succeeded", outputs: { branch: "feat/queue" } });
    steps(rig, 3);
    const offered = action(rig, pr);
    assert.equal(offered.status, "waiting");
    assert.equal(offered.waitingReason, "executor");
    assert.deepEqual(offered.resolvedInputs, { branch: "feat/queue", base: "main" });
    const claim = rig.store.claimAction({ executor: "apiary", kinds: ["open_pr"] })!;
    assert.equal(claim.action.status, "running");
    steps(rig, 2);
    assert.equal(action(rig, pr).status, "running", "the scheduler leaves a claimed attempt alone");
    rig.store.reportAction({ actionId: pr, attempt: 1, token: claim.token, reporter: { executor: "apiary" }, kind: "result", outcome: "succeeded", outputs: { prUrl: "https://github.com/x/y/pull/7", prNumber: 7 }, receipt: { id: 7 } });
    assert.equal(action(rig, pr).status, "succeeded");
    // Internal executor missing on this daemon: land waits with reason executor and proceeds after a restart that has it.
    rig.restart({ cellCaptureExecutor: undefined });
    const landItems = [{ kind: "land", version: null, inputs: { targetBranch: "main" }, clientRef: null, title: null }];
    const land = rig.store.enqueueActions({ beeId: "b6", idempotencyKey: "land", requestHash: hashActionEnqueueRequest({ beeId: "b6", items: landItems }), items: landItems }).actions[0]!.id;
    steps(rig, 2);
    assert.equal(action(rig, land).status, "waiting");
    assert.equal(action(rig, land).waitingReason, "executor");
    assert.equal(action(rig, land).attempt, 0, "no attempt was spent while waiting");
    rig.restart();
    steps(rig, 1);
    assert.equal(action(rig, land).status, "succeeded");
    assert.equal(action(rig, land).attempt, 1);
  } finally {
    rig.cleanup();
  }
});

const MIN = 60_000;

function nudgeMails(rig: Rig, beeId: string): number[] {
  return rig.store.auditTail(0, 100_000, beeId)
    .filter((r) => r.kind === "mail.enqueued" && r.payload.origin === "action.nudge")
    .map((r) => (r.payload.message as { id: number }).id);
}

function enqueueOne(rig: Rig, beeId: string, kind: string, key: string, inputs: Record<string, unknown> = {}) {
  const items = [{ kind, version: null, inputs, clientRef: null, title: null }];
  return rig.store.enqueueActions({ beeId, idempotencyKey: key, requestHash: hashActionEnqueueRequest({ beeId, items }), items }).actions[0]!;
}

test("actions.loop.nudge: one idle reminder per silent commit attempt after 30 min — not before, reset by progress, never mid-turn, never again after restart, again for a retry", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "n1");
    const { actions } = ship(rig, "n1");
    const [commit, land] = actions.map((a) => a.id) as [string, string];
    steps(rig, 1);
    const delivered = action(rig, commit);
    assert.equal(delivered.status, "running");
    assert.ok(delivered.dispatch?.deliveredAt != null, "instruction delivered");
    const { attempt, token } = tokenOf(lastDeliveredBody(rig));
    // 29 minutes of silence: not yet.
    rig.clock.now = delivered.dispatch!.deliveredAt! + 29 * MIN;
    steps(rig, 3);
    assert.equal(nudgeMails(rig, "n1").length, 0);
    // Progress is a sign of life: the 30 minutes restart from it.
    rig.store.reportAction({ actionId: commit, attempt, token, reporter: { beeId: "n1" }, kind: "progress", note: "still staging" });
    const progressAt = action(rig, commit).progress!.at;
    rig.clock.now = progressAt + 29 * MIN;
    steps(rig, 3);
    assert.equal(nudgeMails(rig, "n1").length, 0, "progress reset the clock");
    // The bee is mid-turn when the reminder falls due: it is queued (idle urgency), never an interrupt.
    startTurn(rig, "n1");
    rig.clock.now = progressAt + 30 * MIN;
    steps(rig, 1);
    const [nudgeId] = nudgeMails(rig, "n1");
    assert.ok(nudgeId !== undefined, "reminder mailed");
    assert.ok(rig.ops.some((op) => op.startsWith(`action.nudge bee=n1 action=${commit} attempt=1`)), rig.ops.join("\n"));
    const nudged = action(rig, commit);
    assert.equal(nudged.status, "running", "a reminder is never completion");
    assert.equal(typeof nudged.dispatch?.nudgedAt, "number");
    const mail = rig.store.getMessage(nudgeId!)!;
    assert.equal(mail.urgency, "idle");
    assert.equal(mail.deliveredAt, null, "not delivered mid-turn");
    assert.equal(rig.driver.interrupts.length, 0);
    assert.ok(mail.body.startsWith(`[Hive action] Reminder — Commit — action ${commit}, attempt 1`), mail.body);
    assert.ok(mail.body.includes(`hive action report ${commit} --attempt 1 --token ${token} --succeeded --output commitSha=<commitSha>`));
    assert.ok(rig.store.auditTail(0, 100_000, "n1").some((r) => r.kind === "action.put" && r.payload.reason === "nudged"));
    endTurn(rig, "n1");
    steps(rig, 2);
    assert.notEqual(rig.store.getMessage(nudgeId!)?.deliveredAt ?? null, null, "delivered once the runtime is idle");
    // Hours more of silence, then a daemon restart: still exactly one reminder for the attempt.
    rig.clock.now += 3 * 60 * MIN;
    steps(rig, 3);
    rig.restart();
    rig.clock.now += 3 * 60 * MIN;
    steps(rig, 3);
    assert.equal(nudgeMails(rig, "n1").length, 1, "exactly once per attempt across restarts");
    // A failed report then retry: attempt 2 is a new attempt and may be reminded again.
    rig.store.reportAction({ actionId: commit, attempt, token, reporter: { beeId: "n1" }, kind: "result", outcome: "failed", detail: "hooks failed" });
    rig.store.retryAction(commit);
    // The restarted fake driver revives the runtime first; the instruction waits for it.
    for (let i = 0; i < 20 && action(rig, commit).dispatch?.deliveredAt == null; i += 1) steps(rig, 1);
    const second = action(rig, commit);
    assert.equal(second.attempt, 2);
    assert.equal(second.dispatch?.nudgedAt, null);
    assert.ok(second.dispatch?.deliveredAt != null, "attempt 2 delivered");
    rig.clock.now = second.dispatch!.deliveredAt! + 30 * MIN;
    steps(rig, 1);
    assert.equal(nudgeMails(rig, "n1").length, 2);
    assert.ok(rig.store.getMessage(nudgeMails(rig, "n1")[1]!)!.body.includes(`attempt 2`));
    // The operator completes it (the agent never reports): downstream releases normally.
    const done = rig.store.completeAction(commit, { outputs: { commitSha: rig.cell.head! } });
    assert.equal(done.action.status, "succeeded");
    steps(rig, 1);
    assert.equal(action(rig, land).status, "succeeded", JSON.stringify(action(rig, land).failure));
  } finally {
    rig.cleanup();
  }
});

test("actions.loop.nudge-scope: no reminder for other kinds, after complete or cancel, or while waiting on a question; an answered question restarts the clock", () => {
  const rig = makeRig();
  try {
    spawnCellBee(rig, "n2");
    // A fix instruction: no threshold for the kind.
    const fix = enqueueOne(rig, "n2", "fix", "fix-1", { instruction: "lint" });
    steps(rig, 1);
    assert.ok(action(rig, fix.id).dispatch?.deliveredAt != null);
    rig.clock.now += 5 * 60 * MIN;
    steps(rig, 2);
    assert.equal(nudgeMails(rig, "n2").length, 0, "fix is never reminded");
    rig.store.cancelAction(fix.id, { force: true });
    // Completed by the operator right away: nothing to remind.
    const c1 = enqueueOne(rig, "n2", "commit", "c-1");
    steps(rig, 1);
    rig.store.completeAction(c1.id, { outputs: { commitSha: "abcdef1" } });
    rig.clock.now += 5 * 60 * MIN;
    steps(rig, 2);
    // Force-cancelled after delivery: nothing to remind.
    const c2 = enqueueOne(rig, "n2", "commit", "c-2");
    steps(rig, 1);
    rig.store.cancelAction(c2.id, { force: true });
    rig.clock.now += 5 * 60 * MIN;
    steps(rig, 2);
    assert.equal(nudgeMails(rig, "n2").length, 0);
    // Waiting on a question: no reminder while the operator owes the answer; the answer restarts the clock.
    const c3 = enqueueOne(rig, "n2", "commit", "c-3");
    steps(rig, 1);
    const t3 = tokenOf(lastDeliveredBody(rig));
    const asked = rig.store.reportAction({ actionId: c3.id, attempt: t3.attempt, token: t3.token, reporter: { beeId: "n2" }, kind: "question", question: { text: "amend?" } });
    rig.clock.now += 5 * 60 * MIN;
    steps(rig, 2);
    assert.equal(nudgeMails(rig, "n2").length, 0, "waiting/input is not silence");
    rig.store.answerQuestion(asked.question!.id, "no");
    const answeredAt = rig.store.getQuestion(asked.question!.id)!.answeredAt!;
    steps(rig, 2);
    assert.equal(action(rig, c3.id).status, "running");
    assert.equal(nudgeMails(rig, "n2").length, 0, "not reminded right after the answer");
    rig.clock.now = answeredAt + 30 * MIN;
    steps(rig, 1);
    assert.equal(nudgeMails(rig, "n2").length, 1);
  } finally {
    rig.cleanup();
  }
});
