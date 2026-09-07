# Correctness gates

Every gate names the invariant it defends and how to run it. Gates 1–2 are the
load-bearing ones; a failure in either kills the design, not the test.

## 1. Seq-is-a-complete-change-version (the cache's foundation)

- **Shadow equivalence across the whole invariant suite.** SimDaemon sets
  `verifySnapshotReuse: true`; every reused acquisition rebuilds fresh and
  deep-equals. Run `npm run v2:harness`, `v2:harness:long`, and
  `v2:harness:real` — thousands of virtual-clock steps with fault injection
  now standing-prove "seq unchanged ⇒ snapshot value-identical" against the
  production loop code. Any store write path that skips auditing a
  bees/runtimes/flags/mailbox mutation surfaces here as a deep-equal throw.
- **Direct coverage unit (new, loops-cache.test.ts):** for each public store
  API that mutates the four snapshot tables (send, cancel/expedite,
  markDelivered, setFlag/clearFlag/expireFlags, updateRuntimeState,
  recordBootEvidence, reviveBee, archive/unarchive/rename/tag/args, deleteBee,
  recordOutput, recordProviderSessionId, tryFeedTaskSupply), assert
  `lastAuditSeq()` strictly increases. Guards future write APIs via a
  test-13-style sweep, not a frozen list.

## 2. Rollback safety

- **New unit:** inside `store.transact`, perform audited writes, then throw.
  Assert: `lastAuditSeq()` equals its pre-transaction value AND a subsequent
  tick that reuses the cache produces byte-identical behavior (log capture) to
  a fresh DaemonCore on the same store. Covers the AUTOINCREMENT seq-reuse
  hazard: reuse-after-rollback is only correct because cache reads never see
  uncommitted state.
- **Executor crash replay (existing, extended):** ExecutorCrashError
  before/after effect (harness faults) — assert next tick rebuilds (claim's
  `command.claimed` audit row bumped seq) and replays per B5 exactly as at
  baseline.

## 3. Time-driven actions still fire on seq-quiet ticks (the crux the task names)

New units in loops.test.ts, each holding seq constant across many ticks
(no writes between steps) with a virtual clock:

- **Boot-hang:** runtime stuck `booting`, zero observations → stop enqueued on
  the first tick past `bootHangTimeoutSteps`, not before, exactly once.
- **Scale-to-zero:** idle runtime, empty mailbox → idle-window stop fires from
  a reused snapshot; variant with pending mail asserts the veto still holds.
- **Flag expiry:** flag with `resetsAt` in the past clears (expireFlags is a
  store call, unaffected); its audit row rebuilds the snapshot, so same-tick
  I1 sees the bee unflagged — assert the deadline clock resumes that tick.
- **I1 deadline for stopped/no-runtime bees:** stopped bee (and a bee with no
  runtime row) with pending mail crosses its position-aware deadline during a
  quiet stretch → exactly one violation recorded (reportedI1 dedup), with the
  `idle`-urgency clock base (`rt.updatedAt`) preserved.
- **Archived-but-live:** archived bee with a live idle runtime is still
  visited by scale-to-zero/delivery from a cached snapshot (rows span all
  lifecycles).

## 4. Behavioral identity of the subset walks

- **Log-sequence equality (new):** scripted busy scenario (mixed urgencies,
  interrupts, refused deliveries, degraded runtime, boot failure, revive)
  driven twice — DaemonCore at baseline vs. with cache — assert identical
  ordered log output and identical durable state dump. Catches iteration-order
  or dropped-row regressions (the pendingByBee/rowsById reformulation).
- **Existing suites:** `node --test v2/daemon/tests/loops.test.ts` (and the
  full `npm test`) must pass with unchanged expectations — FIFO/urgency,
  pending-command semantics, post-command refresh, observation-cursor
  transactionality are all asserted there today.

## 5. Lifecycle of the cache itself

- **boot() invalidation (new unit):** build cache, reopen/replace store
  contents (import-frozen fixture path), `boot()` → next tick must rebuild
  even if `MAX(seq)` coincides.
- **Mid-tick mutation visibility (existing seam):** command execution that
  changes runtime state → post-command acquisition rebuilds (claim audit
  guarantees seq moved) → deliveryLoop sees the new generation. Baseline
  loops tests already assert the observable outcome.

## 6. Performance acceptance (parent runs; design's success criteria)

- `core.quietStep.cpu` at core-1000x1: p50 from ~17.9ms to < 1ms (target ≥10×;
  expected ~100×+ for the mapping phases). Allocation profile: `listBees`/
  `mapBee`/`listBeeViewRows` bytes ≈ 0 on reuse ticks (vs 86.8MB/30 ticks).
- No regression: core-10x1 quiet step, busy-tick scenarios (every-tick-write
  workload must stay within noise of baseline — rebuild path is unchanged),
  `view.all`/`view.active` RPC metrics untouched (no store changes).
- Re-run the parent's capture tool on the same scenarios for comparability
  (same toolDigest lineage as evidence/quiet-before.json).

## 7. Repo-standard gates

- `npm run v2:test`, typecheck/lint/build per AGENTS.md ("typecheck, test, and
  build every change"), full `npm test` before any deploy consideration.
