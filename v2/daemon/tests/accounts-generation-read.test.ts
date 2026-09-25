import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { openCoreStore, type CoreStore } from "../../core/src/index.ts";
import { AccountsService } from "../src/accountsService.ts";
import { loadNodeConfig } from "../src/config.ts";

const START = Date.parse("2026-09-25T00:00:00Z");
const HOUR = 3_600_000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Sample = { history: number; payloadBytes: number; query: string; admissionReceiptParses: number; parity: boolean; outputSha256?: string; error?: string };
const samples: Sample[] = [];

after(() => {
  const path = process.env.HIVE_GENERATION_READ_RECEIPT;
  if (!path) return;
  const sources = Object.fromEntries(["../src/accountsService.ts", "../src/config.ts", "../../core/src/store.ts", "../../core/src/schema.ts", "./accounts-generation-read.test.ts"].map((name) =>
    [name, createHash("sha256").update(readFileSync(new URL(name, import.meta.url))).digest("hex")]));
  const complete = samples.length === 64 && samples.every((sample) => sample.parity && !sample.error);
  writeFileSync(path, JSON.stringify({
    workload: "account-generation-read", seriesId: `account-generation-read-v1:${hostname()}:${process.version}:${process.platform}:${process.arch}`,
    capturedAt: new Date().toISOString(), host: hostname(), node: process.version, v8: process.versions.v8, load: loadavg(), sources, complete, samples,
    results: [{ metric: "admissionReceiptParses", samples: samples.map((sample) => sample.admissionReceiptParses), invariantHolds: complete && samples.every((sample) => sample.admissionReceiptParses === 0) }],
    limits: "Exact seeded receipt JSON.parse calls only. No SQL-scan, CPU, latency, RSS, live daemon or provider claim. Fresh-read/rollback/reopen controls are separate from sample completeness.",
  }, null, 2) + "\n");
});

