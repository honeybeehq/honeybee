# Honeybee release producer (HON-5)

Honeybee owns its versions, checked runtime builds and independent publication.
Apiary owns the single compatibility evaluator and release coordinator. These
workflows never deploy a daemon or activate an installed runtime; activation and
rollback remain `hive deploy` operations.

The user-facing [Apiary–Honeybee compatibility matrix](./compatibility.md)
explains exact release combinations and recommended pins. Apiary publication
links each release's generated report and matrix snapshot from its release notes.
Current support follows that manifest's authenticated feed, as explained in
[Finding current support](./compatibility.md#finding-current-support).
See [Maintaining the matrix](./compatibility.md#maintaining-the-matrix) for report
generation and publication.

## Invocation and trust boundary

External coordinators use `workflow_dispatch` on `honeybeehq/honeybee`'s
`.github/workflows/release.yml`, selecting an exact reviewed workflow ref.
`workflow_call` is supported only for wrappers in that same repository. Actions
concurrency is repository-scoped, so cross-repository calls and local production
adapter execution are explicitly rejected. Inputs are:

- `source-revision`: the full Honeybee commit to freeze and build.
- `api-assessment`: the JSON result of the canonical Apiary
  `packages/release-evaluator/src/classification.ts::classifyApiChange`. It binds
  before/after identities, verified candidate probes, inventory fingerprints,
  evaluator/model/prompt/policy revisions, classification, bump and digest.
  `null` is permitted only when the product-source reservation already exists.
- `target`: `darwin-arm64` or `linux-x64`; both archives are packaged on `ubuntu-24.04`.

The macOS archive uses the locked `node-pty` package's shipped ARM64 prebuilds.
Packaging verifies their Mach-O architecture and file type, restores the helper's
execute permission, removes the build host's PTY output, and records the requested
target in the archive identity before hashing. Honeybee no longer compiles a native
macOS process-census helper. Build and test gates run on Linux; macOS-only runtime
checks (such as Seatbelt) still require a Mac and are not proven by the Linux gate.
Linux runtime dependencies are built natively; macOS runtime dependencies use the
verified prebuilds described above.

The protected `honeybee-release` environment and its authorized coordinator or
human caller are the assessment trust boundary. **An assessment's self-digest is
integrity evidence, not authentication or approval.** Before permitting invocation,
the caller must verify that the input came from the canonical evaluator at the
claimed revision, with its actual checked candidates/probes and approved evaluation
policy. Never manufacture a passing assessment from an unverified result. Configure
protected environment reviewers, authorized source/workflow refs and secret access
before enabling production publication. The release producer validates the bound
facts; it does not implement another evaluator or infer compatibility.

Policy is patch for `compatible-fix`, minor for `additive-api`, major for
`breaking-api` (minor before 1.0), and no allocation for `unverified`. Assessment
`after.sourceRevision` must equal the requested revision. Subsequent assessments
must use the latest reserved release commit/version as their `before` baseline.
The first allocation requires an exact evaluated stable-version baseline that is
an ancestor of the requested source and agrees with its committed package version;
there is no guessed bootstrap bump or backfilled historical identity.

Required credentials: `HONEYBEE_RELEASE_TOKEN` with Honeybee contents read/write;
`DISTRIBUTION_TOKEN` with apiary-releases contents read/write and Administration
read for immutable-release-setting verification; optional
`EVALUATOR_NOTIFICATION_TOKEN` with Apiary repository-dispatch permission. Missing
notification credentials produce a pending notification, not a failed publication.

These are production prerequisites, not evidence that secrets, Actions, evaluator
calibration or repository protections have been verified. Operational checks remain
on HON-1's final feature merge/rollout checklist. Current unknown production routing
and calibration evidence remain unknown.

## Allocation and checked source

`src/release/prepare.ts` writes Git objects through a private index without changing
the caller's checkout. It normalizes only the root version fields in package.json
and package-lock.json, and omits only `.release/release.json` and
`.release/api-assessment.json` when hashing product source. Every other tracked
file/mode/object participates conservatively, including dependency changes.

An atomic Git push reserves all three refs together:

- `refs/heads/honeybee-release-ledger`: latest reservation, updated with an exact
  compare-and-swap lease;
- `refs/tags/honeybee-v<version>`: the prepared release commit, never force-pushed;
- `refs/tags/honeybee-source-<product digest>`: the unchanged-source reuse key.

The release commit contains the requested tree, versioned package/lock and retained
assessment metadata; it parents the requested revision and previous reservation.
Concurrent identical requests return the winner. A different source that loses the
allocation race must be reassessed against the winner. Abandoned/failed reservations
may leave version gaps; they are never reassigned to different source. GitHub
workflow concurrency additionally serializes expensive builds and distribution
writes. Git CAS protects version allocation even outside Actions.

The existing `buildDeployArtifact` exports this commit with `git archive`, installs
locked dependencies, runs root check/build/tests and all v2 typechecks and unit
batteries, then stages the npm package with production dependencies. Release mode
rejects `skipTests` and does not select gates based on the local store's FROZEN
marker. Real credential-dependent harness smokes are not this CI gate. Failures
stop publication, including pre-existing failures; local baseline classification
never waives a production check. CLI, daemon and artifact use the same embedded
build identity, prepared package version and exact source tag. The inventory is
extracted from that checked checkout and its provider fingerprint must agree with
the canonical assessment. Extraction gaps are preserved.

## Immutable distribution and retry

Durable assets live in `honeybeehq/apiary-releases`, under a distinct release tag
`honeybee-v<version>-<target>`. The Honeybee source tag points to the exact source;
the distribution repository's tag is only the asset namespace. Consumers use the
descriptor's sourceRevision, never the distribution tag's Git commit.

Each release contains:

- `honeybee-runtime-<release commit>.tar.gz`, including manifest.json and the
  unchanged inventory as release-inventory.json;
- `manifest.json`, `inventory.json` and `SHA256SUMS`;
- `release.json`, the final exact-reference descriptor.

The first checked tarball is the durable build receipt. After interruption, retries
read that original tarball and reconstruct the sidecars without rebuilding different
compressed bytes. Every sidecar upload is create-only and checked by rereading its
bytes. Conflicts stop publication. All assets are verified before the draft becomes
visible, and GitHub must confirm immutable publication. Enable the destination's
[immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
setting beforehand; the producer only checks it, never changes repository policy.

The GitHub adapter requires the workflow's single distribution writer. GitHub has
no conditional asset-delete primitive. Under that ownership fence it rereads the
release and asset metadata, and removes only an empty `starter` placeholder from a
still-draft release. These can remain after a failed upload (see [GitHub upload
semantics](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)).
Uploaded bytes, nonempty placeholders and published releases are never deleted or
replaced. All independent callers must dispatch the workflow in the owning Honeybee
repository so they share its concurrency group; do not run concurrent production
adapters outside it. Same-repository wrappers must preserve this ownership fence.

## Caller and shared-manifest contract

`src/release/publish.ts::HoneybeeReleaseDescriptor` is the `release.json` shape:

```ts
{
  schemaVersion: 1,
  identity: ComponentIdentity, // canonical honeybee/release/v1 identity
  requestedSourceRevision: string,
  productSourceSha256: string,
  assessmentSha256: string, // canonical assessment digest retained in source commit
  inventory: { url: string, sha256: string },
  manifest: { url: string, sha256: string },
  checksums: { url: string, sha256: string }
}
```

The canonical identity carries `component: "honeybee"`, exact version,
`sourceRevision` of the prepared commit, target, and artifact URL/checksum. All
checksums use `sha256:<64 hex>`. Inventory SHA256 covers the exact published bytes;
it is distinct from the inventory's semantic fingerprints. HON-6 consumes identity
and verified bytes unchanged, with no independent latest selection. Workflow outputs
are `descriptor-url`, `descriptor-sha256`, `version`, `source-revision` and
`notification` (`sent` or `pending`).

After publication, notify `honeybeehq/apiary` through `repository_dispatch`:

```json
{
  "event_type": "honeybee-release-published-v1",
  "client_payload": {
    "schemaVersion": 1,
    "eventKey": "sha256:<release.json byte digest>",
    "descriptor": { "url": "<immutable release.json URL>", "sha256": "sha256:<digest>" }
  }
}
```

`release.json` is the durable outbox item. Dispatch failure returns `pending`; rerun
the exact request to resend the same event without changing assets. `sent` means
GitHub accepted dispatch, not that evaluation passed or completed. HON-7 owns the
receiver: deduplicate eventKey, authenticate and hash-check the descriptor, then
queue the single shared evaluator to refresh supported Apiary combinations. This
task adds the producer contract only; receiver rollout is a final integration check.
Compatibility failure can block Apiary publication but does not retract Honeybee.

## Local validation

Use Node 24.15.0. `npm run check`, `npm run v2:check`, `npm run build`, and `npm test`
cover compilation and the root suite; v2 batteries have their existing npm scripts.
Focused allocation/publication/HTTP tests are:

```
node --import tsx --test tests/release-pipeline.test.ts tests/release-publication.test.ts tests/release-github.test.ts
```

They use isolated bare Git remotes, generated tarballs and an HTTP boundary fake;
no published releases, credentials, installed runtime or external evaluation are
used. There is no repository lint script. Review workflow YAML with actionlint.

### Rollback and store schemas

`hive deploy --list --json` identifies an Apiary content-addressed `current`
installation from its `dist/build-identity.json`. `hive deploy --rollback`
selects the newest distinct history entry whose installed CLI still exists and
prints the exact from/to revisions. Missing identity or installed history has a
typed refusal. Deploy and explicit rollback preserve a departing external native
build under `runtime/<revision>` and record its actual dist hash and adoption
provenance in history, so a later rollback can return to it. Conflicting installed
bytes, escaping symlinks or a non-native prior build refuse before activation.
Failed activation restores the original link text, service file and Node pin,
then verifies the old daemon's identity, new PID and RPC readiness.

Rollback checks the target bundle's schema capability against the live owner's
schema (or read-only offline store). Unknown capability refuses. A newer store
or schema 29 returns `ROLLBACK_STORE_RESTORE_REQUIRED`; stop and restore the
matching pre-deploy backup using `hive v2 store restore --from <absolute
receipt.json> --data-dir <dir>` before retrying. Restore discards subsequent
writes; rollback never restores a store automatically. If a candidate migrates
and then fails, recovery restores the service and Node-pin snapshots but leaves
`current` on the stopped candidate, refusing to start the incompatible old binary.
The typed error retains the boot failure as its cause. Same-revision recovery
checks displaced old bytes before swapping them back, and retains them on refusal. A compatible backup may
not exist for an arbitrary historical target; select a compatible runtime then.

Linux fixture: after `npm run build`, run
`node scripts/gates/rollback-lab.mjs`. CLI transcripts, daemon logs and receipts
are saved under `.audit/t4/rollback-lab`. It uses a fixture systemctl process
adapter, real bundled daemon processes and production restart ownership. The
artifact scenario uses a synthetic schema-27 build with an executable standalone
v2 CLI entry to satisfy the current admission contract. Shipped bundles export
that CLI without invoking it; admission also rejects a Node-pin migration before
the restart owner. Those admission issues belong to T7. This lab does not prove
current-schema updater admission; the source scenario proves Node-pin recovery. The
schema refusal scenario migrates a real fixture store from 48 to synthetic 49.
Apiary's updater `start()` catch path and satellite bundler still need their own
Apiary-side failure lab; this fixture does not exercise them. Returning to retained
bytes points current at runtime/<revision>, so Apiary must reconcile its raw-link
CAS after a Honeybee rollback. Manual rollback must retain T3 desired-build pin
checks and explicit override receipts when these branches are combined. There is
no crash journal to resume recovery after a process crash midway through it.
### Store backups and offline restore

Source and artifact deploys (including rollback) require a durable store backup
receipt before changing the selected runtime. The live store owner takes a
`VACUUM INTO` snapshot; an offline owner takes the same snapshot under SQLite's
exclusive lock. An older daemon without the backup RPC must be stopped before
upgrading through this boundary. A first install without a store records a
store-absence receipt instead. Independently, opening an older schema backs it up
before any schema DDL. Backup or receipt failure refuses migration/deployment.

Backups and manifests live next to the store in `core.sqlite3.backups/`, with
private permissions, checksums, schema/DDL identity, integrity result, source build
and time. Retention keeps ten recent snapshots plus the newest for every schema.
Legacy stores without recorded build provenance say so explicitly in migration
receipts; deploy receipts use the running or previously installed build identity.

After stopping the daemon, restore with
`hive v2 store restore --from /absolute/path/to/receipt.json --data-dir /path/to/v2`.
This refuses an active owner, verifies the receipt/checksum/schema/integrity,
preserves the current database as `core.sqlite3.before-restore-<uuid>` with its
WAL/SHM, and restores the snapshot. **Writes made after the backup are discarded.**
Select the matching old runtime only after restoring its schema. Restore is an
explicit operator action; deployment recovery does not silently discard writes.

A Linux fixture proof (after building) is
`node v2/cli/tests/store-backup-smoke.mjs`: it creates a real schema44 store using
archived old source, migrates with the candidate binary, restores through the CLI,
and reopens with the old core to compare logical rows. It starts and stops only
its own fixture daemon by PID, and retains its receipt and daemon log under `/tmp`.
