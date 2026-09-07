# H10 unit 1: daemon HSR/Cell delivery-history retention — fable candidate

Design package only; no production edits, tests, captures, hosts, or Mini.
Baseline 501710c1 (main c6cf01f2 runtime-identical). Grounding: the H10
ownership study, the stopped/released heap study (3,670,056-byte backing
table at 100k proven entries, structure gone on release), and the parent's
provisional plan — considered, not auto-adopted. Sketches in
`signatures.ts` alongside.

## Problem

`HsrDriver.consumed` (driver.ts:320) is a lifetime `Map<number, number>` of
accepted messageId → generation, written at exactly two sites (:587
confirm-consume retry, :614 non-confirming successful write), never
deleted, read by no production path — only the harness invariant checker
and test statistics. In the built-in daemon it grows for the daemon's
lifetime (~36.7 shallow B/entry observed at 100k). Unit 1 must make the
built-in daemon's direct HSR and Cell-inner-HSR retain none of it while
every omitted-option caller keeps today's public semantics (including
overwrite-on-duplicate and lifetime retention), with pending/confirmed
protocol state, writes, observations, cursors, outcomes, and Core mailbox
truth untouched. Tmux/Sim are outside the diff.

## Usage (caller's view, written first)

Daemon (the entire production consumer diff — one field in the shared
literal that already feeds BOTH built-in HSR instances):

```ts
const hsrConfig = {
  sessionLogDir: this.cfg.sessionLogDir,
  stopKillGraceMs: this.cfg.stopKillGraceMs,
  adoptToleranceMs: this.cfg.adoptToleranceMs,
  recordDeliveryHistory: false, // built-in daemon retains no history
};
const hsr = new HsrDriver({ ...hsrConfig, resolve: ... });   // :580 unchanged
const cell = new CellDriver({ ..., hsr: hsrConfig, ... });    // :590 unchanged
```

Existing test/harness caller (unchanged — omission is the compatibility
default):

```ts
const driver = new HsrDriver({ sessionLogDir, resolve });
// ... accepted delivery ...
assert.equal(driver.consumedGeneration(id), 1);   // exactly today's semantics
assert.equal(driver.consumedCount(), n);
```

New-mode caller (tests of the daemon shape):

```ts
const off = new HsrDriver({ sessionLogDir, resolve, recordDeliveryHistory: false });
assert.throws(() => off.consumedCount(), /delivery history recording is disabled/);
```

## Shape

Data structure first: `consumed` becomes `Map<number, number> | null`, and
null IS the disabled state — no parallel flag, no wrapper object, nothing
to keep in sync (single source of truth). The two write sites gain one-line
in-place guards; the sites stay the only evidence origin (anti-tautology:
no outer wrapper, no recording from `{accepted: true}`). The queries throw
when disabled: an explicitly disabled recorder must be loud, because
returning 0/undefined is indistinguishable from valid "nothing delivered"
ground truth — a checker over a populated mailbox would report ghosts and a
statistics caller would publish fake zeros. Throwing changes no existing
caller (no production reader exists; every current caller constructs
default-on) and makes accidental use of a disabled driver fail at the call
site (per encode-lessons-in-structure: the absence of evidence is not
evidence of absence, so the type of the disabled state is an error, not a
zero). No status/discriminated API without a concrete need — none exists.

Cell needs zero source change: its inner HSR is built from `{ ...cfg.hsr }`
(driver-cell:121-124) and its query methods delegate (:291-297), so both
the field and the throw contract flow through. Interface depth: public
surface grows by ONE optional config field; everything else is two guards
and one wiring line. Module map: driver-hsr/src/driver.ts (field + nullable
map + 2 guards + 2 query guards), daemon.ts (+1 literal line), types in the
same driver file; Cell, Tmux, Sim, harness, RuntimeDriver, ExtendedDriver,
SubstrateRouter, Root/RPC/CLI all untouched.

Tmux extension later (described only): the same field on TmuxDriverConfig,
the same in-place guards at its two sites (:365, :384 — the echo-mismatch
assume-best path and the record-before-now() ordering edge stay verbatim in
the default arm), one more daemon literal line. No Tmux metrics claimed
until its own unit.

## Alternatives considered

