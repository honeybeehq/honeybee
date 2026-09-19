import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { replayAudit, toActionView, type ActionRow, type ActionStatus, type CoreStore } from "../src/index.ts";
import { harness, makeBee } from "./helpers.ts";

const samples: Array<{ scenario: string; size: number; round: number; laneReads: number; outputHash: string; parity: boolean }> = [];
const sizes = [1, 32, 256];
const scenarios = ["queued", "paused", "mixed", "filtered", "terminal"] as const;
after(() => {
  if (!process.env.HIVE_ACTION_VIEWS_RECEIPT) return;
  const sources = Object.fromEntries(["../src/store.ts", "../src/actions.ts", "../src/schema.ts", "./action-views.test.ts", "./helpers.ts"].map((path) =>
    [path, createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex")]));
  writeFileSync(process.env.HIVE_ACTION_VIEWS_RECEIPT, JSON.stringify({
    workload: "action-view-projection", seriesId: "action-view-reads-v1", capturedAt: new Date().toISOString(),
    host: hostname(), node: process.version, sources, samples,
    complete: samples.length === scenarios.length * sizes.length * 3,
    results: [{ metric: "laneReadsPerRow", samples: samples.map((s) => s.laneReads / s.size),
      invariantHolds: samples.length === 45 && samples.every((s) => s.parity && s.laneReads <= 4 * s.size) }],
    scope: "Numeric element reads of full lanes during CoreStore.listActionViews only; setup, SQL, parsing, selected-row iteration and allocations excluded. No timing or whole-daemon claim.",
  }, null, 2) + "\n");
});

function enqueue(store: CoreStore, beeId: string, size: number, key = "fixture") {
  return store.enqueueActions({ beeId, idempotencyKey: key, requestHash: key,
    items: Array.from({ length: size }, () => ({ kind: "archive" })) }).actions;
}

for (const scenario of scenarios) for (const size of sizes) for (let round = 0; round < 3; round++) {
  test(`batch action views: ${scenario}, ${size} rows, round ${round}`, () => {
    const h = harness();
    let store = h.open();
    try {
      const { bee } = makeBee(store);
      const rows = enqueue(store, bee.id, size);
      // Fixture-only status shapes: projection uses status/position, not executor receipts.
      if (["mixed", "filtered", "terminal"].includes(scenario)) {
        store.close();
        const db = new DatabaseSync(h.path);
        try {
          for (let i = 0; i < rows.length; i++) {
            const status = scenario === "terminal" ? "succeeded" : (["succeeded", "cancelled", "queued", "failed", "queued", "waiting", "queued"] as const)[i % 7]!;
            db.prepare("UPDATE actions SET status = ? WHERE id = ?").run(status, rows[i]!.id);
          }
        } finally { db.close(); }
        store = h.open();
      }
      if (scenario === "paused") store.pauseActionQueue(bee.id);
      const filter = { beeId: bee.id, ...(scenario === "filtered" ? { statuses: ["queued"] as ActionStatus[] } : {}) };
      const lane = store.listActionsOf(bee.id);
      const queue = store.getActionQueue(bee.id);
      const expected = store.listActions(filter).map((row) => toActionView(row, lane, queue));
      const before = store.dumpState();
      const beforeAudit = store.auditTail(0, 100_000);
      let reads = 0;
      const original = store.listActionsOf.bind(store);
      store.listActionsOf = (id) => new Proxy(original(id), { get(target, key, receiver) {
        if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      } });
      let actual;
      try { actual = store.listActionViews(filter); } finally { store.listActionsOf = original; }
      const parity = JSON.stringify(actual) === JSON.stringify(expected);
      // Normalize IDs only in the comparison receipt; exact equality is asserted above and below.
      const ids = new Map(lane.map((row, i) => [row.id, `action-${i}`]));
      const outputHash = createHash("sha256").update(JSON.stringify(actual, (key, value) =>
        typeof value === "string" && ids.has(value) ? ids.get(value) : key === "beeId" ? "fixture-bee" : value)).digest("hex");
      samples.push({ scenario, size, round, laneReads: reads, outputHash, parity });
      assert.deepEqual(actual, expected);
      assert.deepEqual(store.dumpState(), before);
      assert.deepEqual(store.auditTail(0, 100_000), beforeAudit);
      assert.ok(reads <= 4 * size, `full-lane reads ${reads} exceed linear bound ${4 * size}`);
    } finally { store.close(); h.cleanup(); }
  });
}

test("filtered multi-bee views stay fresh across controls, audit replay and reopen", () => {
  const h = harness();
  let store = h.open();
  try {
    const { bee: a } = makeBee(store, "a");
    const { bee: b } = makeBee(store, "b");
    const aa = enqueue(store, a.id, 4, "a");
    enqueue(store, b.id, 2, "b");
    const check = () => {
      for (const filter of [{}, { statuses: ["queued"] as ActionStatus[] }, { statuses: ["cancelled"] as ActionStatus[] }, { statuses: [] }]) {
        assert.deepEqual(store.listActionViews(filter), store.listActions(filter).map((r) => toActionView(r, store.listActionsOf(r.beeId), store.getActionQueue(r.beeId))));
      }
      assert.deepEqual(replayAudit(store.auditTail(0, 100_000)), store.dumpState());
    };
    check();
    store.cancelAction(aa[0]!.id);
    store.pauseActionQueue(a.id);
    check();
    assert.equal(store.listActionViews({ beeId: a.id, statuses: ["queued"] })[0]!.hold?.reason, "paused");
    store.resumeActionQueue(a.id);
    store.reorderActions(a.id, [aa[3]!.id, aa[2]!.id, aa[1]!.id]);
    check();
    const expected = store.listActionViews();
    store.close(); store = h.open();
    assert.deepEqual(store.listActionViews(), expected);
    check();
  } finally { store.close(); h.cleanup(); }
});

test("batch holds preserve predecessor, pause and active-row priority for every four-row status shape", () => {
  const h = harness();
  const store = h.open();
  try {
    const { bee } = makeBee(store);
    const template = enqueue(store, bee.id, 1)[0]!;
    const statuses: ActionStatus[] = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"];
    for (let n = 0; n < 6 ** 4; n++) for (const paused of [false, true]) {
      const lane = Object.freeze(Array.from({ length: 4 }, (_, i) => Object.freeze({ ...template, id: `id-${i}`, position: i * 3 + 1, status: statuses[Math.floor(n / 6 ** i) % 6]! })));
      const queue = { ...store.getActionQueue(bee.id)!, paused };
      const originalList = store.listActions.bind(store), originalLane = store.listActionsOf.bind(store), originalQueue = store.getActionQueue.bind(store);
      try {
        store.listActions = () => lane.filter((r) => r.status === "queued");
        store.listActionsOf = () => lane as unknown as ActionRow[];
        store.getActionQueue = () => queue;
        const actual = store.listActionViews();
        assert.deepEqual(actual, lane.filter((r) => r.status === "queued").map((r) => toActionView(r, lane, queue)));
      } finally { store.listActions = originalList; store.listActionsOf = originalLane; store.getActionQueue = originalQueue; }
    }
  } finally { store.close(); h.cleanup(); }
});
