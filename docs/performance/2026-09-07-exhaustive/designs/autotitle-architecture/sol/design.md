# Candidate: commit-published mailbox versions

Status: independent architecture sketch against source `604bf4046bfc5b57c67d5746e59405fd47409ec2`. This is not an implementation or a performance claim.

## Problem

The one Hz automatic-title scan reads and maps every mailbox row for every active untitled Bee it reaches. Stable deferred and retry-backoff Bees do this without consuming the eight-probe budget. The scan must preserve exact normalization and context: the count of nonempty clamped texts, the first clamped text, the last three clamped texts, and the first full stripped non-thin body. A fixed prefix cannot supply those facts. The useful optimization boundary is therefore change detection, not approximate reading.

The design must also distinguish committed state from same-connection speculative state. SQLite may reuse an AUTOINCREMENT id from a rolled-back transaction, so equal `(max id, count)` does not identify content if a speculative result escaped. The cache may retain only results proven to describe committed data.

## Usage (caller's view)

The production daemon call does not change:

```ts
const autoTitle = createStoreAutoTitleDispatcher(store, {
  naming: () => naming,
  statePath,
  generate,
  log,
});

await autoTitle();
```

The one Hz call site also stays as it is. It supplies no roster, launches at most one generator, and leaves the 45 second watchdog intact:

```ts
if (autoTitle && now - lastAutoTitleAt >= AUTO_TITLE_SCAN_MS) {
  lastAutoTitleAt = now;
  void autoTitle();
}
```

Tests and custom callers keep the current dependency shape and behavior. They do not opt into reuse:

```ts
const dispatch = createAutoTitleDispatcher({
  ...deps,
  listMessages: beeId => mutableMailboxes.get(beeId) ?? [],
});

await dispatch(callerOwnedBeeRows);
```

Supplying `BeeRow[]` disables the store fast path for that invocation. The dispatcher still runs `getBee(candidate.id) ?? candidate` and reads the custom mailbox exactly as today. This protects callers that mutate rows, return synthetic rows, or use dependency callbacks with reentrant side effects.

## Current behavior that remains fixed

The dispatcher keeps this order:

1. Drain finished outcomes, then check enabled state and the global in-flight slot.
2. Use store roster order. Re-read caller-supplied Bees through `getBee`, preserving the existing fallback.
3. Skip inactive or titled Bees before any mailbox work.
4. Compute the exact title signature, load bookkeeping, preserve the unchanged-defer shortcut, and reset retries on changed context.
5. Increment the eight-probe count only for a defer transition or generation launch.
6. Save the same bookkeeping records. A launch still breaks the roster walk.
7. Build the same `TitleContext`, use one global generator slot, and retain the existing completion, title-write, retry, and watchdog rules.

The optimization changes which durable facts need body hydration. It does not change scan cadence, detection latency, fairness, roster order, or provider traffic.

## Shape

### Core publishes a process-local committed content version

`CoreStore` gains one narrow read, `mailboxContentsVersion(beeId)`. It returns an opaque committed token or the `transaction_open` variant. The token describes only the ordered set of `(message id, body)` rows for that Bee. It is process-local and must never enter SQLite, the automatic-title sidecar, RPC, dumps, or audit.

Core already owns every mailbox write on its private SQLite connection. It stages affected Bee ids while the outer transaction is open and publishes new tokens only after `COMMIT` succeeds. `ROLLBACK` discards the staged set. Nested `transact` calls join the outer staging set.

| Baseline operation | Version effect after outer commit | Reason |
| --- | --- | --- |
| Bee creation | new token | prevents a deleted id incarnation from matching an old cache entry |
| `send` | new token for the Bee | inserts immutable id and body |
| successful pending `cancelMessage` | new token for the Bee | removes one signature input |
| `deleteBee` | remove the Core entry | the foreign-key cascade removes all mailbox rows |
| `markDelivered` | none | delivery fields do not enter title analysis |
| `expediteMessage` | none | urgency does not enter title analysis |
| failed/no-op mutation | none | durable title inputs did not change |
| rolled-back outer transaction | none | no committed fact changed |

The implementation uses one lazily allocated staging map per transaction that actually touches a title input. It does not add a generic commit-hook or observer system. A transaction can conservatively invalidate once even if its net mailbox contents return to their starting state. That costs a later full read but cannot change a title decision.

The current immutability scope is exact and small. `send` assigns `mailbox.id` and `mailbox.body`; no baseline statement updates either column. Cancellation and Bee deletion remove rows. Delivery stamps and urgency can change, but naming ignores them. Moving a row between the two delivery partitions also preserves `listMessages` order because the union has a final `ORDER BY id`. A future body edit, id rewrite, ordering change, or new deletion path must stage a new token or revise this contract.

