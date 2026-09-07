# Review — quiet-tick.mjs v3 (--live/--pending/--body-bytes) vs 487972cf

Read-only diff review + new quiet-tick.test.mjs. Verdict: **approve; no
blockers.** ~30 lines, default invocation semantics unchanged, and the
extension measures exactly the two cases the empty-snapshot guard does not
cover (sparse-live roster cost, held-large-body allocation traffic) — the
right baselines for the sparse-live projection direction.

## Verified properties

- **Validation is complete and ordered before setup**: live ≤ bees,
  pending ≤ 100k, body ≤ 4 MiB, pending×body ≤ 128 MiB, and the
  load-bearing `pending === 0 || live > 0` (held idle mail requires a live
  holder — without it the fixture could not be authority-quiet). All three
  refusal paths are E2E-tested against stderr.
- **Fixture construction is sound**: live targets revived then
  booting→running (bootEvidence `'real'`, now *asserted explicitly* — this
  pins the held-idle premise against future updateRuntimeState changes);
  idle sends land on running perf-0, so no wake commands exist; pending
  count asserted post-seed.
- **Invariants strengthened, not just preserved**: existing state-digest +
  audit-head asserts now hold across live/pending fixtures, plus new
  no-driver-effect asserts (`starts`, `deliveredIds`, `interrupts` all
  empty) — delivery filtering, idle-urgency non-interrupt, and no-spawn are
  each pinned. I1 stays a tripwire (idle urgency on running+real suspends
  the clock; frozen clock can't breach).
- **Provenance/pairing safety**: all new fixture parameters live in
  `workload` (liveRuntimes, pendingMessages, bodyBytes, urgency,
  pendingTarget, descriptive currentRuntimes), so compare-quiet's workload
  deepEqual refuses any cross-config or cross-version pair — old v2
  reports also differ in toolHashes, double-refusing. Existing guard
  evidence remains valid under its recorded old hashes; new claims need
  fresh v3 before-captures, matching the frozen-ruler-v3 plan.
- **Scope string updated honestly** (FakeDriver, seeded state, no real
  process or readiness).
- **Test 1** is a real E2E (live=1, pending=4, 64 KiB, profile mode):
  completion, workload fields, raw counts, auditSeq, and hash-verified
  profile parsing via readQuietProfiles.

## Nits (non-blocking)

1. `activeLifecycleFraction: 0.1` is recorded verbatim, but reviving an
   archived bee unarchives it — exact only for `live ≤ 1` (perf-0 is never
   archived). The announced runs use live=1, so current captures are
   exact; compute or annotate the field if live > 1 runs ever happen.
2. `driver.events` is not in the no-effects assert (starts/delivered/
   interrupts are) — empty by construction today; one line would match
   read-hotspots' assertNoDriverEffects symmetry.
3. `--body-bytes 0` is permitted (empty body) — harmless, just untested.

## Measurement note for the planned runs

Sparse-10000 (live=1) will pay the full roster materialization every tick
by design (guard bypassed via the one live runtime) — the headline metric
is per-tick CPU vs the 10,000-stopped guarded case. Held-large-body runs
measure listUndeliveredMessages body materialization up to 3×/tick; the
128 MiB cap bounds fixture size, and profile-mode allocation numbers stay
attribution-only per the existing scope rules.

## Parent disposition

The all-live fixture is among the actual baseline cases. Replaced the inaccurate `activeLifecycleFraction` with an explicit seed/revival rule and recaptured every case using that frozen ruler. Earlier v3 reports remain exploratory and must not pair with corrected-ruler after captures. The other two notes are nonblocking; driver delivery/start/interrupt effects and durable state are asserted.
