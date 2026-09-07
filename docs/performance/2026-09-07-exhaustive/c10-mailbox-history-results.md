# Sparse mailbox history results

Accepted production `c25ee08a` is integrated as `44ffbb52`, with tests `ca7f498c` and `5479ed6a`. The ordered UNION reads pending and delivered partitions through separate partial indexes. Public API, row values, FIFO order, transaction visibility and caller behavior are preserved. The [design review](c10-design-review.md) records the rejected full-index alternatives and their pending-read regression.

At 20 target rows among 100,000 unrelated rows, listMessages fell from 3.744 to 0.032 ms CPU, about 117 times faster. An empty target fell from 3.677 to 0.011 ms. The critical same-Bee control with 20 pending and 100,000 delivered rows held at 0.024 ms for undeliveredMessages. No full-history scan entered that delivery path.

This is an explicit tradeoff. Reading 100,000 target rows rose from 129.112 to 136.142 ms CPU, +5.45%, and 103.045 to 111.104 ms wall, +7.82%. The A/A CPU comparison was 119.311 to 118.299 ms. We retain the adverse result and accept it for the large sparse-read improvement. We have not measured the production frequency of these shapes. Automatic title context, mailbox RPC and spawn fallback can all call listMessages; active untitled Bees are not guaranteed to have small histories. No claim that giant reads are impossible outside RPC supports this decision.

## Reproduction and scope

[Canonical A/A](evidence/mini-c10-canonical-aa.json) and [canonical A/B](evidence/mini-c10-canonical-ab.json) ran serially on the M4 Mini, Node 24.18.0, one boot. Baseline is `10c25dfc`; treatment is `a67a48bb`. Distinct immutable module paths and full runtime/package fingerprints prove that only schema.ts and store.ts differ. The [frozen ruler](tools/honeybee-mailbox-by-bee-tradeoff.mjs) SHA-256 is `220b803ea0facace2cf5c9ce86f159289229507ce467fae75304519f5c44ce36`.

Reads have six warmup calls then 30 timed calls per side per operation in ABBA order. Each write terminal has one untimed 100-cycle batch and ten timed 100-cycle batches per side. Opens have six fresh-file samples per side without discarded warmup. Installed reopens happen after close and storage inspection including quick_check, so they are fully warmed post-inspection constructor timings. First open includes the whole constructor and index installation; it is not isolated CREATE INDEX time. Copying, close/checkpoint, validation and diagnostics are outside those clocks.

Fixtures use real UUID Bees and foreign-key-valid mailbox rows. Bulk fixture rows are inserted offline without matching enqueue audit/projection history, and only authority reads consume them. Timed writes use the public durable APIs. Each store executes 3,300 sends, 2,200 cancellations, 1,100 deliveries and 1,100 expedites. Exact 7,700 audit-row growth, 1,100 retained-message growth, full state/audit parity, row counts, identity and ordering are asserted. Plans are captured on the unchanged read fixture before writes. All raw samples, query text, plans, boot identity, hashes and file/page/index data are retained. Process CPU includes its threads; OS caches and GC are shared. No retained heap or RAM improvement is claimed.

## Read CPU

All values are p50 ms CPU. A/A columns expose the unchanged-source control.

| Fixture | Read | Before | After | Change | A/A before / control |
|---|---|---:|---:|---:|---:|
| empty-target | listTarget | 3.677 | 0.011 | -99.70% | 3.700 / 3.702 |
| empty-target | pendingTarget | 0.006 | 0.005 | -16.67% | 0.005 / 0.005 |
| sparse-target | listTarget | 3.744 | 0.032 | -99.15% | 3.818 / 3.843 |
| sparse-target | pendingTarget | 0.013 | 0.013 | +0.00% | 0.013 / 0.013 |
| full-target | listTarget | 129.112 | 136.142 | +5.44% | 119.311 / 118.299 |
| full-target | pendingTarget | 32.263 | 32.245 | -0.06% | 31.868 / 31.973 |
| delivered-history-target | listTarget | 128.298 | 130.202 | +1.48% | 129.871 / 129.201 |
| delivered-history-target | pendingTarget | 0.024 | 0.024 | +0.00% | 0.023 / 0.023 |
| large-target | listTarget | 22.111 | 22.257 | +0.66% | 22.537 / 22.358 |
| large-target | pendingTarget | 7.041 | 6.969 | -1.02% | 6.980 / 7.149 |

