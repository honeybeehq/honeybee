# Is mailbox_undelivered redundant? — report-first design note (no edits)

Lane: pending-covering worktree state (production frozen at 6764453a; this
note proposes, nothing is changed). Scratch method: real store built by the
repo's own `openCoreStore`, byte-copied, old index dropped raw on the copy,
plans/storage compared; ratios diagnostic-only.

## Reference inventory (complete)

Production references to `mailbox_undelivered`: exactly TWO — the SCHEMA_SQL
declaration (schema.ts:294) and one prose doc comment
(store.ts:3573, hasUndeliveredMessages). There is **no `INDEXED BY` on any
mailbox statement** and no migration logic that names it. No production SQL
can break on removal; only plans can move.

Pending/full-body/eligibility statements over `delivered_at IS NULL`
(store.ts): per-bee full-body FIFO `undeliveredMessages` (:2660), per-bee
LIMIT-1 probe (:2667), global full-body `listUndeliveredMessages` (:2674),
pendingMail projection head (:2695), work-messages (:3477), pending_bees CTE
(:3517), i1-messages (:3550), global LIMIT-1 `hasUndeliveredMessages`
(:3579), `undeliveredMessageIdsAmong` rowid-IN (:3591). dumpState and
getMessage use the PK.

## Scratch plans: old+new vs new-only

| Statement | old+new | new-only |
| --- | --- | --- |
| per-bee full-body FIFO | SEARCH via mailbox_undelivered (bee_id=?) | SEARCH via mailbox_pending_metadata (bee_id=?) — same seek shape + row fetch |
| per-bee LIMIT-1 probe | covering metadata seek | unchanged |
| global full-body list | SCAN via mailbox_undelivered | SCAN via mailbox_pending_metadata — same shape |
| pendingMail head | covering metadata seek | unchanged |
| global LIMIT-1 probe | covering metadata scan | unchanged |
| ids-among | PK rowid membership | unchanged |

Every consumer lands on the identical access SHAPE through the new index
(same `(bee_id, id)` leading key, same partial predicate; full-body reads
still fetch rows, as they must). **Read-redundancy confirmed.** The only
theoretical read cost of removal: the wider index has lower entry density,
so non-covering seeks touch marginally more index pages — expected noise;
parent's read captures decide.

## Sizing / write-savings hypothesis

- Old-index entry ≈ (bee_id UUID ~36B, id, rowid) per PENDING row; vacuumed
  fixture delta at ~125 mixed rows: 12,288 B. Real sizing = parent capture.
- Write ops touching it per message lifecycle: send INSERT (entry add),
  markDelivered UPDATE (entry REMOVAL — the partial predicate flips),
  cancel/delete DELETE (removal). Same op COUNT as the new index with
  narrower entries — hypothesis: removal recovers a meaningful fraction
  (order ~40%, i.e. ~0.15–0.45 of your 0.4–1.1 ms/100 cycles) of the
  candidate's added write cost, plus the storage share. Measured, not
  asserted.
- My same-module write diagnostic is reported INVALID and discarded: the
  new-only variant reopened through `openCoreStore`, and SCHEMA_SQL
  **re-created mailbox_undelivered on open** — both runs actually carried
  both indexes. A clean same-module write AB is impossible without the
  production edit; it belongs to the paired-step run after the candidate
  exists (expected-changed = schema.ts [+ the store.ts comment]).

## Safe migration order (the crux — my flawed diagnostic proved it)

1. **Remove** the `CREATE INDEX … mailbox_undelivered` line from SCHEMA_SQL.
   Leaving it while adding a drop elsewhere would REBUILD the index on every
   open (a pending-scan per open) and then drop it — the exact
   rebuild/drop-every-open hazard to avoid.
2. **Add `DROP INDEX IF EXISTS mailbox_undelivered;`** in the post-migration
   index block, immediately AFTER the `MAILBOX_PENDING_METADATA_INDEX_SQL`
   exec — the new index exists before the old one goes. The whole block runs
   inside open()'s atomic transaction (migration + stamp commit together),
   so a crash rolls back to the previous state; no committed intermediate
   where neither index exists.
3. Idempotent forever after: `DROP … IF EXISTS` on an absent index is an
   O(1) no-op per open — no churn.
4. **Downgrade**: an older build's SCHEMA_SQL recreates the old index once
   on its first open (a one-time rebuild bounded by PENDING rows, not
   history — typically small); re-upgrade drops it again. No version bump;
   the schema-format equality checks in the rulers still hold.
5. Update the store.ts:3573 doc comment (prose only) in the same candidate.

## Dependencies to update with the candidate (enumerated)

- `step-snapshot-inputs.test.ts`: drops AND asserts reinstall of
  mailbox_undelivered (`indexColumns` + DROP/reopen) — must become an
  absence assertion (fixture WITH the index → open → gone); its probe pin
  already accepts either index.
- `tasks.test.ts:345` either-index pin: already compatible.
- My `pending-covering-index.test.ts`: compatible (drops only the new
  index); the pre-v8 fixture needs no change (it never creates the old
  index; SCHEMA_SQL would have — after removal it simply never exists).
- Grep confirms no other production or v2 src references.

## Adversarial tests the candidate needs

1. Existing-store removal: fixture WITH mailbox_undelivered → public open →
   index absent, all nine statements' plans land on the new index, per-bee
   and global full-body reads byte-identical (order + content) at a few
   hundred mixed pending/delivered rows.
2. Pre-v8 store: urgency migrated → new index created → old never created;
   open succeeds (extends the existing pre-v8 regression).
3. Downgrade round-trip: raw-recreate the old index (as an old build would)
   → reopen → dropped again; twice, proving idempotency.
4. Rollback: crash-safety rests on open()'s transaction atomicity (cite);
   an in-test outer rollback around open is not constructible — document
   rather than pretend.
5. Plan-pin sweep: the four suites already touching mailbox pins re-run;
   expect only the reinstall-assert change above (broad suite gates
   acceptance — the lesson stands).
6. Parent measurements: paired-step write cycles + closedStorage +
   read-hotspots C09/C10 + reopen cost, old+new vs new-only, same-boot
   pairs; the write-recovery number comes from there.

## Recommendation

Redundant for reads, plausibly profitable for writes/storage; removal is a
small, ordered, downgrade-tolerant candidate. Proceed only as its own
reviewed candidate after the covering index itself is accepted — removing
the old index before the new one is accepted would couple two decisions.
No production edits made; all frozen lanes untouched.
