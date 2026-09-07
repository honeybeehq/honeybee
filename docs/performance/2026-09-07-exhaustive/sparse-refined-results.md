# Sparse daemon work and shared pending metadata

The refined candidate `824485f9` is accepted after correcting the first candidate's held-mail regressions. It is integrated through `4db13133`, preserving main's runner-mail repair, flag index, task-supply gates, and command predicates.

Daemon policies now read only current live-runtime fields. Delivery and I1 share body-free pending metadata acquired during the same step. Only the selected delivery hydrates its message body. Audited changes refresh the work after commands and the I1 facts after delivery/task supply. No snapshot survives a step, so an outer transaction rolling back and reusing an audit sequence cannot reuse stale inputs.

## Measurements

M4 Mini, Node 24.18.0, same OS boot and frozen corrected ruler; 30 uninstrumented samples per side, separate native CPU/allocation profiles. Strict comparisons allow exactly core index.ts/store.ts and daemon loops.ts to change.

| Fixture | Before CPU p50, ms | Refined CPU p50, ms |
| --- | ---: | ---: |
| 1,000 stopped Bees | 0.021 | 0.023 |
| 10,000 Bees, one live | 43.459 | 0.026 |
| 1,000 live | 3.259 | 0.841 |
| 1,000 held 64-byte messages | 0.859 | 0.547 |
| 10,000 held 64-byte messages | 8.517 | 5.251 |
| 20,000 held 64-byte messages | 18.485 | 10.503 |
| 100 held 1 MiB messages | 19.053 | 11.785 |

The two-microsecond empty-tick difference is not evidence of a meaningful regression. The separate 15-round ABBA paired ruler reports empty ticks at 0.029 ms on both sides, all-live 3.238→0.890 ms, held 1 KiB messages 0.989→0.564 ms, and write-every-tick 3.262→0.067 ms. Ten durable lifecycle cycles differ by -1.6% to +3.6% across fixtures; no new schema/index or lifecycle write path was added. Outliers and raw samples are retained, not removed.

Sampled allocation traffic over 30 profiled ticks falls from 1,085,260,264 to 477,048 bytes for the sparse fleet; 112,321,616 to 24,209,152 for all-live; 262,963,280 to 158,145,208 for 10,000 held messages; and 3,148,753,632 to 2,486,824 for large bodies. These include collected allocations and do not measure retained or private memory. SQLite still traverses large records to read later metadata fields; large-message CPU remains open.

Evidence: `evidence/mini-sparse-refined-*`, hashed profile sidecars, strict comparisons, and `mini-paired-step-sparse-refined.json`. The first full read-hotspot after capture omitted --expose-gc and was rejected against the original baseline by the strict comparator. It remains as an unpaired diagnostic; a second capture uses matching runtime flags and passes the strict 24-case comparison. No unchanged operation above 0.1 ms CPU regressed by more than 10% in that comparison; smaller differences are retained in the raw rows. No mismatched comparison is accepted.

## Verification

Exact integrated `4db13133`: repository build and all v2 typechecks pass; core 199/199; serial daemon 267 pass, 1 platform skip, no failures. Logs are `verification/mini-sparse-integrated-*`.

The author's frozen old-base check had one Cell survivor completion timeout, reproduced on the unchanged `1325e204` base in isolation. Current main includes the runner socket repair and a real-turn-start journal barrier absent on that old branch. The same isolated case passed on main, and the full integrated suite passes. Original failed logs remain retained.

Tests cover exact ordered projection equivalence, absent/stopped/old-generation runtimes, active flags, all urgencies and FIFO positions, selected body/envelope delivery, post-command refresh, post-delivery/task I1 refresh, I1-disabled paths, and audit-sequence reuse after outer rollback. The [review](../../review/2026-09-07-perf-sparse-work.md) records the boundaries.

Retained dedup sets, persistent backlog scaling, real driver polling, and broader spawning/Cell performance remain separate inventory work.
