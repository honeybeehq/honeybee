# Empty daemon snapshot results

Production commit `bcd85a8c`, integrated as `9e0eb194`, avoids the full snapshot only when no non-stopped runtime and no pending message exists. Both predicates read SQLite afresh. The fallback and all phase boundaries remain unchanged. An additive partial runtime index makes the absence check independent of stopped history.

## Measured benefit

Canonical captures used Node 24.18.0 on the same Apple M4 Mac mini and OS boot. The parent ran captures sequentially, using immutable baseline `343289fe` and exact candidate `bcd85a8c` checkouts. No installed service changed. Studio verification ran on a different machine.

| Measurement | Before | After | Evidence |
| --- | ---: | ---: | --- |
| Core tick CPU, 1,000 stopped Bees, median of 30 | 3.241 ms | 0.022 ms | `mini-quiet-audit-none-guard-comparison.json` |
| Same tick wall time | 3.093 ms | 0.02175 ms | Same strict comparison |
| Sampled allocation traffic, 30 instrumented ticks | 107,752,872 B | 329,368 B | `mini-quiet-audit-profile-guard-comparison.json` and hashed native profiles |
| Paired tick CPU, 1,000 Bees × 20 generations | 4.282 ms | 0.048 ms | `mini-paired-step-guard.json`, 30 samples per side |
| Paired tick CPU, 10,000 stopped Bees | 44.110 ms | 0.042 ms | Same paired report |
| Real daemon idle CPU, 1,000 stopped Bees | 9.715% of one core | 0.467% | `mini-daemon-before.json`, `mini-daemon-after-guard.json`; three 5-second windows each |
| Same daemon, reverse-order repeat | 8.049% | 0.445% | `mini-daemon-guard-recheck-{baseline,candidate}.json` |
| Real daemon idle CPU, 100 Bees × 200 generations | 2.251% | 0.471% | Initial real daemon pair |

Allocation profiles include sampled collected objects and instrumentation overhead. They measure allocation traffic, not exact allocated bytes, retained memory, or a leak. The first daemon pair observed RSS of 249.8 MB → 205.0 MB; the reverse repeat observed 237.1 MB → 197.2 MB. These are process RSS observations after that fixture's setup/RPC history, with no private-memory attribution. Heap-used observations do not consistently improve, so no retained-heap reduction is claimed.

The strict quiet A/A control varied by +0.54% wall and +0.71% CPU. A separate 15-round paired A/A used two distinct byte-identical checkouts, preserving distinct module identities and symmetric warmup. Its retained-10,000 CPU median differed by +9.73%, demonstrating the limits of small deltas under shared-heap GC. The earlier three-round same-module A/A is retained as a smoke only.

Separate real-daemon traces place the original dominant cost in `core.step.snapshot`. Trace timings are attribution evidence, not the uninstrumented headline. Raw reports, profiles, and trace sidecars are under [evidence](evidence/).

## Costs and limits

The runtime index has a cost. Across the nonempty paired fixtures, ten durable create/stop/revive/stop cycles took 4.1–7.7% more median process CPU, an increase of 0.086–0.165 ms per ten-cycle batch. Closed database sizes increased by 4,096 B in six cases and 24,576 B with 1,000 live runtimes. The copied-store first-open observations are single samples and include index installation; they do not establish an installation percentile or a maximum-size migration bound. Reopen medians varied within approximately −4.5% to +5.1% in the candidate comparison; the A/A control itself varied by −3.9% to +7.6%.

Sparse-live, all-live, held-mail, and write-every-tick step CPU medians changed by −0.14%, −0.97%, +0.11%, and −0.60%. These small differences do not establish speedups. The paired ruler preserves identical state and audit histories, symmetric module warmup, WAL/NORMAL durability, and ABBA order. Shared-heap GC can still cross sides.

Public complete-view reads have a separate paired regression matrix in `mini-paired-core-guard/`. Startup and stub readiness samples in the daemon suite are one observation per process; the initial 1,000-Bee spawn observation worsened, while the reverse repeat improved. No spawn speedup or regression is inferred from those isolated timings. Delivery medians remained close across both orders.

The guard helps fully parked hives. Any live runtime or pending message takes the existing full fallback. D02 remains open for sparse fleets, large bodies, and long queues. D05 command predicates and C22 task-supply work are separate measured targets.

## Correctness and verification

[Independent production review](../../review/2026-09-07-perf-empty-snapshot.md) found no blockers. Tests cover fresh empty containers, flag expiry, every live state, archived-live targets, stopped/no-runtime pending mail, old non-current live rows, same-tick revive and task-supply transitions, strict time boundaries, and an executed outer-transaction rollback with reused audit sequence. Existing public snapshot methods remain complete.

The author passed core 182/182, daemon loops 50/50, both package typechecks, and repository build. Its neutral-environment full daemon run passed unit 154/154 and serial/integration 164/164 before the final test-only strengthening; the final loops suite includes that strengthening. The initial ambient run's inherited `HIVE_PARENT` failure is retained separately. Parent integration passed core 182/182, serial/integration 164/164, both package typechecks, all 32 performance-tool tests, and repository build. Its unit suite was 153/154: the unchanged Codex limits transport fixture exceeded its 3,750 ms timeout under Studio load. That exact test passed 1/1 in an isolated rerun. The initial failure and rerun remain separate under `verification/`; the full unit run is not represented as wholly green.
