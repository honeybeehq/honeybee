// autoTitle TRANSITION ruler (changed / expiry / multi-giant stress) — DRAFT
// for parent review. Disposable; no allocation or retained-memory features.
//
// Semantic check performed before authoring (recorded, no mismatch found):
// against the current autoTitle source and the selected synthesis
// (store-owned membership, quiet-only reuse, full-roster pruning), the four
// scenarios hold: envelope-only appends change committed membership but not
// the normalized signature, so scenario 1/2 bees stay deferred-quiet on
// every implementation while pricing the miss; an expired backoff is never
// a quiet condition, so scenario 3 always takes the full read and launches
// with full launch-context assembly (asserted exactly, both sides); the
// scenario 4 fleet stays inside its seeded backoff window, all giants
// visited. Diagnostics record read counts; only the BEFORE side's counts
// are asserted (its semantics are known); candidate-side counts are data.
//
// Usage:
//   node honeybee-autotitle-transition-ruler.mjs <beforeRoot> <afterRoot> <out.json> \
//        [control=true|false] [scale=smoke|canonical] \
//        [expectedDiff=comma,separated,paths]   (REQUIRED for A/B)
//
// Discipline is the approved quiet ruler's: immutable distinct roots,
// runtime-only fingerprints with an exact declared A/B delta, distinct
// module instances, one seed per scenario built via the BEFORE module then
// byte-copied per side (never reusing mutated copies), before-module
// helpers for sidecar signatures, full-field PK proof + audit labeling for
// offline rows, per-side logical clocks, firstScan reported separately,
// warmed ABBA rounds with raw CPU/wall samples retained, mutations /
// settles / drains / oracles OUTSIDE the clocks, exact state / sidecar /
// outcome parity, deterministic providers (throwing where launches are
// forbidden; a deterministic rejecting mock where scenario 3 requires
// launches — mock timing is NOT a production generation measurement), and
// recorded scheduling rules sufficient to reconstruct each side's steps.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const [beforeArg, afterArg, outArg, controlArg = "false", scale = "smoke", expectedDiffArg = ""] = process.argv.slice(2);
assert(beforeArg && afterArg && outArg, "usage: ruler <before> <after> <out> [control] [scale] [expectedDiff]");
assert(["true", "false"].includes(controlArg));
assert(["smoke", "canonical"].includes(scale));
const control = controlArg === "true";
const expectedDiff = expectedDiffArg.length === 0 ? [] : expectedDiffArg.split(",").map((p) => p.trim()).filter(Boolean).sort();
if (control) assert.deepEqual(expectedDiff, [], "A/A control takes no expectedDiff");
else assert(expectedDiff.length > 0, "A/B requires the exact expected runtime changed-file set");
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
const runtimeDiff = Object.keys(sources[0].hashes).filter((p) => sources[0].hashes[p] !== sources[1].hashes[p]).sort();
assert.deepEqual(runtimeDiff, expectedDiff, control ? "A/A control roots must be byte-identical" : "runtime diff must equal the declared expected set");
const toolHash = hash(readFileSync(new URL(import.meta.url)));
const boot = () => {
  const r = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return hash(r.stdout.trim());
};

const coreModules = await Promise.all(roots.map((root) => import(pathToFileURL(join(root, "v2/core/src/index.ts")).href)));
const titleModules = await Promise.all(roots.map((root) => import(pathToFileURL(join(root, "v2/daemon/src/autoTitle.ts")).href)));
const namingModules = await Promise.all(roots.map((root) => import(pathToFileURL(join(root, "v2/daemon/src/naming.ts")).href)));
assert.notEqual(coreModules[0].openCoreStore, coreModules[1].openCoreStore, "modules must be distinct instances");
assert.notEqual(titleModules[0].createStoreAutoTitleDispatcher, titleModules[1].createStoreAutoTitleDispatcher);
const { userTaskMessages, contextSignature } = titleModules[0];
const { stripSessionEnvelopes, isThinOpener } = namingModules[0];

