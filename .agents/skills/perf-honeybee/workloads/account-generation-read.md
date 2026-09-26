# Historical generation account attribution

`AccountsService.accountForGeneration` maps delayed account flag evidence to the account that owned that runtime generation. The query returns only the eligible source account, ordered by reconciliation generation, creation time and ID. It deliberately includes released and expired transfers; a missing source account still returns null. Every call reads current stored facts. No schema, index, cache or account policy changes.

Run the exact command in [the record](account-generation-read.json) with Node 24.18.0 and an absolute `HIVE_PERF_OUT`. The collector uses real SQLite and the public service method, counting calls to JSON.parse for exact seeded admission receipt strings only while that method runs. Fixture setup, expected-output construction and durable-state hashing are outside the counter.

The [retained receipt](baselines/account-generation-read.json) embeds all six arms from three alternating pairs against base `55fa1e4748208bbca05ae328512a237739c4f774`. Each arm has 64 cases: 0/12/120/1200 reservations, 0/4096 bytes of receipt padding, and eight lookup variants. All 192 paired full account digests match, with no durable writes. Baseline receipt parses are 0/12/120/1200 per lookup; candidate parses are zero. Baseline tests intentionally fail the zero-work gate after retaining all samples. Separate controls exercise inserts, account updates, rollback, reopen, expired/released transfers, null and missing source accounts, stable ties and fallback.

These are deterministic parsing counts on the receipt's declared host and runtime. SQLite scanning, latency, CPU, RSS and provider or credential recovery are unmeasured. Supported store writes produce valid JSON receipts; arbitrary corrupt receipt bodies are outside parity coverage. Linked account activity gates were rerun on the current sources; their historical paired gain remains separately identified.

The 2026-09-26 top-level receipt reruns the 64-case control after admission activity batching. Its embedded 2026-09-25 comparison remains historical at its original source hashes.
