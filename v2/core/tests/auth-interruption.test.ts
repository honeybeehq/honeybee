import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AUTH_CONTINUE_BODY, AUTH_RESUME_SENDER, replayAudit, SCHEMA_VERSION, type CoreStore } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

function interrupt(store: CoreStore, beeId: string, over: Partial<Parameters<CoreStore["recordAuthInterruption"]>[0]> = {}) {
  return store.recordAuthInterruption({
    beeId, account: "claude-a", generation: 1, messageIds: [], turnProgress: "unknown", credentialRevision: "rev-1", detail: "Not logged in", ...over,
  });
}

test("auth interruption: a turn that never ran gets its original mail again, exactly once", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const first = store.send(bee.id, "do the thing", { sender: "human:tormod", urgency: "now" }).message;
    const second = store.send(bee.id, "and this", { sender: "operator" }).message;
    store.markDelivered(first.id, 1);
    store.markDelivered(second.id, 1);
    const row = interrupt(store, bee.id, { messageIds: [first.id, second.id], turnProgress: "none" });
    assert.equal(row.state, "open");
    assert.deepEqual(store.liveAuthInterruption(bee.id), row);

    assert.equal(store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY).applied, false, "nothing is sent before a credential is validated");
    assert.equal(store.restoreAuthInterruption(row.id, { revision: "rev-2", by: "login" }).applied, true);
    assert.equal(store.restoreAuthInterruption(row.id, { revision: "rev-3", by: "capture" }).applied, false);

    const resumed = store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY);
    assert.equal(resumed.applied, true);
    assert.equal(resumed.interruption?.state, "resumed");
    assert.equal(resumed.interruption?.continuationKind, "redeliver");
    assert.equal(resumed.interruption?.restoredRevision, "rev-2");
    const pending = store.undeliveredMessages(bee.id);
    assert.deepEqual(pending.map((m) => [m.body, m.sender, m.urgency]), [["do the thing", "human:tormod", "now"], ["and this", "operator", "next"]]);
    assert.deepEqual(resumed.interruption?.continuationMessageIds, pending.map((m) => m.id));
    assert.deepEqual(store.pendingMail(bee.id).messages.map((m) => m.origin), ["auth.resume", "auth.resume"]);

    assert.equal(store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY).applied, false, "a second resume sends nothing");
    assert.equal(store.undeliveredMessages(bee.id).length, 2);

    assert.equal(store.settleAuthInterruption(row.id, "completed", "turn_succeeded").applied, true);
    assert.equal(store.liveAuthInterruption(bee.id), null);
    assert.equal(store.settleAuthInterruption(row.id, "cancelled", "archived").applied, false);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("auth interruption: partial or unproven progress gets one continue message, never a redelivery", () => {
  const h = harness();
  try {
    const store = h.open();
    for (const [name, turnProgress] of [["partial", "some"], ["unproven", "unknown"]] as const) {
      const { bee } = makeBee(store, name);
      const original = store.send(bee.id, "long task").message;
      store.markDelivered(original.id, 1);
      const row = interrupt(store, bee.id, { messageIds: [original.id], turnProgress });
      store.restoreAuthInterruption(row.id, { revision: "rev-2", by: "limits_probe" });
      const resumed = store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY);
      assert.equal(resumed.interruption?.continuationKind, "continue");
      assert.deepEqual(store.undeliveredMessages(bee.id).map((m) => [m.body, m.sender]), [[AUTH_CONTINUE_BODY, AUTH_RESUME_SENDER]]);
    }
    const bare = makeBee(store, "bare").bee;
    const row = interrupt(store, bare.id, { turnProgress: "none" });
    store.restoreAuthInterruption(row.id, { revision: "rev-2", by: "refresh" });
    assert.equal(store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY).interruption?.continuationKind, "continue", "no recorded mail means nothing to redeliver");
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("auth interruption: later failures fold into the live row and only lower its certainty", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const first = interrupt(store, bee.id, { messageIds: [7], turnProgress: "none" });
    const bare = interrupt(store, bee.id, { generation: 2, detail: "again" });
    assert.equal(bare.id, first.id);
    assert.equal(bare.turnProgress, "none", "evidence without turn facts leaves the recorded turn alone");
    assert.equal(bare.generation, 2);
    const merged = interrupt(store, bee.id, { messageIds: [9, 7], turnProgress: "some" });
    assert.deepEqual(merged.messageIds, [7, 9]);
    assert.equal(merged.turnProgress, "some");
    assert.equal(interrupt(store, bee.id, { messageIds: [11], turnProgress: "none" }).turnProgress, "some");
    assert.equal(store.listAuthInterruptions({ beeId: bee.id }).length, 1);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("auth interruption: a continuation that fails authentication blocks the revision that earned it", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const original = store.send(bee.id, "task").message;
    store.markDelivered(original.id, 1);
    const row = interrupt(store, bee.id, { messageIds: [original.id], turnProgress: "none" });
    store.restoreAuthInterruption(row.id, { revision: "rev-2", by: "limits_probe" });
    const continuation = store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY).interruption!.continuationMessageIds;
    store.markDelivered(continuation[0]!, 1);

    const again = interrupt(store, bee.id, { messageIds: continuation, turnProgress: "none", credentialRevision: "rev-2" });
    assert.notEqual(again.id, row.id);
    assert.equal(again.blockedRevision, "rev-2");
    assert.deepEqual(again.messageIds, [original.id], "the replacement still points at the original mail, not the failed copy");
    assert.equal(again.turnProgress, "none");
    const previous = store.getAuthInterruption(row.id)!;
    assert.deepEqual([previous.state, previous.settleReason], ["superseded", "auth_failed_again"]);
    assert.equal(store.listLiveAuthInterruptions().length, 1);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
  } finally {
    h.cleanup();
  }
});

