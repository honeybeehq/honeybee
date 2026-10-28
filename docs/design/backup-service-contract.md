# Backup service, protocol v1

This is an artifact for operator installation, not an installed service. `hive backup run`
invokes `backup.service.run` on the local Honeybee owner. The owner reads its private
`backup-service.json` and admits exactly one local service tick. It never creates a bee.
Systemd, launchd and a disabled Pollinate template live in `deploy/backup/`.

## Authorities

The machine owner captures through the B2 gate and accepts B3 receipts locally. It stores
period, deterministic jitter, operation key, attempt, backoff and outcome in the same CoreStore.
Interrupted or uncertain keys and unverified completed snapshots precede new periods.
A machine-role config makes bare `cell.backup` require the internal service permit; callers
cannot supply a permit, repository URL, password or grant in RPC parameters.

The ciphertext server owns physical inventory, first-observed arrival times, capacity,
trusted publication history, immutable recovery pins, fleet leases and maintenance plans.
It holds an operational Ed25519 grant key and an access HMAC secret, never a repository key
or verifier signing key. A B3 publication anchor signs the exact encrypted catalogue snapshot
ID and receipt hash. The server verifies this anchor and the capture receipt before recording
Cell grouping. Restic client dates, tags and paths never decide retention.

The separate verifier has reader/catalogue-writer access and its own receipt signing grant.
Its narrow `/v1/verify` endpoint accepts only its configured machine/repository and returns
public receipt/publication evidence. It receives no daemon mutate capability. The fleet upload lease is released before readback; the independent verifier has its own single-flight admission.

The separate trusted maintenance executor has repository decryption and a reader grant.
It obtains a short-lived, repository-specific delete capability from the server. Neither
uploaders nor verifiers receive it. Distinct Hem principals enforce host separation;
role names and reference suffixes alone cannot establish which host possesses a credential.

## Scheduling and capacity

Targets configure `periodMs` and `jitterMs`; jitter is deterministic per machine, Cell and
period. A deterministic operation key is durable before any capture. Transient failures
retry that key; terminal capture failures settle that period. A fresh period gets a new key.
Busy, unknown capacity and authority outages use exponential backoff with deterministic
jitter and do not consume effect-attempt limits. Configured `maxAttempts` defaults to eight
for persistent verifier refusal. Interrupted/uncertain captures continue to retry their key;
a repeatedly held key raises `protected_key_held`, retains its bounded B2 checkpoint and
requires owner tag/catalogue reconciliation. A delayed key does not monopolize every target. Live runtime/Cell admission is checked
locally before taking the fleet slot. A non-protected busy period does not consume an effect
attempt and is settled `skipped_busy` once superseded; repeated busy periods alert after two
periods. Protected interrupted keys are never silently superseded.
The owner exposes paged `backup.service.status` / `hive backup status [after]` for inspection.
Verified publications awaiting authority acknowledgment are durable and retried independently
of capture attempts. A report retry does not recapture or lose the authority registration. Fleet leases have a monotonic counter and heartbeat. They throttle
bandwidth; restic's repository locks provide repository consistency. No remove-all unlock.
An expired upload lease can be reassigned, so an isolated old uploader may briefly overlap.
Heartbeat loss aborts its guarded child before the source owner releases its lease.

The server counts physical allocated bytes (at least logical size), repository overhead,
reserve and its owner metadata. Invalid or stale observations stop admission. Per repository
and fleet bands are 70% warn, 80% review, 90% stop. At a 24 TB repository allocation these
are 16.8, 19.2 and 21.6 TB. Total allocation is 24 TB plus 6 TB maintenance reserve. The
machine owner writes fresh B4 `backup-eviction.json` observations; B4 also stops at 90%.
Only tag probes for existing uncertain uploads remain admissible at the stop band.

The external ciphertext watcher detects two missed periods, allowing configured jitter and
slot wait. Its last-arrival clock means last *verified publication*, so verifier outages are
also overdue. A fresh bounded maintenance window excuses the pause; a stale or over-duration
maintenance job alerts and does not silence overdue detection. Observation failures alert
`capacity_unknown`; missing protected objects alert `protected_missing`.

Email uses Hem recipient and SMTP credential references. TLS is required except numeric
loopback fixture sinks. The durable outbox uses stable Message-ID and finite backoff;
lost SMTP acknowledgment may cause duplicate mail. Messages contain closed status codes and
machine identity, not Cell paths, repository URLs, raw errors or credentials.

## Retention and maintenance

