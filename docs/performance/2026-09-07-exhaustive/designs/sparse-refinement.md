# Sparse daemon snapshot refinement

Grounding: baseline 343289fe plus the accepted empty guard. This refines the
fresh-read direction in quiet-tick-design.md and designs/crossjudge.md. It does
not introduce a cross-tick cache, an I1 cutoff, a mailbox index, command-query
changes, or changes to existing public read APIs.

## Sequence

Land linear I1 metadata first as an enabling commit, then land the sparse,
body-free work snapshot immediately after it.

The I1 commit is the right review boundary because it isolates the hardest
semantic change: exact FIFO position for stopped, absent-runtime, flagged, and
live targets. It is not necessarily a standalone optimization. On an unchanged
held queue, a fresh final I1 read can add work where the old code reused the
initial full snapshot. Make no intermediate performance claim and judge
performance at the combined sparse/body-free tip.

## Unit A: fresh linear I1 input

Add these store-owned result types in v2/core/src/store.ts and export them
through v2/core/src/index.ts:

~~~ts
export type DaemonPendingMessageMeta = Readonly<
  Pick<MessageRow, "id" | "urgency" | "enqueuedAt">
>;

export type I1RuntimeFact = Readonly<
  Pick<RuntimeRow, "state" | "bootEvidence" | "updatedAt">
>;

export interface I1PendingBee {
  readonly beeId: string;
  readonly runtime: I1RuntimeFact | null;
  readonly hasActiveFlag: boolean;
  /** Ordered by mailbox id. The array index is the exact zero-based FIFO position. */
  readonly pending: readonly DaemonPendingMessageMeta[];
}

export class CoreStore {
  /** Fresh on every call; ordered by bee id; contains every undelivered message. */
  readI1PendingSnapshot(): readonly I1PendingBee[];
}
~~~

Do not add a separate position field. The pending array index is the existing
detail position, and index plus one is the deadline multiplier. This avoids two
representations drifting apart.

Use two cached statements inside one synchronous store call:

~~~sql
SELECT id, bee_id, urgency, enqueued_at
FROM mailbox INDEXED BY mailbox_undelivered
WHERE delivered_at IS NULL
ORDER BY bee_id, id;
~~~

~~~sql
WITH pending_bees AS (
  SELECT DISTINCT bee_id
  FROM mailbox INDEXED BY mailbox_undelivered
  WHERE delivered_at IS NULL
)
SELECT target.bee_id,
       runtime.state,
       runtime.boot_evidence,
       runtime.updated_at,
       EXISTS (
         SELECT 1
         FROM flags AS flag INDEXED BY flags_active
         WHERE flag.bee_id = target.bee_id
           AND flag.cleared_at IS NULL
       ) AS has_active_flag
FROM pending_bees AS target
LEFT JOIN runtimes AS runtime
  ON runtime.bee_id = target.bee_id
 AND runtime.generation = (
   SELECT MAX(latest.generation)
   FROM runtimes AS latest
   WHERE latest.bee_id = target.bee_id
 )
ORDER BY target.bee_id;
~~~

Group the ordered metadata once. Never filter before assigning array position.
In particular, idle-ineligible and already-reported messages still occupy their
positions. Runtime and flag probes occur once per distinct pending target, not
once per message. Validate runtime state and urgency while shaping rows.

Replace only the final I1 acquisition in DaemonCore:

1. Observations, flag expiry, initial work acquisition, policies, commands,
   post-command refresh, delivery, and task supply stay in their current order.
2. After task supply, read readI1PendingSnapshot() fresh.
3. i1Telemetry() iterates I1PendingBee.pending with its array index and keeps
   the current flag, idle eligibility, strict deadline, dedup, detail text, and
   logging rules byte-for-byte equivalent.
4. Keep the existing core.step.snapshot measurement boundary for comparison.

This final read sees delivery and task-supply writes without cross-tick state or
audit-sequence validity assumptions.

### Unit A tests

Add a core projection test file and focused daemon cases:

- Compare exact ordered I1 violation objects and I1 log order with a test-only
  oracle built from listBeeViewRows() and listUndeliveredMessages().
- Cover booting, idle, synthetic-running, real-running, stopped, and no-runtime
  targets; active and archived bees; active and cleared flags; now, next, and
  idle urgency.
- Use interleaved bee ids, delivered and cancelled rows, an idle-ineligible row
  before an eligible row, and non-monotonic enqueued_at values. Assert rank is
  by mailbox id and includes every undelivered predecessor.
- Assert no event at now == deadline and one event at deadline + 1. Preserve
  zero-based pos in detail and the one-based deadline multiplier.
- After delivery removes queue head zero, prove the next row is re-ranked to
  zero before final I1.
- Preserve the strengthened task-supply case: start stopped with no mail so the
  initial guard returns empty, feed after delivery, then prove final I1 sees it.
- Read inside an outer transaction, roll it back, reuse the audit sequence with
  another commit, and prove the next read is fresh.
- Seed an old noncurrent live runtime with a current stopped runtime. I1 must
  use the current stopped row.
- Seed 10,000 pending messages for one bee. Assert complete ordered output and
  exact first, middle, and last positions. Repeated reported violations must
  still perform one linear pass, never per-message prefix counts.
- Put large bodies and unique sender text in pending rows. Assert neither field
  exists in the projection and the final I1 path does not call a full mailbox
  read.
- With a test-only read-only DatabaseSync, verify mailbox_undelivered,
  flags_active, and the runtimes primary key are used. Do not expose CoreStore's
  private database handle in production.
- Re-run existing unit.0d, unit.0e, unit.6, unit.7, budget.9b, urgency.d6, and
  strict-boundary cases unchanged or with only input-shape updates.

