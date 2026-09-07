# Retained delivery bookkeeping review

Scope: author `0320278f`, integrated as `6e4447d4`. The production change adds one fresh prune operation and two store seams; it does not change urgency, mail order, transactions, or driver actions.

The critical hazard is rollback. Clearing process-local dedup state from an uncommitted empty mailbox would allow duplicate notifications if an outer transaction restores the message. `inTransaction` is derived from the existing depth and checked before querying or clearing. Table-driven tests run the actual nested step after markDelivered, cancelMessage, and deleteBee, throw from the outer transaction, and assert restored mail and preserved notification deduplication. A later committed empty step clears. This proves the relevant safety boundary with real store execution.

The empty probe includes all pending mail, including stopped targets. It does not substitute live delivery work for the global pending queue. I1-disabled interrupt state receives the same protection. The synchronous step cannot interleave another JavaScript writer between its final probe and clear; it only discards IDs for messages already absent or terminal at that point. New sends receive new IDs.

No blocking correctness finding. The measured tradeoff is roughly 1–2 microseconds with nonempty retained sets. Thirty drained cohorts remove all 30,000 obsolete I1 IDs and reduce final post-GC heap by 646,304 bytes in both repeats. RSS is higher in those captures, so acceptance as an RSS optimization is explicitly unsupported. Standing-backlog retention and rotated-generation bookkeeping remain open.

Combined build, all v2 typechecks, core 201/201, serial daemon 271 pass/one platform skip, and capture 7/7 pass. [Full measurements and limits](../performance/2026-09-07-exhaustive/retained-dedup-results.md).
