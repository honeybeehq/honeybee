# Review — scripts/perf/quiet-tick.mjs + six quiet evidence files

Scope: measurement/provenance/cleanup flaws that could invalidate before-after
CPU/allocation claims. Read-only; tool at recorded hash `9e739ffe…` (current
bytes match all four recorded toolHashes — the 07:50 mtime is the copy, not an
edit). All four profile sidecars verified against their recorded sha256:
MATCH. Baseline revision `343289fe` and the three source hashes are identical
across Studio and mini reports, so both hosts measured bit-identical code.

## Verdict

The tool is unusually honest (state-digest quiet invariant, single end-of-run
report write, tmpdir cleanup in `finally`, scope disclaimer). The evidence set
is usable **iff** all before-after deltas pair mini-vs-mini captures and the
comparison is mechanized. Three blockers below; none require re-capturing the
mini baseline.

## Blockers (invalidate claims if not addressed)

**B1. Studio CPU numbers are contention-inflated ~5.5× and must not anchor any
delta.** Same workload (1000×1, 30 samples), same revision, same tool:
Studio timing-mode cpuMs p50 = 18.006 (wall 375!) under loadAfter ~53–59;
mini cpuMs p50 = 3.256 (wall 3.13) under load ~1.6. M4 Max vs M4 P-cores and
Node 25.8 vs 24.18 cannot explain 5.5×; CPU time is not contention-immune on
macOS (E-core scheduling under QoS pressure, cache/TLB pollution are billed as
user time). Consequences: (a) the 682.6ms/722.7ms figures and the earlier
decisions.tsv "median CPU 17.944ms" are Studio-inflated absolutes; (b) the
*share* claim survives on both hosts (snapshot = 94.4% Studio, 96.6% mini) and
is safe to cite; (c) canonical before = `mini-quiet-timing-before.json`
(absolute CPU) + `mini-quiet-profile-before.json` (share/allocation); after
must be captured on the mini, same Node 24.18, load ≈ idle, or on an idle
Studio with a fresh same-host before.

**B2. No enforced pairing for quiet-tick reports — and hostname does not
discriminate the hosts.** `compareReports` (report.mjs) fits only the run.mjs
schema (`results`/`workload.scenarios`; it throws on quiet-tick reports), so
quiet-tick deltas will be computed by hand. Both machines report
`hostname: "Mac.home"`; only `cpu` (M4 vs M4 Max), `node`, and `bootIdentity`
distinguish them, and filename prefixes are convention. One mixed-host or
mixed-mode division silently fabricates a result. Fix: a quiet-tick-aware
compare that asserts `completed === true`, `workload` deepEqual (including
`mode`), `environment.{node,platform,arch,cpu}` equal, `toolHashes` deepEqual,
and prints both `bootIdentity` hashes; refuse timing-vs-profile comparisons.

**B3. Provenance cannot see uncommitted changes or hot files outside the hash
set.** quiet-tick reports record no `git status`/diff (run.mjs does), and
`sourceFiles` hashes only store.ts, schema.ts, loops.ts. The measured path
also executes `v2/core/src/view.ts` (deriveBeeView — inside the snapshot cost
being attributed), `v2/core/src/tasks.ts` (taskSupplyLoop gate helpers), and
`v2/daemon/tests/helpers.ts` (FakeDriver, the per-tick observe path). An
after-capture with uncommitted edits to view.ts would present identical
provenance to baseline. Fix: record `git status --porcelain` plus a sha256 of
`git diff`, and extend sourceFiles with view.ts, tasks.ts, helpers.ts. Note
the accepted design changes only loops.ts (covered), but the tool shouldn't
rely on that.

## Nonblockers (fix or note; do not invalidate the mini baseline)

- **Tool untracked.** `quiet-tick.mjs` is `??` in the worktree; toolHashes
  protect integrity, but commit the tool before after-captures so tool and
  code tie to revisions.
- **Sidecar/JSON mismatch window.** Profiles are written *before* the
  state-digest assert; a failed run leaves fresh sidecars beside a stale JSON.
  Recorded `profiles[].sha256` detects this — keep verifying it when consuming
  (done here: all MATCH). Cheap tool fix: write sidecars after the assert.
- **No start timestamps / loadBefore.** Only end timestamps exist;
  mini-timing (06:02:25.531) and mini-profile (06:02:25.897) ended 0.37s
  apart, so the two runs likely overlapped or ran back-to-back within a
  second — invisible either way. Record startedAt + loadBefore/After; prefer
  strictly sequential captures.
- **Mini profile paths point at the mini's staging dir**
  (`/private/tmp/honeybee-perf-5763a6c9-20260907/evidence/…`); in-repo copies
  verified by hash. Staging-dir cleanup on the mini is not evidenced (harmless
  /tmp). Consider rewriting `profiles[].path` to basenames at copy time — or
  just keep hash-verifying.
- **Environment capture gaps.** No `process.execArgv`/NODE_OPTIONS/compile-
  cache record (`--expose-gc` is asserted but not recorded); Node 24 vs 25
  also differ in type-stripping. Subsumed by B1/B2's same-host-same-node rule;
  record execArgv anyway. Add a hardware discriminator (e.g. `hw.model`) —
  bootIdentity proves same-boot, not same-machine across reboots.
- **Fixture representativeness (fine for this claim; state it).** Zero flags,
  mail, tasks, commands; `boot()` never runs; FakeDriver drains empty arrays
  where HsrDriver does real work. Good isolation of DaemonCore mapping cost —
  don't extrapolate to whole-daemon CPU. Also: seeding marks every generation
  exit `clean` from `booting`, so at generations ≥ the spawn budget the
  20/200-gen scenarios may carry `spawn_failed` flags into the roster (deterministic
  and identical before/after, but explains flag-scan/I1 differences *between*
  scenarios — don't attribute that delta to code).
- **After-state measurement floor.** Post-optimization steps (~sub-0.1ms) make
  the per-sample overhead (2× cpuUsage + 2× perf.now, µs-scale) a low-single-
  digit % of the measurement and cpuUsage µs granularity quantizes samples;
  fine for a ≥10× claim, worth a sentence when reporting ~100× ratios.
- **Profile-mode share bias.** The heap sampler hooks fire on allocation, so
  allocation-heavy phases (snapshot) absorb slightly more profile-mode CPU;
  share claims are directionally safe (timing-mode absolutes exist), already
  half-covered by the scope note.
- **Partial run.mjs capture is handled correctly** (decisions.tsv retains it
  as failed; compareReports would reject it as incomplete). Add one evidence
  index line marking `quiet-before.json` partial+contended and
  `mini-core-before.json` as the complete suite, so nobody re-cites its
  core-1000x1 CPU (it happened once in the early decisions row).

## What is solid (keep)

State-digest before/after assert (also proves the quiet fixture writes
nothing — the exact precondition the snapshot-reuse design depends on);
mkdtemp + `rmSync` + `store.close()` in `finally`; one atomic report write at
end (`completed: true` only on success); warmup then phase-reset then forced
GC; frozen clock for determinism; per-file source/tool sha256s; bootIdentity;
the scope disclaimer separating profile-mode timing from timing-mode.

## Minimal fix set before the after-capture

1. Capture after-runs on the mini (same Node 24.18, idle), timing + profile.
2. Add status/diff + view.ts/tasks.ts/helpers.ts hashes to the report (B3).
3. Mechanize the quiet-tick before/after compare with the B2 asserts.
4. Commit quiet-tick.mjs; add startedAt/loadBefore while touching it.
