import { test } from "node:test";
import assert from "node:assert/strict";
import { CoreError, beeRefCandidate, openCoreStore, toBeeHandoffView, toBeeMoveView, type BeeViewRow, type CoreStore } from "../src/index.ts";
import { STORE_PAGE_CACHE_KIB } from "../src/store.ts";
import { bootToRunning, harness, makeBee } from "./helpers.ts";
import { PHONE_FORMAT, type PhoneOriginRequest } from "../src/phoneOrigin.ts";

function phoneOrigin(id: string): PhoneOriginRequest {
  return { format: PHONE_FORMAT, channel: "phone", issuerNodeId: "test-node", assigner: "listener/1", credentialRef: "opaque-device", target: { kind: "bee", id }, contentKind: "initial-prompt", assurance: "credential-possession-only", humanApproval: "not-verified", lane: "envelope-v1", parentSources: [], rootSources: [], ancestry: "complete" };
}

function authoritative(store: CoreStore, beeId: string): BeeViewRow {
  const bee = store.getBee(beeId)!;
  const move = store.latestMoveOf(beeId), handoff = store.latestHandoffOf(beeId);
  return { bee, runtime: store.currentRuntime(beeId), view: store.view(beeId), move: move ? toBeeMoveView(move) : null, cell: bee.cellId ? store.getCell(bee.cellId) : null, handoff: handoff ? toBeeHandoffView(handoff) : null };
}

function countingStatements<T>(store: CoreStore, run: () => T): { result: T; statements: number } {
  const target = store as unknown as { stmt: (sql: string) => object };
  const original = target.stmt;
  let statements = 0;
  target.stmt = function (sql: string) {
    const statement = original.call(this, sql);
    return new Proxy(statement, { get(inner, key) {
      const value = Reflect.get(inner, key, inner) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (key === "all" || key === "get" || key === "run") statements += 1;
        return (value as (...values: unknown[]) => unknown).apply(inner, args);
      };
    } });
  };
  try { return { result: run(), statements }; }
  finally { target.stmt = original; }
}

function plan(store: CoreStore, sql: string, ...args: Array<string | number>): string {
  const db = (store as unknown as { db: { prepare: (text: string) => { all: (...values: Array<string | number>) => Array<{ detail: string }> } } }).db;
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join("\n");
}

test("archived pages walk newest-archived first by keyset and match the authoritative per-bee reads", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  let clock = 5_000_000;
  const store = openCoreStore(h.path, { ephemeral: true, now: () => clock });
  t.after(() => store.close());
  const archived: string[] = [];
  for (let i = 0; i < 9; i++) {
    const { bee } = store.createBee({ id: `bee-${i}`, name: `worker-${i}`, agent: "stub", substrate: "hsr", cwd: "/tmp" });
    if (i === 8) continue;
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
    clock = 6_000_000 + Math.floor(i / 3) * 1_000;
    store.archiveBee(bee.id);
    archived.push(bee.id);
  }
  const newestFirst = ["bee-7", "bee-6", "bee-5", "bee-4", "bee-3", "bee-2", "bee-1", "bee-0"];
  const walked: string[] = [];
  let after: { archivedAt: number; id: string } | undefined;
  for (;;) {
    const page = store.listBeeViewRows("archived", { limit: 3, ...(after ? { after } : {}) });
    for (const row of page) assert.deepEqual(row, authoritative(store, row.bee.id));
    walked.push(...page.map(row => row.bee.id));
    if (page.length < 3) break;
    const last = page[page.length - 1]!.bee;
    after = { archivedAt: last.archivedAt!, id: last.id };
  }
  assert.deepEqual(walked, newestFirst);
  assert.deepEqual(new Set(walked), new Set(archived));

  const first = store.listBeeViewRows("archived", { limit: 3 });
  const cursor = { archivedAt: first[2]!.bee.archivedAt!, id: first[2]!.bee.id };
  store.unarchiveBee("bee-4");
  store.deleteBee("bee-3");
  clock = 9_000_000;
  store.updateRuntimeState("bee-8", 1, "stopped", { exitCause: "clean" });
  store.archiveBee("bee-8");
  assert.deepEqual(store.listBeeViewRows("archived", { limit: 10, after: cursor }).map(row => row.bee.id), ["bee-2", "bee-1", "bee-0"]);
  assert.deepEqual(store.listBeeViewRows("archived", { limit: 2 }).map(row => row.bee.id), ["bee-8", "bee-7"]);

  assert.throws(() => store.listBeeViewRows("active", { limit: 3 }), CoreError);
  assert.throws(() => store.listBeeViewRows(null, { limit: 3 }), CoreError);
  const paged = plan(store, "SELECT bees.id FROM bees INDEXED BY bees_archived_recent WHERE bees.lifecycle = 'archived' AND (bees.archived_at, bees.id) < (?, ?) ORDER BY bees.archived_at DESC, bees.id DESC LIMIT ?", 1, "x", 3);
  assert.match(paged, /bees_archived_recent/);
  assert.doesNotMatch(paged, /TEMP B-TREE/);
});

