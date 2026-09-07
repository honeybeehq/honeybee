# Query daemon work, not the retained roster

Baseline: `343289fe0f939ad3028550af14b4c5c068ea739e`.

## Usage

`DaemonCore` asks `CoreStore` for the rows that can affect this tick. It does not ask for user-facing `BeeViewRow` objects.

```ts
let takenAtSeq = this.store.lastAuditSeq();
let work = this.store.readDaemonWork();

this.bootHangPolicy(work);
this.scaleToZeroPolicy(work);
this.degradedMailPolicy(work);

this.executeCommands();
({ work, takenAtSeq } = this.refreshDaemonWork(work, takenAtSeq));
this.deliveryLoop(work);
this.taskSupplyLoop();

if (this.policy.i1DeadlineSteps != null && this.onI1Violation != null) {
	this.i1Telemetry(); // takes its own fresh, narrow read after delivery and task supply
}
```

The policy consumers keep their present decisions. Only their input shape changes.

```ts
private bootHangPolicy(work: readonly DaemonWorkRow[]): void {
	const now = this.now();
	for (const { runtime } of work) {
		if (runtime.state !== "booting") continue;
		if (now - runtime.startedAt <= this.policy.bootHangTimeoutSteps) continue;
		if (this.pendingStopExists(runtime.beeId, runtime.generation)) continue;
		this.store.enqueueCommand("stop", runtime.beeId, {
			cause: "stopped_by_system",
			reason: "hang_policy",
		});
	}
}

private deliveryLoop(work: readonly DaemonWorkRow[]): void {
	for (const { runtime, pending } of work) {
		if (runtime.state === "booting" || pending.length === 0) continue;
		// Existing urgency, interrupt, envelope, generation, and markDelivered logic.
	}
}
```

I1 reads current facts after the delivery and task phases. The store may use the strict enqueue cutoff as a coarse filter. The daemon still computes eligibility and the deadline.

```ts
private i1Telemetry(): void {
	const bound = this.policy.i1DeadlineSteps as number;
	const now = this.now();
	const candidates = this.store.listI1PendingCandidates({
		enqueuedBefore: bound >= 0 ? now - bound : undefined,
	});

	for (const row of candidates) {
		if (row.hasActiveFlag) continue;
		let base = row.enqueuedAt;
		if (row.urgency === "idle") {
			if (row.runtime?.state === "running" && row.runtime.bootEvidence === "real") continue;
			base = Math.max(base, row.runtime?.updatedAt ?? row.enqueuedAt);
		}
		const deadline = base + row.fifoPosition * bound;
		if (now <= deadline || this.reportedI1.has(row.messageId)) continue;
		// Existing record, dedup, detail, and log behavior.
	}
}
```

## Type sketch

```ts
export type LiveRuntimeState = Exclude<RuntimeState, "stopped">;

export type LiveRuntimeRow = RuntimeRow & {
	state: LiveRuntimeState;
	exitCause: null;
};

export interface DaemonWorkRow {
	/** A current runtime in booting, running, or idle. Archived bees are included. */
	runtime: LiveRuntimeRow;
	/** Every undelivered message for this bee, ordered by mailbox id. */
	pending: readonly MessageRow[];
}

export interface I1RuntimeFact {
	state: RuntimeState;
	bootEvidence: BootEvidence | null;
	updatedAt: number;
}

export interface I1PendingCandidate {
	beeId: string;
	messageId: number;
	urgency: Urgency;
	enqueuedAt: number;
	/** One-based position among every currently undelivered message for the bee. */
	fifoPosition: number;
	runtime: I1RuntimeFact | null;
	hasActiveFlag: boolean;
}

export interface I1PendingCandidateQuery {
	/** Optional strict cutoff. Omit it when the deadline bound is negative or untrusted. */
	enqueuedBefore?: number;
}

export class CoreStore {
	/** Fresh projection ordered by bee id. No result survives the caller's synchronous step. */
	readDaemonWork(): readonly DaemonWorkRow[];

	/** Fresh I1 facts ordered by bee id then message id. Includes stopped and no-runtime bees. */
	listI1PendingCandidates(
		query?: I1PendingCandidateQuery,
	): readonly I1PendingCandidate[];
}
```