Installation configuration supplies the approved defaults: 48 hourly, 30 daily, 12 weekly,
12 monthly. The planner unions server-clock buckets separately for each signed Cell identity.
Pins preserve sole recovery copies referenced by deleted/evicted Cells and proof owners.
There is no unpin or override API. A pin acquired before an eviction that later refuses (for example content_changed) remains conservatively pinned. B4 registers its pin while holding its durable mutation
gate and before authorizing physical deletion. New pins and history registration refuse
while maintenance owns the fleet lease. Proof owners must register their references before
rollout; existing B4 deletion receipts need the same bootstrap inventory. This is a blocking
server-local install step: the authority requires an operator `bootstrap` attestation per
repository with inventoryHash, required pinIds, approvedAt and approvedBy before admitting
any prune. The pins must already exist. No uploading principal can submit that attestation.
Inventory every prior B4 done removal/eviction and proof reference, register their receipts,
pin their sole recovery generations, hash the inventory, and have Tormod attest it in the
private authority config. An absent attestation refuses prune as retention_unknown.
A configured B6 machine writes `pinRequired:true` into B4 policy. A missing/refused authority
pin becomes `pin_unavailable` before the deletion worker starts; there is no local fallback.
The persisted requirement still holds if service configuration becomes unavailable.

Fresh verified captures remain protected for the configured receipt age, and unknown
snapshots are held. Kept captures keep their catalogues. Forgotten captures and catalogues
are selected together, unless a catalogue also serves a kept capture. Server history records
retirement after both objects disappear. Unknown/unverified arrivals raise a typed alert;
they cannot be disposed merely because an uploader calls them junk. They require independent
verification/catalogue reconciliation. There is currently no signed rejection-disposition
API; unresolved rejected snapshots remain held and can consume the upload stop margin.

Weekly structural and bounded data checks and monthly prune are server-admitted. The
executor checks repository identity, protected IDs before forget, after forget and after
prune, then runs structural plus a rotating data subset check. Explicit server-selected
snapshot IDs are the only `forget` arguments. Bounds include duration, reserve, bytes read,
bytes written, bytes deleted and object count. Large packs or unbalanced read shards can
exhaust a read budget and fail closed; they do not silently increase it. B3 full readback of
sole copies remains separate from restic's structural/subset check.

Every maintenance attempt persists plan/protected hashes, counter, completed forget IDs,
budget charges and typed outcome in Core audit history. An uncertain job is re-planned
under a new admission, never blindly replayed. A failed check/prune does not automatically
repeat the same destructive attempt. Server measurements and mail still run.

## B1 runbook delta: non-append-only access

Tormod must provision a separate tailnet-only TLS authority endpoint and executor Hem
principal. The writer endpoint remains permanently append-only. The authority gateway
binds numeric loopback behind that TLS terminator. For a maintenance grant it starts a
separate non-append-only rest-server on a configured, unused numeric-loopback port. Its
password is job-scoped, distinct from the executor-facing grant password, and retained
only in memory; its htpasswd artifact holds a hash. No decryption key reaches the server.
The gateway denies config/key mutation, arbitrary snapshot deletion and foreign lock deletion,
and enforces the grant budgets before forwarding. Data/index deletion requires a successful new index publication in the same admission; at most 100,000 objects may be deleted. A job that needs to dispose orphan packs without publishing an index is held rather than weakening this guard. It preserves HTTP byte ranges.

The backend is owned through the B2 parent-disconnect guard, with exact process identity
persisted before it can start. Revocation stops and awaits that backend before releasing
the maintenance fence. After an authority restart, an unproved surviving backend holds the
fence until its exact identity is gone. Never expose the backend port on the tailnet. Never
reuse writer credentials for maintenance. Rest-server alone cannot enforce bounded deletes;
the gateway and trusted executor are required parts of this boundary.

Install B6 and bootstrap its recovery pins before enabling production B4 deletion or finite prune. Legacy isolated B4 fixture policy without pinRequired is not a production installation path. Install the owner daemon, private role config, TLS ACL, Hem grants and templates only after
review. Do not embed credentials in units, plists or Pollinate definitions. Mac login/key
setup remains Tormod's. No service or real trigger was installed during development.

## Deployment templates and setup gaps

`deploy/backup/{machine,authority,executor}.example.json` show role configuration
without secrets. Replace public keys, authenticated repository IDs, allocation identities,
TLS endpoints and paths. `retention.example.json` contains the approved configurable counts.
Authority bootstrap starts empty, so the example cannot admit prune as written.

No dedicated repository verification skill is installed. Repository check/build/test commands
and the committed disposable drill provide verification instead. Pollinate is not installed
in this Cell: the disabled TOML parses, but its installed-version schedule schema and dry-run
are NOT_COVERED. The accompanying definition recipe specifies source, delivery, command,
context and expected job/ledger inspection. Tormod must validate it against his installed
Pollinate release before importing/enabling. macOS launchd XML parses; installation/runtime
are NOT_COVERED. Linux unit installation is also untested and was not performed.

