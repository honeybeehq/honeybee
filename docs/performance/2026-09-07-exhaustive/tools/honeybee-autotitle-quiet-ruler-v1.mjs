// autoTitle QUIET-scan before/after ruler — DRAFT for parent review.
//
// Bounded unit: real store-backed quiet scan CPU/wall for four scenarios
// (empty fleet, thin fleet, one envelope-only giant, one substantive giant
// in backoff), plus SEPARATE SQL and allocation replays. Drives ONLY the
// unchanged factory signature createStoreAutoTitleDispatcher(store, opts) —
// valid for any selected design. Explicitly OUT of this unit: launch/changed
// scenarios, launch-order checks, giant-fleet stress, write tradeoffs,
// retained-memory (separate-process RSS) runner, Mini/broad suites.
//
// Usage:
//   node honeybee-autotitle-quiet-ruler.mjs <beforeRoot> <afterRoot> <out.json> \
//        [control=true|false] [mode=none|profile] [scale=smoke|canonical]
//
// Discipline follows the statement-cache ruler: immutable distinct roots
// with runtime-only fingerprints re-asserted at end, distinct module
// instances, one seed built via the BEFORE module then byte-copied to both
// sides (sha-asserted), deterministic logical 1 Hz clocks per side kept
// inside the 600 s backoff cap, cold first scan reported separately, warmed
// ABBA rounds with every raw sample retained, state/sidecar/audit/outcome
// invariants outside the clocks, and a deterministic no-network provider
// that THROWS if any quiet scenario ever launches.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { Session } from "node:inspector/promises";

const [beforeArg, afterArg, outArg, controlArg = "false", mode = "none", scale = "smoke"] = process.argv.slice(2);
assert(beforeArg && afterArg && outArg, "usage: ruler <before> <after> <out> [control] [mode] [scale]");
assert(["true", "false"].includes(controlArg));
assert(["none", "profile"].includes(mode));
assert(["smoke", "canonical"].includes(scale));
const control = controlArg === "true";
const roots = [beforeArg, afterArg].map((p) => realpathSync(p));
const out = resolve(outArg);
assert.notEqual(roots[0], roots[1], "roots must be distinct checkouts");
assert(!existsSync(out), "report already exists");

