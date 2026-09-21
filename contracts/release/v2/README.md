# Release and compatibility contract v2

V2 implements the accepted [standalone workstation decision](../../../docs/adr/003-standalone-workstation-compatibility.md).
It identifies the software making and receiving a request independently, including
two different apiaryd builds or targets. Honeybee owns this schema, parser, types
and portable corpus. Apiary owns producer, evaluator, signed distribution, cache,
runtime admission, supported selection and updater adoption. This package does
not activate software or establish a new handshake or lifecycle authority.

Import `honeybee/release/v2`. The public functions are `parseComponentIdentity`,
`parseDependencyLock`, `parseCompatibilityRecord`, `parseCompatibilityMatrix`,
`parseRecoveryPlan`, `parseReleaseManifest`, `compatibilitySubjectDigest` and
`recoverySubjectDigest`. Types use the same version-scoped names as v1, plus
`ArtifactRole`. `parseBuildIdentity`, `readBuildIdentity` and `BuildIdentity` remain
the separate existing build-provenance API; its version has not changed.

`schema.json#/$defs/identity`, `dependencyLock`, `record`, `matrix`, `recoveryPlan`
and `manifest` are portable schema entry points. JSON Schema alone is insufficient:
readers must implement the semantic checks below and URI format validation.
Parsers accept decoded JSON, reject additional fields and unsupported versions,
and return independent values. Parsing establishes consistency, **not authenticity**.
All example.test fixtures are synthetic, with no real release approval.

## Exact artifact roles

`Combination` has exactly three slots:

| Role | Component | Meaning |
| --- | --- | --- |
| `caller` | `apiary` or `apiaryd` | Actual inventory owner initiating the interaction |
| `provider` | `apiaryd` | Service receiving the node interaction |
| `honeybee` | `honeybee` | Honeybee serving that provider's Honeybee operations |

Every slot has the unchanged identity shape: component, strict SemVer, full
lowercase Git source revision, target, HTTPS artifact URL and SHA-256 checksum.
The caller and provider may share a component, version, artifact or target, or
differ in all of them. Roles remain distinct even when identities are identical.
Targets are independently checked against actual installed artifacts, never
inferred from the other endpoint. Artifact bytes must be verified by consumers.

For the desktop-owned bundled worker, `caller.component: apiary` is valid only
when the actual desktop artifact owns the extracted caller contract and the
bundled worker's authenticated build provenance binds it to that desktop build.
An independently installed workstation service uses `caller.component: apiaryd`
with its own verified artifact and inventory. Attaching a desktop to that service
does not change its caller identity, whether the desktop remains open or closes.
An unrelated desktop version is not a substitute for missing daemon identity.

A role is an evidence endpoint, **not an installation destination**. In particular,
a remote caller's desktop or daemon artifact must never be staged onto the
recipient just because it appears in `components`. Remote update owners select
the recipient's provider and Honeybee artifacts, preserving requester identity.
A desktop recipient may require its own genuine app archive and authenticated
embedded-provider provenance; that destination provenance is independently
verified, not borrowed from the requester. Local desktop updates can change their
own genuine caller and provider together. Apiary's activation owner determines
which artifacts belong on the destination; Honeybee remains activated only by
`hive deploy`.

## Operations and evidence

Each operation keeps its unique ID, required flag, protocol/version/capabilities
and consumer/provider fingerprints. Each endpoint now has
`{ role, component, fingerprint }`. The parser checks that the component equals
the component in the named combination slot and that endpoint roles differ.
There is no component-name inequality rule in v2. Missing or unknown roles and
forged `apiary` attribution for an `apiaryd` slot are rejected.

For example, `caller → provider` describes the node operation, while
`provider → honeybee` describes the receiving daemon's Honeybee dependency.
Neither edge's evidence authorizes the other. A genuine direct caller-to-Honeybee
operation must have its own extracted contract and evidence; it cannot be inferred
from these two edges. An operation ID is unique across the complete subject. A
producer evaluating the same method on several edges must assign distinct IDs
and keep that assignment stable in its requirements/results/evidence.

The evaluator verifies inventories against the exact artifact occupying each role,
including bundled provenance, and checks completeness of required operations.
Dropping a required node operation to pass a Honeybee-only record is invalid
evaluation. The parser cannot discover omitted inventory requirements or prove
that an asserted artifact/provenance is genuine; runtime admission must bind both
actual endpoints through the existing authenticated handshake on connection,
reconnection and dispatch.

All v1 evidence rules are preserved. Exactly one result is required per operation,
including optional operations. Each result contains command, input and output
checks. Decisive checks require evidence bound to the subject digest, operation
ID and check name. Required incompatibility vetoes compatibility; all required
checks must pass for compatible; otherwise the result is unverified. Optional
failures stay visible without vetoing the aggregate. There must be at least one
required operation. Missing/duplicate/unknown results and mismatched evidence
are refused.

Digests use UTF-8 canonical JSON with recursively sorted object keys, ordered
arrays and no whitespace. The subject includes every role's exact identity,
operations and fingerprints, and evaluator/model/prompt/policy revisions. Changing
either endpoint, its target, or any other subject input invalidates old bindings.
Unchanged fingerprints may permit raw evidence reuse only after the producer
verifies both endpoint contracts and applicable evaluation revisions and emits a
new result bound to the exact new subject. Reusing an old digest is invalid.

