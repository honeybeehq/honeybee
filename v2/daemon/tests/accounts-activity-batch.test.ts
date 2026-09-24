import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";

const START = Date.parse("2026-09-24T00:00:00Z");
const HOUR = 3_600_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Sample = {
  accounts: number; bees: number; round: number;
  runtimeReads: number; rosterReads: number; admissionReads: number;
  excessRuntimeReads: number; parity: boolean; factsHash?: string; error?: string;
};
const samples: Sample[] = [];

after(() => {
  const path = process.env.HIVE_ACTIVITY_BATCH_RECEIPT;
  if (!path) return;
  const sources = Object.fromEntries(["../src/accountsService.ts", "../src/config.ts", "../../core/src/store.ts", "./accounts-activity-batch.test.ts"].map((name) =>
    [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]));
  const complete = samples.length === 32 && samples.every((sample) => sample.parity && !sample.error);
  writeFileSync(path, JSON.stringify({
    workload: "account-activity-batch", seriesId: `account-activity-batch-v1:${hostname()}:${process.version}:${process.platform}:${process.arch}`, capturedAt: new Date().toISOString(),
    host: hostname(), node: process.version, load: loadavg(), sources, complete, samples,
    results: [{ metric: "excessRuntimeReads", samples: samples.map((sample) => sample.excessRuntimeReads),
      invariantHolds: complete && samples.every((sample) => sample.excessRuntimeReads === 0
        && sample.rosterReads <= Math.min(1, sample.accounts) && sample.admissionReads <= Math.min(1, sample.accounts)) }],
    limits: "Call counts in one synchronous public report; no provider, runtime, CPU, latency or RSS claim. Behavioral controls are separate from sample completeness.",
  }, null, 2) + "\n");
});

function fixture(accounts: number, run: (store: CoreStore, service: AccountsService, setNow: (now: number) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hb-activity-batch-"));
  let store: CoreStore | undefined;
  try {
    let now = START;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: {
      allocationMode: "active", allocationNodeId: "fixture", allocationOwner: { node: "fixture", epoch: "epoch" },
      allocationRecentGraceMs: HOUR, vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0,
    } }));
    store = openCoreStore(join(dir, "core.sqlite3"), { now: () => now, ephemeral: true });
    for (let i = 0; i < accounts; i += 1) store.createAccount({ id: `a${i}`, harness: "claude", homePath: join(dir, `a${i}`), label: `a${i}` });
    store.createAccount({ id: "other", harness: "grok", homePath: join(dir, "other"), label: "other" });
    const svc = new AccountsService({ store, cfg: loadNodeConfig(dir), now: () => now, log: () => undefined });
    run(store, svc, (value) => { now = value; });
  } finally {
    try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

for (const accounts of [0, 1, 4, 8]) for (const bees of [0, 12, 120, 1200]) for (let round = 0; round < 2; round += 1) {
  test(`batch activity: ${accounts} accounts/${bees} bees, round ${round}`, () => {
    const sample: Sample = { accounts, bees, round, runtimeReads: 0, rosterReads: 0, admissionReads: 0, excessRuntimeReads: 0, parity: false };
    samples.push(sample);
    try {
      fixture(accounts, (store, svc, setNow) => {
        const expected = Array.from({ length: accounts }, (_, i) => ({
          account: `a${i}`, active: 0, pending: 0, recent: 0, ongoingUnits: 0, observedClaimIds: [] as string[],
        }));
        for (let i = 0; i < bees; i += 1) {
          const id = `bee-${i}`;
          store.createBee({ id, name: id, handle: `BA.${i}`, agent: "claude", substrate: "hsr", cwd: "/fixture", account: accounts ? `a${i % accounts}` : "other" });
          const state = i % 6;
          if (state === 1) store.updateRuntimeState(id, 1, "running", { pid: i + 1, pidStartedAt: START });
          if (state === 2) {
            store.updateRuntimeState(id, 1, "running", { pid: i + 1, pidStartedAt: START });
            store.updateRuntimeState(id, 1, "idle");
            store.send(id, "pending", { sender: "operator" });
          }
          if (state >= 3) store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
          if (state === 3) store.enqueueCommand("revive", id, {});
          const fact = expected[i % Math.max(1, accounts)];
          if (fact) {
            if (state < 2) { fact.active += 1; fact.ongoingUnits += 2; }
            else if (state < 4) { fact.pending += 1; fact.ongoingUnits += 1; }
            else if (state === 4) { fact.recent += 1; fact.ongoingUnits += 0.5; }
          }
        }
        setNow(START + HOUR * 1.5);
        for (let i = 4; i < bees; i += 6) store.recordOutput(`bee-${i}`);
        setNow(START + HOUR * 2);
        const before = hash(store.dumpState());
        const runtime = store.currentRuntime.bind(store);
        const roster = store.listBees.bind(store);
        const reservations = store.listAccountAdmissions.bind(store);
        store.currentRuntime = (id) => { sample.runtimeReads += 1; return runtime(id); };
        store.listBees = (...args) => { sample.rosterReads += 1; return roster(...args); };
        store.listAccountAdmissions = () => { sample.admissionReads += 1; return reservations(); };
        let result;
        try { result = svc.nodeActivity("claude"); }
        finally { store.currentRuntime = runtime; store.listBees = roster; store.listAccountAdmissions = reservations; }
        assert.deepEqual(result.accounts, expected);
        assert.equal(hash(store.dumpState()), before);
        sample.factsHash = hash(result);
        sample.excessRuntimeReads = sample.runtimeReads - (accounts ? bees : 0);
        sample.parity = true;
      });
    } catch (error) { sample.error = String(error); throw error; }
    assert.equal(sample.excessRuntimeReads, 0);
    assert.ok(sample.rosterReads <= Math.min(1, accounts));
    assert.ok(sample.admissionReads <= Math.min(1, accounts));
  });
}

test("batch reports stay fresh across account reassignment and claim expiry", () => {
  fixture(2, (store, svc, setNow) => {
    store.createBee({ id: "transfer", name: "transfer", agent: "claude", substrate: "hsr", cwd: "/fixture", account: "a0" });
    store.setBeeAccount("transfer", "a1");
    store.reserveAccountAdmission({ id: "claim", requestKey: "claim", scope: "claude:provider-accounts", account: "a1", sourceAccount: "a0",
      operation: "swap", units: 1, expiresAt: START + HOUR, reconcileAfterGeneration: 1, receipt: {} });
    store.bindAccountAdmission("claim", "transfer");
    assert.equal(svc.nodeActivity("claude").accounts[0]!.active, 1);
    setNow(START + HOUR);
    assert.equal(svc.nodeActivity("claude").accounts[0]!.active, 0);
    assert.equal(svc.nodeActivity("claude").accounts[1]!.active, 1);
    store.setBeeAccount("transfer", "other");
    assert.equal(svc.nodeActivity("claude").accounts[1]!.active, 0);
    assert.equal(svc.nodeActivity("grok").accounts[0]!.active, 1);
  });
});
