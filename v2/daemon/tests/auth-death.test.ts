import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_DEATH_WINDOW_MS, openCoreStore, replayAudit, type AccountMaterialStamp, type CoreStore } from "../../core/src/index.ts";
import { DaemonCore } from "../src/loops.ts";
import { FakeDriver } from "./helpers.ts";
import { AuthResume } from "../src/authResume.ts";

function rig(kind: "central" | "lease" = "lease", unproven = false, initialInstance?: string) {
  const dir = mkdtempSync(join(tmpdir(), "hb-auth-death-"));
  let clock = 10_000;
  let material: AccountMaterialStamp | null = { ...(initialInstance && initialInstance !== "legacy" ? { authorityInstanceId: initialInstance } : {}), kind, scope: kind === "central" ? "claude-test-example.com" : "authority:share", epoch: kind === "central" ? 0 : 1, generation: 1 };
  let store: CoreStore;
  let resume: AuthResume;
  const open = () => {
    store = openCoreStore(join(dir, "core.sqlite3"), { now: () => clock, maxAttempts: 4, backoffBaseMs: 100 });
    resume = new AuthResume({ store, now: () => clock, log: () => {}, accountForGeneration: bee => store.getAccount(bee.account!), credentialRevision: () => `revision-${material?.generation}`, material: account => account.status === "paused" ? null : material });
  };
  open();
  const account = store!.createAccount({ id: "claude-test-example.com", harness: "claude", label: "test-example.com", homePath: join(dir, "home"), status: "ok" });
  const publish = (generation: number, epoch: number) => {
    if (kind === "central") {
      const state = store.putAccountCredentialAuthority({ account: account.id, phase: "ready", generation, expiresAt: clock + 3_600_000, operationKey: null, failure: null, refreshTokenExpiresAt: null });
      if (material) material.authorityInstanceId = state.authorityInstanceId;
    }
    else store.setAccountLease(account.id, { ...(material?.authorityInstanceId ? { authorityInstanceId: material.authorityInstanceId } : {}), authorityNodeId: "authority", shareId: "share", epoch, generation, materialPublished: true, expiresAt: Math.floor((clock + 3_600_000) / 1000), adoptedAt: null, revokedAt: null });
  };
  publish(1, material!.epoch);
  const bee = store!.createBee({ name: "test", agent: "claude", substrate: "hsr", cwd: dir, account: account.id }).bee;
  const admittedMaterial = initialInstance === "legacy" ? { ...material!, authorityInstanceId: undefined } : material!;
  store!.stampRuntimeCredential(bee.id, 1, { material: admittedMaterial, revision: "revision-1", account: account.id, agent: bee.agent, cwd: dir, cellId: bee.cellId, controlFence: 0 });
  if (!unproven) {
    store!.updateRuntimeState(bee.id, 1, "running", { pid: 123, pidStartedAt: 1 });
    store!.recordProviderSessionId(bee.id, "fake-session", 1);
  }
  const fail = (ids: number[] = [], progress: "none" | "some" | "unknown" = "unknown") => resume.interrupted({ beeId: bee.id, generation: store.currentRuntime(bee.id)!.generation, flag: "auth_needed", action: "set", detail: "provider auth error", turn: { messageIds: ids, progress } });
  const die = () => store.updateRuntimeState(bee.id, store.currentRuntime(bee.id)!.generation, "stopped", { exitCause: "crashed" });
  const fresh = (generation = 2, epoch = kind === "central" ? 0 : 1, authorityInstanceId = material?.authorityInstanceId) => { material = { ...(authorityInstanceId ? { authorityInstanceId } : {}), kind, scope: kind === "central" ? account.id : "authority:share", epoch, generation }; publish(generation, epoch); resume.reconcile(); };
  return { dir, bee, account, get now() { return clock; }, get store() { return store; }, get resume() { return resume; }, open, fail, die, fresh, unavailable: () => { material = null; }, advance: (ms: number) => { clock += ms; }, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const kind of ["central", "lease"] as const) for (const order of ["evidence-first", "exit-first", "install-first"] as const) {
  test(`auth death ${kind}: ${order}, one durable claim, same identity and no idle instruction`, () => {
    const r = rig(kind);
    try {
      if (order === "install-first") r.fresh();
      if (order === "exit-first") r.die();
      r.fail();
      if (order !== "exit-first") r.die();
      r.resume.reconcile();
      if (order !== "install-first") {
        assert.equal(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt, null);
        r.fresh();
      }
      const row = r.store.liveAuthInterruption(r.bee.id)!;
      assert.ok(row.deathRecovery?.claimedAt !== null);
      assert.equal(row.continuationKind, "revive");
      assert.equal(r.store.listMessages(r.bee.id).length, 0);
      assert.equal(r.store.getBee(r.bee.id)?.providerSessionId, "fake-session");
      const commands = r.store.listCommands().filter(c => c.args.authDeathRecoveryId === row.id);
      assert.equal(commands.length, 1);
      assert.equal(commands[0]!.verb, "revive");
      r.fresh(); r.resume.reconcile();
      assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId === row.id).length, 1);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    } finally { r.close(); }
  });
}