`readDaemonWork()` performs two prepared reads behind one method. The first reads only current non-stopped runtimes in bee-id order. The second reads undelivered mail only for those runtimes in bee-id and message-id order. It groups messages by `bee_id` without parsing `bees.tags`, `bees.env`, or constructing `BeeView`.

The live-runtime query starts from this partial index and still checks that the selected generation is the latest:

```sql
CREATE INDEX IF NOT EXISTS runtimes_daemon_live
ON runtimes(bee_id, generation)
WHERE state != 'stopped';
```

The latest-generation check preserves `currentRuntime()` semantics even for a database that could contain an old live row through corruption or an old bug. The legal transition path means the index normally holds at most one row per live bee.

`listI1PendingCandidates()` returns mailbox metadata, not bodies. For each candidate, a correlated count over `mailbox_undelivered` produces the one-based FIFO position. A left join to the latest runtime preserves stopped and no-runtime mail. An indexed `EXISTS` supplies `hasActiveFlag`. The optional cutoff uses a second partial index:

```sql
CREATE INDEX IF NOT EXISTS mailbox_pending_enqueued
ON mailbox(enqueued_at, bee_id, id)
WHERE delivered_at IS NULL;
```

For a non-negative bound, every overdue message satisfies `enqueued_at < now - bound`. The query may return false positives because an idle runtime transition can move the deadline later. The daemon applies the exact existing formula. It must count all pending messages, including an ineligible idle message ahead of an eligible message, when it calculates `fifoPosition`.

## Module map

| File | Change | Ownership |
| --- | --- | --- |
| `v2/core/src/store.ts` | Add `readDaemonWork()` and `listI1PendingCandidates()`. Keep SQL, row validation, grouping, and FIFO-position calculation together. | SQLite facts and derived reads. |
| `v2/core/src/schema.ts` | Add the two partial indexes with `CREATE INDEX IF NOT EXISTS`. | Additive query support. No stored truth changes. |
| `v2/core/src/index.ts` | Export the two result types if `loops.ts` imports through the core package entry. | Package boundary only. |
| `v2/daemon/src/loops.ts` | Replace `StepSnapshot`, `stepSnapshot()`, and the I1 full snapshot with the narrow reads. Keep all effects and policy predicates here. | Tick order, time policy, driver effects, and telemetry. |
| `v2/core/tests/daemon-work.test.ts` | Prove projection equivalence, ordering, archived/live inclusion, stopped/no-runtime I1, rollback, and query plans. | Store contract. |
| `v2/daemon/tests/loops.test.ts` | Prove phase ordering, refreshes, deadlines, urgency, and pending-command behavior. | Daemon behavior. |

Do not add a cache module, invalidation callbacks, or a second revision counter. Do not change `listBeeViewRows()` because RPC list and snapshot consumers still need the complete derived view.

## Access-path trace

- `readDaemonWork()`: `runtimes_daemon_live` gives `O(L)` runtime rows, latest-generation probes use the `(bee_id, generation)` primary key, and `mailbox_undelivered` gives `O(M_live)` messages. `L` is the number of current live runtimes. `M_live` is pending mail addressed to those runtimes.
- `listI1PendingCandidates()`: the pending-mail indexes give metadata for messages old enough to be a violation candidate. Per-row FIFO counts use `mailbox_undelivered`. Work scales with candidate mail, not retained bees or message body bytes.
- A zero-live, zero-mail tick returns two empty arrays. It does not read `bees` or map stopped runtime history.

The measured baseline makes this the right cut. With 1,000 retained stopped bees, one generation, no mail, and 30 profiled ticks, snapshot phases used 682.612 ms of 722.7 ms total CPU. The sampled heap profile attributed 109,690,608 bytes, led by `listBees` at about 59.5 MB, `listBeeViewRows` at about 18.5 MB, and `mapBee` at about 8.8 MB. Profile timing is instrumented and must stay separate from the uninstrumented comparison.