test("bee reads carry human output facts and the phone origin in one statement per read", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const { bee: explicit } = makeBee(store, "explicit");
  bootToRunning(store, explicit.id, 7, 7);
  store.setHumanOutputMode(explicit.id, "explicit", "mode");
  const { message } = store.send(explicit.id, "hello", { sender: "operator", senderKind: "human" });
  store.markDelivered(message.id, store.currentRuntime(explicit.id)!.generation, { kind: "human", from: "operator" });
  const { bee: answered } = makeBee(store, "answered");
  bootToRunning(store, answered.id, 8, 8);
  store.setHumanOutputMode(answered.id, "explicit", "mode");
  const second = store.send(answered.id, "hello", { sender: "operator", senderKind: "human" }).message;
  store.markDelivered(second.id, store.currentRuntime(answered.id)!.generation, { kind: "human", from: "operator" });
  store.tellHuman({ beeId: answered.id, text: "reply", idempotencyKey: "tell" });
  const { bee: phone } = store.createBee({ id: "phone-operation", name: "phone-operation", agent: "inbox", substrate: "hsr", cwd: "", phoneOperation: { origin: phoneOrigin("phone-operation"), key: "operation" } });
  const { bee: plain } = makeBee(store, "plain");
  const { bee: child } = store.createBee({ name: "child", agent: "stub", substrate: "hsr", cwd: "/tmp", parentId: explicit.id });

  const listed = new Map(store.listBees().map(row => [row.id, row]));
  assert.equal(listed.get(explicit.id)!.humanOutputMode, "explicit");
  assert.equal(listed.get(explicit.id)!.unansweredHumanMessage!.messageId, message.id);
  assert.equal(listed.get(answered.id)!.unansweredHumanMessage, null);
  assert.notEqual(listed.get(answered.id)!.lastHumanAcknowledgementAt, null);
  assert.deepEqual(listed.get(plain.id)!.humanOutputMode, "legacy");
  assert.equal(listed.get(plain.id)!.humanAcknowledgementTrackingSince, null);
  assert.ok(listed.get(phone.id)!.phoneOperationOrigin);
  assert.equal("phoneOperationOrigin" in listed.get(plain.id)!, false);
  for (const lifecycle of [null, "active"]) {
    for (const row of store.listBeeViewRows(lifecycle)) assert.deepEqual(row, authoritative(store, row.bee.id));
  }
  assert.deepEqual(store.listChildren(explicit.id), [store.getBee(child.id)]);
  assert.deepEqual(JSON.stringify(store.listBees().find(row => row.id === explicit.id)), JSON.stringify(store.getBee(explicit.id)));

  assert.equal(countingStatements(store, () => store.getBee(explicit.id)).statements, 1);
  const few = countingStatements(store, () => store.listBees());
  for (let i = 0; i < 40; i++) makeBee(store, `more-${i}`);
  const many = countingStatements(store, () => store.listBees());
  assert.equal(few.statements, 1);
  assert.equal(many.statements, 1);
  assert.equal(many.result.length, few.result.length + 40);
  const activeFew = countingStatements(store, () => store.listBeeViewRows("active")).statements;
  for (let i = 0; i < 40; i++) makeBee(store, `again-${i}`);
  assert.equal(countingStatements(store, () => store.listBeeViewRows("active")).statements, activeFew);
});

test("a filtered list reads only its own bees", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  for (let i = 0; i < 6; i++) {
    const { bee } = store.createBee({ id: `bee-${i}`, name: `worker-${i}`, agent: "stub", substrate: "hsr", cwd: "/tmp" });
    if (i % 2 === 0) continue;
    store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
    store.archiveBee(bee.id);
  }
  const target = store as unknown as { stmt: (sql: string) => object };
  const original = target.stmt;
  const texts: string[] = [];
  target.stmt = function (sql: string) { texts.push(sql); return original.call(this, sql); };
  try { assert.deepEqual(store.listBeeViewRows("active").map(row => row.bee.id), ["bee-0", "bee-2", "bee-4"]); }
  finally { target.stmt = original; }
  const runtimes = texts.find(sql => sql.includes("SELECT runtime.*"))!;
  assert.match(runtimes, /json_each/);
  assert.doesNotMatch(plan(store, runtimes, JSON.stringify(["bee-0"])), /SCAN (bee|bees|runtime)\b/);
  const bees = texts.find(sql => sql.includes("WHERE bees.lifecycle = ?"))!;
  assert.match(plan(store, bees, "active"), /SEARCH bees USING INDEX bees_by_lifecycle/);
});

