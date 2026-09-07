# Removing the redundant pending index

Accepted production `219b7969`, integrated as `10c25dfc`. The covering metadata index is retained. The old mailbox_undelivered index is no longer created, and public open drops it after its replacement exists. Public query text is unchanged. This decision is separate from accepting the covering index.

Removing duplicate pending entries reduces durable write CPU and releases database pages for reuse. Full-message reads still fetch mailbox rows through the wider remaining index. The possible small read cost is accepted and recorded below; this is not a universal read speedup.

Mini compared immutable `b89d628d` and `219b7969`, with a distinct byte-identical baseline checkout for A/A. A runtime-source fingerprint permits exactly schema.ts and store.ts to differ. The frozen ruler uses identical initial SQLite files, real UUID Bees, 3 warm ABBA rounds and 15 measured ABBA rounds, giving 30 read samples per side. Public open supplies the actual migration; offline DDL is not substituted for production behavior.

CPU medians are milliseconds. Writes are 100 public durable cycles per sample, with 10 measured samples per side after a warm batch.

| Fixture | Whole step before / after | Send/cancel before / after | Send/deliver before / after | Send/expedite/cancel before / after |
|---|---:|---:|---:|---:|
| 1,000 pending × 64 B | 0.317 / 0.318 | 10.082 / 9.545 | 10.082 / 9.532 | 12.277 / 11.483 |
| 20,000 pending × 64 B | 5.613 / 5.620 | 9.004 / 8.742 | 10.149 / 9.698 | 13.346 / 12.770 |
| 100 pending × 1 MiB | 0.053 / 0.054 | 9.002 / 8.442 | 10.311 / 9.613 | 12.031 / 11.315 |
| 20 pending + 100,000 delivered | 0.027 / 0.027 | 10.306 / 9.723 | 10.011 / 9.801 | 12.860 / 11.607 |

A/A write variation reaches roughly 0.46 ms per 100 cycles in these fixtures. The smallest write changes are therefore not individually decisive. All 12 A/B write medians favor removal, and eliminating one index mutation per affected row is directly established by the schema. No precise fleet-wide write percentage is inferred.

| Fixture | Per-bee full pending read before / after | Global full pending read before / after | Old index pages freed | First open wall before / after, ms |
|---|---:|---:|---:|---:|
| 1,000 × 64 B | 0.817 / 0.834 | 0.813 / 0.824 | 14, 57,344 B | 0.321 / 0.406 |
| 20,000 × 64 B | 16.809 / 17.260 | 16.561 / 16.942 | 265, 1,085,440 B | 0.441 / 0.827 |
| 100 × 1 MiB | 20.257 / 19.892 | 19.576 / 19.653 | 3, 12,288 B | 0.490 / 0.620 |
| 20 + 100,000 delivered | 0.022 / 0.023 | 0.018 / 0.018 | 1, 4,096 B | 0.402 / 0.517 |

The 20,000-message per-bee read is 2.68% worse and the global read 2.30% worse. A/A per-bee CPU moved from 17.772 to 16.585 ms and global CPU from 16.457 to 16.674 ms. These samples cannot isolate a stable 2% regression from runtime variation, but a wider index plausibly costs more to scan, so the adverse result remains part of the tradeoff.

Closed database file sizes immediately after open are identical on both sides. DROP releases pages to the freelist; it does not shrink the file. Later measured writes consume those free pages, and the after-write files grow less. First-open figures come from six fresh-file opens per side, with copy and close outside the interval and warm OS caches. Later reopen idempotency is tested, not separately timed here. A downgrade recreates the old partial index by scanning the whole mailbox to filter delivered history, then the next upgrade drops it again.

The independent C09/C10 read matrix retains all 15-sample raw captures. Small pending-page and quiet-tick differences are near measurement resolution. Listing all 100,000 messages measured 133.526 to 136.107 ms CPU, with A/A 133.526 to 134.752. Listing 20 messages among 100,000 unrelated rows measured 3.582 to 3.601 ms. That unfiltered listMessages query cannot use either pending partial index and remains an optimization target.

[Tradeoff A/B](evidence/mini-pending-drop-tradeoff-ab.json), [A/A](evidence/mini-pending-drop-tradeoff-aa.json), [read matrix A/B](evidence/mini-pending-drop-reads-ab.json), and [read A/A](evidence/mini-pending-drop-reads-aa.json) retain source/tool/boot provenance, raw samples, state/audit parity, actual query plans and storage inspection. The [frozen ruler](designs/honeybee-pending-drop-tradeoff.mjs) has SHA-256 `ed5e25e10dd25a8c9da4fcf1d301fea5a77362df820f8c9ec495512be64e4c72`.

Mini candidate build, all v2 typechecks, 225 core tests and 364 daemon/CLI tests passed, with one platform skip. Tests cover reinstalling the replacement on old schema, repeated old-index recreation and drop, unchanged schema version, selective full-body access, FIFO and the empty-mail guard. Parent review found the original migration test captured expected rows before creating the old index and compared only IDs for the global list. A separate tests-only correction is required to compare actual old-plus-covering reads with new-only reads using two interleaved Bees and full rows. The immutable tradeoff ruler already compares the distinct production sides; no performance rerun is needed for that test correction.

The [original redundancy note](designs/honeybee-mailbox-undelivered-redundancy.md) is preserved as written. Its initial same-module write diagnostic is invalid because public open recreated the old index. Its pending-bounded downgrade wording is also superseded here: partial-index creation reads the entire mailbox. Neither claim supports acceptance.
