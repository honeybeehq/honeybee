import { test } from "node:test";
import assert from "node:assert/strict";
import { openCoreStore, replayAudit, type CoreStore } from "../src/index.ts";
import { harness } from "./helpers.ts";

function admit(store: CoreStore, kind: "fork" | "handoff" = "handoff", key = "key", hash = "hash") {
  return store.admitThreadOperation({ id: "operation", kind, idempotencyKey: key, requestHash: hash,
    sourceBeeId: "source", sourceProviderSessionId: "source-session", successorBeeId: "successor", successorProviderSessionId: "successor-session",
    instruction: kind === "handoff" ? "Preserve the unresolved tests" : null,
    source: { path: "/tmp/source", bytes: 100, dev: 1, ino: 2, modelProvider: "mock" }, historyPath: "/tmp/history", sessionPath: "/tmp/session",
  }, { id: "successor", name: "successor", agent: "codex", substrate: "hsr", cwd: "/tmp", parentId: "source", forkedFrom: "source" });
}

test("thread admission, durable dedup, failures and restart preserve one successor and source", () => {
  const h = harness();
  let store = h.open();
  try {
    store.createBee({ id: "source", name: "source", agent: "codex", substrate: "hsr", cwd: "/tmp" });
    const before = store.getBee("source");
    const first = admit(store);
    const seq = store.lastAuditSeq();
    assert.deepEqual(admit(store), first);
    assert.equal(store.lastAuditSeq(), seq, "duplicate acceptance is quiet");
    assert.throws(() => admit(store, "handoff", "key", "changed"), /bound/);
    assert.equal(store.listBees().length, 2);
    assert.equal(store.currentRuntime("successor")?.state, "stopped");
    store.send("successor", "later", { urgency: "now" });
    const archive = store.enqueueCommand("archive", "successor", { reason: "action" });
    assert.equal(store.claimNextCommand(), null, "spawn and wake cannot bypass copy");
    assert.throws(() => store.updateThreadOperation(first.id, { phase: "starting" }), /requires/);
    store.updateThreadOperation(first.id, { transcriptReady: true, phase: "compacting" });
    assert.equal(store.claimNextCommand(), null, "compaction fences all starts");
    store.updateThreadOperation(first.id, { phase: "failed", failure: { stage: "compacting", code: "compaction_failed", detail: "provider offline", retryable: true } });
    assert.equal(store.claimNextCommand(), null, "failure holds downstream");
    store.close();
    store = openCoreStore(h.path, { now: h.now });
    assert.equal(admit(store).successorBeeId, first.successorBeeId);
    store.retryThreadOperation(first.id);
    store.updateThreadOperation(first.id, { phase: "starting", compacted: true });
    const command = store.claimNextCommand();
    assert.equal(command?.id, first.commandId);
    store.completeCommand(command!.id);
    assert.equal(store.claimNextCommand(), null, "structured archive cannot bypass readiness");
    store.updateThreadOperation(first.id, { phase: "ready" });
    assert.equal(store.claimNextCommand()?.id, archive.id);
    store.completeCommand(archive.id);
    assert.deepEqual(store.getBee("source"), before);
    assert.deepEqual(store.listMessages("successor").map(m => m.body), ["Continue from the compacted conversation.", "later"]);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
    store.deleteBee("source");
    assert.equal(admit(store).successorBeeId, first.successorBeeId, "receipt survives source deletion");
    store.deleteBee("successor");
    const deleted = admit(store);
    assert.equal(deleted.failure?.code, "successor_deleted");
    assert.equal(deleted.transcriptReady, false);
    assert.equal(store.getBee("successor"), null, "replay cannot recreate a deleted successor");
    assert.throws(() => store.retryThreadOperation(first.id), /not recoverable/);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});

test("thread fork admits no instruction, continuation mail, or compaction", () => {
  const h = harness(); const store = h.open();
  try {
    store.createBee({ id: "source", name: "source", agent: "codex", substrate: "hsr", cwd: "/tmp" });
    const fork = admit(store, "fork");
    assert.equal(fork.instruction, null);
    assert.equal(fork.continuationMessageId, null);
    assert.equal(store.listMessages("successor").length, 0);
    store.updateThreadOperation(fork.id, { transcriptReady: true, phase: "starting" });
    store.updateThreadOperation(fork.id, { phase: "ready" });
    assert.equal(store.getThreadOperation(fork.id)?.compacted, false);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});
