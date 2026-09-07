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
