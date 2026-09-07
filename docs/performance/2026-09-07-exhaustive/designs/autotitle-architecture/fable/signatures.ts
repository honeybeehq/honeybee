/**
 * Candidate design sketch: committed membership-stamp gate for autoTitle
 * mailbox reads. Types and signatures only — bodies are `not implemented`
 * pseudocode. Baseline 604bf404.
 *
 * Shape summary: core gains ONE read-only derived fact (a mailbox
 * membership stamp); the daemon dispatcher gains a private gate that skips
 * the full mailbox read exactly when the full path would have continued
 * silently anyway (unchanged-defer quietness, active backoff). Every other
 * path — including every path that can generate, defer anew, save
 * bookkeeping, or consume a probe — still performs the full read, so
 * decisions, launch context, bookkeeping writes, retry resets, fairness,
 * slot/watchdog behavior, and detection latency are byte-identical.
 */

// ---------------------------------------------------------------------------
// v2/core/src/types.ts — one new exported type
// ---------------------------------------------------------------------------

/**
 * Opaque committed-membership stamp for one bee's mailbox. Equal stamps ⇒
 * identical committed mailbox row-id multiset (and, because bodies and ids
 * are immutable after insert, byte-identical message contents). Compare
 * with ===; never parse. Derived purely from durable rows — the store keeps
 * NO state for it, so restart, reopen, deleteBee cascade, and bee
 * re-creation need no invalidation machinery at all.
 */
export type MailboxMembershipStamp = string & { readonly __mailboxMembershipStamp: unique symbol };

// ---------------------------------------------------------------------------
// v2/core/src/store.ts — one new read-only method on CoreStore
// ---------------------------------------------------------------------------

export interface CoreStoreMembershipStampSlice {
  /**
   * Committed membership stamp for a bee's mailbox, or null while a
   * transaction is open on this connection (`this.txDepth > 0`, the same
   * seam as `inTransaction`, store.ts:3413). Null is load-bearing: a stamp
   * observed inside a transaction could describe speculative rows whose
   * AUTOINCREMENT ids are released on rollback and reused with different
   * bodies (the parent's uncommitted counterexample), so speculative
   * stamps are never published — callers must fall back to a full read.
   *
   * Implementation: two stmt()-cached single-row aggregates, one per
   * mailbox partial index (the C10 arms), concatenated into the stamp:
   *
   *   SELECT COUNT(*) AS c, MAX(id) AS m FROM mailbox
   *    WHERE bee_id = ? AND delivered_at IS NULL
   *   SELECT COUNT(*) AS c, MAX(id) AS m FROM mailbox
   *    WHERE bee_id = ? AND delivered_at IS NOT NULL
   *
   * Plans: SEARCH mailbox USING COVERING INDEX mailbox_pending_metadata
   * (bee_id=?) and SEARCH mailbox USING INDEX mailbox_delivered_by_bee
   * (bee_id=?). Cost is O(that bee's index entries) — body-free entry
   * scans, NOT O(1); at 100k delivered rows this is the ~hundreds-of-µs
   * class, roughly three orders under the ~130 ms full-body read it
   * replaces, and it must be measured, not assumed.
   *
   * Soundness (proven in the c1c2 fidelity study, §4, and required here as
   * a maintenance invariant): bodies and ids are immutable (the only
   * mailbox writes are send INSERT :2651, pending-cancel DELETE :2928,
   * urgency :2950 and delivery stamps :2985 — the last two change neither
   * membership nor signature inputs); committed AUTOINCREMENT ids are
   * never reused; therefore equal (count,max) per partition at two
   * COMMITTED observation points ⇒ identical rows. deleteBee's FK cascade
   * only removes rows — the stamp of a deleted-then-recreated bee matches
   * a baseline only when both mailboxes are empty, which is also content
   * equality, so re-creation is safe with no special case.
   */
  mailboxMembershipStamp(beeId: string): MailboxMembershipStamp | null;
  // not implemented — body is the two cached aggregates + template join
}

// ---------------------------------------------------------------------------
// v2/daemon/src/autoTitle.ts — deps extension and private gate
// ---------------------------------------------------------------------------

import type { AutoTitleBookkeeping } from "./autoTitle-existing.ts"; // illustrative import

export type AutoTitleDepsAddition = {
  /**
   * OPTIONAL committed membership stamp for one bee, or null when the
   * store cannot answer committed-only (in-transaction). Absent dep ⇒ the
   * gate is inert and every scan behaves exactly as today — existing
   * custom-deps constructors and tests keep their semantics unchanged.
   * Wired by createStoreAutoTitleDispatcher as
   * `(beeId) => store.mailboxMembershipStamp(beeId)` — one line, no
   * pass-through layer.
   */
  mailboxStamp?: (beeId: string) => MailboxMembershipStamp | null;
};

