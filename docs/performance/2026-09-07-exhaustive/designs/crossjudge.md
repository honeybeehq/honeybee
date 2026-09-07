# Quiet-work design cross-judge

Choose Sol's fresh-read direction, graft Fable's phase-order and time-boundary checks, and reject both complete proposals as the first implementation. The smallest useful first unit is an indexed, conservative empty-snapshot fast path. It preserves the existing fallback and creates no cross-tick state. Subsequent units can replace that fallback with narrow runtime and mailbox reads.

This is an independent source review against `343289fe0f939ad3028550af14b4c5c068ea739e`, dated 2026-09-07. I read all seven requested candidate files and the relevant baseline store, schema, view, loop, daemon, driver predicate, and test bodies. No repository edits, nested agents, builds, tests, captures, live-state changes, or commits occurred. The counterexample and complexity analysis below are deductions from source, not executed results. Candidate performance predictions remain unmeasured. The parent profile numbers quoted by both candidates were not independently recaptured or revalidated here. Apiary `self` and `setup` were not callable in this session.

Repository paths and line numbers below refer to that baseline. Candidate paths refer to the supplied `/tmp` directories.

| Decision | Candidate component | Reason |
| --- | --- | --- |
| Pick as the direction | Sol's fresh, store-owned reads, with policy decisions in the daemon | Removes unnecessary display data and can scale with live work without a new cache-validity contract. |
| Graft into the first unit | Sol's `runtimes_daemon_live` partial index and the existing `mailbox_undelivered` index | They support a small proof that none of the snapshot consumers has work. Index cost still requires measurement. |
| Graft into verification | Fable's unchanged phase order, ordered behavioral comparison, and time-driven checks | Correctly recognizes that no database change does not mean no deadline can expire. |
| Reject as written | Fable's cross-tick cache | Its claimed committed-read boundary is not enforced. A permitted outer transaction can poison the cache. |
| Defer | Fable's `rowsById`, `booting`, and `idle` partitions | They add rebuild work and retained references before their incremental value has been measured. |
| Reject | Sol's correlated FIFO `COUNT` for every I1 candidate | It can do quadratic queue-prefix work, including on repeated ticks after violations were already reported. |
| Defer | Sol's enqueue cutoff and `mailbox_pending_enqueued` index | The cutoff can be sound, but it does not cure the quadratic case. Neither its selectivity nor its index tradeoffs are established. |
| Defer | Sol's complete projection rewrite | It changes more contracts than the empty fixture requires. Keep it as the next direction, with linear I1 ranking and explicit query plans. |

The empty fast path is a deliberately limited first unit. It does not resolve a single live runtime among many stopped bees, or a large pending queue. Those remain open work, with a direct follow-on design below.

## Source facts that constrain either design

`DaemonCore.stepPhases()` at `v2/daemon/src/loops.ts:276` does observations, flag expiry, initial snapshot, policies, commands, snapshot refresh, delivery, task supply, and an optional final snapshot refresh plus I1. `refreshSnapshot()` at line 328 reuses only a local value from the same synchronous step. `stepSnapshot()` at line 339 maps every pending message and every retained bee.

`CoreStore.listBeeViewRows()` at `v2/core/src/store.ts:3017` reads and maps complete bee rows, latest runtimes, and active flags. `listUndeliveredMessages()` at line 2366 selects full mailbox rows in `bee_id, id` order. Neither policy nor I1 needs the full display projection.

| Snapshot consumer | Necessary baseline facts | Why its work is empty when there is no non-stopped runtime and no pending mail |
| --- | --- | --- |
| `bootHangPolicy`, `loops.ts:655` | Current booting runtime, start time, fresh pending-stop query | No booting runtime exists. |
| `scaleToZeroPolicy`, `loops.ts:670` | Current idle runtime, update time, pending-mail existence, fresh pending-stop query | No idle runtime exists. |
| `degradedMailPolicy`, `loops.ts:690` | Current live runtime, driver degradation, pending mail, fresh pending-stop query | No live runtime exists. |
| `deliveryLoop`, `loops.ts:895` | Running or idle current runtime, complete eligible FIFO queue, selected message content | No delivery target or pending message exists. |
| `i1Telemetry`, `loops.ts:960` | All pending mail, queue position, current runtime facts or absence, active-flag presence | No pending message exists, including for stopped and no-runtime bees. |