Authentication, anti-replay counters, expiry, revocation/withdrawal and verified
offline cache behavior remain with the signed metadata reader. A new wire version
cannot reset those fences. A parser pass or an interval on screen grants no trust,
support, update permission or recovery permission. Unseen offline combinations
remain unverified.

## Evaluation horizon, support and ranges

Matrices and their entries have `schemaVersion: 2`. `currentMajors` remains keyed
by component (`apiary`, `apiaryd`, `honeybee`). Every occupied role must be within
its component's current major, including both apiaryd roles independently. The
apiary horizon remains declared even when no desktop participates. Major zero
includes all 0.x minors for evaluation, without implying compatibility. Historical
major matrices stay separate.

A manifest's exact `components` must match its compatible `pinned` subject. Its
v2 locked Honeybee dependency must match the Honeybee slot, and required Honeybee
protocols/capabilities must be covered by required operations with provider role
`honeybee`. `supported` is an explicit list of additional compatible subject
digests. Matrix evaluation alone does not promise support; unverified or failed
subjects cannot be pinned or supported. Other historical failures remain present.

Supported ranges are a presentation of these **exact supported combinations**,
scoped to the other endpoint artifacts, targets, operations and evaluation policy.
V2 deliberately has no authoritative interval or wildcard field. A reader may
compact a display only while retaining incompatible and unverified gaps and exact
members. It must never authorize an unseen release, another target, a different
caller, or an unsupported compatible subject using interval membership. Checking
installed releases and selecting update targets requires exact current evidence
and explicit support, not a SemVer comparison.

`standalone-manifest.json` illustrates provider 0.1.0 as the passing pin, 0.2.0
incompatible, 0.3.0 unverified, and 0.4.0 explicitly supported. A label covering
0.1.0–0.4.0 must retain those gaps and cannot grant authority to unlisted 0.2.1.
Its two passing endpoints do not repair a required operation failure in the gap.
Apiary owns actual installed-status and range presentation, under these rules.

## Recovery and reader migration

Recovery binds complete role-based `from`/`to` combinations, strategy, storage
requirements and interruption choice. Storage and evidence rules are unchanged:
compatible recovery requires compatible storage, decisive results need bound
evidence, and the target must exactly match the pin or an explicitly supported
compatible matrix combination. Remote transition plans preserve the caller;
local desktop plans may change it when that artifact is actually being updated.
The recovery parser validates bindings; the updater checks the transition against
the actual requester, destination, storage and activation scope. Caller context
alone cannot authorize changing another machine.

API compatibility never replaces recovery admission, existing device permissions,
per-machine automatic-update opt-in, consent or revocation checks. Empty recovery
plans establish no recovery. The accepted HON-14 storage reservation, replay,
bee-survival and Honeybee deployment boundaries remain unchanged.

Migration is explicit and coordinated:

1. Install a reader that supports v2 and retains its authenticated version-specific
   trust/replay/cache state. V1 readers must refuse v2 records, matrices, locks and
   manifests. V1 recovery parsers also reject the new role-shaped combinations.
   A version change is not a reason to discard withdrawal or anti-replay fences.
2. Produce inventories for the real caller/provider artifacts, evaluate all
   required edges and publish v2 metadata through the authenticated channel. V2
   manifests contain v2 locks and matrices; mixing versions is refused. Build
   identities retain their independent existing version and identity JSON has no
   version field.
3. New readers may retain v1 parsers and authenticated installed recovery receipts
   in a separate versioned path for existing installations. Their v1 claims remain
   v1 claims, never converted or relabeled as v2 compatibility. The versioned v2
   parser itself rejects v1 metadata; dispatch must deliberately select a reader.
4. If the installed updater cannot understand v2, an operator-assisted reader or
   bridge upgrade is acceptable. It must preserve actual identity, authentication,
   storage/recovery and permissions; operator action does not manufacture passing
   evidence. Missing verified recovery still defers activation.
5. After upgrade, re-read authenticated v2 metadata, verify exact installed
   endpoints, required evidence and recovery, and select the authorized target.
   Preserve the genuine bundled-worker path throughout. Never strip role fields
   or rewrite `schemaVersion` to obtain a v1 approval.

The portable reader tests verify refusal, separate continued v1 interpretation and
subsequent v2 parsing. Apiary adoption verifies the operator-upgrade workflow,
signed/offline distribution, revoked/replayed metadata, live identity binding and
destination activation. This canonical corpus does not claim those end-to-end
flows have run.

## Conformance

`fixtures/conformance.json` indexes positive and negative parser cases. Run
`tests/release-contract-v2.test.ts` alongside `tests/release-contract.test.ts`
inside the project's audited isolated runner. Portable readers must run both the
indexed corpus and equivalent semantic mutation tests: endpoint changes,
fingerprints/policy changes, cross-edge evidence, operation failures, horizon,
support gaps, recovery, and old/new reader refusal. Desktop attached and absent
standalone scenarios intentionally use the same standalone subject: attachment
has no authority to alter its identity. The genuine bundled caller has a separate
fixture. The corpus and schema ship in the Honeybee package with the parser.
