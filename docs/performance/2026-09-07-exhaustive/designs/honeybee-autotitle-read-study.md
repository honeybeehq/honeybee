# autoTitle listMessages call-count study — READ-ONLY (no production edits)

Lane: source at `honeybee-perf-c10-by-bee-2026-09-07` (a67a48bb; this module
identical to accepted main). Method: the REAL `createAutoTitleDispatcher`
driven by counting stub deps (no provider, no store, no daemon) in
`/tmp/honeybee-autotitle-scan-study.mjs`; every count below is
assertion-verified, output in `/tmp/honeybee-autotitle-scan-study.json`.
C10 stays frozen; this is follow-on hypothesis, not a title-behavior change.

## 0. My three corrected claims (for the record)

1. Active+untitled does NOT imply young/small — nothing bounds an untitled
   bee's mailbox; giant reads remain possible in autoTitle and the spawn
   fallback. My "autoTitle never reads such bees / giant is RPC-only" was
   wrong and is retracted.
2. The 8-probe cap does NOT bound listMessages calls: `probes += 1` sits at
   autoTitle.ts:158, AFTER both the deferred-signature `continue` (:148-151)
   and the decision `skip` continue (:157). Deferred and backoff bees are
   read on every scan without consuming any probe.
3. The scan runs at 1 Hz (`AUTO_TITLE_SCAN_MS = 1000`, daemon.ts:366, gate
   at :876), not 5/s — my earlier rate claim described the pre-throttle era
   the :139 comment memorializes.

## 1. Exact current semantics (line-cited)

Per scan (daemon.ts:879 calls `autoTitle()` argument-less; the dispatcher
body has no await, so the whole roster walk executes synchronously inside
the `daemon.tick.auto_title` span):

1. Drain finished outcomes; bail if disabled (:114).
2. If a generation is in flight and younger than 45 s: EARLY RETURN — zero
   reads (:117-119). The watchdog frees the slot after 45 s (:120-129).
3. `records = deps.listBees()` — full roster, store order (:132).
4. Walk records in order (:136):
   - `probes >= 8` → break (:137).
   - lifecycle/title pre-skip, no read (:143) — the 2026-09-01 fix; titled
     and archived bees really do cost nothing.
   - **`listMessages(bee.id)` (:144) — unconditional for every active
     untitled bee reached.**
   - deferred-signature match → continue, NO probe (:148-151).
   - decision `skip` (backoff or races) → continue, NO probe (:157).
   - `probes += 1` (:158) — only defer TRANSITIONS and generate launches.
   - defer → saveState + continue (:159-167); in the real wiring every
     saveState rewrites the whole JSON sidecar (:249-251).
   - generate → claim bookkeeping, occupy the single global slot, detach
     the provider call, **break** (:225) — at most ONE launch per scan.

## 2. Measured call counts (real dispatcher, exact)

| fixture (all active untitled) | 1 bee | 100 bees | 1000 bees |
| --- | --- | --- | --- |
| titled control | 0 reads ever | 0 | 0 |
| deferred (stable signature) | 1 read/scan forever | 100/scan | **1000/scan** |
| backoff (failed attempt) | 1/scan | 100/scan | **1000/scan** |
| empty mailbox (defers) | ramp→1/scan | ramp→100/scan | ramp→**1000/scan** |
| thin opener (defers) | same | same | same |

- The empty/thin RAMP: 8 defer transitions per scan (probe-capped), while
  already-deferred bees keep being read. 1000 bees: reads/scan grow
  8,16,24,… to 1000 over ~125 scans — 66,000 total reads and 1000 sidecar
  rewrites (8/scan) before steady state. Steady state is then 1000
  reads/scan, 0 probes, forever.
- Position decides everything: one generate-ready bee BEHIND 1000 deferred
  costs 1001 reads before its launch (then break); the same bee at the
  roster head costs exactly 1 read. While its generation is in flight,
  subsequent scans do 0 reads (early return) until resolve or the 45 s
  watchdog.

## 3. Cost tie-in (arithmetic on the parent's Mini per-call numbers)

Extrapolation, labeled as such — reads/scan × measured per-call CPU:

- 1000 deferred bees with SMALL mailboxes: pre-C10 3.744 ms/read → ~3.7 s
  per 1 Hz scan (the historical stall class the :139 comment describes);
  post-C10 0.032 ms → ~32 ms/scan. C10 makes the small-mailbox fleet shape
  survivable.
- ONE giant untitled deferred bee (100k delivered): ~129-136 ms CPU per
  read, EVERY scan, pre AND post C10 (C10 measured +5.45% there). At 1 Hz
  that is ~13% of a core for one bee, sustained, and it also sits inside
  the synchronous tick span. This is the parent-correction's bite and the
  real residual: C10 does not address it, and nothing bounds it today.

## 4. Scheduling / fairness constraints (current, to preserve or knowingly change)

- Single global generation slot; one launch per scan; launch breaks the
  walk. Roster order (listBees) is the only priority; a tail bee can wait
  many scans behind head bees' launches and in-flight pauses.
- Probe budget (8) bounds defer TRANSITIONS and launches, not reads.
- The deferred/backoff re-read is LOAD-BEARING: the signature (lifecycle,
  user-message count, first message text) is computed FROM the mailbox, so
  "has the task context changed" currently requires the full read. Any
  read reduction must supply an equivalent change signal or accept
  detection latency.
- In-flight pause doubles as a hidden throttle AND a hidden stall (up to
  45 s of zero detection under a slow provider).
- Sidecar write amplification: every defer/claim rewrites the entire
  bookkeeping JSON (8 writes/scan during ramps).

## 5. Measurable optimization candidates (hypotheses only)

Ordered smallest-first; none alter titling decisions unless stated:

- **C1 — bounded signature read.** The scan needs user-message count, first
  user message, and (only at launch) first non-thin + last 3. Replace the
  full-body listMessages in the SCAN path with cheap indexed statements
  (count + first-k), hydrating the full context only at launch. Collapses
  the giant-bee scan read (~130 ms → sub-ms) with identical decisions.
  Read-shape change only; C10's arms make the per-arm seeks cheap.
- **C2 — persisted change probe.** Extend bookkeeping with a last-seen
  mailbox high-water (e.g. max message id + count); a cheap probe decides
  whether the full read runs. Deferred fleets drop from N reads/scan to
  changed-bees/scan. Exact (the probe detects every change), adds one tiny
  probe per bee per scan.
- **C3 — read budget + rotating cursor.** Cap total reads per scan (e.g.
  64) and resume the walk where it stopped. Bounds worst-case scan cost
  regardless of fleet size and removes roster-order unfairness; the cost
  is bounded detection latency (N/budget scans worst case). Behavior
  change: latency only, explicitly.
- **C4 — event-driven dirty set.** The daemon owns every mailbox write;
  a dirty-bee set from send/cancel/deliver could shrink the scan to dirty
  + new bees. Exact but the largest structural change.

All need parent-owned measurement; the harness here gives the count side,
the parent's read rulers give the per-call side. No production edits, no
Mini, no broad tests, no worktree changes (scratch is /tmp-only).
