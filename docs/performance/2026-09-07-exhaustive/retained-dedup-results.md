# Delivery bookkeeping after the queue drains

Unit 1 clears `reportedI1` and `interruptRequested` only when both the current transaction and pending-mail checks permit it. Empty sets skip the SQL probe. An open CoreStore transaction prevents clearing: messages that appear settled inside an outer transaction can return on rollback. Otherwise the existing indexed `LIMIT 1` mailbox probe must find no pending message anywhere before both sets clear. Pending mail for stopped or absent Bees still prevents clearing. No state is cached across steps.

The store exposes its existing transaction depth as a boolean and shares the existing pending-mail probe with `hasStepSnapshotInputs`. The daemon records the prune operation through the fixed `core.step.prune` span. Delivery and I1 deadline behavior remain unchanged.

## Retained heap and its limits

On the M4 Mini with Node 24.18.0, the frozen cohort ruler ran baseline `824485f9`, candidate `0320278f`, candidate again, then baseline again. Each process used 30 cohorts of 1,000 overdue messages, checked exactly one I1 notification per message while pending, deleted each Bee and its mail through the public store, stepped, and forced GC outside any timing claim.

| Final observation | Baseline 1 | Candidate 1 | Candidate 2 | Baseline 2 |
| --- | ---: | ---: | ---: | ---: |
| Obsolete retained I1 IDs | 30,000 | 0 | 0 | 30,000 |
| Post-GC JS heap, bytes | 12,177,400 | 11,531,096 | 11,531,096 | 12,177,400 |
| Process RSS, bytes | 163,020,800 | 171,163,648 | 180,109,312 | 169,050,112 |

Both repeats show 646,304 fewer bytes of final retained JavaScript heap. This is a process heap observation, not exact Set bytes or private memory. RSS increased in both candidate runs; no RSS reduction is claimed. Initial RSS and every cohort sample are retained in `mini-z01-retained-{before,after}-{1,2}.json`. The RSS behavior needs a larger repeated cohort experiment before attributing it to allocator noise or a persistent cost.

The fixture uses real CoreStore and DaemonCore with FakeDriver and a counting callback. Durable audit history remains. It does not exercise real worker delivery, durable I1 callback writes, or `rotatedGenerations`. Clearing when the queue never reaches zero remains Unit 2, not an implemented result.

## CPU cost and allocation controls

The disposable [busy ruler](designs/dedup-busy.mjs) uses identical copied databases, exact once-only callbacks, unchanged audit state, three symmetric warmup rounds, and 15 ABBA rounds (30 samples per side). Pending sets stay populated throughout, exposing the new probe. A/A uses distinct identical baseline checkouts; the reverse capture swaps candidate and baseline.

| Pending messages | A/A CPU p50, ms | Baseline → candidate CPU p50, ms | Candidate → baseline CPU p50, ms |
| --- | ---: | ---: | ---: |
| 1 | 0.018 / 0.018 | 0.015 → 0.017 | 0.019 → 0.018 |
| 1,000 | 0.506 / 0.501 | 0.524 → 0.523 | 0.502 → 0.502 |
| 10,000 | 4.838 / 4.738 | 4.949 → 4.760 | 4.860 → 4.715 |

The smallest case exposes about 1–2 microseconds of additional work. The apparent large-case gain reverses with ordering, so it is not an optimization claim. Reports are `mini-z01-busy-{aa,ab,ba}.json`.

All seven quiet timing and separate allocation pairs pass the strict comparator with exactly store.ts, loops.ts, and performance.ts changed. CPU p50 before → after: empty 0.023→0.024 ms; sparse 0.026→0.026; all-live 0.841→0.841; held 1k 0.547→0.543; held 10k 5.251→5.058; held 20k 10.503→10.496; 100 held 1-MiB bodies 11.785→12.047. The last difference is a measured 2.2% increase, not hidden by a aggregate speedup. Profiles measure sampled allocation traffic including collected objects; they do not establish retained memory.

## Correctness and integration

Four new tests cover outer rollback after delivered/cancelled/deleted messages, live-empty clearing, I1-disabled interrupt clearing, and stopped-pending retention. They inspect Sets without adding a public diagnostic API. Frozen candidate verification passed build, all v2 typechecks, core 191/191, and loops 59/59 on Mini. The author's earlier Studio budget-test timeout under load is retained in the author handoff; the isolated rerun passed.

Combined revision `6e4447d4`, including current main's runner-service and empty-rebase repairs, passed build, all v2 typechecks, core 201/201, serial daemon 271 pass and one platform skip, and capture 7/7. Logs are `verification/mini-c18-z01-integrated-*.log`.
