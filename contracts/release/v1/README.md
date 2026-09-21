# Release and compatibility contract v1

This is the shared wire contract for HON-3 and the agreed HON-1 design. It defines
metadata; it does not implement builds, publication, authentication, evaluation,
installation, or activation. The canonical corpus lives in Honeybee and ships in
its package. Apiary owns the dependency lock and compatibility evaluator.

Consumers use `honeybee/release/v1` or implement the same JSON Schema **and the
semantic rules below**. `schema.json#/$defs/identity`, `dependencyLock`, `record`,
`matrix`, `recoveryPlan`, and `manifest` are the entry points. The corresponding
`parse*` functions accept decoded JSON, reject unknown fields/versions, validate
cross-record relationships, enforce URI syntax (including authorities/ports), and
return independent typed values. Portable validators must enable `format: uri`
assertions, rather than treating format as an annotation. The portable
fixtures are conformance examples. All example.test assets and evidence are
synthetic; none verifies a real release.

## Ownership and distribution

| Producer | Output | Consumers |
| --- | --- | --- |
| Honeybee build/release | Honeybee identity, immutable runtime artifact and checksum; provider inventory | Apiary coordinator/evaluator, installers, running CLI/daemon identity reporting |
| Apiary build/release | Apiary and satellite apiaryd identities, artifacts/checksums; their provider and consumer inventories | Shared evaluator, desktop and node updaters |
| Apiary source repository | Committed `honeybee.lock.json` | Apiary build, nightly coordinator, release manifest producer |
| Apiary compatibility evaluator | Records, matrix, calibrated policy/model/prompt revisions, evidence | Both release gates and all updaters |
| Apiary release coordinator | Common manifest and authenticated versioned matrix updates in `honeybeehq/apiary-releases` | Installers, local/remote update clients, offline verified cache |
| Recovery verifier owned by coordinated updater | Exact transition recovery evidence including storage | Activation gate |

Honeybee remains independently versioned and owns its releases. Satellite apiaryd
is built from the Apiary repository. One manifest describes one exact deployable
combination/target; a multi-platform release supplies a manifest per combination.
A combination contains Apiary, apiaryd, and Honeybee identities; it is the pinned
Apiary/Honeybee pair together with its identified satellite component. Components
can have different targets (desktop versus satellite). No consumer chooses each
component's latest version independently.

The release metadata contract is separate from the existing execution protocol
and apiaryd capability handshake. Inventories should describe those existing
surfaces, including command existence, accepted inputs and returned outputs.
Do not introduce a second runtime handshake. Capability names are owner-defined
nonempty strings; required names such as `spawn.package.skills.v1` remain exact.

## Identities and dependency locks

An identity requires the component name, strict SemVer, full lowercase 40-digit
Git source revision, target, HTTPS artifact URL and `sha256:<64 lowercase hex>`
checksum. URLs must be durable artifact references, not latest-selection APIs;
the checksum is authoritative for bytes even if a host can overwrite a URL.
Consumers download and hash bytes before use. SHA-1 source revisions describe
Git objects; SHA-256 checksums describe artifacts and contracts. Targets use the
producer's canonical platform/architecture identifier (for example darwin-arm64).

`status: locked` records an exact Honeybee identity and nonempty required protocol
list, including capabilities. It is a dependency selection, not proof of
compatibility. A release manifest must carry this lock verbatim and bind it to the
same Honeybee artifact in its components and passing pinned evidence. Apiary
commits the lock before releasing. Several Apiary releases can reuse that exact
Honeybee artifact; Honeybee only publishes a new release when its source changes.

`status: unverified` is the bootstrap/migration form. It has observed legacy source
pins and a reason, with **no fabricated artifact checksum, version identity or
compatibility assertion**. It cannot occur as a release manifest's dependency
lock. The checked-in Apiary lock initially records the installer/vendored-source
mismatch; it does not change either legacy installer at this stage.

## Compatibility records and evidence

Each subject contains the exact three artifacts, required and optional operations,
and evaluation revisions. Each operation binds an ID, provider **and consumer**
component/fingerprint, protocol/version, and capabilities. Fingerprints hash the
relevant command/request/response contract projections; the evaluator must verify
inventory completeness and may not drop a required operation to obtain a pass.
Provider and consumer must differ. Requirements and results have unique operation
IDs with exactly one result per requirement, including optional operations.

