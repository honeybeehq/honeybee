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

test("macOS ancestry ends at the first other-user ancestor that proc_pidinfo refuses, without losing the nearest bee", () => {
  const mac = (pid: number, ppid: number, uid = 501): Extract<ProcessInspection, {kind: "present"}> => ({
    kind: "present", pid, ppid, uid, pgid: pid, state: "live", birth: `darwin:1793200000:${pid}`, bootId: "", startedAtMs: 1793200000000, waitStatus: null,
  });
  const denied: ProcessInspection = { kind: "unavailable", reason: "permission_denied" };
  const chain = (...values: ProcessInspection[]) => {
    const processes = new Map<number, ProcessInspection>();
    for (const [index, value] of values.entries()) processes.set(value.kind === "present" ? value.pid : -index, value);
    return (pid: number): ProcessInspection => processes.get(pid) ?? (pid === 1 || pid === 300 ? denied : { kind: "gone" });
  };
  const runner = chain(mac(700, 600), mac(600, 550), mac(550, 510), mac(510, 505), mac(505, 1));
  const terminal = chain(mac(470, 460), mac(460, 300));
  const ci = { pid: 700, uid: 501, processBirth: "darwin:1793200000:700" };
  const cli = { pid: 470, uid: 501, processBirth: "darwin:1793200000:470" };
  assert.equal(spawnCallerBee(ci, [], runner), null);
  assert.equal(spawnCallerBee(cli, [], terminal), null);
  assert.equal(spawnCallerBee(cli, [{ beeId: "stale", identity: null, pid: null }], terminal), null);
  assert.equal(spawnCallerBee(ci, [{ beeId: "bee", identity: mac(550, 510) }], runner), "bee");
  assert.equal(spawnCallerBee(ci, [{ beeId: "bee", identity: mac(550, 510), pid: 550 }], runner), "bee");
  assert.throws(() => spawnCallerBee(cli, [{ beeId: "hidden", identity: null, pid: 300 }], terminal), refused);
  assert.throws(() => spawnCallerBee(cli, [{ beeId: "hidden", identity: { ...mac(300, 1), birth: "darwin:1793200000:300" } }], terminal), refused);
  assert.throws(() => spawnCallerBee(cli, [], () => denied), refused);
  for (const failure of [{ kind: "gone" }, { kind: "unavailable", reason: "native_observation_failed" }, { kind: "unavailable", reason: "artifact_unavailable" }, { ...mac(460, 300), state: "zombie" }] as ProcessInspection[]) {
    assert.throws(() => spawnCallerBee(cli, [], pid => pid === 460 ? failure : terminal(pid)), refused);
  }
  let reads = 0;
  assert.throws(() => spawnCallerBee(cli, [], pid => pid === 460 && ++reads > 1 ? { ...mac(460, 1) } : terminal(pid)), refused);
});

test("a permission denial between the caller and its bee runtime never attributes past the denial", () => {
  const denied: ProcessInspection = { kind: "unavailable", reason: "permission_denied" };
  const peer = { pid: 4, uid: 1000, processBirth: "linux:4" };
  const inspect = (pid: number): ProcessInspection => pid === 4 ? proc(4, 3) : pid === 3 ? denied : pid === 2 ? proc(2, 1) : pid === 1 ? proc(1, 0) : { kind: "gone" };
  assert.equal(spawnCallerBee(peer, [{ beeId: "above", identity: proc(2, 1) }], inspect), null);
  assert.equal(spawnCallerBee(peer, [{ beeId: "above", identity: proc(2, 1), pid: 2 }], inspect), null);
  assert.throws(() => spawnCallerBee(peer, [{ beeId: "hidden", identity: proc(3, 2) }], inspect), refused);
  assert.throws(() => spawnCallerBee(peer, [{ beeId: "hidden", identity: proc(3, 2), pid: 3 }], inspect), refused);
  assert.equal(spawnCallerBee(peer, [{ beeId: "below", identity: proc(4, 3) }, { beeId: "above", identity: proc(2, 1) }], inspect), "below");
});
