# Acceptance measurements for the synthesized auto-title change

No candidate is accepted yet. The parent owns the serial Mini queue. The existing Cell captures and combined gates are complete.

## Planning evidence already captured

aggregate-cost-study.mjs/json compares a cached combined COUNT/MAX aggregate with the current public listMessages on one actual CoreStore connection. Node24.18 M4, clean47cd5d6b. Twelve ABBA batches per operation, all raw CPU/wall batches retained. This is a planning diagnostic with offline-seeded valid mailbox rows, not a production candidate A/B or complete dispatcher result. At100k rows, aggregate CPU is3.209ms versus134.370ms fullread. Empty aggregate0.566us costs more than empty fullread0.323us. No fleet or retained-RAM claim.

## Before/after ruler contract

Use two distinct immutable roots and independent source module instances. Assert exact runtime/package delta for the synthesized change, same boot, source/tool hashes at start and end, and byte-identical closed SQLite seed copies. Timing excludes preparation, state oracles, SQL tracing, allocation sampling and broad verification. Run A/A on distinct byte-identical pre-change roots before A/B. Keep all samples and rejected-run reasons.

Drive the real createStoreAutoTitleDispatcher with a deterministic clock, real CoreStore and a separate temporary bookkeeping file per side. Provider calls use a deterministic failing or held test provider. Never call a real naming provider. Seed public Bee/mailbox state transactionally. If fixture scale requires offline mailbox rows, label missing synthetic audit/projection records and prove every row against the actual public PK read outside timing.

Create identical bookkeeping seeds from the before-module's actual normalization/signature helpers. Quiet backoff states use attempts high enough for the existing600-second cap. Advance both sides through identical one-second logical scan steps, keeping timed quiet steps within that cap. Preserve exact bookkeeping, outcomes and zero unexpected launches. Do not hide first-scan cost in a warmed headline: report it separately before warming.

Quiet scenarios:
-1000empty deferred Bees.
-1000single-thin-message deferred Bees.
-One100k envelope-only deferred mailbox.
-One100k substantive mailbox in backoff.
-100small backoff Bees with a ready Bee at head or tail, checked outside timing for exact launch order.
-At least one fleet of multiple giant histories as an explicit stress run; size after smoke so fixture setup stays bounded. Do not extrapolate one giant into a claimed measured fleet result.

Changed scenarios:
-One changed Bee per scan and all reached Bees changed.
-Unrelated output/audit activity during otherwise unchanged scans, to reject a global invalidator if it repeatedly reloads giant contents.
-Backoff expiry and selected first-task cancellation, comparing exact generator context and retry resets.
-Roster deletion/recreation and in-transaction scans, checked for committed-only cache publication and bounded state.

Retain per-scan CPU/wall samples. Use balanced ABBA ordering and enough batches to expose normal variation. Count full mailbox reads, SQL prepares/reads, provider launches and bookkeeping saves in a separate instrumented replay of exactly the same steps. No test-hook counters in the public production API.

Run V8 allocation sampling separately around tick execution with complete ancestry retained. Call it allocation traffic, not retained RAM. For retained JS heap, use separate process runs per source with identical fixture and GC procedure, preserving heapUsed and process RSS at cold, warm and post-delete phases. Record that RSS includes SQLite and runtime caches and is not a per-cache attribution. Retained entry bounds must also be demonstrated by functional tests or heap retaining paths, not inferred only from noisy RSS deltas.

If the chosen design touches CoreStore.tx, additionally measure public send/cancel100-cycle batches, unrelated transactions, nested outer transactions and create/delete churn. Assert exact durable state and audit parity. Compare candidate read gains with write overhead before acceptance. No build or broad suite overlaps any captures.
