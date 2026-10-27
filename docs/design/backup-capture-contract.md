# Honeybee backup capture and draft snapshot record (B2)

This contract lets a machine-level service capture a quiescent Cell and create an
encrypted restic snapshot. It does **not** verify a production backup, sign a
receipt, authorize eviction, install a service, or schedule work. B3 adds independent
readback and signed verification; B4 owns the authoritative eviction gate.

## Owner command and configuration

The CLI is thin:

```sh
hive cell backup <cellId> --idempotency-key <stable-operation-key> --json
```

It calls versioned daemon RPC `cell.backup` with `{cellId,idempotencyKey}`;
`cell.backup.v1` advertises support. The daemon alone writes `cell_ops` in its core
SQLite authority. The closed operation vocabulary adds `backup` in schema v52;
existing operation rows and audit replay retain their meaning.

The owning daemon reads `<dataDir>/backup.json`. RPC callers cannot substitute a
destination, secret reference or executable. A non-secret example is:

```json
{
  "repository": "rest:https://backup.example.ts.net/machine-name/",
  "passwordRef": "global/fleet-backup-machine-name-repo-key",
  "writerRef": "global/fleet-backup-machine-name-writer",
  "maxScratchBytes": 1073741824
}
```

Provision the repository separately. The worker never initializes, unlocks,
forgets, prunes or deletes remote history. Production endpoints require HTTPS with
normal certificate validation. HTTP is accepted only for numeric loopback fixture
addresses. Userinfo, queries and fragments are refused. Deployment must enforce
the approved tailnet-only append-only server, private repository, path allowlist,
capacity limits and access policy; the client cannot attest those server controls.

Hem references are restricted to `global/fleet-backup-<name>-repo-key` and
`global/fleet-backup-<name>-writer`. The repository secret's field is `password`;
the writer secret has `username` and `password` fields. `hem get <ref> <field>`
receives only references in argv. The daemon passes its scoped Hem endpoint/token
only to Hem. It passes restic's password and HTTP Basic credentials in a dedicated
child environment via the guard's IPC channel, never in argv, repository URLs,
records or logs. No ambient restic/AWS credentials, proxy or password command is
inherited. Source files are not generically proven secret-free: sensitive filenames
are refused, and recovery databases/logs may contain sensitive application data.
Treat repository decryption authority accordingly.

## Two capture forms

`honeybee.capture.v1.captureKind` is one of:

* `retained_checkout`: a registry `retained` Cell with its full checkout, owner
  ledger `box/cell.json`, Git recovery material, and associated keep stash/manifest
  if present. Capture committed refs, all accessible Git objects (including staged
  and dangling objects), the original index, dirty/untracked/unique ignored files,
  directory modes, executable bits and literal symlink targets.
* `evicted_stash`: a registry `evicted` Cell with no checkout and a required
  `cell-keep/<spaceName>` plus sibling `<spaceName>.json`. Its `evictedHead` and base
  must still be readable from the owner's local origin **at capture time**. A
  scratch bare repository borrows objects read-only, creates recovery/base refs,
  and emits a **self-contained** bundle and object pack for both histories. No
  origin working-tree files are captured. The snapshot's recovery material has
  no external base dependency; restore works after the fixture origin is removed.

The first version always carries the required base history. It refuses a capture
that cannot fit scratch rather than emit an undeclared thin bundle. `git.dependencies`
is the empty array. A future thin format must declare each base object/ref, its
independent immutable locator and hash, and verify that dependency in recovery.
Do not interpret an empty dependency list as permission to omit base objects.

Machine identity is the configured allocation node id, falling back to hostname
for an unconfigured node. The complete owner `CellRow` binds repository identity,
Cell/bee ids, paths, base SHA, state and retention/eviction facts. `generation` is
the durable backup operation UUID, not a runtime generation.

## Admission, consistency and retry

Admission checks a retained/evicted row, no live Cell runtime or admitted start,
no move/handoff, and no Cell operation holding the gate. A node-wide backup lane
serializes repository writers. It acquires the durable operation synchronously
before the first await. Retained exec, landing, forced removal and retention
consult the same gate. Runtime-start command admission leaves spawn/revive/wake queued behind a backup
without incrementing the boot failure budget. Already-admitted booting runtimes
refuse capture; materialization cannot race admission.

A tool guard receives its command and constrained environment by IPC only after
the daemon saves its PID, exact birth identity and boot identity. Parent disconnect
stops the tool and waits for it to exit. Restart keeps an observed surviving guard
fenced; an observed absent guard permits retry. A pre-PID row cannot have started a tool under this protocol, so restart settles
it interrupted and permits retry. Native identity inspection that is unavailable
never proves a live process absent; ambiguous repository results remain an explicit
`outcome_unknown`, never success or a guessed timeout. PID reuse does not count as the
original guard when an exact identity is available.

The manifest records a deterministic sorted inventory for a capture generation.
The worker hashes selected source bytes/metadata before upload and again after it,
and checks new/removed selected files, keep contents, Git refs/object inventory and
HEAD. Changes fail with `source_changed`; an already-created snapshot remains an
unverified orphan and must not authorize eviction. External editors are not
cooperating owners: full restored-byte comparison in B3 remains mandatory before
claiming a sealed, verified recovery point.

