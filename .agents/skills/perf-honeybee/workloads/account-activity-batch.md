# Batch account activity runtime reads

Predeclared acceptance: zero excess runtime reads (at most one per bee, zero for an empty account roster), at most one roster and admission-list read per report, exact activity facts and unchanged durable state across 32 mixed-state cases. Preserve existing inactive, transfer, expiry, reopen and admission controls.

Use the exact JSON recipe with Node 24.18.0 and an absolute HIVE_PERF_OUT. Keep every arm including expected baseline assertion failures. No provider, process or live store is used. This measures synchronous store-call counts only, not CPU, latency, RSS or fleet admission cost. A per-call Map of account totals adds temporary objects but retains no cache.

Three alternating paired executions retain all six arms in baselines/account-activity-batch.json, including expected baseline count failures. All 96 paired results match. At 8 accounts/1200 bees, runtime calls fall 9600→1200 and roster/reservation scans 8→1; one account stays 1200→1200 and zero accounts stays 0. Baseline errors in the initial fixture setup are outside the retained pairs. The final collector derives series identity from fixture protocol, hostname, Node version, OS and architecture; another population is not silently comparable.

The 2026-09-25 root receipt refreshes the current-source control (32 cases). Its embedded comparison retains the 2026-09-24 paired gain at the original source hashes; it is historical evidence, not a newly measured improvement.
