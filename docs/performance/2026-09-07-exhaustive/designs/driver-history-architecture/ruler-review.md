# H10 driver-history ruler review — read-only (no edits, no runs, no Mini)

Subject: frozen DRAFT `/tmp/honeybee-driver-history-ruler.mjs` (v1 preserved;
attempts.md records the pre-child CLI failure honestly: `realpathSync`
passed directly to `Array.map` received the index as its options argument —
the classic map-arity trap — with no artifacts produced). Evidence read:
numeric A/A smoke `…-smoke-aa-v2.json` (completed, control mode, two
byte-identical 604bf404 roots, counts 0/20, 8 serial children, empty
changed-set) and snapshot A/A smoke `…-smoke-aa-v2-snapshot.json`
(completed, 4 children, every phase reading diagnosticOnly, no numeric
differences emitted, 2 snapshots per child). Verdict at the end.

## Focus area 1 — lifecycle references around the released phase: CLEAN

Verified against source, not assumed: `procOf` returns a fresh
`{pid, pidStartedAt, observationCursor}` POJO (driver.ts:1064-1074), so the
child's `host` variable carries three numbers across the released reading,
not a live ManagedProcess. `liveState()` returns only sizes/lengths per its
stated frame contract; `protocolAtRead` is numbers; the observation/
evidence/session/cursor arrays are count-independent (the exact stream is
four observations); the wire proof holds hashes and small strings; the
`drain` closure's captured binding is nulled with the driver. Nothing
count-dependent survives into the released reading on either arm, which
keeps `released` as a clean sanity floor while the meaningful A/B signal
lives in deliveredAndDrained/stopped, exactly as intended. The
stopped-snapshot hashing does read the multi-MB snapshot into transient
buffers before the released reading; they are collectable under the GC
protocol and snapshot-mode readings are diagnostic-only anyway — noting it
only for readers of external/arrayBuffers.

## Focus area 2 — actual-source provenance: STRONG

Clean-tree fingerprints over v2 src (.ts/.js/.mjs/.json) plus package
manifests on both roots; candidate mode asserts the changed set EQUALS
exactly `v2/daemon/src/daemon.ts` + `v2/driver-hsr/src/driver.ts` (matching
the design's module map); control asserts empty. Identity pins hostname,
boot time, node version, and the resolved executable WITH its sha256. The
child re-asserts tool hash, root fingerprint, and identity both before and
after its run; the orchestrator re-asserts all three at the end. The agent
source is hash-recorded and the written file hash-verified. Best of all,
`hostLaunch` is asserted to be `{kind:'source', entry:<root
runner-host-main.ts>}` — the ruler cannot silently measure against a
bundled host. Per-child spec and log files persist for reproduction;
HIVE_*/NODE_OPTIONS are stripped from child env.

## Focus area 3 — semantic scope: EXACT and honestly bounded

The oracle is genuinely external: the agent hashes its received wire and
the ruler recomputes the expected hash from the frame constructor; the
transcript and observation logs are byte-hashed against expectations; the
observation stream is asserted as an exact normalized sequence (pid fields
asserted equal to the host POJO then removed), evidence/sessions/cursors
exact. Cross-process parity is enforced the right way: all four runs per
count — both sides, both ABBA slots — must produce deepEqual `semantics`
objects, which in candidate mode IS the observable-parity acceptance
criterion, while `retries` is correctly excluded from parity (timing
noise) and retained per-run. The queues-zero gate (`pendingDeliveries`,
`confirmedDeliveries`, `pendingWrites`, `outboundPending`, `stdoutRest`,
`socketWritableLength`) blocks the deliveredAndDrained reading until
protocol state is actually drained — the study's drain-or-account
obligation, implemented. The disabled arm checks both queries throw with
the exact error name/message and `Reflect.get(driver,'consumed') === null`;
the default arm checks the full count and every generation. The scope
string states the fixture's limits plainly: non-confirming stub only (the
:614 record site; confirm-consume :587 belongs to separate tests),
small-integer ids, driver-process occupancy only, no CPU claims, and the
separate default/ack/lifecycle/Cell/actual-daemon test obligations. The
smoke confirms parity empirically: one distinct semantics object across
all four n=20 runs.

## Focus area 4 — failure cleanup: GOOD, two bounded residuals

The child writes its error JSON before rethrowing (evidence before
failure), and the orchestrator records `result.error` and writes the
report in `finally`, keeping partial runs, specs, and logs. The child's
`finally` disposes an un-stopped driver and waits for process absence
before removing its directory. Two residuals, both non-blocking: (a) the
cleanup wait inside `finally` is not itself try-wrapped, so a 90 s timeout
there would skip `rmSync` and leak the tmpdir (the dispose path makes this
unlikely); (b) a spawnSync timeout kill (600 s) bypasses the child's
`finally` entirely, which could orphan the owned detached host and its
tmpdir — worth one orchestrator-side note (the receipt/host pid is on disk
in the spec/log if a sweep is ever needed). Neither affects measurement
validity.

## Focus area 5 — no hidden heap attribution: CLEAN

