# Stop-recovery index review

Reviewed `6d2677b1..62cfe73c`, production schema only. Accepted after Mini build, v2 checks, 220 core tests, canonical A/A and A/B, and UUID-sized read/write/open/storage tradeoffs.

The initial tests inserted malformed history under literal names while public createBee returned UUIDs. Follow-up uses the actual IDs. The initial claim pin only described a simplified scan. Follow-up captures and explains every real commands read prepared by public claimNextCommand. Pending stop/revive and list plans keep their indexes; actual claim does not adopt the new index.

The partial predicate safely excludes queued/failed commands and NULL generation is excluded by the unchanged equality. Rollback and all public transition edges are tested. Adding the index does change possible LIMIT-1 visitation order on externally corrupted mixed JSON history. Tests now state only what they prove: no parse during index build, both plans raise on all-malformed buckets, exact supported JSON-boolean behavior. No mixed-corruption order guarantee is asserted.

The generation index does not solve one-generation residual JSON scanning. Accepted costs and remaining work are in [the evidence report](../performance/2026-09-07-exhaustive/stop-recovery-index-results.md). No unresolved correctness blocker identified for supported store writes.
