# Rationale

## Problem

At baseline `343289fe`, `DaemonCore.stepPhases()` builds `StepSnapshot` before policy work and refreshes it after audited writes. `stepSnapshot()` maps every undelivered `MessageRow` and every retained `BeeViewRow`. The policies and delivery code use only live runtime facts, target bee ids, and pending queues. I1 needs pending-mail facts for stopped and no-runtime bees, but it does not need message bodies or full bee rows. In the 1,000-stopped-bee profile, snapshot phases consumed about 94% of measured quiet-step CPU and the allocation profile was dominated by `listBees`, `listBeeViewRows`, and `mapBee`.

## Usage (caller's view)

`DaemonCore` calls `store.readDaemonWork()` before policies, reuses that result only within the same tick, and refreshes it after the command boundary when `lastAuditSeq()` changed. After delivery and task supply, I1 calls `store.listI1PendingCandidates()` and applies the existing time, urgency, flag, FIFO-position, and dedup rules. [README.md](README.md) contains the call sites and types.

## Shape

The chosen shape is a fresh, store-owned work projection. `DaemonWorkRow` contains one current live runtime and its ordered pending queue. Rows keep the current bee-id order, and messages keep mailbox-id order. The type contains no `BeeRow` and no `BeeView`. `I1PendingCandidate` contains only the fields that the existing I1 formula reads. These result types prevent a caller from accidentally depending on tags, environment values, lifecycle display data, or message bodies in telemetry.

`CoreStore` hides the SQL, partial indexes, latest-generation check, row mapping, and grouping behind two reads. This is a deep enough interface because the daemon asks two domain questions: which live runtimes can affect this step, and which pending messages can now be checked for I1. The daemon keeps ownership of clocks, thresholds, driver state, command effects, urgency decisions, and violation recording.

The design keeps `expireFlags(this.now())` before the first work read. Time passage can therefore clear a declared flag at the same instant as today. It keeps `pendingStopExists()` as a fresh query. A boot-hang stop enqueued earlier in the policy phase must be visible to the later degraded-mail policy, so a snapshotted `hasPendingStop` bit would change behavior unless the daemon also maintained mutable within-tick command state.

The design uses `lastAuditSeq()` only to reuse a projection across phase boundaries in one synchronous tick. No result survives into the next tick. `observe()` still folds runtime, output, flags, provider session ids, and observation cursors in one transaction before the work read. A rollback therefore exposes neither the projections nor the cursor. A later transaction may reuse the rolled-back audit sequence without matching stale in-memory data because there is no cross-tick cache.

Archived bees require no special branch. The live projection starts from current runtime rows and does not filter `bees.lifecycle`, so an archived bee with a booting, running, or idle runtime remains policy and delivery work. I1 starts from mailbox rows and left-joins the current runtime, so pending mail for a stopped or no-runtime bee remains observable.

## Synthesis decision

This candidate selects the fresh narrow projection as its base after comparing it with a rollback-safe snapshot cache and an existence-probe fast path. The parent arena still owns the cross-candidate synthesis. Nothing from another runner is claimed here.

## Tradeoffs accepted

- We accept two or three small prepared reads per relevant phase in exchange for removing work proportional to retained bees and full message bodies.
- We accept daemon-specific derived-read types in core in exchange for keeping SQLite and row-shaping knowledge out of `loops.ts`.
- We accept an additive partial-index write and storage cost in exchange for empty and sparse reads that scale with live work.
- We accept fresh I1 metadata reads when telemetry is enabled in exchange for exact post-delivery, post-task, and rollback-safe state.
- We accept fresh `pendingStopExists()` probes for policy candidates in exchange for preserving command visibility between policies without another mutable projection.

## Alternatives considered

### Rollback-safe snapshot cache

A store-owned cache could retain the full snapshot and key it by a commit generation that advances only after the outer transaction commits. Reads inside `transact()` would have to bypass the cache, and rollback would have to discard transaction-local entries. This avoids most allocation on unchanged ticks, but it retains duplicate rows and message bodies, rebuilds the whole roster after any relevant write, and still walks every cached bee unless it adds state partitions and deadline queues. Its invalidation contract reaches into `tx()`, observation folding, rollback, delete cascades, flag expiry, and every future unaudited projection. It hides less complexity than the two fresh reads because callers and store maintainers must understand cache lifetime as well as durable state. It loses here.

### Existence probe followed by the current snapshot

A cheap `hasDaemonWork()` query could skip `stepSnapshot()` when every runtime is stopped and no mail exists. It is the smallest patch and would win the supplied zero-live fixture. One booting or idle runtime would still map all retained bees and all undelivered bodies, so cost remains proportional to history whenever any work exists. It also needs a growing predicate for boot, idle, degraded mail, delivery, and I1. That predicate would duplicate the consumers without giving them a smaller result. It loses on sparse live fleets.

### Persisted current-runtime or daemon-work tables

A materialized current-runtime pointer or work queue could make reads constant-time, but every lifecycle, runtime, mailbox, command, and flag mutation would have to keep it synchronized. That creates another stored truth for facts already derived from SQLite authority. The core contract rules it out unless measurement later proves indexed reads insufficient and the governing model changes.

## Open questions and risks

- Do `EXPLAIN QUERY PLAN` results on the supported SQLite build choose `runtimes_daemon_live` and `mailbox_pending_enqueued` for the exact prepared statements, or does either query need an explicit rewrite?
- Does the write and file-size cost of both partial indexes remain negligible under mailbox churn and generation churn?
- Should the first implementation omit the I1 enqueue cutoff until a focused pending-mail fixture proves that it helps? The minimal metadata projection is correct without it.
- Does the parent want the existing `core.step.snapshot` metric name retained for before-and-after continuity, or split into `core.step.work_read` and `core.step.i1_read` after the first comparison?

## Next implementation step

Add store-level equivalence tests and query-plan assertions for the two projections, then implement the prepared reads without changing `DaemonCore` effects.

## Source grounds

- `v2/daemon/src/loops.ts:276-303` defines phase order and the two audited refresh boundaries.
- `v2/daemon/src/loops.ts:321-347` uses audit sequence only within a tick and builds the full roster and mailbox map.
- `v2/daemon/src/loops.ts:644-699` shows the runtime, timestamp, pending-mail, and pending-stop facts used by all three policies.
- `v2/daemon/src/loops.ts:895-949` requires full message rows only for live non-booting delivery targets.
- `v2/daemon/src/loops.ts:960-988` defines I1 flag suppression, idle eligibility, FIFO-position deadlines, and dedup.
- `v2/core/src/store.ts:1067-1093` shows nested writes joining one `BEGIN IMMEDIATE` transaction and rollback at the outer boundary.
- `v2/core/src/store.ts:2272-2293` expires declared flags transactionally and reads active flags.
- `v2/core/src/store.ts:2353-2371` establishes undelivered FIFO order and shows the current full `MessageRow` mapping.
- `v2/core/src/store.ts:2615-2648` generation-fences delivery and audits the mailbox change.
- `v2/core/src/store.ts:2999-3064` shows that `listBeeViewRows()` parses full bees, finds latest runtimes, maps all active flags, and derives views.
- `v2/core/src/store.ts:4217-4221` defines audit sequence as the store change version.
- `v2/core/src/schema.ts:210-273` defines runtime history, observation cursors, active flags, mailbox FIFO columns, and `mailbox_undelivered`.
- `v2/core/tests/list-views.test.ts:82-91` already guards rolled-back generations in derived reads.
- `v2/core/tests/core-extra.test.ts:61-89` already guards the atomic runtime, output, and observation-cursor fold.