States in the draft are `capturing`, `captured`, `uploading`, `snapshot_created`.
The surrounding `cell_ops` row uses its existing queued/running/done/failed/
outcome_unknown vocabulary; `stdout` stores the typed non-secret draft JSON,
**not** process output. `stderr` remains empty. Existing `cell_op.put` audit deltas
and snapshots carry the record without another lifecycle authority.

A key is bound to the canonical non-secret request hash. Conflicting reuse raises
`idempotency_conflict`. A completed request returns the original snapshot. A failed
or interrupted attempt may resume the same capture generation; it checks the
repository tag `honeybee:<operation UUID>:<manifest SHA-256>` first. One matching
snapshot reconciles a lost receipt; multiple matches return `outcome_unknown`.
A source that changed since its checkpoint needs a new key/generation. Retries
never delete, move or alter the source Cell or stash.

Scratch is private `<canonical dataDir>/backup-captures/<operation UUID>`. The
configured budget (1 GiB default, 10 GiB maximum) caps temporary bulk scratch across
all generations on the node. Durable manifest catalogue bytes are recorded
separately and excluded from the bulk budget; B3/B6 must account for and retain
that catalogue under their verified retention/capacity policies. Existing failed checkpoints reduce the next job’s
available budget and fail closed when exhausted. Git output streams enforce their budget;
online DB exports preflight full page counts (including freelist pages) and
recheck progress/size. Wrapped progress failures retain the scratch-limit reason. Metadata and file-list
bytes also count. Partial SQLite batches and filesystem allocation/metadata can
add bounded overhead; this is a logical-byte budget, not a filesystem quota.
No duplicate whole working tree is staged. Restic reads exact selected source
paths, with cache disabled and a default 10 MiB/s upload limit. Tool processes have
a one-hour bound. Git listings have an explicit 64 MiB buffered limit and return
`git_listing_too_large` when a repository exceeds this supported inventory size,
rather than misreporting the source scratch budget. Successful durable final records release bulk Git/DB scratch;
the manifest remains. Failed captures retain their bounded checkpoint for the same-key retry. When bulk headroom is short, starting a different operation retires other
non-uploading, non-interrupted failed generations’ generated Git/DB scratch
through the owner, oldest first and records `checkpointRetired` in their durable draft. Their
manifest remains; a subsequent retry of a retired key returns `checkpoint_retired`
and requires a new key. Live, interrupted and uncertain uploads are never reclaimed. Non-resumable
`source_changed` failures are eligible even after upload; their manifest and
unverified remote snapshot remain available to B3/B6. Retry
those keys first so a possible committed snapshot is probed before any new work;
a capacity refusal never silently destroys their lost-receipt recovery path. The
future B6 scheduler must retry these persisted operation keys before issuing new
keys; otherwise protected checkpoints can consume the bulk budget until owner
reconciliation. B2 never
deletes a source or remote snapshot.

## Include/exclude policy v1

Preserve tracked files even under generated-directory names. Preserve `.proof`,
`.audit`, `evidence` and `.evidence`, including nested evidence in build output.
Include all other untracked and ignored regular files and symlinks by default.
Tracked paths are preserved even when their names resemble credentials, including
`.env.example` templates and test certificates. Git history may already contain
sensitive blobs; filename rules are not a secret scanner.

Record exclusions for `node_modules`, `.cache`, `.npm`, `.pnpm-store`, `dist`,
`build`, `out`, `target`, `.next`, `updates`, `honeybee-updates`, and special
runtime files. Dependencies/caches/update trees are pruned; evidence must be stored
outside those disposable namespaces. Generated output is walked to retain tracked
files and nested evidence. Git storage itself is represented by the bundle/object
pack/index and ref facts; secret-bearing local Git configuration is not copied.

Recognized **untracked** credential filenames refuse the capture
(`sensitive_file`) rather than silently omit unique data. Live-looking SQLite main files in source trees refuse
with `database_in_tree`; export them through their owner instead. Arbitrary secret
content or nonstandard database names cannot be detected by filenames alone.
Current submodules/gitlinks, nested repositories, Git LFS storage/pointers/attributes,
sparse checkouts and in-progress merge/rebase/cherry-pick/revert state refuse with
`git_incomplete` rather than silently lose external or control data. Local Git
configuration and reflog timelines are explicitly omitted; retained captures keep
the reflog/dangling objects in their object pack. Secret `cell-env` stashes are an
explicit exclusion and require separate Hem-based recovery.
Sockets and special runtime files are excluded explicitly. Symlinks are recorded
literally, never followed. Paths through symlinked parents are refused.

## Manifest and draft record reference

The maintained TypeScript definitions are in
`v2/daemon/src/backupCapture.ts`; use those rather than duplicating an independent
schema. The format names are versioned and must change for incompatible semantics.

