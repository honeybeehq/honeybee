import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { HiveDaemon } from "../../v2/daemon/src/daemon.ts";
import { QuotaRecovery } from "../../v2/daemon/src/quotaRecovery.ts";
import { completionHeadroom, DEFAULT_ACCOUNT_ADMISSION_POLICY } from "../../v2/core/src/accountAllocation.ts";

const root = mkdtempSync(join(tmpdir(), "sar-e-queen-seams-"));
const path = join(root, "core.sqlite3");
const store = openCoreStore(path, { ephemeral: true });
const db = (store as any).db;
store.createAccount({ id: "claude-a", harness: "claude", label: "a", homePath: join(root, "a") });
const { bee } = store.createBee({ name: "control", agent: "claude", substrate: "hsr", cwd: root, account: "claude-a" });
store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
store.updateRuntimeState(bee.id, 1, "idle");
const daemon: any = Object.create(HiveDaemon.prototype);
daemon.store = store;
daemon.accounts = { proactiveAdmissionEnabled: () => true };
for (const column of ["active_move_id", "active_handoff_id"]) {
  db.prepare(`UPDATE bees SET ${column} = ? WHERE id = ?`).run("fixture-control", bee.id);
  for (let poll = 0; poll < 100; poll++) {
    assert.equal(daemon.admitProviderTurn(bee.id, 1), true);
    assert.equal(store.requireCompletionHeadroom(bee.id, 1, { fetchedAt: Date.now(), maxProjectedPercent: 95 }, Date.now() + 100000), null);
  }
  assert.equal(store.listQuotaRecoveries(bee.id).length, 0);
  db.prepare(`UPDATE bees SET ${column} = NULL WHERE id = ?`).run(bee.id);
  console.log(JSON.stringify({ case: column, polls: 100, admitted: true, recoveryRows: 0 }));
}
const candidate: any = {
  accountId: "claude-a", capacityUnits: 1, reservations: 0,
  activity: { active: 0, pending: 0, recent: 0 },
  quota: { fetchedAt: Date.now(), windows: [
    { kind: "fiveHour", usedPercent: 5, resetsAt: Date.now() + 3600000, velocityPerHour: 0, admissionCostPercent: 4 },
    { kind: "weekly", usedPercent: 95, resetsAt: Date.now() + 86400000, velocityPerHour: 0, admissionCostPercent: 1 },
  ] },
};
const protectedWeekly = completionHeadroom(candidate, { ...DEFAULT_ACCOUNT_ADMISSION_POLICY, now: Date.now() });
assert.equal(protectedWeekly.status, "protected");
assert.equal(protectedWeekly.retryAt, candidate.quota.windows[1].resetsAt);
console.log(JSON.stringify({ case: "protected-window-reset", ...protectedWeekly }));
const recovery = store.requireCompletionHeadroom(bee.id, 1, { fetchedAt: Date.now(), maxProjectedPercent: 95 }, Date.now() + 100000)!;
assert.ok(store.claimQuotaRecovery(recovery.id, { targetAccount: "claude-a" }));
store.bindQuotaRecovery(recovery.id, null);
store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_system" });
store.reviveBee(bee.id, { proc: { pid: 2, pidStartedAt: 2 } });
store.updateRuntimeState(bee.id, 2, "stopped", { exitCause: "crashed" });
store.setFlag(bee.id, "spawn_failed", "fixture successor exhausted boot budget");
const reconciler = new QuotaRecovery(store);
reconciler.reconcile();
assert.equal(store.getQuotaRecovery(recovery.id)?.reason, "successor_spawn_failed");
assert.equal(store.quotaDeliveryGate(bee.id).held, false);
console.log(JSON.stringify({ case: "successor-spawn-failed", state: store.getQuotaRecovery(recovery.id)?.state, deliveryHeld: false }));
const provider = store.createBee({ name: "provider-failed", agent: "claude", substrate: "hsr", cwd: root, account: "claude-a" }).bee;
store.updateRuntimeState(provider.id, 1, "running", { pid: 3, pidStartedAt: 3 });
const original = store.send(provider.id, "owed human request").message;
store.markDelivered(original.id, 1);
store.recordQuotaEvidence({ eventId: "fixture-provider-limit", beeId: provider.id, generation: 1,
  quota: { harness: "claude", window: "weekly", resetsAt: Date.now() + 86400000, providerCategory: "rate_limit_event" },
  turn: { messageIds: [original.id], progress: "none" } });
const providerRecovery = store.listQuotaRecoveries(provider.id)[0]!;
assert.ok(store.claimQuotaRecovery(providerRecovery.id, { targetAccount: "claude-a" }));
store.bindQuotaRecovery(providerRecovery.id, null);
store.updateRuntimeState(provider.id, 1, "stopped", { exitCause: "stopped_by_system" });
store.reviveBee(provider.id, { proc: { pid: 4, pidStartedAt: 4 } });
store.updateRuntimeState(provider.id, 2, "running", { synthetic: true });
const resumed = store.resumeQuotaRecovery(providerRecovery.id)!;
assert.equal(resumed.continuationKind, "replay");
store.updateRuntimeState(provider.id, 2, "stopped", { exitCause: "crashed" });
store.setFlag(provider.id, "spawn_failed", "fixture provider successor exhausted budget");
reconciler.reconcile();
assert.equal(store.getQuotaRecovery(providerRecovery.id)?.state, "rotating");
assert.ok(store.undeliveredMessages(provider.id).some(message => resumed.continuationMessageIds.includes(message.id) && message.body === original.body));
console.log(JSON.stringify({ case: "provider-spawn-failed", state: "rotating", replayStillPending: true, automaticRetry: false }));
console.log(JSON.stringify({ case: "indexed-proactive-boundary", plan: db.prepare("EXPLAIN QUERY PLAN SELECT MAX(json_extract(payload, '$.createdAt')) FROM quota_recoveries WHERE json_extract(payload, '$.sourceAccount') = ? AND json_type(payload, '$.admission') = 'object'").all("claude-a") }));
store.close();
