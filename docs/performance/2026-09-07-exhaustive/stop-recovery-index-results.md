# Stop recovery by generation

Accepted production `27150d70` and test-fidelity follow-up `62cfe73c`, integrated as `81ca6853` and `ce9558db`. The partial index contains stop commands in done/running status keyed by bee and generation. The query, strict JSON boolean predicate, command transitions and schema format are unchanged. The index never parses JSON.

On Mini, the existing canonical 100,000-command boot case fell from 11.386 to 7.256 ms CPU. The pending-stop case stayed at 0.037 ms. These are 15 uninstrumented samples per side, with a distinct immutable A/A control and strict schema-only source comparison. [Canonical comparison](evidence/mini-d05-62cf-ab.json) and [control](evidence/mini-d05-62cf-aa.json) retain every case.

The separate tradeoff ruler uses UUID-sized bee keys and 100,000 historical commands. Each side begins with the same pre-index file and a distinct immutable production module. Runtime generations come from public APIs; valid settled command history is inserted offline with a foreign-key check. Reads use 3 warm ABBA rounds followed by 15 measured ABBA rounds, 30 samples per side. CPU medians below are milliseconds.

| History | Predicate before | After | Boot before | After |
|---|---:|---:|---:|---:|
| One generation | 12.547 | 8.104 | 12.728 | 8.238 |
| 200 generations | 6.767 | 0.351 | 7.209 | 0.395 |
| Half stop, half send_wake, one generation | 9.539 | 8.520 | 9.750 | 8.664 |
| Predicate outside all generations | 6.717 | 0.001 | 7.244 | 0.449 |

The off-generation row's boot still reads the current generation; only its predicate probes outside history. The same-generation case still fetches and parses every candidate's args. This index reduces that cost but does not solve its scaling.

[UUID A/B](evidence/mini-stop-tradeoff-v2-ab.json), [UUID A/A](evidence/mini-stop-tradeoff-v2-aa.json), and the [frozen ruler](designs/honeybee-stop-recovery-tradeoff-v2.mjs) retain source, tool and boot hashes, raw timings, exact state/audit parity, index plans and storage. Ruler SHA-256 is `b28222ef80d885bfd3f3633d8283554f8279f7a02b66f3034754cac85b603281`.

Costs are accepted. Per 100 durable public enqueue/claim/complete cycles, CPU rose by 0.52–1.00 ms across these fixtures. Enqueue/claim/fail batches rose by 0.71–1.59 ms. These are six batch samples per side after warmup; A/A variation is retained. First public open on a fresh copy of the old file rose from about 0.5 ms to 15.6 ms with half stop history, or 31.5–39.5 ms with all stop history. Six open samples per side include index creation; copying, close/checkpoint and inspection are outside the clock. OS caches are warm, so this is not cold-disk startup. The final index uses 2.36 MB for half stop history and 4.67–4.80 MB for all stop history, including the 700 newly completed write-test receipts. Failed receipts are excluded.

The earlier short-key tradeoff captures are retained as diagnostic fixtures, not production-sized storage estimates. The first smoke rejected an untracked verification dependency symlink before measurement. The next smoke exposed a fixture error: a stop command aimed at an already stopped writer settles without a claim. The corrected ruler revives a usable writer generation outside write clocks. Both failed logs, the partial report and the exact pre-fix ruler are retained. No production assertion was relaxed.

Build, all v2 typechecks and all 220 core tests passed on Mini. Tests exercise public queued/running/done/failed transitions, rollback, exact JSON booleans, actual captured claim SQL, old-history reopen, NULL generations and malformed historical args. Reopen never parses args to build the index; an all-malformed selected bucket still raises on both plans. LIMIT-1 order across mixed valid/corrupt buckets is unspecified and is not claimed equivalent. Supported store writes always serialize valid JSON.

Whole-boot fleet scaling and same-generation JSON work remain open. No deployment or push was performed.
