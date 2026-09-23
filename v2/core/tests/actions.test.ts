/**
 * v24 action queue — store tier: acceptance (idempotency, ordering, refs),
 * agent dispatch through the mailbox, the authenticated report path (bee,
 * attempt, token; stale/duplicate/conflicting reports), question hold +
 * answer resume, controls (cancel/reorder/pause/resume/retry), archive +
 * external executor flows, attempt fencing for structured settles, audit
 * replay and reopen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ACTION_DISPATCH_MARKER,
  ACTION_DISPATCH_SENDER,
  ActionClaimedError,
  ActionKindUnknownError,
  ActionRefusedError,
  ActionReorderInvalidError,
  ActionStaleAttemptError,
  ActionUnauthorizedError,
  BeeNotFoundError,
  IdempotencyConflictError,
  MIRROR_ACTION_CONTROLS_KEYS,
  MIRROR_ACTION_DISPATCH_KEYS,
  MIRROR_ACTION_KEYS,
  MIRROR_ACTION_QUEUE_KEYS,
  ACTION_NUDGE_AFTER_MS,
  actionNudgeDueAt,
  SCHEMA_VERSION,
  hashActionEnqueueRequest,
  replayAudit,
  type ActionRow,
  type CoreStore,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

type Item = { kind: string; version?: number | null; inputs?: Record<string, unknown>; clientRef?: string | null; title?: string | null };

function enqueue(store: CoreStore, beeId: string, items: Item[], key = `k-${Math.random().toString(36).slice(2)}`) {
  const shaped = items.map((i) => ({ kind: i.kind, version: i.version ?? null, inputs: i.inputs ?? {}, clientRef: i.clientRef ?? null, title: i.title ?? null }));
  return store.enqueueActions({ beeId, idempotencyKey: key, requestHash: hashActionEnqueueRequest({ beeId, items: shaped }), items });
}

/** The commit → land → archive sequence with the land referring to the commit's sha. */
function shipSequence(store: CoreStore, beeId: string, key = "ship-1") {
  return enqueue(
    store,
    beeId,
    [
      { kind: "commit", inputs: { message: "ship it" }, clientRef: "palette-1" },
      { kind: "land", inputs: { targetBranch: "main", commit: { $ref: { item: 0, output: "commitSha" } } }, clientRef: "palette-2" },
      { kind: "archive", clientRef: "palette-3" },
    ],
    key,
  );
}

/** Pull the attempt token out of the delivered instruction body (what the agent sees). */
function tokenOf(body: string): { attempt: number; token: string } {
  const m = /--attempt (\d+) --token ([0-9a-f]+)/.exec(body);
  if (!m) throw new Error(`no token in body: ${body}`);
  return { attempt: Number(m[1]), token: m[2] as string };
}

function liveBee(store: CoreStore, name = "worker") {
  const { bee } = makeBee(store, name);
  bootToRunning(store, bee.id, 4242, 1);
  return bee;
}

function mustAction(store: CoreStore, id: string): ActionRow {
  const row = store.getAction(id);
  if (!row) throw new Error(`action ${id} missing`);
  return row;
}

test("actions.1: a sequence is accepted in order with item refs rewritten; the same key replays, a different request under the key conflicts", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const first = shipSequence(store, bee.id);
    assert.equal(first.deduped, false);
    assert.deepEqual(first.actions.map((a) => [a.kind, a.position, a.status, a.executor]), [
      ["commit", 1, "queued", "agent"],
      ["land", 2, "queued", "cell.capture"],
      ["archive", 3, "queued", "lifecycle.archive"],
    ]);
    const land = first.actions[1]!;
    assert.deepEqual(land.inputs.commit, { $ref: { action: first.actions[0]!.id, output: "commitSha" } });
    assert.equal(land.definition.kind, "land");
    assert.equal(land.definitionVersion, 1);
    const replay = shipSequence(store, bee.id);
    assert.equal(replay.deduped, true);
    assert.deepEqual(replay.actions.map((a) => a.id), first.actions.map((a) => a.id));
    assert.equal(store.listActionsOf(bee.id).length, 3, "the replay appended nothing");
    assert.throws(() => enqueue(store, bee.id, [{ kind: "commit" }], "ship-1"), IdempotencyConflictError);
    // Typed refusals leave the lane untouched.
    assert.throws(() => enqueue(store, bee.id, [{ kind: "teleport" }]), ActionKindUnknownError);
    assert.throws(() => enqueue(store, bee.id, [{ kind: "commit", version: 9 }]), ActionKindUnknownError);
    assert.throws(() => enqueue(store, bee.id, [{ kind: "land", inputs: { targetBranch: "main", commit: { $ref: { item: 1, output: "commitSha" } } } }, { kind: "commit" }]), /not earlier in the request/);
    assert.throws(() => enqueue(store, bee.id, [{ kind: "land" }]), /requires input 'targetBranch'/);
    assert.throws(() => enqueue(store, bee.id, [{ kind: "commit", inputs: { urgency: "soon" } }]), /unknown urgency/);
    assert.equal(store.listActionsOf(bee.id).length, 3);
    // Views: hold is derived per lane; the head has no hold, successors wait on their predecessor.
    const views = store.listActionViews({ beeId: bee.id });
    assert.equal(views[0]!.hold, null);
    assert.deepEqual(views[1]!.hold, { reason: "predecessor_active", actionId: views[0]!.id, actionStatus: "queued" });
    assert.deepEqual(Object.keys(views[0]!).sort(), [...MIRROR_ACTION_KEYS].sort());
    assert.equal("attemptToken" in views[0]!, false, "the token never reaches a view");
    const queue = store.getActionQueue(bee.id)!;
    assert.deepEqual(Object.keys(store.listActionQueueViews()[0]!).sort(), [...MIRROR_ACTION_QUEUE_KEYS].sort());
    assert.equal(queue.counts.queued, 3);
    assert.equal(queue.activeActionId, null);
    // Concurrent appends: positions continue from the queue cursor in commit order.
    const later = enqueue(store, bee.id, [{ kind: "fix", inputs: { instruction: "lint" } }]);
    assert.equal(later.actions[0]!.position, 4);
    const { bee: other } = makeBee(store, "other");
    assert.equal(enqueue(store, other.id, [{ kind: "commit" }]).actions[0]!.position, 1, "positions are per bee");
  } finally {
    h.cleanup();
  }
});

