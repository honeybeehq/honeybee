# Measure Honeybee performance

Use Node 24 or newer and install the repository dependencies. Run `npm run build`
before measuring the installed CLI. Run benchmarks without other builds or test
suites in this checkout. Record machine load and repeat comparisons in alternating
order when background load is substantial.

## Capture repeatable workloads

Run `node scripts/perf/run.mjs --out .artifacts/performance/baseline.json` before
changing production code. It uses fresh processes, temporary SQLite stores with
production WAL/NORMAL durability, real Unix sockets and a real stub HSR runtime.
It never connects to the live daemon or uses a provider account.

Use `--suite core`, `--suite daemon`, or `--suite cli` for a focused experiment.
Use `--samples 30` for more repetitions and `--idle-ms 10000` for longer quiet
windows. Each core workload has three warmup calls. CLI results are warm file-cache
process startups with the explicit Node compile cache configured by the runner, not cold disk boots or an uncached installed launch. Startup and shutdown metrics have one sample
per scenario and need repeated runs to establish a distribution.

Run the same command after the change, with a different output filename. Compare:

```sh
node scripts/perf/run.mjs --compare \
  --before .artifacts/performance/baseline.json \
  --after .artifacts/performance/candidate.json \
  --out .artifacts/performance/comparison.csv
```

The comparator refuses mismatched workloads, metric sets, units, Node versions,
CPU models and hosts. Negative deltas mean less time or resource use. A delta is
not a statistical significance test. Inspect raw samples and p95, then repeat.
Use `--root /absolute/other/checkout` to run the same benchmark script against a
separate revision. Build that checkout first for CLI measurements.

Core workloads cover 10 and 1,000 bees, with concentrated and distributed runtime
history. Ninety percent are archived. The quiet step asserts that reads and ticks
produce no audit changes. Daemon workloads cover empty and 1,000-bee stores plus 100 bees with 200 generations each, RPC
health/list/snapshot, idle resource use, stub spawn, delivery, and shutdown.

Core and daemon workloads execute TypeScript source with Node type stripping; the CLI workload executes the built bundle. Naming, account refresh and scale-to-zero are disabled in the disposable daemon fixture, so its idle CPU excludes those default-install background activities.

The daemon benchmark runs the daemon and RPC client in the worker process. Idle
windows issue no RPC. CPU is percent of one core; RSS and heap measurements include
the worker but exclude separate runner-host and harness processes. The stub spawn
and delivery metrics include polling resolution and tick scheduling. They exclude
provider inference latency. The storage metric is logical file size, not physical
APFS allocation. The fixture seed batches writes and is outside timed operations.

## Capture CPU and allocation profiles

Use `--trace-dir .artifacts/performance/traces` for operational tracing alone.

Add `--profile-dir .artifacts/performance/profiles` to save a Node CPU sample
profile and sampled heap allocation profile for each worker, plus daemon traces
when supported by the measured revision. Profiling changes the workload, so the
comparator refuses an instrumented versus uninstrumented speed comparison.
Compare instrumented runs to each other for attribution, and use uninstrumented
runs for speed claims. Worker profiles include imports, fixture setup and cleanup;
use the daemon phase traces to distinguish the measured intervals.

Load `.cpuprofile` files in Chrome DevTools Performance and `.heapprofile` files in
Memory as allocation profiles. These are sampled allocations, not retained-heap
snapshots. For GC events, run the worker directly with Node `--trace-gc` and redirect
stdout to a separate log. GC text makes stdout unsuitable as the runner's JSON
report. No inspector port or live-process attachment is needed.

## Sample a live process tree

Run the read-only sampler against an explicitly selected daemon PID:

```sh
node scripts/perf/sample-process.mjs --pid 12345 --duration-ms 10000 \
  --out .artifacts/performance/process-tree.json
```

It records PID, parent PID, birth time, CPU time and RSS. It captures no argv,
environment variables, prompts or credentials. It stops if the root exits or its
birth identity changes. CPU is calculated from consecutive observations of the
same identities. Short-lived processes can be missed. Summed RSS counts shared
pages more than once and is not private memory. Sampling itself has a measured
cost in each sample. Use a dedicated host for comparisons that need low noise.

The process sampler caps total process records at 100,000 and marks truncation.
`ps` CPU time resolution varies by OS; short windows can quantize low CPU use to
zero. Use longer windows for idle comparisons. The worker handles SIGTERM/SIGINT
by shutting down its disposable daemon and verifying runner-host exit before
cleanup. SIGKILL and machine failure cannot run that cleanup. The runner derives
its timeout from the requested samples and idle windows, and reports timeouts as
failed captures rather than partial results.

## Compare core revisions while alternating order

When host load changes during separate runs, use two isolated source checkouts
with the same dependencies:

```sh
node scripts/perf/paired-core.mjs \
  --before-root /absolute/baseline-checkout \
  --after-root /absolute/candidate-checkout \
  --out-dir .artifacts/performance/paired
```

The runner copies a closed, checkpointed fixture database and opens one independent
writer per copy. It verifies identical state and operation results, warms both
implementations, then alternates A/B/B/A for each round. It records wall time and
CPU for bulk views, active views, individual views and quiet core steps. Reports
retain raw samples, workload identity, source revisions and a scorecard. Both
implementations share the process heap and host; this reduces time drift but does
not remove GC, scheduling, cache or thermal noise. It measures core operations,
not process startup or per-revision RSS.

Detached runner hosts re-adopted after a daemon restart may have parent PID 1.
A daemon-root process tree does not include those hosts. Sample their separately
identified PIDs when measuring the complete Honeybee footprint. The sampler does
not infer durable ownership from process ancestry.

An interrupted paired-core run can leave its temporary database directories.
It spawns no daemon or harness processes. Completed and failed normal runs close
both stores and remove their temporary directories. Capture reports include a
tool digest; paired reports also hash the measured store and loop source files.
