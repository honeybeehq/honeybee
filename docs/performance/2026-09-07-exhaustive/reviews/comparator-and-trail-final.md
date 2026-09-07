# Review — compare-read-hotspots.mjs (+test) and the decision trail

> **Updated with the final audit below** (see "Final audit", end of file): the
> trail gap is closed, both writeups verified against evidence, and the
> "persist the A/A wrapper output" item is WITHDRAWN — it was already
> persisted; I had checked the wrong file. No open items remain.

Read-only; no captures. Wrapper and test read in full at the execution
worktree; trail cross-checked against tracker.csv, README.md, designs/,
reviews/, verification/, and the guard evidence files.

## Comparator wrapper: both prior gaps closed, no blockers

My two should-fix items are closed stronger than asked: `completed === true`
AND `failure === null` at both report and per-scenario level (lines 13–14,
29–30), and toolHashes equality (line 41) plus per-file format validation.
Every property the wrapper claims is actually implemented:

- **Complete success per report/case** — report + scenario completed/failure
  checks; scenario list must match the embedded plan ids (line 27).
- **Identical tools/boot/environment/workload** — toolHashes deepEqual;
  bootIdentity *required* and deepEqual (same-boot pairing — strictest ruler
  yet, and it elegantly subsumes the uncompared release/osVersion: same boot
  ⇒ same kernel); logicalCpus/execArgv/nodeCompileCache/nodeOptionsSha
  explicit plus node/platform/arch/cpu/hostname via the inner
  `compareReports`; workload deepEqual carries samples, scale, and every
  fixture size.
- **Raw-summary parity** — metrics recomputed from raw per scenario with
  sample-count and finiteness checks (line 37); forged-raw and popped-sample
  refusals are unit-tested.
- **Nonoverlap** — full capture intervals (`startedAt`…`timestamp`), the
  paired-step lesson applied (lines 51–52), plus per-scenario intervals
  validated inside the report's measurement window (lines 31–33).
- **Explicit exact committed source changes** — expected list is a required
  argument (empty string = A/A zero-drift mode, forced intentionality),
  committed-v2 enforcement via porcelain match, changed set computed from the
  union of hash keys (handles added/removed files) and deepEqual'd.
- `timingInstrumentation === 'none'` gate blocks instrumented captures from
  timing claims; CLI output self-fingerprints (`comparatorSha256`), closing
  my last provenance nit.

Test matrix: a positive A/A control with zero deltas, an explicit
single-file delta, and 15 refusal paths (incomplete/failed at both levels,
tool drift, boot drift, execArgv/cpu drift, dirty status, unexpected source
change, overlap, forged raw, sample loss, scenario rename, instrumented
timing). 2/2 as reported.

Nonblockers: (a) hostname equality (via compareReports) is stricter than the
quiet comparator's same-boot hostname-drift allowance — a mid-session macOS
network rename would false-refuse; fails safe, just inconsistent between
rulers. (b) bootIdentity-required refuses cross-reboot pairs by design —
plan captures accordingly. (c) trivial refusal cases not enumerated
(nodeCompileCache drift, scenario interval outside window) ride mechanisms
already tested.

## Guard evidence spot-check (supports the upcoming writeup)

The strict quiet pair (`mini-quiet-audit-none-guard-comparison.json`) is
exactly what the comparator promises: expected == changed == the three
production files, comparator fingerprinted, quiet 1000×1 cpuMs p50
3.241 → 0.022 ms (−99.3%) with wall ≈ cpu on both sides. The daemon
scorecard's daemon-0 rows corroborate directionally (idle one-core
−4.5%, ELU −11.3%, RPC neutral, spawn/send neutral) at a small fleet.
Tracker D02 is honestly dispositioned "optimized partial; continuation
open" with costs stated (lifecycle write +4–8% CPU, 4–24 KiB storage).

## Decision trail: one real gap

**decisions.tsv stops at 06:28:56 (5 rows) — roughly 2.5 hours behind the
work it governs.** Missing rows for: the cross-judge direction choice
(designs/crossjudge.md exists, undated in the log), the paired-step review
fix round, the production guard commit + independent approval + verification
logs, the guard measurement acceptance and D02 partial disposition, the
read-hotspots ruler + canonical n15 baseline + this comparator, and the A/A
protocol. README and tracker currently carry that narrative, but the log's
own charter ("records failures, choices, and evidence") and the writeup's
citations want TSV rows appended — without rewriting the earlier entries,
per the retention policy. This is the only trail item I'd gate the writeup
on.

Accuracy checks that passed: the README's Mac.home/no-cross-machine
language, the failed-capture retention wording, the sequentiality claim (now
backed by the stored remote command sequence rather than timestamps), the
canonical-baseline designation, and the threshold-declined rationale (row 5)
all match the evidence on disk.

## For the first-unit writeup (recommendations, not blockers)

1. Headline from the strict pair only: 3.241 → 0.022 ms (−99.3%), same
   boot, expected-changed exact. Don't mix baselines: mini-core-before's
   3.045 ms (schema-1 ruler) and the audit-none 3.241 ms (schema-2 pair) are
   different fixtures — cite the paired one for the delta, the other as
   corroboration.
