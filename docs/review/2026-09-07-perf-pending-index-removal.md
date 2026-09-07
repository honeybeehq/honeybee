# Pending index removal review

Reviewed `219b7969`, integrated as `10c25dfc`, against `b89d628d`. No unresolved production behavior defect was found. One test-fidelity follow-up remains before final integration closes.

The replacement index has the same bee_id/id order and delivered_at IS NULL predicate. Exact public metadata SQL remains covering. Full-body queries keep selective per-bee seeks or an ordered pending-only scan and fetch body rows. Public query text does not change. The captured query plans and exact paired outputs support read parity, with possible wider-index scan cost explicitly accepted.

The constructor wraps ensureSchemaVersion in one BEGIN IMMEDIATE transaction. Replacement installation precedes removal, and ordinary open failure rolls back the transaction. This is a source-level atomicity argument, not a crash-injection experiment. Version-7 migration remains covered by the earlier public-open fixture. Reopening and downgrade recreation are safe, but an old build rebuilds its partial index by scanning all mailbox rows. Freed pages are reusable space, not immediate file shrink.

The author migration test initially compared new-only reads with new-only reads, because it created the old index after taking expected snapshots. Global equality covered IDs on one Bee, not full content and cross-Bee order. Parent requested a tests-only correction using real old-plus-covering snapshots, interleaved sends to two Bees and full-row global equality. All other plan, schema, reopen and emptiness assertions must remain.

Measured acceptance is based on immutable production modules, identical starting files and paired public operations, not the discarded same-module diagnostic in the design note. The [results](../performance/2026-09-07-exhaustive/pending-index-removal-results.md) preserve small adverse full-message reads, write controls, first-open overhead and page-reuse limits. The candidate passed Mini build, v2 checks, core and daemon/CLI suites. Final combined verification with current main is tracked separately.