On a committed cache miss, the version read and `listMessages` run adjacently in one synchronous JavaScript turn with no dependency callback between them. The private connection and serialized writer prevent a commit from interleaving with those reads. The dispatcher publishes the derived summary only after both return.

### The daemon caches a bounded title summary

The daemon keeps normalization and provider policy. A single pass over `listMessages` produces:

- the number of nonempty `clampUserMessage` results;
- the first such result, at most 700 characters;
- the last zero to three such results, each at most 700 characters;
- the id of the first message whose full stripped body is not a thin opener;
- the full stripped initial task only for the current scan or in-flight generation, never in the cross-tick cache.

The retained entry contains the committed Core token and the first four bounded fields. It never retains `MessageRow`, the complete clamped history, or a full initial-task body. The entry is at most four clamped strings plus scalar metadata. The generator receives fresh arrays, never the cache's arrays.

On a cache miss, the dispatcher performs the existing full ordered read and derives all facts in one pass. On a committed token hit, it computes the signature and decision from the retained summary. Stable defer and backoff paths read no bodies.

If a token hit becomes generation-ready, the dispatcher fetches only the recorded initial-task message by id and combines its stripped body with the cached last three texts. Two thin messages can legally generate with no non-thin initial task; that case performs no selected-body read and keeps `initialTask: ""`. The selected row must still belong to the same Bee. A missing row, wrong Bee, open transaction, or changed token abandons reuse, performs a full ordered read, and reruns signature, retry-reset, and decision logic before launch.

The cache exists only inside `createStoreAutoTitleDispatcher`. The general `createAutoTitleDispatcher` continues to call `listMessages` every time. Store-backed invocations with a caller-supplied roster also use that path. This keeps custom dependency order and reentry behavior unchanged.

For normal no-argument scans, the dispatcher prunes cache keys against the complete fresh roster and drops entries when a current Bee is inactive or titled. Retained state is therefore bounded by the current roster, not total mailbox history or deleted Bees. Pruning and cache bytes need measurement because the full-roster id set is new work.

### Transaction proof

There are three cases:

1. A cached entry came from committed state. Inside any later outer transaction, `mailboxContentsVersion` returns `transaction_open`, so the dispatcher neither consumes nor replaces that entry. It does the same full read as the status quo.
2. A transaction commits a send, cancellation, creation, or deletion. Core publishes the replacement token after SQLite commits and before the mutation call returns. The next scan cannot hit the old entry.
3. A transaction rolls back. Core publishes nothing, and the dispatcher could not have cached its read. If speculative body A used id 1 and committed body B later reuses id 1 with the same `(max, count)`, B's successful commit still publishes a new token. No result derived from A can match it.

This proof does not depend on AUTOINCREMENT behavior. It depends on the private database connection, the complete mutation inventory above, and cache publication being forbidden whenever `CoreStore.inTransaction` is true.

### Module map

| File | Change |
| --- | --- |
| `v2/core/src/store.ts` | Add the version union, private transaction-local affected-Bee map, post-commit publication, rollback discard, and `mailboxContentsVersion`. Stage create, send, applied cancel, and delete. |
| `v2/core/src/index.ts` | Export the new Core token type. Existing read APIs remain unchanged. |
| `v2/daemon/src/autoTitle.ts` | Add the one-pass analysis, summary-based signature and decision internals, and the store-only cache. Keep existing exported helpers as wrappers over the same policy. |
| `v2/core/tests/mailbox-contents-version.test.ts` | Prove commit, rollback, nested transaction, mutation inventory, deletion, and reopen behavior. |
| `v2/daemon/tests/autoTitle.test.ts` | Add exact differential, cache-bound, custom dependency, selected-body, and retry tests. |
| `v2/daemon/src/daemon.ts`, `v2/daemon/src/naming.ts`, schema and sidecar format | No change. |

The interface is deliberately small. Core hides transaction staging and mutation coverage behind one read. The daemon hides cache policy and body selection behind the two existing factories. Callers do not coordinate invalidation, choose cache modes, or handle versions.

The design-red-flag screen found no new shallow public module, transport leakage, or pass-through API. Core owns commit knowledge, while `autoTitle.ts` owns normalization and reuse. The only cross-module value is an opaque token whose representation carries no title policy.

## Synthesis decision

This independent candidate chooses the commit-published token over an indexed fingerprint probe. The parent cross-judge still owns synthesis. The token removes SQLite work from unchanged scans instead of replacing a body traversal with an index traversal. It also makes rollback safety structural: an open transaction cannot produce a reusable token, and only the outer commit publishes one.