/**
 * Per-bee record of the last FULL read this dispatcher performed. Keyed by
 * bee id, values are two strings — O(untitled-active roster) entries,
 * pruned every scan (see prune below), never persisted, dies with the
 * dispatcher (restart ⇒ one full-read warm-up pass, which is the status
 * quo cost).
 */
interface ScanBaseline {
  /** Stamp captured in the same synchronous walk step as the full read. */
  stamp: MailboxMembershipStamp;
  /**
   * The signature computed BY that read — the same string the dispatcher
   * compared against bookkeeping.signature at :148. Tying the baseline to
   * the signature (not just the stamp) makes external sidecar rewrites,
   * restores, or bookkeeping loss force a full read.
   */
  signature: string;
}

/** Result of the gate for one bee in one scan. */
type GateOutcome =
  | { kind: "read" } // fall through to today's listMessages path, then record()
  | { kind: "skip-deferred" } // continue; identical to the :148 quiet continue
  | { kind: "skip-backoff" }; // continue; identical to the decision's backoff skip

export interface ReadGate {
  /**
   * Decide without reading. Returns a skip ONLY when the full path's
   * outcome is fully determined by (unchanged committed mailbox content,
   * existing bookkeeping, now):
   *
   *   read  — when any of: dep absent; stamp null (in-transaction);
   *           no baseline; stamp !== baseline.stamp;
   *           bookkeeping missing; bookkeeping.signature !== baseline.signature;
   *           bookkeeping.deferred === false AND backoff expired
   *           (now - lastAt >= autoTitleRetryBackoffMs(attempts) — the
   *           full path would GENERATE and needs messages for
   *           userMessages/initialTask, so the gate must not decide).
   *   skip-deferred — stamp unchanged ∧ signature tied ∧ deferred:true.
   *           Full path: recompute identical signature → :148 continue.
   *   skip-backoff  — stamp unchanged ∧ signature tied ∧ deferred:false ∧
   *           now - lastAt < autoTitleRetryBackoffMs(attempts).
   *           Full path: identical signature → currentBookkeeping valid →
   *           decision "skip backoff" → continue.
   *
   * Both skips consume no probe, write no bookkeeping, and emit nothing —
   * exactly like the paths they replace. The gate runs AFTER the existing
   * lifecycle/title pre-skip (:143) on the same fresh bee row, so mutable
   * caller-provided rows change nothing relative to today.
   */
  evaluate(beeId: string, bookkeeping: AutoTitleBookkeeping | undefined, now: number): GateOutcome;
  // not implemented — pure function of (baseline map, dep, args); no I/O beyond the stamp dep

  /**
   * Record after EVERY full read in the walk, whatever the decision was
   * (defer, skip, generate, claim): capture the stamp in the same
   * synchronous step (single-threaded scan, no awaits — no committed write
   * can interleave between read and stamp) plus the signature that read
   * produced. A null stamp records nothing (never bind a baseline to
   * speculative state).
   */
  record(beeId: string, signature: string): void;
  // not implemented

  /**
   * Prune at the end of each scan: drop every baseline whose bee was not
   * visited by this walk (titled since, archived, deleted, or gone from
   * the roster). Bounds the map at O(active untitled bees) with no
   * tombstones and no growth with total history; the bound is asserted in
   * tests and the map size is exposed to the perf span for measurement.
   */
  pruneToVisited(visited: ReadonlySet<string>): void;
  // not implemented
}

// ---------------------------------------------------------------------------
// Dispatcher loop integration (pseudocode; ~15 lines in the real body)
// ---------------------------------------------------------------------------

/**
 * for (const candidate of records) {
 *   if (probes >= AUTO_TITLE_CONTEXT_PROBES_PER_TICK) break;
 *   const bee = freshRows ? candidate : (deps.getBee(candidate.id) ?? candidate);
 *   if (bee.lifecycle !== "active" || bee.title) continue;      // unchanged (:143)
 *   visited.add(bee.id);
 *   const outcome = gate.evaluate(bee.id, deps.loadState(bee.id), now); // NEW
 *   if (outcome.kind !== "read") continue;                      // NEW: the two proven-silent paths
 *   const messages = deps.listMessages(bee.id);                 // unchanged from here down
 *   ...existing signature/deferred/decision/probe/defer/generate logic...
 *   gate.record(bee.id, signature);                             // NEW: after the read, any branch
 * }
 * gate.pruneToVisited(visited);                                 // NEW: scan epilogue
 *
 * Untouched by construction: 8-probe accounting, single slot, one launch
 * per scan + break, roster order, in-flight early return, 45 s watchdog,
 * retry reset on changed context (a changed stamp forces the read, and the
 * read performs the reset exactly as today), sidecar format.
 */
export const DISPATCHER_INTEGRATION_PSEUDOCODE: unique symbol = Symbol("see block comment");
