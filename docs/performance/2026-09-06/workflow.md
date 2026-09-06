# Honeybee performance round

The round starts at `8506467f2a6e99d06258e5fe59726d330b2ccdf4` in branch
`perf/system-round-2026-09-06`. The original checkout contains unrelated
untracked files. All work for this round uses a separate worktree.

The completion predicate is a source-backed system map, reproducible performance
snapshots, bounded opt-in tracing, and measured optimizations with passing
correctness checks. A faster microbenchmark alone does not prove a faster live
system. Provider latency and machine load are recorded separately. No deployment
is part of this round.

## Workflow

- [x] Read the astack principles index and applicable sections.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [ ] Phase C: Run the loop
- [ ] Phase D: Keep the audit trail
- [ ] Phase E: Verify and hand back

## Units

1. Map core, daemon, drivers, adapters, CLI, integrations, storage and packaging.
   Record entry points, cost growth, existing evidence, and unmeasured candidates.
2. Build a provider-free profiler and benchmark runner. Record environment,
   workload, source revision, wall time, CPU, memory, storage and distributions.
   Capture baselines before changing measured behavior.
3. Add bounded opt-in operational traces with no payload bodies or credentials.
   Cover daemon startup, ticks and RPC, with CPU and memory profile recipes.
   Test failures, disabled behavior, limits and shutdown. Measure overhead.
4. Optimize measured dominant costs one at a time. Preserve SQLite authority,
   lifecycle, mailbox eligibility/FIFO, idempotency, generations and audit replay.
   Add differential tests and repeat the same workload before retaining a change.
5. Run typechecks, applicable tests, build and isolated real daemon smokes. Review
   the changes and evidence independently. Commit each verified unit with explicit
   paths. Produce a scorecard and a prioritized list of remaining experiments.

Each experiment states a hypothesis, records a baseline, changes one unit, and
records VERIFIED, NOT VERIFIED or INCONCLUSIVE. Evidence and decisions go in
`decisions.tsv`. No performance gate can replace a correctness gate.

The scope is the complete system inventory and reusable profiling foundation,
followed by the highest-value changes the measurements justify. Live provider
and multi-node results remain unproven until those workloads are actually run.
The risk level is high because the daemon owns durable state and runtime control.
Benchmarks use disposable stores and processes with no real account credentials.
