# Authoritative verified Cell deletion gate (B4)

## Deletion-path survey before implementation

| Entry | Physical effect | Required boundary |
| --- | --- | --- |
| CLI `cell evict`, Apiary/Waggle `cell.evict`, force | driver `evictCellWrapper`, then background sweep | One owner receipt/content gate before park and authorization checked before unlink |
| CLI `cell remove`, RPC `cell.remove`, force | `CellDriver.removeCell` → `deleteCell`; reserved allocation raw rm | Same owner gate; no force bypass |
| CLI `cell retained-remove`, RPC `cell.retained.remove`, force | `deleteCell` → markCellRemoved; interrupted reconciliation | Same gate; recovery must not invent authorization from an absent wrapper |
| `cell gc --apply`, automatic age/budget/pressure, `bee_deleted` cleanup | `CellRetentionService.applyOne` → park → sweep | Gate at apply, not just stale planner verdict |
| Boot/periodic `sweepEvicting` and synchronous helper | recursive unlink of every parked directory | Default deny legacy/orphaned directories; require durable owner authorization |
| Output trimming (`trimOne`, `trimCellWrapper`) | park ignored generated subtrees → sweep | Gate or explicit policy-limited exemption; unique/evidence content must not be treated as generated |
| Git image placement/reprovision | deletes existing checkout on image placement/failure | Refuse existing claimed content; scratch-only stages exempt |
| Keep/env restore | rename/copy into checkout then remove old stash | Transfer, not disposal: preserve bytes before removal; reprovision invalidates prior capture |
| Warm-pool release/stale generations, captures, upstream stages, COW probes, sandbox views, bee tmp | generated unbound scratch cleanup | Explicit scratch exemption; never sweep claimed checkout paths |
| Bee lifecycle delete | no direct Cell unlink; later bee_deleted retention | Cell remains protected by receipt gate despite bee lifecycle deletion |

Sources: daemon.ts rpcCellRemove/rpcCellEvict/rpcCellRetainedRemove and retention
wiring; cellRetention.ts applyOne/trimOne/sweep; driver-cell remove.ts, retention.ts,
driver.ts, gitImage.ts, warmPool.ts, provision.ts. Independent read-only cross-family
survey: Claude claude-opus-5-5 reviewer bb31a769, message35411.

Implementation and evidence follow below. No real Cell was deleted during this work.

## Gate and policy

Core schema v53 fences older daemons from opening the new owner-removal journal. The v52 upgrade preserves existing operations and adds bounded pending/latest-backup indexes; no live runtime was changed.

All RPCs and automated apply paths use `evictThroughOwner`. The daemon's
single SQLite owner synchronously acquires a `remove` Cell operation before it
starts the verification worker. Remove operations now deliberately hold the same
mutation gate as capture and exec. Runtime start, Cell exec,
landing, move, handoff and cleanup cannot mutate that active allocation during
verification. Retained allocations do not block their source bee running elsewhere.
Their runtime generation pin is null; active captures pin the runtime generation
that ran in that allocation while the bee still exists. Deleting the bee does not manufacture a source change from its cascaded runtime rows. A complete CellRow identity and source inventory
must still match. Capturing an active but stopped/quiescent Cell is now supported.

The newest backup generation is authoritative: incomplete/unverified newer work
holds eviction rather than falling back to an older receipt. Every effect rechecks
the pinned public key, signature, operation/manifest/repository/machine/Cell binding,
manifest hash, source entries and path set, keep stash, ledger, index, HEAD, refs
and Git object inventory. `force` cannot bypass this. Retained allocations use
remove; only active allocations use evict. Revive must still find HEAD through a
reachable ref in the local origin. A merely present dangling object is insufficient.

`<dataDir>/backup-eviction.json` is a non-secret, owner-managed observation:

```json
{
  "version": 1,
  "maxReceiptAgeMs": 86400000,
  "capacity": {
    "repository": "rest:https://backup.example.ts.net/source/",
    "observedAt": 1793100000000,
    "maxAgeMs": 300000,
    "repositoryUsedBytes": 1000,
    "repositoryLimitBytes": 1000000000000,
    "fleetUsedBytes": 1000,
    "fleetLimitBytes": 24000000000000,
    "stopFraction": 0.9
  }
}
```

B6's authenticated machine-level capacity observer writes this through the owner;
UI/CLI eviction requests cannot supply it. Missing, malformed, future or stale
observations are unknown policy. Either repository or aggregate usage at 90%
refuses new eviction. The worker rereads the owner policy after the parked content check, immediately before authorization; a stop or expiry during verification rolls the source back. No policy is installed by B4. Receipt age is explicit policy,
not inferred from elapsed job time. Terminal refused keys retain their result;
a caller uses a fresh key after clearing the cause. Pending/unknown keys are
reconciled before issuing new work.