test("auth death: partial and untouched turns reuse the sole AuthResume continuation owner", () => {
  for (const progress of ["none", "some"] as const) {
    const r = rig();
    try {
      const original = r.store.send(r.bee.id, "work").message;
      r.store.markDelivered(original.id, 1);
      r.fail([original.id], progress); r.die(); r.fresh();
      const row = r.store.liveAuthInterruption(r.bee.id)!;
      assert.equal(row.continuationKind, progress === "none" ? "redeliver" : "continue");
      assert.equal(row.continuationMessageIds.length, progress === "none" ? 2 : 1);
      r.fresh(3);
      assert.equal(r.store.listMessages(r.bee.id).length, progress === "none" ? 3 : 2);
      if (progress === "none") assert.equal(r.store.listMessages(r.bee.id).at(-1)?.body, "work", "original user text stays untouched");
    } finally { r.close(); }
  }
});

test("auth death: fixed exit deadline expires durably; late evidence or installation never extends it", () => {
  const r = rig();
  try {
    r.die(); r.advance(AUTH_DEATH_WINDOW_MS); r.fail(); r.fresh();
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery, undefined);
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.state, "open");
    assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId !== undefined).length, 0);
    r.store.close(); r.open(); r.fresh(3);
    assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId !== undefined).length, 0);
  } finally { r.close(); }
});

test("auth death: operator stop even already stopped, archive/unarchive, reconfigure and account changes cancel at admission", () => {
  for (const action of ["stop-before-evidence", "stop", "archive", "args", "account"] as const) {
    const r = rig();
    try {
      r.die();
      if (action !== "stop-before-evidence") r.fail();
      if (action.startsWith("stop")) r.store.enqueueCommand("stop", r.bee.id, { cause: "stopped_by_user" });
      if (action === "archive") { r.store.archiveBee(r.bee.id); r.store.unarchiveBee(r.bee.id); }
      if (action === "args") r.store.reconfigureBee(r.bee.id, ["--model", "fake"]);
      if (action === "account") r.store.setBeeAccount(r.bee.id, null);
      if (action === "stop-before-evidence") r.fail();
      r.fresh();
      assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId !== undefined).length, 0, action);
      assert.ok((r.store.getBee(r.bee.id)?.authControlFence ?? 0) > 0);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    } finally { r.close(); }
  }
});

test("auth death: unavailable material cannot claim; restart inside deadline resumes once", () => {
  const r = rig();
  try {
    r.fail(); r.die(); r.unavailable(); r.resume.reconcile();
    r.store.close(); r.open();
    r.fresh();
    const claim = r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt;
    assert.notEqual(claim, null);
    r.store.close(); r.open(); r.fresh(3);
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt, claim);
    assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId !== undefined).length, 1);
  } finally { r.close(); }
});

