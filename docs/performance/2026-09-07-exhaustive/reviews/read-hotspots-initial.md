# Review — scripts/perf/read-hotspots.mjs + test (commit 7b5403a4)

Static read-only review at the committed bytes (clean worktree, HEAD =
7b5403a4). No builds or captures run; the test file's E2E smoke was not
executed by me.

## Verdict

Strongest ruler in the series. Fixtures are validity-asserted from both sides
(offline SQL counts and real-store reads), timing samples are clean of
instrumentation and semantic checks, provenance meets the schema-2 standard
plus incremental atomic report writes with signal-handler failure evidence,
and before/after pairs are mechanically comparable through `compareReports`
with workload/fixture/sample equality enforced. **No blockers in the capture
path.** One should-fix on the comparison side; the rest are nonblockers.

## Fixture validity (audited per family)

- **D05 boot-recovery:** settled `stop` history seeded offline, re-verified
  through the real store (count, status, order sha256); `boot()` against
  FakeDriver with autoBoot off returns an all-zero BootReport each call. The
  measured hotspot is real (reviveAfterStopIfRequested's listCommands scan
  over 0/1k/100k settled rows). Note `boot()` legitimately writes one
  `boot.reconciled` audit row per call — the fixture doesn't claim quiet
  authority, records `bootAuditRows === calls`, and asserts the command
  history and runtime state are byte-stable. Valid.
- **D05 pending-stop:** booting runtime aged 120s past a 60s hang timeout,
  with a future-dated queued stop — so `bootHangPolicy` runs
  `pendingStopExists` (the settled-history scan being measured) and enqueues
  nothing; the future `next_attempt_at` also keeps `claimNextCommand` idle.
  Authority-quiet asserted by audit-seq equality. Valid and clever.
- **C07 flag-expiry:** 100k cleared + N active future-reset flags; offline
  `due=0` pre-asserted; `expireFlags` must return `[]` and leave seq
  untouched. Measures whether cleared history contaminates the active-only
  partial-index scan. Valid.
- **C09 held-idle / stopped-pending / pending-page:** the running holder gets
  `bootEvidence 'real'` via the booting→running edge, so the idle message is
  permanently ineligible (same held-mail construction paired-step uses); the
  stopped variant retains its legitimate wake command but defers it to
  FUTURE offline (asserting exactly one row changed), keeping steps quiet
  while wake intent survives — asserted in finish. `pendingMail` checks the
  16KiB truncation contract against 1MiB bodies. All valid.
- **C10 full/sparse:** delivered-mail history seeded offline with even
  interleave; order pinned by sequence sha256 before, per-call, and after.
  Measures the unindexed `listMessages(bee)` scan (delivered rows are outside
  the partial undelivered index) — the real hotspot. Valid; the
  impossible-provenance of offline "delivered" rows is explicitly disclaimed
  in scope as read-cost fixture, not delivery evidence.
- **C22 enabled-empty/paused:** real `setTaskSupply`/`addTask`/
  `tryFeedTaskSupply` paths build the paused-breaker state; steps then
  exercise the per-tick supply scan plus N no-op write transactions (the
  real per-tick cost of enabled supplies) while staying authority-quiet —
  asserted. Held feed messages stay pending behind running-real runtimes.
  Valid.
- **C25 audit-tail:** 20 target rows spread through 1M unrelated audit rows;
  bee-filtered `auditTail` has no covering index, so the reverse scan is the
  measured cost; exact seq list re-verified after sampling. Valid.
- **C18 rpc-hit/insert/eviction:** retention arithmetic is exact — insert
  seeds `10000 − (warmups+samples+1)` so no call evicts; eviction seeds a
  full window so every call evicts exactly the oldest seed; finish asserts
  the precise eviction boundary (`seed-000000` gone, `seed-00000N` present,
  count pinned at retention). If the store's retention default ever diverges
  from the hard-coded 10k, assertions fail loudly rather than skew. Valid.
  (These two are write-path measurements under a read-hotspots banner —
  honestly labeled as `recordRpcResult`, fine.)

## Measurement contamination (clean)

