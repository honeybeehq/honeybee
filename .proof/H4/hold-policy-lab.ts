import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openCoreStore } from "../../v2/core/src/index.ts";
import { AccountsService } from "../../v2/daemon/src/accountsService.ts";
import { HiveDaemon } from "../../v2/daemon/src/daemon.ts";
import { loadNodeConfig } from "../../v2/daemon/src/config.ts";
import { ReadOnlyStore } from "../../v2/cli/src/readonly.ts";

const root = process.env.HOME!;
if (!root || root !== process.env.TMPDIR || !/^\/(?:private\/)?var\/tmp\//.test(root)) throw new Error("Isolated HOME and TMPDIR required");
const dir = join(root, `hold-policy-${process.pid}`), home = join(dir, "homes", "claude-lab");
mkdirSync(home, { recursive: true });
writeFileSync(join(home, ".credentials.json"), "{}");
writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: { homesDir: join(dir, "homes"), vaultDir: join(dir, "vault") } }));
let now = 100000;
const realNow = Date.now;
Date.now = () => now;
const store = openCoreStore(join(dir, "core.sqlite3"), { ephemeral: true, now: () => now });
const account = store.createAccount({ id: "claude-lab", harness: "claude", label: "lab", homePath: home, status: "ok" });
const { bee } = store.createBee({ name: "held", agent: "claude", substrate: "hsr", cwd: dir, account: account.id });
store.updateRuntimeState(bee.id, 1, "stopped", { exitCause: "stopped_by_user" });
const cfg = loadNodeConfig(dir), accounts = new AccountsService({ store, cfg, now: () => now, log: () => {}, keychainReader: async () => null });
let probes = 0;
accounts.scheduleVerification = ids => { probes++; return [...ids]; };
const daemon: any = new HiveDaemon(cfg);
daemon.store = store; daemon.accounts = accounts;
daemon.accountActivationCandidates.set(bee.id, { commandId: 1, attempts: 0, enqueuedAt: 1 });
let code: string | null = "credential_file_damaged";
daemon.runtimeStartReadiness = () => code ? { ready: false, code, message: `fixture ${code}` } : { ready: true };
try {
  daemon.holdRuntimeStart(bee, account, 1);
  assert.equal(probes, 1);
  now += 30000; daemon.holdRuntimeStart(bee, account, 1); assert.equal(probes, 2);
  now += 30000; daemon.holdRuntimeStart(bee, account, 1); assert.equal(probes, 2);
  now += 30000; daemon.holdRuntimeStart(bee, account, 1); assert.equal(probes, 3);
  assert.equal(daemon.runtimeStartProbeAt.get(account.id).at - now, 120000);
  writeFileSync(join(home, ".credentials.json"), "");
  daemon.holdRuntimeStart(bee, account, 1); assert.equal(probes, 4);
  assert.equal(daemon.runtimeStartProbeAt.get(account.id).at - now, 30000);
  daemon.credentialValidatedQuietly(account.id, "login"); daemon.holdRuntimeStart(bee, account, 1); assert.equal(probes, 5);
  for (let i = 0; i < 10; i++) { now = daemon.runtimeStartProbeAt.get(account.id).at; daemon.holdRuntimeStart(bee, account, 1); }
  assert.equal(daemon.runtimeStartProbeAt.get(account.id).at - now, 900000);
  console.log(JSON.stringify({ scenario: "backoff", intervals: [30000, 60000, 120000], ceiling: 900000, revisionReset: true, loginReset: true }));
  for (const refusal of ["account_lease_revoked", "account_unavailable", "account_paused"]) {
    code = refusal; daemon.holdRuntimeStart(bee, account, 1);
    const flags = store.activeFlags(bee.id);
    assert.ok(!flags.some(flag => flag.flag === "auth_needed"));
    assert.ok(flags.some(flag => flag.flag === "resource_blocked" && flag.detail.includes(refusal)));
    assert.equal(store.view(bee.id).waitingForYou, true);
    code = null; daemon.holdRuntimeStart(bee, account, 1); assert.equal(store.activeFlags(bee.id).length, 0);
    console.log(JSON.stringify({ scenario: "typed-hold", code: refusal, flag: "resource_blocked", needsYou: true, releaseCleared: true }));
  }
  store.setFlag(bee.id, "resource_blocked", "ordinary provider quota", { resetsAt: now + 60000 });
  assert.equal(store.view(bee.id).waitingForYou, false);
  assert.equal(store.listBeeViewRows()[0].view.waitingForYou, false);
  console.log(JSON.stringify({ scenario: "ordinary-quota", resetsAtPresent: true, needsYou: false }));
  const { bee: held } = store.createBee({ name: "readonly-held", agent: "claude", substrate: "hsr", cwd: dir, account: account.id });
  store.updateRuntimeState(held.id, 1, "stopped", { exitCause: "stopped_by_user" });
  store.setFlag(held.id, "resource_blocked", "runtime_start_held: account_lease_revoked: fixture");
  assert.equal(store.view(held.id).waitingForYou, true);
  assert.equal(store.listBeeViewRows().find(row => row.bee.id === held.id)!.view.waitingForYou, true);
  store.close();
  const readonly = new ReadOnlyStore(join(dir, "core.sqlite3"));
  try {
    assert.equal(readonly.view(held.id).view.waitingForYou, true);
    assert.equal(readonly.view(bee.id).view.waitingForYou, false);
    console.log(JSON.stringify({ scenario: "readonly-parity", ownedHoldNeedsYou: true, ordinaryQuotaNeedsYou: false }));
  } finally { readonly.close(); }
} finally { Date.now = realNow; store.close(); }
