# Cross-judge: automatic-title mailbox reads

Source judged: `604bf4046bfc5b57c67d5746e59405fd47409ec2`.

## Verdict

Use Sol as the interface and daemon-policy base, but do not implement either
package verbatim. For the first production version, replace Sol's mutable
commit-published version tracker with Fable's committed SQL membership stamp.
Keep that stamp private to the store-backed dispatcher. Pair each cache fill
with equal committed stamps before and after the full read.

This hybrid keeps Sol's strongest choices:

- `createAutoTitleDispatcher` and caller-supplied rosters keep the current path.
- The store-only path owns reuse without adding an optional public dependency.
- One bounded daemon summary supplies the exact signature and launch context.
- One policy implementation serves both fresh and cached summaries.

It also keeps Fable's strongest choice: derive invalidation from SQLite instead
of changing every mailbox mutation and the central transaction wrapper before
measurements show that an index scan is still too expensive.

Neither frozen candidate is ready for implementation without the repairs below.

## Scores

The scale is: 3 fully meets the criterion, 2 needs a bounded repair, 1 has a
material correctness or architecture gap, and 0 does not address the criterion.

| Rubric criterion | Fable | Sol | Judgment |
| --- | ---: | ---: | --- |
| 1. Exact decisions, context, bookkeeping, retries, scheduling | 1 | 2 | Fable's gate changes the `lastAt === 0` result and moves `loadState` ahead of `listMessages`. Sol preserves the phase shape and context fields, but its new summary decision still needs an explicit test and shared implementation for the source's truthy-`lastAt` rule. |
| 2. Rollback, id reuse, deletion, reopen, reentry | 1 | 3 | Fable blocks direct in-transaction stamps, but its split `evaluate` and `record` operations do not pair the cached signature with the committed state that produced it. Sol confines reuse to the real store, publishes only after the outer commit, stages create and delete, and disables reuse for custom dependencies and caller rosters. |
| 3. Finite retained state | 3 | 2 | Fable retains two bounded strings per reached active untitled Bee and no bodies or Core map. Sol bounds the daemon summary, but omits the bound and cost of Core's `byBee` and transaction-local `staged` maps. |
| 4. Read cost and measurement | 2 | 2 | Both state the main cost honestly and include adverse workloads. Fable correctly calls `COUNT(*)` O(index entries). Sol prices writes and pruning. Neither plan explicitly measures SQLite, WAL, and sidecar storage as the rubric requires. |
| 5. Ownership and interface depth | 1 | 3 | Fable puts durable facts in Core, but its public optional dependency and three-step gate expose coordination and duplicate the deferred and backoff predicates. Sol keeps reuse private to the store factory and puts normalization in one daemon implementation behind unchanged factories. |
| 6. Sequence, tests, rejected alternatives | 3 | 3 | Both provide coherent sequences, real-store tests, semantic differentials, adverse measurements, and explicit rejections without persistence or latency changes. |
| **Total** | **11/18** | **15/18** | **Sol is the stronger base, subject to mandatory contract repairs.** |

## Fable correctness blockers

### The gate changes the exact retry rule

The current predicate at `v2/daemon/src/autoTitle.ts:90-95` starts with
`bookkeeping?.lastAt`. A stored or custom bookkeeping row with `lastAt: 0` is
therefore not in backoff. Fable's proposed predicate at
`fable/signatures.ts:127-134` compares `now - lastAt` directly.

I ran the hash-identical baseline function with a substantive first message,
`attempts: 1`, `lastAt: 0`, `deferred: false`, and `now: 1000`:

```json
{"current":{"action":"generate"},"fablePredicateAsWritten":true}
```

Fable would skip while the source generates. Extract one retry predicate and
call it from both the existing decision function and the cache-hit path. Keep
the truthiness check byte-for-byte, including unusual custom dependency data.

### The claimed inert custom path changes callback order

The source order is `listMessages`, normalization, signature, then `loadState`
at `autoTitle.ts:144-147`. Fable's usage and pseudocode call
`deps.loadState` as an argument to `gate.evaluate` before `listMessages`.
Against the actual factory, a caller-supplied Bee produced this sequence:

```json
["enabled","now","getBee","listMessages","loadState","saveState"]
```

Custom dependencies may make those callbacks stateful or reentrant. An absent
`mailboxStamp` is therefore not inert under the proposed pseudocode. Do not add
`mailboxStamp` to `AutoTitleDeps`. Put reuse behind the existing store factory,
as Sol proposes, and leave the general factory's path in its current order.

### `evaluate` and `record` do not prove a committed read pair

Fable reads a stamp in `evaluate`, performs a full read, then asks `record` to
obtain a stamp for the signature. The interface does not require the pre-read
and post-read stamps to match. Its comments only reject a stamp that is null at
the instant `record` runs.

A permitted custom implementation is enough to break the guarantee:

1. `listMessages` returns a copied one-message thin mailbox.
2. Before it returns, the callback changes its backing mailbox to add a real
   task and changes the stamp.
3. The dispatcher saves the thin deferred signature.
4. `record` binds that thin signature to the new stamp.
5. The next scan sees the new stamp and matching deferred signature, then skips.

