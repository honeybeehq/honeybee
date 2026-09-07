/**
 * Sketch — quiet-tick snapshot reuse for DaemonCore (v2/daemon/src/loops.ts).
 *
 * MODULE MAP (entire change surface):
 *   v2/daemon/src/loops.ts          — everything below; no other production file changes
 *   v2/daemon/tests/loops.test.ts   — extend (gates 1–5 in correctness-gates.md)
 *   v2/daemon/tests/loops-cache.test.ts (new) — seq-coverage, rollback, shadow-equality
 *   v2/harness/src/daemon.ts        — SimDaemon passes verifySnapshotReuse: true (one line)
 *   NO changes: v2/core/* (store, schema, view, types), daemon.ts, drivers, RPC.
 *
 * Everything here is private to DaemonCore except the one optional test hook
 * on DaemonCoreOptions. Line references are baseline 343289fe.
 */

import type { BeeViewRow, MessageRow } from "../../core/src/index.ts";

// ---------------------------------------------------------------------------
// Data structures (replaces interface StepSnapshot, loops.ts:194)
// ---------------------------------------------------------------------------

/**
 * One committed-state read model, valid for exactly one audit seq. All fields
 * readonly: the object is shared across ticks and must never be mutated —
 * consumers copy (`filter`, spread) as they already do today.
 *
 * rows          — every retained bee, ALL lifecycles (archived rows keep their
 *                 live runtimes visible to policies), `bees ORDER BY id`.
 * pendingByBee  — per-bee FIFO of undelivered mail, insertion order
 *                 `ORDER BY bee_id, id` (store.ts:2368); includes bees whose
 *                 runtime is stopped or absent (I1 depends on them).
 * rowsById      — derived: bee id → its row (for pendingByBee-driven walks).
 * booting/idle  — derived: rows whose CURRENT runtime state matches, in rows
 *                 order, so subset walks emit commands/logs in exactly the
 *                 order the full-rows walk does today.
 *
 * Derivations are recomputed from rows on every rebuild, never patched
 * incrementally (derive-don't-sync; no second projection engine).
 */
interface StepSnapshot {
  readonly rows: readonly BeeViewRow[];
  readonly pendingByBee: ReadonlyMap<string, readonly MessageRow[]>;
  readonly rowsById: ReadonlyMap<string, BeeViewRow>;
  readonly booting: readonly BeeViewRow[];
  readonly idle: readonly BeeViewRow[];
}

/** The cache cell. `seq` is ALWAYS a committed lastAuditSeq() observed outside any transaction. */
interface CachedSnapshot {
  readonly snapshot: StepSnapshot;
  readonly seq: number;
}

// ---------------------------------------------------------------------------
// DaemonCoreOptions delta (loops.ts:170)
// ---------------------------------------------------------------------------

interface DaemonCoreOptionsDelta {
  /**
   * Harness-only equivalence check (mirrors `faults`): when true, every REUSED
   * acquisition also rebuilds fresh and deep-equals it against the cache;
   * inequality throws. SimDaemon sets it; production leaves it unset. This
   * turns every v2:harness / v2:harness:real run into a standing proof that
   * "seq unchanged ⇒ snapshot value-identical".
   */
  verifySnapshotReuse?: boolean;
}

// ---------------------------------------------------------------------------
// DaemonCore delta — fields and the acquisition seam
// ---------------------------------------------------------------------------

declare class DaemonCoreDelta {
  /** null until first acquisition and after boot(); never read mid-transaction. */
  private cached: CachedSnapshot | null;

  /**
   * THE single way step code obtains a snapshot; subsumes refreshSnapshot
   * (loops.ts:328) — delete that method. Called only from stepPhases at
   * points outside any open store transaction (observe()'s transact has
   * committed or rolled back before the first call; each executor command
   * tx commits before the post-command call). Sound because:
   *  - every committed mutation of bees/runtimes/flags/mailbox audits in the
   *    same tx (store.ts:8; audit-replay test) → seq equal ⇒ tables equal;
   *  - audit.seq is AUTOINCREMENT (schema.ts:482) and audit rows are never
   *    deleted → committed MAX(seq) strictly monotonic; a rollback reverts
   *    both data and seq together → reuse after rollback is value-correct;
   *  - the tick is synchronous on a single-threaded daemon → no interleaved
   *    writer between the probe and the reuse.
   */
  private currentSnapshot(): { snapshot: StepSnapshot; seq: number };
  // pseudocode:
  //   seq = store.lastAuditSeq()                       // one B-tree rightmost seek
  //   if (this.cached?.seq === seq) {
  //     if (verifySnapshotReuse) deepEqualOrThrow(this.cached.snapshot, this.buildSnapshot())
  //     return { snapshot: this.cached.snapshot, seq }
  //   }
  //   snapshot = this.buildSnapshot()                  // today's cost, only when truth moved
  //   this.cached = { snapshot, seq }
  //   return { snapshot, seq }