2. Label which daemon scenario backs "9.715 → 0.467% one-core" — the
   daemon-0 scorecard rows I read show the small-fleet variant (−4.5%); the
   headline number presumably comes from a larger-fleet scenario in
   mini-daemon-after-guard.json. Name the scenario per claim.
3. State n=1 explicitly for `daemon.startToHello` (+16% includes the
   one-time index install; single sample, not a regression claim).
4. Keep the stated scope: fully-parked hives only; sparse-live and held-mail
   remain open (D02 continuation; cross-judge's fresh sparse-live projection
   + linear pending metadata is the accepted next direction).
5. Hold the writeup's comparison section until the running A/A lands, or
   mark it pending — the A/A is the noise floor the −99.3% claim cites
   against.
6. Cite the correctness gates as run: K1/K2/K3, core/list-views rollback,
   daemon timed policies, the unit.0a–0e + time-boundaries suite, and the
   independent production review.

---

# Final audit — writeups and trail (post-draft)

## Decision trail: gap closed

Eight rows appended (07:19:37–41Z batch), each with why/evidence/result:
paired-warmup fix + distinct-checkout A/A, guard integration as `9e0eb194`,
reverse-order daemon repeat, the 24-case canonical read-hotspots run, the
integration-timeout retention ("no claimed pass; targeted rerun follows"),
the strict comparator, the Apiary-timeout coordination note, and a
paired-core CLI misinvocation correction. The log now records its own
failures alongside choices — exactly its charter. Trail item resolved.

## empty-snapshot-results.md: verified, honest, publishable

Every number I could check matches evidence exactly: quiet strict pair
3.241→0.022 ms CPU / 3.093→0.02175 ms wall (comparison JSON); sampled
allocation 107,752,872→329,368 B (profile comparison, correctly labeled
attribution-only); paired retained-1000 4.282→0.048 ms and retained-10000
44.110→0.042 ms (paired report rows). All six of my prior recommendations
were followed: strict pair headlines the delta; daemon idle claims name
their files and window counts with a reverse-order repeat (9.715→0.467%,
repeat 8.049→0.445%); startToHello stays n=1 with no inference; scope says
fully-parked-only with D02/D05/C22 open; the A/A is cited with real numbers
(quiet A/A +0.54% wall / +0.71% CPU; paired A/A retained-10k +9.73%
honestly flagged as the shared-heap GC limit, three-round run demoted to
smoke); gates and the production review are linked (docs/review file
exists). RSS/heap language is carefully bounded (no retained-heap claim).
Small-delta rows (−0.97%…+0.11%) are correctly presented as not
establishing speedups against the A/A floor.

## read-hotspots-baseline.md: verified

Spot-checked against the canonical capture (24 cases, n=15, `bcd85a8c`,
clean v2 status): D05 174.552 ms, C22 paused 28.467 ms, C18 eviction
0.242 ms — exact to the printed precision. Disclaimers are right
(microbenchmark costs, offline-seeded histories not replay evidence,
returned-text ≠ disk I/O), open work is enumerated, and the doc correctly
requires the strict comparator for any future before/after.

## Verification status — final, kept explicit (corrected)

Parent verification has ENDED; no rerun is ongoing. Final state: the full
unit run finished **153/154** — the one failure is the transport timeout
(Codex limits probe exceeding 3750 ms under Studio load) — and the isolated
rerun of that test passed **1/1**; serial/integration **164/164**; core
**182/182**; **32/32** perf tool tests (attribution: 30 authored by the
guard author, 2 added by the parent); both typechecks and the build passed.
The 153/154 full-run failure stays on the record explicitly per the
retention policy; the isolated pass does not rewrite it.

## Exactness item — WITHDRAWN (my error)

`mini-read-hotspots-aa.json` IS the persisted strict-wrapper comparison
output — verified top-level keys: purpose ("uninstrumented read-hotspot
timings"), rows (48 = 24 cases × 2 metrics), expectedChangedFiles []
matching changedSourceFiles [], comparatorSha256, before/after source and
environment blocks, toolHashes, workload. The raw unchanged-code control
capture is `mini-read-hotspots-control.json`. My earlier probe guessed a
different filename and then inspected only the control; the A/A pass was
citable all along. The per-case A/A rows also give each scenario its own
noise floor — the worst |delta| (~50% on a sub-0.01 ms case) confirms the
baseline doc's caution that sub-millisecond cases carry large relative
jitter. Trace sidecars remain un-deep-audited: the writeup makes no
headline claims from them (attribution-only), so exactness risk there is
low.

## Parent factual annotations

The 32 passing tool tests are the aggregate existing performance suite plus the new rulers and comparator. They were not all authored by the guard author. The control with approximately −50.5% CPU is the 1,000-command boot-recovery fixture (2.358 ms to 1.168 ms), not a sub-0.01 ms case. One A/A run demonstrates observed drift; it does not establish a statistical noise floor. Neither correction changes the approved production or comparator behavior.
