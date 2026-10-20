import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDaemonDir } from "../../v2/daemon/tests/helpers.ts";
import { loadNodeConfig } from "../../v2/daemon/src/config.ts";
import { AccountsService } from "../../v2/daemon/src/accountsService.ts";
import { openCoreStore } from "../../v2/core/src/index.ts";
const { dir } = makeDaemonDir({ accounts: { allocationMode: "shadow" } });
const cfg = loadNodeConfig(dir);
assert.equal(cfg.accounts.proactiveOwnerWaitMs, 90000);
assert.equal(cfg.accounts.proactiveOwnerCooldownMs, 900000);
cfg.accounts.allocationMode = "active";
const store = openCoreStore(join(dir, "core.sqlite3"));
let now = 100000;
const service = new AccountsService({ store, cfg, log: () => undefined, now: () => now });
assert.equal(service.proactiveOwnerWaitExpired(10001), false);
assert.equal(service.proactiveOwnerWaitExpired(10000), true);
cfg.accounts.allocationMode = "shadow";
assert.equal(service.proactiveOwnerWaitExpired(0), false);
store.close();
for (const key of ["proactiveOwnerWaitMs", "proactiveOwnerCooldownMs"]) {
 for (const value of [0, 999, -1, "1000", null]) {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { [key]: value } }));
  assert.throws(() => loadNodeConfig(dir), /must be at least 1000/);
 }
}
console.log(JSON.stringify({ defaults: "90000/900000", activeBoundary: "before=false, at=true", shadowExpiry: false, invalidValuesRejected: 10, passed: true }));