test("actions.2: agent dispatch rides the mailbox; delivery is evidence, the authenticated report completes; stale/duplicate/foreign reports are harmless", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    const other = liveBee(store, "other");
    const { actions } = shipSequence(store, bee.id);
    const commit = actions[0]!;
    const dispatched = store.dispatchAgentAction(commit.id);
    assert.equal(dispatched.action.status, "running");
    assert.equal(dispatched.action.attempt, 1);
    const msg = store.getMessage(dispatched.messageId!)!;
    assert.equal(msg.sender, ACTION_DISPATCH_SENDER);
    assert.equal(msg.urgency, "next");
    assert.ok(msg.body.startsWith(ACTION_DISPATCH_MARKER));
    assert.ok(msg.body.includes(`hive action report ${commit.id} --attempt 1 --token`));
    assert.ok(msg.body.includes("--output commitSha=<commitSha>"));
    assert.ok(msg.body.includes("Suggested commit message: ship it"));
    const enqueued = store.auditTail(0, 1000, bee.id).find((r) => r.kind === "mail.enqueued" && (r.payload.message as { id: number }).id === msg.id);
    assert.equal(enqueued?.payload.origin, "action.dispatch");
    // Delivered ≠ done: the action stays running with delivery evidence.
    store.markDelivered(msg.id, 1);
    let row = mustAction(store, commit.id);
    assert.equal(row.status, "running");
    assert.equal(row.dispatch?.deliveredAt != null, true);
    assert.equal(row.dispatch?.deliveredGeneration, 1);
    const { attempt, token } = tokenOf(msg.body);
    // Wrong bee, wrong token, unknown attempt: refused, nothing changes.
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: other.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abc1234" } }), ActionUnauthorizedError);
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt, token: "deadbeef", reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abc1234" } }), ActionUnauthorizedError);
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt: 2, token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abc1234" } }), ActionRefusedError);
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt, token, reporter: {}, kind: "result", outcome: "succeeded", outputs: { commitSha: "abc1234" } }), ActionUnauthorizedError);
    // Output validation is typed and leaves the action running.
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: {} }), /output 'commitSha' is required/);
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "not a sha" } }), /does not match/);
    assert.equal(mustAction(store, commit.id).status, "running");
    const progress = store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "progress", note: "staging" });
    assert.equal(progress.applied, true);
    assert.equal(progress.action.progress?.note, "staging");
    const done = store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "0123456789abcdef0123456789abcdef01234567", branch: "feat/x" } });
    assert.equal(done.action.status, "succeeded");
    assert.equal(done.action.result?.outputs.commitSha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(done.action.finishedAt != null, true);
    // Duplicate result: harmless. Conflicting result: refused. Late progress: quiet.
    const dup = store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "0123456789abcdef0123456789abcdef01234567" } });
    assert.equal(dup.deduped, true);
    assert.equal(dup.applied, false);
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "result", outcome: "failed", detail: "changed my mind" }), ActionRefusedError);
    assert.equal(store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "progress", note: "late" }).applied, false);
    assert.equal(mustAction(store, commit.id).status, "succeeded");
    // The successor's hold lifted; the queue's counts follow.
    const views = store.listActionViews({ beeId: bee.id });
    assert.equal(views[1]!.hold, null);
    assert.equal(store.getActionQueue(bee.id)!.counts.succeeded, 1);
    // Rejected reports are audited as informational rows.
    assert.ok(store.auditTail(0, 1000, bee.id).some((r) => r.kind === "action.report_rejected" && r.payload.reason === "unauthorized"));
  } finally {
    h.cleanup();
  }
});

