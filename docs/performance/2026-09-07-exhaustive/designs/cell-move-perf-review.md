# Cell-move incremental cost review — main 24058e1f (read-only)

Method: `git show`/`git grep` at merge `24058e1f` from the clean inventory
worktree; no branch switch, no edits, no builds, no Mini activity. Query
plans from a scratch in-memory `node:sqlite` DB using a representative
minimal schema (bees PK + `active_move_id`, bee_moves PK, the shipped
partial unique index) — shapes match the real DDL; not the full schema.

## What ships (facts)

- `bees.active_move_id` (v22) with partial UNIQUE index
  `bees_one_active_move ON bees(active_move_id) WHERE active_move_id IS NOT
  NULL` (schema.ts:719), installed on every open (store.ts:1492). It is
  dual-purpose: one-bee-per-active-move invariant AND the discovery index.
  My initial "unindexed scan" hypothesis was wrong — corrected below with
  the real plans.
- `activeMoveOf(beeId)` (store.ts:4936): bees-PK seek → bee_moves-PK seek.
  O(1), two index searches, statement-cached.
- `listActiveBeeMoves()` (store.ts:4944): join over
  `active_move_id IS NOT NULL ORDER BY m.id`.
- `reconcileMoves()` runs UNCONDITIONALLY every tick under its own
  `core.step.moves` span (stepPhases, after commands, before the delivery
  refresh) — it is NOT behind the empty-snapshot guard, which is correct
  for fences (a move on an otherwise-quiet hive must still advance) and
  cheap iff discovery is O(active).
- Move/cell mutators write audit rows (3 kinds found), so the sparse
  snapshot's seq-based refresh already observes move-phase changes.

## Exact hot call counts per tick

| Shape | activeMoveOf | listActiveBeeMoves | Notes |
| --- | --- | --- | --- |
| Idle/parked (all stopped, no mail, 0 moves) | 0 | 1 | The only move cost; runs even on guard-empty ticks |
| All-live, 0 pending, 0 moves | 0–W | 1 | W = idle runtimes past the idle window (scaleToZero probes AFTER window+pending gates, loops.ts:700) |
| Held-mail, N live bees with pending, 0 moves | **N** (delivery, loops.ts:999) | 1 | Per work row after booting/pending gates; the main steady incremental cost |
| M active moves | as above | 1 | + per move: getBee + currentRuntime + getBeeMove (+ driver sourceGone probe, + phase writes) in the reconcile body |
| Accepted delivery of a placement instruction | +1 (loops.ts:1070) | — | Rare; per accepted instruction delivery with a generation change |

## Query plans (scratch DB, representative schema)

- `activeMoveOf`: `SEARCH b USING sqlite_autoindex_bees_1 (id=?)` →
  `SEARCH m USING sqlite_autoindex_bee_moves_1 (id=?)`. O(1) as expected.
- `listActiveBeeMoves` as written (`ORDER BY m.id`): the planner INVERTS
  the join to satisfy the sort — `SCAN m USING INDEX
  sqlite_autoindex_bee_moves_1` probing the covering partial index per row.
  That is **O(total bee_moves rows including completed/failed receipts)**
  per tick, not O(active): receipts are retained by design, so this term
  grows with move history forever, even at 0 active moves.
- Same query with `ORDER BY b.active_move_id` (semantically identical —
  the join equality `m.id = b.active_move_id` makes the orders the same):
  `SEARCH b USING COVERING INDEX bees_one_active_move` →
  `SEARCH m (id=?)` — **O(active moves)**, no history scan, no temp
  b-tree. A one-line, semantics-preserving store fix; equivalently, drop
  the SQL ORDER BY and sort the tiny active array in JS.

At realistic move volumes (operator-initiated, hundreds over a hive's
life) the as-written cost is sub-millisecond; it is still an
unbounded-growth per-tick term the ordering tweak removes outright.

## Safe same-step sharing/projection options (fences intact)