const T0 = 1_000_000_000;
const BACKOFF_WINDOW_MS = 600_000;
const ENVELOPE_BODY = "<hive-session>generation 3 boot; transcript /tmp/x.jsonl</hive-session>";
const THIN_BODY = "hi";
const GIANT_BODY = "Migrate the billing exporter to the new ledger API and backfill March step ";
const REJECTION_MESSAGE = "transition-ruler deterministic rejection";
const SIZES = scale === "smoke"
  ? { fleet: 12, giantRows: 300, giants: 3, giantEachRows: 60, warmupRounds: 2, measuredRounds: 3, expiryWarmupRounds: 2, expiryMeasuredRounds: 3 }
  : { fleet: 1000, giantRows: 100_000, giants: 10, giantEachRows: 20_000, warmupRounds: 3, measuredRounds: 15, expiryWarmupRounds: 3, expiryMeasuredRounds: 15 };
const CANONICAL_SIZES = { fleet: 1000, giantRows: 100_000, giants: 10, giantEachRows: 20_000, warmupRounds: 3, measuredRounds: 15, expiryWarmupRounds: 3, expiryMeasuredRounds: 15 };
const ABBA = [0, 1, 1, 0];

const report = {
  completed: false,
  startedAt: new Date().toISOString(),
  roots,
  sources,
  runtimeDiff,
  toolHash,
  control,
  scale,
  sizes: SIZES,
  proposedCanonicalSizes: CANONICAL_SIZES,
  environment: { node: process.version, cpu: cpus()[0].model, boot: boot(), loadBefore: loadavg() },
  sourceChecks: {
    factorySignaturePresent: roots.map((_, side) => typeof titleModules[side].createStoreAutoTitleDispatcher === "function"),
    note: "recorded as data; candidate internals are not constrained by this tool",
  },
  schedule: {
    abbaOrder: ABBA,
    clockRule: "+1000 ms per scan; expiry cycles jump to lastClaim+600001 before the timed scan and +1000 for the untimed drain scan",
    mutationRule: "scenario mutations run OUTSIDE clocks, before a scan, keyed to the side-local scan index (one-changed: fleet[index % fleet]; all-changed: every fleet bee in one transaction)",
    firstScanRule: "one separately-reported first scan per side (order side0 then side1), then warmupRounds x ABBA, then measuredRounds x ABBA",
  },
  scope:
    "Transition unit only: changed-membership, backoff-expiry, and multi-giant stress shapes, CPU/wall per timed scan with raw paired ABBA samples retained. Mutations, settles, drains, sidecar/state oracles, and read-count diagnostics all run OUTSIDE the clocks. Envelope-only appends change committed id membership while the normalized signature stays thin/deferred (verified with the BEFORE module's own helpers), so scenarios 1-2 price misses without generation work. Scenario 3 uses a deterministic rejecting mock provider: scan timing EXCLUDES mock completion, and mock timing is not a production generation measurement; provider context (beeId, initialTask, last-three clamped user messages), retry counts, sidecar bytes, and drained outcome streams are asserted exactly on BOTH sides each cycle. Scenario 4 is a measured multi-giant stress shape, not an extrapolation. Offline giant rows are labeled (zero audit rows after the public seed, asserted) and every offline row is full-nine-field PK-proven before copies. Read-count diagnostics wrap public store methods with pass-through interception outside timing and restore them in finally; ONLY the BEFORE side's counts are asserted (known baseline semantics: deferred/backoff fleets are fully read); candidate-side counts are recorded as data because an accepted implementation may legitimately read fewer; in A/A control both sides must match. No allocation, retained-memory, Mini, broad-suite, or production claims; structural smoke on a contended workstation proves wiring, not performance.",
  scenarios: [],
};
const save = () => writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
const dist = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: s[Math.floor((s.length - 1) / 2)], p95: s[Math.ceil((s.length - 1) * 0.95)], min: s[0], max: s.at(-1) };
};
const dir = mkdtempSync(join(tmpdir(), "hb-transition-"));
const opened = [];
save();

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

/** Offline interleaved rows + full PK proof + audit labeling for one bee. */
async function seedOfflineRows(seedPath, core, beeId, rows, auditAfterPublicSeed) {
  const { DatabaseSync } = await import("node:sqlite");
  {
    const db = new DatabaseSync(seedPath);
    const ins = db.prepare(
      "INSERT INTO mailbox(bee_id, sender, body, priority, urgency, enqueued_at, delivered_at, delivered_generation) VALUES(?, 'operator', ?, 0, 'idle', ?, ?, ?)",
    );
    db.exec("BEGIN");
    for (let r = 0; r < rows; r++) {
      const enqueuedAt = T0 - 900_000 + r;
      const delivered = r % 3 !== 0;
      ins.run(beeId, `${GIANT_BODY}${r}`, enqueuedAt, delivered ? enqueuedAt + 500 : null, delivered ? 1 : null);
    }
    db.exec("COMMIT");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  }
  const check = new DatabaseSync(seedPath, { readOnly: true });
  const rawRows = check.prepare("SELECT * FROM mailbox WHERE bee_id = ? ORDER BY id").all(beeId);
  check.close();
  assert.equal(rawRows.length, rows);
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
  proof.close();
}