test("actions.3: a question holds the attempt (waiting/input) until question.answer resumes it; the answer is ordinary mail", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    const { actions } = shipSequence(store, bee.id);
    const commit = actions[0]!;
    const { messageId } = store.dispatchAgentAction(commit.id);
    store.markDelivered(messageId!, 1);
    const { attempt, token } = tokenOf(store.getMessage(messageId!)!.body);
    const asked = store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "question", question: { text: "squash or keep history?", options: ["squash", "keep"] } });
    assert.equal(asked.action.status, "waiting");
    assert.equal(asked.action.waitingReason, "input");
    assert.equal(asked.question?.status, "open");
    assert.equal(asked.action.questionId, asked.question?.id);
    // Downstream stays held on the waiting predecessor.
    assert.deepEqual(store.listActionViews({ beeId: bee.id })[1]!.hold, { reason: "predecessor_active", actionId: commit.id, actionStatus: "waiting" });
    // Asking again is a quiet duplicate while the question is open.
    assert.equal(store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "question", question: { text: "squash or keep history?" } }).deduped, true);
    const answered = store.answerQuestion(asked.question!.id, "squash");
    assert.equal(answered.send.message.body.startsWith(`[answer to question ${asked.question!.id}] squash`), true);
    const resumed = mustAction(store, commit.id);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.attempt, attempt, "same attempt; the token still works");
    const done = store.reportAction({ actionId: commit.id, attempt, token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } });
    assert.equal(done.action.status, "succeeded");
  } finally {
    h.cleanup();
  }
});

test("actions.4: controls — cancel (pending / undelivered / force), reorder validity, pause/resume, retry as a new attempt with a rotated token", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    const { actions } = shipSequence(store, bee.id);
    const [commit, land, archive] = actions as [ActionRow, ActionRow, ActionRow];
    const fix = enqueue(store, bee.id, [{ kind: "fix", inputs: { instruction: "lint" } }]).actions[0]!;
    // Reorder: exactly the queued ids, and land must stay after commit (its $ref target).
    assert.throws(() => store.reorderActions(bee.id, [land.id, commit.id, archive.id, fix.id]), ActionReorderInvalidError);
    assert.throws(() => store.reorderActions(bee.id, [commit.id, land.id]), ActionReorderInvalidError);
    assert.throws(() => store.reorderActions(bee.id, [commit.id, land.id, archive.id, archive.id]), ActionReorderInvalidError);
    const reordered = store.reorderActions(bee.id, [commit.id, fix.id, land.id, archive.id]);
    assert.deepEqual(reordered.actions.map((a) => [a.id, a.position]), [[commit.id, 1], [fix.id, 2], [land.id, 3], [archive.id, 4]]);
    // Pause blocks releases (derived hold), not the API.
    assert.equal(store.pauseActionQueue(bee.id).applied, true);
    assert.equal(store.pauseActionQueue(bee.id).applied, false);
    assert.deepEqual(store.actionView(commit.id).hold, { reason: "paused", actionId: null, actionStatus: null });
    assert.equal(store.resumeActionQueue(bee.id).applied, true);
    assert.equal(store.actionView(commit.id).hold, null);
    // Cancel pending: cancelled rows drop out of the predecessor chain.
    assert.equal(store.cancelAction(fix.id).applied, true);
    assert.equal(mustAction(store, fix.id).status, "cancelled");
    assert.equal(store.cancelAction(fix.id).applied, false, "terminal cancel is a quiet no-op");
    assert.deepEqual(store.actionView(land.id).hold, { reason: "predecessor_active", actionId: commit.id, actionStatus: "queued" });
    // Cancel a running agent action before delivery: the instruction is withdrawn from the mailbox.
    const { messageId } = store.dispatchAgentAction(commit.id);
    assert.equal(store.actionView(commit.id).controls.cancel, true);
    assert.equal(store.cancelAction(commit.id).applied, true);
    assert.equal(store.getMessage(messageId!), null, "undelivered instruction withdrawn");
    assert.equal(mustAction(store, commit.id).attempts[0]?.outcome, "cancelled");
    assert.equal(mustAction(store, commit.id).attemptToken, null);
    // Retry is only for failed / (force) uncertain.
    assert.throws(() => store.retryAction(commit.id), ActionRefusedError);
    // A second commit: delivered, then force-cancelled; its late report is refused but harmless.
    const c2 = enqueue(store, bee.id, [{ kind: "commit" }]).actions[0]!;
    store.reorderActions(bee.id, [c2.id, land.id, archive.id]);
    const d2 = store.dispatchAgentAction(c2.id);
    store.markDelivered(d2.messageId!, 1);
    assert.equal(store.actionView(c2.id).controls.cancel, false);
    assert.equal(store.actionView(c2.id).controls.forceCancel, true);
    assert.throws(() => store.cancelAction(c2.id), ActionRefusedError);
    assert.equal(store.cancelAction(c2.id, { force: true }).applied, true);
    const late = tokenOf(store.getMessage(d2.messageId!)!.body);
    assert.throws(() => store.reportAction({ actionId: c2.id, attempt: late.attempt, token: late.token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } }), ActionUnauthorizedError);
    assert.equal(mustAction(store, c2.id).status, "cancelled");
    // Fail then retry: attempt 2, fresh token; attempt-1 results are stale.
    const c3 = enqueue(store, bee.id, [{ kind: "commit" }]).actions[0]!;
    store.reorderActions(bee.id, [c3.id, land.id, archive.id]);
    const d3 = store.dispatchAgentAction(c3.id);
    store.markDelivered(d3.messageId!, 1);
    const t1 = tokenOf(store.getMessage(d3.messageId!)!.body);
    const failed = store.reportAction({ actionId: c3.id, attempt: t1.attempt, token: t1.token, reporter: { beeId: bee.id }, kind: "result", outcome: "failed", failure: { code: "nothing_to_commit", detail: "tree clean" } });
    assert.equal(failed.action.status, "failed");
    assert.equal(failed.action.failure?.code, "nothing_to_commit");
    assert.deepEqual(store.actionView(land.id).hold, { reason: "predecessor_failed", actionId: c3.id, actionStatus: "failed" });
    assert.equal(store.actionView(c3.id).controls.retry, true);
    const retried = store.retryAction(c3.id);
    assert.equal(retried.action.status, "queued");
    assert.equal(retried.action.attempt, 1, "attempt advances at dispatch, not at retry");
    assert.equal(retried.action.attempts.length, 1);
    assert.equal(retried.action.attempts[0]?.outcome, "failed");
    const d4 = store.dispatchAgentAction(c3.id);
    store.markDelivered(d4.messageId!, 1);
    const t2 = tokenOf(store.getMessage(d4.messageId!)!.body);
    assert.equal(t2.attempt, 2);
    assert.notEqual(t2.token, t1.token);
    assert.throws(() => store.reportAction({ actionId: c3.id, attempt: t1.attempt, token: t1.token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } }), ActionStaleAttemptError);
    assert.equal(mustAction(store, c3.id).status, "running", "the stale attempt-1 report did not complete attempt 2");
    assert.equal(store.reportAction({ actionId: c3.id, attempt: 2, token: t2.token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } }).action.status, "succeeded");
    assert.equal(store.getActionQueue(bee.id)!.counts.cancelled, 3);
  } finally {
    h.cleanup();
  }
});

