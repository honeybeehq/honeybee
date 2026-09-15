import { test } from "node:test";
import assert from "node:assert/strict";
import { bootToRunning, harness } from "./helpers.ts";

test("single-bee reads stay fresh across writes, rollback and generation fencing", (t) => {
  const h = harness();
  t.after(() => h.cleanup());
  const store = h.open();
  t.after(() => store.close());
  const id = "worker";
  assert.equal(store.currentRuntime(id), null);
  assert.deepEqual(store.activeFlags(id), []);
  store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
  bootToRunning(store, id, 101, 11);
  assert.equal(store.view(id).runtimeState, "running");

  store.setFlag(id, "auth_needed", "sign in");
  assert.deepEqual(store.view(id).flags, ["auth_needed"]);
  const runtime = store.currentRuntime(id);
  const flag = store.activeFlags(id)[0];
  assert.ok(runtime);
  assert.ok(flag);
  runtime.state = "stopped";
  flag.detail = "caller mutation";
  assert.equal(store.currentRuntime(id)?.state, "running");
  assert.equal(store.activeFlags(id)[0]?.detail, "sign in");

  store.updateRuntimeState(id, 1, "idle", { recordOutput: true });
  const settled = store.view(id);
  assert.equal(settled.runtimeState, "idle");
  assert.throws(() => store.transact(() => {
    store.setFlag(id, "resource_blocked", "temporary");
    store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
    store.reviveBee(id);
    assert.equal(store.currentRuntime(id)?.generation, 2);
    assert.deepEqual(store.view(id).flags, ["auth_needed", "resource_blocked"]);
    throw new Error("rollback probe");
  }), /rollback probe/);
  assert.deepEqual(store.view(id), settled);

  store.clearFlag(id, "auth_needed");
  assert.deepEqual(store.view(id).flags, []);
  store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
  store.reviveBee(id);
  assert.equal(store.currentRuntime(id)?.generation, 2);
  assert.equal(store.updateRuntimeState(id, 1, "idle").applied, false);
  assert.equal(store.view(id).generation, 2);
  assert.equal(store.view(id).runtimeState, "booting");
});

test("single-bee reads remain isolated between stores and after reopen or deletion", (t) => {
  const a = harness();
  const b = harness();
  t.after(() => { a.cleanup(); b.cleanup(); });
  let first = a.open();
  const second = b.open();
  t.after(() => { first.close(); second.close(); });
  const id = "same-id";
  for (const store of [first, second]) {
    store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
  }
  first.setFlag(id, "auth_needed", "first store");
  second.setFlag(id, "resource_blocked", "second store");
  first.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
  first.reviveBee(id);
  assert.equal(first.view(id).generation, 2);
  assert.deepEqual(first.view(id).flags, ["auth_needed"]);
  assert.equal(second.view(id).generation, 1);
  assert.deepEqual(second.view(id).flags, ["resource_blocked"]);

  const expected = first.view(id);
  first.close();
  first = a.open();
  assert.deepEqual(first.view(id), expected);
  first.deleteBee(id);
  assert.equal(first.currentRuntime(id), null);
  assert.deepEqual(first.activeFlags(id), []);
  assert.equal(first.view(id).exists, false);
  assert.equal(second.view(id).exists, true);
  assert.deepEqual(second.view(id).flags, ["resource_blocked"]);
});