The bootstrap `approvedBy` value is Tormod's public operator identity recorded by the
server-local installer. It is an administrative attestation in private authority config,
not an Ed25519 signature and not a machine-submitted claim. The trusted server filesystem
and Tormod's deployment access establish who may write it; no public operator key is checked.
Do not describe that label as cryptographic proof of Tormod's identity. There is no code
that can enforce this install order on a node that has B4 but has never configured B6.
The operator must configure B6/pinRequired and bootstrap before production deletion.

## Writer fencing and quota retally follow-up

Schema 55 prevents a v54 owner from replaying this privileged effect protocol. The
writer and maintenance backend share ciphertext, so the fleet lease alone is insufficient:
append-only rest-server still permits lock deletion and its size counter is only scanned
at startup. Before maintenance, stop and confirm the exact writer unit. Afterward, prove
all backend processes gone and start a fresh writer so its quota is recounted.

Authority configuration requires exactly
`maintenance.writerFenceCommand = ["/usr/bin/sudo","-n","/usr/local/libexec/fleet-backup-writer-fence"]`.
The daemon supplies only `stop|status|start` plus an allocation unit label. A profile may
set `writerFenceMachine` when its source identity differs from that label. No request,
shell string, URL or Serve identity header can supply a privileged command.

Tormod installs `deploy/backup/fleet-backup-writer-fence.py` as that root-owned 0755 helper.
Its root-owned `/etc/fleet-backup/allocations.tsv` is B1's three-column label/port/limit
allowlist. Its root-owned `/etc/fleet-backup/authority.uid` pins the nonroot authority UID;
UID 0 refuses, and SUDO_UID, if present, must match. The environment never selects the UID.
Root-only persistent state lives at `/var/lib/fleet-backup/writer-fences`: `<label>` is
the writer-start marker, `<label>.json` its job/bound-identity journal, and a flock serializes
operations. Install the matching unit condition from `writer-unit-fence.conf`. Enabled
writers cannot auto-start through a retained marker after reboot. Never store this fence
only in /run. Exact 45 sudoers permissions (three actions × 15 labels), directory ownership,
Linux pidfd support and effective authority service privilege settings require operator
installation proof. No root, sudo or systemd command was run during development.

JSON stdin is `{format:"honeybee.writer-fence.v1",jobId:<64 hex>,backend:null|{pid,birth,bootId}}`.
Output binds format, jobId, machine, `fleet-backup@<label>.service`, writer, ActiveState,
SubState, backend, fenced, and optional inventoryBytes/inventoryComplete. Zero exit alone
is insufficient. `stop` persists intent/marker before stopping and proves inactive/dead,
zero MainPID/ControlPID and an empty unit cgroup. `fenced:true` is intent until stopped
is confirmed. `status` with a backend identity binds it before the guard can launch the
tool; null only inspects recovery, including an already-running/released writer.

The backend guard is a separate process-group leader. Before restarting, the helper
requires the same job and proves the whole same-boot group absent. If the guard was killed,
it can reap only bound orphans of the pinned UID, using exact Linux pidfds, birth/boot/PGID
rechecks, TERM then bounded KILL. It never signals a live/reused leader or a foreign UID.
TypeScript never kills an unverified raw PGID. SIGSTOPped/live unknown guards stay held for
operator inspection. If pipes remain open after guard death, the owner uses a one-second
settle bound and asks the helper for authoritative reap/absence. After proven release,
a late close cannot keep the in-memory backend lane wedged; hash artifacts are cleaned.

The backend always receives an explicit integer `--max-size` equal to the lesser of
`profile.limitBytes + grant.maxWriteBytes` and the observed repository bytes plus that write
budget, also bounded by the 30 TB allocation. Existing duration, reserve, byte and object
budgets still apply. Raw backend ports remain numeric loopback only.

Before restart, the authority attempts a bounded five-second physical inventory; the helper
has a separate two-second advisory scan. Incomplete measurement is recorded, invalidates
capacity/admission, and raises `writer_fence_failed` phase inventory. It does not indefinitely
prevent a confirmed fresh writer restart. A fresh unknown observation writes B4 admission
stop. Ordinary inventory must recover before uploads/evictions resume. Large-repository
scan timing is not measured by the fixture. Lifecycle/identity failures retain marker and
fleet lease, with a phase-specific alert; other repositories still get monitoring/overdue
processing. A journal belonging to a lost job must be reconciled from its durable Core intent
and same-job helper protocol; never erase the marker, change the pinned UID or manually
start through uncertainty.

