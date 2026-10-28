# Owner backup status and staged restore (B8)

`backup.service.status {after?}` remains a read RPC returning the existing 250-row
`states` page. The cursor is the last row id. Additive fields are:

- `capacity: null | {attestation:{payload,signature}, ageMs, clockSkewAllowanceMs:30000, stale}`.
  Payload format is `honeybee.backup-capacity.v1`, with machine, repository, authority
  epoch, monotonic sequence, issuedAt, observation and accounting. Observation carries
  repositoryBytes/repositoryLimitBytes, fleetBytes/fleetLimitBytes, reserveBytes,
  reserveLimitBytes, repositoryId, observedAt and band (normal/warn/review/stop/unknown).
  Those used-byte observations measure allocated ciphertext storage, at least logical size.
  Accounting carries pinnedBytes/retainedBytes and fleetPinnedBytes/fleetRetainedBytes,
  basis `logical-manifest-bytes`, and complete. These sum signed capture manifest bytes,
  once per capture, partitioned by immutable Cell/proof pins. They are not deduplicated
  physical-pack attribution or reclaimable bytes. Unknown/old history or unverified arrivals cannot supply a
  trustworthy logical total; clients must show unknown when complete is false. Unknown
  ciphertext snapshots also cannot be attributed to captures. Incomplete accounting is informational and never gates uploads, eviction or prune. Physical used bytes remain
  authoritative for thresholds, including unknown ciphertext.
- `restoreDrills`: newest 100 independently signed drill reports, ordered by checkedAt.
  All historical reports remain available in paged states. Invalid signatures or retired
  trust keys are excluded. Empty means no trusted report, never a passing drill.

The ciphertext authority signs capacity with its operational Ed25519 grant key, with a
separate format/domain from grants. It mints a new per-repository sequence per authenticated
status request; the signing key is cached in process for 30 seconds, with that revocation
lag. Sequence and authority epoch are durable Core facts. The machine verifies signature,
repository, machine, age and at most 30 seconds of future skew before caching one row per
repository. Equal sequence is allowed only for an identical canonical attestation; lower
or changed equal sequences refuse. Staleness is recomputed at read time, including failed
refresh health and unknown bands. A failed refresh marks health false in Core and attempts
to stop the B4 observation file; B4 independently refuses new or unauthorized replay
admissions on health false. An already-authorized deletion marker still completes safely.

An authority rebuilt from missing/restored Core state gets a new epoch. Machines hold
capacity/admission until an operator invokes mutate RPC `backup.capacity.epoch.accept
{epoch}` for a pending, valid signed epoch. The thin CLI is `hive backup trust-capacity-epoch <epoch>`. It logs an explicit Core fact; the next fresh
refresh can recover. This action is not an automatic epoch reset and does not bypass the
pinned signing key. Do not delete state rows or lower counters by hand. Status polling on
the machine reads the cache; the service action refreshes it from the authenticated server.

## Drill reports

Mutate RPC `backup.restore.drill.report {drill}` verifies a canonical Ed25519 signature
against backup-trust.json publicKeys. Payload format `honeybee.restore-drill.v1` binds id,
machine, cellId, generation, repositoryId, snapshotId, manifestHash, catalogueSnapshotId,
receiptHash (SHA-256 canonical full normalized backup receipt), checkedAt (ISO UTC), result
(passed/failed), sourceUnavailable, checks (files, bytes, gitFsck, databases, manifest),
evidenceHash and verifier {id,keyId}. Checks use ok/failed for Git, DB and manifest. Passed
requires all checks ok and the same file/byte totals as the local verified receipt. The
report must match the local backup operation and receipt hash, and cannot be future-dated
beyond 30 seconds. Same verifier/id is idempotent; conflicting reuse refuses.

The independent drill executor signs only after performing its drill. B7 can produce these
reports using the public types and canonical signature module in backupClientFacts.ts.
A successful Restore RPC does not manufacture a signed drill report. Drill facts are
informational only: they authorize neither eviction, pin release nor retention disposal.
The evidence digest binds the executor's report artifact; it does not inline its contents.

## Restore

Capability `cell.backup.restore.v1` advertises mutate RPC `cell.backup.restore
{cellId,generation,idempotencyKey}`. The caller's key is preserved; reuse with a different
request returns refused/idempotency_conflict. A concurrent duplicate joins its in-flight
request; a completed duplicate returns the original durable result, including after restart.
Outcomes are restored/refused/failed/outcome_unknown, with reason and a path only on success.
No file contents, database rows, passwords or tool output are returned.

This version always restores to a fresh private stage. It never recreates spaceDir, revives
a bee, overwrites an existing checkout or imports owner databases. A live, moving or gated
Cell is refused as busy by policy, to avoid confusing concurrent operations; stage-only
restore itself never mutates its source. Restore into the original location is out of scope.

The owner provisions private backup-restore.json:

```json
{"access":{"machine":"MACHINE","repository":"rest:https://BACKUP/MACHINE/","passwordRef":"global/fleet-backup-MACHINE-repo-key","credentialRef":"global/fleet-backup-MACHINE-reader"},"repositoryId":"64_HEX_AUTHENTICATED_REPOSITORY_ID","maxRestoreBytes":1073741824}
```

The reader grant gives this owner read/decrypt access to its own complete repository history,
including full sensitive core/telemetry recovery snapshots. It is distinct from the uploader's
writer and never carries signing or delete authority. Secrets stay in Hem and constrained
child channels. The RPC requires a local verified backup receipt, a pinned verifier public
key, the configured authenticated repository id, and the same receipt payload in the encrypted
independent catalogue. Full B3 remote readback, hashes, Git and DB validation precede materialization.
Wrong passwords, missing objects and corruption fail closed.

Private 0700 stage roots are under canonical dataDir/backup-restores/<key-hash>. At most four
operation roots may exist. Before download, statfs must report free bytes of at least
4 * maxRestoreBytes + 768 MiB (download/materialization overhead plus daemon reserve).
maxRestoreBytes is configured, positive and at most 100 GiB; B3 also enforces its content,
archive and expansion bounds. Refusals disk_insufficient/stage_limit are durable under that
key; use a new key once space is freed. Completed stages persist for explicit user use.
Mutate `cell.backup.restore.dispose {idempotencyKey}` removes only that operation's private
stage, records disposed, and releases its slot. A disposed key subsequently refuses
stage_disposed; it does not silently create another restore.

Tool guard PID/birth/boot witnesses are durably saved before IPC can launch any readback or
Git tool. Boot cheaply marks running restores outcome_unknown/interrupted via an indexed
query. A single background reconciliation cleans interrupted roots only after exact guard
absence is proven; live/unavailable witnesses leave cleanup held. This maintenance does not
block RPC acceptance or bee re-adoption. Restore/dispose wait for the boot cleanup task.
For a held stage, retry disposal after the guard exits; an unknown key never blindly repeats.
A fresh key creates a fresh stage, subject to the count/free-space limits. No raw PGID kill
or source deletion is part of reconciliation. Shutdown waits for active restore/disposal work.

No service, live data, production reader grant or deployment was installed by B8. Dedicated
Honeybee verification skill remains unavailable; repository checks and disposable drills are
used. Real macOS/runtime setup remains untested.

## B9 integrity correction

[Backup integrity holds](backup-integrity-contract.md) supersedes earlier failure/drill authority wording: failed checks and signed drills hold repository eviction until a matching trusted success. Physical capacity alone cannot clear the hold. Schema 56 and protocol 1 require a coordinated owner/authority/executor upgrade.
