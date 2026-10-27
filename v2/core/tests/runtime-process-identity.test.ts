import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {harness, makeBee} from "./helpers.ts";
import {installRuntimeProcessIdentity, processIdentityValue} from "../src/runtimeProcessIdentity.ts";

const identity = {pid: 123, birth: "darwin:1234:42", bootId: ""};
test("lifecycle exit retains the exact identity and refuses replacement after reopen", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    store.recordRuntimeProc(bee.id, generation, {pid: identity.pid, pidStartedAt: 1234000, processIdentity: identity});
    store.updateRuntimeState(bee.id, generation, "stopped", {exitCause: "clean"});
    store.close(); store = h.open();
    assert.deepEqual(store.runtimeProcessIdentity(bee.id, generation), {kind: "bound", identity, pidStartedAt: 1234000});
    assert.equal(store.recordRuntimeProc(bee.id, generation, {pid: identity.pid, pidStartedAt: 1235000, processIdentity: {...identity, birth: "darwin:1235:42"}}).applied, false);
    assert.deepEqual(store.runtimeProcessIdentity(bee.id, generation), {kind: "bound", identity, pidStartedAt: 1234000});
  } finally {store.close(); h.cleanup();}
});
test("runtime identity migration is additive, once-only and ignores malformed content", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store), rt = store.currentRuntime(bee.id)!;
    store.recordRuntimeProc(bee.id, rt.generation, {pid: 123, pidStartedAt: 1234000});
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    store.close();
    const db = new DatabaseSync(h.path);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()!.value, "53");
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='runtime_process_identity_schema'").get()!.value, "1");
    installRuntimeProcessIdentity(db); installRuntimeProcessIdentity(db);
    assert.equal(db.prepare("PRAGMA table_info(runtimes)").all().filter(r => r.name === "process_identity").length, 1);
    db.prepare("UPDATE runtimes SET process_identity=?").run("{broken"); db.close();
    store = h.open();
    assert.equal(store.runtimeProcessIdentity(bee.id, rt.generation).kind, "unavailable");
    assert.ok(store.currentRuntime(bee.id));
  } finally { store.close(); h.cleanup(); }
});
test("legacy binding is generation and stamp fenced, once only, and persists across reopen", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store), rt = store.currentRuntime(bee.id)!;
    store.recordRuntimeProc(bee.id, rt.generation, {pid: identity.pid, pidStartedAt: 1234000});
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    const hooks = store.runtimeIdentityHooks();
    assert.equal(hooks.read(bee.id, rt.generation).kind, "legacy");
    assert.equal(hooks.bindLegacy(bee.id, rt.generation + 1, 1234000, identity, "authenticated-host-generation"), false);
    assert.equal(hooks.bindLegacy(bee.id, rt.generation, 1234001, identity, "authenticated-host-generation"), false);
    assert.equal(hooks.bindLegacy(bee.id, rt.generation, 1234000, {...identity, pid: 124}, "authenticated-host-generation"), false);
    assert.equal(hooks.bindLegacy(bee.id, rt.generation, 1234000, identity, "authenticated-host-generation"), true);
    assert.equal(hooks.bindLegacy(bee.id, rt.generation, 1234000, identity, "authenticated-host-generation"), false);
    store.close(); store = h.open();
    assert.deepEqual(store.runtimeProcessIdentity(bee.id, rt.generation), {kind: "bound", identity, pidStartedAt: 1234000});
    store.close();
    const db = new DatabaseSync(h.path);
    const audits = db.prepare("SELECT * FROM audit WHERE kind='legacy_birth_bound'").all();
    assert.equal(audits.length, 1); assert.equal(JSON.stringify(audits).includes(identity.birth), false); db.close();
  } finally { store.close(); h.cleanup(); }
});
test("process identity content has a closed shape and exact platform tokens", () => {
  for (const value of [null, {}, {...identity, extra: 1}, {...identity, pid: 0}, {...identity, birth: "linux:12"}, {...identity, birth: "darwin:12:1000000"}, {...identity, bootId: "bad"}]) assert.equal(processIdentityValue(value), null);
  assert.deepEqual(processIdentityValue(identity), identity);
});
test("new PID records without exact evidence cannot enter legacy discovery", () => {
  const h = harness(), store = h.open();
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    store.recordRuntimeProc(bee.id, generation, {pid: 123, pidStartedAt: 1234000});
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "unavailable");
    assert.equal(store.runtimeIdentityHooks().bindLegacy(bee.id, generation, 1234000, identity, "authenticated-host-generation"), false);
    store.recordRuntimeProc(bee.id, generation, {pid: 123, pidStartedAt: 1234000, processIdentity: identity});
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "bound");
  } finally {store.close(); h.cleanup();}
});

test("legacy rows cannot acquire exact authority through recordRuntimeProc", () => {
  const h = harness(), store = h.open();
  try {
    const {bee} = makeBee(store);
    store.recordRuntimeProc(bee.id, 1, {pid: identity.pid, pidStartedAt: 1234000});
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    assert.throws(() => store.recordRuntimeProc(bee.id, 1, {pid: identity.pid, pidStartedAt: 1234000, processIdentity: identity}), /authenticated one-time binding/);
    store.recordRuntimeProc(bee.id, 1, {pid: identity.pid, pidStartedAt: 1234000});
    assert.equal(store.runtimeProcessIdentity(bee.id, 1).kind, "legacy");
    assert.equal(store.runtimeIdentityHooks().bindLegacy(bee.id, 1, 1234000, identity, "authenticated-host-generation"), true);
  } finally {store.close(); h.cleanup();}
});

