# H4b: Claude publication ordering and durable attention

DEPLOY HOLD. Queen reviews credentials; Needle opens and merges the review PR pinned on green. Branch: `review/sar-H4b-rotate-ordering`, based on main `0f9dbe19` (#98). The rebase is preserved without force by retaining the first published commit as a merge parent.

Rotation publishes Keychain, HOME, then vault. The vault is a snapshot, never a newer authority over a different live chain. Keychain-over-HOME source authority is unchanged.

If a present Keychain refuses publication, the core writer atomically persists `keychain_publication_failed` with a SHA-256 digest and expiry of the intended publication BEFORE advancing HOME/vault. No token bytes are stored in that row or logged. A restart reseeds the repair queue. Both daemon refresh and new runtime admission are held, auto-selection skips the account, and account attention has typed code `credential_file_damaged` with the precise cause. The account status remains `ok`.

A fenced repair requires HOME to match the intended publication digest. Old matching HOME/Keychain copies cannot clear it. It can republish that proven HOME to Keychain, or adopt a native Keychain chain newer than the intended expiry. HOME precedes vault; a post-write Keychain re-read must match before clearing. A newer/equal authoritative Keychain is never rewritten merely to confirm it. A concurrent native advance keeps the fence for the next retry. A completed login clears only after the published material matches the login; abandoned/failed publication does not clear it. Linux without a present Keychain never acquires this fence.

`live_chain_ambiguous` now persists transition-only typed account attention through the core writer and publishes `account.put`; keep-last-good usage cannot hide it. The source selector clears that attention only after live source agreement is resolved. This deliberately makes the selector a writer of diagnostic state.

## Verification

- `lab.ts`: fourteen disposable process/restart scenarios, with fake credential documents only. Covers first-publication crashes on Linux/macOS, crashes after Keychain or HOME, a crash after the fence before HOME, failed writer/restart, HOME-vault mismatch repair, successful login, native advancement, same-chain replay, concurrent advancement, and ambiguity despite readable last-good usage. All assert zero spent refresh sends. A fence-before-HOME crash remains held and actionable; no recovery is fabricated.
- `baseline-order-red.log`: the same first-publication Linux crash against exported H4 `29597c41` fails because a spent fixture refresh is sent after restart. The fixed run passes.
- `schema-lab.ts`: actual v48 source opens a fixture, v49 migrates and reopens idempotently, attention survives reopen, deleting an account cascades its attention, and the old runtime refuses the newer store.
- `context-lab.ts`: disposable daemon reports schema49 and supported apiary-swap storage; a Claude account swap copies the conversation and resumes/forks it in generation2 with the original context present.
- Gate and suite outcomes are recorded in `receipts/gates.json`. The complete suites are not described as green when a baseline failure remains.

All lab commands require `HOME == TMPDIR` under `/var/tmp` (or `/private/var/tmp`). Disk headroom was checked first. The fixture account and Keychain are fake files; no native Keychain or real account HOME was inspected. No new unit tests or code comments were added. Existing core schema assertions advance48→49; the existing lease assertions are unchanged. Logic coverage added here is lab coverage, so publication/fence/attention/login transitions remain follow-up unit-test debt per the human's no-new-tests instruction. The required repository verification skill is missing (known setup issue); core-work, astack-principles, diagnosing-bugs and show-me-your-work were used.

## Schema and rollback decision for Queen

Schema49 is additive but intentionally refuses downgrade: v48 must not ignore the durable safety fence. Apiary-swap now accepts exactly `{48,49}`, rejecting every other schema; this widening belongs to the SAME deploy unit as the migration. No v49 store has been deployed by this task; all v49 stores made here are disposable fixtures. The table's digest columns were refined before deployment, so earlier in-progress v49 lab stores are not supported stores.

There is NO down-migration. The orchestrator accepted the requirement to restore a coordinated pre-migration database backup with the old runtime on rollback. **Restoring that backup loses mail, commands, bees and audit writes accepted since the backup.** That cost already exists for the project's earlier schema47 migration; it is not waived here. Queen must decide the backup/rollback conditions at deploy. `hive deploy --rollback` alone cannot reopen a v49 DB with v48 code. DEPLOY HOLD remains; no deployment or rollback was attempted.

## Limits retained for review

- Lost provider responses or a crash before the first live write/fence commit remain the existing uncertain-refresh boundary; this change does not invent replay safety for an unrecorded provider result.
- Keychain offers no atomic compare-and-swap primitive. HOME-origin repair re-reads before writing and confirms afterward under Claude's existing locks; a native writer outside that lock still leaves a narrow read/write race. A conflicting post-confirm retains attention.
- An unparseable Keychain, or a missing intended HOME after the fence, stays fenced with visible attention until repair can prove the material or a login completes.
- Native advancement copied from Keychain includes its document fields in mode0600 HOME/vault files, consistent with the existing rotation shape.
- Held verification backoff is keyed by HOME/vault revision; a Keychain-only external repair can wait up to the15-minute ceiling unless completed login clears attention. Publication repair has its separate15-second retry.
- Source arbitration now writes transition-only diagnostic attention, including under the refresh lock. No parallel lifecycle truth is introduced; the single core store remains authority.