test("auth death: each new runtime death requires material newer than that runtime used", () => {
  const r = rig();
  try {
    r.fail(); r.die(); r.fresh();
    r.store.reviveBee(r.bee.id);
    r.store.stampRuntimeCredential(r.bee.id, 2, { material: { kind: "lease", scope: "authority:share", epoch: 1, generation: 2 }, revision: "revision-2", account: r.account.id, agent: "claude", cwd: r.dir, cellId: null, controlFence: 0 });
    r.store.updateRuntimeState(r.bee.id, 2, "running");
    r.fail(); r.die(); r.fresh();
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt, null);
    r.fresh(3);
    assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId !== undefined).length, 2);
  } finally { r.close(); }
});


test("auth death: cancellation after claim removes recovery continuation and its sole wake", () => {
  for (const stop of ["stop", "archive"] as const) {
    const r = rig();
    try {
      const original = r.store.send(r.bee.id, "work").message;
      r.store.markDelivered(original.id, 1);
      r.fail([original.id], "some"); r.die(); r.fresh();
      const row = r.store.liveAuthInterruption(r.bee.id)!;
      const queued = r.store.listCommands({ status: "queued" }).filter(c => c.targetGeneration === 1 && ["revive", "send_wake"].includes(c.verb));
      assert.equal(queued.length, 1, "the continuation shares the explicit recovery wake");
      if (stop === "stop") r.store.enqueueCommand("stop", r.bee.id, { cause: "stopped_by_user" });
      else r.store.archiveBee(r.bee.id);
      assert.equal(r.store.getAuthInterruption(row.id)?.state, "cancelled");
      assert.equal(r.store.listCommands({ status: "queued" }).filter(c => c.targetGeneration === 1 && ["revive", "send_wake"].includes(c.verb)).length, 0);
      assert.equal(r.store.undeliveredMessages(r.bee.id).length, 0);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    } finally { r.close(); }
  }
});

test("auth death: accepted user mail stays FIFO while held, deadline releases ordinary wake, explicit resume cancels", () => {
  for (const action of ["install", "deadline", "resume"] as const) {
    const r = rig();
    try {
      r.fail(); r.die(); r.resume.reconcile();
      const first = r.store.send(r.bee.id, "first").message;
      const second = r.store.send(r.bee.id, "second").message;
      assert.equal(r.resume.holdsStoppedRuntime(r.store.liveAuthInterruption(r.bee.id)!), true);
      if (action === "install") r.fresh();
      if (action === "deadline") { r.advance(AUTH_DEATH_WINDOW_MS); assert.equal(r.resume.waitingForMaterial(r.bee.id), false); r.resume.reconcile(); }
      if (action === "resume") r.store.enqueueCommand("revive", r.bee.id);
      const pending = r.store.liveAuthInterruption(r.bee.id);
      assert.equal(pending ? r.resume.holdsStoppedRuntime(pending) : false, false);
      assert.deepEqual(r.store.undeliveredMessages(r.bee.id).map(m => m.id), [first.id, second.id]);
      assert.ok(r.store.listCommands({ status: "queued" }).some(c => ["revive", "send_wake"].includes(c.verb)));
    } finally { r.close(); }
  }
});


test("auth death: the normal core start/delivery path holds accepted mail, then install/deadline/manual resume releases FIFO once", () => {
  for (const action of ["install", "deadline", "resume"] as const) {
    const r = rig();
    try {
      const driver = new FakeDriver(() => r.now);
      const core = new DaemonCore({ store: r.store, driver, now: () => r.now, log: () => {}, policy: { bootHangTimeoutSteps: 60_000, commandsPerStep: 10, idleWindowSteps: null, i1DeadlineSteps: 30_000 }, blockedRuntimeStartBeeIds: () => {
        r.resume.reconcile();
        return new Set(r.store.listLiveAuthInterruptions().filter(row => r.resume.holdsStoppedRuntime(row)).map(row => row.beeId));
      } });
      core.step(); core.step();
      r.fail(); r.die(); driver.procs.delete(r.bee.id);
      const first = r.store.send(r.bee.id, "first").message;
      const second = r.store.send(r.bee.id, "second").message;
      core.step(); core.step();
      assert.equal(r.store.currentRuntime(r.bee.id)?.generation, 1);
      assert.equal(r.store.getMessage(first.id)?.deliveredAt, null);
      if (action === "install") r.fresh();
      if (action === "deadline") r.advance(AUTH_DEATH_WINDOW_MS);
      if (action === "resume") r.store.enqueueCommand("revive", r.bee.id);
      for (let i = 0; i < 8; i++) core.step();
      assert.equal(r.store.currentRuntime(r.bee.id)?.generation, 2);
      assert.deepEqual(driver.deliveredIds, [first.id, second.id]);
      assert.equal(r.store.getMessage(first.id)?.deliveredGeneration, 2);
      assert.equal(r.store.getMessage(second.id)?.deliveredGeneration, 2);
      assert.equal(r.store.auditRows().filter(row => row.kind === "auth_death.resumed").length, action === "install" ? 1 : 0);
    } finally { r.close(); }
  }
});