Numeric mode derives only `wholeProcessDifferencesFromConstructed`,
labeled as such; snapshot mode marks every reading diagnosticOnly and
emits no derived differences (verified in the snapshot smoke report);
snapshots never run in numeric mode; no Map-byte or RSS-attribution claim
appears anywhere; Reflect use is tool-side only. The retained-ruler
lessons are all applied.

## Notes for the record

- The default-comparison mode (same A/B roots, option omitted on both) is
  a well-chosen compatibility gate: it forces the candidate root's default
  arm to reproduce the before root's exact semantics stream.
- history() on the default arm walks all N generations twice (pre- and
  post-stop) outside readings — transient allocation handled by the GC
  protocol; fine.
- Boot pin uses kern.boottime string equality where earlier rulers hashed
  kern.bootsessionuuid — equivalent for same-boot enforcement; consistency
  nit only.
- Analyzer-v2 interlock: the parent's metadata-mutation control (removing
  a recognized Map table edge name) produced completed:true JSON with a
  table_edge_count anomaly and exit 1 — the evidence-before-failure path
  the analyzer review asked for, now exercised; snapshot analysis of a
  future candidate still requires its own source re-alignment first.

## Verdict

APPROVED for Mini use as drafted: numeric mode for A/A, candidate, and
default comparisons at 0/10k/100k, snapshot mode as the separate
diagnostic. The two cleanup residuals are optional hardening. The
candidate comparison remains gated on the not-yet-authorized branch and
the disabled arm is correctly unexercised until then; judging is separate.

## Addendum: v3 ownership persistence (corrects a sentence of THIS review)

Correction first, parent-caught: focus area 4 above said the host pid was
"on disk in the spec/log if a sweep is ever needed" — that was WRONG at the
reviewed v2. The spec carried root/count/identity but neither the fixture
directory (a child-side mkdtemp) nor the actual spawned host pid; the
result JSON containing `host` is written only on completion or a caught
error, so a hard timeout-kill left NO on-disk record of the owned process
or directory. The reviewed bytes are preserved as
`…-driver-history-ruler-v2.mjs`; this addendum applies to v3.

The v3 delta (reviewed read-only, no runs) fixes exactly that and nothing
else: an existence-guarded `out.owned.json` written at four transitions —
`fixture_created` (immediately after mkdtemp, before any host),
`host_started` (with the exact procOf pid AND pidStartedAt, so process
identity is unambiguous against pid reuse), `host_exited` (after the
observed exit), `fixture_removed` (in `finally`, after rmSync) — each
carrying dir, root, count, tool hash, and host identity. No signals or
automatic sweeping are added; a hard-timeout parent now inspects the exact
owned process and directory from the last recorded state, which is the
right division of authority for a measurement tool (inspection data over
in-band cleanup policy). Residual, stated: a kill between rmSync and the
final write leaves the state one step stale in the SAFE direction (claims
the dir may exist when it is already gone), and the un-try-wrapped
finally-wait residual from focus area 4 stands, now mitigated by
inspection rather than prevention. Verdict unchanged: APPROVED, v3
included.

Also acknowledged: the parent ran all eight v2 snapshot-smoke heap
snapshots through the v2 analyzer (`…-smoke-aa-v2-snapshot-proof.json`,
completed:true) — every stopped snapshot classified exactly {map: 1} and
every released snapshot empty, with per-input and per-output digests
recorded. That is the analyzer and the ruler cross-validating each other
on real artifacts before any candidate exists.

## Addendum 2: v4 socket-race fix (Mini-found; reviewed read-only)

The Mini v3 A/A failure is a genuine probe race, coherently evidenced: at
count 0 the parsed boot witness can precede the host client's
socket-connect retry (no deliveries exist to force connection-dependent
progress), so `liveState()` asserted on a null socket. The attempts file,
preserved report/log, and an ownership sidecar proving `fixture_removed`
document it; no failed measurement is used. Only count-0/run-0 could
plausibly hit this, which matches the artifact.

The v4 delta is bounded and correct: `liveState()` returns null while the
socket is null, destroyed, or not writable (comment states the race); a
new explicit booted-AND-connected barrier precedes the booted memory
reading; the drain barrier requires a NON-NULL record plus the same zero
queues; and `protocolAtRead` is asserted non-null, so the semantics
parity object keeps its hard guarantee. The queue/wire/transcript/
observation oracles are byte-unchanged — nothing is weakened.

Two observations worth recording. First, v4 is stricter than v3 in one
real case, not just looser in the transient one: the old
`assert(socket && typeof socket === 'object')` would PASS a destroyed
socket object and could count its empty write buffer as drained, silently
— v4 treats destroyed/not-writable as pending, so a genuinely dead socket
now times out loudly instead of false-passing the drain gate. Second, the
booted phase's meaning tightens from "boot witness parsed" to "booted and
connected write lane", which makes the reading deterministic with respect
to connect timing; v3-smoke booted-phase numbers are therefore not
comparable to v4's, which is moot since canonical runs all-v4. Probe-only
change, no production edit, no semantic weakening. APPROVED; verdict
unchanged with v4 included.
