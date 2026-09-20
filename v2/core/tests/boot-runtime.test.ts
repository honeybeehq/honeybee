import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { CoreStore } from "../src/index.ts";
import { harness } from "./helpers.ts";

// The history-scanning query at 81dbdefe, also an independent boolean oracle.
const controlSql = "SELECT 1 FROM runtimes WHERE state = 'booting' LIMIT 1";
const histories = [0, 1, 120, 2000, 10000];
const liveSizes = [0, 1, 12, 120];
type Position = "none" | "first" | "last";

function capture(store: CoreStore) {
  const db = Reflect.get(store, "db") as DatabaseSync;
  const prepare = db.prepare.bind(db);
  const statements: string[] = [];
  db.prepare = (sql) => { statements.push(sql); return prepare(sql); };
  try {
    const result = store.hasBootingRuntime();
    assert.equal(statements.length, 1, "capture the real uncached method query");
    const sql = statements[0]!;
    const plan = prepare("EXPLAIN QUERY PLAN " + sql).all().map((row) => String(row.detail));
    assert.equal(result, prepare(controlSql).get() != null);
    return { sql, result, plan };
  } finally { db.prepare = prepare; }
}

function fixture(stopped: number, live: number, position: Position) {
  const h = harness();
  let store: CoreStore | undefined;
  try {
    store = h.open();
    if (stopped > 0) {
      const { bee, runtime } = store.createBee({ id: "history", name: "history", agent: "stub", substrate: "hsr", cwd: "/tmp" });
      store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    }
    for (let i = 0; i < live; i++) {
      const id = `live-${String(i).padStart(4, "0")}`;
      const { runtime } = store.createBee({ id, name: id, agent: "stub", substrate: "hsr", cwd: "/tmp" });
      const boot = position === "first" && i === 0 || position === "last" && i === live - 1;
      if (!boot) store.updateRuntimeState(id, runtime.generation, "running", { synthetic: true });
    }
    store.close();
    const db = new DatabaseSync(h.path);
    try {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO runtimes(bee_id,generation,state,exit_cause,started_at,updated_at) VALUES ('history',?,'stopped','clean',1,1)");
      for (let generation = 2; generation <= stopped; generation++) insert.run(generation);
      db.exec("COMMIT");
    } finally { db.close(); }
    store = h.open();
    const captured = capture(store);
    assert.equal(captured.result, live > 0 && position !== "none");
    store.close();
    return { ...h, ...captured };
  } catch (error) {
    try { store?.close(); } finally { h.cleanup(); }
    throw error;
  }
}

test("boot-state lookup uses the existing live index even with retained stopped history", () => {
  const f = fixture(10000, 12, "none");
  try { assert.match(f.plan.join("\n"), /USING INDEX runtimes_daemon_live/); }
  finally { f.cleanup(); }
});

test("boot-state reads stay fresh through transitions, rollback, older generations and reopen", () => {
  const h = harness();
  let store: CoreStore | undefined;
  try {
    store = h.open();
    assert.equal(store.hasBootingRuntime(), false);
    const { bee, runtime } = store.createBee({ id: "worker", name: "worker", agent: "stub", substrate: "hsr", cwd: "/tmp" });
    assert.equal(store.hasBootingRuntime(), true);
    const active = store;
    assert.throws(() => active.transact(() => {
      active.updateRuntimeState(bee.id, runtime.generation, "running", { synthetic: true });
      assert.equal(active.hasBootingRuntime(), false);
      throw new Error("rollback boot observation");
    }), /rollback boot observation/);
    assert.equal(store.hasBootingRuntime(), true);
    store.updateRuntimeState(bee.id, runtime.generation, "running", { synthetic: true });
    store.updateRuntimeState(bee.id, runtime.generation, "idle");
    assert.equal(store.hasBootingRuntime(), false);
    store.updateRuntimeState(bee.id, runtime.generation, "stopped", { exitCause: "clean" });
    assert.equal(store.hasBootingRuntime(), false);
    const next = store.reviveBee(bee.id);
    assert.equal(store.hasBootingRuntime(), true);
    store.updateRuntimeState(bee.id, next.generation, "stopped", { exitCause: "clean" });
    store.close();
    const db = new DatabaseSync(h.path);
    try { db.exec("UPDATE runtimes SET state='booting',exit_cause=NULL WHERE generation=1"); }
    finally { db.close(); }
    store = h.open();
    const seq = store.lastAuditSeq();
    assert.equal(store.currentRuntime(bee.id)?.state, "stopped");
    assert.equal(store.hasBootingRuntime(), true, "any booting generation, not only the latest");
    assert.equal(store.lastAuditSeq(), seq, "observation is read-only");
  } finally { try { store?.close(); } finally { h.cleanup(); } }
});

