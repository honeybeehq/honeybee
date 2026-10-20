E2: automatic quota recovery does not request human attention

Base 975ab53eb7b1842113d6874dfd777a47e910d9f7 on review/sar-E-proactive-switch. The E2 branch is review/sar-E2-recovery-not-needs-you.

The core pure view now accepts automatic recovery as an input and suppresses waitingForYou while it is pending. blocked and resource_blocked remain unchanged. The store and CLI stale fallback both use matching quota recovery state and control/placement/generation fences, excluding rows invalidated by a user stop. autoswap=false in tags or args does not suppress attention. Cancellation removes the automatic recovery input. List projection batches live recovery rows rather than fetching each bee's history. The read-only path reuses its existing table-presence query and combines flags/recovery facts into one plan, preserving the existing seven-plan bound.

Run node .proof/E2/lab.ts and node .proof/E2/seams.ts with login:false, env -i, a fake HOME in the Cell, a private0700 TMPDIR under /var/tmp, and Cell-local caches. The daemon lab uses fake Claude/Codex harnesses, two fake accounts and a loopback91% limits stub. Four cases prove valid waiting has waitingForYou false and blocked true, then explicit stop/cancel or autoswap opt-out restores waitingForYou true with resource_blocked retained. The seam lab proves waiting, rotating, invalid-fence and cancelled rows agree between core single/list and stale read-only views. No helper cleanup is invoked.

Run check, v2:check and build. Existing suites: v2/core/tests/list-views.test.ts, core.test.ts, action-views.test.ts; v2/cli/tests/readonly-generation.test.ts, readonly-status.test.ts; v2/daemon/tests/accounts-activity-batch.test.ts. Existing test cleanup is redirected to trash with .proof/B/trash-cleanup.mjs. No new unit tests or production comments.

The first daemon fixture required account_wait specifically, but the established C shadow path reports account_unavailable when every account is excluded; the fixture now accepts either durable capacity wait. The first read-only change used two new prepared plans and failed the existing seven-plan limit; it now shares tableExists and combines flag/recovery reads, and the unchanged bound passes.

Repository verification skill is unavailable (known setup issue); the explicit daemon lab and repository gates provide verification. No deployment; DEPLOY HOLD remains.
