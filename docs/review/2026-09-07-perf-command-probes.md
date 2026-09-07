# D05 production review — perf(core): narrow daemon command probes

Commit `f3ed9b75` vs base `2cff56e0` (same production lineage as the
empty-snapshot guard) in the read-hotspots worktree. Independent static
review; no builds/tests/captures run (author reports core 184, loops 52,
check + v2 check, build green — consistent with my read).

## Verdict

**No blockers. Approve.** 32 production lines replace the two
full-history `listCommands` materializations with three narrow, unhinted,
statement-cached SQL predicates; no schema or index changes; call-site
logic, ordering, and short-circuit structure preserved exactly.

## Equivalence audit (the heart of the change)

- `hasStopThenReviveRequest` ⇔ old `verb==='stop' && targetGeneration===gen
  && args.thenRevive===true && status∈{done,running}`. The strict-boolean
  translation is correct: `json_type(args,'$.thenRevive') = 'true'` matches
  ONLY JSON boolean true — `false`/`null`/`1`/`"true"`/absent all yield a
  different type tag or SQL NULL, mirroring JS `=== true`. Malformed args
  cannot occur (enqueueCommand always writes `JSON.stringify`), so
  json_type's throw-on-malformed path is unreachable — same as JSON.parse
  at map time before. `target_generation = ?` excludes NULL rows, matching
  `null === gen` ⇒ false.
- `hasPendingReviveOrWakeCommand` ⇔ old `(targetGeneration ?? 0) >= gen`
  via `COALESCE(target_generation, 0) >= ?` — exact, including the
  null-wake fallback-to-zero case (tested both sides of the boundary).
- `hasPendingStopCommand` — direct translation; `failed` correctly outside
  both pending sets, as before.
- Call sites: `reviveAfterStopIfRequested` keeps its check order
  (request → pending → current-runtime guard untouched); the common
  no-request path now runs ONE narrow query instead of materializing the
  full history. `pendingStopExists` is a pure delegation. Both are
  same-connection synchronous reads, inside or outside `transact`, exactly
  as the old `listCommands` was — no consistency-window change (the old
  single-read-two-checks structure becomes two reads, but nothing can
  interleave between them on the synchronous tick).
- Semantics deliberately preserved, correctly: a backoff-deferred command
  with `next_attempt_at` in the future still counts as pending intent
  (old code never consulted next_attempt_at) — pinned by the "future
  retry" tests on both the store predicates and the hang-policy flow.

## Test review (both files strong)

- **command-indexes.test.ts:** EXPLAIN QUERY PLAN pins all three unhinted
  predicates to `commands_by_bee_status (bee_id=? AND status=?)` with no
  temp b-tree — the planner-drift risk of going unhinted is converted into
  a loud test failure, which is better than an INDEXED BY hint. The
  strict-boolean matrix ({}, null, false, 1, "true", other-verb-with-true),
  the status lifecycle (queued ≠ request, running = request, failed ≠
  request, done = request), exact generation matching, missing-bee, the
  full negative matrix for the pending predicates, boundary generations
  (equal/above/null-fallback), and read-only-ness (audit seq, dumpState,
  and complete ordered history unchanged by probes) are all asserted.
- **loops.test.ts:** end-to-end boot flow with a thenRevive-false bee and
  an already-covered (pending-wake) bee — no revive enqueued, histories
  byte-stable, no driver effects, exact `boot.reconciled` audit rows; and
  the pending-stop flow where a future-deferred stop suppresses hang-policy
  re-enqueue across repeated authority-no-op steps.

## Performance expectation (set before measuring)

- `pendingStopExists` and the pending-revive probe become O(pending
  commands for the bee) ≈ O(1) via the (bee_id, status) index prefix —
  this should collapse the 176.9 ms pending-stop case.
- `hasStopThenReviveRequest` still range-scans the `(bee_id,'done')`
  bucket — the settled history itself — when no request exists (the
  common case, and the exact boot-recovery fixture shape). The win is the
  removal of 100k-row JS materialization + JSON.parse, a large constant
  factor, but the probe remains **linear in a bee's settled-stop history**
  at the SQL level. Expect boot-recovery (174.6 ms) to improve
  substantially yet stay history-proportional; do not read a residual
  linear term as a failed change. The O(1) endgame is a partial index
  (e.g. `ON commands(bee_id, target_generation) WHERE verb='stop' AND
  json_type(args,'$.thenRevive')='true'`) — correctly excluded this round
  by the no-schema-change constraint; a candidate follow-up unit if the
  measured residual matters at real fleet scale.

## Nonblockers

- Boot cost at fleet scale is `Σ` per-stopped-bee done-bucket scans;
  the D05 fixture measures one bee — if boot latency on large real hives
  matters later, a many-bee boot scenario would show the aggregate.
- Style: deleteBee uses an INDEXED BY hint (store.ts:1607) while these
  predicates rely on plan-pinning tests — both defensible; the test
  approach is the better pattern and could eventually replace the hint.
- The three predicates are daemon-shaped store API (same altitude question
  as `hasStepSnapshotInputs`); consistent with the accepted direction of
  narrow store probes, so no action.
