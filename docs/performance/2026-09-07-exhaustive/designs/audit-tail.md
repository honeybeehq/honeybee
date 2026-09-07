# C25 sparse per-bee audit tail design

Status: read-only proposal. No production or benchmark files have changed, and no performance result is claimed.

## Problem and current behavior

`CoreStore.auditTail(afterSeq, limit, beeId)` runs this query when `beeId` is truthy:

```sql
SELECT *
FROM audit
WHERE seq > ? AND bee_id = ?
ORDER BY seq DESC
LIMIT ?
```

It maps and parses only the selected rows, then reverses them. The public result is therefore the last `limit` rows for that bee after the exclusive cursor, returned in ascending `seq` order. The unfiltered branch has the same tail semantics and uses the `seq` primary key.

The `audit` table has `seq INTEGER PRIMARY KEY AUTOINCREMENT`, so `seq` is SQLite's rowid. It also stores `ts`, `kind`, nullable `bee_id`, and JSON `payload`. Current indexes cover selected mail lifecycle kinds and `bee.deleted`; none covers all rows for one bee. The current per-bee plan searches the rowid range backwards and rejects unrelated rows. C25 measures about 31 ms CPU with one million unrelated rows.

Consumer behavior must stay unchanged:

- daemon RPC defaults `afterSeq` to 0 and otherwise passes any finite number unchanged; it floors and clamps `limit` to 1 through 1000 and treats only a non-empty string as a bee filter;
- `hive events --bee` resolves the reference to a canonical ID before the RPC, applies `--kind` after the tail, and advances follow mode from the last returned `seq`;
- watch flushing calls `auditRows`, not `auditTail`, and must keep using the global `seq` path;
- daemon-down `ReadonlyStore.auditRows` currently reads every row after the cursor and filters per bee in JavaScript. The proposed index does not change or accelerate that fallback;
- deleted bees remain queryable because `bee.deleted` and earlier audit rows survive deletion.

## Recommended shape

Keep the existing method and SQL signature. Add this version-neutral index next to the `audit` table in `SCHEMA_SQL`:

```sql
CREATE INDEX IF NOT EXISTS audit_by_bee
  ON audit(bee_id)
  WHERE bee_id IS NOT NULL;
```

SQLite stores the rowid in every ordinary secondary index. Within one `bee_id`, this index is already ordered by `seq`; SQLite can traverse it backwards for `ORDER BY seq DESC` and apply `seq > ?` as a rowid range. On Node 24.20.0 with SQLite 3.53.4, the natural plan is:

```text
SEARCH audit USING INDEX audit_by_bee (bee_id=? AND rowid>?)
```

There is no temporary sort. This is plan evidence only, not a timing result.

The partial predicate omits authority events whose `bee_id` is null. The query's equality predicate proves non-nullness, so it can use the partial index. The index remains non-covering: `ts`, `kind`, and especially `payload` stay only in the table. At most the bounded result count needs table lookups and JSON parsing.

### Existing-index guard

Adding the general index changes another natural plan. Without `ANALYZE`, SQLite 3.53.4 chooses `audit_by_bee` for `latestBeeDeletedRow()` instead of the narrower `audit_bee_deleted_bee_seq`. That can make a historical snapshot before deletion walk a large per-bee history to prove no deletion existed.

Protect that private lookup explicitly:

```sql
SELECT seq, ts
FROM audit INDEXED BY audit_bee_deleted_bee_seq
WHERE kind = 'bee.deleted' AND bee_id = ? AND seq <= ?
ORDER BY seq DESC
LIMIT 1
```

The named index is guaranteed on every writable `CoreStore` open before callers can reach mail history. Honeybee already uses `INDEXED BY` where SQLite's ordering preference selects a materially worse command-history index. No public query or result semantics change.

## Alternatives considered

| Shape | Decision | Reason |
| --- | --- | --- |
| Partial `audit(bee_id)` | Measure as the preferred candidate | Uses the implicit rowid for cursor and order; one declared key field; excludes null-scoped rows. |
| Partial `audit(bee_id, seq DESC)` | Measure as the portability control | Makes the range and order explicit. `pragma_index_xinfo` shows `seq` as a second key plus the auxiliary rowid, so storage and install cost need comparison. |
| Full `audit(bee_id, seq DESC)` | Reject unless the partial predicate fails on a supported SQLite build | It also indexes null-scoped events without helping the filtered query. |
| Covering `audit(bee_id, seq DESC, ts, kind, payload)` | Reject | It duplicates every payload, including large mail audit JSON, to avoid at most 1000 bounded table lookups. |
| Per-bee projection or cache | Reject for this unit | It adds another maintained representation and recovery rules when one SQLite index can answer the existing query. |

If a supported Node/SQLite build does not naturally use the one-column index for both the rowid bound and ordering, use the explicit two-column candidate. Do not add `INDEXED BY` to `auditTail`; choose the index shape that the natural plan proves.

