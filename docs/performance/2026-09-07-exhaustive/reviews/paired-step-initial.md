# Review — scripts/perf/paired-step.mjs (untracked, 127 lines)

Static read-only review at current bytes; no runs. The self-paired design is
the right shape: one process, two roots, byte-copied identical databases,
ABBA interleave with recorded order, cross-side state asserts, source
re-fingerprint after capture, per-scenario tmpdir cleanup, no output file on
failure, honest scope string. Machine pairing and capture overlap are
non-issues by construction. Remaining findings, ranked.

## Blocker-level (can bias or invalidate specific claims)

**1. Write-phase JIT warmup is asymmetric against the after side (A/B only).**
Seeding runs entirely on `modules[0]` (line 58) — before-side `createBee`/
`reviveBee`/`updateRuntimeState`/`send` execute thousands of times before
measurement. In an A/B run the after side's copies of those functions are
first executed inside its first *measured* `writeRaw` sample (line 103; the
3-step warmup at line 85 warms only the step path, which is symmetric).
Early after-side write samples pay interpreter/tier-up cost; at `rounds=3`
(n=6/side) cold samples can dominate p50, at 15 they thin the tail but still
bias one direction. Fix: run 1–2 unmeasured write batches per side before the
measured loop (mirroring the step warmup), or discard the first K write
samples per side. Note `firstOpen` has a milder analog (before-side open path
has 2 prior calls, after-side 1) — dominated by SQLite DDL, acceptable.

**2. State-equality gates exclude audit and meta (store.ts:4252), so audit
parity and schema-version drift are unchecked.** The asserts at lines 73, 90,
104 and the quiet-invariance hash at line 91 all use `dumpState`, which
"excluded" audit/meta by design. Consequences: (a) a candidate that writes
extra/missing/different audit rows — including audit writes during *quiet*
steps — passes every gate, though audit is consumed by mirror/watch and is
the ecosystem's change-version; (b) a candidate that bumps `schema_version`
or migrates on open is invisible, which matters for the index claim's deploy
story (an older daemon refuses a newer-stamped store). Fix: add
`lastAuditSeq()` equality plus an audit-table hash to the cross-side asserts
and to the side-0 quiet check (also assert side-1's own audit seq is
unchanged across the quiet phase); record each side's schema_version and
`sqlite_master` index list in the report so `closedBytes` deltas are
attributable to named indexes.

**3. A same-root A/A control shares module identity and JIT warmth — it
cannot expose the noise classes above.** With identical roots, the two
`import()` URLs (line 33) hit the module cache and both "sides" are the same
compiled functions: warmup is shared, ICs are shared, and finding 1 is
structurally invisible. The A/A currently running is a valid harness/clock
noise floor, but it under-measures the dual-module A/B regime. Run the
noise-floor A/A with two byte-identical checkouts at different paths
(the source fingerprints will still assert equal), at the same `rounds` as
the A/B run. The report already records both roots, so same-root runs are
detectable after the fact; consider also recording
`modules[0].DaemonCore === modules[1].DaemonCore` explicitly.

## Should-fix (interpretability/provenance)

- **firstOpen is n=1 per side** (line 71, scope admits it). Publish open-cost
  claims from `repeatOpen` p50 (n=5) and present firstOpen only as the
  one-shot index-installation cost; never as an open-latency delta.
- **Tool hashes are computed only at report time** (line 122) — a mid-run
  edit to paired-step.mjs records the edited hash. Fingerprint the four tool
  files before the run and re-assert after, as quiet-tick does for source
  (line 113 covers source only).
- **No per-root `git status`/`diffSha256`, and no expect-changed manifest.**
  Dirty-worktree visibility rests on eyeballing the two full hash maps.
  Mirror the quiet-tick R3 fix in two-root form: assert the sides' hash maps
  differ only in an explicitly listed file set (A/B), or are identical (A/A).
- **Environment parity gaps vs quiet-tick schema 2:** `logicalCpus`,
  `NODE_COMPILE_CACHE`, and the NODE_OPTIONS sha are absent (execArgv is
  recorded).
- **repeatOpen runs 5× side 0 then 5× side 1** (line 107) — interleave ABAB
  like the other phases for drift symmetry.
- **`closedBytes` fragmentation caveat:** identical data is asserted, so the
  size delta ≈ index bytes ± page-allocation noise from interleaved index
  maintenance. Recording `freelist_count`/`page_count` per side would make
  the storage number clean; at minimum keep the claim order-of-magnitude.

## Nonblockers / observations

- **Held-mail fixture is correct for its purpose.** The holder is revived to
  `running` with `bootEvidence: 'real'` (updateRuntimeState booting→running
  without `synthetic` ⇒ 'real'), so all 1000 `idle` messages are permanently
  ineligible (`trulyMidTurn` filter) and the I1 clock is suspended — steps
  stay write-free, which line 91 then proves. The 1e12 deadline plus frozen
  clock makes the assert-fail I1 hook unreachable. Sound.
- **The rename-per-step scenario measures rename+step in one sample**
  (lines 82–83): the rename cost is a symmetric constant that slightly
  dilutes relative step deltas. Moving the rename outside `measure` (the
  rebuild still lands inside the measured step) would sharpen it; optional.
- **WAL-copy hazard is self-checking:** if `seed.close()` ever left a
  -wal sidecar, the byte copy would miss it and the line-73 identity assert
  would fail loudly rather than measure divergent stores. No action.
- **Shared-heap GC coupling:** one V8 heap serves both sides, so the
  allocation-heavy side's GC can bleed into the lean side's samples. ABBA +
  p50 + cpuMs largely absorb it; worth one line in `scope`.
- **Live-revive unarchives archived bees** (all-live: 900 archived bees
  become active via reviveBee's Q3 rule) — deterministic, copied identically;
  just know the all-live roster is 100% active, unlike the other scenarios'
  90/10 split.
- **Deterministic seeded flags:** at generations ≥ the spawn budget the
  retained scenarios carry `spawn_failed` flags (clean boot-exits count);
  revived live bees get theirs reset by the real-boot-evidence path. Copied
  identically to both sides; affects scenario realism, not validity.
- **Coverage suggestion:** every pending message sits on one bee. A
  `spread-mail` variant (e.g. 1000 live-running 'real' bees × 1 held idle
  message each) would exercise many-key pending grouping and the I1/delivery
  walks at breadth while staying write-free — the shape most relevant to a
  pendingByBee-driven after-implementation.
- **Operational:** don't run the A/A control and the fresh baseline capture
  concurrently on the mini — paired-step is internally robust to load, but
  cross-capture noise-floor comparisons want matched quiet conditions, and
  `rounds` should match between the A/A and the A/B being defended.

## Answers to the named concerns

- *live/held-mail fixture:* sound (see above); quiet invariance is proven by
  line 91 for side 0 — extend to audit/meta and side 1 per finding 2.
- *same source imported twice for A/A:* same root ⇒ same module instances ⇒
  shared warmth; use two identical checkouts (finding 3).
- *state equality:* strong on tables, blind to audit/meta (finding 2).
- *default 15 vs cheap 3 rounds:* n=2·rounds per side per phase; 3 rounds ⇒
  n=6, p95=max, and finding 1's cold samples can own the p50 — treat 3-round
  runs as smoke only; claims and their A/A floor should both use 15.
- *index storage/open claims:* valid shape (identical data asserted, index
  delta isolated); publish repeatOpen p50 for open cost, firstOpen as
  index-build one-shot, and add index-list/freelist provenance (finding 2 +
  should-fix list).
