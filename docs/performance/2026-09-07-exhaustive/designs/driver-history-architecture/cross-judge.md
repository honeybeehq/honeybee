# H10 unit 1 architecture cross-judge

Date: 2026-09-07
Source baseline: `501710c18515c4ac077a643c50daba2ce9043958`
Scope: read-only comparison of the frozen Fable and Sol packages. No implementation,
tests, hosts, Mini access, or benchmark work was performed.

## Verdict

There is a real consensus: implement the compatibility-default construction policy,
not either ownership-extraction alternative, for H10 unit 1.

Use Fable as the package base and graft Sol's explicit `true` compatibility control,
real `CoreStore` + `DaemonCore` outcome/audit parity test, and typed shared daemon
literal. The resulting production slice remains exactly two modules: a nullable
history map and two in-place guards in HSR, plus `recordDeliveryHistory: false` in
the daemon's already-shared HSR config. Cell source, Tmux, Sim, Core, router, RPC,
CLI, and public driver query signatures stay unchanged.

No blocker exists in the shared recommended design. Fable's proof plan has one test
gap, and Sol's losing class-split design has one structural blocker; both are bounded
below.

## Scores

| Rubric criterion | Fable | Sol |
| --- | ---: | ---: |
| 1. Exact default/history compatibility and loud disabled state | 4 | 4 |
| 2. Built-in daemon HSR + Cell opt-out with honest scope | 4 | 4 |
| 3. Minimal interface and explicit ownership | 4 | 4 |
| 4. Real-object regression and correctly scoped ruler plan | 3 | 4 |
| 5. Two honest, structurally distinct whole designs | 4 | 3 |
| **Total** | **19/20** | **19/20** |

### 1. Default behavior and history compatibility — both 4/4

Both recommended sketches initialize the field with
`cfg.recordDeliveryHistory === false ? null : new Map()`. Omission and explicit
`true` therefore preserve allocation, overwrite by
message ID, distinct count, and driver-lifetime retention. Both guard the two real
evidence-origin writes in place:

- confirmed delivery, only after `confirmedDeliveries.delete(messageId)` succeeds
  on the acknowledgement retry (`driver-hsr/src/driver.ts:585-589`);
- non-confirming delivery, only after `writeLine()` succeeds
  (`driver-hsr/src/driver.ts:608-625`).

Neither derives evidence from Core's `{ accepted: true }` trust decision. Both make
`consumedGeneration()` and `consumedCount()` throw whenever recording is disabled,
including before any delivery, so missing instrumentation cannot look like valid
empty ground truth. Default callers retain the existing methods and behavior.

### 2. Daemon HSR and Cell wiring — both 4/4

The source has one shared `hsrConfig` literal at `daemon.ts:575-590`. It is spread
into the direct HSR constructor and passed as `CellDriverConfig.hsr`. Cell then
spreads that object into its inner HSR at `driver-cell/src/driver.ts:121-124`.
Adding one explicit false field therefore disables both built-in maps without a
Cell edit. The conditional constructor plus a source/heap check prove no history
`Map` is allocated by either instance; the actual-daemon reflection test protects
against future omission.

Both candidates correctly leave Tmux and Sim unchanged and avoid claims about
default direct constructions. Fable additionally proposes a useful scope tripwire
that the daemon's Tmux query remains enabled; that should mean “does not throw / is
still default-on,” not a new Tmux delivery proof in this unit.

### 3. Interface cost and ownership — both 4/4

The recommended policy adds one optional construction field and no operator-facing
configuration, callback, wrapper, status method, diagnostic getter, or forwarding
layer. `Map | null` is the single state for recorder presence. Cell's existing
spread and query delegation carry both policy and throw semantics.

This is deliberately a daemon opt-out, not full production-class ownership
extraction: default exported `HsrDriver` and `CellDriver` objects still own history
for compatibility. Both packages state that limitation honestly. The rejected
external sink is correctly identified as introducing unenforceable no-throw and
no-reentry requirements at an acceptance boundary.

### 4. Regression and ruler plan — Fable 3/4, Sol 4/4

Both plans cover real runner-host wire frames, refusal and acknowledgement paths,
duplicate IDs, wrong generations, stop/revive/lifetime behavior, Cell forwarding,
actual daemon construction, source A/A, symmetric ABBA at 0/10k/100k, a default-on
control, separate numeric/snapshot runs, and drained-or-accounted live protocol
queues.

Sol additionally specifies the missing durable differential: run direct and
confirmed paths through a real `CoreStore` and `DaemonCore`, then compare mailbox
delivery generation and audit sequence between recording and disabled modes.
Fable labels its plan “real store/host” but its enumerated acceptance matrices do
not actually say to drive an accepted delivery through `DaemonCore`; its actual
`HiveDaemon` check is intentionally empty and therefore proves wiring, not mailbox
or audit parity. That is a concrete proof-plan gap, not a production-design bug.

Before freezing a ruler, retain the existing scope and label four kinds of evidence
separately: source/heap-graph structural absence of the map, sampled allocation,
managed-heap deltas, and whole-process RSS. A backing-table snapshot or a sum of
retained nodes is not an RSS result. Neither package should expand this first unit
to measure live acknowledgement queues or Tmux.

### 5. Alternative designs — Fable 4/4, Sol 3/4

Fable fully sketches a structurally different external recorder sink and rejects
it for two valid reasons. Default absence cannot preserve omitted-option behavior
for unknown external callers, and an injected synchronous callback adds exception
and reentry paths at the exact acceptance boundary. Its Map-backed harness recorder
and migration cost make the alternative concrete and falsifiable.