test("pending start recovery binds once with current generation, PID and stamp fences", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    store.recordRuntimeProc(bee.id, generation, {pid: identity.pid, pidStartedAt: 1234000});
    const hooks = store.runtimeIdentityHooks();
    assert.deepEqual(hooks.read(bee.id, generation), {kind: "unavailable", reason: "pending-new-start"});
    assert.equal(hooks.bindPendingStart!(bee.id, generation + 1, 1234000, identity), false);
    assert.equal(hooks.bindPendingStart!(bee.id, generation, 1234001, identity), false);
    assert.equal(hooks.bindPendingStart!(bee.id, generation, 1234000, {...identity, pid: 124}), false);
    assert.equal(hooks.bindPendingStart!(bee.id, generation, 1234000, identity), true);
    assert.equal(hooks.bindPendingStart!(bee.id, generation, 1234000, identity), false);
    assert.equal(hooks.bindPendingStart!(bee.id, generation, 1234000, {...identity, birth: "darwin:1235:42"}), false);
    store.close(); store = h.open();
    assert.deepEqual(store.runtimeProcessIdentity(bee.id, generation), {kind: "bound", identity, pidStartedAt: 1234000});
    const audits = store.auditTail(0, 1000).filter(row => row.kind === "runtime.pending_start_bound");
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.beeId, bee.id);
    assert.equal(audits[0]!.payload.generation, generation);
  } finally {store.close(); h.cleanup();}
});

test("pending recovery refuses stopped, stale, legacy and malformed rows", () => {
  for (const state of ["stopped", "stale", "legacy", "malformed", "extra-field"] as const) {
    const h = harness(), store = h.open();
    try {
      const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
      store.recordRuntimeProc(bee.id, generation, {pid: identity.pid, pidStartedAt: 1234000});
      const db = (store as unknown as {db: DatabaseSync}).db;
      if (state === "stopped" || state === "stale") store.updateRuntimeState(bee.id, generation, "stopped", {exitCause: "clean"});
      if (state === "stale") store.reviveBee(bee.id);
      if (state === "legacy" || state === "malformed" || state === "extra-field") db.prepare("UPDATE runtimes SET process_identity=? WHERE bee_id=?").run(state === "legacy" ? null : state === "malformed" ? "{broken" : '{"kind":"pending-new-start","extra":true}', bee.id);
      const before = db.prepare("SELECT * FROM runtimes WHERE bee_id=?").all(bee.id);
      assert.equal(store.runtimeIdentityHooks().bindPendingStart!(bee.id, generation, 1234000, identity), false, state);
      assert.deepEqual(db.prepare("SELECT * FROM runtimes WHERE bee_id=?").all(bee.id), before);
      assert.equal(store.auditTail(0, 1000).filter(row => row.kind === "runtime.pending_start_bound").length, 0);
    } finally {store.close(); h.cleanup();}
  }
});

test("readiness bootstrap claim requires exact bound booting identity and commits once across reopen", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store);
    store.recordRuntimeProc(bee.id, 1, {pid: identity.pid, pidStartedAt: 1234000});
    const claim = (generation = 1, value = identity) => store.runtimeIdentityHooks().claimReadinessRecovery!(bee.id, generation, value, "hive-readiness-abcd");
    assert.equal(claim(), false);
    assert.equal(store.runtimeIdentityHooks().bindPendingStart!(bee.id, 1, 1234000, identity), true);
    assert.equal(claim(2), false);
    assert.equal(claim(1, {...identity, birth: "wrong"}), false);
    assert.throws(() => store.transact(() => {assert.equal(claim(), true); throw new Error("rollback");}), /rollback/);
    assert.equal(claim(), true);
    assert.equal(claim(), false);
    store.close(); store = h.open();
    assert.equal(claim(), false);
    const evidence = {requestId: "hive-readiness-abcd", threadId: "thread", state: "idle" as const, adapterCwd: "/tmp/alias", threadCwd: "/private/tmp/alias"};
    const record = (generation = 1, value = identity) => store.runtimeIdentityHooks().recordReadinessRecovery!(bee.id, generation, value, evidence);
    assert.equal(record(2), false);
    assert.equal(record(1, {...identity, birth: "wrong"}), false);
    assert.equal(record(), true);
    assert.equal(record(), true);
    store.close(); store = h.open();
    assert.equal(store.runtimeIdentityHooks().readinessSessionId!(bee.id, 1), "thread");
    assert.equal(store.runtimeIdentityHooks().readinessSessionId!(bee.id, 2), null);
    const recovered = store.auditTail(0, 1000).filter(row => row.kind === "runtime.readiness_recovered");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.payload.threadCwd, evidence.threadCwd);
    assert.equal(recovered[0]!.payload.adapterCwd, evidence.adapterCwd);
    store.updateRuntimeState(bee.id, 1, "stopped", {exitCause: "clean"});
    assert.equal(record(), false);
    assert.equal(claim(), false);
    assert.equal(store.auditTail(0, 1000).filter(row => row.kind === "runtime.readiness_recovery_claimed").length, 1);
  } finally {store.close(); h.cleanup();}
});