const hash = (b) => createHash("sha256").update(b).digest("hex");
const git = (root, ...args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const fingerprint = (root) => {
  assert.equal(git(root, "status", "--porcelain").trim(), "", `${root} must be clean`);
  const files = git(root, "ls-files", "v2", "package.json", "package-lock.json").trim().split("\n")
    .filter((p) => (p.endsWith(".ts") && p.includes("/src/")) || p.endsWith("package.json") || p === "package-lock.json");
  return {
    revision: git(root, "rev-parse", "HEAD").trim(),
    hashes: Object.fromEntries(files.map((p) => [p, hash(readFileSync(join(root, p)))])),
  };
};
const sources = roots.map(fingerprint);
assert.deepEqual(Object.keys(sources[0].hashes), Object.keys(sources[1].hashes), "root file sets differ");
const runtimeDiff = Object.keys(sources[0].hashes).filter((p) => sources[0].hashes[p] !== sources[1].hashes[p]);
if (control) assert.deepEqual(runtimeDiff, [], "A/A control roots must be byte-identical");
else {
  assert(runtimeDiff.length > 0, "A/B roots carry no runtime change");
  for (const p of runtimeDiff) {
    assert(p.startsWith("v2/core/src/") || p.startsWith("v2/daemon/src/"), `unexpected non-runtime diff: ${p}`);
  }
}
const toolHash = hash(readFileSync(new URL(import.meta.url)));

// Distinct module instances per root; helpers come ONLY from the BEFORE
// module (the semantic baseline) so both sides get identical seeds.
const coreModules = await Promise.all(roots.map((root) => import(pathToFileURL(join(root, "v2/core/src/index.ts")).href)));
const titleModules = await Promise.all(roots.map((root) => import(pathToFileURL(join(root, "v2/daemon/src/autoTitle.ts")).href)));
assert.notEqual(coreModules[0].openCoreStore, coreModules[1].openCoreStore, "modules must be distinct instances");
assert.notEqual(titleModules[0].createStoreAutoTitleDispatcher, titleModules[1].createStoreAutoTitleDispatcher);
const { userTaskMessages, contextSignature } = titleModules[0];
const tracePath = join(roots[0], "scripts/perf/sql-trace.mjs");
const { captureSql } = await import(pathToFileURL(tracePath).href);
const sqlToolHash = hash(readFileSync(tracePath));
const boot = () => {
  const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return hash(r.stdout.trim());
};

// ---------------------------------------------------------------- workload --
const ENVELOPE_BODY = "<hive-session>generation 3 boot; transcript /tmp/x.jsonl</hive-session>";
const THIN_BODY = "hi";
const SUBSTANTIVE_BODY = "Migrate the billing exporter to the new ledger API and backfill March step ";
const T0 = 1_000_000_000; // ms; every seeded timestamp and lastAt anchors here
const SIZES = scale === "smoke"
  ? { fleet: 12, giantRows: 300, rounds: 3, warmupRounds: 3 }
  : { fleet: 1000, giantRows: 100_000, rounds: 15, warmupRounds: 3 };
// Logical 1 Hz budget: every per-side scan advances 1000 ms; the backoff
// giant is seeded at the 600 s cap (attempts=7), so all timed quiet steps
// must fit inside it with margin.
const SCANS_PER_SIDE = 1 /* cold */ + SIZES.warmupRounds * 2 + SIZES.rounds * 2 + 1 /* sql replay */ + (mode === "profile" ? 1 : 0);
assert(SCANS_PER_SIDE * 1000 <= 580_000, "logical scan budget exceeds the 600 s backoff cap");

const SCENARIOS = [
  { name: "empty-fleet", bees: SIZES.fleet, rowsPerBee: 0, body: null, bookkeeping: "deferred" },
  { name: "thin-fleet", bees: SIZES.fleet, rowsPerBee: 1, body: THIN_BODY, bookkeeping: "deferred" },
  { name: "envelope-giant", bees: 1, rowsPerBee: SIZES.giantRows, body: ENVELOPE_BODY, bookkeeping: "deferred" },
  { name: "backoff-giant", bees: 1, rowsPerBee: SIZES.giantRows, body: SUBSTANTIVE_BODY, bookkeeping: "backoff" },
];

const report = {
  completed: false,
  startedAt: new Date().toISOString(),
  roots,
  sources,
  runtimeDiff,
  toolHash,
  sqlToolHash,
  control,
  mode,
  scale,
  sizes: SIZES,
  scansPerSide: SCANS_PER_SIDE,
  environment: { node: process.version, cpu: cpus()[0].model, boot: boot(), loadBefore: loadavg() },
  scope:
    "Quiet-scan unit only. Real CoreStore + real createStoreAutoTitleDispatcher via the unchanged factory signature; deterministic per-side 1 Hz logical clocks inside the 600 s backoff cap; sidecar bookkeeping seeded identically on both sides from the BEFORE module's own normalization/signature helpers, so no scan ever launches and the provider throws if one does. Giant mailboxes are offline-seeded rows WITHOUT synthetic audit records (labeled; every row proven against the public PK read outside timing). Timing covers dispatcher scan calls only; state oracles, SQL tracing, and allocation sampling run separately. Cold first scan reported apart from warmed ABBA rounds. Allocation numbers are V8 sampled allocation traffic, not retained RAM; no retained-memory, write-tradeoff, launch, changed-content, launch-order, or giant-fleet-stress claims — those belong to other units. Same-process GC and OS caches may cross sides. Structural smoke runs on a contended workstation prove wiring, not performance.",
  scenarios: [],
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
const measure = (fn) => {
  const c = process.cpuUsage();
  const t = performance.now();
  const value = fn();
  const wallMs = performance.now() - t;
  const u = process.cpuUsage(c);
  return { wallMs, cpuMs: (u.user + u.system) / 1000, value };
};
const dist = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: s[Math.floor((s.length - 1) / 2)], p95: s[Math.ceil((s.length - 1) * 0.95)], min: s[0], max: s.at(-1) };
};

