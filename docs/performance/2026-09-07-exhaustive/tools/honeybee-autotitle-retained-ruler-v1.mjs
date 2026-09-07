// autoTitle RETAINED-memory ruler — DRAFT for parent review. Disposable tool.
//
// Prices what a dispatcher RETAINS (e.g. a candidate private stamp+signature
// Map) as retained JS heap / process RSS across phases, in INDEPENDENT
// child processes per source root — never two roots in one heap. Allocation
// traffic is a different ruler; this one only reports post-GC retained
// figures and honestly labels what they can and cannot attribute.
//
// Usage (orchestrator):
//   node honeybee-autotitle-retained-ruler.mjs <beforeRoot> <afterRoot> <out.json> \
//        [control=true|false] [mode=none|snapshot] [scale=smoke|canonical] \
//        [expectedDiff=comma,separated,paths]   (REQUIRED for A/B)
// The orchestrator builds ONE fixture via the BEFORE module, then spawns
// itself twice ( --child ) SERIALLY, one process per root, with --expose-gc.
//
// Workload per child: one combined quiet fleet — <fleet> small backoff bees
// (public transactional, one substantive message each) plus ONE giant
// backoff mailbox (offline-labeled interleaved pending/delivered rows,
// every one PK-proven by the orchestrator before copies). Sidecar seeded
// identically from the BEFORE module's own normalization helpers at the
// 600 s backoff cap, so every scan is quiet; the provider throws on launch.
//
// Phases (each snapshotted after an identical fixed GC procedure):
//   cold          — store+dispatcher constructed, ONE scan done
//   warm          — after W further quiet scans (logical 1 Hz, inside cap)
//   rosterDeleted — all bees deleted (giant FIRST, so cascades stay cheap),
//                   then one scan over the empty roster (a pruning design
//                   sheds entries here), then GC
//   released      — dispatcher AND store references dropped, store closed,
//                   then GC: the warm→released delta bounds everything the
//                   dispatcher+store retained (lifecycle attribution)
//
// Honest limitations (also embedded in the report): RSS includes SQLite
// page cache, native allocator slack, and V8 fragmentation — it never
// attributes a specific cache. Post-GC heapUsed is the JS-side signal;
// global.gc() is best-effort, so deltas carry GC noise; run A/A first and
// read A/B as delta-of-deltas at identical phases. Per-entry attribution of
// a PRIVATE Map is NOT extractable here without production diagnostics
// (none added; expose-gc lives only in this disposable tool). Concrete
// fallback if that attribution must be exact: the accepted candidate's own
// test suite proves the bound functionally (map size == untitled-active
// roster via test-side Reflect access), and optional mode=snapshot writes
// V8 heap snapshots at warm/released for OFFLINE retaining-path analysis.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const ENVELOPEFREE_SMALL_BODY = "Investigate the flaky nightly export and pin the root cause";
const GIANT_BODY = "Migrate the billing exporter to the new ledger API and backfill March step ";