test("runtimesByPid is a keyed read equal to the roster scan it replaces", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { bee } = store.createBee({ id: `bee-${i}`, name: `worker-${i}`, agent: "stub", substrate: i % 2 === 0 ? "hsr" : "cell", cwd: "/tmp" });
    ids.push(bee.id);
    bootToRunning(store, bee.id, 100 + (i % 3), 10 + i);
    if (i >= 3) {
      store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "clean" });
      store.reviveBee(bee.id);
      bootToRunning(store, bee.id, 100 + (i % 3), 50 + i);
    }
    if (i === 5) store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "clean" });
  }
  makeBee(store, "never-booted");
  const roster = store.listBees().flatMap(bee => store.listRuntimes(bee.id).map(runtime => ({ beeId: bee.id, generation: runtime.generation, substrate: bee.substrate, stopped: runtime.state === "stopped", pid: runtime.pid })));
  for (const pid of [100, 101, 102, 999]) {
    assert.deepEqual(store.runtimesByPid(pid), roster.filter(runtime => runtime.pid === pid).map(({ pid: _pid, ...runtime }) => runtime));
  }
  assert.equal(store.runtimesByPid(100).length, 3);
  assert.equal(countingStatements(store, () => store.runtimesByPid(100)).statements, 1);
  const keyed = plan(store, "SELECT runtime.bee_id FROM runtimes AS runtime JOIN bees AS bee ON bee.id = runtime.bee_id WHERE runtime.pid = ? ORDER BY runtime.bee_id, runtime.generation", 100);
  assert.match(keyed, /SEARCH runtime USING INDEX runtimes_by_pid/);
  assert.doesNotMatch(keyed, /SCAN (runtime|bee)\b/);
});

test("lifecycle-scoped collections equal the full collections restricted to that lifecycle", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const beeIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const { bee } = store.createBee({ id: `bee-${i}`, name: `worker-${i}`, agent: "stub", substrate: "hsr", cwd: "/tmp" });
    beeIds.push(bee.id);
    bootToRunning(store, bee.id, 200 + i, 20 + i);
    store.createSeal(bee.id, { id: `seal-${i}`, title: `result ${i}`, body: "body" });
    store.askQuestion(bee.id, { id: `question-${i}`, text: `question ${i}` });
    store.setTaskSupply(bee.id, { on: true });
    store.addTask({ list: `bee:${bee.id}`, title: `task ${i}`, originKind: "user", originSender: "operator" });
    store.setHumanFirstPolicy(bee.id, true);
    store.setMailBatchingPolicy(bee.id, true);
    store.setHumanOutputMode(bee.id, "explicit", "mode");
    store.tellHuman({ beeId: bee.id, text: `tell ${i}`, idempotencyKey: `tell-${i}` });
  }
  store.addTask({ list: "shared:pool", title: "no owner", originKind: "user", originSender: "operator" });
  for (const id of ["bee-1", "bee-3", "bee-5"]) {
    store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
    store.archiveBee(id);
  }
  for (const lifecycle of ["active", "archived"] as const) {
    const members = new Set(store.listBeeViewRows(lifecycle).map(row => row.bee.id));
    assert.equal(members.size, 3);
    const own = <T extends { beeId: string | null }>(rows: T[]): T[] => rows.filter(row => row.beeId !== null && members.has(row.beeId));
    assert.deepEqual(store.listSeals({ lifecycle }), own(store.listSeals()));
    assert.deepEqual(store.listQuestions({ lifecycle }), own(store.listQuestions()));
    assert.deepEqual(store.listTaskSupply({ lifecycle }), own(store.listTaskSupply()));
    assert.deepEqual(store.listTasks({ lifecycle }), store.listTasks().filter(task => task.beeId === null || members.has(task.beeId)));
    assert.deepEqual(store.listHumanFirstPolicies(lifecycle), own(store.listHumanFirstPolicies()));
    assert.deepEqual(store.listMailBatchingPolicies(lifecycle), own(store.listMailBatchingPolicies()));
    assert.deepEqual(store.listTells(lifecycle), own(store.listTells()));
    assert.deepEqual(store.listReactions(lifecycle), own(store.listReactions()));
    assert.deepEqual(store.listTranscriptSegments(undefined, lifecycle), own(store.listTranscriptSegments()));
    assert.deepEqual(store.listMailBatches(undefined, lifecycle), own(store.listMailBatches()));
    assert.deepEqual(store.listQuotaRecoveries(undefined, lifecycle), own(store.listQuotaRecoveries()));
    assert.deepEqual(store.listBeeMoves(lifecycle), own(store.listBeeMoves()));
    assert.deepEqual(store.listBeeHandoffs(lifecycle), own(store.listBeeHandoffs()));
    assert.deepEqual(store.listActionViews({ lifecycle }), own(store.listActionViews()));
    assert.deepEqual(store.listActionQueueViews(lifecycle), own(store.listActionQueueViews()));
    assert.deepEqual(store.listCells(lifecycle), store.listCells().filter(cell => store.listBeeViewRows(lifecycle).some(row => row.bee.cellId === cell.id)));
    assert.equal(store.listSeals({ lifecycle }).length, 3);
    assert.equal(store.listTells(lifecycle).length, 3);
    assert.equal(store.listTranscriptSegments(undefined, lifecycle).length, 3);
    assert.equal(store.listTasks({ lifecycle }).length, 4);
  }
});