The cost is a surgical change to the Core transaction path. That is the design's unresolved seam and the main cross-judge question. It should not be accepted on architectural neatness alone. The write overhead, cache memory, roster-pruning allocation, and unchanged-scan CPU must beat the lower-risk fingerprint design under the same frozen ruler.

## Tradeoffs accepted

- We accept narrow transaction bookkeeping on mailbox-changing writes in exchange for no SQLite mailbox scan on a stable title candidate.
- We accept one bounded summary per cached active untitled Bee in exchange for eliminating repeated body materialization.
- We accept a conservative cache miss after a send-then-cancel transaction in exchange for simple commit logic.
- We accept a one-row body read when an unchanged backoff expires in exchange for never retaining an unbounded initial task.
- We accept a full-roster cache-pruning pass in exchange for a hard bound tied to current Bees instead of total historical ids.

## Alternatives considered

### Status quo

Keep `listMessages` on every reached active untitled Bee. It has the smallest interface and no retained state, but it repeatedly loads and maps every body during stable defer and backoff. The measured call-count shape makes that cost permanent at one Hz. It does not meet the CPU objective.

### Committed `(max id, count)` fingerprint plus the same summary

The lower-risk alternative keeps mutation paths untouched. Outside a transaction, Core could run this body-free query and compare both result rows with an in-memory baseline:

```sql
SELECT MAX(id) AS max_id, COUNT(*) AS row_count
FROM mailbox
WHERE bee_id = ? AND delivered_at IS NULL
UNION ALL
SELECT MAX(id) AS max_id, COUNT(*) AS row_count
FROM mailbox
WHERE bee_id = ? AND delivered_at IS NOT NULL;
```

Both placeholders bind the same Bee. On the baseline indexes, local Node 24 `EXPLAIN QUERY PLAN` selected `mailbox_pending_metadata` for the first arm and `mailbox_delivered_by_bee` for the second. VDBE used index rowids and did not read a body column. The count still visits every matching index entry, so a 100,000-row unchanged Bee remains O(history) each second. It must also return an uncacheable result inside a transaction to avoid the proven rolled-back-id counterexample. This alternative hides less complexity in Core, but leaks the full history size back into every scan. It should win only if measurement shows transaction tracking is not worth its write-path risk.

### Commit callbacks or a persisted normalized summary

A Core-to-daemon invalidation callback avoids polling, but it introduces subscriber lifetime, callback failure, and reentry rules into the writer. Persisting normalized title facts in SQLite or `auto-title.json` adds migration, restore, downgrade, and policy-version concerns. It also makes Core or storage know daemon normalization. Both shapes expose more coordination than an opaque version read, so this candidate rejects them.

## Test plan

### Pure policy differential

- Generate ordered message lists containing envelope-only, whitespace-only, thin, substantive, and over-700-character bodies. Include every sender value because sender is intentionally ignored.
- Compare the new one-pass analysis with the baseline `userTaskMessages`, `contextSignature`, `messages.map(stripSessionEnvelopes).find(...)`, and `slice(-3)` results byte for byte.
- Cover zero messages, two thin messages, arbitrarily long envelope prefixes, a giant initial task, and more than three later messages.

### Core commit boundary

- Assert that create, send, applied cancel, and delete change the committed token only after the outer commit. Multiple nested changes to one Bee publish one replacement.
- Assert that delivered cancellation refusal, missing cancellation, delivery, urgency, title, and unrelated-Bee mutations leave the token unchanged.
- Reproduce the rollback counterexample exactly: observe speculative id 1/body A during an outer transaction, verify `transaction_open`, roll back, commit id 1/body B, and prove no speculative summary was publishable.
- Delete a Bee with mailbox rows and prove the cascade cannot leave a matching token. Recreate the same explicit id in a test even though production ids are documented as non-reused.
- Close and reopen the store. Construct a new dispatcher and prove its first eligible scan performs a full read before any reuse.

### Dispatcher semantic differential

- Drive the old and new algorithms with the same ordered records and deterministic clock. Compare exact outcomes, every bookkeeping record, title write, log, provider context, launch position, and watchdog result.
- Cover stable empty/thin deferral, envelope-only giant deferral, substantive giant backoff, backoff expiry, changed-context retry reset, cancellation of the selected first task, and send during an in-flight generation.
- Put a ready Bee before and after a deferred fleet. Assert the same roster visits, eight-probe transitions, one launch, and break point.
- Prove stable deferred and backoff hits perform zero body reads. Prove a launch hit reads at most the selected initial-task row and returns the exact ordered last three clamped texts.
- Invoke the store dispatcher inside an outer transaction. It must perform a full read and publish no entry on either commit or rollback paths until a later committed scan.
- Pass mutable caller-owned `BeeRow[]`. Mutate lifecycle, title, and id between calls, exercise the `getBee ?? candidate` fallback, and assert the legacy dependency call order.
- Use custom deps whose `listMessages`, `loadState`, and `saveState` mutate fixtures or reenter once. Since the general factory has no reuse path, results and call order must match the baseline.
- Delete enough Bees across scans to prove cache size never exceeds the current complete roster and no full body, `MessageRow`, or full initial task survives in an entry.