// =========================================================== child mode ====
if (process.argv[2] === "--child") {
  const [, , , root, seedPath, sidecarPath, manifestPath, outPath, scaleArg, modeArg, artifactPrefix] = process.argv;
  assert(root && seedPath && sidecarPath && manifestPath && outPath && scaleArg && modeArg && artifactPrefix);
  assert.equal(typeof globalThis.gc, "function", "child must run with --expose-gc");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const scale = scaleArg;
  const warmScans = scale === "smoke" ? 8 : 30;

  const gcNow = () => {
    for (let i = 0; i < 3; i++) globalThis.gc();
  };
  const snapshot = (label) => {
    gcNow();
    const m = process.memoryUsage();
    return { label, rss: m.rss, heapTotal: m.heapTotal, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers };
  };

  const dir = mkdtempSync(join(tmpdir(), "hb-retained-child-"));
  const result = { root: realpathSync(root), fingerprint: fingerprint(root), phases: [], scans: 0, snapshots: [] };
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
    let store = core.openCoreStore(dbPath, { now: () => clock.t });
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

    // cold: constructed + one scan.
    await scan();
    result.snapshots.push(snapshot("cold"));

    // warm: W further quiet scans.
    for (let i = 0; i < warmScans; i++) await scan();
    assert.equal(readFileSync(statePath, "utf8"), sidecarBytes, "sidecar changed during quiet scans");
    assert.equal(store.lastAuditSeq(), auditSeeded, "audit advanced during quiet scans");
    result.snapshots.push(snapshot("warm"));
    if (modeArg === "snapshot") {
      const v8 = await import("node:v8");
      const p = `${artifactPrefix}.warm.heapsnapshot`;
      v8.writeHeapSnapshot(p);
      result.warmHeapSnapshot = { path: p, sha256: hash(readFileSync(p)), bytes: readFileSync(p).length };
    }

    // rosterDeleted: delete the giant FIRST (one big cascade), then the
    // small bees (each cascade then scans a small mailbox), then one scan
    // over the empty roster so a pruning design sheds its entries.
    const order = [manifest.giantBeeId, ...manifest.smallBeeIds];
    for (const beeId of order) store.deleteBee(beeId);
    assert.deepEqual(store.listBees(), [], "roster must be empty after deletion");
    await scan();
    result.snapshots.push(snapshot("rosterDeleted"));

    // released: drop dispatcher AND store; the warm→released delta bounds
    // the dispatcher+store retained total (lifecycle attribution).
    store.close();
    dispatcher = null;
    store = null;
    result.snapshots.push(snapshot("released"));
    if (modeArg === "snapshot") {
      const v8 = await import("node:v8");
      const p = `${artifactPrefix}.released.heapsnapshot`;
      v8.writeHeapSnapshot(p);
      result.releasedHeapSnapshot = { path: p, sha256: hash(readFileSync(p)), bytes: readFileSync(p).length };
    }

    assert.equal(launches, 0, "provider must never be reached");
    result.completed = true;
  } catch (e) {
    result.failure = String(e.stack ?? e);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  if (!result.completed) process.exit(1);
  process.exit(0);
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
  environment: { node: process.version, cpu: cpus()[0].model, boot: boot(), loadBefore: loadavg() },
  scope:
    "Retained-memory unit only: independent child PROCESS per root (never two roots in one heap), spawned serially with --expose-gc (expose-gc exists ONLY in this disposable tool; no production diagnostics or API). One combined quiet fleet: small backoff bees (public transactional, one substantive message each) + one giant backoff mailbox (offline-labeled interleaved pending/delivered rows, delivered by real generation 1, EVERY row PK-proven full-field before copies; offline rows add zero audit rows after the public seed). Sidecar seeded from the BEFORE module's own helpers at the 600 s backoff cap; every scan quiet, provider throws on launch, outcomes/sidecar/audit asserted stable through the scan phases. Phases cold/warm/rosterDeleted/released each snapshot process.memoryUsage() after an identical 3x global.gc() procedure. LIMITATIONS: RSS includes SQLite page cache, native allocator slack, and V8 fragmentation — it attributes NO specific cache; post-GC heapUsed is the JS-side signal and global.gc() is best-effort, so read A/B as delta-of-deltas at identical phases with A/A first; per-entry attribution of a private Map is not extractable here — the concrete fallback is a functional bound test in the accepted candidate's own suite (map size == untitled-active roster via test-side Reflect access) plus optional mode=snapshot V8 heap snapshots at warm/released for OFFLINE retaining-path analysis. No timing claims, no allocation-traffic claims, no Mini/broad, no provider calls.",
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
      seed.send(bee.id, ENVELOPEFREE_SMALL_BODY, { urgency: "idle" });
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
  // Full-field PK proof of every offline row + audit stability, then the
  // identical backoff sidecar from BEFORE-module helpers.
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

  // ---- one independent child process per root, SERIAL ---------------------
  for (const [side, root] of roots.entries()) {
    const childOut = join(dir, `child-${side}.json`);
    const r = spawnSync(
      process.execPath,
      ["--expose-gc", new URL(import.meta.url).pathname, "--child", root, seedPath, sidecarPath, manifestPath, childOut, scale, mode, `${out}.side-${side}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const child = existsSync(childOut) ? JSON.parse(readFileSync(childOut, "utf8")) : { failure: "child wrote no output" };
    child.side = side;
    child.exitStatus = r.status;
    child.stderrTail = (r.stderr ?? "").split("\n").slice(-6).join("\n");
    report.runs.push(child);
    save();
    assert.equal(r.status, 0, `child ${side} failed: ${child.failure ?? r.stderr}`);
    assert.deepEqual(child.fingerprint, sources[side], "child saw a different root state");
  }

  // Phase deltas per side (derived, raw snapshots retained verbatim).
  report.derived = report.runs.map((run) => {
    const at = Object.fromEntries(run.snapshots.map((s) => [s.label, s]));
    const d = (a, b, k) => at[b][k] - at[a][k];
    return {
      side: run.side,
      heapUsed: {
        coldToWarm: d("cold", "warm", "heapUsed"),
        warmToRosterDeleted: d("warm", "rosterDeleted", "heapUsed"),
        warmToReleased: d("warm", "released", "heapUsed"),
      },
      rss: {
        coldToWarm: d("cold", "warm", "rss"),
        warmToRosterDeleted: d("warm", "rosterDeleted", "rss"),
        warmToReleased: d("warm", "released", "rss"),
      },
    };
  });
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