test("actions.5: mail.cancel of an undelivered dispatch fails the attempt (typed, retryable); an unresolvable $ref fails at dispatch", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    const { actions } = shipSequence(store, bee.id);
    const [commit, land] = actions as [ActionRow, ActionRow];
    const { messageId } = store.dispatchAgentAction(commit.id);
    assert.equal(store.cancelMessage(bee.id, messageId!).canceled, true);
    const row = mustAction(store, commit.id);
    assert.equal(row.status, "failed");
    assert.equal(row.failure?.code, "dispatch_cancelled");
    assert.equal(row.failure?.retryable, true);
    // A failed action is terminal for cancel (retry is the control); land's ref points at a non-succeeded action → typed failure at its dispatch.
    assert.equal(store.cancelAction(commit.id).applied, false);
    assert.equal(store.actionView(commit.id).controls.retry, true);
    const begun = store.beginCellCaptureAttempt(land.id, { expectedHead: "abc" });
    assert.equal(begun.resolved, null);
    assert.equal(begun.action.status, "failed");
    assert.equal(begun.action.failure?.code, "input_unresolved");
    assert.match(begun.action.failure?.detail ?? "", /not_succeeded/);
  } finally {
    h.cleanup();
  }
});

test("actions.6: lifecycle.archive dispatches the bee's archive command under the attempt key and settles from the command; already-archived succeeds immediately", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const archive = enqueue(store, bee.id, [{ kind: "archive" }]).actions[0]!;
    const dispatched = store.dispatchArchiveAction(archive.id);
    assert.equal(dispatched.action.status, "running");
    const cmd = store.getCommand(dispatched.commandId!)!;
    assert.equal(cmd.verb, "archive");
    assert.equal(cmd.idempotencyKey, `action:${archive.id}:a1`);
    assert.equal(store.reconcileArchiveAction(archive.id).settled, false, "still queued");
    // The executor runs the command (as the daemon loop would).
    const claimed = store.claimNextCommand()!;
    assert.equal(claimed.id, cmd.id);
    store.archiveBee(bee.id);
    store.completeCommand(cmd.id);
    const settled = store.reconcileArchiveAction(archive.id);
    assert.equal(settled.settled, true);
    assert.equal(settled.action.status, "succeeded");
    assert.equal(settled.action.result?.outputs.archivedAt, store.getBee(bee.id)!.archivedAt);
    assert.equal((settled.action.result?.receipt as { commandId: number }).commandId, cmd.id);
    // A second archive on an archived bee needs no command.
    const again = enqueue(store, bee.id, [{ kind: "archive" }]).actions[0]!;
    const immediate = store.dispatchArchiveAction(again.id);
    assert.equal(immediate.commandId, null);
    assert.equal(immediate.action.status, "succeeded");
    assert.deepEqual(immediate.action.result?.receipt, { alreadyArchived: true });
    // Structured settles are attempt-fenced: a stale settle is a recorded no-op.
    assert.equal(store.settleAction(archive.id, 1, { kind: "failed", code: "late", detail: "late", retryable: true }).applied, false);
    assert.equal(mustAction(store, archive.id).status, "succeeded");
  } finally {
    h.cleanup();
  }
});

