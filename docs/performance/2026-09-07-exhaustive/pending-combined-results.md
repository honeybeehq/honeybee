# Combined pending improvements against current main

The accepted runtime at `10c25dfc` combines native array mapping, the covering pending-metadata index, removal of the superseded pending index, and the stop-recovery index. It includes current main's gateway admission changes. Immutable baseline `2c3bdf6b` and a separate identical control therefore share the same daemon code with the candidate. The measured runtime-source delta is exactly `v2/core/src/schema.ts` and `v2/core/src/store.ts`.

Each capture used the same frozen quiet-tick ruler on Mini, Node 24.18.0, M4, 16 GiB, one OS boot. Three warm ticks preceded 30 uninstrumented samples. Captures ran serially after verification finished. No live worker was started. These are whole synchronous core-step timings with a FakeDriver, not end-to-end message delivery or worker spawn latency.

| Held workload | Before CPU, ms | A/A control CPU, ms | After CPU, ms | Before wall, ms | After wall, ms |
|---|---:|---:|---:|---:|---:|
| Empty | 0.036 | 0.035 | 0.033 | 0.0347 | 0.0324 |
| One live Bee, 20,000 messages × 64 B | 10.519 | 10.575 | 5.161 | 10.517 | 5.138 |
| 100 live Bees, 100 messages × 1 MiB | 11.219 | 11.893 | 0.151 | 11.210 | 0.150 |

The wide queue uses 50.9% less CPU per measured tick. Large-body CPU falls 98.7% because metadata reads avoid fetching mailbox table pages associated with bodies. Empty-tick differences are only microseconds and do not establish a meaningful improvement. The large-body control moved about 6%, far below the observed change; it remains visible rather than being normalized away.

[Wide A/B](evidence/mini-pending-final-wide-ab.json), [wide A/A](evidence/mini-pending-final-wide-aa.json), [body A/B](evidence/mini-pending-final-body-ab.json), [body A/A](evidence/mini-pending-final-body-aa.json), and [empty A/B](evidence/mini-pending-final-empty-ab.json) link to exact source/tool/boot identities and distributions. Their corresponding before/control/after files retain every raw sample. The comparator requires the same workload, instrumentation, environment and source scope, and nonoverlapping capture intervals.

The [array-only allocation experiment](pending-allocation-results.md) separately measured sampled allocation traffic. This combined timing experiment does not measure retained RAM. The [covering index tradeoff](pending-covering-results.md) records installation time and additional writes/storage. [Removing the old index](pending-index-removal-results.md) recovers duplicate write work and pages while retaining possible small full-message read costs. The [stop-recovery result](stop-recovery-index-results.md) records a separate command-history query and its remaining same-generation JSON work; this quiet workload does not credit that index with the pending gain.

At the exact measured runtime, Mini build and all v2 typechecks passed, followed by 225/225 core tests and 368 daemon/CLI tests, with one platform skip. Test-only migration refinements and the separate compiled-test import correction do not alter these two measured production files. Their final verification is recorded in the integration review.
