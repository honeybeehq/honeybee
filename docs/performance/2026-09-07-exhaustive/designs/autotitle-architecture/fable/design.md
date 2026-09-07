# Committed membership-stamp gate for autoTitle mailbox reads

Candidate design package (fable). Baseline 604bf404. No production edits;
sketch in `signatures.ts` alongside. Grounding: the exhaustive-repo
autotitle-read-investigation and its linked studies/counterexample; the
autoTitle/naming/daemon sources and CoreStore seams re-verified at the
baseline (autoTitle.ts hash-identical to the studied copy; `inTransaction`
at store.ts:3413; mailbox write inventory :2651/:2928/:2950/:2985).

## Problem

A 1 Hz synchronous roster walk full-reads the mailbox of every active
untitled bee that is deferred or in backoff — those continues sit before
`probes += 1`, so nothing bounds them; 1,000 such bees cost 1,000
listMessages calls per scan forever, and one substantive giant in backoff
costs a ~130 ms body read per scan. The reads exist only to prove "context
unchanged" (the signature counts nonempty JS-clamped texts — SQL-side
shortcuts are refuted), and the semantics that must not move are exact:
unchanged-defer quietness, changed-context retry reset, launch context from
full stripped text, probe accounting, slot/roster/watchdog behavior,
detection latency, fairness. Persisted sidecar fields are unapproved;
uncommitted (max,count) observation is proven unsafe (rolled-back
AUTOINCREMENT ids can be reused with different bodies).

## Usage (caller's view)

There is no new public consumer. The two real call sites:

Daemon wiring (`createStoreAutoTitleDispatcher`, one line added):

```ts
return createAutoTitleDispatcher({
  ...existing deps...
  mailboxStamp: (beeId) => store.mailboxMembershipStamp(beeId),
});
```

Inside the dispatcher walk (the only logic change, after the existing
lifecycle/title pre-skip):

```ts
const outcome = gate.evaluate(bee.id, deps.loadState(bee.id), now);
if (outcome.kind !== "read") continue;        // proven-silent scan paths
const messages = deps.listMessages(bee.id);   // everything below unchanged
...
gate.record(bee.id, signature);               // after any full read
```

A test or embedder that constructs the dispatcher without `mailboxStamp`
gets today's behavior verbatim — the gate is inert when the dep is absent,
so every existing stub/fixture keeps its meaning.

## Shape

Data structure first: one dispatcher-private `Map<beeId, {stamp,
signature}>` — the last full read's committed membership stamp tied to the
signature that read produced. The stamp is a new core-derived fact:
`CoreStore.mailboxMembershipStamp(beeId): MailboxMembershipStamp | null` —
an opaque branded string built from two stmt()-cached, body-free aggregates,
one per existing mailbox partial index (`COUNT(*), MAX(id)` over the
pending arm and the delivered arm), `null` whenever `txDepth > 0`.

Flow: pre-skip (unchanged) → gate → either a proven-silent continue
(deferred-quiet or active-backoff, the only two outcomes the full path
determines without message content) → or the full read exactly as today,
followed by `record()`. Scan epilogue prunes baselines to the visited set.

Load-bearing decisions:

- **Derive, don't sync** (single source of truth): the stamp is computed
  from durable rows on demand. No writable counters, no invalidation
  hooks, no nonces, no tombstones — restart, reopen, deleteBee cascade,
  and bee re-creation are all correct by derivation (a recreated bee
  matches a baseline only when both states are empty, which IS content
  equality). The one alternative with O(1) probes needs all four of those
  mechanisms (see Alternatives).
- **Committed-only publication encoded at the source** (per
  boundary-discipline): the core method returns `null` in-transaction —
  the parent's uncommitted-reuse counterexample is excluded at the type
  level rather than by caller discipline. Today's tick-driven scan never
  runs in a transaction; the null arm is the proof that reentrant or
  embedded callers cannot poison a baseline anyway.
- **Skips only where the full path is content-independent given an
  unchanged stamp.** Deferred-quiet: identical recomputed signature would
  hit the :148 continue. Active backoff: identical signature revalidates
  bookkeeping and the decision's backoff branch fires before any content
  branch. Backoff EXPIRY falls through to the read on purpose — the full
  path would generate and needs `userMessages`/`initialTask`, which only
  the real read (JS normalization, unclamped initialTask) can produce. No
  approximation of normalization anywhere, so the refuted first-k/COUNT
  class of bugs cannot recur.
