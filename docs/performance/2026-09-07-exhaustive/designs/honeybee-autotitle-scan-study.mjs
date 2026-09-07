// autoTitle listMessages call-count study — READ-ONLY scratch, real dispatcher.
// Imports the actual createAutoTitleDispatcher from the c10 worktree (source
// identical to accepted main for this module) and drives it with counting
// stub deps: no provider, no store, no daemon. Counts are exact, not timed.
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const WT = "/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-c10-by-bee-2026-09-07";
const {
  createAutoTitleDispatcher,
  contextSignature,
  userTaskMessages,
  AUTO_TITLE_CONTEXT_PROBES_PER_TICK,
} = await import(join(WT, "v2/daemon/src/autoTitle.ts"));

const RICH_BODY = "Please refactor the payment reconciliation job to batch ledger writes";
const THIN_BODY = "hi";

function makeBee(i, { title = null } = {}) {
  return {
    id: `bee-${String(i).padStart(4, "0")}`,
    name: `bee-${i}`,
    lifecycle: "active",
    title,
    tags: [],
    createdAt: 1,
  };
}
const msg = (id, body) => ({ id, beeId: "x", sender: "operator", body, priority: 0, urgency: "next", enqueuedAt: 1, deliveredAt: null, deliveredGeneration: null });

/**
 * Build one scenario: `size` bees in `state`, run `ticks` scans at 1 Hz.
 * States: empty | thin | deferred | backoff | titled.
 * `tail` optionally appends one generate-ready rich bee at the END.
 */
function runScenario({ state, size, ticks, tail = false, resolveGeneration = true }) {
  let clock = 1_000_000;
  const bees = [];
  const mailboxes = new Map();
  const bookkeeping = new Map();
  for (let i = 0; i < size; i++) {
    const bee = makeBee(i, { title: state === "titled" ? "already titled" : null });
    bees.push(bee);
    const messages =
      state === "empty" || state === "titled" ? [] :
      state === "thin" ? [msg(i * 10 + 1, THIN_BODY)] :
      state === "deferred" ? [msg(i * 10 + 1, THIN_BODY)] :
      [msg(i * 10 + 1, RICH_BODY), msg(i * 10 + 2, `${RICH_BODY} with follow-up detail`)];
    mailboxes.set(bee.id, messages);
    const signature = contextSignature(bee, userTaskMessages(messages));
    if (state === "deferred") {
      bookkeeping.set(bee.id, { attempts: 0, lastAt: 0, userTurns: 1, deferred: true, signature });
    } else if (state === "backoff") {
      // Fresh failed attempt: retry backoff (15s * 2^(attempts-1)) far exceeds
      // the 1s scan interval, so every scan skips at the decision, AFTER the read.
      bookkeeping.set(bee.id, { attempts: 3, lastAt: clock, userTurns: 2, deferred: false, signature });
    }
  }
  if (tail) {
    const rich = makeBee(size, {});
    bees.push(rich);
    mailboxes.set(rich.id, [msg(90_001, RICH_BODY), msg(90_002, `${RICH_BODY} continued`)]);
  }

  const counts = { reads: 0, saves: 0, generates: 0, getBee: 0 };
  const readsPerTick = [];
  let pendingGeneration = null;
  const dispatcher = createAutoTitleDispatcher({
    enabled: () => true,
    naming: () => ({}),
    listBees: () => bees,
    listMessages: (beeId) => {
      counts.reads += 1;
      return mailboxes.get(beeId) ?? [];
    },
    getBee: (beeId) => {
      counts.getBee += 1;
      return bees.find((b) => b.id === beeId) ?? null;
    },
    setTitle: (beeId, title) => {
      const bee = bees.find((b) => b.id === beeId);
      if (bee) bee.title = title;
      return { applied: true };
    },
    loadState: (beeId) => bookkeeping.get(beeId),
    saveState: (beeId, next) => {
      counts.saves += 1;
      bookkeeping.set(beeId, next);
    },
    generate: () => {
      counts.generates += 1;
      if (resolveGeneration) return Promise.resolve("Generated Title");
      return new Promise((resolve) => {
        pendingGeneration = resolve;
      });
    },
    now: () => clock,
    log: () => undefined,
  });

  return (async () => {
    for (let t = 0; t < ticks; t++) {
      const before = counts.reads;
      await dispatcher();
      await Promise.resolve(); // let a resolved generation settle its slot
      readsPerTick.push(counts.reads - before);
      clock += 1_000; // AUTO_TITLE_SCAN_MS cadence
    }
    return { state, size, ticks, readsPerTick, counts, resolvePending: () => pendingGeneration?.("Late Title") };
  })();
}

const out = { probesPerTick: AUTO_TITLE_CONTEXT_PROBES_PER_TICK, scenarios: [] };
const record = (r, note) => {
  const { readsPerTick } = r;
  out.scenarios.push({
    state: r.state, size: r.size, ticks: r.ticks, note,
    readsPerTick: readsPerTick.length > 12 ? [...readsPerTick.slice(0, 6), "…", ...readsPerTick.slice(-3)] : readsPerTick,
    steadyReadsPerTick: readsPerTick.at(-1),
    totalReads: r.counts.reads, totalSaves: r.counts.saves, totalGenerates: r.counts.generates,
  });
};

