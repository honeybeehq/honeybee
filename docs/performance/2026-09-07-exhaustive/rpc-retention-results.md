# RPC idempotency retention index

Accept the single `rpc_idempotency(created_at)` index from `c5d79863`. Lookup, insertion, count, pruning, transaction boundaries, key uniqueness, and result replay code are unchanged. The index supplies the existing `ORDER BY created_at, rowid` eviction order without a temporary sort; SQLite's implicit rowid preserves timestamp ties.

## Measured gain and costs

M4 Mini, Node 24.18.0, frozen ruler hash `88bc3630…ac6d87`, identical copied databases, symmetric warmup, 15 ABBA rounds (30 samples per side), real CoreStore WAL/NORMAL transactions. A distinct-checkout pre-index A/A control precedes A/B. Every retained key, result, order, count cap, null result, audit head, and durable reopen is checked.

| Operation | Before CPU p50 | With index CPU p50 |
| --- | ---: | ---: |
| Insert starting empty | 0.013 ms | 0.018 ms |
| Insert starting at 1,000 entries | 0.014 ms | 0.018 ms |
| Evict oldest at 10,000-entry cap | 0.265 ms | 0.037 ms |
| First populated reopen, 1,000 entries | 0.283 ms | 0.415 ms |
| First populated reopen, 10,000 entries | 0.351 ms | 1.336 ms |

The pre-cap insertion cost is real: about 4–5 microseconds versus 1 microsecond observed A/A difference. At the default cap, each new record saves about 228 microseconds. The one-time 10,000-entry index installation adds about 1 ms in warm-process/copied-file conditions; this is not cold daemon startup. Those absolute costs are accepted for bounded steady-state eviction.

The index occupies 4 KiB empty, 20 KiB at 1,000 entries, and 144 KiB at 10,000 entries. Closed-file byte deltas match index pages for these fixtures; no VACUUM is used. A/A has zero storage delta. Idempotency retention remains configurable, so these sizes do not bound stores configured above 10,000 entries.

The separate strict 24-case canonical matrix corroborates eviction CPU 0.236→0.043 ms; lookup CPU stays 0.006 ms and a pre-cap insert rises 0.017→0.024 ms. Reports `mini-read-hotspots-c18-*` allow only schema.ts to differ. Raw paired evidence is `mini-c18-tradeoff-{aa,ab}.json`; [the disposable ruler](designs/c18-tradeoff.mjs) and Studio structural smokes are retained. SQL diagnostics run separately from timing.

## Correctness and verification

The exact frozen candidate passed Mini build, all v2 typechecks, and full core 188/188 on its base. The focused 12 tests include timestamp ties in an order different from key order, backwards clock values, cap changes, duplicate-key rollback, null results, reopen/index reinstall, and the natural exact DELETE plan. No schema version bump is introduced. Combined revision `6e4447d4` also passed build, all v2 typechecks, core 201/201, serial daemon 271 pass with one platform skip, and all seven current capture tests. This includes the concurrent runner-service and empty-rebase repairs. Logs are `verification/mini-c18-z01-integrated-*.log`.

[Review](../../review/2026-09-07-perf-rpc-retention.md). Larger configured caps, RPC payload serialization, and non-retention RPC paths remain separate inventory items.
