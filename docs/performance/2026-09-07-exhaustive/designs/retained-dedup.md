# Z01 — pruning reportedI1 / interruptRequested (revision 2, sparse source)

Design only; no production edits. Grounded on the frozen sparse tip
(quiet-work `824485f9`: "share same-step pending metadata" over
"project sparse daemon work" and "read linear I1 metadata"):

- `StepSnapshot = DaemonStepInputs | { work: DaemonWorkRow[]; i1: null }`
  (loops.ts:195). `DaemonWorkRow = { runtime: DaemonLiveRuntime, pending:
  DaemonPendingMessageMeta[] }` (store.ts:226) — **live-runtime-scoped**:
  with I1 disabled the snapshot omits stopped/absent-target mail entirely,
  so it cannot prove those ids absent. `I1PendingBee` (store.ts:237) is the
  complete pending universe (stopped and absent runtimes included),
  metadata only — no bodies.
- Set sites unchanged at this tip: `reportedI1` decl :214, gains only in
  the I1 phase (:1003–1004) ⇒ provably empty when I1 is disabled;
  `interruptRequested` decl :889, gains :933, removed only on delivered
  :965.
- Measured leak (parent, c027f347, mini): 30 cohorts × 1000 overdue,
  count-callback I1, deleteBee per cohort, fresh core.step → `reportedI1`
  0→30,000 with zero committed pending; post-GC heap 11.068→12.157 MB
  (heap observation, not exact Set bytes).

## Terminality semantics (unchanged by the sparse rewrite)

Delivered (`delivered_at` set — never unsets), canceled (row deleted;
≥2 call sites incl. the task-carrier cancel), and bee-deleted (cascade)
are terminal: those ids can never again be interrupt-eligible or overdue.
Pending ids must be retained across revive (no second interrupt within a
daemon lifetime) and expedite. Duplicates are the documented restart
analog and the recorder dedups durably — tolerable rarely, wrong if
systematic.

## The rollback hazard (governs both units)

`core.step()` runs inside public `store.transact` in practice (unit.0c).
Same-connection reads see uncommitted delivery/cancel/delete; pruning on
that evidence then rolling back loses dedup state while messages return to
committed-pending — duplicate interrupts and I1 callbacks follow. All
pruning below is therefore gated on a narrow read-only seam:
`CoreStore.get inTransaction(): boolean` (txDepth > 0; store.ts:1156 is
private today). Under an open transaction, pruning is skipped entirely —
the sets merely stay large for that tick.

## Unit 1 (recommended first): committed global zero-pending clear

At the end of `stepPhases`, unconditionally (covers the I1-disabled path):

```
private pruneDeliveryDedup(): void {
  if (this.reportedI1.size === 0 && this.interruptRequested.size === 0) return;
  if (this.store.inTransaction) return;          // committed-only
  if (this.store.hasUndeliveredMessages()) return; // one indexed LIMIT-1 probe
  this.reportedI1.clear();
  this.interruptRequested.clear();
}
```

Second one-line seam: `CoreStore.hasUndeliveredMessages(): boolean` —
`SELECT 1 FROM mailbox WHERE delivered_at IS NULL LIMIT 1` on the existing
`mailbox_undelivered` partial index (it is the mail half of
`hasStepSnapshotInputs`, exposed alone). The mail-only probe matters:
keying off the full guard or off `work.length === 0` would be wrong two
ways — a hive with a live runtime and zero pending would never clear
(guard true via the runtime probe), and `work: []` coexists with pending
mail on stopped targets, so it proves nothing.

Properties: no hydration at all (one existence probe, ids untouched,
bodies untouched); no snapshot dependence, so the `{work, i1}` shape and
the I1-disabled omission are irrelevant to correctness; rollback-safe by
the `inTransaction` gate; O(1) per tick while sets are nonempty, zero
(two size checks) after the clear. It fully covers the measured cohort
shape — the first committed zero-pending tick clears both sets even while
live runtimes exist — and the I1-disabled interrupted/canceled-id
requirement, since zero-pending terminalizes every held id. What it does
not cover: hives whose pending count never reaches zero (standing
backlog); their canceled/delivered stragglers wait for unit 2.

