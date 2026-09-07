# C03 statement-cache ruler review — read-only (no edits to the ruler)

Subject: `/tmp/honeybee-mailbox-statement-cache-ruler.mjs` (57 lines), reviewed
against the c03 worktree source at b14f8df4. Verdict at the end.

## Verified sound

1. **Provenance.** Clean-tree fingerprint over runtime sources (src .ts +
   package files) on BOTH roots with the diff-set asserted to be exactly
   `v2/core/src/store.ts` (empty for control); re-fingerprint, tool re-hash,
   sql-trace re-hash, and same-boot-session re-check at completion (:54);
   report-exists guard, incremental save, failure capture with stack, load
   averages recorded before/after. Distinct-roots assert (:12) plus
   distinct-module assert (:17) hold for A/B and control alike.
2. **Fixture validity.** Public transactional seeding — createBee with a
   fixed UUID/handle, updateRuntimeState to running (pid is optional in the
   public signature; legal transition — and the Mini smoke exercised it),
   64-byte sends at idle urgency, every-non-third markDelivered → 2/3
   delivered + 1/3 pending, so BOTH union arms carry rows in every non-empty
   scenario, matching the C10 read shape. Frozen `now()=1000` on both sides.
   The seed is built once via the before-module, then BYTE-copied to each
   side and sha-verified (:32-33): identical closed files, no
   build-the-fixture-twice drift. Scenario grid (empty/20×1000 calls,
   1000×20 calls) covers pure-prepare, autoTitle-typical, and
   row-dominated shapes.
3. **Counts.** Cold first read captured per side in its own `captureSql`
   BEFORE warmup: SQL text equality across sides, exactly one prepare per
   side (correct for both shapes: per-call prepare vs first cache miss),
   row equality across sides plus a per-id getMessage PK oracle. Warmed
   diagnostics run AFTER the timed rounds, in a separate capture: prepares
   = calls on the before side, 0 on the after side (calls/calls for
   control), exactly one read-statement with exact call and row counts.
   Mechanism is verified without ever contaminating the clocks. Every
   warmup and timed batch asserts the row total.
4. **Warming.** Three full ABBA rounds (6 batches/side) precede timing —
   JIT, GC, page cache, and the after-side statement cache are all warm
   entering the measured loop; the post-timing 0-prepare diagnostic
   retroactively proves the cache held through it.
5. **Timing and stats.** Whole-batch `cpuUsage`+wall via one measure()
   (asserts outside the clock), ABBA within each of 15 rounds → 30
   batches/side; per-call values derived from batch totals (no per-call
   clock granularity noise); raw samples retained alongside p50/p95/min/max.
6. **Read-only proof.** dumpState+audit hash equal across sides at open,
   unchanged at close, and rows re-equal the cold capture (:50).
7. **Instrumentation.** sql-trace wraps the SHARED builtin
   `DatabaseSync.prototype` (:21-24, :56 of the tool), so both root
   modules are instrumented identically; the tool is hash-pinned before
   and after.
8. **Profile mode.** Optional, strictly after the headline loops, separate
   capture; collected objects included; sidecars sha256'd; the scope
   string honestly bounds it (sampled allocation traffic, not retained or
   native SQLite memory) and disclaims fleet/RPC/title-provider claims.

## Non-blocking nits (take or leave before canonical)

1. The cold capture asserts prepare-count 1 but not `reads.length === 1`
   (the warmed diagnostic does); one extra assert would make the cold and
   warm shapes symmetrical.
2. Environment records node/cpu/boot but not `sqlite_version()` — one row
   would complete cross-run provenance.
3. Pre-agree interpretation labels: EMPTY per-call CPU delta is the
   headline (pure prepare+seek, no row work); TWENTY is the
   autoTitle-typical shape; THOUSAND is the dilution/regression check
   (prepare cost amortized under 1000-row mapping — expect the smallest
   relative delta there, and that is the expected reading, not a miss).
4. The fingerprint deliberately excludes tests/scripts (runtime-only
   guard); one clause in the scope string would prevent a reader from
   assuming test drift is also gated.
5. The thousand-scenario profile samples only 20 calls at 4096-byte
   intervals — fine as an optional diagnostic, worth labeling
   low-resolution.
6. For the record: `stmt()` is an unbounded Map keyed by SQL text
   (store.ts:1333-1339), so the single-entry warm path the ruler measures
   is the only path there is — no eviction dimension exists.
7. Boundary worth one sentence somewhere: the ruler measures the
   steady-state cache-HIT path; the MISS path appears only in the cold
   diagnostic (excluded from clocks). Correct for the daemon's long-lived
   store; short-lived-store fleets are out of scope and the scope string
   already disclaims them.

## Verdict

APPROVED for canonical as-is; the nits are optional hardening, none
measurement-affecting. Fixture, counts, warming, and interpretation
framing are all sound for the C03 question: per-call re-prepare cost vs
cache hit on byte-identical SQL, with the mechanism proven out-of-band on
both sides.
