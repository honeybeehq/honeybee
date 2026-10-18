import type {CoreStore} from "../../core/src/index.ts";
import type {DatabaseSync} from "node:sqlite";
import assert from "node:assert/strict";
import {test} from "node:test";
import {harness, makeBee} from "../../core/tests/helpers.ts";
import {inspectProcess} from "../../harness/src/processIdentity.ts";
import {IdentityRecovery} from "../src/identityRecovery.ts";
import {DaemonCore} from "../src/loops.ts";
import {FakeDriver} from "./helpers.ts";
import {makeDaemonDir} from "./helpers.ts";
import {HiveDaemon} from "../src/daemon.ts";
import {loadNodeConfig} from "../src/config.ts";
import {runtimeLabel} from "../../cli/src/render.ts";
import {ProcessIdentityUnavailableError} from "../../driver-hsr/src/psutil.ts";

test("identity recovery is bounded, fair, retries failures and warns at ten minutes", () => {
  const recovery = new IdentityRecovery();
  for (let n = 0; n < 33; n++) recovery.retain({beeId: `bee-${n}`, generation: 1, since: 100});
  let calls = 0;
  recovery.retry(100, () => {calls++; return false;}); assert.equal(calls, 16);
  recovery.retry(1099, () => {calls++; return true;}); assert.equal(calls, 16);
  assert.deepEqual(recovery.counts(600099), {count: 33, overdue: 0});
  assert.deepEqual(recovery.counts(600100), {count: 33, overdue: 33});
  recovery.retry(1100, () => {throw new Error("unavailable");}); assert.equal(recovery.entries().length, 33);
  recovery.retry(2100, () => true); assert.equal(recovery.entries().length, 17);
  recovery.retry(3100, () => true); recovery.retry(4100, () => true); assert.equal(recovery.entries().length, 0);
});

for (const verb of ["stop", "archive"] as const) test(`${verb} intent remains queued and deduplicated across restart until proof, without signaling`, () => {
  const h = harness(); let store = h.open(); let now = 10000;
  try {
    const {bee} = makeBee(store), rt = store.currentRuntime(bee.id)!;
    store.recordRuntimeProc(bee.id, rt.generation, {pid: 123, pidStartedAt: 1000});
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    const key = `identity-pending:${verb}:${bee.id}:${rt.generation}`;
    const cmd = store.enqueueCommand(verb, bee.id, {}, {idempotencyKey: key});
    assert.equal(store.enqueueCommand(verb, bee.id, {}, {idempotencyKey: key}).id, cmd.id);
    const driver = new FakeDriver(() => now);
    let stops = 0; const original = driver.stop.bind(driver);
    driver.stop = (...args) => {stops++; return original(...args);};
    const core = new DaemonCore({store, driver, now: () => now, log() {}, policy: {bootHangTimeoutSteps: 1, commandsPerStep: 8}});
    core.boot([{beeId: bee.id, generation: rt.generation}]); now += 1000000; core.step();
    assert.equal(stops, 0); assert.equal(store.getCommand(cmd.id)!.status, "queued");
    assert.equal(store.currentRuntime(bee.id)!.state, rt.state);
    const mail = store.send(bee.id, "mail while identity is unresolved"); assert.ok(mail.message.id);
    store.close(); store = h.open();
    assert.equal(store.getCommand(cmd.id)!.status, "queued");
    const restarted = new DaemonCore({store, driver, now: () => now, log() {}, policy: {bootHangTimeoutSteps: 1, commandsPerStep: 8}});
    restarted.boot([{beeId: bee.id, generation: rt.generation}]);
    assert.equal(store.runtimeIdentityHooks().bindLegacy(bee.id, rt.generation, 1000, {pid: 123, birth: "darwin:1:0", bootId: ""}, "authenticated-host-generation"), true);
    driver.procs.set(bee.id, {generation: rt.generation, pid: 123, pidStartedAt: 1000, degraded: false});
    store.updateRuntimeState(bee.id, rt.generation, "running");
    restarted.resolveProcessIdentity(bee.id, rt.generation); restarted.step(); restarted.step();
    assert.equal(store.getCommand(cmd.id)!.status, "done");
    assert.equal(stops, verb === "stop" ? 1 : 0);
  } finally {store.close(); h.cleanup();}
});

