# Production review — perf(core): skip empty daemon snapshots

Commit `bcd85a8c` vs baseline `343289fe` in honeybee-perf-quiet-work-2026-09-07.
Independent static review; no builds/tests/captures run (parent's reported
results: core 182/182, loops, daemon unit 154/154 + serial 164/164, both
typechecks + build green; pre-existing HIVE_PARENT env leak failure retained
as unrelated — consistent with my read of the diff, not re-verified by me).

## Verdict

**No blockers. Approve.** The 16 production lines are the right conservative
first cut: a partial index `runtimes_daemon_live (bee_id, generation) WHERE
state != 'stopped'`, a two-probe `CoreStore.hasStepSnapshotInputs()`, and an
empty-snapshot short-circuit at the top of `DaemonCore.stepSnapshot()`
(loops.ts:339–341). Because the guard sits inside `stepSnapshot`, all three
acquisition points (initial, post-command, pre-I1) re-evaluate it, so the
existing audit-seq refresh machinery carries every mid-tick transition.

## Correctness argument (checked exhaustively)

**The predicate is complete for all five snapshot consumers.** Empty snapshot
is returned only when no non-stopped runtime exists AND no undelivered mail
exists. Under exactly that condition: boot-hang (needs `booting`),
scale-to-zero (needs `idle`), degraded-mail and delivery (need live runtime +
pending), and I1 (needs pending mail, any runtime state including none) are
all provably no-ops over the full snapshot too. Nothing else reads
`snapshot.rows`/`pendingByBee`. Flags alone, stopped bees, archived metadata,
queued commands, and tasks correctly do not trip the predicate — commands and
task supply run outside the snapshot, and their writes (every claim/send
audits) bump the seq so the next acquisition re-probes. No false negatives.

**Same-tick empty→work transitions** (the risk area): revive mid-tick mints a
booting generation — claim audit bumps seq — post-command acquisition
re-probes true and materializes (pinned by unit.0b with read counters);
task-supply feeding creates mail after delivery — the pre-I1 acquisition
materializes and I1 counts it (pinned by the tightened unit.0e, which now
starts from a stopped/no-mail bee so the *initial* acquisition provably takes
the empty path — `viewReads`/`mailboxReads` stay 0 until the final
acquisition, and the fed message's violation is asserted exactly).

**Rollback:** the guard holds no cross-tick state — every acquisition
re-probes committed state — so the AUTOINCREMENT seq-reuse hazard cannot bite
it. unit.0c goes further and *demonstrates* the hazard with an executed
rollback and seq reuse — the same evidence on which the cross-judge rejected
the cross-tick audit-seq cache direction. The test stands as the permanent
regression trap documenting why snapshot reuse must not key on audit seq.

**Conservative degradation:** the any-generation probe deliberately doesn't
assume the single-live-runtime invariant; a corrupted old-generation live row
yields a false positive (slow path), never a miss — pinned by the dedicated
core test.

## Rollout / index install (checked)

- `CREATE INDEX IF NOT EXISTS` rides SCHEMA_SQL on every open; references only
  v1-era columns, so it installs safely on any store generation before the
  ALTER migrations run. No schema_version bump — the core test asserts the
  stamp is unchanged, matching paired-step's schema-format equality policy.
- **Downgrade-safe:** SQLite maintains the index at the engine level, so an
  older daemon after `hive deploy --rollback` keeps it consistent for free and
  never drops it; re-upgrade is an IF-NOT-EXISTS no-op.
- Both probes are pinned to their partial indexes by EXPLAIN QUERY PLAN
  asserts (`runtimes_daemon_live`, `mailbox_undelivered`) — my main planner
  concern, resolved in-test rather than by assumption.
- One-time index build on first open of a large existing store (up to ~200k
  runtime rows at the benchmark extreme) lands at deploy boot; paired-step's
  firstOpen exists to quantify exactly this. Steady-state maintenance is
  O(log live rows) B-tree work per stopped-boundary transition (rows enter or
  leave the partial index only on those edges; other runtime updates leave
  membership and key untouched).

## Test review

New coverage is unusually strong and adversarial: unit.0a proves the empty
path via throwing stubs on the full-read APIs while flag expiry still runs
ahead of the snapshot and empty containers are fresh per tick; unit.0d proves
I1 for stopped-runtime and surgically-absent-runtime mail; the
time-boundaries unit pins strict `>` semantics at equality for boot-hang
(on an **archived** bee — archived-but-live covered), idle-stop, and I1; the
core file walks every runtime state, 20-generation stopped history,
delivered-only mail, cancel, and asserts the probe itself is read-only
(audit seq unchanged). unit.0e's clock-advancing feed wrapper is a neat way
to force a same-tick deadline crossing without breaking determinism.

## Nonblockers

1. **Scope expectation:** one live runtime or one held message anywhere voids
   the win — the full roster materialization returns (sparse-live scenario).
   Real hives usually have ≥1 live bee, so this guard mostly helps
   fully-parked/scale-to-zero hives — the benchmark case. Fine as the stated
   "first conservative guard." The cross-tick audit-seq snapshot cache was
   rejected by the GPT-6 cross-judge on executed rollback/seq-reuse evidence
   (unit.0c's demonstrated hazard) and remains rejected; the accepted next
   direction is a fresh sparse-live projection plus linear pending metadata —
   per-tick queries scoped to live runtimes and pending mail, no retained
   read-model state.
2. **Busy-tick probe cost:** two extra indexed probes per acquisition (≤6 per
   tick) on top of full reads — negligible; paired-step's all-live and
   write-every-tick scenarios measure it empirically.
3. **Plan-shift surface:** the new index can become usable for other
   `state`-filtering queries (reconcileAtBoot, claimNextCommand's EXISTS) if
   the planner proves the implication — expected neutral-to-positive since
   the index is small and exact-seek; no action, just aware.
4. **Naming altitude:** `hasStepSnapshotInputs` bakes a daemon concept into
   store vocabulary; a purpose-neutral name (e.g. live-runtime-or-pending-mail)
   would keep B8 daemon-agnostic. Not worth churn now.
5. Line 340's early return allocates two small objects per empty acquisition
   (≤3/tick) — intentional (unit.0a asserts freshness to prevent shared
   mutable empties). Correct trade.
6. Parent-reported test counts (loops "50/50" vs 48 `test(` declarations I
   count) presumably include subtests; immaterial, noted only because I could
   not run the suites.

## Paired-step blocker clearance (secondary ask)

All three of my earlier blockers are cleared in the current tool, verified in
source last pass: (1) warmup asymmetry — both modules seed their own fixture
before the baseline copy plus two unmeasured write batches per side, with a
seed-equivalence hash as a bonus behavioral gate; (2) audit/meta blindness —
stateHash now includes auditRows at all five assert points, explicit per-side
quiet audit-head checks, schemaVersion equality, and index/page/freelist
provenance; (3) same-module A/A — `sharedModuleIdentity` recorded, 15-round
distinct-checkout A/A on the mini as the defending control, 3-round
same-module run demoted to smoke. Secondary items (repeatOpen ABBA,
first/last tool fingerprints, expect-changed set with committed-v2
enforcement, env metadata, WAL-sidecar assert, GC-coupling scope note) all
landed. The quiet-tick audit-head guard is in place and recorded.
