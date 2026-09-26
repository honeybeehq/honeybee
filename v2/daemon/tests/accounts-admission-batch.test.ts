import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService, type NewWorkAdmissionOptions } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";

const START = Date.parse("2026-09-26T00:00:00Z");
const HOUR = 3_600_000;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Mode = "active" | "shadow";
type Sample = {
  mode: Mode; accounts: number; bees: number; filter: string;
  rosterReads: number; runtimeReads: number; admissionReads: number;
  allowedRosterReads: number; excessRosterReads: number;
  complete: boolean; resultHash?: string; effectsHash?: string; error?: string;
};
const samples: Sample[] = [];
let controlsPassed = false;

after(() => {
  const path = process.env.HIVE_ADMISSION_BATCH_RECEIPT;
  if (!path) return;
  const sources = Object.fromEntries([
    "../src/accountsService.ts", "../src/config.ts", "../../core/src/store.ts",
    "../../core/src/accountAllocation.ts", "../../core/src/accountSelect.ts", "../../core/src/accountRecipes.ts",
    "../../core/src/accountLimitsParse.ts", "./accounts-admission-batch.test.ts",
  ].map((name) => [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]));
  const complete = samples.length === 40 && samples.every((sample) => sample.complete && !sample.error) && controlsPassed;
  writeFileSync(path, JSON.stringify({
    workload: "account-admission-batch", seriesId: `account-admission-batch-v1:${hostname()}:${process.version}:${process.platform}:${process.arch}`,
    capturedAt: new Date().toISOString(), host: hostname(), node: process.version, v8: process.versions.v8,
    platform: process.platform, arch: process.arch, load: loadavg(), sources, complete, controlsPassed, samples,
    results: [{ metric: "excessRosterReads", samples: samples.map((sample) => sample.excessRosterReads),
      invariantHolds: complete && samples.every((sample) => sample.excessRosterReads === 0) }],
    limits: "Method-call counts through public admitNewWork; no SQL scan, CPU, latency, RSS, provider or running-daemon claim. Cross-arm parity is computed from retained result/effect hashes, not inferred from completeness.",
  }, null, 2) + "\n");
});

