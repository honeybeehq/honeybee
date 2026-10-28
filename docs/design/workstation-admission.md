# Workstation admission with local fallback

Honeybee refuses new automatic workstation admission only when registered local
Apiary confirms a suitable satellite for that request. No Apiary, no subscription,
no eligible satellite, expired trust, timeout or unusable answer admits locally.
The typed result contains the canonical T39c notice:

```json
{"notice":{"code":"no_satellite_available","message":"No satellite available; running on this computer"},"admissionDiagnostic":{"reason":"no_subscription"}}
```

The CLI prints the notice once on stderr, including in JSON mode. JSON stdout
stays structured. The separate diagnostic has a closed reason vocabulary:
`no_candidate`, `no_subscription`, `registration_expired`, `timeout`,
`digest_mismatch`, `malformed`, `criteria_unsupported`, `queue_full`.

Apiary is the sole eligibility resolver. Honeybee forwards the exact request fields
agent/harness/account/requiredCapability/parentNodeId/branch/sha/groupId/key/beeId
as present, without filling defaults or interpreting capability names. No argv,
environment, prompt or credentials enter this query. Canonical serialization binds
identity only. Apiary applies its own group and account rules; no second roster,
OS, model or source-readiness claim is made in Honeybee.

## Authenticated inbound query protocol

The additive capability is `workstation.eligibility.v1`. Register through the existing
LocalRpcTrust challenge/HMAC path. The registration response additionally includes
`daemonInstanceId` and `registrationEpoch`. Trust must be enabled; its `require()`
no-op when disabled cannot authenticate this protocol.

The registered Apiary connection long-polls `admission.eligibility.subscribe` with
`{nodeId,registrationEpoch}`. Only one connection and one pending poll are allowed
per registration epoch. The same open connection can poll again after a batch;
a competing subscription is refused. Polls return `{queries:[...]}`. Each query has
version, queryId, daemonInstanceId, registrationEpoch, destinationNodeId, operation,
origin, exact raw fields, requestDigest and expiresAtMs. Origin is derived from
registered local transport (`apiary-routed`) or is `unprepared`; a caller's group
field never conveys authority. Apiary alone recovers trusted durable placement scope.

Respond on that connection using `admission.eligibility.answer`, echoing the query
identity/digest/deadline (omit fields and operation), plus `eligible:boolean` and,
for YES only, `satellite:{nodeId,name}`. A self-candidate is invalid. YES refuses
before admission effects and names that satellite in the message and details.
NO admits locally with the notice. Query and answer objects are closed.

Each request has a 1.5 second total deadline and the queue is bounded at128. No
subscription returns immediately; overflow, expiration or loss of registration
resolves unavailable. Slot replacement, disconnect and shutdown discard outstanding
queries. No answer is cached across new attempts. The long-poll lease is30 seconds;
clients must use a timeout above that for subscribe, and mutation timeouts above
1.5 seconds plus ordinary execution time. Existing command timeouts must be retained.

Apiary-routed requests can instead carry `frame.context.satelliteEligibility` with
a fresh single-use queryId and the same version/daemonInstanceId/registrationEpoch/destinationNodeId/requestDigest/
expiresAtMs and eligible/satellite fields. Either polarity is final for that request
only if the sender is the currently registered direct-local Apiary. The digest is
`eligibilityDigest(registration,destinationNodeId,operation,rawFields,origin)` in
`satelliteEligibility.ts`; it hashes raw presence/values, not semantic defaults.
Untrusted carried data cannot suppress the live query. Malformed or stale trusted
answers fall back locally. This is a new consumer protocol: T39c alone contains no
subscriber implementation. Without an updated Apiary consumer, fallback is expected.

## Effects and receipts

New fallback admissions have basis `automatic_local_fallback`; successful own work
continues if a satellite later appears. Children get independent admission. New
spawn/fork/thread/import decisions precede account/provisioning effects. Concurrent
spawn retries share one pending attempt. Keys bind actor authority, never changing
fleet state. Committed successful receipts replay without a fleet query or new effect.
Authority is checked again at the synchronous receipt boundary after awaits.

Accepted queued work is not queried or stranded at runtime claim. Its basis, including
`inbox_only`, is preserved; a quiet owner notice/audit records local release. Only
expired fixer producer policy remains a separate hold. Existing mailbox semantics
and live-runtime adoption remain unchanged.

Retained cross-bee exec always uses local fallback with `criteria_unsupported`;
a satellite cannot execute in this local checkout. Ownership/access, busy/live-runtime
checks and exact process fencing remain. A historical effect-free placement denial
can requeue only with empty argv, no PID/birth, no running/done/unknown audit evidence
and the same request hash. The core transaction preserves denial history, restores
the validated argv and appends the requeue. Real or uncertain execution is never
repeated. New placement refusals create no failed Cell operation.

## Limits and activation

This is cooperative admission, not CPU/exec confinement. Human sessions, migrated
existing bees and already-running native shells/descendants are unrestricted. A
local same-UID caller can spoof CLI human/runtime identity or strip environment
markers. Anyone holding the registration key can take its trusted process slot.
No command classifier or OS execution sandbox is claimed.

Schema52's one-time migration admits existing bees as continuation. An old daemon
requires restoring a pre52 backup for rollback; redeploy migrates all restored bees,
including rollback-created work, to continuation. This remains a disclosed gap.

Activation still requires independently reviewed Apiary eligibility consumption,
origin/principal forwarding and notice handling, correct nodeKind config, maintained
LocalRpcTrust and the finite owner-approved T114 spawn-only producer policy. Existing
cross-bee exec caller inventory and delivery sequencing remain owner responsibilities.
This change authorizes no deployment. Tests use disposable satellite fixtures with
fake HOME and short isolated TMPDIR/RUNNER_TEMP; no human workstation is exercised.
