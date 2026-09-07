# Pending metadata without mailbox table reads

Accepted production `6764453a`, migration proof `cfbe5781` and plan-test follow-up `45b7579e`, integrated with array-row mapping as `b89d628d`. A partial covering index contains `(bee_id, id, urgency, enqueued_at, delivered_at)` for undelivered messages. Both public projection queries are unchanged. The final key column is required for SQLite to recognize this covering plan, despite always being NULL in this partial index.

The first offline prototype omitted delivered_at from the key. SQLite kept the old index, read CPU did not improve, and writes became more expensive. That rejected shape and its A/A and A/B reports remain in evidence. The second prototype proved the corrected plan. The acceptance measurements below use distinct immutable production modules and actual public constructor installation, not offline DDL.

Mini compared `6d2677b1` against the production code in `cfbe5781`, with an exact schema/store source delta. Test-only follow-ups do not change those production bytes. Each side began with the same pre-index file. Three warm ABBA rounds preceded 15 measured ABBA rounds, 30 samples per side. Whole-core CPU medians are milliseconds.

| Held mailbox | Before | After | A/A before / control |
|---|---:|---:|---:|
| 1,000 × 64 B | 0.568 | 0.544 | 0.549 / 0.554 |
| 20,000 × 64 B | 11.395 | 10.413 | 11.384 / 11.351 |
| 100 × 1 MiB | 11.669 | 0.098 | 11.505 / 11.585 |
| 20 pending, 100,000 delivered historical rows | 0.033 | 0.032 | 0.031 / 0.031 |

Each fixture uses one real-running Bee with held idle-urgency mail and a FakeDriver. No worker or live runtime is started. The large-body I1 projection fell from 11.556 to 0.066 ms CPU; work projection fell from 11.599 to 0.071 ms. Captured actual plans show covering reads. This avoids mailbox table access associated with large bodies. No retained-memory reduction is claimed here.

[Production A/B](evidence/mini-pending-covering-tradeoff-ab.json), [A/A](evidence/mini-pending-covering-tradeoff-aa.json), and the [frozen ruler](designs/honeybee-pending-covering-tradeoff.mjs) retain every read, write and open sample, exact state/audit parity, plans, source hashes and closed storage. Ruler SHA-256 is `5ad662b28296297a8e57141b1fff7fa01480d2c814ebf788c95745fa75f19d30`.

Write costs are accepted. Per 100 public durable cycles, send/cancel added 0.469–0.656 ms CPU; send/deliver added 0.376–1.022 ms; send/expedite/cancel added 0.589–1.107 ms across fixtures. Each has ten measured batch samples per side following one warm batch. A/A variation remains in the raw report. The wider key indexes urgency, so expedite costs are included.

The index uses 61,440 bytes for 1,000 pending messages, 1,130,496 for 20,000, 12,288 for 100 large messages and 4,096 for 20 pending messages with 100,000 delivered rows. Delivered bodies are not indexed. First open on fresh old-file copies rose from 0.302 to 0.584 ms, 0.438 to 5.140 ms, 0.485 to 12.278 ms and 0.404 to 2.941 ms respectively. These six samples per side include migration/index creation but exclude copying, close/checkpoint and inspection. OS caches are warm. The partial-index build must still inspect historical rows to filter them.

The index installs after the pre-v8 urgency migration. A raw version-7 fixture without urgency proves public open adds the column before building the index and preserves live/parked pending mail, delivered history and pre-v9 NULL boot evidence. Public transition tests cover send, delivery, cancellation, urgency changes, delete, rollback and reopen. The first full core run exposed three old-index-name pins; correcting them revealed a fourth pin previously masked by the first failure. The final tests require covering projection access while preserving selective seeks and ordering checks. Boolean probes allow either equivalent partial index.

Standalone Mini build, all v2 checks, all 221 core tests and 364 daemon/CLI tests passed, with one platform skip. Combined production passed 225 core tests and all daemon behavior checks; the unrelated CLI ambiguity assertion was fixed separately. The failed core run and failed smoke iterations are retained. Early prototype smokes corrected a wrong method name and a diagnostic connection opened while the writer retained its exclusive lock. None of those smoke timings govern acceptance.

The older mailbox_undelivered index is retained in this accepted change. The subsequent [index-removal decision](pending-index-removal-results.md) independently accepted removing its redundant entries after read, write, first-open and page-reuse measurements. The covering-only numbers above still include both indexes.
