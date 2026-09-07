# Automatic-title cache design evidence

S14 remains open. Two independent architecture packages are frozen, and an independent cross-review is running. No automatic-title production code has changed. The designs must be corrected and measured before either can be accepted.

The [Fable package](designs/autotitle-architecture/fable/design.md) proposes a derived mailbox count/max stamp and skips only unchanged defer/backoff reads. The [Sol package](designs/autotitle-architecture/sol/design.md) proposes committed change tokens and a bounded normalized summary. The [rubric](designs/autotitle-architecture/rubric.md) and [parent scores](designs/autotitle-architecture/parent-scores.md) record the initial comparison before the independent judge. Those scores are provisional, not an acceptance decision.

## The count/max probe costs more than the first estimate

A planning diagnostic on the M4 Mini compared a cached aggregate over both mailbox partial indexes with the current public listMessages. Each operation has twelve ABBA batches. Rows have64-byte bodies, with two thirds delivered. This is a same-process query comparison, not a complete dispatcher A/B. Fixtures use a public-created Bee and offline mailbox rows without matching synthetic enqueue audit records.

| Mailbox rows | Public full-read CPU per call | Aggregate CPU per call |
|---:|---:|---:|
|0|0.323 microseconds|0.566 microseconds|
|20|18.461 microseconds|1.422 microseconds|
|1000|0.880 milliseconds|0.0244 milliseconds|
|100000|134.370 milliseconds|3.209 milliseconds|

The100k aggregate is much cheaper than the full read, but the proposed0.1–0.5ms estimate is refuted on this fixture. An empty aggregate costs more than the already cached empty read. Both facts belong in the design tradeoff. No measured giant-fleet result is claimed.

[Raw samples and plans](designs/autotitle-architecture/aggregate-cost-study.json) and the [tool](designs/autotitle-architecture/aggregate-cost-study.mjs) preserve the Node24.18 source/host identity and all observations. A separate [local structural study](designs/autotitle-architecture/aggregate-plan-study.json) shows index-rowid reads without message-body column reads. The aggregate still visits each matching index entry.

## The read and its cache identity must describe the same state

The [executable design counterexamples](designs/autotitle-architecture/gate-counterexamples.mjs) use the real CoreStore and title policy. [Their results](designs/autotitle-architecture/gate-counterexamples.json) show three obligations:

- The existing retry rule treats lastAt=0 as false. The first gate sketch omitted that condition and would skip a scan that the existing policy generates on.
- A custom listMessages callback can read old contents, commit new mail, then return the old snapshot. Recording a later committed stamp associates those old contents with the new state and can suppress a required title launch.
- Bracketing arbitrary callbacks with equal stamps is insufficient. A callback can return a speculative snapshot after opening and rolling back a transaction, while both external stamp reads observe the unchanged committed state.

These are flaws in proposed protocols, not regressions in shipped code. A trusted store-owned read boundary can avoid the callback protocol; existing custom dependencies should retain their current behavior.

## Commit tracking must follow successful SQL writes

The [nested-error proof](designs/autotitle-architecture/nested-caught-write-proof.json) uses the public transaction and clock seams. A send inserts its mailbox row, then its audit clock throws. An outer transaction catches the inner error and commits the row. Nested calls join the outer transaction; they do not independently roll back.

Any new mailbox change tracker must therefore stage its effect immediately after the successful SQL mutation. Staging only after a method returns successfully would miss this committed row. This evidence does not propose changing transaction semantics.

A second obligation is deletion. An initial-token fallback must not return the same token before and after deleting preexisting mailbox contents. The Core getter needs an explicit absent-row contract and a bound that does not retain historical deletion markers. The author is refining that contract in a separate addendum; the original sketch stays frozen.

## A global connection counter has a different cost

The [total_changes proof](designs/autotitle-architecture/total-changes-proof.json) confirms that the connection count advances through rolled-back writes and resets on reopen. It would need a store-instance fence. It also advances for unrelated writes and audited no-ops, so a busy daemon could repeatedly invalidate an otherwise unchanged giant mailbox. This is a lower-complexity alternative to price, not an accepted cache design.

Two scratch expectations were corrected during this proof. Missing-message delivery throws, and duplicate delivery appends a no-op audit row. The corrected script asserts those actual behaviors; the [parent notes](designs/autotitle-architecture/parent-notes.md) retain the failed expectations and their source-backed explanations.

## Measurement and next gate

The [measurement plan](designs/autotitle-architecture/measurement-plan.md) requires exact outcome/bookkeeping/context parity, cold and warm scan costs, changed and unrelated-write workloads, write overhead if CoreStore.tx changes, and separate allocation/retained-memory evidence. A quiet-scan ruler is in review. Its [first review](designs/autotitle-architecture/quiet-ruler-review.md) requires whole-dispatch timing and exact source/fixture boundaries before canonical capture.

No new performance gain is claimed from this architecture work. The already accepted [Cell tag-omission result](cell-no-tags-results.md) is independent and remains integrated in local main.
