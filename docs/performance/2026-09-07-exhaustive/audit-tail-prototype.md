# Audit-tail index tradeoff prototype

The frozen disposable ruler `80e97aa7…37778` measures one real CoreStore module at `824485f9` against two byte-identical copied databases before treatment. Candidate treatment installs `audit_by_bee ON audit(bee_id) WHERE bee_id IS NOT NULL` offline. No production change is included in this experiment. Distinct databases share one process/module; ABBA reduces drift but does not remove shared GC or cache effects.

M4 Mini, Node24.18.0, one million audit rows per fixture, UUID-sized Bee IDs, 15 ABBA read rounds and30 samples per side. Separate global reads and ten batches of100 durable public renames expose unchanged-path and write costs. Every selected row, order, payload, cursor, mutation audit chain, durable reopen, index plan, and closed-file byte count is checked. Index installation is timed as one offline CREATE INDEX exec per fixture; it is not daemon startup or a percentile.

| Fixture | Per-Bee tail CPU p50 before → index | 100 renames CPU p50 before → index | Index bytes | Install wall |
| --- | ---: | ---: | ---: | ---: |
| 20 target rows spread through1M | 40.986→0.039ms | 2.176→2.692ms | 45,383,680 | 306.37ms |
| No target rows | 40.080→0.012ms | 2.225→2.640ms | 45,383,680 | 303.56ms |
| Every row belongs to target | 0.081→0.093ms | 2.249→2.598ms | 45,531,136 | 282.56ms |
| Half null-scoped,20 target rows | 34.690→0.055ms | 2.209→2.580ms | 22,691,840 | 158.04ms |

Global tail CPU remains0.076–0.081ms. A/A per-Bee pairs are40.366/40.398,39.803/39.748,0.079/0.079, and34.620/34.526ms; all storage deltas are zero. A/A100-rename batches differ by−0.010 to+0.054ms, smaller than the candidate's+0.349 to+0.516ms. The dense-tail increase of12microseconds is real in this capture and remains visible.

The cost is about43.3MiB per million non-null UUID-scoped audit rows, plus roughly3.5–5.2microseconds per measured rename. Those costs are accepted for the proposed sparse-tail improvement. Long-term audit retention and daemon-down JS filtering remain open.

The natural plan exposes a required companion fix: SQLite starts using the general index for `latestBeeDeletedRow`, which can scan a dense Bee history. The production candidate must preserve the existing narrower `audit_bee_deleted_bee_seq` plan explicitly. Its semantic and historical-cursor tests, full verification, and immutable production before/after measurements remain pending. No production result is inferred from offline installation alone.

Evidence: `mini-c25-canonical-{aa,ab}.json`, [frozen ruler](designs/c25-ruler.mjs), and Studio structural smokes. [Design and alternative index shapes](designs/audit-tail.md).