test("actions.7: external kinds wait for an executor; claim is idempotent per executor and exclusive across executors; the claimant reports with its token", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const pr = enqueue(store, bee.id, [{ kind: "open_pr", inputs: { branch: "feat/x", base: "main" } }]).actions[0]!;
    const held = store.holdActionForExecutor(pr.id, "no executor");
    assert.equal(held.action.status, "waiting");
    assert.equal(held.action.waitingReason, "executor");
    assert.equal(held.action.attempt, 1);
    assert.equal(store.actionView(pr.id).controls.cancel, true, "unclaimed offers cancel cleanly");
    assert.equal(store.claimAction({ executor: "apiary", kinds: ["push"] }), null, "kind filter");
    const claim = store.claimAction({ executor: "apiary", kinds: ["open_pr"] })!;
    assert.equal(claim.action.status, "running");
    assert.equal(claim.action.dispatch?.claimedBy, "apiary");
    assert.deepEqual(claim.resolvedInputs, { branch: "feat/x", base: "main" });
    assert.equal(store.claimAction({ executor: "apiary" })!.deduped, true);
    assert.throws(() => store.claimAction({ executor: "other", actionId: pr.id }), ActionClaimedError);
    assert.throws(() => store.reportAction({ actionId: pr.id, attempt: 1, token: claim.token, reporter: { executor: "other" }, kind: "result", outcome: "succeeded", outputs: { prUrl: "https://x/1" } }), ActionUnauthorizedError);
    // Uncertain → held; the same attempt reconciles later with the real receipt.
    const unsure = store.reportAction({ actionId: pr.id, attempt: 1, token: claim.token, reporter: { executor: "apiary" }, kind: "result", outcome: "uncertain", detail: "GitHub timed out" });
    assert.equal(unsure.action.status, "waiting");
    assert.equal(unsure.action.waitingReason, "uncertain");
    assert.equal(store.actionView(pr.id).controls.retry, false);
    assert.equal(store.actionView(pr.id).controls.forceRetry, true);
    const recovered = store.claimAction({ executor: "apiary", actionId: pr.id })!;
    assert.equal(recovered.token, claim.token);
    assert.equal(recovered.action.waitingReason, "uncertain");
    assert.throws(() => store.claimAction({ executor: "another", actionId: pr.id }), ActionClaimedError);
    assert.throws(() => store.retryAction(pr.id), ActionRefusedError);
    const reconciled = store.reportAction({ actionId: pr.id, attempt: 1, token: claim.token, reporter: { executor: "apiary" }, kind: "result", outcome: "succeeded", outputs: { prUrl: "https://x/1", prNumber: 1 }, receipt: { id: 1 } });
    assert.equal(reconciled.action.status, "succeeded");
    assert.equal(reconciled.action.result?.reconciled, true);
    // Force-retry of an uncertain attempt is a NEW attempt with a new token.
    const push = enqueue(store, bee.id, [{ kind: "push" }]).actions[0]!;
    store.holdActionForExecutor(push.id, "no executor");
    const pc = store.claimAction({ executor: "apiary", kinds: ["push"] })!;
    store.reportAction({ actionId: push.id, attempt: 1, token: pc.token, reporter: { executor: "apiary" }, kind: "result", outcome: "uncertain", detail: "?" });
    const retried = store.retryAction(push.id, { force: true });
    assert.equal(retried.action.status, "queued");
    assert.equal(retried.action.attempts[0]?.outcome, "superseded");
    store.holdActionForExecutor(push.id, "no executor");
    const pc2 = store.claimAction({ executor: "apiary", kinds: ["push"] })!;
    assert.equal(pc2.action.attempt, 2);
    assert.notEqual(pc2.token, pc.token);
    assert.throws(() => store.reportAction({ actionId: push.id, attempt: 1, token: pc.token, reporter: { executor: "apiary" }, kind: "result", outcome: "succeeded", outputs: {} }), ActionStaleAttemptError);
  } finally {
    h.cleanup();
  }
});

test("actions.8: audit replay reproduces the action tables; the store reopens at v24 with the lane intact; bee deletion cascades", () => {
  const h = harness();
  try {
    let store = h.open();
    assert.equal(SCHEMA_VERSION, 29);
    const bee = liveBee(store);
    const { actions } = shipSequence(store, bee.id);
    const { messageId } = store.dispatchAgentAction(actions[0]!.id);
    store.markDelivered(messageId!, 1);
    const t = tokenOf(store.getMessage(messageId!)!.body);
    store.reportAction({ actionId: actions[0]!.id, attempt: t.attempt, token: t.token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } });
    store.pauseActionQueue(bee.id);
    const dump = store.dumpState();
    assert.equal(dump.actions.length, 3);
    assert.equal(dump.actionQueues[0]?.paused, true);
    assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), dump);
    store.close();
    store = h.open();
    assert.deepEqual(store.dumpState().actions, dump.actions);
    assert.equal(store.getAction(actions[0]!.id)?.attemptToken, t.token, "the token survives reopen for late duplicate reports");
    const { bee: doomed } = makeBee(store, "doomed");
    enqueue(store, doomed.id, [{ kind: "commit" }], "doomed-1");
    store.deleteBee(doomed.id);
    assert.equal(store.listActions({ beeId: doomed.id }).length, 0);
    assert.equal(store.getActionQueue(doomed.id), null);
    assert.throws(() => enqueue(store, doomed.id, [{ kind: "commit" }], "doomed-1"), BeeNotFoundError, "a replayed key after delete is bee_not_found, not a phantom");
    assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
  } finally {
    h.cleanup();
  }
});


