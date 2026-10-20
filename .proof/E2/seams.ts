import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { ReadOnlyStore } from "../../v2/cli/src/readonly.ts";

const root = mkdtempSync(join(tmpdir(), "sar-e2-seams-"));
const path = join(root, "core.sqlite3");
let store = openCoreStore(path, { ephemeral: true });
store.createAccount({ id: "claude-a", harness: "claude", label: "a", homePath: join(root, "a") });
const bee = store.createBee({ name: "automatic", agent: "claude", substrate: "hsr", cwd: root, account: "claude-a" }).bee;
store.updateRuntimeState(bee.id, 1, "running", { pid: 1, pidStartedAt: 1 });
store.updateRuntimeState(bee.id, 1, "idle");
store.setFlag(bee.id, "resource_blocked", "fixture quota");
store.recordQuotaEvidence({ eventId: "fixture", beeId: bee.id, generation: 1,
  quota: { harness: "claude", window: "weekly", resetsAt: Date.now() + 86400000, providerCategory: "rate_limit_event" },
  turn: { messageIds: [], progress: "none" } });
const row = store.listQuotaRecoveries(bee.id)[0]!;
const check = (expected: boolean, phase: string) => {
  assert.equal(store.view(bee.id).waitingForYou, expected);
  assert.equal(store.listBeeViewRows()[0]!.view.waitingForYou, expected);
  assert.equal(store.view(bee.id).blocked, true);
  assert.deepEqual(store.view(bee.id).flags, ["resource_blocked"]);
  store.close();
  const reader = new ReadOnlyStore(path);
  assert.equal(reader.view(bee.id).view.waitingForYou, expected);
  assert.equal(reader.list(null)[0]!.view.waitingForYou, expected);
  reader.close();
  store = openCoreStore(path, { ephemeral: true });
  console.log(JSON.stringify({ phase, waitingForYou: expected, flags: ["resource_blocked"], coreListAndReadonlyAgree: true }));
};
check(false, "waiting");
for (const detail of ["credential_login_required", "lease_needs_operator", "paused", "unavailable", "operation_in_progress"] as const) {
  store.waitQuotaRecovery(row.id, null, "account_unavailable", detail);
  check(detail !== "operation_in_progress", detail);
}
store.waitQuotaRecovery(row.id, null, "account_unavailable", "future_unknown" as any);
check(true, "unknown-detail");
store.waitQuotaRecovery(row.id, null, "future_unknown");
check(true, "unknown-reason");
store.waitQuotaRecovery(row.id, null, "allocation_owner_required");
check(false, "owner-required");
store.waitQuotaRecovery(row.id, null, "account_wait");
check(false, "capacity-without-retry");
assert.ok(store.claimQuotaRecovery(row.id, { targetAccount: "claude-a" }));
check(false, "rotating");
(store as any).db.prepare("UPDATE bees SET auth_control_fence = 1 WHERE id = ?").run(bee.id);
check(true, "invalid-control-fence");
(store as any).db.prepare("UPDATE bees SET auth_control_fence = 0 WHERE id = ?").run(bee.id);
store.cancelQuotaRecovery(row.id, "fixture_cancelled");
check(true, "cancelled");
store.close();