The current dispatcher reads the new task on step 5 and generates. A callback
can make the mismatch even harder to spot by opening and rolling back a
transaction inside `listMessages`, so equal committed stamps bracket a returned
speculative snapshot.

The production store callback is synchronous and pure, but Fable exposes the
capability on the general dependency interface. Keep the capability private.
On a cache fill, read `stampBefore`, call the real `store.listMessages`, read
`stampAfter`, and publish only if both committed stamps are equal. If either
read reports an open transaction, do not publish.

### The gate duplicates policy and its record point is unreachable as drawn

`ReadGate.evaluate` repeats both the deferred-signature shortcut and the
backoff predicate that already live at `autoTitle.ts:148-157`. That makes the
retry defect above likely rather than accidental. The three methods
`evaluate`, `record`, and `pruneToVisited` also require the caller to coordinate
one logical inspection across several branches.

The pseudocode places `gate.record` after the existing logic, but the relevant
source branches all `continue` or `break` at `autoTitle.ts:148-167` and
`autoTitle.ts:223`. An implementation would either miss cache fills or scatter
record calls through those branches. Reject this gate shape. Derive one summary
and run one policy function over either a fresh or cached summary.

### Visited-prefix pruning defeats reuse after normal breaks

Fable prunes to Bees visited by the walk. The source breaks when eight probes
have been consumed at `autoTitle.ts:137` and after one launch at
`autoTitle.ts:223`. Every active untitled Bee after either break loses its
baseline even though it remains in the fresh roster. This does not change a
decision, but it invalidates the claimed steady-state read reduction for the
suffix. Prune against the complete fresh roster and current lifecycle/title
fields, not the reached prefix.

### Fable's committed stamp itself is sound at this source

The two `(COUNT(*), MAX(id))` arms are a valid one-way equality proof for two
committed observations at `604bf404`. `mailbox.id` is AUTOINCREMENT
(`schema.ts:277-293`); inserts occur only in `send` (`store.ts:2628-2673`);
pending cancellation is the only direct row delete (`store.ts:2916-2929`);
and `deleteBee` removes the whole per-Bee set by cascade
(`store.ts:1899-1953`). Bodies and ids are not updated. Delivery and urgency
changes do not affect title inputs. Equal committed stamps therefore imply
equal ordered `(id, body)` rows. Returning no committed stamp while
`CoreStore.inTransaction` is true correctly excludes rolled-back id reuse.

The read is not O(1). `COUNT(*)` visits the matching entries in
`mailbox_pending_metadata` and `mailbox_delivered_by_bee`. Fable states this
cost correctly.

## Sol correctness and contract blockers

### The exported token's equality guarantee is too broad

`sol/signatures.ts:31-35` gives every unchanged Bee the same `initial` token.
If a store opens with Bee A containing body A and Bee B containing body B,
`mailboxContentsVersion(A)` and `mailboxContentsVersion(B)` return equal tokens
while their ordered contents differ. The cache is keyed by Bee id and would not
make that comparison, but the proposed public Core type does not encode that
restriction.

Creation also issues a new token for an empty mailbox. Token inequality therefore
does not prove a content change. It proves conservative invalidation, including
Bee incarnation.

Do one of the following before exposing the method:

- Define equality only for repeated reads of the same Bee id from the same open
  `CoreStore`, and name the value an invalidation token rather than a content
  version.
- Include Bee identity and store-incarnation identity in the opaque value.
- Keep the token entirely private to a store-backed auto-title reader.

The first production design does not need this contract if it uses the derived
stamp.

### Exact retry behavior remains an implementation trap

Sol says that the summary decision uses the existing retry helper, but the
helper only computes a duration. The load-bearing truthy-`lastAt` check remains
in `autoTitleDecision`. A new `autoTitleDecisionFromSummary` can easily repeat
Fable's defect. Use one shared predicate and add the `lastAt: 0` counterexample,
the exact expiry boundary, changed-signature reset, and capped attempts to the
differential tests.

### Core transaction publication needs a failure-safe insertion point

The actual `CoreStore.tx` commits at `store.ts:1359`, catches all later errors,
attempts rollback, and clears `txDepth` in `finally` at `store.ts:1346-1370`.
Sol asks that version publication happen after COMMIT and before `tx` returns.
If publication can throw after COMMIT, the existing catch reports a failed
mutation even though SQLite committed it.

The implementation must separate pre-commit failures from post-commit cache
publication. Stage only after successful create, send, applied cancellation,
or delete work. Discard the whole staged set on rollback. For nested calls,
publish once after the outer COMMIT. Tests must include a nested mutation whose
inner error is caught by the outer callback, a thrown outer callback, a failed
or no-op cancellation, and delete then recreate of the same explicit id.

Sol's delete/recreate state machine is otherwise the right one. The final
effect for an id must win: delete then create publishes a fresh present token,
while create then delete removes the entry. A new store and dispatcher on
reopen naturally require one full warm-up read.

### Sol omits part of its retained-state bound

