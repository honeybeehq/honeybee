# External execution subscription claims — phase 3 proposal

Status: Queen approved the revised protocol, teardown, quarantine/release and capture
policy on 2026-10-21. Tormod decision 7a0b4e6b remains open for design acceptance
and the token-lifetime ceiling. He approves the exact egress list before the first
live run. No phase-3 implementation or credential delivery is authorized.
Phases 1–2 remain no-inference and reject nonempty authentication slots.

## Authority and claim

The account's credential authority owns one exclusive claim in its node's SQLite
store. Satellite observations are evidence, never a second claim authority. Add a
separate, default-off workspace capability for external subscription claims; normal
external-exec admission and existing caller/execution authority checks still apply.
An agent selects an allowed account policy, not credential paths or token bytes.

The immutable binding contains claimId, accountId, issuer node/instance epoch,
monotonic claim generation, attemptId, fencingTokenSha256, dispatch digest,
registered bridge/install digest, target node, workspace, and deadline. A unique
active-account constraint excludes another attempt. Identical acquire keys return
the original claim; changing any binding conflicts. Stale epochs/generations cannot
deliver, release, renew, or replace a claim. Reconcile never acquires a new claim.

Claim states are reserved -> delivering -> active -> releasing -> released, with
expired and revoked terminal dispositions. An uncertain delivery or teardown holds
the account unavailable. Claim rows are independent of bee runtime states.

Exclusive means all admissions, not just a second benchmark: account auto-selection,
spawn/swap/fork/handoff, other lease mint/export, login, credential handoff and
maintenance must consult the same authority. Existing active users, outstanding
leases, credential operations or unproven fleet inventory prevent acquire. Drain
existing work first; do not evict it. Partitioned nodes cannot place new work from
cached eligibility. This is a fleet admission change, not a flag on mintLease.

## Access material and deadline

Before reservation, validate provider capability, account ownership/readiness,
clock uncertainty and deadline. Reserve transactionally before obtaining material.
Use the authority's existing secret handling and access-only validation; never
install a guest lease as an ordinary persistent Honeybee account home.

The run authorization expires no later than the attempt deadline. Credential
exclusivity is a separate window: quarantine lasts until the provider token expiry
plus skew, or proven effective revocation. A token may outlive execution; it costs
account availability and never permits concurrent use. Refuse when remaining provider
validity exceeds the ceiling Tormod approves (12 hours is a proposal), expiry cannot
be verified, or validity is insufficient for the run and teardown. Inspect expiry
with a read-only probe; do not deliver credentials to a guest for this check. A local
TTL does not shorten a JWT; do not assume provider revocation or add a proxy.
No in-guest refresh grant, refresh endpoint, renewal or retry with fresh material.
Refresh needed before reservation must finish before exclusive claim activation.

While reserved/delivering/active/releasing, suppress refresh no-op turns and prevent
new credential mutation. An operation already in flight blocks acquire. Check under
the same admission serialization boundary, not only in a background scheduler.

## Protected delivery

Use an authenticated, target-bound, one-use channel between the credential authority
and the registered host bridge. Bind its redemption to the complete claim plus
attempt/fence/install. An opaque handle in dispatch is not sufficient authority by
itself. Keep credential bytes out of RPC idempotency storage, audit, argv, env,
dispatch manifests, receipts, stdout/stderr and diagnostics. Never emit token hashes.

The bridge validates the claim before guest start and writes native authentication
only into guest memory/tmpfs, with mode 0600 and a volatile native home. No swap,
hibernation, credential-bearing snapshots, core dumps or artifact capture of that
mount. On uncertainty after redemption, reconcile the same guest/claim; do not
redeliver into a new guest. The host retains no persistent token copy.

While the credential is mounted, guest egress is deny-by-default and permits only
the provider API endpoints required for inference. No other network egress is
allowed. Pin the enforcement mechanism, DNS handling, endpoint/redirect behavior and
allowed destinations in the reviewed policy. In-guest models are untrusted. This
allowlist is the principal exfiltration control and must be enforced outside the
guest. Tormod approves the exact endpoint list before live delivery.

