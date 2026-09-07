# Honeybee performance execution, September 7

This round starts at `343289fe`. The requested GPT-6 Astra/ultra inventory is complete; optimization execution is ongoing. [The tracker](tracker.csv) keeps all 153 items open until measured and accounted for. [The original inventory](inventory/report.md), [directory coverage](inventory/coverage.tsv), and [source anchors](inventory/anchors.tsv) retain the agent's inspection limits and file hashes.

The first measured cost is D02: every quiet core tick builds a full retained-bee snapshot. Two independent designs and a cross-judge produced [the implementation decision](quiet-tick-design.md). The first unit will use indexed existence checks to avoid an empty snapshot. Sparse live fleets and large pending queues remain subsequent work; the guard cannot close those cases.

## Baseline evidence

| Files under `evidence/` | Status and use |
| --- | --- |
| `quiet-before.json` | Failed broad Studio capture: only two of four scenarios completed. Never use as a complete comparison. |
| `quiet-timing-before.json`, `quiet-profile-before.json` and sidecars | Initial Studio diagnosis under heavy unrelated contention, Node 25.8.0 / M4 Max. Snapshot consumed 94.4% of profiled core CPU. Absolute timings are not the canonical baseline. |
| `mini-core-before.json` | Complete original four-scenario suite on the Mac mini, Node 24.18.0 / M4. Quiet-step CPU medians: 0.063 ms (10×1), 3.045 ms (1,000×1), 4.919 ms (1,000×20), 0.438 ms (100×200). |
| `mini-quiet-timing-before.json`, `mini-quiet-profile-before.json` and sidecars | Initial schema-1 focused mini captures. Snapshot consumed 96.6% of profiled core CPU. Retained as exploratory evidence, superseded for strict pairing by schema 2. |
| `mini-quiet-v2-none-before.json`, `mini-quiet-v2-profile-before.json` and sidecars | Canonical focused baseline after the measurement review: full source fingerprints, capture intervals, runtime flags, OS boot identity, and unchanged-source checks. |

The two machines both report `Mac.home`; hostname alone cannot identify a valid pair. No cross-machine or cross-Node speedup is accepted. Studio/mini ratios do not isolate the cause of their difference. The remote fixture is an owned disposable clone, not an installed daemon or live deployment. Timed commands on that machine run sequentially through one parent-owned process.

The quiet fixture measures real `DaemonCore` with `FakeDriver`, retained stopped bees, and no pending mail. It does not measure HSR polling, providers, real readiness, or whole-daemon idle CPU. Deep-generation fixtures may include the spawn-failure flags produced by their public API setup. Native allocation profiles include sampled collected objects; RSS observations are process resident memory and do not establish private memory or leaks.

## Tools and verification

`scripts/perf/quiet-tick.mjs` separates setup from timing and native CPU/allocation profiling. Run it with `node --expose-gc`, `--mode none|profile`, and an output path. `compare-quiet.mjs before.json after.json out.json` rejects mismatched environments, boots, tools, workloads, overlapping measurement intervals, incomplete results, and summaries that disagree with raw samples. Profile mode produces diagnostic attribution, never an uninstrumented timing comparison. Copied profile sidecars are resolved next to their report and checked by hash; their original remote paths remain unchanged in the evidence.

`scripts/perf/sql-trace.mjs` supplies disposable synchronous SQL attribution, including cached statements, prepare/exec calls, row counts, and returned text/blob bytes. It never records bound values or result contents. Its timing is diagnostic and includes observation costs. Lazy iterators are explicitly unsupported. The trace restores native methods after success or failure and is never installed in the live daemon.

Verification so far: repository build (including TypeScript) passed; existing ruler checks passed 13/13; the first four new comparator and SQL-tracer checks passed on both Node 25.8.0 and 24.18.0; the focused tool executed successfully in timing and profiling modes on both machines. [The initial independent measurement review](reviews/quiet-tool-initial.md) is retained unchanged; its pairing/provenance requests led to schema 2 and a fresh mini baseline. [The second review](reviews/tools-final.md) found no hard blockers. Follow-up changes check full recorded capture intervals and an optional exact changed-source list, and fingerprint the comparator. Production verification remains in progress.

The comparator records conditions for review; it does not impose an uncalibrated wall/CPU ratio or load threshold. Valid SQLite work can wait for I/O, and process CPU is not immune to scheduling or cache effects. Published comparisons will use sequential same-machine captures, an A/A control, raw samples, and the expected changed-source list. The stored remote command sequence proves the early mini runs were sequential; nearby completion timestamps alone do not establish overlap.

The [workflow](workflow.md) defines the completion predicate. [The decision log](decisions.tsv) records failures, choices, and evidence without rewriting earlier observations. No production optimization has been accepted in this checkpoint.
