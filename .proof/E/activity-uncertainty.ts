import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { AccountsService } from "../../v2/daemon/src/accountsService.ts";
import { loadNodeConfig } from "../../v2/daemon/src/config.ts";
const dir = mkdtempSync(join(tmpdir(), "activity-uncertainty-"));
const now = Date.now();
writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { allocationMode: "active", allocationNodeId: "fixture", allocationOwner: { node: "fixture", epoch: "epoch" }, vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0 } }));
const store = openCoreStore(join(dir, "core.sqlite3"), { now: () => now, ephemeral: true });
store.createAccount({ id: "a", harness: "fixture", label: "a", homePath: join(dir, "homes", "a") });
store.putAccountLimits("a", { readable: true, fetchedAt: now, fiveHour: { usedPercent: 5, resetsAt: now + 3600000, windowMinutes: 300 }, weekly: { usedPercent: 5, resetsAt: now + 86400000, windowMinutes: 10080 } });
const svc = new AccountsService({ store, cfg: loadNodeConfig(dir), now: () => now, log: () => undefined });
const fresh = { version: 1 as const, scope: svc.allocationScope("fixture"), authority: { node: "fixture", epoch: "epoch" }, revision: "fleet", observedAt: now, complete: true, accounts: [] };
for (const [name, context] of [["missing", null], ["incomplete", { ...fresh, complete: false }], ["stale", { ...fresh, observedAt: now - 120001 }]] as const) {
  const result = svc.admitNewWork("fixture", { operation: "spawn", requestKey: name, context });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.code, "account_wait"); assert.equal(result.receipt.reason, "activity_unknown"); }
  console.log(JSON.stringify({ name, passed: true, outcome: "wait", reason: "activity_unknown" }));
}
assert.equal(store.listAccountAdmissions().length, 0);
store.close();
