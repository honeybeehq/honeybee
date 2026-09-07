# Reusing the mailbox history statement

Accepted `b14f8df4` changes only listMessages from per-call DatabaseSync.prepare to CoreStore's existing stmt cache. The SQL template is byte-identical and both placeholders still bind the same Bee. The cache gains one statement per store after first use, independent of the number of Bees queried. It stores a prepared statement, not message results, so transaction visibility and delivery/cancel updates remain live.

Repeated empty reads fell from 6.981 to 0.311 microseconds CPU per call in 1,000-call batches. Twenty-row reads fell from 25.957 to 18.438 microseconds, about 29%. The 1,000-row comparison is nearly unchanged; fetching and mapping rows dominates. The unchanged-source A/A control is retained. These batch-throughput measurements use a different fixture and clock boundary from the earlier C10 one-call history ruler, so do not multiply or chain their speedups.

| Rows | Calls per batch | Before CPU µs/call | After CPU µs/call | Change | A/A before / control µs |
|---|---:|---:|---:|---:|---:|
| empty | 1,000 | 6.981 | 0.311 | -95.55% | 6.953 / 6.971 |
| twenty | 1,000 | 25.957 | 18.438 | -28.97% | 25.981 / 25.961 |
| thousand | 20 | 898.400 | 887.000 | -1.27% | 883.950 / 888.900 |

## Evidence and limits

[Canonical A/A](evidence/mini-stmt-cache-canonical-aa.json) and [A/B](evidence/mini-stmt-cache-canonical-ab.json) ran serially on M4 Mini, Node 24.18.0, one boot. Distinct C10 module roots are byte-identical for A/A; treatment b14 differs only in store.ts. The complete runtime/package fingerprint matches the integrated source. Tests are deliberately outside that runtime fingerprint. SQLite's version is not separately recorded; the exact Node runtime is. All raw batch CPU/wall values, source hashes and module URLs are retained.

The [frozen ruler](tools/honeybee-mailbox-statement-cache-ruler.mjs) is SHA-256 `0ebd2d2d9184624cedf9d0be49e6d98de9154b9e4d717a939c330c5edc21233f`. It seeds a real running Bee through public APIs in one transaction, with 0, 20 or 1,000 64-byte messages and two-thirds delivered. Identical closed-file copies start both sides. Each operation has six warmup batches then 30 timed batches per side in ABBA order. CPU and wall are measured once around the whole batch and divided by its call count. This measures warmed cache hits in a long-lived store, not first-use or whole-daemon latency. Shared-process GC and warm OS caches remain limitations. Small mailboxes are illustrative; production prevalence was not measured.

Separate SQL diagnostics prove one prepare on the cold first read on both sides. After timing, 1,000 warmed calls produce 1,000 prepares before and zero after, with identical SQL, exact call/row counts and no SQL instrumentation inside clocks. The large case analogously has 20 versus zero prepares. Cold rows match a public primary-key read oracle. Full state/audit hashes and exact rows remain unchanged after the workload.

## Allocation traffic

A [separate profile run](evidence/mini-stmt-cache-canonical-allocation-ab.json) samples V8 allocations at 4,096-byte intervals and includes objects collected during the measured read batch. Setup, SQL diagnostics and headline timing loops are outside each profile. Each side has one profile per shape, so these values are diagnostic samples, not precise percentage estimates.

| Rows | Profiled calls | Before sampled bytes | After sampled bytes |
|---|---:|---:|---:|
| empty | 1,000 | 140,632 | 57,568 |
| twenty | 1,000 | 17,038,856 | 17,085,704 |
| thousand | 20 | 16,699,008 | 17,148,576 |

The empty case shows less V8 allocation traffic. The nonempty cases are dominated by row materialization and mapping; no allocation improvement is claimed for them. Profiles cover one batch, including only 20 calls in the largest case. They do not measure retained heap, native SQLite statement memory, process RSS, or overall system RAM. The existing statement Map has no eviction; one additional retained statement is the cache cost.

Mini build, all v2 typechecks, core 230/230 and daemon/CLI 368 plus one platform skip passed at the measured source. The five union tests include full-row identity, both-arm binding, inside-transaction read-your-writes and rollback, heavy history, plans and old-store migration. No new mirror-of-implementation test was added for the cache call. [Independent ruler review](designs/honeybee-c03-ruler-review.md) found no measurement blocker. Its warmup count is six batches per side, twelve across both; its "typical" description is treated as illustrative here. The prior legacy compiled-suite control still has 67 identical failures and is not newly claimed green.
