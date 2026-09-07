# Discover active Cell moves without scanning history

The active-move query previously ordered by `m.id`. SQLite walked the receipt primary-key index, probing the active-pointer index for every historical row. Ordering by the equal joined value `b.active_move_id` preserves the exact result and order while letting SQLite start with the partial active-pointer index. No index, storage, write, or state-machine behavior changes.

Candidate `476559e5` changes one SQL line and adds a regression test. Mini measurements compare immutable `7eb8ecb7` and `476559e5`, with exactly `v2/core/src/store.ts` different among runtime/package sources. The separate A/A control uses two distinct byte-identical 7eb checkouts.

## Measurements

M4 Mini, Node 24.18.0. Each fixture is copied byte-identically before opening both stores. Failed historical receipts are synthesized offline from a real public admission/failure receipt; active moves use public admission. Three symmetric warmup rounds precede 15 ABBA rounds, giving 30 samples per side. Whole quiet steps use real DaemonCore with FakeDriver and commands disabled, and are measured only when no move is active. Setup, semantic checks, and cleanup are outside timing.

All values below are milliseconds at p50. CPU values near one microsecond are at process.cpuUsage resolution; wall time provides finer detail without making sub-microsecond CPU claims.

| Historical receipts | Active | Operation | A/A CPU | Before / after CPU | Before / after wall |
| ---: | ---: | --- | ---: | ---: | ---: |
| 0 | 0 | discovery | 0.001000 / 0.001000 | 0.001000 / 0.001000 | 0.000375 / 0.000375 |
| 0 | 0 | quietStep | 0.013000 / 0.014000 | 0.012000 / 0.012000 | 0.011625 / 0.011625 |
| 1,000 | 0 | discovery | 0.024000 / 0.024000 | 0.021000 / 0.001000 | 0.021083 / 0.000416 |
| 1,000 | 0 | quietStep | 0.033000 / 0.033000 | 0.034000 / 0.011000 | 0.032583 / 0.010583 |
| 100,000 | 0 | discovery | 2.775000 / 2.781000 | 2.753000 / 0.001000 | 2.751875 / 0.000500 |
| 100,000 | 0 | quietStep | 2.815000 / 2.833000 | 2.792000 / 0.012000 | 2.787292 / 0.011250 |
| 100,000 | 1 | discovery | 2.979000 / 2.965000 | 2.913000 / 0.005000 | 2.911917 / 0.004417 |
| 100,000 | 10 | discovery | 3.074000 / 3.064000 | 3.810000 / 0.023000 | 3.809625 / 0.022959 |

At 100,000 historical receipts and no active move, whole-step CPU falls from 2.792 to 0.012 ms, a 99.6% reduction in this fixture. Empty history is unchanged. Active discovery scales with the active set instead of receipt history. These are store/step results, not end-to-end move latency or whole-daemon idle measurements.

Both reports preserve raw samples, exact ordered full receipts, fixture/source/tool hashes, boot identity, unchanged audit sequence, no driver effects, and database quick_check. The captured production plan changes from `SCAN m USING INDEX sqlite_autoindex_bee_moves_1` to `SEARCH b USING COVERING INDEX bees_one_active_move (active_move_id>?)`, then primary-key receipt lookup. The A/A control retains the history scan on both sides.

## Verification and limits

The regression test first failed on the real history-scan plan. It then passed with the ordering change. It covers 64 public failed receipts, two active receipts, exact order/content, outer-transaction failure and rollback restoration, reopen, and the plan of the actual prepared production statement. Studio passed all 12 Cell-move core tests, core typecheck, and repository build. Mini passed the same 12 tests and both measured workloads. Combined `4ebf43c9` passed core 213/213 and the serial daemon suite with 358 passes and one platform skip. The exact combined production source also passed all v2 typechecks, repository build, and the 68-test loop suite. Logs are `verification/mini-move-held-integrated-*.log` and `mini-held-eligibility-*.log`.

The query still reads current durable state on every call. No cross-step cache or early return bypasses move reconciliation. Per-bee `activeMoveOf` lookups in delivery and idle shutdown remain a separate performance opportunity; this change does not remove those fences.

Evidence: [frozen ruler](designs/move-discovery.mjs), [A/A](evidence/mini-move-discovery-aa.json), [A/B](evidence/mini-move-discovery-ab.json), and `verification/mini-move-discovery-*.log`. The original failed test log is retained alongside the passing Studio logs.
