# Dedup retention while pending mail never drains

Unit 2 is accepted as consolidated integration `b60e1310`, after measurement and combined verification. `24a4604b` introduced a bounded sweep on top of accepted Unit 1. Parent review found that a reentrant `onI1Violation` callback could create and track a new pending message after the outer step read its I1 basis. The outer sweep could then forget that live ID and interrupt it twice. Test z01.i reproduced the regression on 24a4604b, passed on Unit 1, and passes with `1576571c`. That fix verifies would-delete IDs against current committed mailbox membership. No callback-contract assumption or relaxed assertion was used to excuse the bug.

`dfecaeba` refines temporary allocation. The sweep now starts with a Set of tracked IDs, subtracts IDs known pending in the current step's I1 metadata, and verifies remaining candidates in chunks of at most 512. It removes only IDs still absent from committed state. The disabled-I1 path uses the same candidate probes without an I1 basis. Scratch scales with tracked IDs rather than all pending messages. The existing outer-transaction guard prevents forgetting rollback-restorable mail.

The trigger is combined tracked-set growth of at least 1,024 since the last sweep, or 256 committed ticks. Both counters reset after every sweep. Stable backlog does not re-trigger growth each tick; continued growth can cause further growth sweeps. These thresholds bound frequency, not wall time: a sweep still processes its tracked IDs and may walk the pending metadata until candidates resolve.

## Persistent pending anchor

The frozen [standing ruler](designs/retained-standing.mjs) uses real CoreStore and DaemonCore, FakeDriver, and a counting I1 callback. Thirty cohorts each add 1,000 overdue messages, check exactly-once callbacks, then delete their Bee and mail through the public API. One permanent overdue anchor stays pending throughout. Each cohort records post-GC process memory outside timed steps. After all cohorts, 256 steps allow a complete cadence window before the final GC and separate vmmap summary. Durable audit history remains.

| Revision/run | Final tracked I1 IDs | Final post-GC JS heap, bytes | New 1,000-message cohort CPU p50, ms |
| --- | ---: | ---: | ---: |
| 0320278f / before | 30,001 | 12,311,856 | 0.8995 |
| 1576571c / after | 1 | 11,711,040 | 1.3345 |
| 1576571c / after-repeat | 1 | 11,711,120 | 1.3175 |
| 0320278f / before-repeat | 30,001 | 12,312,280 | 0.9055 |
| dfecaeba / refined | 1 | 11,702,536 | 1.2665 |
| 1576571c / 1576-repeat | 1 | 11,711,096 | 1.3415 |

The original Unit 1 retains 30,001 IDs because mail never drains. Both corrected Unit 2 versions settle to the one pending anchor. The refined candidate uses about 0.61 MB less retained JS heap than Unit 1 in this fixture. This is process retained heap, not exact Set bytes. Growth-sweep cost is real: about 0.37 ms additional CPU for the new 1,000-message cohort. The first corrected candidate peaks at 2,001 tracked IDs across the cohort sequence. Native footprint observations at this smaller scale vary with process order, so no Unit 2 footprint or RSS gain is claimed.

## Steady cadence cost

The [cycle ruler](designs/dedup-cycle.mjs) times 256 consecutive steps per sample, covering a complete sweep cadence with stable overdue pending IDs. These numbers are milliseconds per 256-tick cycle, not per tick. Fixtures are byte-identical copies, modules come from distinct roots, three symmetric warmups precede three ABBA rounds, and each side has six measured cycle samples. Setup, GC, and checks are outside timing. All callbacks remain exactly once, with no new audit rows, delivery, interrupt, or start effects.

| Pair | Pending | Before / after CPU p50, ms per cycle |
| --- | ---: | ---: |
| aa | 1 | 3.659 / 3.509 |
| aa | 1,000 | 134.302 / 135.541 |
| aa | 10,000 | 1233.377 / 1245.269 |
| ab | 1 | 3.867 / 3.609 |
| ab | 1,000 | 130.938 / 134.127 |
| ab | 10,000 | 1243.766 / 1242.285 |
| ba | 1 | 3.76 / 3.617 |
| ba | 1,000 | 131.137 / 132.448 |
| ba | 10,000 | 1243.194 / 1236.71 |
| refinement | 1 | 3.801 / 3.507 |
| refinement | 1,000 | 128.311 / 129.769 |
| refinement | 10,000 | 1221.888 / 1220.438 |
| final | 1 | 3.601 / 3.483 |
| final | 1,000 | 132.072 / 132.209 |
| final | 10,000 | 1233.817 / 1233.358 |

A/A compares two Unit 1 roots. A/B compares Unit 1 with 1576571c; B/A reverses that pair. Refinement compares 1576571c with dfecaeba. Final compares Unit 1 with dfecaeba. Stable large-backlog CPU is essentially unchanged within the observed control/order variation. These samples support the retention/cost assessment; they do not establish a steady CPU speedup.

## Verification and acceptance

Mini 1576571c passed repository build, all v2 typechecks, full core, and all 64 loop tests. Mini dfecaeba passed build, all v2 typechecks, and all 65 loop tests. The added cases cover committed/rolled-back terminals, disabled I1, stopped/absent targets, exact cadence and growth triggers, revived now-message dedup, callback reentry, and 5,000 pending messages with only one initially tracked ID.

The [dedicated allocation/probe diagnostic](dedup-sweep-results.md) passed: the 20,000-pending sweep tick fell 10.523 → 9.637 ms CPU and prune-attributed sampled allocation fell 2,188,528 → 90,856 bytes. Disabled-I1 sweep CPU stayed 0.289 ms. Combined integration with C25 and both Cell read changes passed build, all v2 typechecks, 218 core tests, and 364 daemon/CLI tests with one platform skip. No regression-bearing intermediate commit is accepted independently.

## Half-million-message standing stress

The same frozen ruler ran 50 cohorts of 10,000 messages per process, keeping one pending anchor throughout. Process order was Unit 1, refined candidate, refined candidate, Unit 1. All exact callback, pending-mail, source, and boot checks passed. Final memory follows the complete 256-tick settling window and forced GC; vmmap runs separately while the store remains open.

| Run | Final tracked IDs | Final JS heap, bytes | Physical footprint, vmmap M | New 10,000-message cohort CPU p50, ms |
| --- | ---: | ---: | ---: | ---: |
| before | 500,001 | 22,172,344 | 129.7 | 9.6365 |
| after | 1 | 11,730,888 | 121.7 | 11.3180 |
| after-repeat | 1 | 11,731,560 | 117.0 | 11.2950 |
| before-repeat | 500,001 | 22,172,192 | 128.2 | 9.8880 |

The candidate removes 500,000 obsolete IDs, reduces final retained JS heap by about 10.44 MB in both comparisons, and has smaller observed physical footprint in both process orders. This supports a footprint improvement for this workload; the smaller experiment and all raw RSS samples remain retained. It is not a universal RSS or exact native-allocation claim. New-cohort CPU increases by about 1.4–1.7 ms per 10,000 messages. The workload excludes real workers and durable I1 recorder writes.
