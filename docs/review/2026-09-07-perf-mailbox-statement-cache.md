# Mailbox statement-cache review

The single production change in b14f8df4 reuses CoreStore.stmt for listMessages. The existing Map is keyed by the constant SQL text, which is byte-identical to the prior query; both Bee parameters are rebound on every all call. No result caching or new invalidation policy is introduced. Repeated all calls reset statement execution, and the existing real-store tests prove new rows, arm moves, cancellation and uncommitted rollback reads remain visible.

The private cache is connection-owned and gains one entry for this query, not one per Bee or parameter value. It has no eviction. This is a deliberate native-memory retention cost of one prepared statement; the V8 allocation profile cannot quantify it. No API, migration, row-mapping or automatic-title change is present.

The [measured comparison](../performance/2026-09-07-exhaustive/mailbox-statement-cache-results.md) proves the actual prepare count separately from timing and records raw ABBA samples plus the identical-source control. Empty and twenty-row calls improve; the thousand-row case is not claimed as a meaningful bulk-read gain. The reviewer approved the frozen ruler with scope clarifications incorporated into the result document.

Exact measured-source Mini build, all v2 checks, 230 core tests, 368 daemon/CLI tests plus one platform skip pass. Source fingerprints match the integrated runtime. The earlier legacy compiled suite remains red with the documented identical-control failures. No deployment or push is included.