function fixture(mode: Mode, accounts: number, run: (store: CoreStore, svc: AccountsService, dir: string, setNow: (now: number) => void) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hb-admission-batch-"));
  let store: CoreStore | undefined;
  try {
    let now = START;
    writeFileSync(join(dir, "config.json"), JSON.stringify({ accounts: {
      allocationMode: mode, allocationNodeId: "fixture", allocationOwner: { node: "fixture", epoch: "epoch" },
      allocationRecentGraceMs: HOUR, vaultDir: join(dir, "vault"), homesDir: join(dir, "homes"), limitsRefreshMs: 0,
    } }));
    store = openCoreStore(join(dir, "core.sqlite3"), { now: () => now, ephemeral: true });
    for (let i = 0; i < accounts; i += 1) {
      store.createAccount({ id: `a${i}`, harness: "fixture", homePath: join(dir, `a${i}`), label: `a${i}` });
      store.putAccountLimits(`a${i}`, { readable: true, fetchedAt: now,
        fiveHour: { usedPercent: 5, resetsAt: now + 4 * HOUR, windowMinutes: 300 },
        weekly: { usedPercent: 5, resetsAt: now + 144 * HOUR, windowMinutes: 10_080 } });
    }
    const svc = new AccountsService({ store, cfg: loadNodeConfig(dir), now: () => now, log: () => undefined });
    run(store, svc, dir, (value) => { now = value; });
  } finally {
    try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

function options(svc: AccountsService, key = "measured", now = START): NewWorkAdmissionOptions {
  return { operation: "spawn", requestKey: key, reservationId: key,
    context: { version: 1, authority: { node: "fixture", epoch: "epoch" }, scope: svc.allocationScope("fixture"),
      revision: "fleet", observedAt: now, complete: true, accounts: [] } };
}

function measure(mode: Mode, accounts: number, bees: number, filter = "all") {
  test(`admission batch: ${mode}/${accounts}/${bees}/${filter}`, () => {
    const sample: Sample = { mode, accounts, bees, filter, rosterReads: 0, runtimeReads: 0, admissionReads: 0,
      allowedRosterReads: 0, excessRosterReads: 0, complete: false };
    samples.push(sample);
    try {
      fixture(mode, accounts, (store, svc, dir) => {
        for (let i = 0; i < bees; i += 1) {
          const id = `bee-${i}`;
          store.createBee({ id, name: id, handle: `AB.${i}`, agent: "fixture", substrate: "hsr", cwd: "/fixture", account: accounts ? `a${i % accounts}` : null });
          const state = i % 6;
          if (state === 1) store.updateRuntimeState(id, 1, "running", { pid: i + 1, pidStartedAt: START });
          if (state === 2) { store.updateRuntimeState(id, 1, "running", { pid: i + 1, pidStartedAt: START }); store.updateRuntimeState(id, 1, "idle"); store.send(id, "pending", { sender: "operator" }); }
          if (state >= 3) store.updateRuntimeState(id, 1, "stopped", { exitCause: "clean" });
          if (state === 3) store.enqueueCommand("revive", id, {});
          if (state === 4) store.recordOutput(id);
        }
        const opts = options(svc);
        if (filter === "none") opts.excludeAccountIds = new Set(Array.from({ length: accounts }, (_, i) => `a${i}`));
        if (filter === "only") opts.onlyAccountIds = new Set(["a1"]);
        if (filter === "swap") { opts.operation = "swap"; opts.sourceAccount = "a0"; opts.excludeAccountIds = new Set(["a2"]); }
        if (filter === "stale") opts.context = null;
        const eligible = filter === "none" ? 0 : filter === "only" ? 1 : filter === "swap" ? accounts - 2 : accounts;
        const legacyPool = filter === "swap" ? accounts - 1 : eligible;
        sample.allowedRosterReads = (eligible ? 1 : 0) + (mode === "shadow" && legacyPool > 1 && filter !== "only" ? 1 : 0);
        const before = store.dumpState();
        const seq = store.auditRows().at(-1)?.seq ?? 0;
        const runtime = store.currentRuntime.bind(store);
        const roster = store.listBees.bind(store);
        const reservations = store.listAccountAdmissions.bind(store);
        store.currentRuntime = (id) => { sample.runtimeReads += 1; return runtime(id); };
        store.listBees = (...args) => { sample.rosterReads += 1; return roster(...args); };
        store.listAccountAdmissions = () => { sample.admissionReads += 1; return reservations(); };
        let result;
        try { result = svc.admitNewWork("fixture", opts); }
        finally { store.currentRuntime = runtime; store.listBees = roster; store.listAccountAdmissions = reservations; }
        if (!eligible || (mode === "active" && filter === "stale")) assert.equal(result.ok, false);
        if (eligible && bees === 0 && filter !== "stale") assert.equal(result.ok, true);
        if (result.ok) assert.equal(result.reservation === null, mode === "shadow");
        const after = store.dumpState();
        const { accountAdmissions: ignoredBefore, selectionCursors: oldCursors, ...beforeOther } = before;
        const { accountAdmissions: admissions, selectionCursors: cursors, ...afterOther } = after;
        assert.deepEqual(afterOther, beforeOther);
        const normalize = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(dir, "<fixture>"));
        sample.resultHash = hash(normalize(result));
        sample.effectsHash = hash(normalize({ admissions, cursors, audit: store.auditRows(seq) }));
        sample.excessRosterReads = Math.max(0, sample.rosterReads - sample.allowedRosterReads);
        sample.complete = true;
      });
    } catch (error) { sample.error = String(error); throw error; }
    assert.equal(sample.rosterReads, sample.allowedRosterReads);
  });
}

for (const mode of ["active", "shadow"] as const) {
  for (const accounts of [0, 1, 4, 8]) for (const bees of [0, 12, 120, 1200]) measure(mode, accounts, bees);
  for (const filter of ["none", "only", "swap", "stale"]) measure(mode, 4, 12, filter);
}

test("admission refreshes local activity and holds each call, rolls back, and reopens", () => {
  fixture("active", 2, (store, svc, dir, setNow) => {
    const first = svc.admitNewWork("fixture", options(svc, "first"));
    assert.equal(first.ok && first.account.id, "a0");
    const second = svc.admitNewWork("fixture", options(svc, "second"));
    assert.equal(second.ok && second.account.id, "a1");
    const before = store.dumpState();
    assert.throws(() => store["tx"](() => {
      svc.admitNewWork("fixture", options(svc, "rollback"));
      throw new Error("rollback");
    }), /rollback/);
    assert.deepEqual(store.dumpState(), before);
    store.createBee({ id: "transfer", name: "transfer", handle: "AB.transfer", agent: "fixture", substrate: "hsr", cwd: "/fixture", account: "a1" });
    store.reserveAccountAdmission({ id: "transfer", requestKey: "transfer", scope: svc.allocationScope("fixture"), account: "a1", sourceAccount: "a0",
      operation: "swap", units: 1, expiresAt: START + 3 * HOUR, reconcileAfterGeneration: 1, receipt: {} });
    store.bindAccountAdmission("transfer", "transfer");
    const refreshAt = (now: number) => {
      setNow(now);
      for (const id of ["a0", "a1"]) store.putAccountLimits(id, { readable: true, fetchedAt: now,
        fiveHour: { usedPercent: 5, resetsAt: now + 4 * HOUR, windowMinutes: 300 },
        weekly: { usedPercent: 5, resetsAt: now + 144 * HOUR, windowMinutes: 10_080 } });
    };
    refreshAt(START + 2 * HOUR);
    const sourceCharged = svc.admitNewWork("fixture", options(svc, "source-charged", START + 2 * HOUR));
    assert.equal(sourceCharged.ok && sourceCharged.account.id, "a1");
    refreshAt(START + 3 * HOUR);
    const targetCharged = svc.admitNewWork("fixture", options(svc, "target-charged", START + 3 * HOUR));
    assert.equal(targetCharged.ok && targetCharged.account.id, "a0");
    const persisted = store.dumpState();
    store.close();
    const reopened = openCoreStore(join(dir, "core.sqlite3"), { now: () => START + 3 * HOUR });
    try {
      assert.deepEqual(reopened.dumpState(), persisted);
      const fresh = new AccountsService({ store: reopened, cfg: loadNodeConfig(dir), now: () => START + 3 * HOUR, log: () => undefined });
      const reply = fresh.admitNewWork("fixture", options(fresh, "after-reopen", START + 3 * HOUR));
      assert.equal(reply.ok && reply.account.id, "a0");
    } finally { reopened.close(); }
  });
  controlsPassed = true;
});
