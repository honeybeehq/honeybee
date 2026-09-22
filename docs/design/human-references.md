# Permanent bee references

Schema v30 retains the canonical bee UUID and adds `BeeRow.human_ref` and
`BeeRow.issuing_namespace`, both nullable strings. For example, `CO.9652.00`
contains the original handle and the issuing installation's namespace. Placement,
name and harness changes preserve both fields. Deletion retains a reservation;
neither a qualified reference nor a deleted bee UUID can be issued again.

## Enroll a fleet

Select **one Honeybee daemon as the fleet's registry**. The existing Honeybee node
registry and Apiary peer registry do not serialize fleet allocations. This registry
is explicitly initialized, has one SQLite writer, and never elects a replacement.
Do not initialize a registry separately on every machine.

1. On the selected authority, run `hive human-ref registry init` once.
2. On each issuing installation, run `hive human-ref status --json`. Copy its
   `installationId`, which identifies the Honeybee database, not an Apiary node,
   hostname, bee, or current owner.
3. On the authority, run
   `hive human-ref registry reserve <installation-id> --json > receipt.json`.
4. Transfer that receipt to its issuing installation and run
   `hive human-ref enroll receipt.json` there.

Reservation commits before returning a signed receipt. Retrying a reservation for
an installation returns its original receipt. Codes use an expanding base36
sequence (`00` through `zz`, then `100`, etc.); they are never randomly guessed or
recycled. Enrollment verifies the Ed25519 signature and target installation,
then trusts and permanently pins that authority on first use. This explicit
first enrollment is trust on first use, not proof of a global registry.
Conflicting namespace or authority reassignment refuses. An installation that
already has qualified references cannot initialize a different registry.
Independent registries cannot be federated; their codes are not globally unique.

Enrolled installations issue offline, using an expanding local hexadecimal
sequence. The registry may be offline during issuance, restart, or receipt
verification. An unenrolled installation continues to expose nullable qualified
fields and legacy aliases; it does not guess a namespace. Enrollment qualifies
its existing bees transactionally. Pre-v30 deleted handle spellings that remain
in the audit history are reserved too; previously reused legacy aliases cannot
be retroactively made unique.

## Consumer contract

Snapshots carry both fields on their bee rows. Creation deltas include them in
`bee.created.payload.bee`. Enrollment emits one `bee.human_ref` event per changed
bee, with `{beeId, human_ref, issuing_namespace}`, in the same transaction as
backfill. Exact enrollment retries emit nothing. `SpawnResult` adds `humanRef`
and `issuingNamespace`. Capability: `bee.human_ref.v1`.

CLI display prefers the qualified reference. Resolution accepts UUID, qualified
reference, legacy alias, name, and a unique prefix, in that order. Ambiguous aliases
refuse and list candidates. Consumers must not reconstruct an issuer from current
placement. Trusted import code must preserve the reference and issuing namespace;
the current transport only implements same-node Cell moves.

RPCs: `humanRef.status`, `humanRef.enroll {receipt}`,
`humanRef.registry.status`, `humanRef.registry.init`, and
`humanRef.registry.reserve {installationId}`. These use the existing same-user
control socket. Allocation and enrollment are durably idempotent without relying
on the bounded RPC response cache. Registry initialization is an explicit operator
choice; ordinary daemon startup never initializes it.

## Storage and recovery limits

The v30 bump is required: older writers do not maintain permanent UUID/alias
reservations or issuance counters and can reuse deleted identities. They can also
recreate the old unique bare-handle index, which conflicts with imported aliases.
Version 29 is skipped because reverted build `7374447d` accepts stores up to v29;
using v30 also fences that writer. Stores at v28 or earlier migrate directly to
v30 with idempotent table creation and column checks. A store stamped v29 refuses
with an explicit error naming `7374447d` and requiring a restore from backup; its
retired reminder-origin vocabulary is not migrated by this change.

Rollback to any pre-v30 binary requires a store restore. Reopening a completed
migration preserves installation identity, references, reservations and counters.

Back up the **entire SQLite store consistently**, including the WAL when relevant.
It holds installation identity, issuer receipt, reference reservations, allocation
ledger, counters and the authority's private signing key. Protect it as private
local daemon state. Deleting bees never deletes the allocation or reference ledger.

Do not restore an older backup and resume issuing: allocations or references issued
after that backup could be reused. Recovery must restore the complete latest ledger
and counters before issuance resumes; this implementation cannot detect records
lost in a rollback. Do not run a cloned installation or registry database alongside
the original. Both copies would share identity and counters, and disconnected
writers could issue the same reference. Fresh installations need fresh databases
and enrollment with the selected authority. This release supplies no automatic
clone detection, registry failover, or independent-registry merge.