Timers wrap only `fixture.operation()`; `check()` runs after both clocks stop.
Warmups (3) precede an optional `global.gc()`; the SQL diagnostic is one
separate post-timing `captureSql` call, labeled diagnostic-only and excluded
from raw samples; its return value is deliberately not serialized (privacy —
asserted in the E2E test). Offline seeding uses `synchronous = OFF` only on
the seeding connection while the store is closed — `synchronous` is
per-connection, so measured operations run under production WAL/NORMAL, and
the workload block says exactly that. Per-scenario stores live in one
mkdtemp run dir, closed per scenario, removed in `finally` and on signals.
Sample-to-sample state is stable in every family (the two growing families —
boot-recovery's one audit row per call and C18's constant-shape writes —
have per-call-invariant cost).

## Provenance (meets the current standard)

Source fingerprint (all v2 src + helpers) plus status and binary-diff sha
taken before the dynamic imports; source and tool fingerprints re-asserted
after capture. Full environment block including release/osVersion/
totalMemoryBytes beyond the schema-2 set. Incremental atomic report writes
(tmp + rename) after every scenario mean a killed or crashed run leaves a
valid JSON with `completed:false` and structured failure evidence; SIGINT/
SIGTERM handlers persist failure + loadAfter and clean the run dir before
exiting 130/143. This is the best failure-evidence story of the rulers.

## Behavioral assertions (strong)

Every family asserts authority quietness (or the exact audit delta),
exact retained state with order digests, and zero driver effects
(`starts`/`deliveredIds`/`interrupts`/`events` all empty). The I1 hook is an
assert-fail tripwire and i1/idle policies are disabled in `makeCore`, so any
unexpected policy write fails the run rather than contaminating it.

## Before/after comparability

Safe through `compareReports`, which the E2E test proves accepts these
reports: it enforces environment (node/platform/arch/cpu/hostname) equality,
scenario-list equality, and `workload` deepEqual — and because the embedded
plan carries every fixture size (including the samples-derived C18
`distinctWrites`), any drift in samples, scale constants, or scenario set
refuses the pair. Two gaps make the comparison less than fully mechanical:

**Should-fix: `compareReports` does not assert `completed === true` or
toolHashes equality for these reports.** A capture that finished all
scenarios but failed the final source/tool fingerprint assert retains a full
results array with `completed:false` — it would pass `compareReports`. And a
before/after pair captured with different ruler bytes passes as long as the
workload matches. Both checks exist as fields; add them to the comparator (or
a thin read-hotspots wrapper) before publishing deltas. Until then, treat
"completed:true both sides, toolHashes deepEqual" as a mandatory manual step.

## Nonblockers

- `global.gc()` is conditional and its availability isn't recorded — either
  assert `--expose-gc` like quiet-tick or record a `gcAvailable` boolean
  (execArgv makes it derivable; explicit is better).
- Default `--samples 5` is thin for canonical published deltas (p95 = max of
  5); the flag supports up to 1000 — suggest ≥15 for the remote canonical
  runs so distributions match the other rulers' habits.
- Per-scenario load isn't sampled; a long canonical run (1M-row seedings)
  records only run-level loadBefore/After. Per-scenario measurement intervals
  exist, so adding per-scenario loadAfter would complete the attribution.
  (No threshold proposed, per standing decision; the wall/cpu ratio remains
  available in-file as within-capture evidence.)
- `bootIdentity` is recorded but not compared by `compareReports`; hostname
  equality is — and the fleet's known hostname collision ("Mac.home" on two
  machines) means cpu/node equality is doing the real cross-machine guard.
  Same residual as prior rulers; consistent handling.
- The offline-seeded histories intentionally break the audit-replay
  invariant (rows without audit provenance); scope disclaims this clearly.
  Just never promote these stores into behavior-replay or migration
  fixtures.
- Minor: `buildScenarioPlan`'s smoke E2E covers one case; `selectScenarios`'s
  unknown-case rejection and the signal path are untested (both are simple
  and loud).

## Answers to the named audit axes

Fixture validity: sound in all ten families, with two-sided verification.
Measurement contamination: none found in the timed path. Provenance:
exemplary, including partial-run evidence. Behavioral assertions: strong and
adversarial. Before/after: safe once the two comparator gaps (completed
flag, toolHashes) are closed or checked manually; everything else is
enforced mechanically.