### Query and source guards

- Assert the Core mutation inventory with behavior tests rather than a private database handle. A test should fail when a new body or membership mutation omits version staging.
- Keep existing listMessages order and index-plan tests unchanged. No new schema or index is part of this candidate.

## Measurement plan

Use separate frozen before and after processes with matching source, tool hashes, fixtures, warmups, and sample order. Do not publish an intermediate performance claim.

Measure:

- 1, 100, and 1,000 stable deferred and backoff Bees over enough one Hz-equivalent scans to reach steady state;
- 100,000-row delivered history, envelope-only history, and large-body histories;
- a ready Bee at roster head and tail;
- one changed Bee per scan, all Bees changed, backoff expiry, send-cancel churn, and delete churn;
- CPU and allocation under unchanged scans, full refreshes, selected-body launch, roster pruning, send, cancel, and outer transactions;
- retained heap and cache entry count at fixed roster sizes, then after deleting the full roster;
- exact counts of version reads, full `listMessages` reads, selected `getMessage` reads, generator launches, and bookkeeping writes.

Acceptance requires semantic differential success first. Performance acceptance then requires an unchanged-scan win without material send/cancel regression or retained-memory growth with historical deletions. The query-fingerprint alternative should run under the same fixtures if the commit tracker's write cost or complexity is disputed.

## Open questions and risks

- Does the measured unchanged-scan gain justify changing `CoreStore.tx`, or is the indexed fingerprint fast enough with less writer risk?
- Is a full-roster id set for pruning allocation-neutral enough, or should implementation use an epoch mark on entries while keeping the same current-roster bound?
- Should a committed version be a stable object or a symbol-bearing discriminated value? It must allocate only on committed changes, not on every read.
- Can every future live import or restore only replace the store and dispatcher together? If any path mutates a live private database outside the listed Core methods, it must join version staging before implementation is safe.

## Next implementation step

Build the Core committed-version seam and its rollback/delete/reopen tests first, then add the daemon summary cache behind the unchanged store-dispatcher signature.

## Grounding provenance

- Task SHA-256: `6d2d05a3657f8d1e98d780e820f1eccf67164a6c6fc60e12eacbff19c248b7db`
- Architect runner prompt SHA-256: `baf96910e3a47fb4d901ac2d35b7ef00cef76acd979b7fbb6c8c20af6fa29056`
- Investigation SHA-256: `5b49c29845fe8c48b9d6e66e0adaf710fffe9f08b4888ba4f077944dbf73bec5`
- Original study SHA-256: `4d425165c77f52edcc5c273aa2d1d56b4ea18e2511865348b52cc501343d8439`
- Original executable study SHA-256: `7cf8bc6f63f439025366f052e89107a9539d05b1f63945c07dc39ebce3defc58`
- Original count evidence SHA-256: `391f5d5b97f87438210e3515daba97f2dcee7516120b849dee44bd0cb6474951`
- Corrected fidelity study SHA-256: `f8f1fcb14409c8cf6cdd31c345988cd38d27d44c7f1d25588ac45ecaf80ea2d0`
- Rollback counterexample SHA-256: `36f5b076776f791ed4b10371d0fdd7d7c83683a10843c911c2d2f040a93f0eda`
- Baseline `autoTitle.ts` SHA-256: `245e0202fd3758aac7cbf022f328ccc4b3f0e88b58303ff03b0e675bceef3e91`
- Baseline `naming.ts` SHA-256: `eae82ba481b3e5b74d7d80c38ca50d6bbf64e378e48e8a7c953d35b2f0a643f5`
- Baseline `daemon.ts` SHA-256: `37cd4d03a456d076100671fe6da175ea72bbc449d8661c761543a0a27669c6ca`
- Baseline `store.ts` SHA-256: `6a11139e98cb03f68bf0da31c58a2cb4864166faf439258b25fafcff40bef151`
- Baseline `schema.ts` SHA-256: `5521ca43cd2db4987d811aa28a21174618cffbdcf8f44793f6896b13c07aeb7e`
- Cheap local check: 1,000 deterministic adversarial message lists produced the same count, first clamped text, last three clamped texts, and initial task as the baseline functions.