- **Signature tie**: a baseline is honored only if
  `bookkeeping.signature === baseline.signature`, so sidecar rewrites,
  restores, or loss force a read. The sidecar format itself is untouched
  (persistence stays unapproved).
- **Interface depth**: public surface grows by exactly one read-only core
  method plus one optional dep; the gate, its map, pruning, and the
  stamp's SQL are all hidden. Daemon keeps every normalization/policy
  fact; core exposes one durable-fact read, in the same family as
  `hasUndeliveredMessages`. No generic cache framework, no pass-through
  layer.

What the design deliberately does not do: change detection latency or
fairness (every bee is still considered every scan; only the proven-silent
re-read is elided), touch the sidecar format, persist anything, cache
message contents, or special-case giants.

Module map (complete): `v2/core/src/types.ts` +1 branded type;
`v2/core/src/store.ts` +1 read-only method (two cached aggregates);
`v2/daemon/src/autoTitle.ts` +1 optional dep, the private gate
(evaluate/record/pruneToVisited around a private Map), and ~15 integration
lines in the walk; `createStoreAutoTitleDispatcher` +1 wiring line.
`naming.ts`, `daemon.ts` scan cadence, the sidecar format, and every other
module untouched.

Invariants encoded in types: the stamp is opaque and branded (callers can
only compare); `null` is the only in-transaction value (no speculative
stamp exists to leak). Invariants stated as maintenance constraints with
tests: bodies/ids immutable; committed AUTOINCREMENT never reused; the
stamp's two statements must keep riding the two partial indexes (plan
pins).

## Cost model (stated, to be measured, not assumed)

