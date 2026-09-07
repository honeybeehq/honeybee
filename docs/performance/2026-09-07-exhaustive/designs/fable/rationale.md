# Rationale — seq-validated cross-tick snapshot reuse

## Problem

Every 200ms tick (`tickMs`, daemon config.ts:256), `DaemonCore.stepPhases`
unconditionally materializes the whole read model: `stepSnapshot()`
(loops.ts:339) groups every undelivered message and maps every retained bee —
any lifecycle, `listBeeViewRows(null)` (store.ts:3017) — into fresh
`BeeRow`/`RuntimeRow`/`BeeView` object graphs (two `JSON.parse` per bee in
`mapBee`, store.ts:455/462). Five consumers then walk all rows: boot-hang,
scale-to-zero, degraded-mail, delivery, I1 telemetry. On a quiet 1,000-bee hive
this is ~94% of tick CPU and ~3.7MB/tick of allocation for work whose output is
identical tick after tick. The shape constraints: (1) the policies are
**time-dependent** — a tick with zero store changes can still cross a boot-hang
timeout, idle window, flag `resetsAt`, or I1 deadline, so "nothing changed →
skip the walks" is wrong; the walks must run, only the *materialization* is
redundant. (2) I1 needs bees with pending mail even when their runtime is
stopped or absent, and archived bees can have live runtimes, so no
lifecycle/state prefilter may drop rows the consumers read today. (3) The store
already publishes a change version: every committed mutation appends audit rows
in the same transaction (store.ts:8, enforced by the audit-replay test), and
`refreshSnapshot` (loops.ts:328) already relies on `lastAuditSeq()` equality
within a tick. (4) A cache must be rollback-safe: audit seq is
`INTEGER PRIMARY KEY AUTOINCREMENT` (schema.ts:482) — monotonic across
*commits*, but a rolled-back transaction's seqs can be reused by a later commit,
so a cached seq recorded from uncommitted state would be poison.

## Usage (caller's view)

The "caller" is `stepPhases` itself plus the harness; no API outside
`DaemonCore` changes. The whole tick reads as: acquire a validated snapshot
wherever truth may have moved, walk only actionable subsets.

```ts
private stepPhases(): void {
  this.observe();                                  // unchanged (tx; may write)
  this.expireFlags();                              // unchanged (may write → seq bump)
  let { snapshot } = this.currentSnapshot();       // reuse if lastAuditSeq() == cachedSeq
  this.bootHangPolicy(snapshot);                   // walks snapshot.booting (usually [])
  this.scaleToZeroPolicy(snapshot);                // walks snapshot.idle (usually [])
  this.degradedMailPolicy(snapshot);               // walks snapshot.pendingByBee (usually {})
  this.executeCommands();                          // unchanged; any claim audits → seq bump
  ({ snapshot } = this.currentSnapshot());         // post-command refresh, same seam as today
  this.deliveryLoop(snapshot);                     // walks pendingByBee → rowsById
  this.taskSupplyLoop();                           // unchanged (own queries, out of scope)
  if (i1 enabled) {
    ({ snapshot } = this.currentSnapshot());
    this.i1Telemetry(snapshot);                    // walks pendingByBee → rowsById
  }
}
```

Second call site — `boot()` (loops.ts:231) invalidates, so a replayed/replaced
store never meets a stale cache:

```ts
boot(): BootReport {
  this.invalidateSnapshot();   // cache never survives a store (re)open
  ...existing body unchanged...
}
```

Third call site — the harness proves equivalence on every sim run
(SimDaemon passes it; production leaves it unset):

```ts
new DaemonCore({ ..., verifySnapshotReuse: true })  // reused tick ⇒ rebuild fresh + deep-equal, throw on drift
```

## Shape

Data structure first: `StepSnapshot` (loops.ts:194) grows three **derived**
readonly fields, built in the same single pass as today's construction and
cached across ticks with the seq that validated it.

```ts
interface StepSnapshot {
  readonly rows: readonly BeeViewRow[];                          // as today (all lifecycles)
  readonly pendingByBee: ReadonlyMap<string, readonly MessageRow[]>;  // as today (per-bee FIFO)
  readonly rowsById: ReadonlyMap<string, BeeViewRow>;            // derived
  readonly booting: readonly BeeViewRow[];                       // derived, rows order
  readonly idle: readonly BeeViewRow[];                          // derived, rows order
}
// cache: { snapshot: StepSnapshot; seq: number } | null, private to DaemonCore
```

`currentSnapshot()` is the single acquisition seam (it subsumes
`refreshSnapshot`): probe `lastAuditSeq()` (a B-tree rightmost seek,
store.ts:4218); if equal to the cached seq, return the cached snapshot, else
rebuild and re-cache. Consumers stop iterating `rows` and instead walk the
subset that already encodes their guard: boot-hang over `booting`,
scale-to-zero over `idle`, and the three mail-driven loops over
`pendingByBee` keys resolved through `rowsById`. Each loop body is verbatim
today's body minus its leading `continue` guards — eligibility, urgency/FIFO,
synthetic-boot gating, interrupt dedup, and `pendingStopExists` live queries
are untouched.

