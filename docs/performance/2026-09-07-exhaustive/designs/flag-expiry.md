# Bound provider-flag expiry reads

C07 calls `expireFlags()` on every daemon tick. The unchanged query scans retained cleared flags and future flags even when no provider deadline is due. The first prototype keeps the exact query and public writer implementation, and adds a partial `(resets_at, id)` index over open flags with declared deadlines. It introduces no cached flag truth, ordering change, or new expiry policy.

Create the index after additive column migrations in `ensureSchemaVersion()`. Pre-v17 stores have no `resets_at` column, so placing this index in the initial `SCHEMA_SQL` would break their upgrade before migration runs. Ensure the index on every open; no schema-version bump is needed for this additive read index. Public expiry continues to return pre-clear rows in ascending ID order, clear each flag with the existing audit event, and roll back atomically.

The parent ran `flag-index-prototype.mjs` on exact `f3ed9b75`, with the same CoreStore module against copied databases. Fifteen ABBA rounds produced 30 samples per side and operation, following three warmup rounds. Expiry bursts ran inside an outer transaction rolled back outside timing, preserving identical rows; these numbers exclude durable commit latency. Set/clear cycles were separate production WAL/NORMAL transactions. Final state and audit were identical across sides. The script, raw samples, query plans, source hashes, boot UUID, and index SQL are retained.

| Fixture | Before expiry CPU p50 | Indexed CPU p50 | Added database bytes |
| --- | ---: | ---: | ---: |
| Empty flags | 0.005 ms | 0.005 ms | 4,096 |
| 100,000 cleared + 1,000 future | 1.994 ms | 0.006 ms | 24,576 |
| 20,000 future | 0.495 ms | 0.005 ms | 344,064 |
| 100,000 cleared + 1,000 due | 12.632 ms | 11.031 ms | 24,576 |
| 1,000 due, no cleared history | 10.455 ms | 10.844 ms | 24,576 |

Ten durable set/clear cycles cost 0.034–0.060 ms more per batch (7.6–11.6%). The all-due burst is 0.389 ms slower in this prototype because the deadline index requires ID sorting and index deletion. These are accepted candidates for tradeoff review: routine no-due ticks recur much more often than a thousand-flag expiry burst. They are not a claim that every flag operation improves. Index creation took 0.328–2.625 ms CPU in one observation per fixture; those are not percentile estimates.

Validation must cover populated reopen without the index, v16 upgrade, due ID order different from deadline order, future/open-ended/cleared exclusions, outer rollback, unchanged audit on reopen and no-op expiry, and natural query-plan use. Exact committed before/after measurement follows verification. No production speedup is claimed from the prototype alone.

A second frozen prototype adds explicit control/index modes without changing measured production operations (`flag-index-controlled.mjs`). Both completed all five cases. The A/A control matched expiry within 1.2% and durable writes within 1.2%. The A/B repeat reproduced no-due 100k-history CPU 2.352→0.016 ms and 20k-future 0.497→0.006 ms. Ten durable set/clear cycles added 0.050–0.059 ms; the all-due burst added 0.496 ms (11.904→12.400 ms). Raw `mini-flag-index-{control,index}-repeat.json` reports retain the drift and costs. These controls strengthen the prototype conclusion without replacing exact production measurements.

## Exact production pair

Committed baseline `979d3129` and candidate `e24c2501` ran the unchanged full 24-case matrix sequentially on the same M4 Mini / Node 24.18.0 / boot. The strict comparator accepted exactly `schema.ts` and `store.ts` as source changes. No-due expiry with 100,000 cleared and 1,000 future flags fell from **2.691 to 0.007 ms CPU** and 2.689375 to 0.006125 ms wall time (15 samples per side). Reports are `mini-read-hotspots-flags-{baseline,candidate}.json` and `mini-read-hotspots-flags-comparison.json`. This confirms the prototype with production index installation.

Verification: 188 core tests and 46 runner/Cell tests passed on the Studio, along with all v2 TypeScript checks and build. The subsequent combined task-supply/main integration passed 190 core tests, 69 focused daemon tests, all v2 checks, and build on the Mini. The independent review is `docs/review/2026-09-07-perf-flag-expiry.md`.
