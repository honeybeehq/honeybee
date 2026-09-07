# Sparse daemon work review

Reviewed the combined `9240cede`, `1325e204`, and `824485f9` source/tests and the parent integration through `4db13133`. The initial two-commit performance candidate was held for measured CPU regressions; only the final refinement is accepted.

Current-runtime selection remains max generation per Bee, including archived Bees; stale old live generations cannot drive policy or delivery. The query uses the existing live partial index and per-Bee mailbox prefix. I1 independently includes every pending target, including stopped/absent runtimes, exact mailbox order, current boot evidence, and active flags. The fact query and body-free queue query execute synchronously under the serialized writer.

The combined input shares queue identity for work and I1 within one step. Audit-sequence checks refresh command-boundary work and final I1 after any durable change; no cross-step cache is introduced. The selected message is rehydrated and checked for target, pending status, urgency, and enqueue time before envelope construction and delivery. Successful interrupts skip body hydration. Existing urgency/FIFO and peer-envelope behavior remain covered by real CoreStore/FakeDriver tests.

No blockers found in the combined source. Natural plans, full ordered oracles, mutation/rollback tests, and parent broad checks support the conclusion. This does not prove all runtime paths free of bugs; the accepted scope is the synchronous step projection. Parent verification: build, all v2 typechecks, core 199/199, serial daemon 267 pass and 1 platform skip. Old-base Cell timeout is attributed with unchanged-base and repaired-main controls in the results document.
