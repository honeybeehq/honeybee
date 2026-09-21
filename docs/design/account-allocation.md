# Automatic account allocation

Honeybee admits new automatic work through one allocator owner per provider
scope. The owner is the daemon whose SQLite store contains the scope's
`account_admission_reservations`. Every automatic request for a scope must be
routed to that same daemon. Every daemon has its own `allocationNodeId` and
the same fenced `allocationOwner {node,epoch}`; only the node whose identity
matches the owner may acquire. Apiary must not route around an unavailable
owner.

The rollout defaults to observation-only:

```json
{
  "accounts": {
    "allocationMode": "shadow",
    "allocationNodeId": "metal1",
    "allocationOwner": { "node": "metal1", "epoch": "owner-2026-09-21" },
    "allocationQuotaFreshMs": 120000,
    "allocationActivityFreshMs": 120000,
    "allocationRecentGraceMs": 900000,
    "allocationReservationTtlMs": 900000,
    "allocationPlanCapacityUnits": { "pro": 1, "max_5x": 5 }
  }
}
```

Shadow mode records the new decision in the RPC receipt and log while the
legacy selector remains authoritative. Active mode removes legacy scoring,
near-tie rotation, capped elapsed credit, static busy penalties, and penalty
hints from automatic admission. Explicit account choices are unchanged.
Existing bee identities may stop and resume without admission.

Before activating the policy, set `allocationMode:"active"`, give each daemon
its exact Apiary routing identity in `allocationNodeId`, and install the same
`allocationOwner` tuple everywhere. This version deliberately has no
automatic owner failover: changing owner or epoch requires fencing the old
daemon and carrying its ledger forward before Apiary changes configuration or
route.

## Shared-owner RPC contract

Capability `account.allocation.owner.v1` exposes a three-step claim saga. For
every account scope, Apiary MUST route every acquire to the one configured
authority daemon and MUST NOT fail over to another daemon until it has fenced
the old owner and transferred its durable ledger. Two SQLite ledgers for one
scope are not a shared authority.

1. Call `account.admission.acquire` on that owner with one stable
   `idempotencyKey`, the operation, model, exclusions, target identity and a
   fresh complete fleet context excluding only that owner's local node. The
   effective model must be supplied when provider grants or quota are model
   scoped. The owner selects and inserts the claim in
   one SQLite transaction. Concurrent callers therefore see earlier holds.
2. Send the returned claim unchanged to the target mutation as
   `allocationClaim` with `account:"auto"`. Supported consumers are `spawn`,
   `bee.swapAccount`, `bee.fork`, `bee.handoff`, and thread fork/handoff. The
   target imports the globally unique claim id and binds it atomically with
   its mutation. Claim-bearing target calls require an idempotency key. A
   retry under another RPC key cannot bind that claim to another bee.
3. On committed target success, call `account.admission.confirm` on the owner.
   On a definitive pre-commit refusal, call `account.admission.release`. If
   the target outcome is unknown, retry the target mutation with the same key;
   never release on uncertainty. Confirm/release use their own stable keys.

Derive distinct keys from the Apiary operation key, for example `K/acquire`,
`K/apply`, `K/confirm`, and `K/release`. This is required when owner and target
are the same daemon because Honeybee's idempotency namespace is node-wide.
Retry `account_wait` on acquire with the unchanged `K/acquire`; refusals do not
consume the key.

Active-mode automatic mutations without an owner claim return `account_wait`
with reason `allocation_owner_required`. This is the enforcement that prevents
node-local ledgers from racing. In default shadow mode, acquire returns
`authoritative:false`, `claim:null`, and a decision receipt; existing legacy
placement remains authoritative.

Acquire request (swap example):

```json
{
  "harness": "claude",
  "operation": "swap",
  "target": { "node": "metal1", "workId": "bee-uuid", "expectedGeneration": 7 },
  "sourceAccount": "claude-old",
  "excludeAccountIds": ["claude-old"],
  "model": "claude-opus-4-1",
  "allocationContext": { "version": 1, "scope": "claude:provider-accounts", "revision": "fleet-r42", "observedAt": 1790000000000, "complete": true, "accounts": [] },
  "idempotencyKey": "apiary-operation-key:acquire"
}
```

Successful active response:

```json
{
  "authoritative": true,
  "claim": {
    "version": 1,
    "id": "claim-uuid",
    "scope": "claude:provider-accounts",
    "account": "claude-new",
    "operation": "swap",
    "units": 1,
    "model": "claude-opus-4-1",
    "sourceAccount": "claude-old",
    "createdAt": 1790000000000,
    "expiresAt": 1790000900000,
    "authority": { "node": "metal1", "epoch": "owner-2026-09-21" },
    "target": { "node": "metal1", "workId": "bee-uuid", "expectedGeneration": 7 },
    "allocation": { "version": 1, "mode": "active", "outcome": "selected", "account": "claude-new" }
  },
  "allocation": { "version": 1, "mode": "active", "outcome": "selected", "account": "claude-new" }
}
```

The target call is
`bee.swapAccount {beeId, account:"auto", allocationClaim, idempotencyKey}`.
The consumer refuses the claim unless its authority tuple exactly matches the
configured owner and `claim.target.node` exactly matches that daemon's
configured `allocationNodeId`; owner-epoch changes fence old claims.
Then confirm with
`account.admission.confirm {claimId,target:{node,workId},idempotencyKey}`.
Release is
`account.admission.release {claimId,reason,idempotencyKey}` and is refused
after confirmation or after the claim was applied on the owner node. For
spawn/fork the caller must choose a path-safe target bee id before acquire and
pass it as `id`/`successorBeeId` to the target mutation.