  /**
   * Today's stepSnapshot (loops.ts:339) + one derivation pass. Single loop
   * over rows fills rowsById/booting/idle; pendingByBee built exactly as
   * today. Cost on rebuild == today's per-tick cost + O(rows) map inserts.
   */
  private buildSnapshot(): StepSnapshot;
  // pseudocode:
  //   pendingByBee = group(store.listUndeliveredMessages())      // unchanged
  //   rows = store.listBeeViewRows()                             // unchanged, all lifecycles
  //   rowsById = new Map(); booting = []; idle = []
  //   for (row of rows) {                                        // rows order preserved
  //     rowsById.set(row.bee.id, row)
  //     if (row.runtime?.state === "booting") booting.push(row)
  //     else if (row.runtime?.state === "idle") idle.push(row)
  //   }
  //   return { rows, pendingByBee, rowsById, booting, idle }

  /** Cache must not survive a store (re)open/replay. Called first in boot(). */
  private invalidateSnapshot(): void; // this.cached = null
}

// ---------------------------------------------------------------------------
// stepPhases (loops.ts:276) — same phase order, same perf span labels
// ---------------------------------------------------------------------------
//
// private stepPhases(): void {
//   measure("core.step.observe",  () => this.observe());       // unchanged
//   measure("core.step.flags",    () => this.expireFlags());   // unchanged; expiry writes bump seq
//   let { snapshot } = measure("core.step.snapshot", () => this.currentSnapshot());
//   measure("core.step.policies", () => {
//     this.bootHangPolicy(snapshot);
//     this.scaleToZeroPolicy(snapshot);
//     this.degradedMailPolicy(snapshot);
//   });
//   measure("core.step.commands", () => this.executeCommands()); // any claim audits → next probe rebuilds
//   ({ snapshot } = measure("core.step.snapshot", () => this.currentSnapshot()));
//   measure("core.step.delivery", () => this.deliveryLoop(snapshot));
//   measure("core.step.tasks",    () => this.taskSupplyLoop());  // unchanged (own queries)
//   if (this.policy.i1DeadlineSteps != null && this.onI1Violation != null) {
//     ({ snapshot } = measure("core.step.snapshot", () => this.currentSnapshot()));
//     measure("core.step.i1", () => this.i1Telemetry(snapshot));
//   }
// }
//
// The three acquisition points are the SAME seams as today (loops.ts:280,289,297);
// only the miss/hit decision moved from "changed since tick start" to "changed
// since last build, whenever that was".

// ---------------------------------------------------------------------------
// Consumers — signature change only; bodies are today's minus leading guards
// ---------------------------------------------------------------------------

declare class ConsumerDelta {
  /**
   * loops.ts:655 — was (rows). Iterates snap.booting; body verbatim minus
   * `if (!rt || rt.state !== "booting") continue`. Time predicate
   * (now - rt.startedAt > bootHangTimeoutSteps) and pendingStopExists live
   * query unchanged — a hang STILL fires on a seq-quiet tick.
   */
  private bootHangPolicy(snap: StepSnapshot): void;

  /**
   * loops.ts:670 — was (rows, pendingByBee). Iterates snap.idle; body
   * verbatim minus the state guard. Idle-window predicate against now(),
   * pending-mail veto via snap.pendingByBee, pendingStopExists unchanged.
   */
  private scaleToZeroPolicy(snap: StepSnapshot): void;

  /**
   * loops.ts:690 — was (rows, pendingByBee). Iterates snap.pendingByBee
   * entries → snap.rowsById.get(beeId) (row always present: mailbox rows
   * FK-cascade with bees; rows spans all lifecycles). Body verbatim minus
   * the pending-length guard: LIVE check, ext.isDegraded, pendingStopExists
   * unchanged. Iteration order equals today's rows order (same TEXT key,
   * same BINARY collation — see rationale).
   */
  private degradedMailPolicy(snap: StepSnapshot): void;

  /**
   * loops.ts:895 — was (rows, pendingByBee). Same pendingByBee→rowsById walk.
   * Everything semantic is untouched: stopped/booting skip, synthetic-boot
   * `trulyMidTurn` gate, urgency eligibility filter, one-interrupt-per-message
   * via this.interruptRequested, FIFO eligible[0] pick, envelope rendering,
   * markDelivered (whose audit row forces the NEXT acquisition to rebuild).
   * A refused/interrupted delivery writes nothing → cache stays valid → the
   * retry next tick sees the identical pending truth, as today.
   */
  private deliveryLoop(snap: StepSnapshot): void;

  /**
   * loops.ts:960 — was (rows, pendingByBee). Same pendingByBee→rowsById walk;
   * flagged-bee skip now reads row.view.flags via the looked-up row. Position-
   * aware deadlines, idle-eligibility clock base (rt.updatedAt), reportedI1
   * dedup unchanged. Bees with pending mail and NO runtime or a STOPPED
   * runtime are visited because pendingByBee — not runtime state — drives the
   * walk (I1's stopped-bee guarantee).
   */
  private i1Telemetry(snap: StepSnapshot): void;
}

// ---------------------------------------------------------------------------
// Cost model (quiet tick, 1,000 retained stopped bees, no mail)
// ---------------------------------------------------------------------------
// today : listUndeliveredMessages + listBeeViewRows (3 scans, ~2,000 JSON.parse,
//         ~4,000 objects, 2 maps) + 5 × O(1000) walks  ≈ 22.8ms CPU, ~3.7MB alloc
// after : 3 × lastAuditSeq probes + walks over [] / empty maps ≈ well under 0.1ms, ~0 alloc
// rebuild tick (any committed write): today's cost + O(rows) subset pass — unchanged asymptote.