/** Common per-scenario scaffolding over two sides. */
function makeSides(scenarioName, seedPath, sidecarJson, generateFor) {
  const paths = [0, 1].map((side) => join(dir, `${scenarioName}-${side}.sqlite`));
  const fixtureSha256 = hash(readFileSync(seedPath));
  for (const p of paths) {
    copyFileSync(seedPath, p);
    assert.equal(hash(readFileSync(p)), fixtureSha256, "seed copy drifted");
  }
  const statePaths = [0, 1].map((side) => join(dir, `${scenarioName}-${side}-bookkeeping.json`));
  for (const p of statePaths) writeFileSync(p, sidecarJson);
  const clocks = [{ t: T0 }, { t: T0 }];
  const stores = paths.map((p, side) => coreModules[side].openCoreStore(p, { now: () => clocks[side].t }));
  opened.push(...stores);
  const contexts = [[], []];
  const dispatchers = stores.map((store, side) =>
    titleModules[side].createStoreAutoTitleDispatcher(store, {
      naming: () => ({ auto: true }),
      statePath: statePaths[side],
      now: () => clocks[side].t,
      log: () => undefined,
      generate: generateFor(side, contexts[side]),
    }),
  );
  const scanCounts = [0, 0];
  const timedScan = async (side) => {
    clocks[side].t += 1000;
    scanCounts[side] += 1;
    const c = process.cpuUsage();
    const t = performance.now();
    const outcomes = await dispatchers[side]();
    const wallMs = performance.now() - t;
    const u = process.cpuUsage(c);
    return { outcomes, sample: { wallMs, cpuMs: (u.user + u.system) / 1000 } };
  };
  const untimedScan = async (side, clockAdvance = 1000) => {
    clocks[side].t += clockAdvance;
    scanCounts[side] += 1;
    return dispatchers[side]();
  };
  const stateHash = (s) => hash(JSON.stringify({ state: s.dumpState(), audit: s.auditRows() }));
  const close = () => {
    for (const s of stores) {
      s.close();
      opened.splice(opened.indexOf(s), 1);
    }
  };
  return { fixtureSha256, sidecarSha256: hash(sidecarJson), paths, statePaths, clocks, stores, dispatchers, contexts, scanCounts, timedScan, untimedScan, stateHash, close };
}

/** Pass-through read-count interception, outside timing, restored by caller. */
function interceptReads(store) {
  const counts = { listMessages: 0, readMailboxMembership: 0, membershipMethodPresent: false };
  const originalList = store.listMessages.bind(store);
  Object.defineProperty(store, "listMessages", { configurable: true, value: (beeId) => { counts.listMessages += 1; return originalList(beeId); } });
  let restoreMembership = null;
  if (typeof store.readMailboxMembership === "function") {
    counts.membershipMethodPresent = true;
    const originalMembership = store.readMailboxMembership.bind(store);
    Object.defineProperty(store, "readMailboxMembership", { configurable: true, value: (beeId) => { counts.readMailboxMembership += 1; return originalMembership(beeId); } });
    restoreMembership = () => delete store.readMailboxMembership;
  }
  return { counts, restore: () => { delete store.listMessages; if (restoreMembership) restoreMembership(); } };
}

/** ONE generate function per side: counts the invocation, then throws. */
const makeCountedThrowingGenerate = (label, providerCalls) => (side) => () => {
  providerCalls[side] += 1;
  throw new Error(`${label}: quiet scenario attempted a launch`);
};

