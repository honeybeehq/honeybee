/**
 * Schema v11 — agent task lists: add/transition/claim/move/edit, auto-supply
 * gate + feed via mailbox, breaker reset on human send, audit replay.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildTaskFeedBody,
  CoreError,
  TASK_FEED_PROMPT_MARKER,
  TASK_SUPPLY_SENDER_NAME,
  TaskNotFoundError,
  beeTaskList,
  evaluateSupplyGate,
  replayAudit,
} from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

function planDetails(db: DatabaseSync, sql: string, ...params: string[]): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>)
    .map((row) => row.detail);
}

test("tasks.add: user origin defaults auto; self never auto; bee origin ignores --auto; replay", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    const user = store.addTask({
      list: beeTaskList(bee.id),
      title: "paint the button",
      originKind: "user",
      originSender: "operator",
    });
    assert.equal(user.task.status, "pending");
    assert.equal(user.task.auto, true);
    assert.equal(user.task.list, beeTaskList(bee.id));
    assert.equal(user.warning, undefined);

    const self = store.addTask({
      list: beeTaskList(bee.id),
      title: "own plan",
      originKind: "self",
      originSender: bee.id,
      autoRequested: true,
    });
    assert.equal(self.task.auto, false);
    assert.match(self.warning ?? "", /self-origin/);

    const peer = store.addTask({
      list: beeTaskList(bee.id),
      title: "from another bee",
      originKind: "bee",
      originSender: "other",
      autoRequested: true,
    });
    assert.equal(peer.task.auto, false);
    assert.match(peer.warning ?? "", /bee-origin/);

    assert.throws(() => store.addTask({ list: beeTaskList(bee.id), title: "", originKind: "user", originSender: "operator" }), CoreError);
    assert.throws(
      () => store.addTask({ list: beeTaskList(bee.id), title: "a\nb", originKind: "user", originSender: "operator" }),
      CoreError,
    );
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.transition: start/done/block/cancel; queued close cancels carrying mail; start reopens blocked", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    const { task } = store.addTask({
      list: beeTaskList(bee.id),
      title: "do it",
      originKind: "user",
      originSender: "operator",
    });
    const started = store.transitionTask(task.id, "start");
    assert.equal(started.status, "in-progress");
    const blocked = store.transitionTask(task.id, "block", { reason: "need a decision" });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedReason, "need a decision");
    assert.ok(blocked.closedAt);
    const reopened = store.transitionTask(task.id, "start");
    assert.equal(reopened.status, "in-progress");
    assert.equal(reopened.blockedReason, null);
    assert.equal(reopened.closedAt, null);
    const done = store.transitionTask(task.id, "done");
    assert.equal(done.status, "done");
    assert.throws(() => store.transitionTask(task.id, "start"), CoreError);
    assert.throws(() => store.transitionTask("nope", "done"), TaskNotFoundError);

    store.setTaskSupply(bee.id, { on: true });
    const { task: auto } = store.addTask({
      list: beeTaskList(bee.id),
      title: "auto one",
      originKind: "user",
      originSender: "operator",
    });
    const fed = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed);
    assert.equal(fed.fed.id, auto.id);
    assert.equal(fed.fed.status, "queued");
    assert.ok(fed.fed.mailboxMessageId);
    assert.equal(store.undeliveredMessages(bee.id).length, 1);
    const canceled = store.transitionTask(auto.id, "cancel");
    assert.equal(canceled.status, "cancelled");
    assert.equal(canceled.mailboxMessageId, null);
    assert.equal(store.undeliveredMessages(bee.id).length, 0);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.claim/move/edit: claim takes top unclaimed; move bisects; edit respects self auto lock", () => {
  const h = harness();
  try {
    const store = h.open();
    const a = store.addTask({ list: "shared:backlog", title: "first", originKind: "user", originSender: "operator" }).task;
    const b = store.addTask({ list: "shared:backlog", title: "second", originKind: "user", originSender: "operator" }).task;
    assert.ok(a.order < b.order);
    const moved = store.moveTask(b.id, { before: a.id });
    assert.ok(moved.order < a.order);
    const claimed = store.claimTask("shared:backlog", "worker");
    assert.equal(claimed?.id, b.id);
    assert.equal(claimed?.claimedBy, "worker");
    assert.equal(claimed?.status, "in-progress");
    assert.equal(store.claimTask("shared:backlog", "other")?.id, a.id);

    const { bee } = makeBee(store, "selfy");
    const self = store.addTask({
      list: beeTaskList(bee.id),
      title: "plan",
      originKind: "self",
      originSender: bee.id,
    }).task;
    const edited = store.editTask(self.id, { title: "plan v2", auto: true });
    assert.equal(edited.title, "plan v2");
    assert.equal(edited.auto, false);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.supply: gate is six conditions; feed is one idle mailbox message; breaker; human send resets feeds", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    bootToRunning(store, bee.id, 11, h.now());
    const { task } = store.addTask({
      list: beeTaskList(bee.id),
      title: "eligible",
      originKind: "user",
      originSender: "operator",
    });
    const { task: next } = store.addTask({
      list: beeTaskList(bee.id),
      title: "next",
      originKind: "user",
      originSender: "operator",
    });
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "supply off");
    store.setTaskSupply(bee.id, { on: true, limit: 2 });

    const question = store.askQuestion(bee.id, { text: "which task?" });
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "needs input");
    const answer = store.answerQuestion(question.id, "first");
    store.cancelMessage(bee.id, answer.send.message.id);

    store.send(bee.id, "human note", { sender: "operator" });
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "mailbox not empty");
    const mail = store.undeliveredMessages(bee.id)[0]!;
    store.cancelMessage(bee.id, mail.id);

    const listQuestions = store.listQuestions.bind(store);
    const undeliveredMessages = store.undeliveredMessages.bind(store);
    store.listQuestions = () => assert.fail("task supply must not hydrate questions for a boolean gate");
    store.undeliveredMessages = () => assert.fail("task supply must not hydrate mailbox rows for a boolean gate");
    let fed: ReturnType<typeof store.tryFeedTaskSupply> = null;
    try {
      fed = store.tryFeedTaskSupply(bee.id);
    } finally {
      store.listQuestions = listQuestions;
      store.undeliveredMessages = undeliveredMessages;
    }
    assert.ok(fed);
    assert.equal(fed.fed.id, task.id);
    assert.equal(fed.fed.status, "queued");
    assert.equal(fed.supply.feeds, 1);
    assert.equal(fed.supply.paused, false);
    const body = store.getMessage(fed.fed.mailboxMessageId as number)?.body ?? "";
    assert.ok(body.startsWith(TASK_FEED_PROMPT_MARKER));
    assert.equal(body, buildTaskFeedBody(fed.fed, 1), "feed body reports the exact remaining task count");
    assert.equal(store.getMessage(fed.fed.mailboxMessageId as number)?.sender, TASK_SUPPLY_SENDER_NAME);
    assert.equal(store.getMessage(fed.fed.mailboxMessageId as number)?.urgency, "idle");

    assert.equal(store.tryFeedTaskSupply(bee.id), null, "task in flight");
    store.transitionTask(task.id, "done");
    // cancel of queued mail already happened on done; remaining undelivered is none
    const fed2 = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed2);
    assert.equal(fed2.fed.id, next.id, "eligible task order remains stable");
    assert.equal(fed2.supply.feeds, 2);
    assert.equal(fed2.supply.paused, true, "breaker trips at limit");
    assert.equal(
      store.getMessage(fed2.fed.mailboxMessageId as number)?.body,
      buildTaskFeedBody(fed2.fed, 0),
      "last eligible task reports no remaining tasks",
    );
    store.transitionTask(fed2.fed.id, "done");
    assert.equal(store.tryFeedTaskSupply(bee.id), null, "breaker paused");

    store.send(bee.id, "thanks", { sender: "operator" });
    assert.equal(store.getTaskSupply(bee.id).feeds, 0, "human send resets feeds");
    assert.equal(store.getTaskSupply(bee.id).paused, true, "paused stays until --on");
    store.setTaskSupply(bee.id, { on: true });
    assert.equal(store.getTaskSupply(bee.id).paused, false);
    assert.equal(store.getTaskSupply(bee.id).feeds, 0);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.supply: missing, terminal gates, and empty lists avoid unrelated row hydration", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee: off } = makeBee(store, "supply-off");

    const { bee: paused } = makeBee(store, "supply-paused");
    store.setTaskSupply(paused.id, { on: true, limit: 1 });
    const pausedTask = store.addTask({
      list: beeTaskList(paused.id),
      title: "trip paused breaker",
      originKind: "user",
      originSender: "operator",
    }).task;
    assert.equal(store.tryFeedTaskSupply(paused.id)?.fed.id, pausedTask.id);
    assert.equal(store.getTaskSupply(paused.id).paused, true);

    const { bee: atLimit } = makeBee(store, "supply-at-limit");
    store.setTaskSupply(atLimit.id, { on: true, limit: 2 });
    const limitTask = store.addTask({
      list: beeTaskList(atLimit.id),
      title: "reach feed limit",
      originKind: "user",
      originSender: "operator",
    }).task;
    assert.equal(store.tryFeedTaskSupply(atLimit.id)?.fed.id, limitTask.id);
    store.transitionTask(limitTask.id, "done");
    const limited = store.setTaskSupply(atLimit.id, { limit: 1 });
    assert.equal(limited.feeds, 1);
    assert.equal(limited.paused, false, "feed count alone exercises the breaker predicate");

    const { bee: empty } = makeBee(store, "supply-empty");
    store.setTaskSupply(empty.id, { on: true });

    const stateBefore = store.dumpState();
    const auditBefore = store.lastAuditSeq();
    const reads = { bees: 0, supplies: 0, tasks: 0, questions: 0, mail: 0 };
    const getBee = store.getBee.bind(store);
    const getTaskSupply = store.getTaskSupply.bind(store);
    const listTasks = store.listTasks.bind(store);
    const listQuestions = store.listQuestions.bind(store);
    const undeliveredMessages = store.undeliveredMessages.bind(store);
    store.getBee = (beeId) => {
      reads.bees += 1;
      return getBee(beeId);
    };
    store.getTaskSupply = (beeId) => {
      reads.supplies += 1;
      return getTaskSupply(beeId);
    };
    store.listTasks = (filter) => {
      reads.tasks += 1;
      return listTasks(filter);
    };
    store.listQuestions = (filter) => {
      reads.questions += 1;
      return listQuestions(filter);
    };
    store.undeliveredMessages = (beeId) => {
      reads.mail += 1;
      return undeliveredMessages(beeId);
    };
    try {
      assert.equal(store.tryFeedTaskSupply("missing-bee"), null);
      assert.equal(store.tryFeedTaskSupply(off.id), null);
      assert.equal(store.tryFeedTaskSupply(paused.id), null);
      assert.equal(store.tryFeedTaskSupply(atLimit.id), null);
      assert.equal(store.tryFeedTaskSupply(empty.id), null);
    } finally {
      store.getBee = getBee;
      store.getTaskSupply = getTaskSupply;
      store.listTasks = listTasks;
      store.listQuestions = listQuestions;
      store.undeliveredMessages = undeliveredMessages;
    }

    assert.deepEqual(reads, { bees: 0, supplies: 5, tasks: 1, questions: 0, mail: 0 });
    assert.equal(store.lastAuditSeq(), auditBefore, "negative supply decisions do not append authority events");
    assert.deepEqual(store.dumpState(), stateBefore, "negative supply decisions do not mutate authority state");
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.supply: boolean probes use the existing partial indexes", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "supply-plan");
    store.askQuestion(bee.id, { text: "which task?" });
    store.send(bee.id, "pending mail");
    store.close();

    const check = new DatabaseSync(h.path, { readOnly: true });
    try {
      const questionPlan = planDetails(
        check,
        "SELECT 1 FROM questions WHERE bee_id = ? AND status = 'open' LIMIT 1",
        bee.id,
      ).join("\n");
      assert.match(questionPlan, /USING (?:COVERING )?INDEX questions_open \(bee_id=\?\)/);

      const mailPlan = planDetails(
        check,
        "SELECT 1 FROM mailbox WHERE bee_id = ? AND delivered_at IS NULL LIMIT 1",
        bee.id,
      ).join("\n");
      assert.match(mailPlan, /USING (?:COVERING )?INDEX mailbox_undelivered \(bee_id=\?\)/);
    } finally {
      check.close();
    }
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.supply.gate: evaluateSupplyGate is ordered and pure", () => {
  const supply = { beeId: "b", on: true, limit: 5, feeds: 0, paused: false };
  const task = {
    id: "task_1",
    list: "bee:b",
    beeId: "b",
    title: "t",
    body: null,
    context: null,
    originKind: "user" as const,
    originSender: "operator",
    auto: true,
    status: "pending" as const,
    claimedBy: null,
    order: 10,
    questId: null,
    mailboxMessageId: null,
    fedAt: null,
    stalledAt: null,
    blockedReason: null,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
  };
  assert.equal(evaluateSupplyGate({ supply: { ...supply, on: false }, needsInput: false, mailboxEmpty: true, tasks: [task] }).reason, "supply-off");
  assert.equal(evaluateSupplyGate({ supply, needsInput: true, mailboxEmpty: true, tasks: [task] }).reason, "needs-input");
  assert.equal(evaluateSupplyGate({ supply, needsInput: false, mailboxEmpty: false, tasks: [task] }).reason, "mailbox-not-empty");
  assert.equal(
    evaluateSupplyGate({
      supply,
      needsInput: false,
      mailboxEmpty: true,
      tasks: [{ ...task, status: "queued" }],
    }).reason,
    "task-in-flight",
  );
  assert.equal(evaluateSupplyGate({ supply, needsInput: false, mailboxEmpty: true, tasks: [] }).reason, "no-eligible-task");
  assert.equal(
    evaluateSupplyGate({ supply: { ...supply, paused: true }, needsInput: false, mailboxEmpty: true, tasks: [task] }).reason,
    "breaker",
  );
  assert.equal(evaluateSupplyGate({ supply, needsInput: false, mailboxEmpty: true, tasks: [task] }).feed?.id, "task_1");
});

test("tasks.stall: idle + empty mail + fed in-flight stamps stalledAt once", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    bootToRunning(store, bee.id, 9, h.now());
    const rt = store.currentRuntime(bee.id)!;
    store.updateRuntimeState(bee.id, rt.generation, "idle");
    store.setTaskSupply(bee.id, { on: true });
    store.addTask({ list: beeTaskList(bee.id), title: "one", originKind: "user", originSender: "operator" });
    const fed = store.tryFeedTaskSupply(bee.id);
    assert.ok(fed);
    const undeliveredMessages = store.undeliveredMessages.bind(store);
    store.undeliveredMessages = () => assert.fail("stall detection must not hydrate mailbox rows for a boolean gate");
    try {
      assert.equal(store.maybeStallFedTask(bee.id), null, "mail still queued");
      store.cancelMessage(bee.id, fed.fed.mailboxMessageId as number);
      const stalled = store.maybeStallFedTask(bee.id);
      assert.ok(stalled?.stalledAt);
      assert.equal(store.maybeStallFedTask(bee.id), null, "already stalled");
    } finally {
      store.undeliveredMessages = undeliveredMessages;
    }
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("tasks.delete: bee delete cascades tasks and supply; shared lists survive", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store, "worker");
    store.addTask({ list: beeTaskList(bee.id), title: "mine", originKind: "user", originSender: "operator" });
    store.setTaskSupply(bee.id, { on: true });
    store.addTask({ list: "shared:keep", title: "ours", originKind: "user", originSender: "operator" });
    store.deleteBee(bee.id);
    assert.equal(store.listTasks({ list: beeTaskList(bee.id) }).length, 0);
    assert.equal(store.listTaskSupply().length, 0);
    assert.equal(store.listTasks({ list: "shared:keep" }).length, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});