The stamp is O(that bee's index entries), body-free — not O(1). Arithmetic
on measured per-call numbers (labeled extrapolation): small-mailbox probe
is a few µs vs an 18 µs post-C03 read (modest ~2–3× per bee, on top of
eliminating the map/normalization allocation traffic); a 100k-history
giant's probe is the ~0.1–0.5 ms class vs ~130 ms (three orders). Fleet
steady state: 1,000 small deferred bees drop from ~18 ms to a few ms per
scan; one giant in backoff drops from ~130 ms to sub-ms. Adverse workload
called out honestly: N simultaneously-untitled giants cost N probe scans
per scan (~0.3 ms each) — 100 such bees ≈ 30 ms/scan, still ~400× under
today, but this is the scenario that would justify the rejected O(1)
alternative; the measurement plan prices exactly this shape. Retained
state: two strings per active untitled bee, pruned every scan, size
exposed for measurement.

## Synthesis decision

Left to the parent cross-judge; this package is one independent candidate.

## Tradeoffs accepted

- We accept O(index entries) probe cost per un-skipped-or-gated bee per
  scan in exchange for zero new writable state and correctness by
  derivation (no commit hooks, nonces, tombstones, or lifecycle coupling).
- We accept one new read-only CoreStore method in exchange for keeping SQL
  out of the daemon (the architecture contract; the daemon has no raw DB
  seam and must not gain one).
- We accept an optional dep (inert-when-absent) in exchange for not
  breaking existing custom-deps constructors and fixtures.
- We accept a one-fleet-read warm-up after dispatcher restart (baseline map
  is process-local) in exchange for having no persisted state to
  invalidate, migrate, or restore.

## Alternatives considered

- **Core-owned in-memory change counter (event-driven invalidation).** A
  per-bee stamp Map in CoreStore bumped on committed send/cancel/cascade
  (pending-set flushed at outer commit, discarded on rollback), plus a
  store-instance nonce, plus tombstone-or-drop handling for
  deleteBee-then-recreate, read as O(1). Wins the adverse many-giants
  workload decisively. Loses on authority and invariant surface: it adds
  writable ephemeral state to core with a commit-boundary contract, an
  invalidation protocol (nonce + delete semantics — a dropped entry plus
  an empty-mailbox re-creation is a genuine wrong-skip hazard the
  tombstone exists to fix), and cross-module lifecycle coupling — four
  mechanisms replacing zero, for a fact that durable rows already answer.
  Interface depth is worse than it looks: the counter's meaning leaks into
  every mailbox write site. Documented as the explicit escalation path if
  the measured adverse workload demands it; the gate's seam (one dep)
  admits it as a drop-in later.
- **Status quo.** Post-C03 a 1,000-bee small fleet costs ~18 ms per scan
  inside the tick span — tolerable; one giant in backoff costs ~130 ms per
  scan sustained through any provider outage, unbounded by anything —
  rejected on that quantified residual.
- **Bounded scan budget / rotating cursor.** Bounds worst-case scan cost
  for any fleet, but converts cost into detection latency and reorders
  fairness — both explicitly frozen in this unit. Rejected here;
  orthogonal and compatible later.
- **Persisted sidecar (max,count) baseline.** Survives restarts, but
  persistence is unapproved and brings restore/import, stale-sidecar,
  version-compatibility, and committed-only-publication obligations into a
  durable format. Rejected: all of the value with none of the obligations
  exists in the in-memory baseline.
- **Fixed first-k + SQL COUNT shortcut.** Already refuted (decision flips
  under envelope-only rows; row count ≠ nonempty-clamp count; initialTask
  is unclamped). Listed to mark it dead, not as a contender.

## Test and measurement plan

Tests (cheap, focused; executable counterexamples first):

1. Core stamp: mutation truth table on a real store (send / cancel-highest
   / cancel-old+send-new / send+cancel-same / markDelivered / expedite /
   rollback / deleteBee cascade / delete-then-recreate-empty vs non-empty
   / reopen) asserting stamp movement exactly tracks membership change;
   `null` inside `transact` (both nesting depths); plan pins on the two
   aggregates riding `mailbox_pending_metadata` and
   `mailbox_delivered_by_bee`; the uncommitted-reuse counterexample
   replayed against the gate (baseline can never capture a speculative
   stamp because none is ever returned).
2. Dispatcher gate (counting stub deps, real dispatcher, my scan-study
   harness shape): deferred fleet reads drop to zero after one warm-up
   pass while outcomes/saves/probes stay byte-identical scan-for-scan with
   an ungated control dispatcher; active-backoff quiet with reads elided;
   backoff expiry still reads and generates on schedule (launch context
   equality asserted against the control); mid-backoff send forces a read
   and the retry-budget reset matches control; envelope-flood bee stays
   deferred-quiet with zero reads; absent dep ⇒ counts identical to
   control everywhere; baseline map size equals the untitled-active set
   and shrinks on title/archive/delete (prune bound).
3. Semantics parity sweep: run gated vs ungated dispatchers over
   randomized-but-seeded scenario scripts (sends, cancels, deliveries,
   titles, deletions, restarts) asserting identical outcome streams,
   sidecar contents, and saveState sequences — the "no observable
   behavior change" claim as an executable property.

Measurement (parent-owned; isolation-valid per campaign discipline):

- Stamp microbench vs listMessages per-call at 0/20/1k/100k rows on the
  statement-cache-ruler pattern (distinct-module A/B, ABBA, cold/warm
  separated, allocation profile separate) — prices the probe honestly,
  including the adverse giant.
- Fleet scan CPU: 1,000-small-deferred, 1-giant-backoff, and the adverse
  100-giant-backoff fixtures, gated vs ungated, same-boot pairs + A/A —
  the 30 ms adverse figure is a hypothesis until this runs.
- Retained-state gauge: baseline map entries and bytes across the ramp and
  steady state (bound: O(untitled-active)).

## Open questions and risks

- Is the adverse many-giant-fleet cost (probe O(entries) × N giants)
  acceptable to defer until measured, with the core-owned counter as the
  named escalation, or should that alternative be built first despite its
  authority cost?
- Is one optional dep the right compatibility posture, or should the gate
  be unconditional with test fixtures updated (smaller surface, more test
  churn)?
- `MAX(id)` per arm relies on committed AUTOINCREMENT monotonicity — the
  fidelity study proves it today; does the team accept the paired
  maintenance test as sufficient protection against a future id-reuse or
  body-edit feature?

## Next implementation step

Implement `mailboxMembershipStamp` with its two cached aggregates and the
mutation-truth-table test, since every other piece composes against that
fact.