test("proven gone still reconciles to stopped while unresolved rows stay reachable", () => {
  const h = harness(), store = h.open();
  try {
    const {bee} = makeBee(store), rt = store.currentRuntime(bee.id)!;
    store.recordRuntimeProc(bee.id, rt.generation, {pid: 123, pidStartedAt: 1000});
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=NULL WHERE bee_id=?").run(bee.id);
    store.reconcileAtBoot([], [{beeId: bee.id, generation: rt.generation}]);
    assert.equal(store.currentRuntime(bee.id)!.state, rt.state); assert.equal(store.view(bee.id).reachable, true);
    store.reconcileAtBoot([]);
    assert.equal(store.currentRuntime(bee.id)!.state, "stopped"); assert.equal(store.currentRuntime(bee.id)!.exitCause, "machine_restart");
  } finally {store.close(); h.cleanup();}
});

test("resolved RPC results omit diagnostics; overdue unresolved rows carry doctor and CLI text", () => {
  const h = harness(), store = h.open(), rig = makeDaemonDir();
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    const daemon = new HiveDaemon(loadNodeConfig(rig.dir));
    const internals = daemon as unknown as {store: CoreStore; identityRecovery: IdentityRecovery; viewOf: (store: CoreStore, id: string) => import("../src/protocol.ts").ViewResult; rpcHealth: () => import("../src/protocol.ts").HealthResult; rpcEnqueue: (verb: string, id: string, args: Record<string, unknown>, params: Record<string, unknown>) => import("../src/protocol.ts").MutationResult};
    internals.store = store;
    assert.equal(Object.hasOwn(internals.viewOf(store, bee.id), "identityDiagnostic"), false);
    assert.equal(Object.hasOwn(internals.rpcHealth(), "identityDiagnostic"), false);
    assert.equal(Object.hasOwn(internals.rpcEnqueue("stop", bee.id, {}, {}), "pending"), false);
    internals.identityRecovery.retain({beeId: bee.id, generation, since: Date.now() - 600001});
    assert.deepEqual(internals.rpcHealth().identityDiagnostic, {warning: "process_identity_unresolved", count: 1});
    assert.equal(runtimeLabel(internals.viewOf(store, bee.id)), "identity unresolved");
    assert.equal(internals.rpcEnqueue("stop", bee.id, {}, {}).pending?.message, "stop pending process identity proof");
  } finally {store.close(); h.cleanup(); rig.cleanup();}
});

test("identity loss during stop holds the same durable command without a signal or retry exhaustion", () => {
  const h = harness(), store = h.open(); let now = 10000;
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    store.updateRuntimeState(bee.id, generation, "running", {pid: 123, pidStartedAt: 1000});
    const driver = new FakeDriver(() => now); driver.procs.set(bee.id, {generation, pid: 123, pidStartedAt: 1000, degraded: false});
    const original = driver.stop.bind(driver); let signals = 0, holds = 0;
    driver.stop = () => {throw new ProcessIdentityUnavailableError();};
    const core = new DaemonCore({store, driver, now: () => now, log() {}, policy: {bootHangTimeoutSteps: 100000, commandsPerStep: 8}, onIdentityUnresolved: () => {holds++;}});
    core.boot();
    const cmd = store.enqueueCommand("stop", bee.id, {}, {idempotencyKey: "unresolved-stop"});
    core.step();
    assert.equal(store.getCommand(cmd.id)!.status, "queued"); assert.equal(store.getCommand(cmd.id)!.attempts, 0); assert.equal(holds, 1);
    now += 2000; core.step(); assert.equal(holds, 1);
    driver.stop = (...args) => {signals++; return original(...args);};
    core.resolveProcessIdentity(bee.id, generation); core.step(); core.step();
    assert.equal(signals, 1); assert.equal(store.getCommand(cmd.id)!.status, "done");
  } finally {store.close(); h.cleanup();}
});