test("auth death: account pause at admission cancels even a claimed queued start and late evidence cannot undo it", () => {
  for (const claimed of [false, true]) {
    const r = rig();
    try {
      r.fail(); r.die();
      if (claimed) r.fresh();
      const rowId = r.store.liveAuthInterruption(r.bee.id)!.id;
      r.store.setAccountStatus(r.account.id, "paused");
      assert.equal(r.store.getAuthInterruption(rowId)?.state, "cancelled");
      r.store.unpauseAccount(r.account.id, { by: "operator", owner: null }, "ok"); r.fail(); r.fresh(3);
      assert.equal(r.store.listCommands({ status: "queued" }).filter(c => c.args.authDeathRecoveryId !== undefined).length, 0);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    } finally { r.close(); }
  }
});


test("auth death: automatic quota and lease pauses hold rather than cancel, including a queued claim, and remain deadline-bounded", () => {
  for (const by of ["quota", "lease"] as const) for (const claimed of [false, true]) {
    const r = rig();
    try {
      r.fail(); r.die(); if (claimed) r.fresh();
      const id = r.store.liveAuthInterruption(r.bee.id)!.id;
      r.store.pauseAccount(r.account.id, { by, owner: "test-manager" });
      r.resume.reconcile();
      assert.ok(r.store.liveAuthInterruption(r.bee.id));
      assert.equal(r.resume.holdsStoppedRuntime(r.store.liveAuthInterruption(r.bee.id)!), true);
      assert.equal(r.store.getBee(r.bee.id)?.authControlFence ?? 0, 0);
      r.store.unpauseAccount(r.account.id, { by, owner: "test-manager" }, "ok"); r.fresh();
      assert.ok(r.store.getAuthInterruption(id)?.deathRecovery?.claimedAt !== null);
      assert.equal(r.store.listCommands().filter(c => c.args.authDeathRecoveryId === id).length, 1);
      r.store.pauseAccount(r.account.id, { by, owner: "test-manager" }); r.advance(AUTH_DEATH_WINDOW_MS); r.resume.reconcile();
      assert.equal(r.store.getAuthInterruption(id)?.deathRecovery?.releasedWhilePaused, true);
      assert.ok(["open", "restored"].includes(r.store.getAuthInterruption(id)!.state));
      assert.equal(r.store.listCommands({ status: "queued" }).filter(c => c.args.authDeathRecoveryId === id).length, 0);
    } finally { r.close(); }
  }
});