test("queued Land v2 holds Archive until the destination executor reports durable integration", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const destination = { nodeId: "workstation", root: "/repo", branch: "main" };
    const [land, archive] = enqueue(store, bee.id, [
      { kind: "land", version: 2, inputs: { destination } }, { kind: "archive" },
    ]).actions;
    assert.equal(land!.executor, "external");
    store.holdActionForExecutor(land!.id, "Waiting for Apiary");
    const claim = store.claimAction({ executor: "apiary:workstation", actionId: land!.id })!;
    assert.deepEqual(claim.resolvedInputs, { destination });
    assert.equal(store.actionView(archive!.id).hold?.actionId, land!.id);
    assert.equal(store.claimAction({ executor: "apiary:workstation", actionId: land!.id })!.token, claim.token);
    store.reportAction({ actionId: land!.id, attempt: claim.action.attempt, token: claim.token,
      reporter: { executor: "apiary:workstation" }, kind: "result", outcome: "succeeded",
      outputs: { resultSha: "a".repeat(40), cellHead: "b".repeat(40), targetBranch: "main" }, receipt: { entryId: "integrated-entry" } });
    assert.equal(store.actionView(archive!.id).hold, null);
    const legacy = enqueue(store, bee.id, [{ kind: "land", inputs: { targetBranch: "main" } }]).actions[0]!;
    assert.equal(legacy.definitionVersion, 1);
    assert.equal(legacy.executor, "cell.capture");
  } finally { h.cleanup(); }
});

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Dispatch the head agent action and deliver its instruction; returns the delivered token. */
function deliver(store: CoreStore, actionId: string): { attempt: number; token: string; messageId: number } {
  const { messageId } = store.dispatchAgentAction(actionId);
  store.markDelivered(messageId!, 1);
  return { ...tokenOf(store.getMessage(messageId!)!.body), messageId: messageId! };
}

