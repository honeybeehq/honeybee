# Addendum: smaller first slice for automatic-title quiet reads

Status: recommended first implementation slice against
`604bf4046bfc5b57c67d5746e59405fd47409ec2`. The frozen Fable and Sol
packages remain unchanged.

## Recommendation

Yes. The first slice can stop before Sol's summary, selected-body read, policy
rewrite, and commit-published Core version. Cache only the last verified
`{ membershipStamp, signature }` for each eligible Bee in the concrete
store-backed dispatcher. Use that cache for exactly two outcomes already known
to be content-independent: unchanged deferral and active retry backoff.

Every path that can defer on new information, generate, reach backoff expiry,
save changed bookkeeping, consume a probe, or build title context must retain
the existing full `listMessages` read, `userTaskMessages` normalization,
`contextSignature`, decision, `initialTask`, and `slice(-3)` logic. This makes
summary fidelity and selected-body hydration unnecessary in slice one.

## Narrow seam

- Add one read-only Core fact, `mailboxMembershipStamp(beeId)`, which reports no
  reusable value while this `CoreStore` has an open transaction.
- Keep the cache and stamp capability private to the store-backed dispatcher.
  Do not add it to exported `AutoTitleDeps`.
- `createAutoTitleDispatcher(customDeps)` and every caller-supplied roster keep
  the current path and callback order. A supplied roster neither reads,
  publishes, nor prunes this cache.
- A no-argument store scan prunes against the complete fresh roster, not the
  visited prefix. Retain entries only for active, untitled Bees. Normal early
  returns before a roster read may temporarily retain the preceding bounded
  roster; do not add a roster read merely to prune.

The stamp should come from one cached statement over both existing partial
index arms:

```sql
SELECT SUM(row_count) AS row_count, MAX(max_id) AS max_id
FROM (
  SELECT COUNT(*) AS row_count, MAX(id) AS max_id
  FROM mailbox
  WHERE bee_id = ? AND delivered_at IS NULL
  UNION ALL
  SELECT COUNT(*) AS row_count, MAX(id) AS max_id
  FROM mailbox
  WHERE bee_id = ? AND delivered_at IS NOT NULL
);
```

Both placeholders bind the same Bee. Compare an unambiguous pair, not a
concatenation with ambiguous separators. The implementation may return an
opaque value, but its contract is only this: for the same Bee and supported
Core mutations, equal committed stamps imply the same ordered `(id, body)`
rows. Inequality is conservative and does not prove different title input.
Missing and empty Bees may share a stamp; that is safe because reuse starts
from a Bee in the fresh roster, and empty delete/recreate has the same title
input. Delivery and urgency changes deliberately leave the combined total and
global maximum unchanged. A future body edit, id rewrite/reuse, or additional
mailbox mutation path invalidates this contract and must update or retire the
probe. Do not force either index with `INDEXED BY`; test the natural exact-query
plan instead.

## Exact dispatcher order

After the existing active/untitled pre-skip, the store-only path is:

1. Read a committed stamp. If it equals a cached stamp, load bookkeeping and
   require `bookkeeping.signature === cached.signature`.
2. If that verified bookkeeping is deferred, continue exactly as the existing
   unchanged-signature branch does.
3. Otherwise call the existing
   `autoTitleDecision(bee, [], verifiedBookkeeping, now)`. Honor only a `skip`
   result; after the pre-skip this is the existing backoff result. Any
   `defer` or `generate` result falls through to the full path. This preserves
   the truthy `lastAt` rule, including `lastAt === 0`, backward clocks, capped
   attempts, and the exact expiry boundary without copying the retry predicate.
4. On every fallthrough, execute the original full path. Treat the current
   stamp as `stampBefore`, perform `listMessages`, normalize, and compute the
   exact signature. Then read `stampAfter`.
5. Publish one cache entry immediately there, before `loadState` and before any
   existing `continue` or `break`, only when both stamps are committed and
   equal. If the earlier cache check loaded state but could not skip, the full
   path may load it again at its original position; this pure store-owned map
   read is preferable to moving the original branch ordering.

The pairing is valid only because the concrete Core read is synchronous,
side-effect-free, and on the store-owned connection. It is not a safe contract
for arbitrary callbacks or independently supplied snapshots. An open
transaction disables publication and reuse; a rolled-back AUTOINCREMENT id can
therefore never poison the cache.

Publishing before the old branches is load-bearing. It warms the cache after a
full read that immediately continues for an existing defer, creates a new
defer, skips after a fresh backoff check, or launches and breaks. Scattering
publication across those branches would make coverage fragile.

## Cost and acceptance

The Mini planning diagnostic supports trying this lower-risk slice, but it is
not a dispatcher speedup result. Median CPU per call was:

| Rows | Full read | Aggregate | Ratio |
| ---: | ---: | ---: | ---: |
| 0 | 0.323 us | 0.566 us | aggregate 75% slower |
| 20 | 18.461 us | 1.422 us | 13.0x lower |
| 1,000 | 0.880 ms | 0.024 ms | 36.1x lower |
| 100,000 | 134.370 ms | 3.209 ms | 41.9x lower |

The 100,000-row probe still walks index entries; 100 such Bees extrapolate to
about 321 ms per scan and were not measured as a fleet. The fixture was
offline-seeded and lacks matching enqueue audit history. The empty aggregate's
0.243 us absolute penalty also requires a whole-dispatcher empty/small-fleet
guard. Acceptance therefore needs A/A plus isolated ABBA whole-scan captures,
not these query ratios alone.

Focused correctness gates should cover:

1. Real-store stamp changes for send, applied cancellation, and cascade delete;
   silence for delivery and urgency; open/nested transaction refusal; rollback,
   reopen, and empty/non-empty delete-recreate cases; and natural use of both
   existing indexes.
2. Differential store dispatch for first-fill and second-pass deferred/backoff,
   `lastAt: 0`, exact expiry, backward clock, changed membership, changed or
   missing bookkeeping, new defer, generation context, probe limit/order,
   launch break, watchdog, and full-roster pruning after an early break.
3. Explicit proof that general dependencies and caller rosters retain their
   original callback trace and never touch the cache seam.

Measure backoff-expiry full reads as a later independent unit. Escalate to the
corrected presence-aware event token in Sol's contract addendum only if the
measured many-giant residual justifies changing Core transaction and mutation
paths. Do not combine that writer change with this policy-preserving slice.

## Inputs

- Parent scores: `4652f5be330278f7960b56c4d018b87c64b7f55f7d4de2ad681dc72fc9e52d50`
- Parent notes: `5493c0b3df04be0f52a0f7f1de3b71be5743f795a5ac0cd23cfe9f74e362dc16`
- Aggregate study: `3bbed5b538f07e6f6755b58c7de52906e6a6eadd69453926d886a5a1817f8686`
- Sol Core addendum: `7a47d1494637f0e7217279743af62b88be8c112e1d817faf6b37fd177f94ad8d`
- Cross-judge: `2486d38802907c1cb3057958601fdc49ea609d28467342b537fc1fcadbe33285`
