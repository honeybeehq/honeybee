# Correctness and performance gates

These are implementation gates for the parent. This candidate ran no build, test, benchmark, profiler, or live-state command.

## Store projection gates

1. Compare `readDaemonWork()` with a simple oracle built from `listBeeViewRows()` and `listUndeliveredMessages()` across active and archived bees, zero and many generations, every runtime state, active flags, and zero or many messages. Compare target ids, runtime fields, complete message fields, and per-bee message order.
2. Archive a running and an idle bee without stopping its runtime. Both must remain in `readDaemonWork()`. The idle bee must still reach scale-to-zero, and pending mail must still reach degraded policy and delivery.
3. Seed an old non-current live runtime through a fixture that bypasses the public transition API. `readDaemonWork()` must match `currentRuntime()` and ignore that old row.
4. Verify that zero live runtimes return zero `DaemonWorkRow` objects for 0, 10, 1,000, and 10,000 retained bees with 1, 20, and 200 generations.
5. Verify that `listI1PendingCandidates()` returns no body, sender, bee tags, environment, or other unused fields.
6. Verify one-based `fifoPosition` after delivery and cancellation. Count every undelivered predecessor, including an `idle` message that is not currently eligible.
7. Verify pending mail for a stopped bee and for a retained bee with no runtime row. Both must appear in the I1 projection. A left join, not a live-runtime join, is required.
8. Compare the new I1 loop with the old loop as an oracle over `now`, `next`, and `idle`; booting, synthetic-running, real-running, idle, stopped, and no-runtime facts; zero and multiple flags; queue lengths 1, 2, and 20; and times immediately before, at, and after each deadline.

## Transaction and refresh gates

1. In `store.transact()`, change a runtime, enqueue or deliver mail, advance an observation cursor, call each new read, and throw. After rollback, both reads must match the pre-transaction state.
2. Exercise audit sequence reuse directly. Build a projection after an uncommitted write at sequence `N+1`, roll it back to `N`, then commit a different write that receives `N+1`. No result from the rolled-back transaction may appear.
3. Keep `observe()` atomic. The existing test for runtime state, `lastOutputAt`, and `runtime_observation_cursors` must pass unchanged.
4. On a quiet tick, `readDaemonWork()` runs once. When a policy or command writes, it runs again before delivery. When nothing writes after the read, `refreshDaemonWork()` reuses only that same-tick value.
5. After one message is delivered, I1 must take a fresh read and recalculate the next message's FIFO position. A task-supply message added later in the same tick must also be visible to I1.

## Policy and mailbox gates

1. Keep the exact strict thresholds: boot hang and idle stop use `now - timestamp > window`; flag expiry occurs when `now >= resetsAt`; I1 records only when `now > deadline`.
2. Keep `expireFlags()` before the work read. Test `resetsAt - 1`, `resetsAt`, and an open-ended flag after a large clock jump.
3. Keep `pendingStopExists()` fresh. With one booting, degraded bee that has pending mail and has crossed the boot-hang threshold, one tick may enqueue at most one stop for that generation.
4. A queued or running stop for generation N suppresses another policy stop for N. A stop for an older generation does not suppress policy for the current generation.
5. Keep replacement-argument stop deferral, `thenRevive`, queued and running wake dedup, command claim order, command replay, and generation fencing unchanged.
6. Keep delivery behavior unchanged: booting and stopped runtimes do not receive mail; synthetic-running accepts `idle`; real-running holds `idle`; `now` interrupts once; eligible messages use mailbox-id FIFO; `markDelivered()` carries the consuming generation.
7. Keep I1 behavior unchanged for blocked bees, stopped or absent runtimes, synthetic boot evidence, idle eligibility, repeated ticks, and messages that shift position after cancellation or delivery.

Run the existing focused cases in `v2/daemon/tests/loops.test.ts`, including `unit.0`, `unit.2`, `unit.5`, `unit.6`, `unit.7`, `budget.9b`, `urgency.d1` through `urgency.d6`, the recovery-cursor cases, and `unit.flag-expiry`. Run the core list-view, urgency, spawn-budget, mailbox, rollback, and audit-replay cases. Then run the repository's required typecheck, lint, tests, and build. The parent must schedule these after its active capture.

## Query-plan gates

Capture `EXPLAIN QUERY PLAN` for each new statement on these stores:

- 1,000 bees by 20 generations, all current runtimes stopped;
- 1,000 bees by 20 generations, 1% live;
- 1,000 bees with 0, 1, and 10,000 undelivered messages;
- one bee with 10,000 pending messages and a mixed-urgency queue.

The stopped-fleet live query must use `runtimes_daemon_live` and must not scan `bees` or the complete `runtimes` table. The I1 cutoff query must start from `mailbox_pending_enqueued`; FIFO-position probes must use `mailbox_undelivered`; current-runtime probes must use the runtime primary key; active-flag probes must use `flags_active`. Treat a temp sort over a small candidate set as measurable, not automatically wrong.

## Performance decision gates

Use paired, uninstrumented before and after captures for timing. Use a separate instrumented capture for attribution.

1. On the supplied 1,000-stopped-bee, zero-mail fixture, the heap profile must contain no measured-interval allocation attributed to `listBees`, `listBeeViewRows`, or `mapBee` from `DaemonCore.step()`.
2. Add 10,000 stopped bees. Quiet-step CPU and allocations must remain governed by the empty partial-index probes, not grow in proportion to retained bees. Reject the change if the 10,000-bee median CPU is more than twice the 1,000-bee median under the same controlled run.
3. Measure stopped/live mixes of 100%, 99%, 90%, and 0% stopped. The candidate must scale with current live rows and their pending mail. Report the slope rather than one percentage.
4. Measure 0, 1, 100, and 10,000 pending messages with 16-byte and large bodies. I1-only work must not allocate message bodies. Delivery may allocate bodies only for live targets.
5. Re-run accepted-message-to-delivery latency for all urgencies and wake states. No p95 regression above 10% is acceptable unless repeated paired runs show that host noise explains it.
6. Record database bytes and send, deliver, runtime-transition, and store-open CPU with the new indexes. Do not accept a quiet-tick win that causes a material write-path or reopen regression.

The before profile is `docs/performance/2026-09-07-exhaustive/evidence/quiet-profile-before.json` in the parent execution worktree. It records the source revision and hashes. Preserve the same workload identity in the after artifact.
