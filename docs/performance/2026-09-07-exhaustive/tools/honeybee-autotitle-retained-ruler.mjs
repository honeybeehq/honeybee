// autoTitle RETAINED-memory ruler — revision 2 for parent review. Disposable.
//
// Reports post-GC memory readings across phases of a quiet autoTitle
// workload, in INDEPENDENT child processes per source root (never two roots
// in one heap), serially in ABBA order with at least two children per side.
// All figures are WHOLE-PROCESS phase readings and differences — they do
// not bound or attribute any single object's retained memory (deletion
// audits, prepared statements, and SQLite caches all move between phases).
// heapUsed is managed-heap occupancy after a best-effort collection, not
// exact live bytes; RSS is not a cache measurement. A/B same-phase and
// phase-difference comparisons are signals subject to A/A variation.
//
// Usage (orchestrator):
//   node honeybee-autotitle-retained-ruler.mjs <beforeRoot> <afterRoot> <out.json> \
//        [control=true|false] [mode=none|snapshot] [scale=smoke|canonical] \
//        [expectedDiff=comma,separated,paths]   (REQUIRED for A/B)
//
// mode=none is the ONLY numeric-comparison mode. mode=snapshot writes V8
// heap snapshots for OFFLINE retaining-path analysis; snapshot
// serialization forces a deeper collection and inflates RSS, so in that
// mode every memory reading is marked diagnostic-only and no derived
// differences are emitted. Within-mode symmetry in one A/A pair does not
// prove the artifact cancels between different implementations.
//
// Phases per child (identical fixed GC protocol before every reading —
// recorded verbatim in the report; not tuned to chase smaller numbers):
//   constructed   — store opened + dispatcher constructed, NO scan yet
//                   (process/module/fixture caches already warmed by
//                   imports, copy, and open; initial cache retention shows
//                   up in constructed→firstScan)
//   firstScan     — after the first dispatcher scan
//   warm          — after W further quiet scans (logical 1 Hz)
//   rosterDeleted — all bees deleted (giant FIRST so cascades stay cheap),
//                   one further scan over the empty roster, sidecar
//                   re-checked after that scan
//   released      — dispatcher and store references dropped, store closed
//
// Cache-bound evidence for any candidate's private state is OUT of scope
// here: closure-local structures are not reachable by reflection, and no
// diagnostic property or API is authorized merely for a benchmark. Bounds
// need implementation-specific behavioral evidence in the accepted
// candidate's own tests (instrumenting its existing Map operations
// carefully if needed) plus offline retaining-path analysis of the
// snapshots. The design bound is AT MOST the entries of the last full
// active-untitled roster walk — not equality to roster size, and pruning
// is not instantaneous while scans return early.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

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
const T0 = 1_000_000_000;
const BACKOFF_WINDOW_MS = 600_000; // seeded attempts=7 → the 600 s cap
const SMALL_BODY = "Investigate the flaky nightly export and pin the root cause";
const GIANT_BODY = "Migrate the billing exporter to the new ledger API and backfill March step ";
const GC_PROTOCOL = "3x global.gc(), one macrotask yield (setTimeout 0) after each call and once more before reading process.memoryUsage()";
const WARM_SCANS = { smoke: 8, canonical: 30 };
const EXPECTED_SCANS = { smoke: 10, canonical: 32 }; // firstScan + W + empty-roster scan