The manifest contains machine, full `CellRow`, capture generation/kind,
Git head/headRef/base, refs, object-id inventory hash, bundle/pack/index locations,
base dependencies, explicit policy/exclusions, database receipts, sorted entries,
and selected file/byte totals. Each entry records absolute source path, kind,
permission bits, logical bytes, SHA-256 and optional literal symlink target.
A symlink digest hashes its target string. Directory bytes are zero and its digest
hashes the empty string. Empty directories are included in restic's file list;
manifest directory metadata rebuilds directories containing only excluded children
without asking restic to recurse into those children.

Database receipts carry source path/build, schema version, DDL digest,
`integrityCheck: ok`, snapshot time, closed snapshot path, receipt path and SHA-256.
`core.snapshot` and `TelemetryStore.snapshot` call SQLite's online backup API on
their existing owner connections. Hashing streams the closed output; integrity
validation runs on a worker thread. Never copy a live main or WAL file. These are
per-database recovery checkpoints, not one atomic multi-database instant. Full
core and telemetry exports are intentionally sensitive node recovery data and may
contain mail, transcript-related state and temporary application capabilities.
They go only into encrypted snapshots, never proof evidence or diagnostic output.
Daemon shutdown aborts guarded tools, awaits in-flight snapshot/validation jobs,
then closes the owner databases. Cancellation reaches SQLite backup progress,
terminates integrity workers and interrupts streaming hashes. A 30-second shutdown
deadline refuses to close live snapshot connections; a process exit leaves the
durable operation interrupted for the successor. Deadline cleanup still closes
RPC, removes the endpoint and detaches runner-host ownership without signaling
bee runtimes; it leaves active SQLite snapshot connections to process exit. This
rare deadline catch branch is NOT_COVERED by a forced-deadline live-bee drill in
B2; normal snapshot shutdown/retry and existing runner-host re-adoption are tested. The drill stops the daemon during an online
snapshot and retries after restart. Apiary/harness-owned databases require their
owners' exports in later integration.

The draft `honeybee.backup-draft.v1` binds operation UUID, machine/Cell identity,
generation, non-secret repository locator, manifest path/hash, state, snapshot id,
capture/snapshot times, Node/Git/restic versions and optional current guard identity.
`verification` is **always `not_verified`**. The restic repository locator is not a
cryptographic repository id; B3 must obtain and bind the repository's authenticated
config id as part of independent verification. B3 also binds verifier identity,
readback results, signing authority and time without mutating this draft into
lifecycle or eviction truth.

Typed outcomes are `snapshot_created`, `refused`, `failed`, `outcome_unknown`.
Reasons include invalid request, busy, unsupported Cell state, source changed,
sensitive file, database in tree, incomplete Git, scratch limit, secret unavailable,
oversized Git listing, retired checkpoint, tool failure, interruption and unknown outcome. Diagnostics contain these closed
reason codes, not raw subprocess output or exception text.

## Recovery and verification

With restic and rest-server available locally, run:

```sh
node scripts/verify-backup-capture.mjs
```

Set `HIVE_TEST_RESTIC` / `HIVE_TEST_REST_SERVER` to executable paths if needed.
The script refuses to skip the real drill when tools are absent. It uses a
throwaway authenticated append-only server on numeric loopback, disposable
passwords held in memory and a one-way server password hash. Fixtures are beneath
this checkout's `.audit/backup-b2/fixtures`; a temporary short symlink is used for
Unix socket paths, while all fixture bytes remain inside the Cell. No real Cell or
remote host is used.
`HIVE_TEST_KEEP_BACKUP_FIXTURE=1` keeps disposable encrypted repositories/restores
for examination; no plaintext repository/writer password is written.

Expected evidence is `.audit/backup-b2/end-to-end.json` and five passing tests.
The drill proves full-checkout and stash-only recovery, byte/mode/symlink agreement,
empty directories, staged/unstaged changes, Git fsck, committed WAL rows, database
integrity, source preservation, killed-owner tool cleanup, interrupted upload,
lost-receipt reconciliation, real daemon RPC/done replay, shutdown during an online
snapshot, symlinked dataDir support and absence of fixture credentials in diagnostics.
Seven successful snapshots are expected: one retained operation despite retries, one
stash operation, one daemon RPC operation, one lost-receipt operation, one interleaved
operation on another Cell, one operation after reclaiming a failed checkpoint and
one shutdown/retry operation. The
dictionary of operation tags is unique; this is one snapshot per operation.

Restore into a fresh staging directory, using restic's snapshot-subtree syntax to
avoid restoring/chowning unrelated absolute ancestors. The snapshot includes the
manifest; do not rely on the source machine's copy. Verify its digest against the
independently trusted record before trusting paths. B3 must validate restored
paths/targets before writing any recovery destination, verify all entries and DB
receipts, rebuild refs and index from Git recovery material, and preserve symlink
targets verbatim when overlaying keep files. Full checkouts keep captured dirty
bytes; stash-only recovery clones the self-contained recovery bundle, checks out
the recorded head, and overlays kept paths without dereferencing symlinks.

The local drill deliberately deletes only its disposable origin before rebuilding
the stash-only tree. It is evidence of this implementation, not an independent
production verification or a fleet rollout. No live backup, eviction, deployment,
service installation or schedule is part of B2.