Observations, flag expiry, command execution, and task supply are not covered by this proof. They must still run. The proof allows active and archived bees. It does not infer lifecycle or liveness from time, driver silence, or absent mail.

## Fable has a transaction blocker

Fable's `rationale.md:97` and `sketch.ts:76` claim cache acquisition structurally occurs outside transactions. The production call at `v2/daemon/src/daemon.ts:645` currently calls `core.step()` directly, but the class boundary does not enforce that usage.

`DaemonCore.step()` is public at `loops.ts:272`. `CoreStore.transact()` is public at `store.ts:2904`. The private `tx()` at line 1068 joins an existing transaction by increasing `txDepth`. Its nested return does not commit the outer transaction. Therefore `observe()` returning from its own `transact()` at `loops.ts:313` does not prove that a subsequent snapshot sees committed state. `lastAuditSeq()` at `store.ts:4218` reads the connection's visible `MAX(seq)`, including that connection's uncommitted rows.

A source-derived counterexample uses ordinary public methods and needs no external effects:

1. Start with a bee whose current runtime is booting and whose audit head is N. Use a driver with no observations, command budget zero, no pending mail, and disabled idle/I1 policies.
2. Inside `store.transact()`, call `updateRuntimeState(beeId, generation, "running", { synthetic: true })`. This path writes one runtime audit row. Call `core.step()` successfully, then throw from the outer callback.
3. Fable's cache now holds a running runtime at N+1. SQLite rolls back to the committed booting runtime and audit head N. The successful inner step has no knowledge of the later rollback.
4. Commit one unrelated `renameBee()` change, which also emits one audit row. The rolled-back AUTOINCREMENT value can be reused, so the head becomes N+1 again.
5. Advance time beyond the boot-hang threshold and call `step()`. The proposed cache hits N+1 and sees running. The fresh baseline sees booting and enqueues the hang stop.

The relevant mutation bodies are `store.ts:1691` and `store.ts:1494`. The audit table uses AUTOINCREMENT at `schema.ts:482`. This demonstrates a reachable API-level design defect. I found no current production tick caller deliberately nesting `step()` inside `transact()`, so it is not a claim that this failure already occurs in the live daemon.

Fable's rollback gate at `correctness-gates.md:24` performs writes and rolls them back before the subsequent tick. That checks the safe case. It does not acquire the cache inside the transaction and then commit different data at the reused sequence. Clearing the cache when `step()` throws would also miss the counterexample, since that step returns successfully.

If a later measurement justifies caching, either expose a store-owned transaction-aware validity check and bypass both cache reads and publication while a transaction is open, or explicitly prohibit `step()` inside transactions with an enforced check before any driver effects. The latter changes the calling contract and needs a deliberate decision. A commit counter alone is insufficient if uncommitted reads may still enter the cache under that counter. `boot()` invalidation addresses restart lifetime, not outer rollback.

There are two further limits on Fable's claims:

- `rationale.md:136` says busy ticks cost exactly today's cost, while `sketch.ts:101` explicitly adds a pass with map inserts and subset arrays. The asymptotic rebuild order stays the same, but CPU, allocations, and retained references do not. A replacement build may coexist with the previous retained graph. Whole message bodies and parsed bee configuration also stay reachable through the cache. The asserted 1–2 MB retention, unchanged RSS, and strictly lower GC pressure are not established for body-heavy or continuously changing workloads.
- `readonly BeeViewRow[]` and `ReadonlyMap` do not make `BeeViewRow`, `RuntimeRow`, nested configuration, or `MessageRow` deeply immutable. See `store.ts:203` and `types.ts:159`. Current loop bodies appear to consume those rows without modifying them, but the proposed types are not the claimed compile-time proof of safe sharing.