// =========================================================== child mode ====
if (process.argv[2] === "--child") {
  const [, , , root, seedPath, sidecarPath, manifestPath, outPath, scaleArg, modeArg, artifactPrefix] = process.argv;
  assert(root && seedPath && sidecarPath && manifestPath && outPath && scaleArg && modeArg && artifactPrefix);
  assert(["smoke", "canonical"].includes(scaleArg), "child scale invalid");
  assert(["none", "snapshot"].includes(modeArg), "child mode invalid");
  assert.equal(typeof globalThis.gc, "function", "child must run with --expose-gc");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const warmScans = WARM_SCANS[scaleArg];
  const diagnosticOnly = modeArg === "snapshot";

  const gcNow = async () => {
    for (let i = 0; i < 3; i++) {
      globalThis.gc();
      await sleep(0); // yield a turn so same-turn temporaries are not read as live state
    }
    await sleep(0);
  };
  const snapshot = async (label) => {
    await gcNow();
    const m = process.memoryUsage();
    return { label, diagnosticOnly, rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
  };
  // Scoped so the large dump/audit temporaries die with the call frame and
  // are collected by the next reading's GC protocol.
  const scopedStateHash = (s) => hash(JSON.stringify({ state: s.dumpState(), audit: s.auditRows() }));

  const dir = mkdtempSync(join(tmpdir(), "hb-retained-child-"));
  const result = { root: realpathSync(root), fingerprint: fingerprint(root), gcProtocol: GC_PROTOCOL, scans: 0, snapshots: [] };
  let store = null;
  try {
    const dbPath = join(dir, "core.sqlite");
    copyFileSync(seedPath, dbPath);
    assert.equal(hash(readFileSync(dbPath)), manifest.fixtureSha256, "seed copy drifted");
    const statePath = join(dir, "bookkeeping.json");
    copyFileSync(sidecarPath, statePath);
    const sidecarBytes = readFileSync(statePath, "utf8");
    assert.equal(hash(sidecarBytes), manifest.sidecarSha256, "sidecar copy drifted");

    const core = await import(pathToFileURL(join(root, "v2/core/src/index.ts")).href);
    const title = await import(pathToFileURL(join(root, "v2/daemon/src/autoTitle.ts")).href);
    const clock = { t: T0 };
    store = core.openCoreStore(dbPath, { now: () => clock.t });
    let launches = 0;
    let dispatcher = title.createStoreAutoTitleDispatcher(store, {
      naming: () => ({ auto: true }),
      statePath,
      now: () => clock.t,
      log: () => undefined,
      generate: () => {
        launches += 1;
        throw new Error("quiet retained workload attempted a launch");
      },
    });
    const scan = async () => {
      clock.t += 1000;
      result.scans += 1;
      const outcomes = await dispatcher();
      assert.deepEqual(outcomes, [], "quiet scan produced outcomes");
    };
    const auditSeeded = store.lastAuditSeq();
    const quietStateHash = scopedStateHash(store);

    // constructed: no scan has run yet.
    result.snapshots.push(await snapshot("constructed"));

    // firstScan.
    await scan();
    result.snapshots.push(await snapshot("firstScan"));

    // warm: W further quiet scans, then quiet-state equality OUTSIDE the
    // reading (hash computed before the GC protocol runs).
    for (let i = 0; i < warmScans; i++) await scan();
    assert.equal(readFileSync(statePath, "utf8"), sidecarBytes, "sidecar changed during quiet scans");
    assert.equal(store.lastAuditSeq(), auditSeeded, "audit advanced during quiet scans");
    assert.equal(scopedStateHash(store), quietStateHash, "quiet scans changed store state");
    result.snapshots.push(await snapshot("warm"));
    if (modeArg === "snapshot") {
      const v8 = await import("node:v8");
      const p = `${artifactPrefix}.warm.heapsnapshot`;
      v8.writeHeapSnapshot(p);
      result.warmHeapSnapshot = { path: p, sha256: hash(readFileSync(p)), bytes: readFileSync(p).length };
    }

    // rosterDeleted: giant first (one big cascade), then the fleet, then one
    // scan over the empty roster; sidecar re-checked AFTER that scan.
    const order = [manifest.giantBeeId, ...manifest.smallBeeIds];
    for (const beeId of order) store.deleteBee(beeId);
    assert.deepEqual(store.listBees(), [], "roster must be empty after deletion");
    await scan();
    assert.equal(readFileSync(statePath, "utf8"), sidecarBytes, "sidecar changed by the empty-roster scan");
    result.snapshots.push(await snapshot("rosterDeleted"));

    // released: drop dispatcher AND store references; whole-process phase
    // reading only — this does not attribute what they retained.
    store.close();
    dispatcher = null;
    store = null;
    result.snapshots.push(await snapshot("released"));
    if (modeArg === "snapshot") {
      const v8 = await import("node:v8");
      const p = `${artifactPrefix}.released.heapsnapshot`;
      v8.writeHeapSnapshot(p);
      result.releasedHeapSnapshot = { path: p, sha256: hash(readFileSync(p)), bytes: readFileSync(p).length };
    }

    assert.equal(launches, 0, "provider must never be reached");
    assert.equal(result.scans, EXPECTED_SCANS[scaleArg], "scan budget drifted from the declared schedule");
    assert(clock.t - T0 <= BACKOFF_WINDOW_MS - 20_000, "elapsed logical time escaped the seeded backoff window");
    result.elapsedLogicalMs = clock.t - T0;
    result.completed = true;
  } catch (e) {
    result.failure = String(e.stack ?? e);
  } finally {
    // Close any still-open store BEFORE removing its owned disposable files.
    try {
      if (store !== null) store.close();
    } catch {
      // already closed or close failed during teardown; removal proceeds
    }
    rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  process.exit(result.completed ? 0 : 1);
}

// ====================================================== orchestrator mode ==
const [beforeArg, afterArg, outArg, controlArg = "false", mode = "none", scale = "smoke", expectedDiffArg = ""] = process.argv.slice(2);
assert(beforeArg && afterArg && outArg, "usage: ruler <before> <after> <out> [control] [mode] [scale] [expectedDiff]");
assert(["true", "false"].includes(controlArg));
assert(["none", "snapshot"].includes(mode));
assert(["smoke", "canonical"].includes(scale));
const control = controlArg === "true";
const expectedDiff = expectedDiffArg.length === 0 ? [] : expectedDiffArg.split(",").map((p) => p.trim()).filter(Boolean).sort();
if (control) assert.deepEqual(expectedDiff, [], "A/A control takes no expectedDiff");
else assert(expectedDiff.length > 0, "A/B requires the exact expected runtime changed-file set");
const roots = [beforeArg, afterArg].map((p) => realpathSync(p));
const out = resolve(outArg);
assert.notEqual(roots[0], roots[1], "roots must be distinct checkouts");
assert(!existsSync(out), "report already exists");
const sources = roots.map(fingerprint);
assert.deepEqual(Object.keys(sources[0].hashes), Object.keys(sources[1].hashes), "root file sets differ");
const runtimeDiff = Object.keys(sources[0].hashes).filter((p) => sources[0].hashes[p] !== sources[1].hashes[p]).sort();
assert.deepEqual(runtimeDiff, expectedDiff, control ? "A/A control roots must be byte-identical" : "runtime diff must equal the declared expected set");
const toolHash = hash(readFileSync(new URL(import.meta.url)));
const boot = () => {
  const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return hash(r.stdout.trim());
};
const SIZES = scale === "smoke" ? { fleet: 12, giantRows: 300 } : { fleet: 1000, giantRows: 100_000 };
const CHILD_ORDER = [0, 1, 1, 0]; // serial ABBA; two independent children per side

const report = {
  completed: false,
  startedAt: new Date().toISOString(),
  roots,
  sources,
  runtimeDiff,
  toolHash,
  control,
  mode,
  scale,
  sizes: SIZES,
  childOrder: CHILD_ORDER,
  gcProtocol: GC_PROTOCOL,
  expectedScansPerChild: EXPECTED_SCANS[scale],
  environment: { node: process.version, cpu: cpus()[0].model, boot: boot(), loadBefore: loadavg() },
  scope:
    "Retained-memory unit only: independent child PROCESS per root per run (never two roots in one heap), spawned SERIALLY in ABBA order with two children per side and unique per-run outputs/artifact paths (order recorded; this permits a minimal A/A variability check — descriptive evidence, not a statistical guarantee, and no aggregate performance claims from any single pair). expose-gc exists ONLY in this disposable tool; no production diagnostics or API. One combined quiet fleet: small backoff bees (public transactional, one substantive message each) + one giant backoff mailbox (offline-labeled INTERLEAVED pending/delivered rows delivered by real generation 1, auditRowsAdded=0 after the public seed asserted, EVERY row full-nine-field PK-proven before copies). Sidecar seeded from the BEFORE module's own helpers at the 600 s backoff cap; every scan quiet; provider throws on launch; sidecar/audit/state-hash stability asserted outside the readings, sidecar re-checked after the empty-roster scan; scan budget and elapsed logical time asserted against the declared schedule. Phases constructed/firstScan/warm/rosterDeleted/released each read process.memoryUsage() after the recorded fixed GC protocol (yielding an event-loop turn between calls and before reading; not tuned). ALL figures are WHOLE-PROCESS phase readings and differences: deletion writes audits, prepared statements and SQLite caches move between phases, so no phase difference bounds or attributes any single object's retained memory. heapUsed is managed-heap occupancy after a best-effort collection, not exact live bytes; RSS includes SQLite page cache, native allocator slack, and V8 fragmentation and is not a cache measurement; A/B same-phase and phase-difference comparisons are signals subject to A/A variation. mode=none is the only numeric-comparison mode; in mode=snapshot every memory reading is diagnostic-only, derived differences are omitted, and the V8 heap snapshots exist for OFFLINE retaining-path analysis (within-mode symmetry in one A/A pair does not prove the snapshot artifact cancels between implementations). Cache bounds for a candidate's private state need implementation-specific behavioral evidence in that candidate's own tests plus offline retaining-path analysis — closure-local structures are not reachable by reflection and no diagnostic API is authorized for a benchmark; the design bound is AT MOST the last full active-untitled roster walk's entries, without instantaneous pruning while scans return early. No timing claims, no allocation-traffic claims, no Mini/broad, no provider calls.",
  fixture: {},
  runs: [],
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
const dir = mkdtempSync(join(tmpdir(), "hb-retained-"));
save();
try {
  // ---- fixture built ONCE via the BEFORE module ---------------------------
  const core = await import(pathToFileURL(join(roots[0], "v2/core/src/index.ts")).href);
  const title = await import(pathToFileURL(join(roots[0], "v2/daemon/src/autoTitle.ts")).href);
  const { userTaskMessages, contextSignature } = title;
  const seedPath = join(dir, "seed.sqlite");
  let seedClock = T0 - 1_000_000;
  const seed = core.openCoreStore(seedPath, { now: () => (seedClock += 1) });
  const smallBeeIds = [];
  seed.transact(() => {
    for (let i = 0; i < SIZES.fleet; i++) {
      const bee = seed.createBee({ name: `small-${i}`, agent: "stub", substrate: "hsr", cwd: dir }).bee;
      smallBeeIds.push(bee.id);
      seed.send(bee.id, SMALL_BODY, { urgency: "idle" });
    }
  });
  const giantBeeId = seed.transact(() => seed.createBee({ name: "giant", agent: "stub", substrate: "hsr", cwd: dir }).bee.id);
  const auditAfterPublicSeed = seed.lastAuditSeq();
  seed.close();
  // Offline giant rows: INTERLEAVED pending/delivered (every third remains
  // pending), delivered by the bee's real generation 1; zero audit rows
  // added after the public seed (asserted in the PK-proof pass below).
  let offlineDelivered = 0;
  let offlinePending = 0;
  {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(seedPath);
    const ins = db.prepare(
      "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation) VALUES(?, 'operator', ?, 0, 'idle', ?, ?, ?)",
    );
    db.exec("BEGIN");
    for (let r = 0; r < SIZES.giantRows; r++) {
      const enqueuedAt = T0 - 900_000 + r;
      const delivered = r % 3 !== 0;
      ins.run(giantBeeId, `${GIANT_BODY}${r}`, enqueuedAt, delivered ? enqueuedAt + 500 : null, delivered ? 1 : null);
      if (delivered) offlineDelivered += 1;
      else offlinePending += 1;
    }
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }
  const numberField = (row, f) => {
    const v = Reflect.get(row, f);
    assert.equal(typeof v, "number", `raw ${f} not a number`);
    return v;
  };
  const textField = (row, f) => {
    const v = Reflect.get(row, f);
    assert.equal(typeof v, "string", `raw ${f} not text`);
    return v;
  };
  const nullableNumberField = (row, f) => {
    const v = Reflect.get(row, f);
    if (v === null) return null;
    assert.equal(typeof v, "number", `raw ${f} not number|null`);
    return v;
  };
  const sidecar = {};
  {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(seedPath, { readOnly: true });
    const rawRows = db.prepare("SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id").all(giantBeeId);
    db.close();
    assert.equal(rawRows.length, SIZES.giantRows);
    let proofClock = T0 - 90_000;
    const proof = core.openCoreStore(seedPath, { now: () => (proofClock += 1) });
    assert.equal(proof.lastAuditSeq(), auditAfterPublicSeed, "offline rows must add zero audit rows after the public seed");
    for (const row of rawRows) {
      const mapped = {
        id: numberField(row, "id"),
        beeId: textField(row, "bee_id"),
        sender: textField(row, "sender"),
        body: textField(row, "body"),
        priority: numberField(row, "priority"),
        urgency: textField(row, "urgency"),
        enqueuedAt: numberField(row, "enqueued_at"),
        deliveredAt: nullableNumberField(row, "delivered_at"),
        deliveredGeneration: nullableNumberField(row, "delivered_generation"),
      };
      assert.deepEqual(proof.getMessage(mapped.id), mapped, `offline row ${mapped.id} fails full PK equality`);
    }
    for (const beeId of [...smallBeeIds, giantBeeId]) {
      const bee = proof.getBee(beeId);
      assert(bee && bee.lifecycle === "active" && !bee.title);
      const users = userTaskMessages(proof.listMessages(beeId));
      assert(users.length >= 1, "backoff bees need substantive content");
      sidecar[beeId] = { attempts: 7, lastAt: T0, userTurns: users.length, deferred: false, signature: contextSignature(bee, users) };
    }
    proof.close();
  }
  const sidecarPath = join(dir, "bookkeeping.json");
  writeFileSync(sidecarPath, `${JSON.stringify(sidecar)}\n`);
  const manifest = {
    fixtureSha256: hash(readFileSync(seedPath)),
    sidecarSha256: hash(readFileSync(sidecarPath)),
    smallBeeIds,
    giantBeeId,
  };
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  report.fixture = {
    fixtureSha256: manifest.fixtureSha256,
    sidecarSha256: manifest.sidecarSha256,
    smallBees: smallBeeIds.length,
    giantRows: SIZES.giantRows,
    offlineMailboxRows: SIZES.giantRows,
    offlineDelivered,
    offlinePending,
    auditRowsAdded: 0,
  };
  save();

  // ---- serial ABBA child runs: unique outputs/artifacts per run -----------
  const toolPath = fileURLToPath(import.meta.url);
  for (const [runIndex, side] of CHILD_ORDER.entries()) {
    const childOut = join(dir, `child-run${runIndex}-side${side}.json`);
    const artifactPrefix = `${out}.run${runIndex}-side${side}`;
    const r = spawnSync(
      process.execPath,
      ["--expose-gc", toolPath, "--child", roots[side], seedPath, sidecarPath, manifestPath, childOut, scale, mode, artifactPrefix],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const child = existsSync(childOut) ? JSON.parse(readFileSync(childOut, "utf8")) : { failure: "child wrote no output" };
    child.runIndex = runIndex;
    child.side = side;
    child.exitStatus = r.status;
    child.stderrTail = (r.stderr ?? "").split("\n").slice(-6).join("\n");
    report.runs.push(child);
    save();
    assert.equal(r.status, 0, `child run ${runIndex} (side ${side}) failed: ${child.failure ?? r.stderr}`);
    assert.deepEqual(child.fingerprint, sources[side], "child saw a different root state");
    assert.equal(child.scans, EXPECTED_SCANS[scale]);
  }

  // Whole-process phase differences, per run — numeric comparisons belong to
  // mode=none only; snapshot-mode readings are diagnostic-only.
  if (mode === "none") {
    report.wholeProcessPhaseDifferences = report.runs.map((run) => {
      const at = Object.fromEntries(run.snapshots.map((s) => [s.label, s]));
      const d = (a, b, k) => at[b][k] - at[a][k];
      const keys = ["heapUsed", "rss"];
      const spans = [
        ["constructed", "firstScan"],
        ["firstScan", "warm"],
        ["warm", "rosterDeleted"],
        ["warm", "released"],
      ];
      return {
        runIndex: run.runIndex,
        side: run.side,
        ...Object.fromEntries(
          keys.map((k) => [k, Object.fromEntries(spans.map(([a, b]) => [`${a}To${b[0].toUpperCase()}${b.slice(1)}`, d(a, b, k)]))]),
        ),
      };
    });
  }
  assert.deepEqual(roots.map(fingerprint), sources, "roots mutated during the run");
  assert.equal(hash(readFileSync(new URL(import.meta.url))), toolHash);
  assert.equal(boot(), report.environment.boot, "boot session changed mid-run");
  report.completed = true;
} catch (e) {
  report.failure = String(e.stack ?? e);
  throw e;
} finally {
  report.finishedAt = new Date().toISOString();
  report.environment.loadAfter = loadavg();
  save();
  rmSync(dir, { recursive: true, force: true });
}
console.log(out);