test("a durable store keeps the measured page cache; no memory map", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = openCoreStore(h.path, { now: h.now });
  t.after(() => store.close());
  const db = (store as unknown as { db: { prepare: (text: string) => { get: () => Record<string, number> } } }).db;
  assert.equal(STORE_PAGE_CACHE_KIB, 32 * 1024);
  assert.equal(db.prepare("PRAGMA cache_size").get().cache_size, -STORE_PAGE_CACHE_KIB);
  assert.equal(db.prepare("PRAGMA mmap_size").get().mmap_size, 0);
});

test("a reference read returns exactly the bees the reference can name, at any lifecycle", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const rows = [
    { id: "0a11aaaa-0000-4000-8000-000000000001", name: "alpha", handle: "CO.9652" },
    { id: "0a11aaaa-0000-4000-8000-000000000002", name: "beta", handle: "CO.9653" },
    { id: "0a11bbbb-0000-4000-8000-000000000003", name: "alpha", handle: "CL.1a2" },
    { id: "9c22cccc-0000-4000-8000-000000000004", name: "Ærlig", handle: "GR.0f0" },
    { id: "9c22dddd-0000-4000-8000-000000000005", name: "alphabet", handle: "IN.abc" },
  ];
  for (const row of rows) {
    store.createBee({ ...row, agent: "stub", substrate: "hsr", cwd: "/tmp" });
    store.updateRuntimeState(row.id, 1, "stopped", { exitCause: "clean" });
  }
  store.archiveBee(rows[1]!.id);
  store.archiveBee(rows[4]!.id);
  const whole = store.listBeeViewRows();
  for (const ref of ["alpha", "alp", "al", "co.9652", "CO.965", "0a11", "0a11aaaa-0000-4000-8000-000000000002", "ærlig", "Ærl", "gr.0F0", "nobody", "x"]) {
    assert.deepEqual(store.listBeeViewRowsForRefs([ref]), whole.filter(row => beeRefCandidate(row.bee, ref)), ref);
  }
  assert.deepEqual(store.listBeeViewRowsForRefs(["alpha"]).map(row => row.bee.id), [rows[0]!.id, rows[2]!.id, rows[4]!.id]);
  assert.deepEqual(store.listBeeViewRowsForRefs(["CO.965"]).map(row => row.bee.lifecycle), ["active", "archived"]);
  assert.deepEqual(store.listBeeViewRowsForRefs(["nobody"]), []);
  assert.deepEqual(store.listBeeViewRowsForRefs(["gr.0F0", "alpha", "nobody", "alp"]).map(row => row.bee.id), [rows[0]!.id, rows[2]!.id, rows[3]!.id, rows[4]!.id]);
  const few = countingStatements(store, () => store.listBeeViewRowsForRefs(["alpha"])).statements;
  for (let i = 0; i < 30; i++) makeBee(store, `filler-${i}`);
  assert.equal(countingStatements(store, () => store.listBeeViewRowsForRefs(["alpha"])).statements, few);
});
