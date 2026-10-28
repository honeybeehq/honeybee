# B9 verification receipt

Base: d3e7453b. All runs use this Cell and disposable numeric-loopback rest-server/SMTP, Node 24.18.0, pinned npm 11, restic 0.18.1 and rest-server 0.14.0. No real data, root/systemd installation, external mail or backup transfers. The Honeybee verification skill is unavailable; repository checks and committed drill scripts ran.

| Gate | Result | Evidence |
| --- | --- | --- |
| root typecheck | passed | `.audit/backup-b9/final-check.log` |
| v2 typechecks | passed | `.audit/backup-b9/final-v2check.log` |
| build | passed | `.audit/backup-b9/final-build.log` |
| core + fleet | 623 + 6 passed | `.audit/backup-b9/final-core.log` |
| daemon security/client/eviction/retention | 35 passed | `.audit/backup-b9/final-daemon-marker.log` |
| fresh B9 runner | 7 Python + 12 Node service + 5 integrity passed | `.audit/backup-b9/final-integrity.log` |
| B8 client/restore regression | 7 Python + 12 service + 5 verifier/client passed | `.audit/backup-b9/final-b8.log` |
| B2 capture regression | 5 passed | `.audit/backup-b9/final-b2.log` |
| built B4 worker/verifier regression | 14 passed | `.audit/backup-b9/final-b4.log` |

All listed tests have zero skips. The B4 suite selects built verifier/worker for its end-to-end case; other cases execute source. The B9 runner exercises source service modules and real tool children. This receipt supersedes the B6/B8 failure-hold gap identified by the independent checker; their other rollout limits remain.

The five integrity tests are named:

- check holds require the same shard or a full read; order, reopen and audit preserve the latch
- tool failure classification discards diagnostics and separates lock/abort from corrupt check output
- new holds interrupt only matching uncommitted effects and preserve the first reason
- refused and transient drill relays never starve authenticated capacity refresh; local holds remain
- an accepted authority epoch recovers the signed failed shard and clears only after its matching trusted success

The real-run `.audit/backup-b9/holds.json` asserts all seventeen flags: provisionalForeignRepositoryRefused, missingHistoryRelaysAfterReceiptReport, coreReopenHoldPersists, repairScopePinnedDespiteGrowth, abortedCheckDoesNotHold, realCorruptionDetected, checkFailedEvictionRefused, normalObservationCannotClear, laterTrustedCheckClears, failedSignedDrillHolds, failedDrillEmailDelivered, operationalDrillAllowsUploads, corruptionBlocksUploads, oldDrillReplayCannotClear, laterSignedDrillClears, disposableEvictedAndRestored, gitFsck.

The epoch test uses actual HTTP gateway/authentication/signatures/Core and a stub backend effect adapter; actual restic corruption, cancellation, scope recovery and exact disposal/restore are proven separately in the loopback run. Fixture credential diagnostics checks remain narrow; no blanket claim that restored node databases contain no secrets is made.

Read-only cross-family source/trail review: claude-opus-5-5, session bb31a769-23c0-4ff1-a79e-51ded537b66a, messages 38731–38888. No tests run by that reviewer. No remaining code findings; attention: manual catalogue-history rebuild after authority state loss, legacy full-read budget not measured at fleet scale, negative replay can cause a hold, single verifier clock, restic English diagnostic version pin, no separate stale-integrity-coverage alert. Existing privileged installation/macOS/mmap/open-fd/special-tar/authority-compromise limitations remain. No production-ready claim.

Process deviation: decisions.tsv was reconstructed at closeout from the authenticated review messages and tool logs, using actual recording timestamps rather than invented decision times. Earlier failed migration expectations, private transaction compile attempt, ESM abort wrapper and synthetic overdue clock assertions were fixed; final logs above supersede those experiments. The committed trail includes their provenance and explicit final closeouts.
