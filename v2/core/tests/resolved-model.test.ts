/**
 * v33 `bees.resolved_model` — the provider model id a runtime reports:
 * current-generation fenced, quiet on repeats, reset by a new generation,
 * audited as `bee.resolved_model` and replay-equivalent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { replayAudit } from "../src/index.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";

test("resolved-model.core.1: record, dedupe, fence stale generations, reset on revive, replay", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    assert.equal(store.getBee(bee.id)?.resolvedModel, null, "unknown at birth");
    bootToRunning(store, bee.id, 4242, 1);

    assert.deepEqual(store.recordResolvedModel(bee.id, 1, "claude-fable-5-1"), { applied: true });
    const seq = store.lastAuditSeq();
    assert.deepEqual(store.recordResolvedModel(bee.id, 1, "claude-fable-5-1"), { applied: false });
    assert.equal(store.lastAuditSeq(), seq, "a repeated report is quiet");

    // In-harness switch: one delta carrying the previous value.
    assert.deepEqual(store.recordResolvedModel(bee.id, 1, "claude-opus-5-5"), { applied: true });
    const delta = store.auditRows().at(-1)!;
    assert.equal(delta.kind, "bee.resolved_model");
    assert.deepEqual(delta.payload, { beeId: bee.id, generation: 1, resolvedModel: "claude-opus-5-5", previous: "claude-fable-5-1" });

    // A stopped bee keeps the model it last ran; a new generation resets it.
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
    assert.equal(store.getBee(bee.id)?.resolvedModel, "claude-opus-5-5");
    store.reviveBee(bee.id);
    assert.equal(store.getBee(bee.id)?.resolvedModel, null, "generation 2 has not reported yet");
    assert.deepEqual(store.recordResolvedModel(bee.id, 1, "claude-haiku-5-5"), { applied: false }, "stale generation fenced");
    assert.equal(store.getBee(bee.id)?.resolvedModel, null);
    assert.deepEqual(store.recordResolvedModel(bee.id, 2, "claude-opus-5-5"), { applied: true });
    assert.equal(store.getBee(bee.id)?.resolvedModel, "claude-opus-5-5");

    assert.throws(() => store.recordResolvedModel(bee.id, 2, ""), /non-empty/);
    assert.deepEqual(replayAudit(store.auditRows()), store.dumpState());
  } finally {
    store.close();
    h.cleanup();
  }
});