function fixture(run: (context: { store: () => CoreStore; service: () => AccountsService; setNow: (value: number) => void; reopen: () => void }) => void) {
  const dir = mkdtempSync(join(tmpdir(), "hb-generation-read-"));
  let store: CoreStore | undefined;
  try {
    let now = START;
    writeFileSync(join(dir, "config.json"), "{}");
    const open = () => openCoreStore(join(dir, "core.sqlite3"), { now: () => now });
    store = open();
    for (const id of ["a0", "a1", "a2"]) store.createAccount({ id, harness: "claude", label: id, homePath: `/fixture/${id}` });
    for (const id of ["target", "other"]) store.createBee({ id, name: id, handle: `AG.${id}`, agent: "claude", substrate: "hsr", cwd: "/fixture", account: "a2" });
    const service = () => new AccountsService({ store: store!, cfg: loadNodeConfig(dir), now: () => now, log: () => undefined });
    run({ store: () => store!, service, setNow: (value) => { now = value; }, reopen: () => { store!.close(); store = undefined; store = open(); } });
  } finally {
    try { store?.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

function reserve(store: CoreStore, id: string, sourceAccount: string | null, generation: number, beeId: string | null, receipt: Record<string, unknown>) {
  store.reserveAccountAdmission({ id, requestKey: id, scope: "fixture", account: "a2", sourceAccount, operation: "swap", units: 1,
    expiresAt: START + 10 * HOUR, reconcileAfterGeneration: generation, receipt });
  if (beeId !== null) store.bindAccountAdmission(id, beeId);
}

for (const history of [0, 12, 120, 1200]) for (const payloadBytes of [0, 4096]) {
  test(`generation attribution: ${history} reservations, ${payloadBytes} receipt padding`, () => {
    const start = samples.length;
    fixture(({ store: getStore, service, setNow }) => {
      const store = getStore();
      const receiptStrings = new Set<string>();
      const special: [string, string | null, number, string | null, number][] = [
        ["z-tie", "a1", 2, "target", 1],
        ["a-tie", "a0", 2, "target", 1],
        ["early", "a1", 4, "target", 0],
        ["late", "a2", 4, "target", 1],
        ["null-source", null, 1, "target", 0],
        ["missing-source", "missing", 7, "target", 0],
        ["same-account", "a2", 8, "target", 0],
        ["unbound", "a0", 1, null, 0],
      ];
      for (let i = 0; i < history; i += 1) {
        const [id, sourceAccount, generation, beeId, offset] = special[i] ?? [`other-${i}`, "a1", 1, "other", 0];
        setNow(START + offset);
        const receipt = { marker: "generation-read", id, padding: "x".repeat(payloadBytes) };
        receiptStrings.add(JSON.stringify(receipt));
        reserve(store, id, sourceAccount, generation, beeId, receipt);
        if (i < 2) store.releaseAccountAdmission(id);
      }
      setNow(START + 11 * HOUR);
      const svc = service();
      const cases = [
        { query: "generation1", id: "target", account: "a2", generation: 1, expected: history ? "a0" : "a2" },
        { query: "generation2", id: "target", account: "a2", generation: 2, expected: history ? "a0" : "a2" },
        { query: "generation3", id: "target", account: "a2", generation: 3, expected: history ? "a1" : "a2" },
        { query: "generation5", id: "target", account: "a2", generation: 5, expected: history ? null : "a2" },
        { query: "generation8", id: "target", account: "a2", generation: 8, expected: "a2" },
        { query: "generation9", id: "target", account: "a2", generation: 9, expected: "a2" },
        { query: "unknownBee", id: "unknown", account: "a1", generation: 1, expected: "a1" },
        { query: "noCurrentAccount", id: "target", account: null, generation: 1, expected: history ? "a0" : null },
      ];
      for (const row of cases) {
        const sample: Sample = { history, payloadBytes, query: row.query, admissionReceiptParses: 0, parity: false };
        samples.push(sample);
        try {
          const expected = row.expected === null ? null : store.getAccount(row.expected);
          const before = digest(store.dumpState());
          const parse = JSON.parse;
          let actual;
          try {
            JSON.parse = (text, reviver) => {
              if (receiptStrings.has(text)) sample.admissionReceiptParses += 1;
              return parse(text, reviver);
            };
            actual = svc.accountForGeneration({ id: row.id, account: row.account }, row.generation);
          } finally { JSON.parse = parse; }
          assert.deepEqual(actual, expected);
          assert.equal(digest(store.dumpState()), before);
          sample.outputSha256 = digest(actual);
          sample.parity = true;
        } catch (error) { sample.error = String(error); throw error; }
      }
    });
    for (const sample of samples.slice(start)) assert.equal(sample.admissionReceiptParses, 0);
  });
}

test("generation attribution stays fresh through insertion, account changes, rollback and reopen", () => {
  fixture(({ store: getStore, service, setNow, reopen }) => {
    let store = getStore();
    let svc = service();
    const bee = { id: "target", account: "a2" };
    assert.equal(svc.accountForGeneration(bee, 1)?.id, "a2");
    reserve(store, "first", "a0", 2, "target", {});
    assert.equal(svc.accountForGeneration(bee, 1)?.id, "a0");
    store.releaseAccountAdmission("first");
    setNow(START + 11 * HOUR);
    assert.equal(svc.accountForGeneration(bee, 1)?.id, "a0");
    store.setAccountStatus("a0", "paused", "fixture");
    assert.equal(svc.accountForGeneration(bee, 1)?.status, "paused");
    setNow(START + HOUR);
    assert.throws(() => store["tx"](() => {
      reserve(store, "rollback", "a1", 1, "target", {});
      assert.equal(svc.accountForGeneration(bee, 1)?.id, "a1");
      throw new Error("rollback fixture");
    }), /rollback fixture/);
    assert.equal(svc.accountForGeneration(bee, 1)?.id, "a0");
    reopen(); store = getStore(); svc = service();
    assert.equal(svc.accountForGeneration(bee, 1)?.id, "a0");
    reserve(store, "next", "a1", 1, "target", {});
    assert.equal(svc.accountForGeneration(bee, 1)?.id, "a1");
    assert.equal(svc.accountForGeneration({ id: "target", account: "a1" }, 3)?.id, "a1");
    assert.equal(svc.accountForGeneration(bee, Number.NaN)?.id, "a2");
    assert.equal(svc.accountForGeneration(bee, Number.POSITIVE_INFINITY)?.id, "a2");
    assert.equal(svc.accountForGeneration(bee, -1)?.id, "a1");
  });
});
