import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname, loadavg } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ActionRefusedError, hashActionEnqueueRequest, replayAudit, type CoreStore } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const samples: Array<{ scenario: string; size: number; round: number; polls: number; laneViewBuilds: number; actionRowsViewed: number }> = [];
const receiptPath = process.env.HIVE_ACTION_NOOP_RECEIPT;
after(() => {
  if (!receiptPath) return;
  const sources = Object.fromEntries(["../src/store.ts", "../src/actions.ts", "../../daemon/src/loops.ts", "./actions-noop.test.ts", "./helpers.ts"].map((path) =>
    [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
  writeFileSync(receiptPath, JSON.stringify({
    workload: "action-noop-reconciliation", seriesId: "action-noop-counts-v1", capturedAt: new Date().toISOString(),
    host: hostname(), node: process.version, load: loadavg(), sources, samples,
    results: [{ metric: "laneViewBuilds", samples: samples.map((s) => s.laneViewBuilds), invariantHolds: samples.length === 18 && samples.every((s) => s.laneViewBuilds === 0) }],
    scope: "Store method work counts; one fresh ActionView still reads the lane. No timing or whole-daemon claim.",
  }, null, 2) + "\n");
});

function lane(store: CoreStore, kind: string, size: number) {
  const { bee } = makeBee(store);
  const items = Array.from({ length: size }, (_, i) => ({ kind: i === 0 ? kind : "archive", ...(i === 0 && kind === "land" ? { inputs: { targetBranch: "main" } } : {}) }));
  const shaped = items.map((item) => ({ ...item, version: null, inputs: item.inputs ?? {}, clientRef: null, title: null }));
  const actions = store.enqueueActions({ beeId: bee.id, idempotencyKey: "lane", requestHash: hashActionEnqueueRequest({ beeId: bee.id, items: shaped }), items }).actions;
  return { bee, first: actions[0]!, next: actions[1] };
}

function watchLaneViews(store: CoreStore) {
  const original = store.listActionViews.bind(store);
  const counts = { builds: 0, rows: 0 };
  store.listActionViews = (filter) => {
    const views = original(filter);
    counts.builds += 1;
    counts.rows += views.length;
    return views;
  };
  return { counts, restore: () => { store.listActionViews = original; } };
}

for (const scenario of ["archive-queued", "archive-running", "executor-unchanged"] as const) {
  for (const size of [1, 32]) {
    for (let round = 0; round < 3; round += 1) {
      test(`unchanged action poll: ${scenario}, lane ${size}, round ${round}`, () => {
        const h = harness();
        const store = h.open();
        try {
          const { first } = lane(store, scenario === "executor-unchanged" ? "land" : "archive", size);
          if (scenario === "executor-unchanged") store.holdActionForExecutor(first.id, "no executor");
          else {
            const dispatched = store.dispatchArchiveAction(first.id);
            if (scenario === "archive-running") assert.equal(store.claimNextCommand()?.id, dispatched.commandId);
          }
          const state = store.dumpState();
          const audit = store.auditTail(0, 100_000);
          const expected = store.actionView(first.id);
          const watched = watchLaneViews(store);
          try {
            for (let poll = 0; poll < 10; poll += 1) {
              const result = scenario === "executor-unchanged" ? store.holdActionForExecutor(first.id, "no executor") : store.reconcileArchiveAction(first.id);
              assert.deepEqual(result.action, expected);
              if ("settled" in result) assert.equal(result.settled, false);
            }
          } finally { watched.restore(); }
          assert.deepEqual(store.dumpState(), state, "unchanged polls preserve all durable state");
          assert.deepEqual(store.auditTail(0, 100_000), audit, "unchanged polls emit no audit rows");
          samples.push({ scenario, size, round, polls: 10, laneViewBuilds: watched.counts.builds, actionRowsViewed: watched.counts.rows });
          assert.equal(watched.counts.builds, 0, "unchanged polling must not rebuild every lane view for an audit");
        } finally { store.close(); h.cleanup(); }
      });
    }
  }
}

for (const outcome of ["done", "failed", "missing"] as const) {
  test(`archive settlement after quiet polls and reopen: ${outcome}`, () => {
    const h = harness();
    let store = h.open({ maxAttempts: 1 });
    try {
      const { bee, first, next } = lane(store, "archive", 2);
      const dispatched = store.dispatchArchiveAction(first.id);
      assert.equal(store.reconcileArchiveAction(first.id).settled, false);
      store.close();
      if (outcome === "missing") {
        const db = new DatabaseSync(h.path);
        try { db.prepare("DELETE FROM commands WHERE id = ?").run(dispatched.commandId!); } finally { db.close(); }
      }
      store = h.open({ maxAttempts: 1 });
      if (outcome !== "missing") {
        assert.equal(store.claimNextCommand()?.id, dispatched.commandId);
        if (outcome === "done") { store.archiveBee(bee.id); store.completeCommand(dispatched.commandId!); }
        else store.reportCommandFailure(dispatched.commandId!, "resource_blocked", "test failure");
      }
      const watched = watchLaneViews(store);
      const result = store.reconcileArchiveAction(first.id);
      watched.restore();
      assert.equal(watched.counts.builds, 2, "a real settlement still audits before and after views");
      assert.equal(result.settled, true);
      assert.equal(result.action.status, outcome === "done" ? "succeeded" : "failed");
      assert.equal(result.action.failure?.code, outcome === "done" ? undefined : outcome === "missing" ? "operation_missing" : "command_resource_blocked");
      assert.equal(store.actionView(next!.id).hold?.reason ?? null, outcome === "done" ? null : "predecessor_failed");
      const seq = store.auditTail(0, 100_000).at(-1)!.seq;
      assert.equal(store.reconcileArchiveAction(first.id).settled, false);
      assert.equal(store.auditTail(seq, 100).length, 0);
      if (outcome !== "missing") assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
    } finally { store.close(); h.cleanup(); }
  });
}

test("executor holds publish changed details, preserve attempt, and allow later claim", () => {
  const h = harness();
  let store = h.open();
  try {
    const { first } = lane(store, "push", 2);
    const held = store.holdActionForExecutor(first.id, "offline").action;
    store.close(); store = h.open();
    assert.deepEqual(store.holdActionForExecutor(first.id, "offline").action, held);
    const seq = store.auditTail(0, 100_000).at(-1)!.seq;
    const watched = watchLaneViews(store);
    const changed = store.holdActionForExecutor(first.id, "connecting").action;
    watched.restore();
    assert.equal(watched.counts.builds, 2);
    assert.equal(changed.waitingDetail, "connecting");
    assert.equal(changed.attempt, held.attempt);
    assert.deepEqual(changed.dispatch, held.dispatch);
    assert.equal(store.auditTail(seq, 100).filter((a) => a.kind === "action.put").length, 1);
    assert.ok(store.claimAction({ actionId: first.id, executor: "test" }));
    assert.throws(() => store.holdActionForExecutor(first.id, "connecting"), ActionRefusedError);
    assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
  } finally { store.close(); h.cleanup(); }
});