test("actions.9: action.complete settles the open agent attempt as the operator; late reports dedupe or are refused; refusals are typed", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    const { actions } = shipSequence(store, bee.id);
    const [commit, land] = actions as [ActionRow, ActionRow];
    // Queued: not completable (the operator cancels or waits for dispatch instead).
    assert.equal(store.actionView(commit.id).controls.complete, false);
    assert.throws(() => store.completeAction(commit.id, { outputs: { commitSha: SHA } }), ActionRefusedError);
    const t = deliver(store, commit.id);
    const running = store.actionView(commit.id);
    assert.equal(running.controls.complete, true);
    assert.deepEqual(Object.keys(running.controls).sort(), [...MIRROR_ACTION_CONTROLS_KEYS].sort());
    // Outputs are validated like a report and leave the action running.
    assert.throws(() => store.completeAction(commit.id, {}), /output 'commitSha' is required/);
    assert.throws(() => store.completeAction(commit.id, { outputs: { commitSha: "nope" } }), /does not match/);
    assert.equal(mustAction(store, commit.id).status, "running");
    const seqBefore = store.lastAuditSeq();
    const done = store.completeAction(commit.id, { outputs: { commitSha: SHA, branch: "feat/x" }, detail: "agent was told to ignore it" });
    assert.equal(done.applied, true);
    assert.equal(done.action.status, "succeeded");
    assert.deepEqual(done.action.result?.outputs, { commitSha: SHA, branch: "feat/x" });
    assert.deepEqual(done.action.result?.receipt, { completedBy: "operator" });
    assert.equal(done.action.result?.detail, "agent was told to ignore it");
    assert.equal(done.action.result?.attempt, 1);
    assert.equal(done.action.result?.reconciled, false);
    assert.equal(done.action.attempts[0]?.outcome, "succeeded");
    assert.equal(done.action.controls.complete, false);
    // Downstream releases normally; the audit names the operator completion.
    assert.equal(store.actionView(land.id).hold, null);
    const puts = store.auditTail(seqBefore, 1000, bee.id).filter((r) => r.kind === "action.put");
    assert.ok(puts.some((r) => r.payload.reason === "operator_complete" && (r.payload.action as { id: string }).id === commit.id && r.payload.previous === "running"));
    // Terminal: quiet no-op.
    assert.equal(store.completeAction(commit.id, { outputs: { commitSha: SHA } }).applied, false);
    // The agent's late report for the same attempt: same outcome dedupes, different outcome is refused.
    const late = store.reportAction({ actionId: commit.id, attempt: t.attempt, token: t.token, reporter: { beeId: bee.id }, kind: "result", outcome: "succeeded", outputs: { commitSha: "abcdef1" } });
    assert.equal(late.deduped, true);
    assert.equal(late.applied, false);
    assert.equal(mustAction(store, commit.id).result?.outputs.commitSha, SHA, "the operator's outputs stand");
    assert.throws(() => store.reportAction({ actionId: commit.id, attempt: t.attempt, token: t.token, reporter: { beeId: bee.id }, kind: "result", outcome: "failed", detail: "could not" }), ActionRefusedError);
    assert.equal(store.reportAction({ actionId: commit.id, attempt: t.attempt, token: t.token, reporter: { beeId: bee.id }, kind: "progress", note: "late" }).applied, false);
    // Non-agent executors and uncertain agent attempts are refused.
    assert.throws(() => store.completeAction(land.id, { outputs: {} }), ActionRefusedError);
    const c2 = enqueue(store, bee.id, [{ kind: "fix" }]).actions[0]!;
    store.reorderActions(bee.id, [c2.id, ...store.listActionsOf(bee.id).filter((a) => a.status === "queued" && a.id !== c2.id).map((a) => a.id)]);
    const t2 = deliver(store, c2.id);
    store.reportAction({ actionId: c2.id, attempt: t2.attempt, token: t2.token, reporter: { beeId: bee.id }, kind: "result", outcome: "uncertain", detail: "?" });
    assert.equal(store.actionView(c2.id).controls.complete, false);
    assert.throws(() => store.completeAction(c2.id), ActionRefusedError);
    assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("actions.10: complete answers the attempt's open question, withdraws an undelivered instruction, and checks requested outputs", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    // waiting/input: the open question is answered (ordinary mail), never left dangling.
    const commit = enqueue(store, bee.id, [{ kind: "commit" }]).actions[0]!;
    const t = deliver(store, commit.id);
    const asked = store.reportAction({ actionId: commit.id, attempt: t.attempt, token: t.token, reporter: { beeId: bee.id }, kind: "question", question: { text: "squash?" } });
    assert.equal(store.actionView(commit.id).controls.complete, true);
    const done = store.completeAction(commit.id, { outputs: { commitSha: "abcdef1" } });
    assert.equal(done.action.status, "succeeded");
    const q = store.getQuestion(asked.question!.id)!;
    assert.equal(q.status, "answered");
    assert.ok(q.answer?.includes("completed by the operator"), q.answer ?? "");
    const answerMail = store.getMessage(q.deliveryMessageId!)!;
    assert.ok(answerMail.body.startsWith(`[answer to question ${q.id}]`));
    const puts = store.auditTail(0, 100_000, bee.id).filter((r) => r.kind === "action.put" && (r.payload.action as { id: string }).id === commit.id);
    assert.equal(puts.at(-1)?.payload.reason, "operator_complete");
    assert.equal(puts.at(-1)?.payload.previous, "waiting");
    // Undelivered: the instruction is withdrawn from the mailbox.
    const greet = enqueue(store, bee.id, [{ kind: "instruction", inputs: { instruction: "say hi", outputs: ["greeting"] } }]).actions[0]!;
    const { messageId } = store.dispatchAgentAction(greet.id);
    assert.throws(() => store.completeAction(greet.id, { outputs: {} }), /output 'greeting' is required/);
    assert.notEqual(store.getMessage(messageId!), null, "a refused complete changes nothing");
    const g = store.completeAction(greet.id, { outputs: { greeting: "hi" } });
    assert.equal(g.action.status, "succeeded");
    assert.equal(store.getMessage(messageId!), null, "undelivered instruction withdrawn");
    assert.ok(store.auditTail(0, 100_000, bee.id).some((r) => r.kind === "mail.canceled" && r.payload.messageId === messageId));
    assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
  } finally {
    h.cleanup();
  }
});