test("auth death: expired pause-held claims preserve continuation until quota or lease unpause", () => {
  for (const by of ["quota", "lease"] as const) {
    const r = rig();
    try {
      r.fail([], "some"); r.die(); r.fresh();
      const id = r.store.liveAuthInterruption(r.bee.id)!.id;
      r.store.pauseAccount(r.account.id, { by, owner: "test-manager" });
      r.advance(AUTH_DEATH_WINDOW_MS);
      for (let i = 0; i < 4; i++) r.resume.reconcile();
      assert.equal(r.store.getAuthInterruption(id)?.state, "restored");
      assert.equal(r.store.listCommands({ status: "queued" }).filter(c => ["revive", "send_wake"].includes(c.verb)).length, 0);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
      r.store.close(); r.open(); r.resume.reconcile();
      assert.equal(r.store.getAuthInterruption(id)?.state, "restored");
      const accepted = r.store.send(r.bee.id, "queued user work").message;
      assert.equal(accepted.body, "queued user work");
      assert.equal(r.store.listCommands({ status: "queued" }).filter(c => c.verb === "send_wake").length, 1);
      r.store.unpauseAccount(r.account.id, { by, owner: "test-manager" }, "ok");
      r.resume.reconcile(); r.resume.reconcile();
      assert.equal(r.store.getAuthInterruption(id)?.state, "resumed");
      const commands = r.store.listCommands().length;
      r.resume.reconcile(); r.resume.reconcile();
      assert.equal(r.store.listCommands().length, commands);
      assert.equal(r.store.listCommands({ status: "queued" }).filter(c => c.verb === "send_wake").length, 1);
    } finally { r.close(); }
  }
});

test("auth death: a claim accepted just before its deadline survives ordinary executor delay and runs once", () => {
  const r = rig();
  try {
    const driver = new FakeDriver(() => r.now);
    const core = new DaemonCore({ store: r.store, driver, now: () => r.now, log: () => {}, policy: { bootHangTimeoutSteps: 60_000, commandsPerStep: 10 }, blockedRuntimeStartBeeIds: () => {
      r.resume.reconcile(); return new Set(r.store.listLiveAuthInterruptions().filter(row => r.resume.holdsStoppedRuntime(row)).map(row => row.beeId));
    } });
    core.step(); core.step(); r.fail(); r.die(); driver.procs.delete(r.bee.id); r.resume.reconcile();
    r.advance(AUTH_DEATH_WINDOW_MS - 1); r.fresh();
    const row = r.store.liveAuthInterruption(r.bee.id)!;
    const commandId = row.deathRecovery!.commandId!;
    assert.equal(r.store.getCommand(commandId)?.status, "queued");
    r.advance(100); r.resume.reconcile();
    assert.equal(r.store.getCommand(commandId)?.status, "queued");
    for (let i = 0; i < 6; i++) core.step();
    assert.equal(r.store.currentRuntime(r.bee.id)?.generation, 2);
    assert.equal(driver.starts.filter(start => start.generation === 2).length, 1);
    assert.equal(r.store.getCommand(commandId)?.status, "done");
  } finally { r.close(); }
});