Audit completeness must also be stated precisely. Observation cursors and RPC result records have intentionally unaudited updates at `store.ts:2002` and `store.ts:2929`. Those are outside today's `StepSnapshot`, so they are not a separate demonstrated cache bug. They do disprove the broader premise that unchanged audit head means no database write. `dumpState()` at line 4253 and `spec01.13` at `v2/core/tests/spec01.test.ts:320` cover replayable state, not every table or every possible mutation sequence. A shadow-read harness is useful evidence, not exhaustive proof.

## Sol has a queue-scaling blocker

Sol's `README.md:137` proposes a correlated count of all undelivered predecessors for each I1 candidate. The existing `(bee_id, id)` partial index locates that prefix efficiently but still must visit its matching entries to count them.

For one bee with n old pending messages and all n selected, counting predecessors plus one visits approximately `n(n-1)/2` predecessor entries. Counting inclusively visits `n(n+1)/2`. At 10,000 messages either is about 50 million entries per read. Baseline `i1Telemetry()` ranks the queue with one `forEach`, so its ranking work is linear. This is a source-level complexity result, not an observed timing.

The cutoff does not fix this case. Old mail can all satisfy `enqueued_at < now - bound`. The JS `reportedI1` check happens after the SQL, so already-reported queues can pay the same counting cost every tick. An index-name assertion alone would pass while this regression remained.

For the first narrow I1 read, return all undelivered metadata in SQL `ORDER BY bee_id, id`, and compute positions in one pass. Reset the ordinal when the bee changes. Advance it for every pending message before skipping eligibility, deadline, or already-reported cases. Retain the zero-based position in the existing violation detail text even if a new internal type uses a one-based multiplier. Flagged bees may skip their whole group. Resolve runtime and flag facts in batches or once per distinct target, rather than once per message where practical.

A window-function rank over the complete pending relation is another linear-ranking design worth comparing later. Any cutoff must be applied after full-queue ranking, or preserve the ordinal through an equivalent method. Filtering first and numbering the survivors changes deadlines when older-id predecessors are outside the cutoff. Do not rely on enqueue timestamps being monotonic with mailbox IDs.

The cutoff itself is not inherently incorrect. For ordinary finite non-negative bound B, an overdue message has base at least `enqueuedAt` and position at least one, so its enqueue time is strictly below `now - B`. Keep the exact final deadline check. However, proving that necessary condition does not prove the second index is worthwhile. Sol already identifies omission of the cutoff as an open option in `rationale.md:53`. Take that option.

Sol also needs two qualifications before its larger rewrite:

- The promised `O(M_live)` mail access at `README.md:162` needs actual SQL and a plan. A join can start by scanning all pending mail and filter to live targets afterward. Require live-runtime-driven probes or evidence for an equally selective plan, especially with many stopped-target messages and one live bee. Preserve the latest-generation check for both runtime selection and the mail relation.
- `readDaemonWork()` still selects complete bodies for all pending mail on live runtimes, including booting runtimes and held idle mail. It removes stopped-target bodies and full bee display rows, but it is not the endpoint for large live queues. I1's body-free output also does not prove zero physical body-related I/O: non-covering metadata reads can still access mailbox table pages.

## Minimum safe first implementation

Add one proposed store method, `hasStepSnapshotInputs(): boolean`, and one partial runtime index. Use the existing cached-statement helper. No cache, new revision counter, partitions, time cutoff, command predicate, or new mailbox index is needed.

The method asks two conservative existence questions and short-circuits once either is true:

```sql
SELECT 1 FROM runtimes WHERE state != 'stopped' LIMIT 1;
SELECT 1 FROM mailbox WHERE delivered_at IS NULL LIMIT 1;
```