test("auth interruption: a swap moves the open row to the target account and unblocks it", () => {
  const h = harness();
  try {
    const store = h.open();
    const { bee } = makeBee(store);
    const row = interrupt(store, bee.id);
    store.restoreAuthInterruption(row.id, { revision: "rev-2", by: "refresh" });
    const rebound = store.rebindAuthInterruption(bee.id, "claude-b")!;
    assert.deepEqual([rebound.account, rebound.state, rebound.restoredRevision, rebound.blockedRevision], ["claude-b", "open", null, null]);
    assert.deepEqual(store.rebindAuthInterruption(bee.id, "claude-b"), rebound);
    assert.equal(store.rebindAuthInterruption(makeBee(store, "other").bee.id, "claude-b"), null);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("auth interruption: deleting the bee removes its rows; reopening keeps the rest", () => {
  const h = harness();
  try {
    let store = h.open();
    const kept = makeBee(store, "kept").bee;
    const gone = makeBee(store, "gone").bee;
    interrupt(store, kept.id, { messageIds: [1], turnProgress: "some" });
    interrupt(store, gone.id);
    store.deleteBee(gone.id);
    assert.deepEqual(store.listAuthInterruptions().map((row) => row.beeId), [kept.id]);
    const settled = makeBee(store, "settled").bee;
    const old = interrupt(store, settled.id);
    store.settleAuthInterruption(old.id, "cancelled", "archived");
    assert.deepEqual(store.listAuthInterruptions({ beeId: settled.id, account: "claude-a" }).map((row) => row.id), [old.id]);
    assert.deepEqual(store.listAuthInterruptions({ account: "claude-z" }), []);
    assert.equal(store.pruneAuthInterruptions(h.now() + 10_000), 1, "only the settled row is pruned");
    assert.deepEqual(store.listAuthInterruptions().map((row) => row.beeId), [kept.id]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.close();
    store = h.open();
    assert.deepEqual(store.listLiveAuthInterruptions().map((row) => [row.beeId, row.messageIds, row.turnProgress]), [[kept.id, [1], "some"]]);
    store.close();
  } finally {
    h.cleanup();
  }
});

test("auth interruption: a v32 store gains the table and the auth.resume mail origin without losing history", () => {
  const h = harness();
  try {
    let store = h.open();
    const { bee } = makeBee(store);
    store.send(bee.id, "before the upgrade");
    store.close();
    const raw = new DatabaseSync(h.path);
    raw.exec("DROP TABLE auth_interruptions");
    raw.exec("ALTER TABLE mail_history_enqueues RENAME TO history_now");
    raw.exec(`CREATE TABLE mail_history_enqueues (
      seq INTEGER PRIMARY KEY, message_id INTEGER NOT NULL UNIQUE, bee_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('mail.send','spawn.prompt','legacy.unknown','handoff.seed','action.dispatch')),
      sender BLOB NOT NULL, sender_truncated INTEGER NOT NULL CHECK (sender_truncated IN (0, 1)), body BLOB NOT NULL,
      body_truncated INTEGER NOT NULL CHECK (body_truncated IN (0, 1)), priority INTEGER NOT NULL,
      urgency TEXT NOT NULL CHECK (urgency IN ('now','next','idle')), enqueued_at INTEGER NOT NULL) STRICT`);
    raw.exec("INSERT INTO mail_history_enqueues SELECT * FROM history_now");
    raw.exec("DROP TABLE history_now");
    raw.exec("UPDATE meta SET value = '32' WHERE key = 'schema_version'");
    raw.close();

    store = h.open();
    assert.equal(SCHEMA_VERSION, 34);
    const row = interrupt(store, bee.id);
    store.restoreAuthInterruption(row.id, { revision: "rev-2", by: "credentials_restored" });
    store.resumeAuthInterruption(row.id, AUTH_CONTINUE_BODY);
    assert.deepEqual(store.pendingMail(bee.id).messages.map((m) => [m.origin, m.body]), [["mail.send", "before the upgrade"], ["auth.resume", AUTH_CONTINUE_BODY]]);
    assert.equal(store.mailHistory().messages.length, 2);
    store.close();
    const check = new DatabaseSync(h.path);
    assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "34");
    check.close();
  } finally {
    h.cleanup();
  }
});