- **Design 2 — test-owned recorder sink, default absent** (fully sketched
  in signatures.ts). The cleaner END ownership: no history Map in ANY
  ordinary construction, evidence storage owned by the harness. Loses THIS
  unit on two concrete grounds. (1) Compatibility, the task's hard
  constraint: default-absent removes the recorder from the ~19 direct
  consumedGeneration/consumedCount assertion sites, both real harnesses,
  helpers, and smokes, all of which must migrate inside the same diff that
  must also prove daemon wiring — a large churn and review surface for the
  identical daemon outcome. (2) Surface cost: it adds a public injectable
  interface whose no-throw/no-reentry contract is prose (Map.set cannot
  throw today; a throwing recorder is a NEW mid-acceptance exception path,
  and the Tmux record-before-now() edge proves after-the-fact recording is
  not exactly equivalent). Design 1 reaches the same daemon end state and
  leaves Design 2 implementable later behind the same write sites, with
  the query-method compatibility decision taken separately.
- **Protected hook + test subclasses**: acceptance-site separation without
  injection, but exposes a subclass API in production, needs a Cell
  recording path, and still breaks the concrete queries unless shims stay
  — broader than Design 2 with no offsetting gain.
- **Default-off recorder**: silently flips existing source callers to
  empty/throwing — an unannounced compatibility break; rejected.
- **Prune-on-exit / cap / LRU**: loses full-lifetime checker evidence,
  breaks I1 over complete mailbox scans, changes consumedCount semantics,
  and does not bound a busy long-lived runtime; rejected as non-solutions.
- **Status quo**: leaves unbounded daemon growth; rejected as the point of
  the unit.

## Tests (real store/host; no production diagnostic API)

1. Default matrix (compatibility): refusals (no process, wrong generation,
   socket, write failure) record nothing; non-confirming success records;
   confirming sequence records exactly once at confirm-consume retry;
   duplicates overwrite without count growth; stop/revive/detach/dispose
   retain history; fresh driver empty. These re-pin today's semantics
   under the unchanged default.
2. Disabled matrix: the SAME transition matrix with
   `recordDeliveryHistory: false`, comparing outcomes, exact wire
   frames/body/count, observations, session evidence, recovery cursors,
   pending/confirmed contents, stop/revive — byte-equal to the default run
   except both queries throw with the stable message.
3. Cell pass-through: set the field via `CellDriverConfig.hsr`, deliver,
   assert delegated queries throw and provisioning/delivery/process
   evidence unchanged — proving the zero-Cell-change assumption.
4. ACTUAL daemon construction: start the real daemon on provider-free
   fixtures, `Reflect.get(daemon, "driver")` → `SubstrateRouter` (public
   readonly hsr/cell), `instanceof` checks, then assert BOTH built-in HSR
   paths throw on the queries while a directly constructed default driver
   in the same test still records — the regression tripwire the study
   demands; an isolated disabled-driver test proves neither wiring nor
   absent allocation. Tmux instance asserted STILL recording (explicit
   unit scope honesty).
5. API guards: RuntimeDriver/ExtendedDriver/RPC/CLI/store/audit unchanged
   (compile-time + existing suites).

## Measurement outline (parent-owned; requirements only)

Two roots with exact declared diff; A/A first; ABBA at 0/10k/100k with a
default-on compatibility control root showing the original slope; numeric
and snapshot modes strictly separate; drained-or-accounted pending/
confirmed/pendingWrites/socket/transcript state before any retained
reading; snapshot mode proves no-history allocation by finding ZERO
consumed Maps under the daemon-shaped construction via the
classification-FIXED inspector (the current analyzer labels any `consumed`
target a Map and must be corrected first — recorded in the heap study
addendum); no gains invented; live protocol queues stay separate axes.

## Open questions and risks

- Is a bare Error with a stable message enough for the throw contract, or
  should a named error class ship? (Smallest surface says message; a
  future embedder wanting programmatic discrimination says class.)
- Future daemon constructions can silently regress to recording by
  omitting the field; test 4 is the tripwire, but is a lint/type nudge
  (e.g., requiring the field in the daemon's own config type) wanted?
- Acceptance language must stay scoped: "built-in daemon HSR and
  Cell-inner-HSR allocate and retain no accepted-delivery history;
  default constructions preserve the prior recorder API and semantics;
  protocol pending/confirmed state unchanged" — a daemon opt-out, NOT
  production ownership extraction (that is Design 2, later, if the
  measured slope justifies it).

## Next implementation step

Guard the two write sites behind the nullable map and add the config
field, since every test and the daemon line compose against that seam.
