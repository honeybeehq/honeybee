# Automatic-title changed-workload baseline

The [transition ruler](tools/honeybee-autotitle-transition-ruler.mjs) supplements the [quiet-scan baseline](autotitle-quiet-design.md) and [memory baseline](autotitle-memory-baseline.md). It records CPU and wall time per scan with exact state, context, outcome and bookkeeping checks. Mutation/setup work and mock-provider completion run outside the timed scans. The [review](../../review/2026-09-07-perf-autotitle-transition-ruler.md) records draft bugs, fixes and hash corrections.

Two distinct clean Mini checkouts at 322815d9 passed the [canonical A/A control](evidence/mini-autotitle-transition-aa-canonical.json), using ruler 93260cb4 on Node 24.18. These are identical-code baseline values, not optimization gains.

| Workload | Before CPU p50 ms/scan | Identical control CPU p50 ms/scan | Before wall p50 ms/scan | Control wall p50 ms/scan |
|---|---:|---:|---:|---:|
| One changed bee in a 1000-bee thin fleet | 4.221 | 4.368 | 4.201 | 4.275 |
| Every bee changed in the thin fleet | 34.412 | 35.880 | 33.952 | 35.448 |
| Expired retry, one 100k-message mailbox | 184.776 | 185.858 | 154.034 | 154.429 |
| Ten quiet 20k-message backoff mailboxes | 309.769 | 312.952 | 269.235 | 275.201 |

Every row has 30 measured samples per side after warmup, in ABBA order. First scan/cycle readings are separate in the raw report. Envelope-only appended messages change membership while leaving the thin normalized signature unchanged, so the changed-fleet cases remain quiet. The all-changed history grows during the run; it is an adverse miss workload, not a fixed-size steady-state test. The expiry case executes 38 launches per side across first, warm, measured and diagnostic cycles, with one untimed drain scan per cycle. The ten-mailbox row is directly measured fleet stress, not an extrapolation from one mailbox.

Treatment measurements remain pending the frozen dispatcher candidate and its behavior tests. In particular, gains on warm quiet scans must be weighed against two extra membership reads on misses, first-scan costs and the private cache's retained state.

The [offline heap inspector](tools/honeybee-autotitle-cache-heap-inspect.py) is ready for candidate snapshot analysis. Its [structural proof](evidence/honeybee-autotitle-cache-heap-inspector-proof.json) includes a positive synthetic closure and negative released/baseline controls. It counts observed entry objects through a named Map context slot. It neither exposes a production API nor claims per-cache retained bytes.
