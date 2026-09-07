# C07 flag-expiry index review

## Verdict

Accept. I found no blocking or correctness findings in the scoped C07 change.

Reviewed state:

- Worktree: `/Users/trmd/Projects/trmd/honeybee/repos/honeybee-perf-exhaustive-2026-09-07`
- Base HEAD: `979d3129483e074250f7ff3b837dd86820db3dd7`
- Tracked production and migration-test patch SHA-256: `fc22c71be6f606648fcec9ad1e8d08f65725f9596ce7de909bcffd4c1c5d7162`
- New `flag-expiry-index.test.ts` SHA-256: `f304ca4d30d43dfc25d4641b7c8d1d79ca9bfcc06095eb4f4164dd0d11196c5a`

## What changes

`v2/core/src/schema.ts:595` defines `flags_due` as `(resets_at, id)` over rows where `cleared_at IS NULL AND resets_at IS NOT NULL`. `v2/core/src/store.ts:1223` installs it after additive column migration. The change does not edit `expireFlags()` at `v2/core/src/store.ts:2287`; its predicate, `ORDER BY id`, row mapping, clear loop, return value, and audit path remain unchanged.

The index stays out of `SCHEMA_SQL`. This placement matters because `SCHEMA_SQL` runs before `ensureSchemaVersion()`, while a v16 `flags` table has no `resets_at` column. The v16 migration adds and backfills the column at `v2/core/src/store.ts:1152`, then index installation runs in the same open transaction at line 1225. Current-version stores also reach line 1225, so a rollout can add a missing index without a schema-version bump.

## Safety fact and proof

The change is safe because it changes only SQLite's access path. The authoritative query and every mutation remain unchanged.

Evidence reaches runtime-test level in the retained focused log at `docs/performance/2026-09-07-exhaustive/verification/flags-focused.log`:

- 24 of 24 focused tests pass.
- The populated-reopen test drops `flags_due`, reopens the real `CoreStore`, and confirms that installation changes neither `dumpState()` nor `auditRows()`.
- The test gives the lower-ID row a later deadline and confirms that expiry still returns and audits rows in ID order.
- An outer transaction rollback restores both state and audit rows.
- Future rows stay out of the due result. Open-ended and cleared rows stay out of the partial index.
- The exact unhinted production query reports `SEARCH flags USING INDEX flags_due`.
- The v16 migration test opens a table without `resets_at` and confirms that both the column migration and later index installation succeed.

The retained full-core log reports 188 of 188 passing tests. I did not start a duplicate test process while root owned the Studio heavy-check window.

## Risks and accepted tradeoffs

No unhandled correctness risk remains in the scoped patch.

The index makes each write that adds, changes, or clears a deadline-bearing open flag maintain one more B-tree entry. The prototype measured ten durable set/clear cycles as 0.034–0.060 ms slower per batch, or 7.6–11.6%. An all-due burst of 1,000 flags measured 0.389 ms slower because SQLite sorts the deadline-range result back into ID order and removes index entries. These costs are explicit and acceptable against the recurring no-due improvements. The patch correctly keeps `ORDER BY id` instead of changing public order to match the index.

Index creation is also a startup write. The prototype measured 0.328–2.625 ms across its fixtures and up to 344 KiB for 20,000 active future flags. `CREATE INDEX IF NOT EXISTS` makes this a one-time storage cost for a valid store, followed by cheap existence checks on later opens.

## Checks cleared

- No index hint forces the planner.
- No index is added to `SCHEMA_SQL` before the v16 column migration.
- No schema-version constant changes.
- No expiry policy, deadline comparison, or ID ordering changes.
- No cached flag truth or count is introduced.
- No audit event is added for index installation or an empty expiry pass.
- Index installation and v16 migration remain atomic with the existing open transaction.
- The partial predicate excludes cleared history and open-ended flags while retaining future deadlines for range search.

## Before integration

Use root's already-running combined verification as the final gate. No additional source change is required from this review.

## Parent correction

The 20,000-active-row storage difference was 344,064 bytes, or 336 KiB. The review's “344 KiB” label is a units error; the raw prototype and design table retain the exact bytes. The later parent full-core run passed all 188 tests, including the explicit v16 index-install assertion.
