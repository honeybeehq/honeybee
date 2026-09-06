### Perf issue

**You own the measurement story. Plan, review, verify the numbers.** Tie every fix to a measurement, don't read source instead of measuring.

1. Capture a baseline trace via the driver skill (`run` for CLIs/TUIs, `verify` for UIs).
2. `how` to ground hypotheses; don't claim a perf ceiling without running it first.
   Most fixes come from eight strategy families. Use them as hypothesis generators, not a checklist. A family earns an attempt only when the trace shows the signal it names, and a focused fix for the dominant cost beats applying all eight.
   - **Elimination.** The cheapest work is work that doesn't run. Before optimizing the hot path, ask whether it needs to exist: a computation nobody consumes, a feature gate that's always off for this user, a sync that redundantly mirrors state, a legacy path kept "just in case". The trace shows what's slow, never that it's deletable, so this family needs the `how` pass, not the profiler. Deleting the work beats every other family when it applies.
   - **Divide and conquer.** The dominant cost scales with input size. Split the work so each piece touches less (chunk, shard, prune the search space) or so independent pieces run in parallel.
   - **Caching.** The same computation or fetch repeats on identical inputs. Store and reuse the result; name what invalidates it before claiming the win.
   - **Indirection.** The hot path does expensive work a cheaper intermediate could absorb: an index instead of a scan, a queue that shifts work off the interactive thread, a handle that lets a cheaper implementation swap in. Add the hop only when it removes more from the critical path than it adds; a layer that sits on the hot path without removing work is pure cost.
   - **Batching.** Many small operations each pay a fixed overhead (RPC, query, syscall, draw call). Coalesce them to pay the overhead once per batch.
   - **Redundancy.** The wait hangs on one slow instance or attempt. Duplicate the work (replicas, hedged requests, speculative execution) and take the fastest result. This trades extra load for lower tail latency, so the trace has to show the wait dominates and the system has headroom; duplication without that tradeoff only adds load.
   - **Lazy evaluation.** Cost lands on results that are never used or not needed yet (eager init on the boot path, rendering offscreen items). Defer the work until first use.
   - **Scheduling.** The work must happen, but not during the interactive moment. Move it to where nobody is waiting: idle callbacks, a background warmup after boot, precompute before the user arrives, cleanup after the frame commits. Distinct from Lazy (later-when-needed): Scheduling often runs the work *earlier* than the hot moment, or in its shadow. The win is perceived latency, so measure the interactive path, not total work done.
3. Plan the fix from the trace. If it crosses a function boundary, `architect` first. Delegate implementation through provider dispatch using your configured perf-issue descriptor (default `codex:gpt-5.6-sol@max`) with `isolated-write` in a dedicated worktree; review the diff. Capture a post-fix trace.
   Apply the **sequence-verifiable-units** principle, verifying each attempt before trying the next.
4. Parse and compare the artifacts (JSON to sqlite, diff). "Inconclusive" or wrong-surface is not a pass; flag it.
5. Cite the measurement in the PR.
6. Run **Landing**.

For sustained improvement against a metric rather than a one-off fix, use the Hillclimb playbook (`playbooks/hillclimb.md`).

**Reply:** baseline number, post-fix number, delta, artifact path.

## Execution checklist

- [x] Read the astack principles index and applicable simplicity, isolation, verification, and sequencing sections.
- [x] Inspect main and create an isolated worktree at a22c42bd. Main initially contained four unrelated untracked files; they were absent on a later status check. This task did not touch them.
- [x] Capture a fresh built-worker baseline and retain earlier native Git/CPU/heap attribution.
- [x] Complete the narrow how explanation and review the config batching hypothesis.
- [x] Freeze and verify remote-aware measurement tooling.
- [x] Retain baseline measurements before integrating production changes.
- [x] Review delegated implementation and real-Git regression checks.
- [x] Capture alternating before/after built-worker results and five-worker cohorts.
- [x] Compare raw artifacts and record inconclusive metrics honestly.
- [x] Independent code and evidence review.
- [x] Commit completed units; integrate current main without conflicts.
- Local main landing follows this final report commit; no push or deployment.

Landing adaptations: local merge follows the user’s existing merge instruction. No push, PR, or runtime deployment is requested. Product preview is skipped because this is a backend optimization exercised through real built-worker fixtures. Architect is skipped while the candidate remains inside the existing private config function with no interface change. Revisit that decision if the scope changes.

## Additional measured units

The command-history map exposed a separate reconfiguration cost. That unit was implemented, independently reviewed, checked, measured, and committed before adding indexes. Disposable index prototypes were then compared under both test and production read pragmas. The history-only prototype was rejected. The dual-index candidate required a follow-up correction after raw pending-delete plans exposed a regression. Both the rejection and correction are retained in the decision trail.

The index and query changes remain within CoreStore's private implementation, with no new interface or ownership boundary. No additional architect pass was needed. The parent owns all rulers and performance captures; isolated authors own production/test edits; Claude Fable provides independent code and evidence review. All owned broad work pauses during captures. Unrelated shared-host verification was observed and is disclosed in the report.

Local CI lookup returned no runs for this unpublished branch. Author full builds and affected typechecks/tests are retained. Final integration rebuilds the combined v2 CLI, Worker, and runner-host artifacts and exercises the built Worker. Unchanged legacy suites are not repeated solely because commits were cherry-picked.
