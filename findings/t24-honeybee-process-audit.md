# T24 Honeybee child-process audit

Source snapshot: 9d7a295668ffcb38d136dfa721686377ca114fc2. Own fresh metal-2 Cell only. No live host, live database, deployment, cleanup, provider agent or network probe used. No production code, tests or comments added.

## Confirmed defect: host lifetime follows inherited pipes rather than agent lifetime

`v2/driver-hsr/src/runner-host.ts:241-245` records agent exit and exits the host only on ChildProcess `close`. A descendant can inherit stdout/stderr, outlive the direct agent, and delay `close` indefinitely. The direct child has already been reaped by Node; this is retained host/orphan ownership, not proof of a zombie. The host ignores TERM/INT/HUP at lines 200-202, and its socket continues accepting connections. The daemon tracks host identity and only finishes an adopted host when that host exits (`v2/driver-hsr/src/driver.ts:1263-1277`). Thus a dead agent can leave a live host with no exit receipt and pipes belonging to a surviving descendant. Accumulation across many such agents is possible; it has not been established on mini04 or mini07.

The fenced host has the same close-only finish at `v2/driver-hsr/src/gated-runner-host.ts:63`; only the ordinary host was exercised here.

Run from the repository root on Linux:

```
node findings/t24-runner-close.mjs
```

This calls the actual source runner with a stub agent which forks one 2.5-second descendant inheriting its pipes, then exits after 100ms. All files stay under this Cell's `.audit/runner`. `/proc/self/cwd` shortens the Unix socket pathname and resolves to this Cell, not an external directory. All processes terminate naturally. Two independent runs produced:

```
{"afterMs":650,"agentAlive":false,"hostAlive":true,"statusExited":false,"bugObserved":true}
{"finalStatusExited":true,"hostExitCode":0,"stderr":""}
```

The fixture proves the retention interval, not indefinite growth or the live outage. Its descendant is deliberately finite. Recommended root correction: observe direct-agent exit independently, bound the final pipe drain, and settle exact descendant ownership before declaring the generation finished. Start with removing the unnecessary host wait, not faster polling or more concurrency. A correction must preserve final output and exact process-identity fencing.

## Other source hazards, not reproduced defects

- `v2/driver-cell/src/exec.ts:247-259`: TERM the group, wait one second, but KILL only if the original PID is alive, then await pipe close without a second deadline. If the direct leader is gone but a TERM-resistant descendant retains pipes, escalation can be skipped. A first fixture returned in 1270ms for a 250ms timeout, so it did NOT reproduce this concern. This fresh Cell lacks the built native identity artifact; identity unavailable is conservatively treated alive by `psutil.ts:11-15`, which can explain escalation in this environment. Do not report it as confirmed.
- `v2/driver-cell/src/driver.ts:708-752`: warm refresh is single-flight per repoKey, with no global worker cap; a many-repository burst can create one worker per key. Workers are threads, not one PID each, but each invokes Git/heartbeat helper processes. `poolWorker.ts:52-58` bounds member construction by target/maxSize and stops on error. No source evidence of an unbounded per-repo creation loop. `clear()` runs on message before exit, a narrow overlap opportunity, not evidence of accumulation.
- `v2/driver-cell/src/git.ts:179-184`: generic synchronous Git receives an optional timeout, often absent. Upstream fetch itself is explicitly timed (`upstream.ts:200`). Git/SSH descendants are not independently owned by this generic wrapper. Hung tooling can retain a worker and helpers; no actual hung Git reproduced.
- `v2/driver-cell/src/upstream.ts:141-151`: lock heartbeat child is unrefed and killed on release; stdin EOF also stops it. Node owns direct-child reaping. No proof that unref leaks zombies.

## Failed spawn pacing and negative findings

`v2/core/src/store.ts:1666-1667` defaults to five attempts and a 30-second backoff base. `applySpawnFailure` at 3350-3371 sets spawn_failed at the budget; `wakeNotBefore` at 3405-3407 doubles the interval. `reportCommandFailure` at 5918-5963 caps command attempts and sets exponential nextAttemptAt. `v2/daemon/src/loops.ts:1010-1021` sends pre-process driver-start failures through that path. Host async spawn errors call finishHost (`driver.ts:641-645`). No tight unlimited EAGAIN retry loop was found in these examined paths. This does not establish aggregate admission safety across many different bees.

Upstream failed-fetch retry has a five-minute minimum backoff (`upstream.ts:22`, 184-187). Warm-pool worker exits after one result. No forage runner implementation appeared in the v2/src/scripts search; that surface remains outside this repository audit.

## Limits and checks

Core architecture, diagnosis, astack-principles, first-principles-optimisation, perf, performance-mantras and show-me-your-work read and applied. No repository verification skill or verify-apiary is installed here. perf-honeybee exists, but its map has no retained-process/reaping workload; no baseline, performance gain or live count is claimed. No new map was created because this task is source-only audit, not a performance implementation. Decision trail is findings/t24-decisions.tsv. The requested no-helper boundary overrides the trail skill's delegated cross-model review.

The actual runner fixture ran twice successfully. `npm run check` and `npm run build` were attempted and both stop at `tsc: not found`; node_modules is absent. No dependency installation or live runtime changes made. No production code change requires a new test suite; the deliverable is an audit and standalone reproducer, not added tests.

Pending independent evidence: mini04/mini07 per-user process counts, process ownership/tree/state and installed source version. Only those can connect a source hazard to the current failures.