try {
  // ======================================================================
  // Scenario seed A: thin-deferred fleet (used by one-changed + all-changed)
  // ======================================================================
  const fleetSeedPath = join(dir, "fleet-seed.sqlite");
  let fleetIds = [];
  let fleetSidecarJson = "";
  {
    let seedClock = T0 - 1_000_000;
    const seed = coreModules[0].openCoreStore(fleetSeedPath, { now: () => (seedClock += 1) });
    seed.transact(() => {
      for (let i = 0; i < SIZES.fleet; i++) {
        const bee = seed.createBee({ name: `thin-${i}`, agent: "stub", substrate: "hsr", cwd: dir }).bee;
        fleetIds.push(bee.id);
        seed.send(bee.id, THIN_BODY, { urgency: "idle" });
      }
    });
    const sidecar = {};
    for (const beeId of fleetIds) {
      const bee = seed.getBee(beeId);
      const users = userTaskMessages(seed.listMessages(beeId));
      assert.equal(users.length, 1, "thin fleet bees carry exactly one normalized message");
      assert.ok(isThinOpener(users[0]), "fleet opener must be thin");
      sidecar[beeId] = { attempts: 0, lastAt: 0, userTurns: 1, deferred: true, signature: contextSignature(bee, users) };
    }
    // The envelope append must NOT change any signature: verified with the
    // real helpers before any scenario runs.
    assert.deepEqual(userTaskMessages([{ body: THIN_BODY }, { body: ENVELOPE_BODY }]), userTaskMessages([{ body: THIN_BODY }]),
      "envelope-only bodies must normalize away");
    seed.close();
    fleetSidecarJson = `${JSON.stringify(sidecar)}\n`;
  }

  for (const variant of ["one-changed", "all-changed"]) {
    const providerCalls = [0, 0];
    const sides = makeSides(variant, fleetSeedPath, fleetSidecarJson, makeCountedThrowingGenerate(variant, providerCalls));
    const rotations = [[], []];
    const mutationCounts = [0, 0];
    const mutate = (side) => {
      const store = sides.stores[side];
      if (variant === "one-changed") {
        const target = fleetIds[mutationCounts[side] % fleetIds.length];
        rotations[side].push(target);
        store.send(target, ENVELOPE_BODY, { urgency: "idle" });
      } else {
        store.transact(() => {
          for (const beeId of fleetIds) store.send(beeId, ENVELOPE_BODY, { urgency: "idle" });
        });
      }
      mutationCounts[side] += 1;
    };
    const step = async (side, timed) => {
      mutate(side); // outside the clock
      if (timed) {
        const { outcomes, sample } = await sides.timedScan(side);
        assert.deepEqual(outcomes, [], `${variant}: scan produced outcomes`);
        return sample;
      }
      assert.deepEqual(await sides.untimedScan(side), [], `${variant}: scan produced outcomes`);
      return null;
    };
    const firstScan = [await step(0, true), await step(1, true)];
    for (let i = 0; i < SIZES.warmupRounds; i++) for (const side of ABBA) await step(side, false);
    const raw = [[], []];
    for (let i = 0; i < SIZES.measuredRounds; i++) for (const side of ABBA) raw[side].push(await step(side, true));
    // Diagnostics: one further full step per side with interception.
    const diagnostics = [];
    for (const side of [0, 1]) {
      const wrap = interceptReads(sides.stores[side]);
      try {
        await step(side, false);
      } finally {
        wrap.restore();
      }
      diagnostics.push({ side, ...wrap.counts });
    }
    assert.equal(diagnostics[0].listMessages, SIZES.fleet, `${variant}: BEFORE side must read the whole reached fleet`);
    if (control) assert.deepEqual({ ...diagnostics[1], side: 0 }, { ...diagnostics[0], side: 0 }, `${variant}: A/A diagnostic counts must match`);
    // Parity oracles, outside timing: identical mutation schedules must
    // leave both sides byte-equivalent, and sidecars untouched (quiet).
    assert.equal(sides.scanCounts[0], sides.scanCounts[1]);
    assert.deepEqual(rotations[0], rotations[1], `${variant}: rotation sequences must match across sides`);
    if (variant === "one-changed") {
      assert.deepEqual(rotations[0], rotations[0].map((_, i) => fleetIds[i % fleetIds.length]), "rotation must be round-robin");
    }
    assert.equal(readFileSync(sides.statePaths[0], "utf8"), fleetSidecarJson, `${variant}: sidecar changed`);
    assert.equal(readFileSync(sides.statePaths[1], "utf8"), fleetSidecarJson, `${variant}: sidecar changed`);
    assert.deepEqual(providerCalls, [0, 0], `${variant}: provider must never be invoked`);
    assert.equal(sides.stateHash(sides.stores[0]), sides.stateHash(sides.stores[1]), `${variant}: sides diverged`);
    assert.equal(sides.stores[0].lastAuditSeq(), sides.stores[1].lastAuditSeq());
    assert(sides.clocks[0].t - T0 <= 580_000, `${variant}: escaped the logical window`);
    sides.close();
    report.scenarios.push({
      name: variant,
      fleet: SIZES.fleet,
      fixtureSha256: sides.fixtureSha256,
      sidecarSha256: sides.sidecarSha256,
      mutationsPerSide: mutationCounts[0],
      messagesAppendedPerMutation: variant === "one-changed" ? 1 : SIZES.fleet,
      firstScan,
      raw,
      metrics: raw.map((xs) => ({ scanWallMs: dist(xs.map((x) => x.wallMs)), scanCpuMs: dist(xs.map((x) => x.cpuMs)) })),
      diagnostics,
      rotation: variant === "one-changed" ? rotations[0] : null,
    });
    save();
  }

  // ======================================================================
  // Scenario 3: repeated backoff expiry of one substantive giant
  // ======================================================================
  {
    const seedPath = join(dir, "expiry-seed.sqlite");
    let seedClock = T0 - 1_000_000;
    const seed = coreModules[0].openCoreStore(seedPath, { now: () => (seedClock += 1) });
    const giantId = seed.transact(() => seed.createBee({ name: "expiry-giant", agent: "stub", substrate: "hsr", cwd: dir }).bee.id);
    const auditAfterPublicSeed = seed.lastAuditSeq();
    seed.close();
    await seedOfflineRows(seedPath, coreModules[0], giantId, SIZES.giantRows, auditAfterPublicSeed);
    let expectedContext = null;
    let sidecarJson = "";
    {
      let sigClock = T0 - 50_000;
      const reader = coreModules[0].openCoreStore(seedPath, { now: () => (sigClock += 1) });
      const bee = reader.getBee(giantId);
      const messages = reader.listMessages(giantId);
      const users = userTaskMessages(messages);
      assert.equal(users.length, SIZES.giantRows);
      const initialTask = messages.map((m) => stripSessionEnvelopes(m.body)).find((m) => !isThinOpener(m)) ?? "";
      expectedContext = { beeId: giantId, initialTask, userMessages: users.slice(-3) };
      sidecarJson = `${JSON.stringify({ [giantId]: { attempts: 7, lastAt: T0, userTurns: users.length, deferred: false, signature: contextSignature(bee, users) } })}\n`;
      reader.close();
    }
    // Held-promise provider: entry and held-promise allocation may fall
    // inside the awaited scan timing; rejection CONSTRUCTION, completion,
    // and drain are explicitly outside it (the pending rejector fires only
    // after the timed span stops).
    const pendingRejects = [null, null];
    const sides = makeSides("expiry-giant", seedPath, sidecarJson, (side, contexts) => (context) => {
      contexts.push(context);
      return new Promise((_, reject) => {
        assert.equal(pendingRejects[side], null, "at most one held generation per side");
        pendingRejects[side] = reject;
      });
    });
    const seededSignature = JSON.parse(sidecarJson)[giantId].signature;
    const lastClaim = [T0, T0];
    const attempts = [7, 7];
    const stateBefore = sides.stores.map(sides.stateHash);
    assert.equal(stateBefore[0], stateBefore[1], "expiry: sides must open with identical state hashes");
    const cycle = async (side, timed) => {
      // Jump PAST the 600 s cap so the backoff has expired: this scan MUST
      // launch. The timed span covers the scan only; the mock provider's
      // rejection settles afterwards and the drain scan is untimed.
      sides.clocks[side].t = lastClaim[side] + BACKOFF_WINDOW_MS + 1;
      sides.scanCounts[side] += 1;
      let sample = null;
      let outcomes;
      if (timed) {
        const c = process.cpuUsage();
        const t = performance.now();
        outcomes = await sides.dispatchers[side]();
        const wallMs = performance.now() - t;
        const u = process.cpuUsage(c);
        sample = { wallMs, cpuMs: (u.user + u.system) / 1000 };
      } else {
        outcomes = await sides.dispatchers[side]();
      }
      assert.deepEqual(outcomes, [], "the launching scan itself drains nothing");
      lastClaim[side] = sides.clocks[side].t;
      attempts[side] += 1;
      // Outside the timed span: exactly one new provider invocation with
      // exactly one held rejection, then the controlled rejection + drain.
      assert.equal(sides.contexts[side].length, attempts[side] - 7, "provider invocations must grow by exactly one per cycle");
      assert.equal(typeof pendingRejects[side], "function", "the launching scan must hold exactly one pending generation");
      const reject = pendingRejects[side];
      pendingRejects[side] = null;
      reject(new Error(REJECTION_MESSAGE));
      await sleep(0);
      await sleep(0); // rejection settles fully outside the timed span
      const drained = await sides.untimedScan(side, 1000);
      assert.deepEqual(drained, [{ beeId: giantId, ok: false, error: REJECTION_MESSAGE }], "drain must yield exactly the rejection outcome");
      const expectedSidecarBytes = `${JSON.stringify({
        [giantId]: { attempts: attempts[side], lastAt: lastClaim[side], userTurns: SIZES.giantRows, deferred: false, signature: seededSignature },
      })}\n`;
      assert.equal(readFileSync(sides.statePaths[side], "utf8"), expectedSidecarBytes, "sidecar must record the claim as exact serialized bytes");
      const context = sides.contexts[side].at(-1);
      assert.deepEqual(context, expectedContext, "provider context must be the exact full-read launch context");
      return sample;
    };
    const firstCycle = [await cycle(0, true), await cycle(1, true)];
    for (let i = 0; i < SIZES.expiryWarmupRounds; i++) for (const side of ABBA) await cycle(side, false);
    const raw = [[], []];
    for (let i = 0; i < SIZES.expiryMeasuredRounds; i++) for (const side of ABBA) raw[side].push(await cycle(side, true));
    const diagnostics = [];
    for (const side of [0, 1]) {
      const wrap = interceptReads(sides.stores[side]);
      try {
        await cycle(side, false);
      } finally {
        wrap.restore();
      }
      diagnostics.push({ side, ...wrap.counts });
    }
    // A cycle spans TWO dispatcher scans — the timed launching scan and the
    // untimed drain scan — and on the baseline each performs one full read
    // of the giant (the drain scan re-reads, re-matches the signature, and
    // skips on fresh backoff before returning the drained outcome).
    assert.equal(diagnostics[0].listMessages, 2, "expiry: BEFORE side reads the giant once per scan, twice per cycle");
    if (control) assert.deepEqual({ ...diagnostics[1], side: 0 }, { ...diagnostics[0], side: 0 });
    // Exact accounting: launches/side = 1 first + warmupRounds*2 + measuredRounds*2 + 1 diagnostic,
    // each cycle spans two dispatcher scans (launch + drain).
    const expectedLaunches = 1 + SIZES.expiryWarmupRounds * 2 + SIZES.expiryMeasuredRounds * 2 + 1;
    for (const side of [0, 1]) {
      assert.equal(raw[side].length, SIZES.expiryMeasuredRounds * 2, "measured samples per side must equal 2x rounds");
      assert.equal(sides.contexts[side].length, expectedLaunches, "launch count must match the declared schedule");
      assert.equal(sides.scanCounts[side], expectedLaunches * 2, "each cycle spans exactly two scans");
    }
    assert.deepEqual(sides.stores.map(sides.stateHash), stateBefore, "expiry cycles must not change store state");
    sides.close();
    report.scenarios.push({
      name: "expiry-giant",
      giantRows: SIZES.giantRows,
      fixtureSha256: sides.fixtureSha256,
      sidecarSha256: sides.sidecarSha256,
      offlineMailboxRows: SIZES.giantRows,
      auditRowsAdded: 0,
      launchesPerSide: sides.contexts[0].length,
      accounting: {
        firstCycle: 1,
        warmupCycles: SIZES.expiryWarmupRounds * 2,
        measuredCycles: SIZES.expiryMeasuredRounds * 2,
        diagnosticCycles: 1,
        scansPerCycle: 2,
      },
      finalAttempts: attempts[0],
      expectedContextShape: { initialTaskChars: expectedContext.initialTask.length, lastUserMessages: expectedContext.userMessages.length },
      firstCycle,
      raw,
      metrics: raw.map((xs) => ({ scanWallMs: dist(xs.map((x) => x.wallMs)), scanCpuMs: dist(xs.map((x) => x.cpuMs)) })),
      diagnostics,
      note: "mock-provider completion excluded from timed spans; fake-provider timing is not a production generation measurement",
    });
    save();
  }

  // ======================================================================
  // Scenario 4: quiet fleet of substantive backoff giants (measured stress)
  // ======================================================================
  {
    const seedPath = join(dir, "ten-giants-seed.sqlite");
    let seedClock = T0 - 1_000_000;
    const seed = coreModules[0].openCoreStore(seedPath, { now: () => (seedClock += 1) });
    const giantIds = [];
    for (let g = 0; g < SIZES.giants; g++) {
      giantIds.push(seed.transact(() => seed.createBee({ name: `stress-giant-${g}`, agent: "stub", substrate: "hsr", cwd: dir }).bee.id));
    }
    const auditAfterPublicSeed = seed.lastAuditSeq();
    seed.close();
    for (const giantId of giantIds) {
      await seedOfflineRows(seedPath, coreModules[0], giantId, SIZES.giantEachRows, auditAfterPublicSeed);
    }
    let sidecarJson = "";
    {
      let sigClock = T0 - 50_000;
      const reader = coreModules[0].openCoreStore(seedPath, { now: () => (sigClock += 1) });
      const sidecar = {};
      for (const giantId of giantIds) {
        const bee = reader.getBee(giantId);
        const users = userTaskMessages(reader.listMessages(giantId));
        assert.equal(users.length, SIZES.giantEachRows);
        sidecar[giantId] = { attempts: 7, lastAt: T0, userTurns: users.length, deferred: false, signature: contextSignature(bee, users) };
      }
      reader.close();
      sidecarJson = `${JSON.stringify(sidecar)}\n`;
    }
    const providerCalls = [0, 0];
    const sides = makeSides("ten-giants", seedPath, sidecarJson, makeCountedThrowingGenerate("ten-giants", providerCalls));
    const stateBefore = sides.stores.map(sides.stateHash);
    assert.equal(stateBefore[0], stateBefore[1], "ten-giants: sides must open with identical state hashes");
    const quietScan = async (side, timed) => {
      if (timed) {
        const { outcomes, sample } = await sides.timedScan(side);
        assert.deepEqual(outcomes, [], "ten-giants: scan produced outcomes");
        return sample;
      }
      assert.deepEqual(await sides.untimedScan(side), [], "ten-giants: scan produced outcomes");
      return null;
    };
    const firstScan = [await quietScan(0, true), await quietScan(1, true)];
    for (let i = 0; i < SIZES.warmupRounds; i++) for (const side of ABBA) await quietScan(side, false);
    const raw = [[], []];
    for (let i = 0; i < SIZES.measuredRounds; i++) for (const side of ABBA) raw[side].push(await quietScan(side, true));
    const diagnostics = [];
    for (const side of [0, 1]) {
      const wrap = interceptReads(sides.stores[side]);
      try {
        await quietScan(side, false);
      } finally {
        wrap.restore();
      }
      diagnostics.push({ side, ...wrap.counts });
    }
    assert.equal(diagnostics[0].listMessages, SIZES.giants, "ten-giants: BEFORE side must read every giant each scan");
    if (control) assert.deepEqual({ ...diagnostics[1], side: 0 }, { ...diagnostics[0], side: 0 });
    for (const side of [0, 1]) {
      assert.equal(readFileSync(sides.statePaths[side], "utf8"), sidecarJson, "ten-giants: sidecar changed during quiet scans");
      assert(sides.clocks[side].t - T0 <= BACKOFF_WINDOW_MS - 20_000, "ten-giants: escaped the seeded backoff window");
    }
    assert.deepEqual(providerCalls, [0, 0], "ten-giants: provider must never be invoked");
    assert.deepEqual(sides.stores.map(sides.stateHash), stateBefore, "ten-giants: quiet scans changed store state");
    sides.close();
    report.scenarios.push({
      name: "ten-giants",
      giants: SIZES.giants,
      rowsPerGiant: SIZES.giantEachRows,
      totalRows: SIZES.giants * SIZES.giantEachRows,
      fixtureSha256: sides.fixtureSha256,
      sidecarSha256: sides.sidecarSha256,
      offlineMailboxRows: SIZES.giants * SIZES.giantEachRows,
      auditRowsAdded: 0,
      firstScan,
      raw,
      metrics: raw.map((xs) => ({ scanWallMs: dist(xs.map((x) => x.wallMs)), scanCpuMs: dist(xs.map((x) => x.cpuMs)) })),
      diagnostics,
    });
    save();
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
  for (const s of opened) s.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(out);
