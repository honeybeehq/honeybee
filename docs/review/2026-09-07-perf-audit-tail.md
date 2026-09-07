# Audit-tail index review

Reviewed author 485a6c3f and integration e17374fc against their parents. The change is an additive partial index plus one explicit existing-index selection; public audit query predicates, sequence ordering, cursor and limit handling are unchanged. NULL-scoped rows stay outside the index; global tails retain their sequence path.

The broad index creates a real planner risk for latestBeeDeletedRow. The explicit audit_bee_deleted_bee_seq selection is necessary: otherwise a deletion lookup can walk a dense Bee history. CoreStore installs schema before this private query can run. The regression suite captures the actual prepared SQL plan and drives historical mail lookup through a deleted Bee, including cursor behavior. Rollback and reopen cases verify authority remains unchanged. Malformed unselected payloads remain unparsed while selected malformed data still fails.

The other audit queries were inspected for bee_id predicates and competing indices. Expression-indexed mail lifecycle queries and global sequence queries retain their shapes. The 24-case immutable read matrix shows the sparse tail gain; unchanged-path timing shifts and the separate offline-index write/storage/dense-tail costs are recorded in audit-tail-results.md. No constant-memory, startup, or global read speedup is claimed.

Five focused regression tests passed, along with author build/typechecks and the Mini production core suite. Final combined build, all v2 typechecks, 218 core tests and 364 daemon/CLI tests passed, with one platform skip. No remaining correctness blocker was found. Long-term audit retention and daemon-down filtering are separate open work.