## Unit B: sparse live work plus selected-body fetch

Reuse DaemonPendingMessageMeta and add:

~~~ts
export type DaemonLiveRuntimeRow = Readonly<
  Omit<RuntimeRow, "state" | "exitCause"> & {
    state: Exclude<RuntimeState, "stopped">;
    exitCause: null;
  }
>;

export interface DaemonWorkRow {
  readonly runtime: DaemonLiveRuntimeRow;
  /** Undelivered metadata for this live target, ordered by mailbox id. */
  readonly pending: readonly DaemonPendingMessageMeta[];
}

export class CoreStore {
  /** Fresh on every call; current live runtimes ordered by bee id. */
  readDaemonWork(): readonly DaemonWorkRow[];
}
~~~

The runtime read starts at the accepted partial index and filters out an old
noncurrent live row:

~~~sql
SELECT runtime.*
FROM runtimes AS runtime INDEXED BY runtimes_daemon_live
WHERE runtime.state != 'stopped'
  AND runtime.generation = (
    SELECT MAX(latest.generation)
    FROM runtimes AS latest
    WHERE latest.bee_id = runtime.bee_id
  )
ORDER BY runtime.bee_id;
~~~

The mail read must be live-runtime driven. This concrete shape makes runtime the
outer loop and performs indexed mailbox probes:

~~~sql
SELECT message.id, message.bee_id, message.urgency, message.enqueued_at
FROM runtimes AS runtime INDEXED BY runtimes_daemon_live
CROSS JOIN mailbox AS message INDEXED BY mailbox_undelivered
WHERE runtime.state != 'stopped'
  AND runtime.generation = (
    SELECT MAX(latest.generation)
    FROM runtimes AS latest
    WHERE latest.bee_id = runtime.bee_id
  )
  AND message.bee_id = runtime.bee_id
  AND message.delivered_at IS NULL
ORDER BY runtime.bee_id, message.id;
~~~

Reject the query if EXPLAIN QUERY PLAN scans mailbox rather than searching
mailbox_undelivered by bee_id. A small result sort is measurable, but a
pending-mail outer loop is not acceptable. Do not query bees; archived live
targets remain included naturally. Do not add a new mailbox index in this unit.

Change StepSnapshot to hold only DaemonWorkRow values. Keep
hasStepSnapshotInputs() provisionally: false returns a fresh empty work array;
true calls readDaemonWork(). The conservative old-live false positive therefore
does extra work but cannot create a false negative. Remove the guard later only
if the parent's paired measurements say it is redundant.

Policies consume runtime plus pending.length. pendingStopExists() remains a
fresh command query so a stop enqueued by an earlier policy suppresses a later
duplicate.

Delivery selects from metadata first. A successful now interrupt returns
without fetching a body. Otherwise fetch exactly the chosen eligible head with
the existing getMessage(messageId), validate that it still matches the target
and is undelivered, then perform peer-envelope rendering, driver delivery, and
generation-fenced markDelivered() exactly as today. A refused delivery may
fetch one selected body; booting, stopped, held-idle, empty, and
successfully-interrupted targets fetch none.

The three acquisition positions remain:

1. Fresh sparse work after observation folding and flag expiry.
2. Same-tick work reuse, or a fresh sparse work read after command-phase audit
   changes.
3. Fresh linear I1 input after delivery and task supply.

No result survives step().

### Unit B tests

- Differentially compare readDaemonWork() with the old full snapshot for every
  live state, zero and many messages, active and archived bees, and bee/message
  ordering.
- Exclude stopped and absent runtimes. Include archived live runtimes. Ignore
  an old noncurrent live generation when the latest generation is stopped.
- Populate many stopped bees and many stopped-target messages with one live
  target. Assert the plan scans runtimes_daemon_live and searches
  mailbox_undelivered by bee_id, without scanning bees or all mailbox rows for
  work.
- Assert projected message objects have no body, sender, priority, or delivery
  fields. Large body size must not change the JavaScript projection size.
- Count getMessage() calls: zero for nonselected paths and successful
  interrupts; one per selected target at most. Cover accepted and refused
  delivery, peer envelopes, an urgent row behind an earlier eligible row, and
  consuming-generation fencing.
- Preserve boot-hang, idle-stop, degraded-runtime, pending-stop dedup, command
  ordering, flag expiry, urgency eligibility, and strict time boundaries.
- Prove a revive/spawn from an initially empty snapshot appears in the
  post-command acquisition. Prove delivery and task feed appear in final I1.
- Repeat the outer-rollback and reused-audit-sequence counterexample. No stale
  work or I1 input may survive.
- Assert listBeeViewRows(), views(), listUndeliveredMessages(),
  undeliveredMessages(), pendingMail(), listMessages(), and getMessage() retain
  their public signatures and full results.

## Acceptance

Keep Unit A and Unit B as adjacent reviewable commits. Run focused core and
daemon tests after each. At the combined tip run core and daemon typechecks,
full core and neutral-environment daemon suites, then npm run build. Preserve
unrelated ambient failures separately.

Only the combined tip is a performance candidate. Its sequential materialized
work is proportional to current live runtimes, live-target pending metadata,
and complete pending metadata for I1. It does not hydrate the retained roster
or pending bodies. Distinct pending targets add indexed latest-runtime and
active-flag probes. Parent measurements decide whether the empty guard remains.

## Parent implementation refinements

Unit B selects only the six runtime fields its consumers use: bee ID, generation, state, start time, update time, and boot evidence. It does not assert an unused null exit cause. Natural query plans are preferred when they establish the intended selective reads; the live-runtime-driven join remains a measured requirement. Unit A is an enabling commit; performance acceptance applies to the combined A+B tip.