The gateway continues to require configured Bearer credentials and scoped maintenance Basic
grants. Tailscale Serve `Tailscale-User-*` headers confer no authentication, even on a
reachable frontend. The loopback drill sends those headers without a grant and receives 403.
It also kills a real disposable guard, proves automatic orphan recovery, tests a stuck fence,
and checks actual writer quota retally after maintenance additions and deletions. Production
sudoers, systemd boot behavior, target ACLs and actual SX65 installation remain untested.

## Final B1 filesystem and readiness alignment

The supported server model has separate writer and authority UIDs. The backend runs as the
same dedicated nonroot authority UID (matching authority.uid) with supplementary ciphertext
group `fleet-backup`. Both rest-server paths use `--group-accessible-repos`, UMask 0007 and
setgid 2770 repository directories; ciphertext files are 0660. The guard sets only its own
backend umask before spawn. Authority keys/config and state remain in private 0700 trees
under /etc/fleet-backup-authority and /var/lib/fleet-backup-authority, primary private group,
with writer/proxy InaccessiblePaths. The authority needs an owned private reserve/artifact
directory too; do not point it at B1's root-only reserve directory without reviewed access.

This is a trusted-authority boundary: its shared group grants standing write/unlink access
to ciphertext. Compromise of the network-facing authority can delete repository data and
bypass its own grant/pin checks. Group permissions are not an OS enforcement boundary against
that process; grant bounds constrain the trusted implementation and authenticated callers.
The server still receives no decryption or verifier private key. This residual is explicit
in B1 v13 and requires operator review before activation.

For existing repositories, Tormod must perform a one-time migration while writers and
maintenance are stopped: validate each exact canonical encrypted instance tree, reject
symlinks, change only that tree to the ciphertext group, set directories 2770 and files
0660, then verify it. Never apply recursive changes to /p4/main/depots, Perforce or private
authority state. New initialization uses these modes from the start. Before backend launch,
a bounded preflight checks the repository root, metadata directories, sampled metadata and
pack files, matching group and actual authority access. Every data prefix directory is checked; pack sampling stops after the first 16 packs found. File mode 0660 is a hygiene requirement stricter than unlink needs: writer umask drift refuses as permissions_invalid. Legacy 0600 files refuse early with
`permissions_invalid` before forget. Sampling does not replace the full migration.

The inventory root is the actual namespace (`repos/unit/unit` in B1); the backend root is
its parent (`repos/unit`), derived from and checked against the configured repository URL.
A complete pre-maintenance census records logical bytes including directory metadata,
separately from physical allocated bytes. Incomplete logical inventory cannot admit a backend
or supply its max-size input. The cap is the exact lesser of limit+admitted writes and
logical observed bytes+admitted writes. Post-maintenance incomplete physical observations
hold client admission/eviction; a valid static writer credential can still reach the freshly
retallied, hard-capped writer. That is not an adversarial endpoint fence after restart.

Successful writer start additionally requires an anonymous GET /unit/config on its allocated
loopback port to return 401. Active/running alone is not ready. A bounded readiness timeout
retains the marker/restarting phase; retry waits for the same already-started writer instead
of repeatedly stopping its initial tally. The local drill uses B1's nested layout, checks
real 0660/setgid bits, tests incomplete pre-inventory and legacy mode refusal, and proves the
backend's exact argv/cap. A real two-UID deployment, sudoers and systemd remain operator proof.

B1 reserveRoot alignment: `/p4/main/depots/fleet-backup/reserve/authority` is authority-owned
0700, beneath a root:private-authority-group 0750 parent. Writers are not members of that
private group. The authority has an explicit ReadWritePaths grant for its child; reserve
accounting includes it. No agent created or changed these production paths.


Failed maintenance admission is durable and retryable. After confirmed cleanup, the same
run is queued with admissionFailures and notBefore: exponential 30-second delay capped by
the configured weekly check interval. A held same-job fence still reconciles immediately.
This prevents a persistent backend fault from repeatedly stopping and restarting writers.
Unauthorized preflight never takes the writer fence. Failed cleanup retains its lease.
On daemon shutdown, a durable held writer fence cannot skip RPC cleanup and runner-host
detachment; the successor reconciles the persisted fence. The forced shutdown-catch branch
is NOT_COVERED by a fault-injected daemon test.

## B9 integrity correction

[Backup integrity holds](backup-integrity-contract.md) supersedes earlier failure/drill authority wording: failed checks and signed drills hold repository eviction until a matching trusted success. Physical capacity alone cannot clear the hold. Schema 56 and protocol 1 require a coordinated owner/authority/executor upgrade.
