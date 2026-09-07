# Parent scoring rubric, 0 to 3 each

1. Preserves exact normalized decisions, launch context, saved bookkeeping, retry/watchdog/slot/roster behavior, with executable counterexamples identified.
2. Handles rollback/uncommitted id reuse, delete/recreate, restart/reopen and reentry without stale contents or new authority.
3. States finite retained-state bounds and cost; avoids O(total message bodies) cache or unbounded stale Bee entries.
4. Explains actual read/invalidation complexity and an isolation-valid before/after CPU/allocation/storage plan with adverse workloads.
5. Keeps normalization/policy in daemon and durable facts in core with small deep interfaces; no duplicated predicates or pass-through scaffolding.
6. Gives a minimal coherent implementation sequence with tests and explicit rejected alternatives. No unsupported persistence or latency changes.