Expected cost is one indexed probe per tick only while sets are nonempty;
whether that is invisible is for the rulers to say — acceptance is
measured (below), not asserted.

## Unit 2 (separate, later): bounded nonempty retain-sweep

Retain exactly the ids still committed-pending; remove the rest.

- **Basis, I1 enabled:** the tick's `snapshot.i1` (`I1PendingBee[]`) —
  the complete pending-id universe including stopped/absent targets,
  metadata already materialized this tick, no new read, no bodies.
- **Basis, I1 disabled:** the snapshot is insufficient by design (work
  omits stopped-target mail). Probe membership for the SET's ids only —
  `SELECT id FROM mailbox WHERE delivered_at IS NULL AND id IN (…)` in
  bounded chunks (primary-key lookups, ids only): work scales with set
  size, never with total pending, satisfying "no hydrating all pending."
  (`readI1PendingSnapshot()` is the fallback basis if measurement shows
  the IN-probe worse at real set sizes; decide from numbers.)
- **Trigger (bounded — fixes the revision-1 flaw):** a plain
  `size ≥ N OR cadence` re-fires every tick once a legitimate backlog
  exceeds N. Instead: sweep when `ticksSinceLastSweep ≥ 256` OR
  `max(set.size − sizeAtLastSweep) ≥ 1024`, and reset BOTH counters after
  every sweep regardless of outcome. Growth-since-last-sweep cannot
  re-fire on a stable retained backlog, so worst-case cost is one
  O(basis + setSize) pass per 256 ticks plus O(1) checks per tick, even
  with a permanent 10k-message backlog.
- Committed-only gate identical to unit 1.

## Rejected alternatives (unchanged from revision 1, re-checked against sparse source)

- Event-driven terminal notifications: fragile coverage (multiple cancel
  sites, executor deletes, future paths), RPC→core wiring, and the same
  transaction gate needed anyway.
- Age-based eviction: terminality from time/silence contradicts the
  contract and re-interrupts a revived generation within one lifetime.
- Durable NOT-EXISTS dedup: per-overdue-per-tick query cost on busy ticks;
  no durable table in the harness.

## Tests and metrics

Unit 1:
1. **Rollback:** inside `store.transact`, deliver/cancel tracked messages
   and run `core.step()`; roll back; assert both sets intact (test-only
   size accessor — id autoincrement makes the leak otherwise invisible)
   and subsequent ticks add zero `driver.interrupts` and zero duplicate
   violation callbacks.
2. **Cohort regression (the measured shape):** cohorts → violations →
   deleteBee → fresh steps; both sets reach 0 on the first committed
   zero-pending tick; callback count stays exactly 1000/cohort.
3. **Live-runtime clear:** one idle live bee retained, zero pending —
   clear still fires (validates the mail-only probe over the full guard).
4. **I1-disabled:** interrupted `now` message canceled, then zero-pending
   tick → `interruptRequested` cleared with no I1 configured;
   `reportedI1` asserted permanently empty.
5. **Held no-clear:** standing held mail → probe true every tick, sets
   untouched, no per-tick growth in work done (assert probe count via a
   counting store stub if worthwhile).
6. **CPU acceptance (measured, not claimed):** quiet-tick v3 (parked and
   `--live/--pending` held) and paired-step scenarios before/after within
   the distinct-checkout A/A envelope; plus a mini re-run of
   `/tmp/honeybee-retained-i1.mjs` — expected shape: reportedI1 returns to
   0 per cohort and post-GC heap flat across cohorts rather than +1.09 MB
   (exact numbers to come from the run, not this doc).

Unit 2 adds: growth-trigger bound test (permanent >1024 backlog → sweep
frequency ≤ cadence), retain-across-revive, and the I1-disabled IN-probe
membership path.

## Non-goals

No cross-tick snapshots or caches, no event wiring, no durable dedup
table, no change to eligibility/FIFO/urgency/revive/violation semantics,
no schema change. Unit 1 is ~8 lines in loops.ts plus two one-line
read-only store seams.