// --- titled: the pre-skip works; zero reads ever. ---------------------------
for (const size of [1, 100, 1000]) {
  const r = await runScenario({ state: "titled", size, ticks: 5 });
  assert.equal(r.counts.reads, 0);
  record(r, "lifecycle/title pre-skip: no mailbox reads at all");
}

// --- deferred: every scan reads EVERY deferred bee; probes never consumed. --
for (const size of [1, 100, 1000]) {
  const r = await runScenario({ state: "deferred", size, ticks: 5 });
  assert.deepEqual(r.readsPerTick, Array(5).fill(size), "deferred bees are re-read on every scan");
  assert.equal(r.counts.saves, 0, "no probe, no bookkeeping write");
  assert.equal(r.counts.generates, 0);
  record(r, "deferred-signature continue is AFTER the read and BEFORE probes++");
}

// --- backoff: same shape — read first, skip at the decision, no probe. ------
for (const size of [1, 100, 1000]) {
  const r = await runScenario({ state: "backoff", size, ticks: 5 });
  assert.deepEqual(r.readsPerTick, Array(5).fill(size), "backoff bees are re-read on every scan");
  assert.equal(r.counts.saves, 0);
  record(r, "backoff skip is AFTER the read and consumes no probe");
}

// --- empty / thin: 8 new defers per scan; reads RAMP as the deferred set
// --- grows, then plateau at size reads per scan forever. --------------------
for (const state of ["empty", "thin"]) {
  for (const size of [1, 100, 1000]) {
    const ticks = Math.ceil(size / AUTO_TITLE_CONTEXT_PROBES_PER_TICK) + 3;
    const r = await runScenario({ state, size, ticks });
    const expectedTick1 = Math.min(size, AUTO_TITLE_CONTEXT_PROBES_PER_TICK + (size > AUTO_TITLE_CONTEXT_PROBES_PER_TICK ? 0 : 0));
    assert.equal(r.readsPerTick[0], expectedTick1, "tick 1 reads the first 8 (all defer) then breaks at the cap");
    assert.equal(r.readsPerTick.at(-1), size, "steady state re-reads the whole untitled set");
    assert.equal(r.counts.saves, size, "each bee defers exactly once");
    assert.equal(r.counts.generates, 0);
    record(r, "defer transitions are capped at 8/scan; reads ramp by 8/scan to the full set");
  }
}

// --- one generate-ready bee behind 1000 deferred: position cost + break. ----
{
  const r = await runScenario({ state: "deferred", size: 1000, ticks: 3, tail: true, resolveGeneration: false });
  assert.equal(r.readsPerTick[0], 1001, "the scan reads all 1000 deferred bees before reaching the rich one");
  assert.equal(r.counts.generates, 1, "generation launches for the rich bee");
  assert.equal(r.readsPerTick[1], 0, "while a generation is in flight the scan returns early: zero reads");
  assert.equal(r.readsPerTick[2], 0);
  record(r, "in-flight slot: early return, zero reads until resolve/watchdog (45s)");
  r.resolvePending();
}

// --- same rich bee FIRST in the roster: one read, then break. ---------------
{
  let clock = 2_000_000;
  const rich = makeBee(0);
  const deferredBees = [];
  const mailboxes = new Map([[rich.id, [msg(1, RICH_BODY), msg(2, `${RICH_BODY} more`)]]]);
  const bookkeeping = new Map();
  for (let i = 1; i <= 1000; i++) {
    const bee = makeBee(i);
    deferredBees.push(bee);
    const messages = [msg(i * 10, THIN_BODY)];
    mailboxes.set(bee.id, messages);
    bookkeeping.set(bee.id, {
      attempts: 0, lastAt: 0, userTurns: 1, deferred: true,
      signature: contextSignature(bee, userTaskMessages(messages)),
    });
  }
  let reads = 0;
  const dispatcher = createAutoTitleDispatcher({
    enabled: () => true,
    naming: () => ({}),
    listBees: () => [rich, ...deferredBees],
    listMessages: (beeId) => { reads += 1; return mailboxes.get(beeId) ?? []; },
    getBee: () => null,
    setTitle: () => ({ applied: true }),
    loadState: (beeId) => bookkeeping.get(beeId),
    saveState: (beeId, next) => bookkeeping.set(beeId, next),
    generate: () => new Promise(() => undefined),
    now: () => clock,
    log: () => undefined,
  });
  await dispatcher();
  assert.equal(reads, 1, "a generate launch BREAKS the loop: roster position decides scan cost");
  out.scenarios.push({ state: "deferred+rich-first", size: 1001, ticks: 1, readsPerTick: [1], steadyReadsPerTick: 1, totalReads: 1, totalSaves: 1, totalGenerates: 1, note: "generate at roster head: 1 read then break — order decides everything" });
}

writeFileSync("/tmp/honeybee-autotitle-scan-study.json", JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out.scenarios.map((s) => ({ state: s.state, size: s.size, steady: s.steadyReadsPerTick, total: s.totalReads, saves: s.totalSaves, gen: s.totalGenerates, note: s.note })), null, 1));
