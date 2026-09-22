import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";

const START = Date.parse("2026-09-22T00:00:00Z");
const HOUR = 3_600_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const samples: Array<{ size: number; round: number; activePendingReads: number; parity: boolean; factsHash?: string; error?: string }> = [];

after(() => {
  const path = process.env.HIVE_ACCOUNT_ACTIVITY_RECEIPT;
  if (!path) return;
  const sources = Object.fromEntries(["../src/accountsService.ts", "../src/config.ts", "../../core/src/store.ts", "./accounts-activity.test.ts"].map((name) =>
    [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]));
  const complete = samples.length === 12 && samples.every((s) => !s.error && s.parity);
  writeFileSync(path, JSON.stringify({
    workload: "account-activity-reads", seriesId: "account-activity-reads-v1", capturedAt: new Date().toISOString(),
    host: hostname(), node: process.version, load: loadavg(), sources, complete, samples,
    results: [{ metric: "activePendingReads", samples: samples.map((s) => s.activePendingReads),
      invariantHolds: complete && samples.every((s) => s.activePendingReads === 0) }],
    limits: "Store call counts only; public nodeActivity, fixture SQLite, no provider/runtime. Behavioral tests are separate from sample completeness. No latency/CPU/RSS claim.",
  }, null, 2) + "\n");
});

function fixture(run: (store: CoreStore, service: AccountsService, advance: (ms: number) => void, reopen: () => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hb-account-activity-"));
  let store: CoreStore | undefined;
  try {
    let now = START;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: {
      allocationMode: "active", allocationNodeId: "fixture", allocationOwner: { node: "fixture", epoch: "epoch" },
      allocationRecentGraceMs: HOUR, vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0,
    } }));
    const cfg = loadNodeConfig(dir);
    const open = () => openCoreStore(join(dir, "core.sqlite3"), { now: () => now, ephemeral: true });
    store = open();
    for (const id of ["a", "b"]) store.createAccount({ id, harness: "claude", homePath: join(dir, id), label: id });
    const svc = new AccountsService({ store, cfg, now: () => now, log: () => undefined });
    // Reopen is the final operation of a behavioral fixture.
    run(store, svc, (ms) => { now += ms; }, () => {
      const expected = svc.nodeActivity("claude");
      store!.close();
      store = undefined;
      store = open();
      const reopened = new AccountsService({ store, cfg, now: () => now, log: () => undefined });
      assert.deepEqual(reopened.nodeActivity("claude"), expected);
    });
  } finally {
    try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

for (const size of [0, 1, 120, 2000]) for (let round = 0; round < 3; round += 1) {
  test(`active pending reads: ${size} bees, round ${round}`, () => {
    const sample = { size, round, activePendingReads: 0, parity: false } as (typeof samples)[number];
    samples.push(sample);
    try {
      fixture((store, svc) => {
          for (let i = 0; i < size; i += 1) {
            const id = `bee-${i}`;
            store.createBee({ id, name: id, handle: `AC.${i}`, agent: "claude", substrate: "hsr", cwd: "/fixture", account: i % 2 === 0 ? "a" : "b" });
            if (i % 2 === 1) store.updateRuntimeState(id, 1, "running", { pid: i + 1, pidStartedAt: START });
            if (i % 2 === 0) store.send(id, "pending fixture mail", { sender: "operator" });
            else store.enqueueCommand("revive", id, {});
          }
        const before = hash(store.dumpState());
        const mailbox = store.undeliveredMessages.bind(store);
        const commands = store.listCommands.bind(store);
        store.undeliveredMessages = (id) => { sample.activePendingReads += 1; return mailbox(id); };
        store.listCommands = (filter) => { sample.activePendingReads += 1; return commands(filter); };
        let result;
        try { result = svc.nodeActivity("claude"); }
        finally { store.undeliveredMessages = mailbox; store.listCommands = commands; }
        assert.deepEqual(result.accounts, [
          { account: "a", active: Math.ceil(size / 2), recent: 0, pending: 0, ongoingUnits: Math.ceil(size / 2), observedClaimIds: [] },
          { account: "b", active: Math.floor(size / 2), recent: 0, pending: 0, ongoingUnits: Math.floor(size / 2), observedClaimIds: [] },
        ]);
        assert.equal(hash(store.dumpState()), before, "activity read must not change durable state");
        sample.factsHash = hash(result);
        sample.parity = true;
      });
    } catch (error) { sample.error = String(error); throw error; }
    assert.equal(sample.activePendingReads, 0, "active classification must not read unused pending work");
  });
}

test("inactive pending work remains fresh, active age and transfer claims retain generation ownership", () => {
  fixture((store, svc, advance, reopen) => {
    const bee = (id: string) => store.createBee({ id, name: id, agent: "claude", substrate: "hsr", cwd: "/fixture", account: "a" });
    bee("transfer");
    store.updateRuntimeState("transfer", 1, "running", { pid: 1, pidStartedAt: START });
    advance(3 * HOUR);
    store.setBeeAccount("transfer", "b");
    const reserve = (id: string, account: string, sourceAccount: string | null) => {
      store.reserveAccountAdmission({ id, requestKey: id, scope: "claude:provider-accounts", account, sourceAccount,
        operation: "swap", units: 1, expiresAt: START + 10 * HOUR, reconcileAfterGeneration: 1, receipt: {} });
      store.bindAccountAdmission(id, "transfer");
    };
    reserve("old-claim", "a", null);
    reserve("transfer-claim", "b", "a");
    const facts = () => svc.nodeActivity("claude").accounts;
    assert.deepEqual(facts(), [
      { account: "a", active: 1, recent: 0, pending: 0, ongoingUnits: 3, observedClaimIds: ["old-claim"] },
      { account: "b", active: 0, recent: 0, pending: 0, ongoingUnits: 0, observedClaimIds: [] },
    ]);
    store.updateRuntimeState("transfer", 1, "idle");
    store.send("transfer", "new work", { sender: "operator" });
    assert.deepEqual(facts()[0], { account: "a", active: 0, recent: 0, pending: 1, ongoingUnits: 1, observedClaimIds: ["old-claim"] });
    bee("command");
    store.updateRuntimeState("command", 1, "stopped", { exitCause: "clean" });
    store.enqueueCommand("spawn", "command", {});
    assert.equal(facts()[0]!.pending, 2);
    bee("recent");
    store.updateRuntimeState("recent", 1, "stopped", { exitCause: "clean" });
    advance(HOUR / 2);
    assert.equal(facts()[0]!.recent, 1);
    assert.equal(facts()[0]!.ongoingUnits, 2.5);
    advance(HOUR);
    assert.equal(facts()[0]!.recent, 0);
    assert.equal(facts()[0]!.pending, 2);
    reopen();
  });
});
