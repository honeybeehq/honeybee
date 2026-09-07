# Automatic-title membership cache integration review

Accepted `8e57e746` after exact-source combined verification and paired measurement. The [results and tradeoff record](../performance/2026-09-07-exhaustive/autotitle-quiet-results.md) contains the CPU, memory, allocation, source, test, and failure evidence.

The change preserves Core authority. No writer, schema, migration, sidecar-format, provider, scan-cadence, or general dependency API change. Core owns the body-free membership fact and refuses to publish it during any same-connection transaction. The dispatcher owns the private optimization, full-roster pruning, and quiet eligibility. Equal count/max is used only with the documented immutable id/body, same-store, same-bee contract. A signature mismatch, expiry, changed membership, supplied roster, or speculative read takes the original full path.

Parent review agrees with the [independent Unit2 review](../performance/2026-09-07-exhaustive/designs/autotitle-architecture/honeybee-autotitle-unit2-review.md): no correctness blocker. The tests reproduce rollback id reuse rather than trusting an assumed callback contract. Full generation context remains unbounded by any new first-k shortcut. Delivery/urgency updates leave count/global maximum unchanged. Complete-roster pruning precedes the probe-limited loop, with the documented disabled/in-flight retention bound.

Accepted costs are explicit. Empty1000 adds 0.282ms CPU/scan. All-changed1000 has +3.58% CPU and +8.47% wall in its growing-history workload. First scans populate a cache. Whole-process RSS falls in the retained fixture while managed-heap occupancy rises, mostly persisting after release. Neither metric establishes exact Map retained bytes. Both treatment warm snapshots show1001 recognized entries; all released snapshots show zero slots and CoreStore objects. Scope and source alignment were independently reviewed.

Relevant gates pass: build, all v2 typechecks, Core237/237, daemonCLI378 pass and one platform skip. The prior legacy compiled suite remains red on identical-source control; no claim of full-repository green. Nonblocking gaps remain titled/archived eviction as individual tests and broader differential outcome streams. Existing focused cases and source proof support acceptance.

The inspector's original assertion behavior and source-citation mistakes were corrected with preserved lineage. Version2 records recognized violations before nonzero exit. Its real invalid fixture exercises both branches; it does not claim to discover malformed objects without the identifying property edges. One parent summary-printer error occurred after a valid quiet capture and is preserved without rerun. No performance claim uses contended Studio timings.

No production edits followed combined Mini gates or captures. The evidence integration changes only documentation and disposable analysis tooling. No push or deploy by this lane.
