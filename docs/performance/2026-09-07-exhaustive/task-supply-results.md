# Task-supply short circuits

Author commit `6cc402de` eliminates full Bee, question, and mailbox hydration for terminal feed decisions. Disabled, paused, and exhausted supplies return immediately. Empty task lists stop before question or mailbox reads. Pending-mail and open-question checks use existing indexed existence queries. Stall detection uses the same pending-mail predicate. The pure gate's reason ordering and full public reads remain unchanged; no index is added.

The parent measured exact `f3ed9b75` before and `6cc402de` after on the same M4 Mini / Node 24.18.0 / boot, using the unchanged 24-case ruler and 15 samples per case. The strict comparator accepted exactly `v2/core/src/store.ts` as the source change.

| Whole-core fixture | Before CPU p50 | After CPU p50 |
| --- | ---: | ---: |
| 100 empty enabled supplies | 2.154 ms | 1.227 ms |
| 1,000 empty enabled supplies | 21.325 ms | 12.295 ms |
| 100 paused supplies | 2.694 ms | 1.243 ms |
| 1,000 paused supplies | 27.280 ms | 12.796 ms |

The remaining cost includes the core tick and per-supply stall/task checks; C22 is still open for further scaling work. A first invocation under the `/tmp` alias silently skipped the ruler's `isMain` guard. It produced no report and is not evidence. The corrected canonical script path produced a complete 24-case report, checked after execution. `mini-read-hotspots-after-c22.json` and `mini-read-hotspots-c22-comparison.json` contain the accepted measurements.

A separate paired public-API experiment, `designs/task-supply-paired.mjs`, compares exact returned feeds, message bodies, full state and audit for 100 targets with ten tasks each. Each batch runs in an outer transaction rolled back outside timing; the measurements therefore exclude durable commit latency. Fifteen ABBA rounds give 30 samples per side, after three warmup rounds. Fixtures are copied from one public-API seed and both source modules are warmed.

| Task-supply batch | Before CPU p50 | After CPU p50 |
| --- | ---: | ---: |
| 100 positive feeds | 10.308 ms | 9.460 ms |
| Ten open 4 KiB questions per target | 4.680 ms | 1.954 ms |
| Ten held 4 KiB messages per target | 5.135 ms | 1.951 ms |

The paired report is `evidence/mini-task-supply-positive-c22.json`. Every sample preserved identical effect hashes across both implementations and restored initial state/audit after rollback. These experiments measure local CoreStore work, not provider execution or process readiness. Integrated as `7dfd8ca3`. Parent integration at `c027f347` passed 190 core tests, 69 daemon loop/account/argument tests, all eight v2 TypeScript checks, and the repository build on Node 24.18.0. [The independent parent review](../../review/2026-09-07-perf-task-supply.md) found no blockers.
