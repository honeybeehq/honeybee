# Quiet tick design exploration

Baseline: `343289fe`. No production changes or accepted design yet.

## Grounding

`DaemonCore.stepPhases` expires flags, reads an audit sequence, then unconditionally builds `stepSnapshot` at the start of every tick. The snapshot groups every undelivered message and maps every retained bee through `CoreStore.listBeeViewRows`. Audit sequence reuse only avoids repeated snapshots within one tick. Boot-hang, scale-to-zero, degraded-mail, delivery, and I1 telemetry consume the snapshot. Task supply has its own fresh query.

The policies need booting, idle, or otherwise live runtimes. Delivery needs a live non-booting runtime plus pending mail. I1 additionally needs bees with pending mail even if their current runtime is stopped or absent. Archiving does not imply that a runtime is stopped. Flags expire against time before the snapshot. `observe` folds evidence and advances cursors in one transaction. A persistent cache cannot treat a reused audit sequence after rollback as proof that the data is unchanged.

The proposed investigation is to reduce retained-history work on quiet ticks without introducing another state authority or changing policy eligibility. The existing core benchmark includes 10/1,000 bees and 1/20/200 generations, all current runtimes stopped, with normal SQLite pragmas. Baseline measurement is pending the build.

## Arena checklist

- [x] Frame the operation, consumers, and correctness constraints from source.
- [x] Fan out two independent designs, including structurally different approaches.
- [x] Cross-judge completed candidates independently.
- [x] Pick the base against measured cost, interface depth, and invariants.
- [x] Graft useful ideas and record rejected alternatives.
- [ ] Verify the implementation and compare raw measurements.

The two candidate lanes are read-only Fable/max and Codex gpt-5.6-sol/max, adapting architect's runner matrix to two available slots. Both receive the same grounding and may propose a fresh relevant-row query, a rollback-safe cache, or a stronger alternative. They must compare at least two structural approaches. The parent owns measurements; neither lane may run builds or benchmarks.

## Synthesis

The independent GPT-6 ultra cross-judge selected fresh store reads as the direction but narrowed the first unit to an empty-snapshot proof. Add `CoreStore.hasStepSnapshotInputs()` using conservative existence probes for any non-stopped runtime or any undelivered message. A partial runtime index makes absence cheap; the existing pending-mail index supports the second probe. `stepSnapshot()` returns fresh empty containers only when both are absent. All other phases and the existing nonempty fallback remain unchanged.

This adopts Sol's partial index and fresh-read ownership, plus Fable's phase-order and exact time-boundary checks. Fable's cache is rejected: public `step()` can run inside public `transact()`, publish uncommitted state, and later hit a reused audit sequence after rollback. Its extra partitions also have unmeasured rebuild/retention costs. Sol's per-message FIFO prefix count is rejected because an all-overdue queue requires quadratic entry visits. Any later I1 metadata projection must rank the complete pending queue in one pass. The cutoff and second mailbox index are deferred pending evidence.

The guard is a first unit, not completion of D02 or C09: sparse live fleets and body-heavy queues still use the full fallback. Follow with linear I1 metadata, current-live runtime projection, and selected-body retrieval as separate measured units. Keep the guard afterward only if it still saves work. The partial index's first-open, storage, lifecycle-write, complete-view, and busy-fallback costs must be measured alongside the quiet win.