The runtime query is supported by Sol's proposed index:

```sql
CREATE INDEX IF NOT EXISTS runtimes_daemon_live
ON runtimes(bee_id, generation)
WHERE state != 'stopped';
```

`mailbox_undelivered` already exists at `v2/core/src/schema.ts:273`. Match the partial predicate in the prepared runtime statement. Verify both access paths on the supported SQLite version before accepting their performance. Without a selective runtime index, proving absence could scan the whole generation history and defeat the intended unit.

At the start of `stepSnapshot()`, return fresh empty `rows` and `pendingByBee` containers when the method returns false. Otherwise execute its existing body. Keep the three acquisition positions and the existing within-step `refreshSnapshot()` unchanged. Install the additive index through the repository's existing schema initialization discipline, including upgrade verification. No durable authority table changes.

The existence predicate deliberately considers any non-stopped historical runtime. An old non-current live row creates a conservative false positive and uses the baseline fallback. It cannot create a false negative. Do not add a latest-generation subquery to this first boolean probe. The eventual row-returning projection does need that subquery to preserve `currentRuntime()` semantics.

Do not return early from `step()` or reuse a previous tick's empty result. A queued spawn or revive can create work in the command phase, which must trigger the existing post-command refresh. Task supply can add a message after delivery, which must remain visible to the final I1 acquisition. Flags still expire before the initial snapshot. The normal single-writer synchronous boundary also makes both existence reads consistent with the following fallback. Nested transactional reads remain fresh and never escape into another tick.

This adds at most two small probes to a snapshot build. It can regress the busy fallback by that cost, and the runtime index has write and installation costs. Accept it only after the narrow checks below. This is not a declaration that all quiet-daemon cost becomes constant: observation folding, flag expiry, command checks, task supply, and the outer daemon tick remain unchanged.

Sol dismisses this fast path in `rationale.md:41` because it does not solve sparse fleets. That is a fair limit on the final design, not a blocker to using it as the first independently verifiable unit. Its predicate does not need to duplicate each timeout or urgency rule. It conservatively excludes every current snapshot consumer using just two durable facts. When the fallback is later replaced, retain this guard only if it still saves measurable work.

## Follow-on shape for sparse live work and large bodies

Keep the following as separate evidence-producing changes, rather than bundling them with the first guard:

1. Replace I1's display snapshot dependency with fresh ordered mailbox metadata plus current-runtime and active-flag facts. Use the linear ranking described above, without cutoff or new mailbox index. Compare exact ordered violation records against the old function. This alone does not remove the initial full snapshot, so do not claim the entire body cost is gone.
2. Replace the remaining policy/delivery fallback with Sol's current-live runtime projection. Reuse the runtime partial index, retain latest-generation filtering, preserve archived live targets, and preserve bee-id order. Keep `pendingStopExists()` live so a stop enqueued by an earlier policy suppresses a duplicate later in that phase. Mail for stopped or absent runtimes must continue through the independent I1 read. Keep same-step refreshes after commands and after delivery/task supply where their consumers need current facts.
3. If complete live-target queues remain body-heavy, read ordered queue metadata for pending existence, eligible-head selection, and the first unhandled `now` message. Fetch the complete body and sender only for the selected delivery message. `getMessage()` already exists at `store.ts:2413`. Decide per-target versus batched body retrieval from measured actionable cohort size. Preserve interruption before delivery, one accepted delivery per bee per tick, peer envelopes, consuming-generation fencing, and full mailbox results in existing public APIs. Do not substitute the paginated, body-budgeted `pendingMail()` API at line 2382 for the full internal queue.

At the sparse stage, use structural runtime types and existing mappings without claiming casts prove liveness. SQL selection and validated row shaping must establish state and nullability. Avoid storing derived current-runtime pointers or incremental audit projections for this work.

