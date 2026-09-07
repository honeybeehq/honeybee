# C10 listMessages index shapes — report-first study (no production edits)

Lane: `honeybee-perf-c10-by-bee-2026-09-07` at `10c25dfc` (worktree untouched;
all scratch in /tmp). Method: real store built by the worktree's own
`openCoreStore`, raw bulk inflation to the parent's shapes (stated: bypasses
audit; diagnostic only), byte-copied per variant, verbatim production SQL
(normalized source-contains asserted for every statement). SQLite 3.53.4,
node v25.8.0. Raw data: `/tmp/honeybee-c10-variants.json` (5 variants,
13-statement plan matrix, row-identity proofs, sizes, timings) and the
earlier `/tmp/honeybee-c10-by-bee-study.json` (first A/B + cascade bytecode).
Wall timings here are DIAGNOSTIC — same-plan reads spread ±40% across runs
(control giant scan 682/891/535 ms in three loops), so only order-of-magnitude
deltas are trusted; the parent ruler + Mini gate own real measurement.

## 1. Target, callers, and statement inventory

`listMessages` (store.ts:2703): `SELECT * FROM mailbox WHERE bee_id = ?
ORDER BY id` — full-scans today (both existing mailbox indexes are partial on
`delivered_at IS NULL`; an all-rows query cannot use them). It is also the
one per-bee statement NOT using the `stmt()` prepared cache (`this.db.prepare`
each call, store.ts:2705) — switching it to `stmt()` alters neither API nor
SQL text; flagging for the parent, not proposing it here. Callers:
- mailbox RPC (daemon.ts:1344) — full listing per request;
- autoTitle dispatcher (autoTitle.ts:144) — up to N untitled ACTIVE bees per
  tick read their FULL mailbox (post-2026-09-01 pre-skip bounds who, not how);
- rpcSpawn idempotency fallback (daemon.ts:1603) — lists the original bee's
  messages to find the operator prompt.

Mailbox statement set (13, verbatim-verified): the target; 10 pending-predicate
statements (per-bee FIFO :2683, per-bee probe :2690, global list :2697,
pendingMail JOIN :2716, work-messages CROSS JOIN :3536, i1 facts CTE + i1
messages :3600/:3634, global probe :3678, ids-among :3690); PK get :2743; and
dumpState `SELECT * FROM mailbox ORDER BY id` :5479 as the all-row negative
control. No `INDEXED BY` anywhere; no production statement filters
`delivered_at IS NOT NULL` (grep: zero hits).

## 2. Schema facts that carry the analysis

- `id INTEGER PRIMARY KEY AUTOINCREMENT` (schema.ts:278) — rowid alias in a
  rowid table, so any mailbox index orders by (keys…, rowid=id) implicitly.
  Parent's scratch confirmed on the REAL schema: `index_xinfo(mailbox_by_bee)`
  = [bee_id (key), rowid (aux, cid=-1)]; `WHERE bee_id=? ORDER BY id` plans
  as `SEARCH … (bee_id=?)` with no temp B-tree.
- `bee_id TEXT NOT NULL REFERENCES bees(id) ON DELETE CASCADE` (schema.ts:279)
  with `PRAGMA foreign_keys = ON` (store.ts:1301) — enforcement is live, and
  deleteBee (store.ts:1940) is real. The cascade's internal child lookup must
  find ALL of a bee's mailbox rows; a pending-only partial index can never
  serve it (`bee_id = ?` does not imply `delivered_at IS NULL`), so today
  every deleteBee full-scans mailbox. Cascade children without a usable FK
  lookup index: mailbox (large), flags, questions (both small); runtimes,
  seals, task_supply are covered by PK/full indexes.

## 3. THE BLOCKER — plan theft by any full bee_id index

With `mailbox_by_bee ON mailbox(bee_id)` present, `undeliveredMessages`
(per-bee pending FIFO) moves off the covering partial:

    control:   SEARCH mailbox USING INDEX mailbox_pending_metadata (bee_id=?)
    candidate: SEARCH mailbox USING INDEX mailbox_by_bee (bee_id=?)