## Authoritative node activity

Capability `account.allocation.activity.v1` exposes the read-only
`account.activity {harness}` RPC. Apiary calls it on every non-owner node; it
must not infer pending work from the fleet snapshot. Honeybee derives these
facts from its authoritative runtimes, queued start/revive/send-wake commands,
undelivered mail, recent-work grace, generation/account transfers, and bound
admission claims.

```json
{
  "version": 1,
  "node": "netcup",
  "authority": { "node": "metal1", "epoch": "owner-2026-09-21" },
  "scope": "claude:provider-accounts",
  "revision": "netcup:48291",
  "observedAt": 1790000000000,
  "freshUntil": 1790000120000,
  "accounts": [{
    "account": "claude-example",
    "active": 1,
    "recent": 0,
    "pending": 1,
    "ongoingUnits": 3.25,
    "observedClaimIds": ["claim-uuid"]
  }]
}
```

Apiary validates the expected node, scope, owner tuple, and `freshUntil` on
every response. It sums account facts, unions claim IDs, sets the aggregate
`observedAt` to the oldest component observation, and derives one bounded
revision digest from the ordered component revisions. It sets `complete:true`
only after receiving every configured non-owner node. The acquire context is:

```json
{
  "version": 1,
  "authority": { "node": "metal1", "epoch": "owner-2026-09-21" },
  "scope": "claude:provider-accounts",
  "revision": "apiary-fleet-revision",
  "observedAt": 1790000000000,
  "complete": true,
  "accounts": [
    {
      "account": "claude-example",
      "active": 1,
      "recent": 0,
      "pending": 1,
      "ongoingUnits": 3.25,
      "observedClaimIds": ["claim-uuid"]
    }
  ]
}
```

The context covers every node except the allocator owner's local node; the
owner adds its authoritative store facts. `complete:true` with an empty array
is a positive observation that no other node has activity. Missing, stale,
malformed, wrong-scope, or incomplete context is uncertainty, never zero.
`revision` is an opaque, bounded fleet snapshot identity used in receipts.
The `active`, `recent`, and `pending` categories are disjoint; a booting or
running generation is active rather than also pending.

Apiary routing is therefore: build one complete non-owner fleet snapshot;
acquire on the configured authority; apply on `target.node`; confirm back on
the same authority. A timeout never changes any of those routes or keys. If
the authority is unavailable, queue the work instead of asking the target or
another daemon to allocate.

`observedClaimIds` closes the saga accounting seam. Until a fresh remote fact
lists a claim id, the owner hold counts. Once listed, the owner omits that hold
because the same fact's pending/active/ongoing totals now represent it. This
prevents both an under-counting gap and permanent double counting. A confirmed
claim cannot be released merely because its confirmation arrived; it remains a
hold until observed, reconciled locally, or expired.

Apiary must not copy every historical `snapshot.accountAdmissions[].id` into
`observedClaimIds`. Start with rows whose `beeId` is non-null, `releasedAt` is
null, and `expiresAt` is in the future. Include a claim consumed on that remote
node only while the same account fact still represents it as a start
hold, pending work, active work, or recent work. Omit it once none of those
categories represents the claim; the owner then conservatively counts its hold
until the matching 15-minute reservation TTL expires. The default recent grace
and claim TTL intentionally match.

Successful automatic RPCs include `allocation`: a bounded, secret-free v1
decision receipt. Active-mode refusal is:

```json
{
  "code": "account_wait",
  "message": "Automatic account allocation is waiting: completion_reserve",
  "details": { "allocation": { "version": 1, "outcome": "wait" } }
}
```

Wait reasons are `allocation_owner_required`, `no_eligible_account`,
`activity_unknown`, `quota_uncertain`, and `completion_reserve`. The caller queues/retries at the
receipt's `retryAt` or after a newer quota/activity revision. There is no
least-bad fallback.

## Policy

Eligibility includes harness/provider, model-scoped grants, verified auth,
pause state, and recent exhaustion. Quota must be freshly observed and its
reset must still be in the future. Applicable windows project measured or
active-session burn plus every unreconciled start hold. New work is excluded
if the projection reaches 90%, or if current use is already at least 90% and
there is active, recently active, pending, or reserved work. The last 10% is
therefore reserved for already-bound continuations.

Forks, children, swaps, thread successors, and same-harness handoffs whose
account field is omitted are all new automatic work. Omission is not an
explicit account choice. Existing bee stop/revive and session continuation do
not acquire a claim.

For each account, fair-share rate is its usable weekly allowance below 90%
divided by time remaining, with a six-hour near-reset floor. Configured plan
capacity units make rates comparable across plans. The smallest virtual
finish wins, so sustained starts converge to those rates without starving a
lower-rate eligible account. Active session age is uncapped; idle/stopped
activity decays completely after the configurable 15-minute grace.

Reservations are schema-v28 replay state. A request key can create one hold.
The hold counts until release/expiry or until a runtime generation above its
fence exists; the actual runtime then replaces the hold in activity totals.
Transfers retain their source account so evidence from an old generation
cannot be charged to the target account after a rebind.
