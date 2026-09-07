# First sparse projection: gains and rejected regressions

The combined `9240cede` + `1325e204` implementation passed its author's core and daemon suites. It is **not accepted for integration**: the unchanged held-mail cases regressed. Correctness checks alone cannot establish a performance improvement.

The parent captured all seven timing and profiling fixtures on the same M4 Mini and Node 24.18.0, with the corrected frozen quiet ruler. Strict comparison accepted exactly `v2/core/src/index.ts`, `v2/core/src/store.ts`, and `v2/daemon/src/loops.ts` as source changes. Both sides have 30 uninstrumented samples; allocation profiles are separate runs.

| Fixture | Before CPU p50 | Candidate CPU p50 |
| --- | ---: | ---: |
| 1,000 stopped Bees | 0.021 ms | 0.023 ms |
| 10,000 Bees, one live | 43.459 ms | 0.026 ms |
| 1,000 live | 3.259 ms | 1.037 ms |
| 1,000 held 64-byte messages | 0.859 ms | 1.057 ms |
| 10,000 held 64-byte messages | 8.517 ms | 10.458 ms |
| 20,000 held 64-byte messages | 18.485 ms | 21.202 ms |
| 100 held 1 MiB messages | 19.053 ms | 22.153 ms |

Sampled allocation traffic for the sparse fleet fell from 1,085,260,264 to 410,592 bytes over 30 profiled ticks. Large held bodies fell from 3,148,753,632 to 3,325,680 bytes. These are sampled allocations including collected objects, not retained or private memory. Small-message queues allocated 20–27% more.

The large-body candidate CPU profile is dominated by two SQLite `all()` calls, with 225 and 215 sampled ticks respectively. The implementation reads live pending metadata for delivery, then reads it again for fresh I1 telemetry. Avoiding body materialization removes JavaScript allocations but does not eliminate SQLite record traversal. The proposed refinement shares body-free metadata within one tick and refreshes it after audited mutations. Cross-tick caching remains excluded because outer rollback can reuse audit sequence numbers.

Raw reports, profiles and strict comparisons are `evidence/mini-work-*-after-sparse.json`, their sidecars, and `mini-work-*-sparse-comparison.json`. A revised candidate must retain exact FIFO ranking, post-task I1 facts, all-live behavior, and selected-message hydration while removing these regressions. The two-microsecond empty-tick delta is not a claim of a meaningful regression.

The corrected-ruler unchanged-code control confirmed the held regressions exceed observed drift: CPU p50 was 0.835 ms (1,000 held), 8.685 ms (10,000), 18.075 ms (20,000), and 19.425 ms (large bodies). Strict A/A reports are `mini-work-*-none-v3fixed-aa.json`; raw controls are adjacent. These observations are not a universal noise threshold.
