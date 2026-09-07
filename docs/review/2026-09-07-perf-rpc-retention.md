# RPC retention index review

Reviewed author `c5d79863`, its two-file diff and adversarial tests, and parent canonical/paired evidence. The production change adds one nonunique created_at index to SCHEMA_SQL. Existing table creation precedes it; populated reopen installs it without rewriting authority or changing schema version.

The existing retention subquery orders by created_at and rowid. The new index supplies timestamp order and its implicit rowid tie-breaker; exact selected-key tests cover ties and backwards clocks. Unique-key errors still roll back the insertion and prune transaction; result replay, nulls, count/cap changes, and store methods are unchanged. No cache or alternate authority is introduced.

No blockers found. Natural DELETE plans and full retained-order assertions support the indexed behavior. Parent measurements explicitly accept 4–5 microseconds pre-cap insertion cost, 144 KiB at the default cap, and about 1 ms additional warm populated open time, against roughly 228 microseconds saved per eviction. The index's cost grows with configured retention; results do not promise a fixed size for larger caps.

Frozen-base Mini verification: build, all v2 typechecks, core188/188; focused idempotency12/12 by author. Combined revision 6e4447d4 passes build, all v2 checks, core201/201, serial daemon271 pass/one platform skip, and capture7/7. Newer concurrent Cell-move integration still needs its own combined gate. Evidence and scope are in docs/performance/2026-09-07-exhaustive/rpc-retention-results.md.