const dir = mkdtempSync(join(tmpdir(), "hb-autotitle-quiet-"));
const opened = [];
save();
try {
  for (const scenario of SCENARIOS) {
    // ---- seed once via the BEFORE module, prove, close, byte-copy ---------
    const seedPath = join(dir, `${scenario.name}-seed.sqlite`);
    let seedClock = T0 - 1_000_000; // fixture history strictly precedes scans
    const seed = coreModules[0].openCoreStore(seedPath, { now: () => (seedClock += 1) });
    const beeIds = [];
    seed.transact(() => {
      for (let i = 0; i < scenario.bees; i++) {
        const bee = seed.createBee({
          name: `${scenario.name}-${i}`,
          agent: "stub",
          substrate: "hsr",
          cwd: dir,
        }).bee;
        beeIds.push(bee.id);
      }
    });
    // Fleets get fully public transactional mail; giants get offline rows
    // (plan-sanctioned; labeled: no synthetic audit/projection records are
    // written for offline rows, and every one is PK-proven below).
    if (scenario.rowsPerBee > 0 && scenario.bees > 1) {
      seed.transact(() => {
        for (const beeId of beeIds) {
          for (let r = 0; r < scenario.rowsPerBee; r++) seed.send(beeId, scenario.body, { urgency: "idle" });
        }
      });
    }
    const auditSeqSeeded = seed.lastAuditSeq();
    seed.close();
    let syntheticAuditRows = 0;
    if (scenario.rowsPerBee > 0 && scenario.bees === 1) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(seedPath);
      const ins = db.prepare(
        "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation) VALUES(?, 'operator', ?, 0, 'idle', ?, NULL, NULL)",
      );
      db.exec("BEGIN");
      for (let r = 0; r < scenario.rowsPerBee; r++) {
        const body = scenario.body === SUBSTANTIVE_BODY ? `${SUBSTANTIVE_BODY}${r}` : scenario.body;
        ins.run(beeIds[0], body, T0 - 900_000 + r);
        syntheticAuditRows += 1;
      }
      db.exec("COMMIT");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
    }
    // PK proof for every offline row, via the public read, outside timing.
    let pkProofRows = 0;
    if (syntheticAuditRows > 0) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(seedPath, { readOnly: true });
      const rows = db.prepare("SELECT id, bee_id, body FROM mailbox WHERE bee_id = ? ORDER BY id").all(beeIds[0]);
      db.close();
      let proofClock = T0 - 90_000;
      const proof = coreModules[0].openCoreStore(seedPath, { now: () => (proofClock += 1) });
      for (const row of rows) {
        const viaPk = proof.getMessage(Number(row.id));
        assert(viaPk && viaPk.body === String(row.body) && viaPk.beeId === String(row.bee_id), `offline row ${row.id} fails the public PK read`);
        pkProofRows += 1;
      }
      assert.equal(pkProofRows, syntheticAuditRows);
      proof.close();
    }
    const fixtureSha256 = hash(readFileSync(seedPath));
    const paths = [0, 1].map((side) => join(dir, `${scenario.name}-${side}.sqlite`));
    for (const p of paths) {
      copyFileSync(seedPath, p);
      assert.equal(hash(readFileSync(p)), fixtureSha256, "seed copy drifted");
    }

    // ---- identical quiet sidecar seeds from BEFORE-module helpers --------
    // Signatures computed with the actual normalization pipeline over the
    // actual fixture bodies (empty list for empty/envelope fixtures — the
    // envelope claim is asserted, not assumed).
    const sidecar = {};
    {
      let sigClock = T0 - 50_000;
      const reader = coreModules[0].openCoreStore(seedPath, { now: () => (sigClock += 1) });
      for (const beeId of beeIds) {
        const bee = reader.getBee(beeId);
        assert(bee && bee.lifecycle === "active" && !bee.title, "fixture bees must be active untitled");
        const users = userTaskMessages(reader.listMessages(beeId));
        if (scenario.name === "empty-fleet" || scenario.name === "envelope-giant") {
          assert.deepEqual(users, [], `${scenario.name}: normalized user messages must be empty`);
        }
        if (scenario.name === "thin-fleet") assert.equal(users.length, 1);
        if (scenario.name === "backoff-giant") assert.equal(users.length, scenario.rowsPerBee);
        const signature = contextSignature(bee, users);
        sidecar[beeId] = scenario.bookkeeping === "deferred"
          ? { attempts: 0, lastAt: 0, userTurns: users.length, deferred: true, signature }
          : { attempts: 7, lastAt: T0, userTurns: users.length, deferred: false, signature };
      }
      reader.close();
    }
    const sidecarJson = `${JSON.stringify(sidecar)}\n`;
    const sidecarSha256 = hash(sidecarJson);
    const statePaths = [0, 1].map((side) => join(dir, `${scenario.name}-${side}-bookkeeping.json`));
    for (const p of statePaths) writeFileSync(p, sidecarJson);

    // ---- per-side stores + dispatchers via the UNCHANGED factory ---------
    const clocks = [{ t: T0 }, { t: T0 }];
    let launches = 0;
    const stores = paths.map((p, side) => coreModules[side].openCoreStore(p, { now: () => clocks[side].t }));
    opened.push(...stores);
    const dispatchers = stores.map((store, side) =>
      titleModules[side].createStoreAutoTitleDispatcher(store, {
        naming: () => ({ auto: true }),
        statePath: statePaths[side],
        now: () => clocks[side].t,
        log: () => undefined,
        generate: () => {
          launches += 1;
          throw new Error(`quiet scenario ${scenario.name} attempted a launch`);
        },
      }),
    );
    const scanCounts = [0, 0];
    const scan = async (side) => {
      clocks[side].t += 1000; // logical 1 Hz
      scanCounts[side] += 1;
      const m = measure(() => dispatchers[side]());
      const outcomes = await m.value;
      assert.deepEqual(outcomes, [], `${scenario.name}: quiet scan produced outcomes`);
      return { wallMs: m.wallMs, cpuMs: m.cpuMs };
    };

    // Invariant oracles, outside every clock.
    const stateHash = (s) => hash(JSON.stringify({ state: s.dumpState(), audit: s.auditRows() }));
    const auditBefore = stores.map((s) => s.lastAuditSeq());
    assert.equal(auditBefore[0], auditBefore[1]);
    assert.equal(auditBefore[0], auditSeqSeeded, "copies must carry the seeded audit tail");
    const stateBefore = stores.map(stateHash);
    assert.equal(stateBefore[0], stateBefore[1], "sides must open identical states");

    // ---- cold first scan, reported separately (fixed order A then B) -----
    const cold = [await scan(0), await scan(1)];

    // ---- warmup, then measured ABBA rounds -------------------------------
    for (let i = 0; i < SIZES.warmupRounds; i++) for (const side of [0, 1, 1, 0]) await scan(side);
    const raw = [[], []];
    for (let i = 0; i < SIZES.rounds; i++) {
      for (const side of [0, 1, 1, 0]) raw[side].push(await scan(side));
    }

    // ---- separate SQL replay of exactly one further quiet scan -----------
    // The dispatcher body is synchronous end-to-end for quiet scans (it
    // never awaits), so a sync capture sees every statement; the returned
    // promise is settled by then and awaited outside the patch window.
    const sqlReplay = [];
    for (const side of [0, 1]) {
      clocks[side].t += 1000;
      scanCounts[side] += 1;
      let pending;
      const captured = captureSql(() => {
        pending = dispatchers[side]();
      });
      assert.deepEqual(await pending, [], `${scenario.name}: replay scan produced outcomes`);
      const statements = captured.statements;
      const writes = statements.filter((x) => /^\s*(insert|update|delete)/i.test(x.sql));
      assert.deepEqual(writes, [], `${scenario.name}: quiet scan issued write statements`);
      sqlReplay.push({ side, statements });
    }

    // ---- optional separate allocation replay (traffic, not retained RAM) -
    const profiles = [];
    if (mode === "profile") {
      for (const side of [0, 1]) {
        const session = new Session();
        session.connect();
        try {
          await session.post("HeapProfiler.enable");
          await session.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
          clocks[side].t += 1000;
          scanCounts[side] += 1;
          assert.deepEqual(await dispatchers[side](), []);
          const { profile } = await session.post("HeapProfiler.stopSampling");
          const path = `${out}.${scenario.name}.${side}.heapprofile`;
          writeFileSync(path, JSON.stringify(profile));
          const sum = (n) => n.selfSize + n.children.reduce((a, c) => a + sum(c), 0);
          profiles.push({ side, path, sha256: hash(readFileSync(path)), sampledBytes: sum(profile.head) });
        } finally {
          session.disconnect();
        }
      }
    }

    // ---- end invariants: no launches, no sidecar/audit/row drift ---------
    assert.equal(launches, 0, "provider must never be reached in quiet scenarios");
    for (const side of [0, 1]) {
      assert.equal(readFileSync(statePaths[side], "utf8"), sidecarJson, "sidecar bytes changed during quiet scans");
      assert.equal(stores[side].lastAuditSeq(), auditBefore[side], "audit advanced during quiet scans");
    }
    const stateAfter = stores.map(stateHash);
    assert.deepEqual(stateAfter, stateBefore, "store state changed during quiet scans");
    assert.equal(scanCounts[0], scanCounts[1], "sides must run identical scan schedules");
    assert(clocks[0].t - T0 <= 580_000, "logical time escaped the backoff window");

    for (const s of stores) {
      s.close();
      opened.splice(opened.indexOf(s), 1);
    }
    report.scenarios.push({
      scenario: { name: scenario.name, bees: scenario.bees, rowsPerBee: scenario.rowsPerBee, bookkeeping: scenario.bookkeeping },
      fixtureSha256,
      sidecarSha256,
      syntheticAuditRows,
      pkProofRows,
      scansPerSide: scanCounts[0],
      cold,
      raw,
      metrics: raw.map((xs) => ({
        scanWallMs: dist(xs.map((x) => x.wallMs)),
        scanCpuMs: dist(xs.map((x) => x.cpuMs)),
      })),
      sqlReplay,
      profiles,
      invariants: {
        auditSeq: auditBefore[0],
        stateHashStable: true,
        sidecarStable: true,
        outcomesAllEmpty: true,
        providerLaunches: launches,
      },
    });
    save();
  }
  assert.deepEqual(roots.map(fingerprint), sources, "roots mutated during the run");
  assert.equal(hash(readFileSync(new URL(import.meta.url))), toolHash);
  assert.equal(hash(readFileSync(tracePath)), sqlToolHash);
  assert.equal(boot(), report.environment.boot, "boot session changed mid-run");
  report.completed = true;
} catch (e) {
  report.failure = String(e.stack ?? e);
  throw e;
} finally {
  report.finishedAt = new Date().toISOString();
  report.environment.loadAfter = loadavg();
  save();
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(out);