The stolen plan row-fetches the bee's ENTIRE history and filters. Same-bee
negative control (100k delivered + 20 pending on one bee): 0.046 ms → 50.3 ms
per call (~1000×). Blast radius is daemon-core: loops.ts:963 (delivery
selection), loops.ts:473 (synthetic turn-end), store.ts:2240/:3071/:5315
(command paths). This reverses part of the covering-index campaign win and is
disqualifying for the plain full-index candidate as-is. All other pending
statements (work/i1 projections, probes, pendingMail JOIN, global list) and
the dumpState negative control kept byte-identical plans — theft is confined
to `undeliveredMessages`, but that is enough.

## 4. Bounded alternatives (queries unchanged; no ANALYZE; no INDEXED BY)

| shape (same fixture, medians, wall, diagnostic) | sparse list 20-of-100360 | giant list 100k+20 | giant undelivered (20 pending) | cascade delete (one-shot) | index bytes (post-VACUUM) | stolen pending statements |
| --- | --- | --- | --- | --- | --- | --- |
| control (10c25dfc) | 27.93 ms | 891.8 ms | 0.046 ms | 60.7 ms | 0 | — |
| `(bee_id)` full | 0.090 ms | 548.1 ms | **50.35 ms** | 1.18 ms | 4,542,464 | undeliveredMessages |
| `(bee_id, id)` full | 0.088 ms | 663.1 ms | **55.95 ms** | 3.09 ms | 4,907,008 | undeliveredMessages |
| `(bee_id, delivered_at)` full | 0.101 ms | **1017.1 ms (temp B-tree)** | 0.092 ms | 0.86 ms | 4,927,488 | undeliv., probe, pendingMail JOIN |
| `(bee_id) WHERE delivered_at IS NOT NULL` + UNION ALL rewrite | 0.046 ms (rewrite) | 551.6 ms (rewrite) | 0.038 ms | 75.7 ms (no gain) | 4,538,368 | **none** |

- **`(bee_id, id)` refuted.** The explicit id key does NOT change planner
  choice — identical theft. `index_xinfo` shows THREE entries: bee_id (key),
  id (key, cid=0), AND the implicit rowid trailer (cid=-1) — SQLite stores
  the rowid-alias column twice, costing +364 KB (+8.0%) for zero ordering or
  planner benefit. Strictly dominated by `(bee_id)`.
- **`(bee_id, delivered_at)`.** Its thefts are individually efficient — the
  stolen pending plans seek `(bee_id=? AND delivered_at=NULL)` and stay
  covering for the probe and pendingMail JOIN (rowid supplies m.id), and
  giant-undelivered stays at 0.092 ms. Being a full index it also fixes the
  cascade (0.86 ms). But it destroys the TARGET's ordering property:
  listMessages becomes SEARCH + `USE TEMP B-TREE FOR ORDER BY` — a
  full-history sort per call, the worst giant number in the table (1017 ms)
  — and the UNION rewrite sorts on it too. Disqualified for C10's own goal.
  Worst write shape as well: delivered_at is IN the key, so every
  markDelivered pays an index entry delete+insert on top of every send/cancel.
