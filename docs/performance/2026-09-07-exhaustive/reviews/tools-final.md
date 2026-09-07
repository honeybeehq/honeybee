# Final review — quiet-tick.mjs (schema 2), compare-quiet.mjs (+test), sql-trace.mjs (+test)

Static re-review at the current untracked script bytes; no builds, captures, or
test runs (parent reports 4/4 passing). Prior review's three blockers are
addressed and verified in source:

- B1 (pairing/conditions): `validateQuietPair` enforces schema 2, completed,
  workload+mode, toolHashes, node/platform/arch/cpu/logicalCpus/execArgv/
  compile-cache/NODE_OPTIONS-sha equality, same **bootIdentity** (with an
  explicit hostname-drift allowance, and hostname fallback only when both boot
  ids are absent), measured-interval non-overlap, and recomputes every
  distribution from raw samples so a doctored summary fails. Timing claims are
  refused for profile-mode pairs (`profiling overhead must not enter timing
  claims`). Schema 1 files are refused, so the retained Studio/mini schema-1
  evidence cannot leak into paired claims.
- B2 (comparator existence): compare-quiet.mjs exists, has a CLI with a
  distinct instrumented-attribution output shape, and 13 refusal paths are
  unit-tested.
- B3 (provenance): schema 2 fingerprints **all** v2 `src/*.ts` plus
  `v2/daemon/tests/helpers.ts` before imports, records `git status
  --porcelain` and a `git diff --binary HEAD` sha256, re-asserts source and
  ruler hashes after the capture, and buffers profile sidecars until the
  state-digest and fingerprint asserts pass (no orphan sidecars). Interval
  timestamps, loadBefore/After, and execArgv are recorded.
  `readQuietProfiles` re-verifies sidecar sha256 with a basename join, which
  also fixes the old absolute-path mismatch on copied evidence.

sql-trace.mjs is sound for its stated purpose: prototype wrapping with saved
descriptors restored in reverse in `finally`, nested/async/lazy-iterate use
refused loudly, bound values and row data never retained (tested), and the
header honestly scopes timing as attribution-with-overhead. Statement groups
merge across database instances — irrelevant for the single-store use, worth
one comment if it ever measures multi-store code.

## Verdict

**No hard blockers remain in capture or comparison correctness.** Three
should-fix gaps below could still let an invalid *claim* through under
operator error; each is a small addition to compare-quiet.mjs.

## Remaining items, ranked

**R1. The comparator never checks measurement conditions, only pairing.** A
timing pair captured under heavy load, swap, or background GC passes every
assert. The data already contains the detector, within each file (no
cross-machine inference needed): healthy capture wall≈cpu
(mini timing: wall p50 3.13 / cpu p50 3.26 ≈ 0.96×); degraded capture wall≫cpu
(Studio timing: 375.0 / 18.0 ≈ 20.8×). Add to `compareQuiet` (timing mode):
assert `wallMs.p50 / cpuMs.p50` below a bound (≈1.5×) for both files, and/or
`max(loadBefore, loadAfter) / logicalCpus` below ~1. Without this, the
condition that invalidated the Studio numbers is still only guarded by
operator discipline.

**R2. Non-overlap uses measurement intervals only.** Two concurrent runs where
A measures while B seeds/imports/profiles contend for CPU yet pass the check
(the two schema-1 mini runs ended 0.37s apart — exactly this shape). Schema 2
already records full capture bounds (`startedAt` … `timestamp`); tighten the
assert to full-interval non-overlap. One line.

**R3. Attribution is recorded but not enforced.** `validateQuietPair` verifies
hash presence/format, not *which* files changed: an after-capture with stray
uncommitted edits (say store.ts) alongside the intended loops.ts change passes,
and the delta gets attributed to the intended change unless someone eyeballs
`beforeSource`/`afterSource.hashes`. Add an optional `--expect-changed
v2/daemon/src/loops.ts[,…]` that asserts source hashes are equal for every
file NOT listed, differ for listed files, and that neither `status` contains
modified tracked `v2/` entries. Until then, treat the hash-diff eyeball as a
mandatory review step for any published delta.

## Nonblockers / nits

- The comparator doesn't fingerprint itself; its output records both captures'
  provenance but not the compare tool's own sha256. Add `comparatorSha256` to
  the output for a closed chain.
- All five scripts are still untracked (`??`). toolHashes equality keeps pairs
  honest; commit the ruler with the implementation so evidence ties to
  revisions.
- `readQuietProfiles` sums raw `selfSize` — unscaled *sampled* bytes, not an
  allocation estimate. Comparative use with identical samplingInterval is
  valid and the scope string says "sampled"; small after-state allocations will
  be sampling-noise-dominated, so report allocation deltas as order-of-
  magnitude, not precise percentages.
- Same-boot pairing means a mini reboot between before and after refuses the
  pair (re-capture before; conservative and correct — just plan captures
  accordingly).
- Consider one A/A control (capture baseline twice, compare) on the mini to
  document the noise floor before publishing the A/B delta; `compareQuiet`
  supports this as-is (same revision is permitted).
- `NODE_COMPILE_CACHE` equality is strict path equality; differing cache paths
  between runs refuse the pair (over-strict but safe).

## Test coverage read

compare-quiet.test.mjs: refusal matrix covers machine, boot, boot-absence,
node, mode, tool, completeness, sample-count, doctored-summary, missing
source hash, interval-order, bad timestamp, and profile-pair timing refusal;
positive path covers zero-baseline null delta and hostname drift. Suggested
additions if R1/R2 land: a contended-file refusal case and a full-interval
overlap case. sql-trace.test.mjs covers counting, byte accounting, privacy,
restoration after failure, lazy-iterate and nested refusal — matches the
implementation's risk surface.
