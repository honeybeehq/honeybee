# B8 verification receipt

Run `node scripts/verify-backup-clients.mjs` with local restic and rest-server available,
or set HIVE_TEST_RESTIC and HIVE_TEST_REST_SERVER to their executable paths. It requires
the tools, runs only disposable fixtures on numeric loopback, and refuses to skip the real
run. Expected: seven Python helper checks, twelve service Node tests and five client/RPC
Node tests, zero skips. No services or triggers are installed.

Toolchain: Linux x64, Node24.18.0, pinned npm11.16.0, restic0.18.1, rest-server0.14.0.
All evidence is under `.audit/backup-b8/` in this Cell:

| Evidence | Result |
| --- | --- |
| end-to-end.log | 7 Python +17 Node passed, zero skips |
| capacity.json | authenticated server→machine capacity, physical used/logical pinned bytes, explicit age |
| owner-rpc.json | real capability/RPC, source absent, Git fsck/dirty index agreement, same-key restart replay, signed drill persistence/tamper refusal, actual guard witness, disk/stage limits, disposal, wrong password and boot cleanup |
| end-to-end.json | full B3 remote hashes, SQLite integrity, Git and transcript negatives, repository-only recovery |
| check-commit.log, v2check-commit.log, build-commit.log | pinned source/test and v2 checks, build |
| core-final.log | core623/fleet6 passed |
| daemon-verified.log | local RPC classification, eviction, retained safety and retention32 passed |
| capture.log | capture/SQLite/retry regression5 passed |
| eviction-built.log | built verifier/eviction regression13 passed |

The main service test also creates a real unknown snapshot. Signed accounting.complete is
false while upload and B4 capacity policy still admit: logical accounting is informational,
separate from physical/logical inventory completeness. Finite prune preserves that unknown
snapshot and the pinned sole copy. A zero-byte stdin fixture initially returned restic's
exit3 despite creating a snapshot; the final fixture uses an actual disposable file.

The client tests cover equal-sequence refresh, replay and signature/domain refusal, epoch
state-loss hold and explicit trust recovery, cached status after reopen and stale age. They
also cover interrupted cleanup with an absent guard versus held cleanup with an exact live
guard, and explicit disposal/source preservation. The real daemon fixture seeds an
interrupted operation before boot and observes outcome_unknown plus completed background
cleanup. The live restore exposes a non-null tool guard in durable owner status.

No fixture repository password, writer credential or private signing key is included in
proof records. Existing service diagnostics/record/Core facts/mail scans include derived
maintenance credentials and tokens. Restore diagnostics scan fixture credentials; stages
contain deliberately sensitive recovery DB copies, protected by private0700 paths. This
is not a claim that application backup contents are secret-free.

Read-only cross-family review by claude-opus-5-5: no remaining Medium code findings in the
reviewed implementation. Review supplied sequence/epoch, disk/cleanup and non-blocking boot
safeguards. Forced disk shortage uses an injected zero-free-space observation, not filling
the host filesystem. The actual statfs path is used by the successful real RPC restore.

Limits: stage-only restore, no in-place revive; completed stages require explicit disposal.
The reader grant on an owner permits reading its whole machine repository. Drill reports
are independent signed informational claims, not eviction or pin-release authority. Large
repository timing, actual macOS/privileged deployment, cross-host Apiary import transport,
legacy special-tar fixture and inherited mmap/inaccessible-fd residual remain outside this
proof. Unknown/unverified snapshots have no signed rejection API and stay protected; they
can consume capacity. Thirty-second authority signing/token cache revocation lag remains.
The dedicated repository verification skill is unavailable; repository checks and these
committed drills supply the evidence. No real Cell, Studio/MacBook, SX65 or Perforce data
was read, evicted or restored.
