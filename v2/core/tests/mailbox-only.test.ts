import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreError, filterMailbox, INBOX_AGENT } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

function makeInbox(store: ReturnType<ReturnType<typeof harness>["open"]>, name = "grokbot") {
  return store.createBee({ name, agent: INBOX_AGENT, substrate: "hsr", cwd: "" });
}

test("mailbox-only bee: created with one stopped(clean) generation and nothing to start", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee, runtime } = makeInbox(store);
    assert.equal(runtime.state, "stopped");
    assert.equal(runtime.exitCause, "clean");
    assert.equal(runtime.pid, null);
    const view = store.view(bee.id);
    assert.equal(view.working, false);
    assert.equal(view.blocked, false);
    assert.deepEqual(store.listCommands({ beeId: bee.id }), []);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("mailbox-only bee: mail is stored undelivered and never schedules a wake", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeInbox(store);
    const worker = makeBee(store).bee;
    const res = store.send(bee.id, "hello grokbot", { sender: worker.id });
    assert.equal(res.wakeCommand, null);
    assert.equal(res.message.sender, worker.id);
    assert.equal(store.enqueueWake(bee.id).outcome, "mailbox_only");
    assert.equal(store.enqueueBootRetry(bee.id).outcome, "mailbox_only");
    assert.deepEqual(store.listCommands({ beeId: bee.id }), []);
    assert.equal(store.undeliveredMessages(bee.id).length, 1);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("mailbox-only bee: spawn, wake, revive, and reconnect are refused", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeInbox(store);
    for (const verb of ["spawn", "send_wake", "revive", "reconnect_tools"]) {
      assert.throws(() => store.enqueueCommand(verb, bee.id, {}), /mailbox-only/, verb);
    }
    assert.throws(() => store.reviveBee(bee.id), /mailbox-only/);
    assert.equal(store.currentRuntime(bee.id)?.generation, 1);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("mailbox-only bee: excluded from I1 pending, step inputs, and auto-title", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeInbox(store);
    store.send(bee.id, "unread", { sender: "operator" });
    assert.deepEqual(store.readI1PendingSnapshot(), []);
    assert.equal(store.hasStepSnapshotInputs(), false);
    assert.ok(!store.listAutoTitleCandidates().some((c) => c.id === bee.id));
  } finally {
    store.close();
    h.cleanup();
  }
});

test("mailbox-only bee: ack marks mail read through an id, emits mail.delivered with ack, and is idempotent", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeInbox(store);
    const ids = [1, 2, 3].map((n) => store.send(bee.id, `m${n}`, { sender: "operator" }).message.id);
    assert.deepEqual(store.ackMail(bee.id, ids[1]!).acked, ids.slice(0, 2));
    assert.deepEqual(store.ackMail(bee.id, ids[1]!).acked, []);
    const unread = filterMailbox(store.listMessages(bee.id), { unread: true });
    assert.deepEqual(unread.map((m) => m.id), [ids[2]]);
    assert.deepEqual(filterMailbox(store.listMessages(bee.id), { sinceId: ids[0] }).map((m) => m.id), ids.slice(1));
    const acks = store.auditTail(0, 1000, bee.id).filter((row) => row.kind === "mail.delivered");
    assert.equal(acks.length, 2);
    assert.ok(acks.every((row) => row.payload.ack === true));
    assert.deepEqual(store.listCommands({ beeId: bee.id }), []);
  } finally {
    store.close();
    h.cleanup();
  }
});

test("mailbox-only bee: ack is refused for a bee with a runtime", () => {
  const h = harness();
  const store = h.open();
  try {
    const worker = makeBee(store).bee;
    store.send(worker.id, "work", { sender: "operator" });
    assert.throws(() => store.ackMail(worker.id, 1), (err: unknown) => err instanceof CoreError && /not mailbox-only/.test(err.message));
  } finally {
    store.close();
    h.cleanup();
  }
});

test("mailbox-only bee: survives store reopen and boot reconcile untouched", () => {
  const h = harness();
  let store = h.open();
  const { bee } = makeInbox(store);
  const messageId = store.send(bee.id, "kept", { sender: "operator" }).message.id;
  store.close();
  store = h.open();
  try {
    store.reconcileAtBoot([]);
    const runtime = store.currentRuntime(bee.id);
    assert.equal(runtime?.state, "stopped");
    assert.equal(runtime?.exitCause, "clean");
    assert.equal(store.enqueueWake(bee.id).outcome, "mailbox_only");
    assert.deepEqual(store.listCommands({ beeId: bee.id }), []);
    assert.deepEqual(store.undeliveredMessages(bee.id).map((m) => m.id), [messageId]);
  } finally {
    store.close();
    h.cleanup();
  }
});