Closed reasons are `receipt_missing`, `receipt_stale`, `receipt_corrupt`,
`receipt_unverified`, `content_changed`, `capacity_stop`, `unknown_policy`,
`gate_busy`, `interrupted`, `outcome_unknown`. Refusals contain codes, never tool
stderr or sensitive file contents. The CLI shows the reason and no force suggestion.

## Atomic owner effect and crash recovery

Filesystem work runs off the daemon event loop in a worker thread. The owner gate
persists throughout it. The worker hashes and inventories the source, atomically
renames the wrapper to `_evicting/<wrapper>.verified.<operationId>`, then checks
the parked tree against the original source names. A mismatch or cancellation
before authorization puts the wrapper back. Any replay refusal (including expired
receipt or capacity observations) also restores an unauthorized park when safe.

Linux `/proc` cwd/fd inspection runs both before and after parking. A process still
attached to the wrapper refuses with content_changed. Other platforms currently
fail unknown_policy until an owner-supported writer-exclusion probe is supplied.
Owner mutations cannot interleave; external same-uid writers are not a filesystem
snapshot: inaccessible descriptors, mmaps and a writer opening between probes are
residuals. The parked recheck removes the path-writer window; the gate must run
only after runtime quiescence, never as a claim of kernel-enforced immutability.

After the parked check, a private fsynced completion marker commits authorization
before unlink. Cancellation is a shared flag honored only before that marker;
workers are never terminated mid-delete. Read-only directories become owner-writable
for completion; file modes and external hardlinks are not modified. Once authorized,
completion of the same effect can continue after a later capacity stop or receipt
age limit. This is recovery of committed intent, not a new eviction approval.

The marker binds operation id, generation, manifest hash and exact parked path.
Boot replays durable owner intents through the same key. A marker permits finishing
that authorized park and committing the Cell transition even if source bytes are
already gone. Without a marker, the parked source must pass full verification again
or be restored. Parks without an owner intent are never swept. An uncertain source
and simultaneous replacement are held with outcome_unknown. Markers are removed
after the done row commits; a leftover marker is harmless recovery evidence.

## Deliberate fail-closed limits

Active eviction currently refuses ignored env files or kept ignored paths with
unknown_policy. The old local-stash transport is not silently dropped. Those Cells
can remain retained and be backed up; retained removal is permitted only through
its exact verified receipt and explicit exclusion policy. Automatic output trimming
is disabled until a partial-tree disposal policy is defined; even an otherwise
valid whole-Cell receipt cannot authorize it. Legacy destructive helpers always
refuse, including force and raw reserved-wrapper removal. Legacy/orphan park sweeps
hold data. Provisioning/image/pool placement refuses preexisting claimed checkout
bytes rather than wiping an unrecorded tree. These changes intentionally trade
immediate disk reclamation for recoverability. There is no data-loss override.

Historical stash restore tests seed disposable transfer fixtures directly; they
continue to test owner restore/conflict behavior without pretending those fixtures
carry production deletion authority. Old tests expecting clean/force deletion
without backup are replaced with intact-source refusal assertions and the new
verified owner-worker end-to-end drill.


## Immediate bee deletion and visible Cell hold

Orchestrator decision, 2026-10-27 message35602: bee deletion remains immediate.
Missing receipts never delay the bee's lifecycle intent. Its in-flight Cell remains
fenced; the existing core delete removes the bee/runtime/log obligations without
changing the CellRow. Cleanup and the Cell transition happen only after capture
or interrupted owner-effect reconciliation, through the receipt gate. A completed
removal of a now-deleted bee's allocation marks the Cell removed, not evicted.

`cell.status {cellId}` (`cell.mutation-status.v1`, read) and thin CLI
`hive cell status <cellId>` return `{cell,mutation}`. A held mutation is
`{state:"cell_mutation_held",operations:[{id,kind,status,reason}]}`; otherwise null.
This is a derived Cell projection of durable owner operations, not a persisted
bee lifecycle flag or another Cell state authority. It remains readable after the
bee is gone. Starts into an active/evicted fenced Cell wait without charging the
spawn failure budget; retained Cells never block their moved bee elsewhere.

The disposable drill deletes a bee during actual capture and proves its Cell
stays intact until independent verification and owner cleanup. It also deletes a
bee after a simulated owner crash at the durable authorization boundary, proves
parked bytes still exist, then reconciles the same key and restores the exact
Cell from the encrypted repository. No real bee or Cell is used.
