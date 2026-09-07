# Store-owned membership checks for quiet automatic-title scans

This is the selected first implementation design. It is not performance acceptance. The original candidates and independent judge stay frozen. The parent owns measurement and integration; local implementation may proceed without a human checkpoint under the existing performance-program authorization.

## Caller usage

The caller still constructs and invokes createStoreAutoTitleDispatcher(store, options) with no new arguments. The general createAutoTitleDispatcher(deps) API is unchanged. Supplying BeeRow[] to either returned dispatcher keeps the existing full-read path and callback order.

Only the no-argument store-backed scan can reuse a prior signature. It skips a full read only when both the committed membership and the signature tied to current bookkeeping prove the existing code would take an unchanged-defer or active-backoff continue. Every possible new defer, retry reset, or generation still executes the current full read, normalization and full launch-context assembly.

## Core fact

Add readMailboxMembership(beeId), one cached compound statement. The result is a discriminated union with committed messageCount/maxMessageId or transaction_open. Check inTransaction before SQL and return the uncacheable variant while any outer or nested transaction is open.

The statement returns the SUM of counts and global MAX of ids over two aggregate arms, each constrained to the same Bee id, one pending and one delivered. Both placeholders bind the same Bee. The final identity combines the partitions so delivery does not invalidate it. Empty mailbox is count0/maxNULL. A missing Bee has the same empty membership, which is sufficient because no contents differ; the caller separately preserves the existing lifecycle/title behavior.

Use the existing mailbox_pending_metadata and mailbox_delivered_by_bee indexes. No schema, index, transaction wrapper, mutation, RPC or sidecar-format change. The read is O(that Bee's index entries), not O(1). A measured100k planning fixture costs3.209ms per aggregate. Bodies and ids must remain immutable, committed AUTOINCREMENT ids must not be reused, and all row-deletion paths are part of the proof. Uncommitted id reuse is excluded by transaction_open. Equality is a one-way contents proof inside the same live CoreStore, not a statement that every mutation changes the pair.

## Daemon reuse boundary

Add a private implementation entrypoint that the two existing factories call. Only createStoreAutoTitleDispatcher supplies the real store capability. General custom dependencies never receive or enable the capability. Caller-supplied BeeRow[] disables reuse for that invocation.

The private cache contains one membership identity and one exact context signature per reached active untitled Bee. It retains no MessageRow, normalized-history array, full initial task, provider context or persisted field. On a normal fresh-roster scan, prune it against all active untitled ids in that complete roster, not just the visited prefix. This avoids evicting valid suffix entries on the existing eight-probe or one-launch break. Between in-flight/disabled returns, the bound is the last scanned roster; do not claim instantaneous pruning without reading a roster.

A fill reads a committed membership before the real store.listMessages call and again after its pure normalization/signature calculation. Publish once, immediately after that pairing and before the existing continue/break branches. Publish only if both results are committed and both numeric fields match. No caller callback runs inside this trusted store read interval. Arbitrary independent custom callbacks cannot supply this guarantee and remain outside reuse. In a transaction, consume and publish no cache entry, while retaining today's full-read behavior.

On a prospective hit, load the store factory's private bookkeeping and require its signature to equal the cached signature. A missing or changed sidecar state falls through to the full read. Reuse only the two existing quiet conditions. Preserve truthy lastAt exactly. Prefer extracting the existing backoff expression into one small private predicate called by both autoTitleDecision and the quiet-hit path; this avoids a new summary decision and duplicated retry logic. An equivalent call to the existing decision that honors only its backoff result is acceptable if the author proves it more clearly. Do not synthesize launch context from bounded prefixes.

All non-hit paths preserve the legacy order of messages, normalization, signature, bookkeeping, unchanged-defer test, currentBookkeeping reset, autoTitleDecision, probe count, save and launch. Keep the single in-flight slot, watchdog, token fencing, roster order and scan cadence unchanged. Calls with a supplied roster keep the existing getBee-or-candidate fallback.

## Synthesis decision

Parent initial scores were Fable9/18 and Sol13/18; the independent judge scored11/18 and15/18. Both select Sol's private store-backed ownership as the stronger boundary and reject either original package verbatim.

The judge recommends deriving the membership from SQLite before adding Core commit hooks. The parent adopts that correction. The actual3.209ms100k probe is materially above Fable's first estimate, so the residual remains a measured escalation target, not a reason to hide it.

The parent narrows the judge's proposed summary rewrite. Graft Fable's quiet-only scope, but replace its public optional dependency and multi-step gate protocol with the private store-owned interval above. Keep full launch reads for this first candidate. The parent quiet-policy probe checks4,800 combinations against the current real policy and finds exact agreement for the quiet narrowing, including lastAt0 and unusual numeric states. It does not replace the required integrated semantic tests.

Reject the following from this slice:
- Sol's selected-message launch hydration and summary-policy rewrite. They are independent optimizations with a larger correctness surface.
- Sol's Core transaction version tracker, even with the corrected absence/staging addendum. First measure the simpler read-only change; the tracker needs separate write, failure, startup and retained-map tradeoffs.
- Per-arm serialized count/max identities, which conservatively invalidate on delivery. Use combined total count/global max.
- A global connection counter. The real proof shows unrelated audits and audited no-ops invalidate it; a busy-daemon workload would still reload unchanged giants.
- Persistent sidecar fields, SQL normalized summaries, fixed prefixes, or changed scan budgets/cadence.

## Verifiable units

1. Core read-only membership method and public-API truth-table tests. Cover empty/mixed contents, delivery/urgency silence, canceled-highest and interior rows, send/cancel net-equal identity, nested rollback/id reuse, cascade deletion/recreation/reopen, and exact production SQL plans. Keep the original writer path unchanged. Author runs focused tests and core typecheck only; parent performs broad Mini gates.
2. Private store-only quiet reuse. Test exact outcomes, bookkeeping bytes, provider contexts, launch order, probe limits, retry boundaries including zero, watchdog, state changes, supplied rosters, custom callback order/reentry, transaction scans and cache bounds. A changed or expiry path must still perform the original full read. Existing tests remain unrelaxed.
3. Parent source review and serial Mini build/all-v2/core/daemon gates, then immutable A/A and A/B measurements. Keep baseline and treatment frozen during capture. Reject a candidate with a correctness failure or an unpriced material common-case regression.

The approved quiet ruler is8e4d3cacea90a15760de59b40e65f37a692a1bfd12d5b20aba42a753cd9d2f67. Its Mini A/A baseline passed on two distinct322815d9 checkouts. Warm CPU per scan is2.759/2.754ms empty1000,4.052/4.230ms thin1000,139.902/139.322ms envelope100k,184.857/180.132ms backoff100k. These are before/control values, not candidate gains. Both giant partitions are exercised. Thirty raw samples per side/scenario are retained.

Acceptance additionally needs changed/expiry and multi-giant stress scenarios, measured allocation and retained cache cost, and SQLite/WAL/sidecar storage checks. No new write-path overhead is expected from this design because writers do not change, but unrelated-write invalidation behavior still needs functional proof. Stage further optimizations only after this unit's evidence is assessed.
