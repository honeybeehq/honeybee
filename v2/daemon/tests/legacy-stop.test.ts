import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {harness} from "../../core/tests/helpers.ts";
import {legacyStopRelease} from "../../core/src/legacyStop.ts";
import {DaemonCore} from "../src/loops.ts";
import {FakeDriver} from "./helpers.ts";

const release = {generation: 1, pid: 123, pidStartedAt: 1234000, uid: 1000, birth: "linux:1234", bootId: "be5cb902-bbde-4bf1-8e0c-2c3a05c84ea2", authorityRef: "private operator release"};
function fixture() {
  const h = harness(), store = h.open();
  const {bee} = store.createBee({name: "legacy", agent: "stub", substrate: "hsr", cwd: "/tmp"});
  const db = (store as unknown as {db: DatabaseSync}).db;
  store.recordRuntimeProc(bee.id, 1, release);
  store.updateRuntimeState(bee.id, 1, "running");
  store.updateRuntimeState(bee.id, 1, "idle");
  db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
  for (const cmd of db.prepare("SELECT id FROM commands WHERE bee_id=?").all(bee.id)) store.completeCommand(Number(cmd.id));
  store.send(bee.id, "private queued mail");
  store.archiveBee(bee.id);
  return {h, store, bee, db};
}

test("legacy stop release shape is closed and requires explicit Linux operator authority", () => {
  assert.deepEqual(legacyStopRelease(release), release);
  for (const invalid of [null, {}, {...release, authorityRef: " "}, {...release, extra: true}, {...release, birth: "darwin:123:0", bootId: ""}, {...release, pid: 0}, {...release, generation: 0}, {...release, uid: -1}, {...release, pidStartedAt: null}]) assert.equal(legacyStopRelease(invalid), null);
});

for (const wrong of ["active", "generation", "pid", "stamp", "stopped", "pending", "malformed", "bound", "substrate"] as const) test(`legacy release rejects ${wrong} without mutation`, () => {
  const {h,store,bee,db} = fixture();
  try {
    let request = {...release};
    if (wrong === "active") store.unarchiveBee(bee.id);
    if (wrong === "generation") request.generation++;
    if (wrong === "pid") request.pid++;
    if (wrong === "stamp") request.pidStartedAt++;
    if (wrong === "stopped") store.updateRuntimeState(bee.id, 1, "stopped", {exitCause: "clean"});
    if (wrong === "substrate") db.prepare("UPDATE bees SET substrate='tmux' WHERE id=?").run(bee.id);
    if (["pending","malformed","bound"].includes(wrong)) db.prepare("UPDATE runtimes SET process_identity=? WHERE bee_id=?").run(wrong === "pending" ? '{"kind":"pending-new-start"}' : wrong === "malformed" ? '{broken' : JSON.stringify({pid:release.pid,birth:release.birth,bootId:release.bootId}), bee.id);
    const before = store.auditTail(0,1000);
    assert.throws(() => store.enqueueLegacyStop(bee.id, request, "release"), /changed/);
    assert.deepEqual(store.auditTail(0,1000), before);
  } finally {store.close();h.cleanup();}
});

test("only the exact release command bypasses the unresolved identity fence, once across reopen", () => {
  const f = fixture(); let store = f.store;
  try {
    const ordinary = store.enqueueCommand("stop", f.bee.id, {reason:"degraded_runtime"});
    const archive = store.enqueueCommand("archive", f.bee.id);
    const wake = store.enqueueCommand("send_wake", f.bee.id);
    const released = store.enqueueLegacyStop(f.bee.id, release, "release");
    const blockedIdentityBeeIds = new Set([f.bee.id]);
    assert.equal(store.claimNextCommand({blockedIdentityBeeIds}), null);
    assert.equal(store.enqueueLegacyStop(f.bee.id, release, "release").id, released.id);
    assert.throws(() => store.enqueueLegacyStop(f.bee.id, {...release, authorityRef:"different"}, "release"), /conflict/);
    store.close();store=f.h.open();
    assert.equal(store.pendingLegacyStop(f.bee.id, 1)!.id, released.id);
    assert.equal(store.claimNextCommand({blockedIdentityBeeIds,releasedStopCommandIds:new Set([released.id])})!.id, released.id);
    assert.equal(store.claimNextCommand({blockedIdentityBeeIds,releasedStopCommandIds:new Set([released.id])}),null);
    assert.equal(store.getCommand(ordinary.id)!.status,"queued");
    assert.notEqual(store.getCommand(wake.id)!.status,"running");
    assert.notEqual(store.getCommand(archive.id)!.status,"running");
    assert.equal(store.runtimeProcessIdentity(f.bee.id,1).kind,"legacy");
    assert.equal(store.auditTail(0,1000).filter(a=>a.kind==="runtime.legacy_stop_released").length,1);
  } finally {store.close();f.h.cleanup();}
});

for (const observedExit of [false,true]) test(`released archived stop cannot wake queued mail after ${observedExit ? "observed" : "already gone"} exit or restart`, () => {
  const {h,store,bee,db} = fixture();
  try {
    const ordinary = store.enqueueCommand("stop",bee.id,{reason:"degraded_runtime"});
    const wake = store.enqueueCommand("send_wake",bee.id);
    const revive = store.enqueueCommand("revive",bee.id);
    db.prepare("UPDATE commands SET target_generation=NULL WHERE id IN (?,?)").run(wake.id,revive.id);
    const released = store.enqueueLegacyStop(bee.id,release,"release");
    const driver = new FakeDriver(()=>10000000);driver.acceptDeliveries=false;
    if (observedExit) driver.procs.set(bee.id,{generation:1,pid:123,pidStartedAt:1234000,degraded:true});
    let signals=0;
    const core = new DaemonCore({store,driver,now:()=>10000000,log(){},policy:{commandsPerStep:8,bootHangTimeoutSteps:60},releasedStopCommandIds:()=>new Set([released.id]),stopReleased:()=>{
      signals++;
      if(observedExit){driver.procs.delete(bee.id);driver.events.push({kind:"exited",beeId:bee.id,generation:1,exitCause:"stopped_by_user"});}
      return {hadProcess:observedExit};
    }});
    core.boot([{beeId:bee.id,generation:1}]);core.step();core.step();
    assert.equal(store.currentRuntime(bee.id)!.state,"stopped");
    core.resolveProcessIdentity(bee.id,1);core.step();core.step();
    const restarted = new DaemonCore({store,driver,now:()=>10000000,log(){},policy:{commandsPerStep:8,bootHangTimeoutSteps:60}});restarted.boot([]);restarted.step();
    assert.equal(signals,1);
    assert.equal(store.getCommand(ordinary.id)!.status,"done");
    assert.equal(store.getCommand(wake.id)!.status,"done");
    assert.equal(store.getCommand(revive.id)!.status,"done");
    assert.deepEqual(store.auditTail(0,1000).filter(a=>a.kind==="command.moot" && a.payload.reason==="legacy_stop_released").map(a=>a.payload.commandId),[wake.id,revive.id]);
    assert.equal(store.getBee(bee.id)!.lifecycle,"archived");
    assert.equal(store.currentRuntime(bee.id)!.generation,1);
    assert.equal(store.undeliveredMessages(bee.id).length,1);
    assert.equal(store.enqueueWake(bee.id).outcome,"fenced");
    store.unarchiveBee(bee.id);
    assert.equal(store.enqueueWake(bee.id).outcome,"enqueued");
  } finally {store.close();h.cleanup();}
});
