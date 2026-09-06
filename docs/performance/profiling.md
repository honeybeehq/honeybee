# Profile the v2 daemon

The v2 daemon has an opt-in, process-local trace recorder. Set `HIVE_PERF_DIR`
before the process starts to enable it. If the variable is unset or empty, the
recorder uses no timers, writes no files, and takes no resource samples.

The recorder does not open an inspector port. It does not write to the core
store or add telemetry to durable Honeybee state.

## Record a bounded trace

Use the provider-free runner to create disposable account, home, socket and store paths:

```sh
node scripts/perf/run.mjs --suite daemon \
  --trace-dir .artifacts/performance/traces \
  --out .artifacts/performance/traced-daemon.json
```

The runner shuts down each fixture after its workload. Clean shutdown writes
one trace file and one summary file. `SIGKILL` cannot flush either file. For a
separately configured daemon, set `HIVE_PERF_DIR` at launch and send `SIGINT` or
`SIGTERM` after the workload.

Do not point a profiling process at the store of a running daemon. The core
store permits one writer. A different `--data-dir` alone does not isolate
account homes or disable naming. Use the runner or explicitly configure those
paths and services for a standalone fixture.

These optional variables adjust the recording window. Values outside the
listed ranges are clamped. Invalid values use the default.

| Variable | Default | Range | Meaning |
| --- | ---: | ---: | --- |
| `HIVE_PERF_DURATION_MS` | 60000 | 100 to 3600000 | Time before the recorder stops collecting events |
| `HIVE_PERF_SAMPLE_MS` | 1000 | 10 to 60000 | Process-resource sample interval |
| `HIVE_PERF_MAX_EVENTS` | 25000 | 1 to 1000000 | Maximum retained trace events |
| `HIVE_PERF_MAX_BYTES` | 8388608 | 65536 to 67108864 | Maximum combined bytes for the trace and summary |

All profiler timers are unreferenced. Reaching the duration, event, or byte
limit stops sampling and span timing. The daemon continues normally. The
recorder keeps only bounded event strings and fixed-size aggregates until
shutdown.

## Read the artifacts

Each process writes files with the same unique stem:

```text
hive-perf-<start-ms>-<pid>-<nonce>.trace.json
hive-perf-<start-ms>-<pid>-<nonce>.summary.json
```

Open `*.trace.json` in Perfetto or the Chrome trace viewer. It contains Chrome
Trace Event Format complete events for daemon startup, daemon ticks, core-step
phases, and each allowlisted RPC verb. It also contains `process.resources`
counter events with these fields:

- CPU user and system time for the sample interval
- RSS, heap total, heap used, external memory, and array-buffer bytes
- event-loop utilization, active time, and idle time
- event-loop delay mean, maximum, and p99 for the sample interval

The summary uses `process.hrtime.bigint()` as its monotonic clock. For every
span name, `count`, `errors`, `totalNanoseconds`, and `maxNanoseconds` are exact
for the events accepted during the recording window. `totalNanoseconds` and
`maxNanoseconds` are decimal strings so JSON number rounding cannot change
them.

The distribution is bounded. `histogram.upperBounds` defines fixed
nanosecond buckets, and each span has one `bucketCounts` array plus an overflow
bucket. Bucket counts are exact. Any percentile inferred from a bucket is an
approximation.

`traceEvents` is the number of retained events. `droppedEvents` counts events
rejected after a duration, event, or byte cap and events removed to keep both
files under `HIVE_PERF_MAX_BYTES`. `artifactTrimmedEvents` is the subset
removed during final serialization. `stopReason` records the first collection
limit or `shutdown`.

Trace payloads contain only allowlisted event names, durations, error booleans,
and process metrics. They never contain prompts, request parameters, Honeybee
entity IDs, environment values, or error details. The unique filename contains
the operating-system process ID.

If setup or artifact IO fails, the recorder disables itself and writes one
generic diagnostic to the daemon log. Profiling failures never change an RPC
response or a core transition.

## Use native Node profiles offline

Node's built-in profilers answer questions that span timing cannot. The runner
can capture CPU and sampled allocation profiles for each worker:

```sh
node scripts/perf/run.mjs --suite daemon \
  --profile-dir .artifacts/performance/profiles \
  --out .artifacts/performance/profiled-daemon.json
```

For a standalone fixture, first prepare a config that isolates account homes,
vault, sockets and agents and disables provider-backed naming and refresh.
The following examples assume that config already exists. Put Node flags before
`dist/cli.js` and stop the daemon cleanly.

Record sampled JavaScript CPU stacks:

```sh
mkdir -p /tmp/hive-cpu
node --cpu-prof --cpu-prof-dir=/tmp/hive-cpu \
  dist/cli.js v2 daemon run --data-dir /tmp/hive-profile-node \
  --config /tmp/hive-profile-node/config.json
```

Record heap-allocation samples:

```sh
mkdir -p /tmp/hive-heap
node --heap-prof --heap-prof-dir=/tmp/hive-heap \
  dist/cli.js v2 daemon run --data-dir /tmp/hive-profile-node \
  --config /tmp/hive-profile-node/config.json
```

Capture V8 garbage-collection diagnostics:

```sh
node --trace-gc dist/cli.js v2 daemon run \
  --data-dir /tmp/hive-profile-node --config /tmp/hive-profile-node/config.json \
  > /tmp/hive-gc.log 2>&1
```

Load the CPU and heap files in a compatible offline viewer. GC tracing is
text output. None of these recipes enables a live inspector socket.

RPC span duration includes asynchronous waits but ends before response
serialization and socket delivery. Nested spans overlap; summing all span totals
double-counts work. Use the benchmark's RPC round-trip timings for client latency.
Native worker profiles do not include stacks from separate harness or CLI child
processes. Profile those executables explicitly when attributing child CPU.

`rpc.serialize` measures JSON encoding and socket queueing for replies and watch
frames. `daemon.tick.auto_title` measures synchronous kickoff only; asynchronous
title generation is outside that tick span.
