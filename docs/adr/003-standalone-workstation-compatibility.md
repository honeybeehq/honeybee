---
status: accepted
---

# Preserve standalone workstation compatibility

On 2026-09-21, the operator confirmed the shared understanding for
[HON-15](https://linear.app/honeybee-hq/issue/HON-15): preserve standalone
workstation services and extend the release evidence contract with a new version.
Evidence must identify the actual calling and receiving software separately,
including when both are apiaryd. Desktop attachment does not transfer desktop
release identity to a separately installed service.

This is an accepted design decision, not a claim that the successor contract is
implemented or that any release or installation has passed its checks. The v1
wire contract and parser remain unchanged by this documentation change.

## Reason and alternative

Apiary documents separately installed workstation services, and its desktop
connects to an existing service before starting its bundled worker. V1 instead
has one apiaryd artifact slot and forbids operations whose consumer and provider
have the same component name. It cannot represent the two actual daemon builds.
Removing that rejection alone would still leave the identity ambiguity.

Requiring the desktop-owned bundled worker was considered and rejected. It would
narrow an existing supported topology and require installation migration. A new
evidence version costs coordinated producer and reader changes, but preserves the
product direction and gives each participating service its real release identity.
The bundled worker's genuine desktop-build provenance remains supported.

## Confirmed behavior

- Devices may run different apiaryd releases and targets when the matrix provides
  passing evidence for the actual installed combination. A version-number rule is
  not compatibility evidence.
- Check the existing installed releases and report their compatibility and support
  status, together with the supported range for the relevant combination and
  targets. Report incompatible releases and unverified gaps honestly; a compact
  interval must not hide either or imply support for unseen releases. Retain the
  existing distinction between an evaluation and an explicit support promise.
- A standalone workstation service can initiate remote updates while the desktop
  is closed, using its own verified identity. Existing device permissions,
  per-machine automatic-update opt-in, and recovery checks continue to apply.
- Old readers refuse unsupported evidence versions. A one-time operator-assisted
  upgrade is acceptable when the installed updater cannot understand the new
  contract. The migration path must be documented and verified; it is not an
  exception to compatibility or recovery requirements.

Background automatic updates were already an agreed HON-1 requirement. HON-9
contains daemon-owned initiation machinery, but its desktop-identity admission
check blocks standalone initiation. This decision resolves that gap; it does not
establish that the pre-HON-9 implementation already supported this behavior.

## Implementation implications

1. Honeybee owns the new canonical contract version, parser, schema, types and
   conformance fixtures. Represent caller and provider roles with independently
   bound exact artifacts, fingerprints and targets, even when their component
   names match. Preserve evidence invalidation when either endpoint changes.
2. Apiary updates its canonical dependency copy, inventory bindings, evaluator,
   matrix and supported-combination selection coherently. Evidence must cover
   required daemon-to-daemon operations and the applicable Honeybee operations;
   evidence for one edge cannot authorize another. Preserve the existing
   current-major evaluation horizon and explicit unknown-coverage handling.
3. Release producers, signed metadata distribution, offline caches and readers
   must agree on the new version. Preserve authentication, anti-replay and
   revocation behavior. Evidence reuse requires the existing contract checks and
   a result bound to the exact new combination; a displayed interval grants no
   additional authority.
4. Runtime checks bind the actual installed caller and provider to matrix results
   on connection, reconnection and dispatch through the existing handshake.
   Standalone update initiation must select an authorized target without requiring
   or fabricating a desktop identity. Keep consent and activation with their
   existing owners, including Honeybee activation through `hive deploy`.
5. Document the producer/reader transition and the operator-assisted upgrade path
   for old readers. Preserve bundled-worker operation throughout migration. Do not
   recast unsupported v2 evidence as a v1 approval.

The successor implementation must verify these cases with isolated fixtures:

- Bundled worker to remote daemon, and standalone daemon to remote daemon with
  the desktop both attached and absent.
- Different exact daemon builds and targets; changed caller, changed provider,
  ambiguous identities and forged desktop attribution.
- Installed compatible/supported, incompatible and unverified combinations;
  displayed supported ranges with gaps and required-operation failures.
- Explicit and automatic update requests, per-machine opt-in and refusal,
  reconnect/replay, signed/offline metadata, revocation and recovery admission.
- Old-reader rejection, operator-assisted upgrade and subsequent new-reader
  operation without a compatibility bypass.

## Verified source evidence

The read-only investigation used Apiary HON-9 source and Honeybee integration
`codex/jev-compatability-ci`. Relevant Apiary paths are:

- `docs/design/local-organizations/workstation-pairing.md`: separately installed
  workstation service contract.
- `apps/desktop/src/main/apiarydHost.ts`: connect before spawn.
- `scripts/release-runtime-build.mjs` and `services/apiaryd/src/buildIdentity.ts`:
  standalone daemon identity; no embedded desktop identity.
- `apps/desktop/electron.vite.config.ts`: bundled worker receives actual desktop
  and daemon build identities.
- `services/apiaryd/src/nodes/compatibility.ts`: standalone resolver selection,
  remote operation admission and desktop-only update initiation gate.
- `services/apiaryd/src/nodes/automaticUpdate.ts`: background requester and
  opt-in rechecks.

Canonical Honeybee evidence is in [the v1 contract](../../contracts/release/v1/README.md)
and [its parser](../../src/release/index.ts). Inspection established the contract
gap; it was not a live runtime or end-to-end update test.

## Delivery boundary

The parent HON-1 task coordinates implementation ownership and dependency removal.
HON-15 resolves the human decision; HON-9 completion and HON-11 acceptance still
require the resulting implementation and verification. Work remains on local
feature branches. This decision authorizes no push, CI dispatch, publication,
deployment, runtime activation, remote-node operation, notification or live Jev
evaluation. The resolved HON-14 recovery decision is unchanged.
