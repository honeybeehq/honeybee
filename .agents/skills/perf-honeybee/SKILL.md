---
name: perf-honeybee
description: Measure satellite Cell startup, unchanged action-lane polling batch action views and boot-state reads using isolated Honeybee fixtures and conservative workload receipts.
---

# Perf Honeybee

This map covers **satellite Cell startup** and **unchanged action-lane polling** **batch action views**, and **boot-state reads**, not all Honeybee performance.
Read [the map](workloads/README.md) and [the workload](workloads/remote-cell-spawn.md).
For action polling, read [its workload](workloads/action-noop-reconciliation.md).
It counts store work in real SQLite fixtures; no runtime is launched or timing claimed.
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
compact timing receipts in `docs/performance/` only after an idle-host baseline.
Deterministic action-view counts are retained under `workloads/baselines/`; they
do not require an idle host and carry no timing claim.
Normal completion and SIGTERM stop owned runtimes and verify runner exit before
removing fixtures. SIGKILL cannot clean up; retain the reported fixture path and
use exact run ownership for recovery. Never signal by process name.

## The map and Helpers

`node scripts/perf-map.mjs census`, `validate`, `index`, `drift`, and
`check <receipt>` maintain the map. Census uses bounded regex in five source roots;
it is inventory, not call-graph coverage. Unmeasured families are in `gaps.json`.
Run `node --test scripts/perf-map.node-test.mjs scripts/perf/cell-spawn-receipt.test.mjs scripts/perf/worker.test.mjs`.
The existing `scripts/perf/cells.mjs` and `runner-host.mjs` provide narrower attribution;
workstation Git-image timings must not be presented as satellite Cell timings.

Batch action-view projection is mapped by [action-view-projection](workloads/action-view-projection.md): full-lane element counts only, separate from no-op reconciliation calls. Its core test emits a receipt with HIVE_ACTION_VIEWS_RECEIPT.

Boot-state lookup is mapped by [boot-runtime-lookup](workloads/boot-runtime-lookup.md). The recipe records system SQLite statement counts, with a separate Node SQLite plan/behavior guard. The two engines are not interchangeable latency populations.
