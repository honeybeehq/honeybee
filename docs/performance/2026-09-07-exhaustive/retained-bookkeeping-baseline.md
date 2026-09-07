# Retained daemon bookkeeping baseline

At integrated production `c027f347`, thirty cohorts of 1,000 overdue messages left **30,000 IDs in `reportedI1` after all pending messages were deleted**. `interruptRequested` stayed empty in this fixture. The exact retained ID count establishes obsolete bookkeeping independently of allocator noise.

Post-GC JavaScript heap grew from 11,067,984 to 12,156,896 bytes. That is an observed process heap change, not exact Set storage, private memory, or a whole-daemon leak estimate. The fixture retains durable audit history and uses a counting I1 callback and FakeDriver. It asserts one callback per overdue message while pending, no duplicate on a second tick, no pending mail after deletion, and no process starts or deliveries.

The [ruler](designs/retained-i1.mjs) and [complete report](evidence/mini-retained-i1-before.json) retain source hashes, tool hash, Mini boot identity, Node 24.18.0, all cohort samples, and completion assertions. This is a baseline only. A pruning design must preserve deduplication across revive, cancellation rollback, and `core.step()` inside an outer store transaction. The sparse projection changes are being settled before another change to the same loop.