test("auth death: newer published authority restores a delayed account auth verdict atomically, but login_required never qualifies", () => {
  const r = rig("central");
  try {
    r.fail(); r.die(); r.store.setAccountStatus(r.account.id, "auth_needed"); r.fresh();
    assert.equal(r.store.getAccount(r.account.id)?.status, "ok");
    assert.ok(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt !== null);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
  const failed = rig("central");
  try {
    failed.fail(); failed.die();
    failed.store.putAccountCredentialAuthority({ account: failed.account.id, phase: "login_required", generation: 2, expiresAt: null, operationKey: null, failure: null, refreshTokenExpiresAt: null });
    failed.resume.reconcile();
    const row = failed.store.liveAuthInterruption(failed.bee.id)!;
    assert.equal(failed.store.claimAuthDeathRecovery(row.id, { kind: "central", scope: failed.account.id, epoch: 0, generation: 2 }, "revision-2", "continue"), false);
    assert.equal(failed.store.liveAuthInterruption(failed.bee.id)?.deathRecovery?.claimedAt, null);
    assert.equal(failed.store.listCommands().filter(c => c.args.authDeathRecoveryId !== undefined).length, 0);
  } finally { failed.close(); }
});


test("auth death: automatic recovery preserves boot-failure count/backoff and cannot override the exhausted budget", () => {
  const r = rig("lease", true);
  try {
    const driver = new FakeDriver(() => r.now);
    const start = driver.start.bind(driver);
    driver.start = (beeId, generation) => {
      if (generation > 1) r.store.stampRuntimeCredential(beeId, generation, { material: { kind: "lease", scope: "authority:share", epoch: 1, generation: r.store.getAccount(r.account.id)!.leasedFrom!.generation! }, revision: "test-revision", account: r.account.id, agent: "claude", cwd: r.dir, cellId: null, controlFence: r.store.getBee(beeId)?.authControlFence ?? 0 });
      start(beeId, generation);
    };
    driver.authBootFailure = true;
    r.store.enqueueCommand("spawn", r.bee.id);
    const core = new DaemonCore({ store: r.store, driver, now: () => r.now, log: () => {}, policy: { bootHangTimeoutSteps: 60_000, commandsPerStep: 10 }, onFlagEvidence: event => { if (event.flag === "auth_needed" && event.action === "set") r.resume.interrupted(event); }, blockedRuntimeStartBeeIds: () => {
      r.resume.reconcile(); return new Set(r.store.listLiveAuthInterruptions().filter(row => r.resume.holdsStoppedRuntime(row)).map(row => row.beeId));
    } });
    core.step(); core.step();
    assert.equal(r.store.getBee(r.bee.id)?.spawnFailures, 1);
    for (const generation of [2, 3, 4]) {
      r.fresh(generation);
      const before = driver.starts.length;
      core.step();
      assert.equal(driver.starts.length, before, "existing boot backoff still applies");
      r.advance(60_000);
      for (let i = 0; i < 6; i++) core.step();
      assert.equal(r.store.getBee(r.bee.id)?.spawnFailures, generation, "automatic recovery never refills the budget");
    }
    assert.ok(r.store.activeFlags(r.bee.id).some(flag => flag.flag === "spawn_failed"));
    const starts = driver.starts.length;
    r.fresh(5); r.advance(60_000); for (let i = 0; i < 6; i++) core.step();
    assert.equal(driver.starts.length, starts, "no fifth boot without operator action");
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});


test("auth death compatibility: live args, env and session changes retain ordinary late-evidence continuation", () => {
  for (const mutation of ["args", "env", "session"] as const) {
    const r = rig();
    try {
      if (mutation === "args") r.store.updateBeeArgs(r.bee.id, ["--model", "fake"]);
      if (mutation === "env") r.store.setBeeEnv(r.bee.id, { TEST_SETTING: "changed" });
      if (mutation === "session") r.store.rekeyBeeSession(r.bee.id);
      r.fail(); r.die();
      assert.ok(r.store.liveAuthInterruption(r.bee.id), mutation);
      r.resume.credentialValidated(r.store.getAccount(r.account.id)!, "limits_probe");
      const row = r.store.liveAuthInterruption(r.bee.id)!;
      assert.equal(row.state, "resumed", mutation);
      assert.equal(row.deathRecovery, undefined);
      assert.equal(row.continuationMessageIds.length, 1);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    } finally { r.close(); }
  }
});

test("auth death compatibility: verified same material releases immediately; repeat failure remains revision-blocked", () => {
  for (const kind of ["central", "lease"] as const) {
    const r = rig(kind);
    try {
      r.store.setFlag(r.bee.id, "auth_needed", "test"); r.fail(); r.die(); r.resume.reconcile();
      assert.equal(r.resume.waitingForMaterial(r.bee.id), true);
      r.resume.credentialValidated(r.store.getAccount(r.account.id)!, "limits_probe");
      const row = r.store.liveAuthInterruption(r.bee.id)!;
      assert.equal(row.state, "resumed"); assert.equal(row.deathRecovery, undefined);
      assert.equal(r.resume.waitingForMaterial(r.bee.id), false);
      assert.equal(r.store.activeFlags(r.bee.id).some(flag => flag.flag === "auth_needed"), false);
      assert.equal(row.continuationMessageIds.length, 1);
      r.advance(AUTH_DEATH_WINDOW_MS); r.resume.reconcile();
      assert.equal(r.store.listMessages(r.bee.id).length, 1);
      r.fail(); r.resume.credentialValidated(r.store.getAccount(r.account.id)!, "limits_probe");
      assert.equal(r.store.liveAuthInterruption(r.bee.id)?.state, "open");
      assert.equal(r.store.listMessages(r.bee.id).length, 1, "baseline blockedRevision still prevents a same-token loop");
    } finally { r.close(); }
  }
});

test("auth death compatibility: a healthy account swap preserves the held continuation", () => {
  const r = rig();
  try {
    r.fail(); r.die(); r.resume.reconcile();
    const target = r.store.createAccount({ id: "claude-other-example.com", harness: "claude", label: "other", homePath: join(r.dir, "other"), status: "ok" });
    r.store.setBeeAccount(r.bee.id, target.id); r.store.setBeeEnv(r.bee.id, { CLAUDE_CONFIG_DIR: target.homePath });
    r.resume.beeSwapped(r.bee.id, target); r.resume.reconcile();
    const row = r.store.liveAuthInterruption(r.bee.id)!;
    assert.equal(row.account, target.id); assert.equal(row.state, "resumed");
    assert.equal(row.deathRecovery, undefined); assert.equal(row.continuationMessageIds.length, 1);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});


test("auth death compatibility: a remembered validation survives the deadline and provenance changes preserve an already owed turn", () => {
  for (const action of ["deadline", "args", "env"] as const) {
    const r = rig();
    try {
      r.fail(); r.die(); r.resume.reconcile(); r.unavailable();
      r.resume.credentialValidated(r.store.getAccount(r.account.id)!, "limits_probe");
      assert.equal(r.store.liveAuthInterruption(r.bee.id)?.state, "restored");
      assert.equal(r.resume.waitingForMaterial(r.bee.id), true);
      if (action === "deadline") r.advance(AUTH_DEATH_WINDOW_MS);
      if (action === "args") r.store.updateBeeArgs(r.bee.id, ["--model", "fake"]);
      if (action === "env") r.store.setBeeEnv(r.bee.id, { TEST_SETTING: "changed" });
      r.resume.reconcile();
      const row = r.store.liveAuthInterruption(r.bee.id)!;
      assert.equal(row.deathRecovery, undefined); assert.equal(row.state, "resumed");
      assert.equal(row.continuationMessageIds.length, 1);
      r.resume.reconcile(); assert.equal(r.store.listMessages(r.bee.id).length, 1);
      assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
    } finally { r.close(); }
  }
});


test("auth death compatibility: an accepted queued claim keeps its validated continuation after an args change", () => {
  const r = rig();
  try {
    r.fail(); r.die(); r.fresh();
    const claimed = r.store.liveAuthInterruption(r.bee.id)!;
    const oldCommand = claimed.deathRecovery!.commandId!;
    r.store.updateBeeArgs(r.bee.id, ["--model", "fake"]); r.resume.reconcile();
    const row = r.store.liveAuthInterruption(r.bee.id)!;
    assert.equal(r.store.getCommand(oldCommand)?.status, "done");
    assert.equal(row.deathRecovery, undefined); assert.equal(row.state, "resumed");
    assert.equal(row.continuationMessageIds.length, 1);
    assert.equal(r.store.undeliveredMessages(r.bee.id).length, 1);
    assert.equal(r.store.listCommands({ status: "queued" }).filter(command => command.verb === "send_wake").length, 1);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});


test("auth death compatibility: machine-restart exits opt out without losing the ordinary continuation", () => {
  const r = rig();
  try {
    r.fail(); r.store.updateRuntimeState(r.bee.id, 1, "stopped", { exitCause: "machine_restart" });
    r.resume.reconcile();
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery, undefined);
    r.resume.credentialValidated(r.store.getAccount(r.account.id)!, "limits_probe");
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.state, "resumed");
    assert.equal(r.store.listCommands().filter(command => command.args.authDeathRecoveryId !== undefined).length, 0);
  } finally { r.close(); }
});

for (const kind of ["central", "lease"] as const) for (const legacy of [false, true]) test(`auth death ${kind}: new authority instance recovers a lower generation from ${legacy ? "legacy" : "scoped"} admission once`, () => {
  const r = rig(kind, false, legacy ? "legacy" : randomUUID());
  try {
    r.fail(); r.die();
    const id = r.store.liveAuthInterruption(r.bee.id)!.id;
    const oldInstance = r.store.currentRuntime(r.bee.id)?.credentialStamp?.material.authorityInstanceId;
    if (kind === "central") r.store.putAccountCredentialAuthority({ ...r.store.getAccountCredentialAuthority(r.account.id)!, phase: "disabled" });
    r.fresh(0, kind === "central" ? 0 : 1, randomUUID());
    const row = r.store.getAuthInterruption(id)!;
    assert.equal(row.state, "resumed");
    assert.equal(row.deathRecovery?.replacement?.generation, 0);
    assert.notEqual(row.deathRecovery?.replacement?.authorityInstanceId, oldInstance);
    r.resume.reconcile();
    assert.equal(r.store.auditRows().filter(row => row.kind === "auth_death.resumed").length, 1);
    assert.deepEqual(replayAudit(r.store.auditRows()), r.store.dumpState());
  } finally { r.close(); }
});

test("auth death: stale instance verdict cannot claim current published material", () => {
  const r = rig("lease", false, randomUUID());
  try {
    r.fail(); r.die(); r.resume.reconcile();
    const row = r.store.liveAuthInterruption(r.bee.id)!;
    const origin = r.store.getAccount(r.account.id)!.leasedFrom!;
    r.store.setAccountLease(r.account.id, { ...origin, generation: 0, authorityInstanceId: randomUUID() });
    assert.equal(r.store.claimAuthDeathRecovery(row.id, { kind: "lease", scope: "authority:share", epoch: 1, generation: 0, authorityInstanceId: randomUUID() }, "new", "continue"), false);
    assert.equal(r.store.listCommands().filter(command => command.args.authDeathRecoveryId === row.id).length, 0);
  } finally { r.close(); }
});

test("auth death: admitted remembered legacy scope requires returning instance to exceed its floor", () => {
  const r = rig("lease");
  try {
    const a = randomUUID();
    const runtime = r.store.currentRuntime(r.bee.id)!;
    r.store.updateRuntimeState(r.bee.id, runtime.generation, "stopped", { exitCause: "crashed" });
    const stamp = runtime.credentialStamp!;
    const bee = r.store.getBee(r.bee.id)!;
    const row = r.store.recordAuthInterruption({ beeId: bee.id, account: r.account.id, generation: 1, messageIds: [], turnProgress: "unknown", credentialRevision: "old", detail: "auth" });
    r.store.setAuthDeathRecovery(row.id, { admitted: { ...stamp, material: { ...stamp.material, generation: 6, authorityInstanceId: undefined, legacyAuthorityInstanceId: a, legacyAuthorityGenerationFloor: 6 } }, deathAt: r.now, deadline: r.now + AUTH_DEATH_WINDOW_MS, claimedAt: null, replacement: null, commandId: null });
    for (const generation of [5, 6]) {
      r.store.setAccountLease(r.account.id, { ...r.store.getAccount(r.account.id)!.leasedFrom!, authorityInstanceId: a, generation });
      assert.equal(r.store.claimAuthDeathRecovery(row.id, { kind: "lease", scope: "authority:share", epoch: 1, generation, authorityInstanceId: a }, "new", "continue"), false);
    }
    r.store.setAccountLease(r.account.id, { ...r.store.getAccount(r.account.id)!.leasedFrom!, authorityInstanceId: a, generation: 7 });
    assert.equal(r.store.claimAuthDeathRecovery(row.id, { kind: "lease", scope: "authority:share", epoch: 1, generation: 7, authorityInstanceId: a }, "new", "continue"), true);
  } finally { r.close(); }
});

test("auth death: higher epoch does not turn a same-instance lower generation into new material", () => {
  const instance = randomUUID();
  const r = rig("lease", false, instance);
  try {
    r.fail(); r.die(); r.resume.reconcile();
    r.fresh(0, 2, instance);
    assert.equal(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt, null);
    assert.equal(r.store.auditRows().filter(row => row.kind === "auth_death.resumed").length, 0);
    r.fresh(2, 2, instance);
    assert.notEqual(r.store.liveAuthInterruption(r.bee.id)?.deathRecovery?.claimedAt, null);
  } finally { r.close(); }
});
