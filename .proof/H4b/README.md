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

All lab commands require `HOME == TMPDIR` under `/var/tmp` (or `/private/var/tmp`). Disk headroom was checked first. The fixture account and Keychain are fake files; no native Keychain or real account HOME was inspected. No new unit tests or code comments were added. Existing core schema assertions advance48→49; the existing lease assertions are unchanged. An existing ceiling fixture now waits for a recorded provider session before asserting conversation forks; its original-race and fixed repetition results are retained. Logic coverage added here is lab coverage, so publication/fence/attention/login transitions remain follow-up unit-test debt per the human's no-new-tests instruction. The required repository verification skill is missing (known setup issue); core-work, astack-principles, diagnosing-bugs and show-me-your-work were used.

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

## Test infrastructure and continuity limits

The test helper's `forceStopTestDaemon` uses `execFileSync(ps)` with Node's1MB default buffer. Host process-argument output exceeds that buffer here. This ENOBUFS is reproduced on exported H4 `29597c41`; the affected isolated auth-death cases pass with a local32MB override. The override is local audit tooling, absent from the final tracked diff. `daemon-buffered.log`, `daemon-buffered-exit.log`, and `auth-death-buffered.log` disclose its use; the force-exit diagnostic run also uses Node's test-force-exit flag. Original unmodified gate failures remain evidence, not a green result. Increase the test-helper buffer as separate infrastructure follow-up. Foreign process-list stdout is omitted from ENOBUFS receipts; the actual error and stack are retained.

The ceiling test's original warm-up waits for delivery+idle, which do not prove that system/init and providerSessionId were recorded. Original-fixture10-per-side counts and the fixed10-run results are in receipts/repetitions. Driver readyAtSpawn explicitly allows synthetic idle before init. Session evidence is folded transactionally with observations before command execution (loops.ts observe/applySessionIds); the Claude adapter extracts the ID from system/init. H4b does not change those paths.

A missing persisted session ID is not proof that a real provider never allocated context: Honeybee has no known resumable conversation until init is observed. This existing pre-init window is not represented as a new no-context guarantee. The v49 daemon lab proves that once the session/context is known, rotation carries it and forks correctly.

Original parallel-group comparison, unchanged fixture: baseline H4 `29597c41` failed the ceiling assertion in3/10 runs; H4b `25af863a` failed in4/10. There were no other failures in those20 groups. These counts establish the pre-existing race; the small sample does not establish a meaningful H4b rate increase. Healthy readiness now adds synchronous SQLite reads, which can affect scheduling; it does not write attention when no ambiguity/fence exists. No unsupported causal attribution to extra writes is made. The barrier adds one wait to the existing test, requiring its session identity to be known before it stops the bee and later asserts two conversation forks. All10 fixed groups pass:161 tests passed and1 skipped per group, zero failures across the10 runs.

Retained full-daemon baseline failures (both reproduced on `29597c41` in `baseline-delivery-paths.log`): `OS-level file read outside cwd: cell-sandbox; tool-policy read UNVERIFIED (OS-level only)` and the corresponding `satellite-default` case. Both require a sandbox fixture base outside private mounts with a socket path no longer than103 bytes; the fake `/var/tmp` root and long Cell path do not provide such a base. Nine other cases in that baseline file pass. The task does not bypass the fixture's safety constraint.

The full legacy `npm test` failure is `turn runner: exact turn_end advances past an inherited stdout pipe and session stop reaps descendants`. The clean `d532471e` reproduction is committed in `.proof/H4/receipts/baseline-hsr.log`; H4b retains the same diagnostic. No whole-suite green is claimed.

Final checks: `check`, `v2:check`, and `build` pass. Core617; harness14; driver163; driver2 287pass22skip. Broad daemon prefix770pass2knownfail1skip, followed by90 remaining files706pass4skip. The complete legacy run retains the baseline reaping failure (6523.714ms here,5797ms on clean d532471e). Full suites are therefore honestly reported with retained baseline failures.
