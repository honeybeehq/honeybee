---
name: perf-honeybee
description: Measure satellite Cell startup on metal or netcup using isolated Honeybee fixtures, map receipts and conservative comparisons. Use before optimizing remote Cell provisioning or runner readiness.
---

# Perf Honeybee

This map currently covers **satellite Cell startup**, not all Honeybee performance.
Read [the map](workloads/README.md) and [the workload](workloads/remote-cell-spawn.md).
Older subsystem recipes remain in [measure.md](../../../docs/performance/measure.md).

## The loop

Pick a metric, prove the recipe, baseline on an idle target, attribute separately,
predeclare acceptance, change, compare the same series, retain evidence. Never
compare metal against netcup as before/after, or a stub against a provider harness.
No latency budget has been ruled. Shared-host timings are recipe proof only.

## Launch and Doctor

Use Node **24.18.0** on an explicitly selected target. Confirm `node --version`,
`git --version`, host identity/load and `command -v bwrap` on Linux. Run the global
`perf/scripts/perf-tools-doctor.sh` there. Do not benchmark alongside builds/tests.
The runner creates its own daemon/socket/store, origins, Cells and stub agents;
it never uses the live daemon or provider credentials. No deployment is needed.

## Measure

From a source checkout outside `/tmp` with dependencies installed:

```sh
node scripts/perf/run.mjs --suite cell-spawn --cache warm --width 1 --sandbox on --samples 5 --out .proof/remote-cell-spawn/warm.json
node scripts/perf/run.mjs --receipt --from .proof/remote-cell-spawn/warm.json --out .proof/remote-cell-spawn/warm.receipt.json
```

Run `--cache cold` and `--width 4` separately. Cold means a new repository fixture,
not cold OS caches. Run on `trmd-metal-1` and `netcup-1` as separate populations.
The sandbox stays on; `--sandbox off` is a diagnostic population only. Five samples
support a median; collect twenty batches for tail analysis. See the workload for
transport and provider gaps. `--profile-dir` is attribution, never baseline timing.

## Compare

```sh
node scripts/perf/run.mjs --compare --before before.json --after after.json --out comparison.csv
node scripts/perf-map.mjs check .proof/remote-cell-spawn/warm.receipt.json
```

The comparator requires identical host/runtime/workload. Receipts reject incomplete,
failed, instrumented or inconsistent captures. A passing invariant is not a speed win.

## Evidence and Cleanup

Raw reports and failures go under `.proof/remote-cell-spawn/`, uncommitted. Retain
compact baseline receipts in `docs/performance/` only after an idle-host baseline.
Normal completion and SIGTERM stop owned runtimes and verify runner exit before
removing fixtures. SIGKILL cannot clean up; retain the reported fixture path and
use exact run ownership for recovery. Never signal by process name.

## The map and Helpers

`node scripts/perf-map.mjs census`, `validate`, `index`, `drift`, and
`check <receipt>` maintain the map. Census uses bounded regex in four source roots;
it is inventory, not call-graph coverage. Unmeasured families are in `gaps.json`.
Run `node --test scripts/perf-map.node-test.mjs scripts/perf/cell-spawn-receipt.test.mjs scripts/perf/worker.test.mjs`.
The existing `scripts/perf/cells.mjs` and `runner-host.mjs` provide narrower attribution;
workstation Git-image timings must not be presented as satellite Cell timings.
