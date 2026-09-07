# First automatic-title reuse candidate

The selected [synthesis](designs/autotitle-architecture/synthesis.md) uses a read-only committed mailbox identity and caches only the exact signature needed to skip unchanged defer/backoff scans. The general dependency factory and caller-supplied rosters keep their full-read behavior. A possible title launch still reads and normalizes the full mailbox as today.

This is an implementation decision, not performance acceptance. Core Unit1 is frozen at bc6554b6 in the isolated candidate worktree and passes Mini build, all v2 typechecks and all 237 Core tests. Unit2 dispatcher implementation is active. No automatic-title cache is integrated in main.

The [independent judge](designs/autotitle-architecture/cross-judge.md) preferred Sol's private store-backed boundary and Fable's derived SQLite identity. The [smaller-slice addendum](designs/autotitle-architecture/smaller-first-slice-addendum.md) agrees that full summary and selected-body launch changes can wait. The Core transaction token remains an alternative; its [contract corrections](designs/autotitle-architecture/sol/core-contract-addendum.md) are retained but not selected for this slice.

A [4,800-case design probe](designs/autotitle-architecture/quiet-policy-proof.json) checks quiet-path equivalence against the current real policy. It includes zero timestamps, exact retry boundaries and unusual numeric states. This does not prove an implemented cache; Core and dispatcher regression tests remain required.

## Whole-dispatcher baseline

The final [quiet ruler](tools/honeybee-autotitle-quiet-ruler.mjs) is8e4d3cacea90a15760de59b40e65f37a692a1bfd12d5b20aba42a753cd9d2f67. It times awaited dispatcher completion, uses copied identical authority/sidecar fixtures, asserts exact source differences, and retains every raw scan sample. Both giant fixtures contain interleaved pending/delivered rows. SQL and allocation replays are separate; SQL replay is explicitly limited to synchronous entry work, which the accepted source must preserve. The first scan is a cold dispatcher over an already inspected fixture, not a cold process or filesystem.

Two distinct Mini checkouts at322815d9 passed the [A/A smoke](evidence/mini-autotitle-quiet-aa-smoke.json) and [canonical A/A run](evidence/mini-autotitle-quiet-aa-canonical.json). Each canonical side has30 warmed samples per scenario on Node24.18/M4.

| Scenario | Before CPU p50 ms/scan | Identical control CPU p50 ms/scan |
|---|---:|---:|
|1000empty deferred Bees|2.759|2.754|
|1000thin deferred Bees|4.052|4.230|
|100k envelope-only messages|139.902|139.322|
|100k substantive messages in backoff|184.857|180.132|

These are baseline and control results. They are not optimization gains. The empty and thin fleets guard the common small-mailbox case; the giant fixtures identify the expensive repeated work. Both sides issue1001 all-reads per fleet scan and2 per giant scan in the separate SQL replay. The deterministic provider is never reached, every outcome is empty, and bookkeeping bytes, audit head and full state hashes remain unchanged.

Giant mailbox rows are seeded offline without synthetic enqueue audit/projection rows. Every row is checked against the public primary-key read across all nine MessageRow fields. Fixtures carry normal public Bee audit history. The report's auditRowsAdded=0 refers to additions after the public seed, not zero total fixture audit rows.

## Ruler review lineage

The [v1 draft](tools/honeybee-autotitle-quiet-ruler-v1.mjs) and [v2 revision](tools/honeybee-autotitle-quiet-ruler-v2.mjs) remain byte-exact. V1 timed only synchronous dispatch entry and used an all-pending giant fixture. V2 fixes those measurement boundaries and the exact source gate. Final bytes change only the interleaved-history and audit-count wording. Studio v1/v2 smoke reports and heap profiles retain their original hashes. They prove structural wiring, not performance, and their differing fixtures must not be mixed with final Mini captures.

Next gates are Core and daemon behavior tests, broad serial Mini verification, treatment captures, changed/expiry and multi-giant workloads, and separate retained-memory measurement. The new cache's RAM cost must be priced independently from any reduction in allocation traffic. No schema, persistent sidecar field, writer hook, scan-cadence change, provider call, push, or deployment is part of this candidate work.

The [memory baseline](autotitle-memory-baseline.md) records the approved process ruler, its limitations and the canonical identical-source control.