test("actions.11: the reminder mail — origin action.nudge, urgency idle, the exact report command; recorded once per attempt as dispatch.nudgedAt", () => {
  const h = harness();
  try {
    const store = h.open();
    const bee = liveBee(store);
    const { actions } = shipSequence(store, bee.id);
    const commit = actions[0]!;
    const { messageId } = store.dispatchAgentAction(commit.id);
    // Not delivered yet: no reminder, not due.
    assert.equal(actionNudgeDueAt(mustAction(store, commit.id)), null);
    assert.equal(store.nudgeAgentAction(commit.id, 1), null);
    store.markDelivered(messageId!, 1);
    const t = tokenOf(store.getMessage(messageId!)!.body);
    const delivered = mustAction(store, commit.id);
    assert.equal(delivered.dispatch?.nudgedAt, null);
    assert.equal(actionNudgeDueAt(delivered), delivered.dispatch!.deliveredAt! + ACTION_NUDGE_AFTER_MS.commit!);
    assert.equal(ACTION_NUDGE_AFTER_MS.commit, 30 * 60_000);
    // Progress restarts the silence clock.
    store.reportAction({ actionId: commit.id, attempt: t.attempt, token: t.token, reporter: { beeId: bee.id }, kind: "progress", note: "staging" });
    const progressed = mustAction(store, commit.id);
    assert.equal(actionNudgeDueAt(progressed), progressed.progress!.at + 30 * 60_000);
    assert.equal(actionNudgeDueAt(progressed, [progressed.progress!.at + 5]), progressed.progress!.at + 5 + 30 * 60_000);
    assert.equal(store.nudgeAgentAction(commit.id, 2), null, "wrong attempt");
    const seqBefore = store.lastAuditSeq();
    const nudged = store.nudgeAgentAction(commit.id, 1)!;
    assert.ok(nudged);
    const mail = store.getMessage(nudged.messageId)!;
    assert.equal(mail.sender, ACTION_DISPATCH_SENDER);
    assert.equal(mail.urgency, "idle");
    assert.ok(mail.body.startsWith(`[Hive action] Reminder — Commit — action ${commit.id}, attempt 1`), mail.body);
    assert.ok(mail.body.includes("still open and is holding the queue"), mail.body);
    assert.ok(mail.body.includes(`hive action report ${commit.id} --attempt 1 --token ${t.token} --succeeded --output commitSha=<commitSha>`), mail.body);
    assert.ok(mail.body.includes(`hive action report ${commit.id} --attempt 1 --token ${t.token} --failed --detail`), mail.body);
    const tail = store.auditTail(seqBefore, 1000, bee.id);
    assert.equal(tail.find((r) => r.kind === "mail.enqueued")?.payload.origin, "action.nudge");
    const put = tail.find((r) => r.kind === "action.put" && r.payload.reason === "nudged");
    assert.ok(put, "action.put nudged");
    const view = put.payload.action as { status: string; dispatch: Record<string, unknown> };
    assert.equal(view.status, "running", "a reminder is never completion");
    assert.equal(typeof view.dispatch.nudgedAt, "number");
    assert.deepEqual(Object.keys(view.dispatch).sort(), [...MIRROR_ACTION_DISPATCH_KEYS].sort());
    // Exactly once per attempt; not due any more.
    assert.equal(store.nudgeAgentAction(commit.id, 1), null);
    assert.equal(actionNudgeDueAt(mustAction(store, commit.id)), null);
    // Mail history keeps the typed origin (the widened CHECK accepts it).
    assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
    // Other kinds have no threshold.
    const fix = enqueue(store, bee.id, [{ kind: "fix" }]).actions[0]!;
    assert.equal(actionNudgeDueAt({ ...mustAction(store, fix.id), status: "running", attempt: 1, dispatch: { ...delivered.dispatch!, nudgedAt: null } }), null);
  } finally {
    h.cleanup();
  }
});

test("actions.12: a v28 store migrates to v29 — the mail-history origin CHECK gains action.nudge; pre-v29 dispatch JSON reads nudgedAt null", () => {
  const h = harness();
  const seed = h.open();
  const bee = liveBee(seed);
  const commit = enqueue(seed, bee.id, [{ kind: "commit" }]).actions[0]!;
  const { messageId } = seed.dispatchAgentAction(commit.id);
  seed.markDelivered(messageId!, 1);
  seed.close();
  const db = new DatabaseSync(h.path);
  db.exec("UPDATE meta SET value = '28' WHERE key = 'schema_version'");
  const ddl = String((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'mail_history_enqueues'").get() as { sql: string }).sql);
  db.exec("ALTER TABLE mail_history_enqueues RENAME TO mail_history_enqueues_old");
  db.exec(ddl.replace(",'action.nudge'", ""));
  db.exec("INSERT INTO mail_history_enqueues SELECT * FROM mail_history_enqueues_old; DROP TABLE mail_history_enqueues_old");
  // A v24..v28 row: dispatch JSON without the nudgedAt key.
  const row = db.prepare("SELECT dispatch_json FROM actions WHERE id = ?").get(commit.id) as { dispatch_json: string };
  const legacy = JSON.parse(row.dispatch_json) as Record<string, unknown>;
  delete legacy.nudgedAt;
  db.prepare("UPDATE actions SET dispatch_json = ? WHERE id = ?").run(JSON.stringify(legacy), commit.id);
  db.close();
  h.open().close(); // migrate
  let store: CoreStore | null = null;
  try {
    const check = new DatabaseSync(h.path, { readOnly: true });
    assert.equal(Number((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    assert.ok(String((check.prepare("SELECT sql FROM sqlite_master WHERE name = 'mail_history_enqueues'").get() as { sql: string }).sql).includes("'action.nudge'"));
    const carried = (check.prepare("SELECT count(*) AS n FROM mail_history_enqueues").get() as { n: number }).n;
    check.close();
    assert.ok(carried >= 1, "rows carried across");
    store = h.open();
    const view = store.actionView(commit.id);
    assert.equal(view.dispatch?.nudgedAt, null);
    assert.deepEqual(Object.keys(view.dispatch!).sort(), [...MIRROR_ACTION_DISPATCH_KEYS].sort());
    assert.ok(store.nudgeAgentAction(commit.id, 1), "the migrated store accepts the new origin");
  } finally {
    store?.close();
    h.cleanup();
  }
});