## Installation and migration

`audit`, `bee_id`, and `seq` have existed since v1. Follow the existing command and daemon-input index pattern: `CREATE INDEX IF NOT EXISTS` runs from `SCHEMA_SQL` on every writable open, installs on populated stores once, and does not bump `SCHEMA_VERSION`. Integrated main is currently v21 while this performance branch is v20; the eventual implementation should retain the version already present at integration.

The first open of a populated million-row store builds the index synchronously before the daemon becomes ready. That startup cost, temporary disk use, and failure behavior are part of the acceptance decision. A daemon-down read-only process never installs schema. An older store without the index remains correct and slow.

## Adversarial tests

Put focused tests in `v2/core/tests/audit-tail-index.test.ts`. Use `DatabaseSync` only against a closed test fixture for schema and plan inspection; do not expose the production store's private database handle.

1. Exact differential. Interleave target, other-bee, and null-scoped rows. For limits 1, 2, and 1000 and cursors before, between, and after target rows, compare full `AuditRow` values against `store.auditRows().filter(...).slice(-limit)`. Include no-match and dense-single-bee cases.
2. Ordering and gaps. Include non-contiguous sequences, a rolled-back audit insert followed by sequence reuse, and a cursor exactly equal to a target sequence. Results must be strictly ascending and `seq > afterSeq`.
3. Payload isolation. Give unrelated rows large payloads and one malformed JSON payload inserted while the store is closed. A target-only tail must neither return nor parse it; a selected malformed target row must still fail as before.
4. Deletion history. Verify per-bee tails still include `bee.deleted` after the bee row is gone. Create a historical mail snapshot before deletion plus substantial later audit traffic and prove `latestBeeDeletedRow` uses `audit_bee_deleted_bee_seq`, has no temporary sort, and preserves lifecycle folding.
5. Populated reopen. Create audit history, record schema version, state, and last audit sequence, close, drop `audit_by_bee`, then reopen. Verify the index's declared column and partial predicate, unchanged schema version and authority state, and idempotent second reopen.
6. Natural plans. The exact per-bee tail must use `audit_by_bee` with both bee equality and rowid or `seq` range and no `USE TEMP B-TREE`. The global tail must keep the integer-primary-key plan. Mail lifecycle expression indexes and the forced `bee.deleted` index must remain in use.
7. Public edges. Preserve the current distinction where `undefined`, `null`, and an empty string select the global CoreStore branch, while daemon RPC accepts only a non-empty bee string. Existing CLI tests continue to cover daemon-up, stale fallback, client-side kind filtering, and follow ordering.

## Measurement plan

Run strict frozen pairs for three database variants: no new index, partial `audit(bee_id)`, and partial `audit(bee_id, seq DESC)`. Record the source and ruler digests, Node and SQLite versions, page size, and identical fixture hash. Do not infer acceptance from `EXPLAIN` alone.

Use disposable copies with one million audit rows. Keep UUID-sized bee IDs and fixed payload bytes. Run at least these distributions:

- one target row among unrelated rows;
- 100 and 1000 target rows spread through the sequence;
- no target rows;
- all rows for the target bee;
- separate null-scoped shares, because the partial-index storage saving depends on that distribution;
- small payloads and large mail-style payloads, since table overflow pages affect the baseline scan but are absent from the index key.

Measure:

- Read measurements. Record wall and CPU distributions for limits 1, 100, and 1000 with cursors at 0, mid-history, near head, and beyond head. Include warm and fresh-process runs, A/A controls, allocation or peak RSS, the global tail, and the private deletion lookup.
- Write measurements. Run paired fixed batches of real CoreStore mutations under production WAL and synchronous settings, plus a raw prepared-insert transaction to isolate SQLite's marginal index work. Record wall, CPU, commit latency distribution, WAL growth, and bytes per inserted audit row for bee-scoped and null-scoped mixes.
- Storage measurements. After a checkpoint on fresh fixture copies, record database, WAL, and SHM bytes, `page_count`, `freelist_count`, and index-only pages and bytes from `dbstat WHERE name = 'audit_by_bee'`. Do not use a production `VACUUM` to make the number look cleaner.
- Install measurements. Remove the candidate index from identical populated copies and time the first writable reopen. Record wall, CPU, peak RSS, peak directory bytes, daemon start-to-ready time, and final index bytes. Time a second reopen separately to measure the `IF NOT EXISTS` steady state. One upgrade sample is evidence of that run, not a distribution; repeat from fresh copies for a distribution.

## Decision gate

First require exact semantic and plan tests. Then compare the read result with the measured write, storage, and one-time install costs. Accept the index only if the C25 reduction is outside A/A noise and the operator accepts those absolute costs. Keep the one-column shape only if every supported SQLite build proves the intended natural plan; otherwise select the explicit `seq DESC` control. Publish no intermediate performance claim.
