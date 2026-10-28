import { test } from "node:test";
import assert from "node:assert/strict";
import { bindSpawnParent, spawnCallerBee } from "../src/spawnLineage.ts";
import { RpcError } from "../src/protocol.ts";
import type { ProcessInspection } from "../../harness/src/processIdentity.ts";

const bootId = "11111111-1111-1111-1111-111111111111";
const proc = (pid: number, ppid: number): Extract<ProcessInspection, {kind: "present"}> => ({
  kind: "present", pid, ppid, uid: 1000, pgid: 2, state: "live", birth: `linux:${pid}`, bootId, startedAtMs: 1, waitStatus: null,
});
const refused = (error: unknown) => error instanceof RpcError && error.code === "caller_not_trusted";

test("spawn lineage binds authenticated bee and preserves operator delegation", () => {
  assert.deepEqual(bindSpawnParent({ name: "helper" }, "caller"), { name: "helper", parentId: "caller", parentExternal: false });
  assert.deepEqual(bindSpawnParent({ parentId: "caller" }, "caller"), { parentId: "caller", parentExternal: false });
  for (const params of [{ parentId: "other" }, { parentId: null }, { parentId: "caller", parentExternal: true }]) {
    assert.throws(() => bindSpawnParent(params, "caller"), refused);
  }
  for (const params of [{ parentId: "other" }, { parentId: null }, { parentId: "external", parentExternal: true }]) {
    assert.throws(() => bindSpawnParent(params, null), refused);
    assert.equal(bindSpawnParent(params, null, true), params);
  }
  assert.deepEqual(bindSpawnParent({ name: "default-root" }, null), { name: "default-root" });
});

test("spawn peer authentication follows exact process ancestry and chooses the closest bee", () => {
  const processes = new Map([proc(4, 3), proc(3, 2), proc(2, 1), proc(1, 0)].map(value => [value.pid, value]));
  const inspect = (pid: number): ProcessInspection => processes.get(pid) ?? { kind: "gone" };
  const peer = { pid: 4, uid: 1000, processBirth: "linux:4" };
  assert.equal(spawnCallerBee(peer, [{ beeId: "parent", identity: proc(2, 1) }], inspect), "parent");
  assert.equal(spawnCallerBee(peer, [{ beeId: "parent", identity: proc(2, 1) }, { beeId: "nested", identity: proc(3, 2) }], inspect), "nested");
  assert.equal(spawnCallerBee(peer, [], inspect), null);
  assert.equal(spawnCallerBee(peer, [{ beeId: "unrelated", identity: null, pid: 99 }], inspect), null);
  assert.throws(() => spawnCallerBee(peer, [{ beeId: "unresolved", identity: null, pid: 3 }], inspect), refused);
  assert.throws(() => spawnCallerBee({ ...peer, processBirth: "linux:999" }, [], inspect), refused);
  processes.set(3, { ...proc(3, 2), ppid: 4 });
  assert.throws(() => spawnCallerBee(peer, [], inspect), refused);
});

test("spawn refuses missing ancestry evidence and process replacement during inspection", () => {
  const peer = { pid: 4, uid: 1000, processBirth: "linux:4" };
  assert.throws(() => spawnCallerBee(peer, [], () => ({ kind: "unavailable", reason: "permission_denied" })), refused);
  let reads = 0;
  assert.throws(() => spawnCallerBee(peer, [{ beeId: "caller", identity: proc(4, 0) }], () => ({ ...proc(4, 0), birth: ++reads === 1 ? "linux:4" : "linux:99" })), refused);
  assert.equal(spawnCallerBee(peer, [{ beeId: "recycled", identity: { ...proc(4, 0), birth: "linux:99" } }], () => proc(4, 0)), null);
});

test("gateway ancestry refuses peer and runtime PID reuse and reparenting during the final fence", () => {
  const peer = { pid: 4, uid: 1000, processBirth: "linux:4" };
  assert.equal(spawnCallerBee(peer, [{ beeId: "reused", identity: { ...proc(4, 0), birth: "linux:old" } }], () => proc(4, 0)), null);
  assert.throws(() => spawnCallerBee(peer, [{ beeId: "runtime", identity: proc(4, 0) }], () => ({ ...proc(4, 0), birth: "linux:new" })), refused);
  const reads = new Map<number, number>();
  assert.throws(() => spawnCallerBee(peer, [{ beeId: "runtime", identity: proc(2, 1) }], pid => {
    const count = (reads.get(pid) ?? 0) + 1;
    reads.set(pid, count);
    const value = proc(pid, pid - 1);
    return pid === 3 && count > 1 ? { ...value, ppid: 1 } : value;
  }), refused);
});
