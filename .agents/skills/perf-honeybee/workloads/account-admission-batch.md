# Batch local activity for account admission

Measure public `admitNewWork` on isolated SQLite fixtures. Count `listBees` calls directly; `currentRuntime` and `listAccountAdmissions` calls are supporting attribution. The existing shadow picker may add a second pass. No cross-call cache is permitted.

Before implementation, capture the baseline and declare three alternating B/A, A/B, B/A pairs on Node 24.18.0. Compare normalized decisions, reservations, selection cursors and audit rows exactly. The candidate must pass the current-source recipe and linked activity/generation controls. No CPU, SQL scan, memory, latency or real-provider claim follows from these counts.

Retained evidence contains three B/A, A/B, B/A pairs (40 cases per arm). All 120 normalized reply/effect hashes match. Eight-account active admission uses one fleet read instead of eight; shadow uses two instead of nine. At 1,200 bees, active runtime lookups fall from 9,600 to 1,200. This is a read-count reduction, not a latency, CPU, SQL scan or memory measurement. The top-level zero baseline gates current behavior; the embedded pairs establish the reduction.

The standard map checker trusts the producer’s `invariantHolds` field and checks the declared count samples against the current baseline. It does not recompute the embedded cross-arm comparison or authenticate receipt contents. The retained six arms establish the historical paired comparison; their result/effect hashes must be compared separately when repeating that experiment. A green current-source check alone is not proof of a new improvement.