Every operation has three checks: `command`, `input`, `output`. A check records its
state, method (`mechanical` or typed `jev`), reason, and evidence references. A
decisive check needs evidence; service errors, unknown commands/shapes, unavailable
judgment or unresolved uncertainty are `unverified`, never a pass. A command can
be conclusively absent (`incompatible`) when mechanically established. The
evaluator policy owns which mechanical/typed judgments suffice and calibrated
thresholds; model confidence alone is not evidence of correctness.

| Required check outcomes | Record state |
| --- | --- |
| At least one conclusively incompatible | incompatible |
| Every command/input/output check compatible | compatible |
| Otherwise | unverified |

At least one required operation is necessary. Optional failures remain visible but
do not veto the result. Missing, duplicate, unknown, or unevidenced decisive
results fail parsing. The aggregate state must match required checks.

`subjectDigest` is SHA-256 over UTF-8 JSON with recursively sorted object keys,
no whitespace, ordered arrays, and JSON string escaping (the exported
`compatibilitySubjectDigest` implementation). The subject includes evaluator Git
revision, exact model revision, prompt checksum and policy checksum. All four
must be captured by the producer, never inferred from a mutable model alias.
Every evidence reference binds this digest plus the specific operation ID and
check name. Changing any artifact, relevant provider/consumer contract, requirement
or evaluation revision invalidates that binding. A recovery evidence reference
binds the recovery subject instead.

Evidence artifacts must contain the corresponding inputs, mechanical results or
typed judgments and provenance. The evaluator/publisher verifies downloaded bytes
against their checksum and their contents against this binding. Parsers check
structural consistency, **not** signatures, byte availability, judgment truth,
contract inventory completeness or trust in the producer. Never authorize
publication solely because arbitrary JSON passes parsing. Authenticated versioned
updates, anti-replay rules and trust anchors belong to HON-6; clients retain only
verified cached results, and unseen combinations stay unverified offline.

Evidence reuse is allowed only after comparing **both** relevant provider and
consumer fingerprints and applicable evaluator/model/prompt/policy revisions.
Reused raw evidence may retain its content-addressed reference, but a new exact
artifact combination needs a newly bound result establishing why reuse is valid;
an old subject digest must not be copied across artifacts.

## Evaluation horizon, support and release gates

A matrix declares the current major separately for Apiary, apiaryd and Honeybee.
Every included entry must be inside that horizon for all three identities. Older
major matrices remain historical documents and are not silently merged into the
current-major matrix. For 0.x, major is 0; this does not imply that minor versions
are compatible. A matrix entry records an evaluation, not a support promise.

A manifest's `pinned` subject must be compatible and match its exact components.
Its required Honeybee protocols/capabilities must be covered by required provider
operations in that subject (capabilities may span several required operations
of the same protocol/version). `supported` names additional subject digests that are
explicit support promises; each must be present and compatible. A pinned failure
or supported regression prevents a publishable manifest. Other historical
incompatible/unverified entries are retained without blocking the release.
Unverified states cannot authorize either gate. `supported: []` is valid and
promises no combinations beyond the pin. The matrix, not a blanket minor-version
rule, determines compatibility. Publication must evaluate the current candidate
and supported combinations with the current trusted policy; parsing is not a
replacement for that gate.

## Recovery metadata and activation boundary

`recovery` contains exact `from`/`to` transition plans, separately from API
compatibility. Each plan binds a strategy (`rollback` or `coordinated_migration`),
explicit storage requirements, and whether interruption is required. Its digest
covers that entire subject. Its result and storage result use the same three
states. A compatible recovery result requires compatible storage and evidence;
all decisive recovery or storage results need bound evidence, even if the other
result remains unverified. The target must equal the manifest's pinned components
or an exact explicitly supported, compatible combination in its matrix. This
includes every component's platform, archive URL and checksum; mixing artifacts
from different approved combinations is not support. A later feed evaluation
alone cannot authorize a recovery target absent from this manifest. An empty
plan list means no recovery has been verified.

A passing API matrix cannot authorize activation without a verified applicable
recovery strategy, actual storage compatibility and checks for the current machine
state. Honeybee v27 versus a v26 rollback binary and credential-authority state
are concrete migration cases; restoring old binaries alone is not proof of
recovery. The updater must preserve accepted writes and active bees, verify current
and incoming Apiary compatibility while staging, then verify health after
activation and recover the previous usable pair on failure. Missing/uncertain
recovery defers automatic activation to coordinated migration. Interruption needs
user choice. Honeybee activation remains exclusively `hive deploy`; this contract
adds no alternate deployment route. Remote automatic updates remain per-machine
opt-in. Implementing these gates belongs to HON-8/HON-9.

