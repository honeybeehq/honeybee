# Exhaustive performance execution

The user authorized inventory followed by implementation, measurement, verification, continuous commits, and local merges. The inventory lane is GPT-6 Astra with ultra reasoning, session `71ae901f-97f5-4e3e-a417-a9e0d78767a3`, baseline `343289fe`.

## Execution playbooks

### Autonomous run

**You own the exit condition. Define done, then drive to it without stopping.** For "going to bed" / "run until done" / "/loop until X".

1. State the exit condition as a checkable predicate before the first iteration (tests green, repro fixed, all N PRs merged, pixel-diff zero). A vague goal stalls; a predicate lets you stop.
2. Pick the wake mechanism using Claude Code's `loop` skill (built-in). An event to watch (CI, a merge, a ref advancing) gets a watcher subagent that wakes you on the event, with a long time-based heartbeat as fallback. No event gets a fixed-interval heartbeat sized to when the result is worth re-checking.
3. Each iteration makes the smallest change the evidence justifies, verifies it against the predicate, commits if it advanced, discards changes that didn't help. Belt-and-suspenders that "might help" gets reverted, not left to ride.
   Sequence the work via the **sequence-verifiable-units** principle, verifying each unit before the next instead of batching checks at the end.
4. Mid-run discoveries are yours. Address broken skills, related bugs, flaky verifiers, review noise, tooling failures, orphaned follow-ups, and fixable drift yourself via astack-mode. Put out-of-band fixes in their own PR. Do not park reversible work for the human or use `AskUserQuestion`. Surface only irreversible actions, genuine product or preference calls no experiment can settle, or a real dead end. Keep the predicate as the main drive, and return to it after each side fix.
5. Checkpoint every iteration via the **show-me-your-work** skill, a row for what changed and whether the predicate moved. A run with no trail can't be audited or resumed.
6. Stop when the predicate is met. A plateau is not a stop, so keep going and pivot your approach to push past it. Surface a genuine dead end rather than spinning, and never relax the predicate to declare victory.

**Reply:** the exit condition, iterations run, what landed, what was discarded, final predicate state.


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

## Applied workflow

- [x] Read the principles index and applicable isolation, verification, sequencing, and type sections.
- [x] Read the Honeybee architecture contract and inspect main.
- [x] Call live Apiary self/setup and spawn the requested GPT-6 ultra inventory agent through authenticated agent_spawn.
- [x] Create separate baseline and execution worktrees at 343289fe.
- [x] Retain the source-grounded inventory and directory coverage matrix.
- [ ] Assign every inventory row to an instrumented workload and correctness gate.
- [ ] Capture baselines before production edits.
- [ ] Work each measured avoidable cost through one verified unit at a time.
- [ ] Retain before/after data, rejected approaches, costs, and unresolved evidence.
- [ ] Cross-model review of production changes and the final trail.
- [ ] Commit completed units and merge locally with clean task worktrees.

The completion predicate is a fully accounted inventory: every item has an executed measurement or a concrete externally blocked prerequisite; every demonstrated avoidable Honeybee cost has been addressed through verified changes or a measured rejection explaining why the alternative is worse or violates a required behavior. Unmeasured items remain open. A fast microbenchmark does not close end-to-end or recovery rows. No claim of a mathematically optimal system will substitute for evidence.

Autonomous step 2 uses active execution and authenticated Honeybee agent messages in this harness; a Claude-only loop skill is unavailable and no unattended scheduler is needed while this turn is running. The plan-only multi-phase playbook is not selected because the user explicitly authorized execution. Per-unit architecture work is required when a design crosses a function boundary. Local merges remain authorized from the session; remote push and live deployment are not part of the current execution.

The parent owns the measurements. Implementation lanes use separate worktrees and pause broad verification during capture windows. Source, tool, artifact, workload, and measured boot identity are retained. Existing scripts are reused where they measure the exact operation; missing coverage earns new tooling rather than inferred numbers.

The completed inventory contains 153 IDs, 391 lexical source anchors, and 113 directory rows covering 1,391 tracked files. Its original files and hashes are retained under `inventory/`; `tracker.csv` records execution status separately. Inventory completion is not optimization completion. The child could not discover Apiary tools in its own harness; the parent successfully called live self/setup and performed authenticated spawning and the visible tracker handoff.

Supplementary captures use a disposable shallow clone at `/tmp/honeybee-perf-5763a6c9-20260907/baseline` on `trmd-rohan-mini01`, running its installed Node 24.18.0. The original Studio uses Node 25.8.0 and is heavily contended by unrelated work. Comparisons remain within one machine/runtime, and source hashes accompany both. No remote service or installed runtime is changed.
