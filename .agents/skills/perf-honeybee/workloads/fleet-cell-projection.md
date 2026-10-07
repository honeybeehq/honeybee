# Referenced Cell projection in fleet lists

`CoreStore.listBeeViewRows` selects only Cells referenced by the lifecycle-filtered bees, using the existing Cell primary key. It reads fresh SQLite state with no cache or schema change. The full Cell registry APIs and the separate snapshot `cells` field are unchanged.

Run `mkdir -p .proof && node scripts/perf/fleet-cell.mjs --out .proof/fleet-cell.json`, then `node scripts/perf-map.mjs check .proof/fleet-cell.json`. Run `node --test scripts/perf/fleet-cell.node-test.mjs v2/core/tests/list-views.test.ts v2/core/tests/cell-move.test.ts`. The new regression controls also run in `npm run v2:test`. Node 24.18.0 is required. The existing CoreStore harness owns temporary-store cleanup; fixtures are isolated from the live daemon.

Three alternating baseline/candidate pairs cover 48 distinct synthetic cases: 1, 8 and 64 bees, 0, 1, 8 and 64 Cells per bee, and unfiltered, active, archived and unmatched lifecycle filters. All 144 full output comparisons and query invocation counts match. With 64 bees and 64 Cells each, the unfiltered call returns 64 Cell rows instead of 4,096, a 98.4375% reduction. The active and archived filters each return 32. Empty-history and unmatched-filter controls remain zero. A one-Cell-per-bee unfiltered list is unchanged; filtered lists avoid the other lifecycle's Cells.

The collector counts rows returned by the Cell query, not SQL VM instructions. One mapped Cell object per returned row follows from the mapping loop. Tests exercise replacement, retained and evicted state, reactivation, removal, rollback, deletion, reopen and audit replay. Separate raw-reference controls preserve null, missing, empty and shared Cell IDs. Query-plan checks cover all four lifecycle bindings and require Cell primary-key lookup without scanning the Cell table.

The subquery still scans the bee roster and builds a temporary membership set. Its CPU cost, sparse-history tradeoffs, allocation bytes, RSS, latency and production history frequency are unmeasured. The full snapshot still reads the complete Cell registry separately. This result establishes no UI or whole-daemon speedup.

The compact receipt contains one 48-case table plus hashes for all six retained raw arms under Speedy run `2026-10-06/c55ae577b9036a2377304506`. The candidate baseline check measures consistency with that capture; the paired raw outputs establish the reduction. The acceptance bound was predeclared before baseline and production edits.

The source owner and compact receipt were refreshed on 2026-10-07 after move mapping changed. All 48 current-source outputs match point reads and excess counts remain zero. This refresh does not remeasure the historical before arm.