## Local deployment admission

The local coordinated updater calls `hive deploy --artifact <archive> --identity
<json> --admission <json> --expected-current <sha|none>`. Honeybee verifies the
complete archive checksum, clean release build facts, protocol/execution digests,
and full packaged tree before publishing through the existing atomic
`runtime/current` owner. Safe extraction rejects escaping paths, unsupported
entry types, dangling links, cycles, and links that escape through other links.
The published immutable version includes an owner-written v2 deployment receipt.
A separate `runtime/runtime-mode.json` configuration keeps the node on v2 even
when a later source deploy has no signed release identity. It grants no
compatibility approval and never substitutes for a legacy `FROZEN` migration.
Optional `--bin-dir` exposes an owner-managed CLI through `runtime/current` only
after successful activation, preserving existing user-managed commands and
symlinks. Retrying an interrupted installation safely completes that exposure.

The daemon exposes `update.reservation.v1` through `update.status`,
`update.reserve`, and `update.release`; `hive update-owner` is their thin CLI.
An exact id/recovery-subject/epoch token reserves the closed
`honeybee-v27-disabled-authority-v1` contract. Its monotonic epoch and active or
released state live in the core SQLite metadata under the serialized writer.
There is no lease timeout: a crashed helper resumes the same token. Release
requires the exact installed and live Honeybee identity. The shared deployment
lock serializes reservation changes with runtime publication.

Every non-disabled credential-authority phase blocks admission. An active token
blocks enrollment before credential-file effects and prevents ordinary deploy,
rollback, and pruning. Artifact replay requires the same complete verified tree
and active token; a previously released token cannot be reused. An absent daemon
permits a labeled read-only admission check only when the database is not locked
by a live owner. It never permits an alternate SQLite writer. Fresh installation
requires an empty node and supports replay of its exact owner-verified artifact.

This fence establishes storage admission, not a compatibility result. The caller
must still supply the exact authenticated compatible rollback plan with the
singleton storage requirement above, verify both component combinations, and
retain recovery archives until live health and receipt persistence succeed.
Restart continues through Honeybee's service owner, preserving surviving runner
hosts, process identities, bee generations, and accepted writes. Automatic
recovery switches verified binaries; it never restores database or credential
snapshots. Legacy binaries without this contract require a deliberate bridge
migration and cannot claim automatic recovery from their version label alone.

## Versioning and bootstrap

Each component versions independently: patch for fixes without API changes, minor
for additions, major for breaking APIs. While 0.x, breaking changes bump minor.
Versions do not stand in for a compatibility result. Contract changes that cannot
be understood by v1 parsers require a new contract version; consumers must not
silently interpret unknown fields or versions as compatible.

Existing `0.0.1` labels are ambiguous because distinct builds reported that same
label (and daemon version text could differ). Never backfill a guessed verified
identity from that label or the currently running source tree.

1. Record observed installer/source/vendor pins as an unverified lock. Keep
   conflicting pins distinct and preserve their source locations.
2. Rebuild or retrieve an immutable artifact from a known full source revision,
   hash its actual bytes, and record the producer's actual version and target.
   Retrieving an old artifact does not prove its compatibility.
3. Produce inventories, evaluate the exact candidate combination and supported
   combinations, and publish authenticated evidence only after every required
   check passes. Select the next version using the API change policy above; no
   bootstrap version bump or known-good artifact is invented by this contract.
4. Replace the migration lock with the exact tested Honeybee identity and required
   protocols. HON-7/HON-8 migrate legacy installer selectors to the manifest/lock;
   source vendoring pins remain source provenance, never runtime compatibility
   evidence. Unknown installed commits remain unverified; an operator recovery
   override is not API evidence.
5. Verify storage/recovery before rollout. Release assets and metadata are durable
   apiary-releases assets, not temporary Actions run artifacts.

## Validation

Run `node --import tsx --test tests/release-contract.test.ts` in Honeybee. The suite
checks all fixture states, malformed identity/hash rejection, exact artifact and
both-side fingerprint fencing, evaluator/model/prompt/policy fencing, missing and
mismatched evidence, pinned/support gates, current-major scope and recovery.
Non-TypeScript consumers must run this corpus and equivalent cross-field tests;
JSON Schema alone cannot express hash equality or reference resolution.

Build provenance and mechanically extracted provider/consumer evidence are described
in [BUILD-EVIDENCE.md](BUILD-EVIDENCE.md). They supplement the verified release
contracts without weakening their artifact or compatibility requirements.