## Narrow acceptance gates for the parent

These are future gates. None was executed in this review.

| Gate | Minimum verification | What blocks acceptance |
| --- | --- | --- |
| Empty proof | Stopped and no-runtime bees with no mail return false regardless of lifecycle, flags, retained bee metadata, or history depth. Each live state or any pending message returns true. Include an old non-current live row. | Any false negative. |
| Transition visibility | Begin with an empty snapshot, execute spawn/revive, and prove the post-command acquisition sees the new runtime. Prove new mail after delivery is visible to I1. Keep observation fold and flag expiry ahead of reads. | Skipping the rest of the step, caching emptiness, or losing a refresh. |
| Time boundaries | Boot hang and idle stop at `now - timestamp > window`; flag expiry at `now >= resetsAt`; I1 at `now > deadline`. Include archived live, stopped/no-runtime mail, real-running and synthetic-running idle urgency. | Moving a strict boundary or dropping a target. |
| Transaction safety | Read inside an outer transaction, roll back, then commit different state at the reused audit sequence. The next read/step must use fresh state. If caching is reconsidered, use the explicit Fable counterexample, not only rollback-before-read. | Uncommitted state surviving the outer rollback. |
| First-unit query plans | Empty 1,000 and 10,000-bee stores with 1, 20, and 200 retained generations. Both existence probes use selective partial-index access without scanning bee or complete runtime history. Include delivered-only mailbox history. | An absence probe whose work grows with stopped history. |
| First-unit performance | Paired uninstrumented empty and busy-fallback measurements. Record snapshot CPU, allocations, complete-step CPU, and a separate attribution profile. Include a write every tick. | A quiet win presented without busy overhead or with unrelated phases omitted from the result. |
| Index tradeoffs | Runtime creation, transition to stopped, generation churn, first open of an existing store, subsequent open, database pages, WAL, and complete list-view query plans/results. | Material write/open/list regression hidden by the empty-read result. |
| Later I1 complexity | One bee with 10,000 old pending messages, all candidates; repeat after dedup. Double queue length and inspect operation/row counts as well as CPU. Include interleaved urgencies, cancellations, and non-monotonic enqueue times. | Prefix recounting, rank-after-filter, changed detail positions, or result truncation. |
| Later body/sparse behavior | One live target among many stopped bees; many stopped-target messages; one large live queue; small and large bodies. Separate JS materialization, retained heap, and physical I/O. | Scanning all stopped mail for live work, hydrating unused bodies, or claiming storage savings from a body-free result shape alone. |

Existing narrow source anchors include `v2/daemon/tests/loops.test.ts:270` for batch reads and refresh, line 311 for scale-to-zero, line 418 for degraded rotation, lines 446 and 469 for I1/flags, line 1126 for recovery, line 1206 onward for urgency, and line 1452 for flag expiry. Add the missing empty-branch and phase-transition cases. Preserve `unit.0`'s bounded-read intent while updating call-count expectations only where the new branch legitimately changes them.

Core anchors include `v2/core/tests/list-views.test.ts:82` for rolled-back derived reads, `core-extra.test.ts:61` for atomic completion/output/cursor state, and `spec01.test.ts:320` for audit replay. Follow the repository's required implementation checks after the parent resumes code work. A permanent production shadow-rebuild option is not required for the first unit.

The September command-index report already documents full-100k CPU +7.3% and upgrade storage +28.2% for that different index change, at `docs/performance/2026-09-06-cell-git/README.md:53` and line 61. Those numbers do not estimate the proposed runtime index. They establish why access-path wins, durable write costs, complete results, and storage must be reported separately. No cutoff index should be added merely because its read plan looks selective.

The first implementation decision is therefore narrow: prove and measure the empty-snapshot branch with one runtime index. Keep the fuller Sol projection as the continuation, replace its FIFO counts before implementation, and leave Fable's cache rejected until its transaction contract and memory economics are independently established.
