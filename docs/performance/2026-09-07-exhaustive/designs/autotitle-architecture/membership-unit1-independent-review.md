# Independent review of Core mailbox membership Unit 1

Reviewed commit `bc6554b6c562019011fb9d3e23cb2e9013bc765f` directly
against its sole parent, `322815d9dd0af4d63471c17dc27a9ab90cecca7a`.
The diff contains only:

- `v2/core/src/index.ts`
- `v2/core/src/store.ts`
- `v2/core/tests/mailbox-membership.test.ts`

## Verdict

No correctness blocker found in Unit 1. The production method matches the
selected design: one `stmt()`-cached compound aggregate, the same Bee id bound
to both exhaustive delivery arms, a total count plus global maximum, and a
`transaction_open` return before the query whenever `txDepth > 0`. The commit
adds no schema or writer change. The diff is additions only.

The load-bearing safety fact holds at executable-proof level for the supported
store. `CoreStore` owns one WAL/EXCLUSIVE connection, the read is synchronous,
and the supported mailbox mutations are insert, pending cancellation, Bee
cascade deletion, urgency update, and delivery update. Only the first three
change membership. Committed `AUTOINCREMENT` ids are not reused. An open
transaction cannot publish an aggregate, so rollback id reuse cannot turn a
speculative body into a reusable committed fact.

## Non-blocking findings

### Low: an unsafe SQLite integer bypasses the checked mapper

`mailboxMembershipInteger` at `v2/core/src/store.ts:523` rejects unsafe
numbers with `CoreError`, but Node converts SQLite integers before
`mapMailboxMembership` runs. With a controlled row id of
`9007199254740993`, the real method throws this instead:

```json
{"name":"RangeError","code":"ERR_OUT_OF_RANGE","isCoreError":false}
```

This cannot return a false cache identity, and the supported writer cannot
normally create such an id without failing first, so it is not a cache
correctness blocker. It is still a gap in the stated checked-scalar behavior.
The malformed-row test at `mailbox-membership.test.ts:276` covers a negative
maximum only. Either wrap the conversion failure as `CoreError`, add an unsafe
integer test and accept the native error explicitly, or narrow the validation
claim. Do not switch the hot statement to BigInt without measuring it.

### Low: the transaction test does not pin nested depth or the pre-SQL guard

The rollback test calls `readMailboxMembership` after nested `send()` has
returned, so `txDepth` is one at `mailbox-membership.test.ts:148`. The
caught-write test has the same shape at line 197. Neither invokes the read from
inside a second `transact`, and neither proves that the method returns before
preparing or executing SQL.

The implementation is correct today. A throwaway real-store check with a
malformed mailbox row returned `transaction_open` at both outer and nested
depth, while the same read outside the transaction raised the expected
`CoreError`. Turn that shape into one focused regression test. It will pin both
requirements without exposing the database.

### Low: one global-maximum partition shape is absent

The semantic tests cover all-pending, all-delivered, and mixed rows where the
highest id is pending. They do not leave a lower id pending while moving the
highest id to delivered. That case directly proves the outer `MAX(max_id)` is
global rather than "pending max when pending exists." The production SQL at
`store.ts:2766` is correct, and the plan test checks the exact current text, so
this is a regression-test gap only.

### Low: exported contract comments omit comparison boundaries

The exported types at `store.ts:271` and method comment at line 2757 do not
record three limits from `synthesis.md`: compare fields only for the same Bee
and live `CoreStore`; equality is a one-way content proof; and missing and
empty Bees intentionally have the same result. Unit 2 is designed around those
limits, but the public Core declaration does not tell its next consumer. Add
the limits to the method JSDoc when touching this area again. No type or API
shape needs to change.

## Checks cleared

- Exact commit parent is `322815d9`; no intermediate commit is hidden.
- `git diff --check 322815d9 bc6554b6` passes.
- Both bindings are `beeId`, and the outer aggregate combines both partition
  rows before exposing the result.
- Empty and missing mailboxes return `{kind: "committed", messageCount: 0,
  maxMessageId: null}` as selected.
- Delivery and urgency remain silent. Send, cancellation, cascade deletion,
  delete/recreate, reopen, rollback id reuse, and caught nested write failure
  have real-store coverage.
- The natural plan uses `mailbox_pending_metadata` and
  `mailbox_delivered_by_bee`; the query has no forced index or temp sort.
- The read-only test snapshots state, audit rows, and audit head.
- Focused command passed with 7/7 tests:
  `NODE_COMPILE_CACHE=/tmp/honeybee-unit1-review-node-cache node --test v2/core/tests/mailbox-membership.test.ts`.

I did not run a broad suite, typecheck, build, benchmark, or Mini command. Unit 2
began modifying an unrelated daemon file during this review; the three
committed Unit 1 paths retained the hashes below.

## Provenance

- Synthesis: `8d3aaed885b3a9cce426d76c7e0c889486ee09ec9d8b6a93901f27aa7e449e18`
- Synthesis signatures: `ea8f7b6c3263c41fb7a9297b2099e0033791bad22075a62e35650cc2fd16d90b`
- Unit 1 task: `d14317555b53c2285e0c328a3d295f762b068f114249cca290e1f80b5e90ad8b`
- Unit 1 binary diff: `3b3ab9c6ca73fb537c2c00a468a52fd8656b006e6b741b79fe950143a2117323`
- `index.ts`: `1d9ab7425149fe17615ac98f8986911abda59fc475b9db5ecae59d1b1754cdb8`
- `store.ts`: `ce0c7f57909d095985d5e167f82ea281ddbf35e27c45099e232c162c04e4cc5c`
- membership test: `14f2048840188ad2491383dd3f36039414418daff773cdaca1b9600574fe72d1`