1. **Zero-move fast path for delivery (minimal first unit).** One
   `hasActiveBeeMoves()` probe (LIMIT-1 on the partial index, O(1)) at the
   top of `deliveryLoop`; when false, skip the per-row `activeMoveOf`
   entirely — held-1000 drops N joins/tick to 1 probe. When true, the
   exact per-row check runs as today, so the delivery fence
   (`move && move.phase !== "starting" → skip`) is byte-identical whenever
   any move exists. scaleToZero can share the same per-tick boolean.
   Per-tick, same-step only — no cross-tick memory (see hazards).
2. **Ordering fix for `listActiveBeeMoves`** (above) — discovery becomes
   O(active) regardless of receipt history. Prefer this over gating
   `reconcileMoves` behind a probe: with it, the zero-move walk is an
   empty covering-index scan and a gate adds nothing.
3. **Projection sharing (deeper, optional later):** LEFT JOIN the active
   move PHASE into `readDaemonWork` so `DaemonWorkRow` carries
   `activeMovePhase: phase | null` — one batched read replacing N probes,
   naturally refreshed by the existing seq-based snapshot machinery (move
   mutators audit). It must carry the PHASE, not mere existence — the
   delivery fence distinguishes `starting`. Touches the sparse projection
   SQL and its tests; option 1 gets ~all of the win with none of that
   surface.

## Feature fences and rollback hazards (must survive any change)

- **Do not remove or weaken**: the delivery fence at loops.ts:999–1000,
  the scaleToZero admission skip at loops.ts:700, and the post-delivery
  instruction/completion sequence at loops.ts:1066–1073.
- **reconcileMoves' body must keep live reads.** It intentionally
  re-reads getBee/currentRuntime/getBeeMove mid-loop as phases advance
  within one tick; feeding it from any snapshot/projection would act on
  stale phases. Only the DISCOVERY read is optimizable.
- **No cross-tick "no moves" caching.** A step inside a public
  `store.transact` sees uncommitted admissions/cancellations; a cached
  zero-move flag surviving an outer rollback reproduces the Z01 hazard
  class. Per-tick probes are safe in both directions: an uncommitted
  admission makes the probe conservatively TRUE (fences engage; rollback
  just wastes the per-row checks for one tick), and there is no state to
  lose.
- **Schema/rollout**: everything above is SQL/read-API only; the index
  already ships in v22; no version bump, no migration, downgrade-safe.
- `completeBeeMove`/`markMoveInstructionsApplied` run after the driver
  effect on the accepted-delivery path (existing design); none of the
  options touch that sequencing.

## Minimal metric fixtures (parent-run; spans already exist)

The `core.step.moves` and `core.step.delivery` spans make before/after
trivial with the standing strict-pair discipline:

1. **Receipt-history term** (validates option 2): idle-parked N=10k bees,
   0 active moves, R ∈ {0, 10_000} bee_moves receipt rows seeded offline
   (read-cost fixture, disclaimed as non-lifecycle evidence, same
   discipline as read-hotspots) → `core.step.moves` p50 vs R exposes the
   O(history) scan; after the ordering fix it must be flat.
2. **Held-mail per-row term** (validates option 1): quiet-tick v3
   `--live 1000 --pending 1000` shape (or the paired-step held case) →
   `core.step.delivery` p50 before/after; expected delta ≈ N × two-seek
   join per tick; A/A envelope decides significance.
3. **Active-move reconcile body**: M ∈ {1, 32} admitted moves via the
   PUBLIC admission path (fences must hold; not offline-seeded) parked in
   `stopping`/`placing` with the source process absent-stubbed →
   `core.step.moves` per-move cost; asserts quiet invariants outside the
   move rows (no unrelated audit growth per tick).
4. Existing loops move tests already pin fence behavior; no new
   correctness fixtures needed for options 1–2 beyond a
   probe-count/zero-move equivalence unit.

No production or test files were touched; integration and all Mini work
remain the parent's.
