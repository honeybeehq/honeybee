# Dedup sweep allocation and CPU

The final sweep `dfecaeba` is accepted as consolidated integration `b60e1310`. It preserves the committed-membership fix from `1576571c` while sizing temporary candidates to tracked IDs. The [standing retention results](retained-standing-candidate.md) compare it with Unit 1; this experiment isolates the allocation refinement from the already corrected 1576571c sweep.

The parent [v3 ruler](designs/dedup-sweep-v3.mjs), SHA-256 `66b77cccfe0f152468062806955eb97203e55f3600572ad0e0c3ed97109dd75a`, extends the [frozen author v2](designs/dedup-sweep-author-v2.mjs) with package/lock fingerprints, full retained source hashes, verified macOS boot identity at both ends, and two complete warm cycles per side. Reports retain the exact changed source list (loops.ts only), distinct module identity, pristine database hashes before every cycle, and tool/tree end checks. A/A extracts the same pre-refinement ref twice into distinct roots.

The wide scenario seeds 20,000 pending messages but starts with one tracked ID. The probe-cadence scenario disables I1 and tracks 128 interrupted now-messages. It tests the cadence path, not a 1,024-ID growth trigger. Test z01.e separately proves that growth reaches the same sweep body. The ruler verifies the actual sweep index from the primed counter each cycle: wide index 254, probe index 255. All 256 raw step wall/CPU values are retained and the single sweep tick is reported separately from the other 255 ticks.

Three ABBA rounds provide six sweep samples and 1,530 quiet samples per side after warmup. Setup, assertions, GC, and profiling are outside these uninstrumented times. All captures ran sequentially on the M4 Mini with Node 24.18.0.

| Scenario / CPU p50, ms per tick | A/A before / control | Before / after refinement |
| --- | ---: | ---: |
| Wide quiet tick | 9.831 / 9.688 | 9.748 / 9.667 |
| Wide sweep tick | 10.461 / 10.302 | 10.523 / 9.637 |
| Probe quiet tick | 0.211 / 0.210 | 0.213 / 0.214 |
| Probe sweep tick | 0.274 / 0.273 | 0.289 / 0.289 |

A separate 256-tick profile per side samples allocation with an 8 KiB interval, including collected objects, and records full frame ancestry. The wide sweep's prune ancestry fell from 2,188,528 to 90,856 sampled bytes. Before refinement the large components were iterator allocation and Set.add; the candidate no longer constructs a Set of all pending IDs. These numbers estimate allocation traffic, not retained heap or exact object sizes.

Total wide-cycle sampled allocation was 2,690,215,080 → 2,678,112,456 bytes. That small total difference is not a whole-cycle allocation claim: I1 metadata reading still dominates at about 2.69 GB per 256-tick profile, and is the next investigation. Probe-cycle total allocation increased 38,939,968 → 41,877,848 bytes; this opposing observation is retained. Single low-volume sampled paths cannot establish a general memory gain.

The exact membership SQL plans for one and 512 IDs show a mailbox INTEGER PRIMARY KEY lookup with a json_each virtual scan, without a mailbox table scan. Probe correctness asserts exact tracked-ID membership and callback counts. FakeDriver.interrupt produces turn_ended facts, whose folds write audit events; the ruler asserts the exact +383 audit sequence change for 128 pairs. Wide mode remains authority-quiet. Recopying the pristine template each cycle prevents these writes from contaminating later samples.

Earlier author drafts had an incorrect sweep index, missing raw steps, and shared fixtures changed by those audit writes. They were fixed before accepted captures. The stalled 20,000-message Studio draft was stopped, its partial report discarded, and transaction seeding plus small structural smokes replaced it. Studio results are structural only. Accepted v3 smoke, 20k A/A, 20k A/B, and profile all completed with every source, database, membership, sequence, callback, and end-identity assertion green. Four heap sidecars are retained with verified hashes.

Combined acceptance: repository build, all v2 typechecks, 218 core tests, and 364 daemon/CLI tests passed on the exact final source alongside C25 and Cell read optimizations. One existing platform skip remains. Unit 2 is consolidated so the earlier callback-reentry regression at 24a4604b is never shipped independently.

Evidence: `mini-z01-sweep-v3-{smoke,aa,ab,profile}.json`, four `.heapprofile` sidecars, matching logs, and `mini-c25-z01-combined-source.json`.
