# Backup integrity holds (B9)

This contract supersedes the B6/B8 claim that a failed check is only an alert or that drill facts have no eviction effect. A failed check or authenticated failed drill holds deletion for its repository. A pass clears only the matching failure; it never grants deletion, releases a pin, or replaces the receipt/content checks.

## Authority and recovery

The node's Core writer owns durable `integrity` facts. Failed checks carry the signed grant's scope: full read or exact read-data shard/total. A wrong-shard pass cannot clear a hold. While held, the authority schedules that exact failed shard before rotation, keeping its denominator stable as the repository grows. Restic partitions subsets by pack ID. A full successful read covers subset holds. Every check also repeats structure and protected-set checks.

Failures latch; older events are ignored and failure wins ties. Capacity returning to normal, repaired bytes, empty hold arrays, a new epoch, or a restart cannot clear a failure. Signed capacity includes active `holds` and explicit held/cleared `integrityEvents`. Machines persist them and require a later matching signed success. On explicit capacity-epoch acceptance, `/v1/integrity/recover` relays the old signed negative evidence to the authenticated authority, bound to machine, repository and known repositoryId. It adopts failed scopes only, so the replacement authority can grant the exact recovery check. Epoch reset alone grants nothing.

Signed drills are bound to repositoryId, machine, snapshot, receipt, catalogue and verifier. Failed drills hold that snapshot's repository; only a later signed pass on the same registered snapshot clears it. Ordering assumes a single pinned verifier clock. A failure arriving before receipt registration creates a provisional server hold when repository identity is known, returns retryable `drill_history_missing`, and is retried after registration. Foreign repository identity is refused. If the original history never arrives, the hold remains: recover/register the original signed receipt and catalogue and re-run that drill. There is no unrelated-pass or override release.

Local drill, hold and email-outbox changes commit in one Core transaction. Drill relay uses independent backoff and durable acknowledgements; terminal principal/signature refusals alert without starving capacity refresh. Missing history and maintenance contention remain retryable. A local hold remains even if relay fails.

## Effects and upload policy

Both fresh eviction admission and marker-less replay consult Core holds independently of the policy file. Refusals are `check_failed` or `drill_failed`. In-flight workers receive a shared, first-reason-wins abort flag before authorization. A fully bound, committed deletion marker completes after a crash; a torn or foreign marker is not authorization. This preserves already-authorized partial deletions while stopping new ones. Prune and new recovery pins also pause under an integrity hold.

An operational failed drill pauses eviction but allows uploads. A corrupt drill or failed restic integrity check blocks uploads too; probes for existing uncertain upload keys may still reconcile. Known abort, timeout, lock/auth/network/HTTP and grant-budget failures are operational: alert and requeue with backoff, without creating a corruption hold or clearing an existing one. Unknown check failures conservatively count as integrity failures. Diagnostic classification is pinned to restic 0.18.1 English output; a bounded private 64 KiB tail is discarded rather than put in records, responses or logs. Upgrade that parser with fixtures when changing restic.

Legacy unscoped failed/running/unknown maintenance facts conservatively become full-read holds. No production installation is evidenced here. Before enabling pre-release state, review it and provision a full-read time/read budget; at 24 TB the default one-hour job cannot be assumed sufficient. There is no automatic administrative override. Persistent operational failures still alert `maintenance_failed`; a separate integrity-coverage-age alert is not implemented.

## Client contract and upgrade

`backup.service.status` adds `integrity: {state: held|ready|unknown, holdReason, holds[]}`. Each hold has repository, reason (`check_failed|drill_failed`), snapshotId (null for checks), held, numeric millisecond `at`, blockUploads and optional checkScope. Capacity also exposes state, holdReason and holds independently of physical threshold band. Normal space never means integrity is ready.

Schema 56 excludes older owners. Authority, machine and executor must upgrade together: maintenance claim/finish requires `integrityProtocol: 1`; grants bind checkScope; signed capacity requires holds and integrityEvents. Old payloads fail closed. The signed epoch recovery endpoint adds no positive authority. No installation, live service, real email, real deletion or cross-machine backup occurred in this task.

## Verification

Run `node scripts/verify-backup-integrity.mjs`. It starts from a fresh fixture work directory without `.audit/backup-b6`, runs the real service runner, seven Python fence tests, twelve Node service tests and five integrity tests. Numeric-loopback rest-server and SMTP are disposable. It corrupts a pack, proves typed eviction refusal and durable restart holds, restores the pack, proves normal capacity alone cannot clear the hold, re-checks the failed scope, then deletes and restores one disposable Cell exactly. Signed failed drills exercise mail, operational/corrupt upload policy, pre-history relay and later signed recovery.

The authority-reset test uses real gateway authentication, signatures and Core stores, with a stub backend effect adapter; the separate corrupt-pack drill runs actual restic. Existing privileged systemd/boot/ACL, macOS, mmap/open-fd, special-tar and authority-compromise limitations from B3/B4/B6 remain. No production readiness is inferred from these fixture results.

## Authority state-loss procedure and limits

Epoch acceptance is not a complete authority recovery procedure. If its Core state was lost, reconstruct trusted history from the repository's signature-verified recovery catalogues: use the B3 discovery/readback verifier to recover the original receipt and its signed catalogue publication, then submit each pair through authenticated machine-scoped `/v1/report`. Rebuild bootstrap/pin inventory under the existing operator attestation rules before permitting prune. Locally cached `reportedAt` does not re-publish that history automatically. A signed passing drill requires that matching history; without it the hold stays and pins/prune refuse. Only after rebuilding history should the operator re-run the failed drill or exact failed check. This task automates negative scope recovery, not history reconstruction; no automatic history-rebuild tool is claimed.

Old signed negative attestations have no age limit in the recovery endpoint. Replaying one after losing the authority's superseding success can re-create a hold (denial of service), never clear one or authorize deletion. Use the latest machine cache during epoch recovery. A recovered check at the current counter still needs a later counter's success; ties remain held.
