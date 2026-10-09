/**
 * AuthResume policy over a real CoreStore (temp dir), no driver and no daemon:
 * the cases that depend on WHEN a bee can take its continuation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_RESUME_SENDER, openCoreStore, type AccountRow, type CoreStore } from "../../core/src/index.ts";
import { AuthResume } from "../src/authResume.ts";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "hb-auth-resume-"));
  const path = join(dir, "core.sqlite3");
  let clock = 1_000;
  const revisions = new Map<string, string>();
  const log: string[] = [];
  const open = (): { store: CoreStore; resume: AuthResume } => {
    const store = openCoreStore(path, { now: () => (clock += 1), ephemeral: true });
    const resume = new AuthResume({
      store,
      log: (op) => log.push(op),
      accountForGeneration: (bee) => store.getAccount(bee.account ?? ""),
      credentialRevision: (account) => revisions.get(account.id) ?? "rev-1",
    });
    return { store, resume };
  };
  return { open, revisions, log, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function account(store: CoreStore, id: string): AccountRow {
  return store.createAccount({ id, harness: "claude", homePath: `/tmp/${id}`, label: id });
}

function idleBee(store: CoreStore, name: string, accountId: string): string {
  const { bee } = store.createBee({ name, agent: "claude", substrate: "hsr", cwd: "/tmp/w", account: accountId });
  store.updateRuntimeState(bee.id, 1, "running", { pid: 100, pidStartedAt: 1 });
  store.updateRuntimeState(bee.id, 1, "idle");
  return bee.id;
}

function cutOff(store: CoreStore, resume: AuthResume, beeId: string): void {
  store.setFlag(beeId, "auth_needed", "Not logged in");
  resume.interrupted({ beeId, generation: store.currentRuntime(beeId)!.generation, flag: "auth_needed", action: "set", detail: "Not logged in" });
}

const resumeMail = (store: CoreStore, beeId: string) => store.listMessages(beeId).filter((m) => m.sender === AUTH_RESUME_SENDER);

test("auth resume: a bee mid-turn is not disturbed; the owed continuation survives a restart and is sent once when the turn ends", () => {
  const r = rig();
  try {
    let { store, resume } = r.open();
    const a = account(store, "claude-a");
    const bee = idleBee(store, "busy", a.id);
    cutOff(store, resume, bee);
    store.updateRuntimeState(bee, 1, "running");

    r.revisions.set(a.id, "rev-2");
    const receipt = resume.credentialValidated(store.getAccount(a.id)!, "limits_probe");
    assert.deepEqual([receipt.clearedBeeIds, receipt.resumingBeeIds], [[bee], [bee]]);
    assert.equal(store.liveAuthInterruption(bee)?.state, "restored");
    assert.deepEqual(resumeMail(store, bee), [], "a running turn is left alone");
    store.close();

    ({ store, resume } = r.open());
    resume.reconcile();
    assert.deepEqual(resumeMail(store, bee), []);
    store.updateRuntimeState(bee, 1, "idle");
    resume.reconcile();
    resume.reconcile();
    assert.equal(resumeMail(store, bee).length, 1);
    assert.equal(store.liveAuthInterruption(bee)?.state, "resumed");

    resume.turnSucceeded(bee);
    assert.equal(store.liveAuthInterruption(bee), null);
    assert.equal(store.listAuthInterruptions({ beeId: bee })[0]?.state, "completed");
    store.close();
  } finally {
    r.cleanup();
  }
});

test("auth resume: a turn that succeeds before the continuation is sent supersedes it", () => {
  const r = rig();
  try {
    const { store, resume } = r.open();
    const a = account(store, "claude-a");
    const bee = idleBee(store, "moved-on", a.id);
    cutOff(store, resume, bee);
    resume.turnSucceeded(bee);
    resume.credentialValidated(a, "login");
    assert.deepEqual(resumeMail(store, bee), []);
    assert.deepEqual(store.listAuthInterruptions({ beeId: bee }).map((row) => [row.state, row.settleReason]), [["superseded", "turn_succeeded"]]);
    store.close();
  } finally {
    r.cleanup();
  }
});

test("auth resume: archive and a user stop cancel the continuation; a system stop does not", () => {
  const r = rig();
  try {
    const { store, resume } = r.open();
    const a = account(store, "claude-a");
    const archived = idleBee(store, "archived", a.id);
    const userStopped = idleBee(store, "user-stopped", a.id);
    const parked = idleBee(store, "parked", a.id);
    for (const bee of [archived, userStopped, parked]) cutOff(store, resume, bee);
    store.updateRuntimeState(archived, 1, "stopped", { exitCause: "clean" });
    store.archiveBee(archived);
    store.updateRuntimeState(userStopped, 1, "stopped", { exitCause: "stopped_by_user" });
    store.updateRuntimeState(parked, 1, "stopped", { exitCause: "stopped_by_system" });

    resume.credentialValidated(a, "capture");
    assert.equal(store.getBee(archived)?.lifecycle, "archived", "an archived bee is not unarchived by a continuation");
    assert.deepEqual(store.listAuthInterruptions({ beeId: archived }).map((row) => [row.state, row.settleReason]), [["cancelled", "archived"]]);
    assert.deepEqual(store.listAuthInterruptions({ beeId: userStopped }).map((row) => [row.state, row.settleReason]), [["cancelled", "stopped_by_user"]]);
    assert.deepEqual([resumeMail(store, archived).length, resumeMail(store, userStopped).length, resumeMail(store, parked).length], [0, 0, 1]);
    assert.ok(store.listCommands({ beeId: parked }).some((cmd) => cmd.verb === "send_wake"), "the continuation wakes a parked bee");
    for (const bee of [archived, userStopped, parked]) assert.deepEqual(store.activeFlags(bee), []);
    store.close();
  } finally {
    r.cleanup();
  }
});

test("auth resume: a restore clears flags by where the failure came from, not only by current binding", () => {
  const r = rig();
  try {
    const { store, resume } = r.open();
    const a = account(store, "claude-a");
    const b = account(store, "claude-b");
    const swappedAway = idleBee(store, "swapped-away", a.id);
    const onB = idleBee(store, "on-b", b.id);
    cutOff(store, resume, swappedAway);
    cutOff(store, resume, onB);
    store.setAccountStatus(b.id, "auth_needed", "test");
    store.setBeeAccount(swappedAway, b.id);
    resume.beeSwapped(swappedAway, store.getAccount(b.id)!);
    assert.equal(store.liveAuthInterruption(swappedAway)?.account, b.id, "the interrupted work now waits on the target account");

    const restoredA = resume.credentialValidated(a, "login");
    assert.deepEqual([restoredA.clearedBeeIds, restoredA.resumingBeeIds], [[], []], "the source account's restore no longer concerns the swapped bee");
    assert.equal(store.activeFlags(swappedAway).length, 1);

    const restoredB = resume.credentialValidated(store.getAccount(b.id)!, "login");
    assert.deepEqual([...restoredB.resumingBeeIds].sort(), [swappedAway, onB].sort());
    assert.deepEqual([store.activeFlags(swappedAway), store.activeFlags(onB)], [[], []]);

    // Late evidence from the old account, after the bee already runs on the new one.
    const late = idleBee(store, "late-evidence", b.id);
    store.setFlag(late, "auth_needed", "Not logged in");
    store.recordAuthInterruption({ beeId: late, account: a.id, generation: 1, messageIds: [], turnProgress: "unknown", credentialRevision: "rev-1", detail: "Not logged in" });
    assert.deepEqual(resume.credentialValidated(store.getAccount(b.id)!, "limits_probe").clearedBeeIds, [], "account B's health says nothing about a failure that came from A");
    assert.deepEqual(resume.credentialValidated(a, "login").clearedBeeIds, [late]);
    assert.equal(resumeMail(store, late).length, 1);
    store.close();
  } finally {
    r.cleanup();
  }
});