## Write CPU

Values are p50 ms CPU per 100 public cycles. Delivery adds an index entry. Pending sends still evaluate the index predicate; absence of an entry mutation is not zero cost. Cancel and expedite differences overlap control variation and are not claimed as gains.

| Fixture | Terminal | Before | After | Difference | A/A before / control |
|---|---|---:|---:|---:|---:|
| empty-target | cancel | 9.220 | 9.330 | +0.110 | 9.385 / 9.519 |
| empty-target | deliver | 10.433 | 10.837 | +0.404 | 9.702 / 9.636 |
| empty-target | expedite-cancel | 11.434 | 11.686 | +0.252 | 11.310 / 11.259 |
| sparse-target | cancel | 8.512 | 8.642 | +0.130 | 9.358 / 9.338 |
| sparse-target | deliver | 10.381 | 11.248 | +0.867 | 10.110 / 9.644 |
| sparse-target | expedite-cancel | 12.098 | 11.802 | -0.296 | 12.138 / 11.779 |
| full-target | cancel | 8.784 | 8.594 | -0.190 | 9.451 / 9.369 |
| full-target | deliver | 9.970 | 10.570 | +0.600 | 10.629 / 10.558 |
| full-target | expedite-cancel | 11.565 | 11.827 | +0.262 | 12.189 / 11.932 |
| delivered-history-target | cancel | 9.485 | 9.492 | +0.007 | 9.563 / 9.782 |
| delivered-history-target | deliver | 10.760 | 11.310 | +0.550 | 9.698 / 9.680 |
| delivered-history-target | expedite-cancel | 11.611 | 11.822 | +0.211 | 11.666 / 11.654 |
| large-target | cancel | 8.749 | 8.719 | -0.030 | 8.533 / 8.522 |
| large-target | deliver | 9.816 | 10.401 | +0.585 | 9.711 / 9.673 |
| large-target | expedite-cancel | 13.083 | 12.530 | -0.553 | 11.936 / 11.664 |

## Open and storage

Values are p50 wall ms before / after. Closed file growth equals the retained index bytes on these fixtures. The index contains identifiers, not message bodies. The initial install scans the mailbox and indexes delivered rows; it can recur if an old build or operator removes the index.

| Fixture | First constructor | Installed reopen | Index bytes |
|---|---:|---:|---:|
| empty-target | 0.541 / 16.893 | 0.384 / 0.375 | 3,022,848 |
| sparse-target | 0.522 / 16.901 | 0.352 / 0.356 | 3,022,848 |
| full-target | 0.522 / 17.197 | 0.343 / 0.360 | 3,022,848 |
| delivered-history-target | 0.531 / 27.068 | 0.364 / 0.368 | 4,530,176 |
| large-target | 0.563 / 0.797 | 0.398 / 0.408 | 36,864 |

## Verification and measurement corrections

Standalone Mini build and all v2 typechecks passed. Core passed 230/230; daemon/CLI passed 368 with one platform skip. The a67 tests-only cleanup separately passed its five cases and core typecheck. The exact integrated source at c01f7733 also passed build, all v2 typechecks, 230 core tests and 368 daemon/CLI tests plus one platform skip. Its complete runtime/package fingerprint matches the measured treatment. The previous legacy compiled-suite limitation remains: 67 failures matched a repaired unchanged-main control, with 693 emitted modules identical. These v2 gates do not turn that legacy suite green.

Independent ruler review caught plans being recorded after writes. Moving them before writes exposed CoreStore's exclusive connection lock in a real Mini smoke. The corrected ruler closes stores after read validation, obtains plans, then reopens and proves unchanged state/audit before writes. The failed f8d4 smoke and log are retained, along with the pre-review and pre-lock script bytes. Corrected A/A and A/B smokes passed. Review also corrected the reopen description to post-inspection. None of the failed-smoke values is used as a performance result.