Sol's separate compatibility/runtime classes are a legitimate distinct direction:
default class names keep today's recorder, while daemon-only classes expose no
history methods and use a closed module-owned recorder only in compatibility mode.
It correctly rejects the direction as too broad for unit 1. The sketch is not yet
an implementation-ready whole design, however. It supplies `HsrDriverBase` but no
corresponding shared Cell implementation. At the baseline, `CellDriver` has runtime
delegation plus `ensureCell`, `cellOf`, `capture`, and `removeCell`; the daemon types
`requireCellBee()` and `requireActiveCellBee()` as returning concrete `CellDriver`
and directly calls `driver.cell` (`daemon.ts:1795-1820`, `:2408`). The router also
stores concrete HSR/Cell classes and returns their union (`substrates.ts:35-68`).
A second empty `CellRuntimeDriver` cannot satisfy those paths. Candidate B would
need either a complete common Cell base/interface and widened daemon/router types,
or duplicated Cell logic. That omitted seam is a structural blocker for Candidate
B, but it does not affect Sol's recommended Candidate A.

## Source-grounded constraints

The critical candidate claims match `501710c1`:

- HSR's historical recorder is a lifetime `Map<number, number>` at
  `driver-hsr/src/driver.ts:320`; `detachAll()` and `disposeAll()` do not clear it
  (`:1145-1180`).
- The only HSR writes are the confirmation-consume and successful direct-write
  sites at `:587` and `:614`. `pendingDeliveries` and `confirmedDeliveries` are
  separate protocol sets; acknowledgement/refusal mutates them at `:1331-1339`.
- Cell's delivery and history methods are pure inner-HSR delegation at
  `driver-cell/src/driver.ts:190-192` and `:291-296`.
- Core marks durable mail delivered solely from `DeliverOutcome.accepted` at
  `daemon/src/loops.ts:1095-1098`; neither history query is in `RuntimeDriver` or
  the daemon's extended driver shape.
- The real class is `HiveDaemon` (`daemon.ts:442`), its router field is private
  (`:446`), and `SubstrateRouter.hsr/cell/tmux` are public readonly
  (`substrates.ts:45-48`). Test-side `Reflect.get()` followed by `instanceof`
  narrowing is sufficient; no production inspection API is warranted.

## Corrections that are not candidate-design failures

1. `task.md:22` says `HoneybeeDaemon`; the baseline class is `HiveDaemon`.
   Sol names it correctly. This is a parent/task prose correction and carries no
   score penalty.
2. Fable's “~19 direct consumedGeneration/consumedCount assertion sites ...
   helpers, and smokes” is not an exact baseline inventory. `git grep` finds nine
   executable HSR/Cell query calls in their own tests/real harnesses, plus one
   generic invariant-checker call; HSR/Cell smoke files do not call either query.
   The architectural conclusion survives: a default-absent sink breaks unknown
   omitted-option callers and entails broader in-repo migration.
3. Fable's `3,670,056 / 100,000 ≈ 36.7` figure is a descriptive quotient for that
   observed Map backing-table capacity, not a stable per-entry allocation law.
4. Fable's signature preamble says “four existing acceptance-site writes.” Unit 1
   changes the two HSR sites; the other two are Tmux's later-only sites at
   `driver-tmux/src/driver.ts:365` and `:384`. The detailed design scopes this
   correctly.

## Recommended bounded synthesis

Take Fable's recommended policy as the base, with only these Sol grafts:

1. Type the shared daemon literal as
   `satisfies Omit<HsrDriverConfig, "resolve">`; this documents that the same
   complete HSR sub-config feeds direct HSR and Cell. The actual-daemon test, not
   this optional-property type, remains the regression proof that false is present.
2. Test omitted, explicit `true`, and explicit `false` modes in the same acceptance
   table. Explicit `true` is a useful control for the public option contract.
3. Add Sol's real `CoreStore` + `DaemonCore` direct/confirmed differential, checking
   exact mailbox generation and audit ordering. Run `InvariantChecker` only against
   enabled evidence; disabled queries must throw.
4. Keep Fable's actual `HiveDaemon` reflection check for both built-in HSR paths and
   its Tmux scope tripwire. Do not turn the Tmux check into delivery work.

Reject both larger alternatives for this unit: do not add an external recorder
interface, runtime/compatibility class families, common Cell bases, router unions,
or new public diagnostics. Those are separate ownership/API units, not prerequisites
for removing built-in daemon HSR/Cell retention.

## Frozen inputs

- `task.md`: `ae48b8cadf48a7b6b1caac86f4a7aec8f89b6712395ce8f13999bc5436b2c4bc`
- `rubric.md`: `b1570fbb982ec48a2eec5f6714b3b776335064045e027fc4c1bdb3b19463e5d2`
- Fable `design.md`: `9a3bb84912dfb47c8ca33e4ae2df6c674620a0ca82a2d4269458f6dd624d0b18`
- Fable `signatures.ts`: `4de5bb6611927e84a7527fee7945dede4df52968328b5e06cfd675227f0aaf84`
- Sol `usage.md`: `44d2727dee174b258896f54e075c7fc161638bef72d9d944fe9f359dda88b317`
- Sol `design.md`: `22b3d8e2adc911139a0633f55ba54205ca65144bae60ad07bcf0bc9a996c2f11`
- Sol `signatures.ts`: `4eaed15b13f68888ff9d21a7898c53d3011656f68991ecb35059f40789e61240`