Tormod accepts the JWT's visible email claim. Do not strip or proxy it. That exception
does not authorize logging credentials or other identity/context leakage. Before
releasing any artifact or raw stream into the evidence path, the bridge scans its
bytes for exact token substrings and for the refresh-free JWT signature segment
while holding the token in protected memory. Scan across chunk boundaries, include
all artifact/diagnostic/native stream paths, and fail closed on unreadable or
unscanned data. A hit seals the artifact unchanged in a private quarantine outside
the evidence path, records only "credential echo detected", and flags human review.
Raw evidence is never rewritten or published on a hit. Keep staging private until
scanning finishes; teardown must not discard the in-memory scan material before
capture is checked. The scan supplements egress enforcement; it does not detect all
encodings or transformations. No credential or signature bytes enter audit/receipts.

## Release, restart and expiry

Terminal bridge processing first disables guest execution/network and destroys the
volatile authentication mount, then sends a claim-bound teardown receipt to the
issuer. Release is an idempotent compare-and-set for that claim epoch/generation;
late release cannot free a successor. Capture failure does not justify leaving
credentials usable; preserve safe partial artifacts and record capture failure.

If terminal delivery is lost, the fleet reconciler queries the exact attempt's
bridge owner and observes verified guest death/credential teardown. Bridge process
exit or transport silence alone is insufficient. The claim remains excluded while
evidence is unknown. An issuer restart resumes the same claim and expiry, without
minting another token or resetting the deadline.

Expiry/revocation stops the attempt and invalidates redemption. Re-admission requires
both proof no guest can continue using the credential and provider token expiry
(with skew margin), unless provider revocation has separately proven effectiveness.
Use fail-closed quarantine when either fact is unknown. Local expiry is not proof of
provider-side revocation. Terminal release ends exclusivity only after the reviewed
teardown/expiry policy is satisfied.

## Storage, wire and verification

Add versioned claim tables, active-account uniqueness, secret-free audit/replay and
snapshot/delta projections. Expose safe claim status, deadline and refusal reasons;
exclude handles, token bytes and fencing capabilities from mirrors. Negotiate new
claim acquire/redeem/reconcile/release capabilities; old peers refuse rather than
falling back to account.lease.v1. Extend admission operation vocabulary explicitly.

Current anchors: v2/daemon/src/daemon.ts:6538 (mint RPC),
v2/daemon/src/accountsService.ts:3654 (mintLease), :3640 (refreshBusy),
v2/daemon/src/rpc.ts:110 (lease ingress boundaries),
v2/core/src/accountLease.ts:16 (lease provenance),
v2/core/src/executionStart.ts:55 (fenced start),
v2/core/src/schema.ts:162 and v2/core/src/mirror.ts:97 (storage/mirror).

Before any live delivery, test simultaneous fleet acquisitions, ordinary admission
exclusion, stale release, lost delivery/release, issuer/bridge restart, split brain,
refresh races, expiry/skew and tmpfs teardown with synthetic secrets. A separate
explicit approval permits a live token probe only after the design is accepted.

## Decisions required

1. Tormod: accept the design, the maximum remaining provider-token lifetime
   (proposed 12 hours), and the exact provider egress endpoint list.
2. Queen: approve the revised protected redemption protocol, teardown attestation,
   account quarantine/release semantics and artifact capture/quarantine policy.
3. Honeybee implementer: establish the account authority's complete consumer
   inventory and exclusion of ordinary users/previous leases; unknown consumers
   prevent exclusivity. Demonstrate protocol and fault cases with synthetic data.
4. Vendor capability/expiry: obtain facts from a read-only expiry probe of existing
   access material, reporting only lifetime/capability facts, never token contents.
   This is not a live guest delivery and does not authorize inference.

Queen review and Tormod acceptance are required before phase-3 code or credentials.