- **Delivered-partial + single-statement UNION ALL rewrite (parent's shape).**
  `CREATE INDEX mailbox_delivered_by_bee ON mailbox(bee_id) WHERE
  delivered_at IS NOT NULL`, and listMessages as one statement:
  pending arm (`delivered_at IS NULL`) UNION ALL delivered arm
  (`delivered_at IS NOT NULL`), final `ORDER BY id`. Plan:

      MERGE (UNION ALL)
        LEFT  SEARCH mailbox USING INDEX mailbox_pending_metadata (bee_id=?)
        RIGHT SEARCH mailbox USING INDEX mailbox_delivered_by_bee (bee_id=?)

  No temp B-tree: both arms emit id-ordered rows (partial-prefix equality +
  implicit rowid), merged streaming. Zero theft — structurally (a
  delivered-only partial can only serve `delivered_at IS NOT NULL`
  statements, of which production has none) and empirically (moved=[]; all
  13 plans byte-identical to control). Row identity proven by deepEqual of
  rewrite vs current listMessages on the same snapshot for sparse (12/8),
  genuinely interleaved (20/20 alternating delivered/pending ids — the merge
  interleaves row-perfectly), and giant (100k+20) bees, on all five variant
  databases (the rewrite is also plan-safe WITHOUT the new index: the
  delivered arm just scans, still merged, still identical rows).

## 5. Write / open / storage considerations

- Write shape (structural; parent measures): delivered-partial leaves SEND —
  the hot, audit-bearing write — completely untouched (pending rows are
  outside the predicate), adds ONE index insert per markDelivered (mirroring
  the entry the pending partial removes at the same moment), and
  cancel-before-delivery mail NEVER touches it. Full-index variants instead
  pay an entry on every send and a removal on every cancel/cascade row
  (markDelivered untouched for `(bee_id)`/`(bee_id,id)`).
- Install: all shapes use v1-era columns only → SCHEMA_SQL-only install (the
  C18 pattern), `IF NOT EXISTS`, no schema_version bump, downgrade-tolerant
  both ways (an old build maintains unknown indexes automatically; re-upgrade
  is a no-op). First open after upgrade builds the index with one full
  mailbox scan — same class as the covering-index install — executed by the
  SCHEMA_SQL exec at store.ts:1302, which runs OUTSIDE the migration `tx()`
  wrap (:1303): a single-statement implicit transaction, so a crash mid-build
  leaves no index and the next open retries. Not claiming crash-injection
  coverage; that is the same documented posture as prior index candidates.
- Storage: ~4.54 MB at 100k delivered history (+28.8% on this fixture's
  15.8 MB file) for either `(bee_id)` or the delivered partial — history
  dominates, so the partial saves only the pending entries. It shrinks
  nothing; it grows with retained delivered history.
- FK cascade: ONLY full-index shapes fix the deleteBee mailbox scan
  (60.7 → ~1 ms one-shot diagnostic; bytecode in the first study shows the
  cascade's two mailbox read cursors moving onto mailbox_by_bee). The
  delivered-partial variant does NOT and no gain is claimed — its cascade
  one-shot (75.7 vs 60.7 ms) is within single-shot noise. deleteBee is a
  rare operator action, not a tick path; if the scan ever matters it is a
  separate future candidate (flags and questions share the gap, smaller).

## 6. Recommendation

Take the delivered-partial + UNION ALL rewrite forward as the C10 candidate,
gated on the parent ruler's same-bee negative control and Mini broad gate:
it is the only shape with zero theft surface, it preserves every existing
plan byte-for-byte, wins the sparse/autoTitle/spawn-fallback shape ~600×
(diagnostic), keeps sends untouched, and never indexes canceled-before-
delivery mail. Its open questions for measurement: the giant full-list shape
(delivered arm row-fetches via index vs today's scan — my wall noise cannot
rank 551 vs 892 ms honestly) and the per-delivery index insert cost. It IS a
production SQL change (one statement inside CoreStore.listMessages, no API or
caller change, result identity proven above) — awaiting explicit approval
before any production edit. Second choice if the rewrite is rejected:
`(bee_id)` full index is acceptable ONLY with a theft mitigation for
`undeliveredMessages`, none of which survives the constraints (no ANALYZE,
no INDEXED BY, queries unchanged); `(bee_id,id)` and `(bee_id,delivered_at)`
are dominated as shown.

## 7. Adversarial tests the eventual candidate needs

1. Identity: rewrite vs a raw `ORDER BY id` read across all-delivered,
   all-pending, interleaved, empty, and single-row mailboxes; multi-bee
   isolation (bind the same bee twice — both arms MUST use the same bee id).
2. Plan pins on verbatim production SQL: MERGE (UNION ALL), both arms on
   their named indexes, no TEMP B-TREE anywhere in the compound; full
   13-statement no-theft matrix re-pinned (broad suite gates acceptance —
   the distributed-pin lesson stands).
3. Migration: existing store gains mailbox_delivered_by_bee on open;
   pre-v8 fixture (urgency absent) opens clean — the new index needs only
   v1-era columns, so it installs before migrations by SCHEMA_SQL order;
   downgrade round-trip leaves it present and harmless, re-upgrade no-op.
4. Lifecycle: markDelivered moves a row between arms atomically (read after
   deliver sees it once, in id position); cancel-before-delivery never
   appears in the delivered index (index content probe via raw connection).
5. dumpState / global negative controls unchanged.

No worktree changes, no commits, no Mini, no frozen-lane edits. Scratch:
/tmp/honeybee-c10-by-bee-study.mjs, /tmp/honeybee-c10-variants.mjs (+ JSONs).
