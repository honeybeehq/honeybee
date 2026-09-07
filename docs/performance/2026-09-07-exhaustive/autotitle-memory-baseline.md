# Automatic-title memory baseline

The [retained-memory ruler](tools/honeybee-autotitle-retained-ruler.mjs) measures whole-process heap occupancy and RSS across construction, first scan, warm scans, roster deletion and release. Each side gets two fresh processes in serial ABBA order. It records all readings after the same fixed GC procedure and checks exact source identities, copied fixtures, quiet state, audit and bookkeeping bytes. The provider is never reached.

The [review](../../review/2026-09-07-perf-autotitle-memory-ruler.md) approves revision e4a1db87. [V1](tools/honeybee-autotitle-retained-ruler-v1.mjs), original structural smoke reports and snapshots remain preserved. Snapshot mode is for offline retaining paths only. Numeric comparisons use mode=none. The [snapshot archive manifest](evidence/autotitle-retained-archive.json) maps losslessly compressed artifacts to their original paths and hashes.

## Identical-source Mini control

The [canonical A/A report](evidence/mini-autotitle-retained-aa-canonical.json) uses distinct clean 322815d9 checkouts on the Mini with Node 24.18. Each process scans 1000 small backoff bees and one giant with 100k interleaved pending/delivered messages. Every offline giant row passes the full public primary-key oracle before fixture copies. No dispatcher-cache candidate exists in these roots.

| Run order | Side | Warm heapUsed B | Warm RSS B | Released heapUsed B |
|---:|---:|---:|---:|---:|
| 0 | Before | 6,854,912 | 851,001,344 | 6,742,440 |
| 1 | Identical control | 6,854,680 | 861,782,016 | 6,742,208 |
| 2 | Identical control | 6,855,056 | 866,369,536 | 6,742,368 |
| 3 | Before | 6,854,872 | 825,049,088 | 6,742,400 |

All runs completed with 32 scans and stable quiet state. Warm managed-heap occupancy differs by only 376 B across the four runs, while RSS varies by about 41.3 MB. First-scan heap occupancy is about 11.59 MB before dropping during warmup. These differences illustrate why neither RSS nor a phase delta isolates cache retention. Deletion also writes audit data and changes statement and SQLite caches. The candidate still needs same-phase and phase-difference comparisons, exact cache-bound behavior and retaining-path analysis. No RAM optimization gain is claimed here.

## Implementation checkpoint

Core membership Unit1 is frozen at bc6554b6. The [Mini source proof](evidence/mini-autotitle-unit1-source-proof.json) matches the three committed files. Parent build, all v2 checks and all 237 Core tests pass. The dispatcher cache is being implemented separately on that candidate branch. Changed-mail, expiry and multi-giant timing scenarios are also being prepared. Main retains the previously accepted runtime until integrated behavior tests and before/after tradeoffs justify acceptance.

The [independent Unit1 review](designs/autotitle-architecture/membership-unit1-independent-review.md) finds no correctness blocker. A separate follow-up will strengthen nested-transaction and delivered-maximum tests and document comparison limits. The unsafe-integer case retains its current native error; it cannot silently produce a reusable identity.