test("a queued unresolved stop settles after restart when the process is proven gone", () => {
  const h = harness(); let store = h.open();
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    store.recordRuntimeProc(bee.id, generation, {pid: 123, pidStartedAt: 1000});
    const cmd = store.enqueueCommand("stop", bee.id, {}, {idempotencyKey: "gone-stop"});
    store.close(); store = h.open();
    const driver = new FakeDriver(() => 10000); let signals = 0;
    driver.stop = () => {signals++; return {hadProcess: false};};
    const core = new DaemonCore({store, driver, now: () => 10000, log() {}, policy: {bootHangTimeoutSteps: 100000, commandsPerStep: 8}});
    core.boot(); core.step();
    assert.equal(signals, 0); assert.equal(store.getCommand(cmd.id)!.status, "done");
    assert.equal(store.currentRuntime(bee.id)!.state, "stopped");
  } finally {store.close(); h.cleanup();}
});


test("boot absence cannot settle a malformed or unbound persisted identity", () => {
  const h = harness(), store = h.open(), rig = makeDaemonDir();
  try {
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    store.recordRuntimeProc(bee.id, generation, {pid: 2147483647, pidStartedAt: 1000});
    const daemon = new HiveDaemon(loadNodeConfig(rig.dir));
    const owner = daemon as unknown as {store: CoreStore; adoptSurvivors(store: CoreStore, driver: unknown): Array<{beeId: string; generation: number}>};
    owner.store = store;
    const driver = {adopt: () => false, isDegraded: () => false};
    const db = (store as unknown as {db: DatabaseSync}).db;
    for (const content of [null, "{bad", JSON.stringify({pid: "wrong"})]) {
      db.prepare("UPDATE runtimes SET process_identity=? WHERE bee_id=?").run(content, bee.id);
      assert.deepEqual(owner.adoptSurvivors(store, driver), [{beeId: bee.id, generation}]);
      assert.notEqual(store.currentRuntime(bee.id)!.state, "stopped");
    }
  } finally {store.close(); h.cleanup(); rig.cleanup();}
});


test("recovery persists an owned late capture through the store and never replaces malformed content", () => {
  const h = harness(), store = h.open(), rig = makeDaemonDir();
  try {
    const value = inspectProcess(process.pid); assert.equal(value.kind, "present");
    if (value.kind !== "present") throw new Error("Own process observation unavailable");
    const {bee} = makeBee(store), generation = store.currentRuntime(bee.id)!.generation;
    const proc = {pid: process.pid, pidStartedAt: value.startedAtMs, processIdentity: {pid: process.pid, birth: value.birth, bootId: value.bootId}};
    store.recordRuntimeProc(bee.id, generation, {pid: proc.pid, pidStartedAt: proc.pidStartedAt});
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "unavailable");
    const daemon = new HiveDaemon(loadNodeConfig(rig.dir));
    let resolved = 0;
    const owner = daemon as unknown as {store: CoreStore; driver: unknown; core: unknown; identityRecovery: IdentityRecovery; retryProcessIdentities(): void};
    owner.store = store;
    owner.driver = {procOf: () => proc, retryProcessIdentity() {}, hasProcess: () => true};
    owner.core = {resolveProcessIdentity: () => {resolved++;}};
    owner.identityRecovery.retain({beeId: bee.id, generation, since: Date.now()});
    owner.retryProcessIdentities();
    assert.equal(resolved, 1); assert.equal(owner.identityRecovery.has(bee.id, generation), false);
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "bound");
    (store as unknown as {db: DatabaseSync}).db.prepare("UPDATE runtimes SET process_identity=? WHERE bee_id=?").run("{malformed", bee.id);
    owner.identityRecovery = new IdentityRecovery(); owner.identityRecovery.retain({beeId: bee.id, generation, since: Date.now()});
    owner.retryProcessIdentities();
    assert.equal(resolved, 1); assert.equal(owner.identityRecovery.has(bee.id, generation), true);
    assert.equal(store.runtimeProcessIdentity(bee.id, generation).kind, "unavailable");
  } finally {store.close(); h.cleanup(); rig.cleanup();}
});