type Counts = { fullscan: number; vm: number; result: boolean };
type Sample = { stopped: number; live: number; position: Position; round: number; order: string[]; sql: string; plan: string[]; expected: boolean; control?: Counts; current?: Counts; error?: string };
const samples: Sample[] = [];
let cliVersion = "";
const receiptPath = process.env.HIVE_BOOT_RUNTIME_RECEIPT;
function count(path: string, sql: string): Counts {
  // Every writer is closed/checkpointed. Immutable avoids creating WAL sidecars
  // when Apple's CLI opens a WAL-format file read-only; never use on live data.
  assert.equal(existsSync(path + "-wal"), false);
  const uri = pathToFileURL(path);
  uri.searchParams.set("immutable", "1");
  const run = spawnSync(process.env.HIVE_SQLITE3 ?? "sqlite3", ["-readonly", "-batch", "-cmd", ".stats on", uri.href, sql], { encoding: "utf8", timeout: 10000 });
  assert.equal(run.status, 0, `${run.error ?? ""}\n${run.stderr}\n${run.stdout}`);
  const read = (label: string) => {
    const matches = [...run.stdout.matchAll(new RegExp(`^${label}:\\s+(\\d+)\\s*$`, "gm"))];
    assert.equal(matches.length, 1, `missing/ambiguous ${label}: ${run.stdout}`);
    return Number(matches[0]![1]);
  };
  return { fullscan: read("Fullscan Steps"), vm: read("Virtual Machine Steps"), result: /^1\r?$/m.test(run.stdout) };
}

if (receiptPath) test("boot query statement counts and all-live displaced cost", () => {
  const version = spawnSync(process.env.HIVE_SQLITE3 ?? "sqlite3", ["--version"], { encoding: "utf8", timeout: 10000 });
  assert.equal(version.status, 0, String(version.error ?? version.stderr));
  cliVersion = version.stdout.trim();
  for (const stopped of histories) for (const live of liveSizes) for (const position of (live ? ["none", "first", "last"] : ["none"]) as Position[]) {
    const f = fixture(stopped, live, position);
    try {
      for (let round = 0; round < 3; round++) {
        const order = round % 2 === 0 ? ["control", "current"] : ["current", "control"];
        const sample: Sample = { stopped, live, position, round, order, sql: f.sql, plan: f.plan, expected: f.result };
        samples.push(sample); // Preserve a completed first arm when the second fails.
        try {
          for (const arm of order) {
            const counts = count(f.path, arm === "control" ? controlSql : f.sql);
            if (arm === "control") sample.control = counts; else sample.current = counts;
            assert.equal(counts.result, f.result);
          }
        } catch (error) { sample.error = String(error); throw error; }
      }
    } finally { f.cleanup(); }
  }
  const { growth, allLive, complete } = metrics();
  assert.equal(complete, true);
  assert.ok(growth.every((n) => n === 0), "stopped history must add no scan steps");
  assert.ok(allLive.every((s) => s.current!.vm - s.control!.vm <= 3 * s.live + 50), "all-live VM overhead exceeded declared guard");
});

function metrics() {
  const complete = samples.length === 150 && samples.every((s) => s.control && s.current && !s.error && s.control.result === s.expected && s.current.result === s.expected);
  const allLive = samples.filter((s) => s.stopped === 0 && s.control && s.current);
  const growth = samples.filter((s) => s.stopped > 0 && s.current).map((s) => {
    const base = allLive.find((b) => b.live === s.live && b.position === s.position && b.round === s.round);
    return base?.current ? s.current!.fullscan - base.current.fullscan : NaN;
  });
  return { complete, growth, allLive };
}

after(() => {
  if (!receiptPath) return;
  const { complete, growth, allLive } = metrics();
  const sources = Object.fromEntries(["../src/store.ts", "../src/schema.ts", "./helpers.ts", "./boot-runtime.test.ts"].map((p) => [p, createHash("sha256").update(readFileSync(new URL(p, import.meta.url))).digest("hex")]));
  writeFileSync(receiptPath, JSON.stringify({
    workload: "boot-runtime-lookup", seriesId: `boot-runtime-history-v1:${hostname()}:${process.version}:node-sqlite-${process.versions.sqlite}:cli-${createHash("sha256").update(cliVersion).digest("hex").slice(0, 16)}`,
    capturedAt: new Date().toISOString(), host: hostname(), node: process.version, nodeSqlite: process.versions.sqlite, cliVersion,
    sources, controlSql, complete, samples,
    results: [
      { metric: "stoppedHistoryScanSteps", samples: growth, invariantHolds: complete && growth.every((n) => n === 0) },
      { metric: "liveVmOverhead", samples: allLive.map((s) => s.current!.vm - s.control!.vm), invariantHolds: complete && allLive.every((s) => s.current!.vm - s.control!.vm <= 3 * s.live + 50) },
    ],
    scope: "CLI statement counters only, separate engine from Node; actual CoreStore SQL/boolean and Node plan checked. No timing, I/O or daemon cost claim.",
  }, null, 2) + "\n");
});