The daemon entry has a real finite payload: at most one first clamped message
and three recent clamped messages, each at most 700 UTF-16 code units, plus
scalars and Map overhead. It retains no full initial task or `MessageRow`.

Core also retains `byBee` for every extant Bee changed or created since open,
including titled and archived Bees. `deleteBee` removes an entry, so this does
not grow with deleted history, but it can grow to O(all current Bees). The
transaction-local staged map is O(distinct affected Bee ids in one outer
transaction). State both bounds and measure both maps. The current plan only
measures the daemon cache.

### Sol's private store path handles custom dependencies correctly

This is a strength, not a blocker. `createAutoTitleDispatcher` retains full
reads, and a caller-supplied roster disables reuse. The real store path uses
one private SQLite connection and synchronous reads, so no writer can
interleave between a version read and `listMessages`. On a cached launch, keep
Sol's second token check after `getMessage`, verify Bee ownership, and rerun the
full signature, retry reset, and decision before saving a claim if any check
fails.

## Recommended synthesis

Start from Sol's dispatcher structure and bounded `AutoTitleMailboxSummary`.
Make these grafts:

1. Use Fable's `mailboxMembershipStamp` as the first store change detector.
   Return a discriminated `transaction_open` result rather than a nullable
   branded string if that makes the no-cache branch harder to ignore.
2. Keep the detector private to `createStoreAutoTitleDispatcher`. Do not extend
   `AutoTitleDeps`, and disable reuse whenever the caller supplies `BeeRow[]`.
3. On a fresh fill, require equal committed stamps before and after the real
   ordered read. On a cached launch, check the stamp before and after the
   selected `getMessage` read.
4. Refactor the existing normalization once into Sol's bounded summary. Make
   both exported legacy helpers and the cached path call the same signature and
   decision code.
5. Extract the source's exact backoff predicate, including truthy `lastAt`, and
   use it everywhere.
6. Prune against the complete no-argument roster. Measure the entry count and
   retained bytes, including the full-roster pruning set.

Keep Sol's commit-published tracker as a measured escalation. Build it only if
the adverse many-giant workload shows that Fable's O(index entries) stamp still
costs enough to justify changes to `CoreStore.tx`, `createBee`, `send`,
`cancelMessage`, and `deleteBee`.

## Rejections

- Reject Fable's public optional `mailboxStamp` and its
  `evaluate`/`record`/`pruneToVisited` gate.
- Reject Sol's commit-published tracker in the first production slice. It needs
  the token-contract and retained-map repairs plus a measured reason to touch
  the central writer path.
- Reject persisted sidecar or SQLite summaries. They add restore, migration,
  downgrade, and policy-version obligations.
- Reject fixed-prefix body reads and SQL row count as title summaries. The
  envelope-only counterexample already disproves them.
- Reject a rotating scan cursor in this behavior-preserving unit because it
  changes detection latency and fairness.

## Minimal implementation and proof sequence

1. Add the committed membership stamp and its real-store truth table. Pin both
   query plans, replay rolled-back id reuse, and cover cascade delete plus
   explicit-id recreation and reopen.
2. Add the pure bounded analyzer and run a seeded byte-for-byte differential
   against `userTaskMessages`, `contextSignature`, `autoTitleDecision`, the
   initial-task expression, and `slice(-3)`.
3. Add private store reuse with before/read/after pairing. Compare exact callback
   sequences for the general factory, exact outcomes and bookkeeping, probe
   positions, launch order, watchdog behavior, retry boundaries, and provider
   contexts.
4. Measure isolated A/A and ABBA processes. Include stable small fleets, one
   100k backoff Bee, many giant Bees, backoff expiry, all-changed scans,
   cancellation, deletion, reopen warm-up, allocations, cache bytes, SQLite and
   WAL bytes, and sidecar bytes. Keep headline timing separate from SQL and
   allocation diagnostics.

Semantic differential success is a prerequisite. The first production change
does not need a new schema, a persistent field, a scan-cadence change, or a
Core write-path hook.

## Provenance

- Rubric: `9fc776be964a1647fbe8531faeedeea00814cb545926a9931161702f8de23359`
- Task: `6d2d05a3657f8d1e98d780e820f1eccf67164a6c6fc60e12eacbff19c248b7db`
- Fable design: `d26c396154865e42f43da6485071e1683bd8f8fefccdc05711b16f0c82488123`
- Fable signatures: `635e0adea585ae237aa0d52b50e2ade68de577127bf0888815a2100841e07421`
- Sol design: `40c667de3f7cb2eb975bd0b04a21691980d095a9b9b7d29370ff83726bb292c0`
- Sol signatures: `7db34f18037be4714987288049e13f6f9f90d3bdd6b26636f1f3e77e29b70fed`
- Investigation: `5b49c29845fe8c48b9d6e66e0adaf710fffe9f08b4888ba4f077944dbf73bec5`
- Baseline auto-title source: `245e0202fd3758aac7cbf022f328ccc4b3f0e88b58303ff03b0e675bceef3e91`
- Baseline Core store source: `6a11139e98cb03f68bf0da31c58a2cb4864166faf439258b25fafcff40bef151`

I did not read `parent-notes.md` or `parent-alternative.md`.