Why this is behavior-identical, not just plausible: (a) *value equality* — seq
unchanged ⇒ zero committed writes anywhere (every committed mutation audits,
store contract; audit is append-only, no `DELETE FROM audit` exists; committed
`MAX(seq)` is strictly monotonic under AUTOINCREMENT), so a rebuild would
produce value-identical rows; (b) *rollback safety* — the cache is only read
and written at `stepPhases` points that sit outside any open transaction, the
tick is fully synchronous (single-threaded daemon, daemon.ts:684 comment), and
a rolled-back transaction leaves both the committed tables and the committed
`MAX(seq)` exactly as cached, so reuse is correct by construction; the
reused-seq-with-different-data hazard requires reading uncommitted state, which
this shape structurally never does; (c) *order equality* — `rows` comes from
`bees ORDER BY id` (store.ts:1484) and `pendingByBee` insertion order from
`ORDER BY bee_id, id` (store.ts:2368): the same TEXT key under the same BINARY
collation, so subset walks visit bees in the same sequence and emitted
commands/log lines are byte-identical.

Invariants encoded in types per encode-lessons-in-structure: every snapshot
field is `readonly`/`ReadonlyMap`, making cross-tick sharing safe at compile
time. Validation lives at the one seam (`currentSnapshot`), per
boundary-discipline; single source of truth per invariant — the subsets are
*derived* from `rows` at build, never maintained incrementally, per
derive-don't-sync. Interface depth: the public surface grows by **zero**
methods (one optional `DaemonCoreOptions.verifySnapshotReuse` test hook,
mirroring `faults`); all complexity — revalidation, rollback reasoning, subset
derivation — hides behind two private methods in the one file that already
owns the tick. The design deliberately does **not**: change any store/schema
surface, filter audit kinds (over-invalidation is accepted), maintain the cache
incrementally, or serve any consumer outside `stepPhases` (daemon.ts RPC/list
paths keep their own fresh reads).

## Synthesis decision

*Left to the arena orchestrator; this is one candidate.*

## Tradeoffs accepted

- We accept **over-invalidation** (any audited write anywhere — seals, tasks,
  accounts — rebuilds the roster) in exchange for a one-probe validity check
  with no coupling to the audit-kind vocabulary. Busy ticks then cost exactly
  today's every-tick cost; quiet ticks cost ~nothing. A kind-filtered
  invalidation was rejected as a fragile second vocabulary.
- We accept **retaining ~1–2MB** (1,000-bee row graph) across ticks in exchange
  for eliminating ~3.7MB/tick of churn; steady-state RSS is a wash, GC pressure
  strictly drops.
- We accept **extending reliance on the audit-seq change-version contract**
  from within-tick (already load-bearing at loops.ts:325) to across-tick, in
  exchange for not inventing a second change signal; the contract is already
  enforced by the audit-replay test and additionally gated below.
- We accept that the **first tick after any change pays a full rebuild**
  (~18ms at 1,000 bees) — same as every tick today; smoothing it (incremental
  maintenance) is complexity the quiet-tick target does not need.

## Alternatives considered

- **Fresh targeted queries per consumer (no cache).** Replace the monolithic
  snapshot with narrow per-policy SQL: booting/idle latest-generation rows,
  bees-with-undelivered-mail joined to live runtimes, flags per pending bee.
  Wins: no cross-tick state, no staleness argument, O(actionable) on busy ticks
  too, time predicates pushable into SQL. Loses: the store's public surface
  grows 4–6 policy-shaped read APIs (daemon eligibility vocabulary leaks into
  the store — information leakage); "latest generation, state=X" has no index,
  so it either scans all runtime rows (200k at 100×200-generation histories —
  worse than today) or needs a new partial index + migration riding the
  single-live-runtime invariant (reviveBee, store.ts:2042); eligibility logic
  splits across SQL and JS, the exact N+1-shape regression the one-snapshot
  refactor (loops.ts:334) was built to kill; and quiet ticks still pay ~5
  statement executions vs one MAX probe. Interface depth decides it: same
  quiet-tick asymptote, strictly larger public surface and diff. **Rejected.**
- **Incremental cache maintained from audit deltas.** Apply audit rows since
  cached seq as row-level patches. Rejected: rebuilds audit.ts replay logic
  inside the daemon — a second projection engine and a de-facto competing
  state authority; zero benefit on quiet ticks (no deltas), and busy-tick
  rebuild is already acceptable.
- **Store-owned validated snapshot (`store.listBeeViewRowsIfChanged(seq)`).**
  Same idea, seam moved into core. Rejected: adds public core API for exactly
  one caller and ties cache lifetime to the wrong layer (the store outlives
  and predates tick semantics); DaemonCore already owns the seq-compare
  pattern. Falls back to this only if other daemon consumers later want the
  cache.

## Open questions and risks

- Is the `verifySnapshotReuse` hook wanted as a `DaemonCoreOptions` flag wired
  into SimDaemon permanently (every harness run shadow-verifies, my
  recommendation), or as a temporary migration check to delete later?
- Is retaining the ~1–2MB roster graph in daemon RSS acceptable on the
  smallest deployment targets, or should the cache drop `rows` above some
  roster size? (I recommend no cap; the daemon allocates the same graph 5×/s
  today.)
- The remaining quiet-tick floor after this change is three write-transactions
  per tick that mostly do nothing (`observe`'s unconditional `transact`,
  loops.ts:313; `expireFlags`, store.ts:2273; `claimNextCommand`,
  store.ts:2783) plus `taskSupplyLoop`'s per-tick scan. All out of the stated
  scope — flag for the parent inventory rather than widening this design?
- `boot()`-reset covers store replacement across daemon restarts; the design
  assumes no path swaps the store file under a running DaemonCore without
  `boot()`. I found none at baseline — worth one confirming glance at deploy
  paths during implementation.

## Next implementation step

In loops.ts, add the cache fields and `currentSnapshot()`/`buildSnapshot()`
(subsuming `refreshSnapshot`), leaving every policy iterating full `rows` —
land that as a no-behavior-change commit proven by the shadow-verify harness
run, then switch the five consumers to the derived subsets.
