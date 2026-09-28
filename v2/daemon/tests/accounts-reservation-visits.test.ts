import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";

const START = Date.parse("2026-09-28T00:00:00Z");
const HOUR = 3_600_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Sample = { size: number; profile: string; round: number; reservationRows: number; reservationBeeIdReads: number; excessBeeIdReads: number; complete: boolean; outputHash?: string; error?: string };
const samples: Sample[] = [];
let controls = 0;

function fixture(run: (store: CoreStore, service: AccountsService, advance: (ms: number) => void, reopen: () => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hb-reservation-visits-"));
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
    store.createAccount({ id: "other", harness: "grok", homePath: join(dir, "other"), label: "other" });
    const service = new AccountsService({ store, cfg, now: () => now, log: () => undefined });
    run(store, service, (ms) => { now += ms; }, () => {
      const expected = service.nodeActivity("claude");
      store!.close(); store = undefined; store = open();
      const reopened = new AccountsService({ store, cfg, now: () => now, log: () => undefined });
      assert.deepEqual(reopened.nodeActivity("claude"), expected);
    });
  } finally {
    try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

function reserve(store: CoreStore, id: string, bee: string | null, account: string, sourceAccount: string | null = null, expiresAt = START + 10 * HOUR) {
  store.reserveAccountAdmission({ id, requestKey: id, scope: "claude:provider-accounts", account, sourceAccount,
    operation: "swap", units: 1, expiresAt, reconcileAfterGeneration: 1, receipt: { marker: id } });
  if (bee !== null) store.bindAccountAdmission(id, bee);
}

for (const size of [0, 12, 120, 1200]) for (const profile of ["ordinary", "transfer", "skew", "history"]) for (const round of [0, 1]) {
  test(`reservation visits ${size}/${profile}/${round}`, () => {
    const sample: Sample = { size, profile, round, reservationRows: 0, reservationBeeIdReads: 0, excessBeeIdReads: 0, complete: false };
    samples.push(sample);
    try {
      fixture((store, service, advance) => {
        const expected = ["a", "b"].map(account => ({ account, active: 0, recent: 0, pending: 0, ongoingUnits: 0, observedClaimIds: [] as string[] }));
        store.transact(() => {
          for (let i = 0; i < size; i++) {
            const id = `bee-${i}`;
            const account = profile === "transfer" ? "a" : i % 2 ? "b" : "a";
            store.createBee({ id, name: id, handle: `RV.${i}`, agent: "claude", substrate: "hsr", cwd: "/fixture", account });
            const state = i % 6;
            if (state === 1) store.updateRuntimeState(id, 1, "running", { pid: i + 1, pidStartedAt: START });
            if (state >= 2) store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
            if (state === 2) store.send(id, "pending", { sender: "operator" });
            if (state === 3) store.enqueueCommand("revive", id, {});
            const fact = expected[account === "a" ? 0 : 1]!;
            if (state < 2) { fact.active++; fact.ongoingUnits += 2; }
            else if (state < 4) { fact.pending++; fact.ongoingUnits++; }
            else if (state === 4) { fact.recent++; fact.ongoingUnits += 0.5; }
            const claim = `${id}-0-own`;
            reserve(store, claim, profile === "skew" ? "bee-0" : id, profile === "skew" ? "a" : account);
            if (profile === "skew") expected[0]!.observedClaimIds.push(claim);
            else if (state !== 5) fact.observedClaimIds.push(claim);
            if (profile === "transfer") {
              store.setBeeAccount(id, "b");
              reserve(store, `${id}-1-transfer`, id, "b", "a");
              reserve(store, `${id}-2-later`, id, "a", "b");
              if (state !== 5) fact.observedClaimIds.push(`${id}-2-later`);
            }
            if (profile === "history") {
              reserve(store, `${id}-expired`, id, "b", "other", START + 2 * HOUR);
              reserve(store, `${id}-released`, id, "b", "other");
              store.releaseAccountAdmission(`${id}-released`);
              reserve(store, `${id}-unbound`, null, "b", "other");
            }
          }
        });
        advance(HOUR * 1.5);
        for (let i = 4; i < size; i += 6) store.recordOutput(`bee-${i}`);
        advance(HOUR * 0.5);
        expected.forEach(row => row.observedClaimIds.sort());
        const before = hash(store.dumpState());
        const original = store.listAccountAdmissions.bind(store);
        store.listAccountAdmissions = () => original().map(row => {
          sample.reservationRows++;
          const value = row.beeId;
          Object.defineProperty(row, "beeId", { enumerable: true, configurable: true, get() { sample.reservationBeeIdReads++; return value; } });
          return row;
        });
        let result;
        try { result = service.nodeActivity("claude"); } finally { store.listAccountAdmissions = original; }
        assert.deepEqual(result.accounts, expected);
        assert.equal(hash(store.dumpState()), before);
        sample.outputHash = hash(result);
        sample.excessBeeIdReads = Math.max(0, sample.reservationBeeIdReads - sample.reservationRows);
        sample.complete = true;
      });
    } catch (error) { sample.error = String(error); throw error; }
    assert.equal(sample.excessBeeIdReads, 0);
  });
}

test("first transfer ordering, fresh release/expiry/generation, rollback and reopen", () => {
  fixture((store, service, advance, reopen) => {
    store.createBee({ id: "bee", name: "bee", agent: "claude", substrate: "hsr", cwd: "/fixture", account: "b" });
    reserve(store, "z-later", "bee", "a", "other");
    reserve(store, "a-first", "bee", "b", "a", START + HOUR);
    const facts = () => service.nodeActivity("claude").accounts;
    assert.equal(facts()[0]!.active, 1);
    assert.throws(() => store.transact(() => { store.releaseAccountAdmission("a-first"); assert.equal(facts()[0]!.active, 0); throw new Error("rollback"); }), /rollback/);
    assert.equal(facts()[0]!.active, 1);
    advance(HOUR);
    assert.equal(facts()[0]!.active, 0);
    store.releaseAccountAdmission("z-later");
    assert.equal(facts()[1]!.active, 1);
    reserve(store, "fresh", "bee", "b", "a");
    assert.equal(facts()[0]!.active, 1);
    store.updateRuntimeState("bee", 1, "stopped", { exitCause: "clean" }); store.reviveBee("bee");
    assert.equal(facts()[1]!.active, 1);
    let reads = 0; const original = store.listAccountAdmissions.bind(store);
    store.listAccountAdmissions = () => { reads++; return original(); };
    try { assert.deepEqual(service.nodeActivity("missing").accounts, []); } finally { store.listAccountAdmissions = original; }
    assert.equal(reads, 0);
    reopen(); controls++;
  });
});

after(() => {
  const path = process.env.HIVE_RESERVATION_VISITS_RECEIPT;
  if (!path) return;
  const sources = Object.fromEntries(["../src/accountsService.ts", "../src/config.ts", "../../core/src/store.ts", "./accounts-reservation-visits.test.ts"].map(name => [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]));
  const complete = samples.length === 32 && samples.every(sample => sample.complete && !sample.error) && controls === 1;
  writeFileSync(path, JSON.stringify({ workload: "account-activity-reservation-visits", seriesId: `reservation-visits-v1:${hostname()}:${process.version}:${process.platform}:${process.arch}`,
    capturedAt: new Date().toISOString(), host: hostname(), node: process.version, load: loadavg(), sources, complete, samples, controls,
    results: [{ metric: "excessBeeIdReads", samples: samples.map(sample => sample.excessBeeIdReads), invariantHolds: complete && samples.every(sample => sample.excessBeeIdReads === 0) }],
    limits: "Call-through beeId field getters on real returned reservation rows during public nodeActivity. No SQL scan, receipt decode, CPU, latency, memory, provider or process claim. Temporary grouping allocation is unmeasured.",
  }, null, 2) + "\n");
});
