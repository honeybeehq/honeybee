# Performance round: 6 September 2026

This round maps the system, adds reusable measurement and bounded daemon tracing,
and removes a measured runtime-history bottleneck. It changes source on
`perf/system-round-2026-09-06`; it does not deploy to the running daemon.

The [system map](system-map.md) covers the core, daemon, RPC/CLI, drivers, adapters,
accounts, integrations, Cells, packaging and storage. The
[next experiments](next-experiments.md) list names the remaining costs and the
correctness conditions for investigating each. No provider, remote-node, Cell,
cold-disk or large live-host-fleet speedup is claimed.

## Verified core changes

The old latest-runtime self-join compared generations against newer generations,
producing quadratic work per bee's history. The replacement seeks the maximum
generation through the existing primary key. Lifecycle filters now run in SQL
before constructing excluded bee and runtime objects. No schema, persistent
state, lifecycle, scheduling policy or protocol change is required.

The final comparison alternates baseline `8506467f` and candidate `4fd0c1fa` in
A/B/B/A order over identical checkpointed databases, with three warmups and 30
samples per operation and side. It asserts identical returned values, identical
initial state and no audit changes. Ninety percent of fixture bees are archived.
Both implementations run in one Node 25.8 process on the same shared Mac.

| Operation | Before p50 | After p50 | Change | Before / after p95 |
|---|---:|---:|---:|---:|
| List all, 100 bees × 200 generations | 378.19 ms | 3.42 ms | -99.1% | 437.47 / 5.66 ms |
| Quiet core step, 100 × 200 | 366.97 ms | 4.79 ms | -98.7% | 411.96 / 6.06 ms |
| List all, 1,000 × 20 | 86.28 ms | 35.04 ms | -59.4% | 142.98 / 51.78 ms |
| List active, 1,000 × 20 | 84.51 ms | 11.36 ms | -86.6% | 103.26 / 16.72 ms |
| List active, 1,000 × 1 | 24.13 ms | 3.65 ms | -84.9% | 35.09 / 5.29 ms |

The [complete scorecard](evidence/final-core-scorecard.csv) includes CPU and
unchanged operations; the [before](evidence/final-core-before.json) and
[after](evidence/final-core-after.json) reports retain every sample and source
hashes. These are seeded source-operation results, not live deployment claims.

At 100 × 200, quiet-step CPU falls from 318.85 to 4.17 ms. At 1,000 × 1,
unfiltered quiet-step CPU is effectively unchanged (23.06 to 23.11 ms). Small
10-bee quiet steps measure 0.391 to 0.435 ms wall and 0.431 to 0.482 ms CPU;
their p95 CPU is nearly identical (1.426 versus 1.433 ms). Unfiltered 1,000 × 1
list CPU increases 4.2% and wall time 6.7% in this capture. Treat this as a
measured flat-history tradeoff, not an across-the-board win. Its wall p95 worsens
from 28.19 to 30.88 ms, while CPU p95 improves from 32.30 to 27.85 ms. A stable
regression size requires repeat captures; these deltas remain visible in the scorecard.
Shared scheduling, GC and cache effects remain, even with alternating order.

The earlier [single-query scorecard](evidence/query-scorecard.csv) and
[lifecycle-filter scorecard](evidence/filter-scorecard.csv) isolate the two changes.
The [final query plan](evidence/query-plan-final.json) confirms indexed generation
lookups. Timing claims come from populated stores, not planner estimates.

## Profiling delivered

The [measurement guide](../measure.md) documents repeatable core, real daemon,
Unix RPC, stub-runtime and built CLI captures; wall/CPU distributions; idle CPU,
RSS, heap, event-loop and logical storage metrics; a bounded read-only process-tree
sampler; and native CPU/allocation profiles. Reports include workload identity,
environment, source revision and tool digests. Comparisons reject mismatched or
partial reports. Interrupted daemon workers stop their disposable runtime hosts.

The [tracing guide](../profiling.md) documents opt-in startup, tick, core phase and
RPC spans, response serialization, failed startup phases, resource counters and
Chrome/Perfetto output. Default recording is disabled. Enabled recording has
bounded duration, event count and artifact bytes, records fixed names rather than
request bodies, and fails open on artifact IO errors. Artifacts flush at clean
shutdown; this is process-local tracing, not streaming or distributed tracing.
Auto-title spans measure synchronous kickoff, not provider generation latency.

The [synthetic overhead capture](evidence/profiler-overhead.json) measures median
calls at 52 ns direct, 72 ns with disabled recording and 2.82 µs with enabled
recording. It recorded 15,500 spans, dropped none and wrote 1,778,802 bytes.
This excludes operation work and final artifact serialization; it is not a claim
that active profiling has zero application-level cost.

## Daemon, startup, memory and storage observations

The [daemon scorecard](evidence/final-daemon-scorecard.csv) measures separate
real daemon workers before and after, with real Unix RPC and a stub harness.
The large-history result carries through to RPC, quiet CPU and message delivery.

| Metric, 100 bees × 200 generations | Before | After | Samples per side |
|---|---:|---:|---:|
| List RPC | 714.93 ms | 7.45 ms | 15 |
| Snapshot RPC | 729.16 ms | 6.83 ms | 15 |
| Quiet CPU (% of one core) | 48.85% | 2.78% | 3 |
| Quiet loop delay p99 | 460.59 ms | 27.03 ms | 3 |
| Stub send to delivered | 931.09 ms | 218.42 ms | 5 |

The empty daemon starts to its RPC hello in 57.4 versus 55.5 ms; its stub becomes
idle in 913 versus 909 ms. Those startup measurements have only one sample per
scenario. They do not establish a startup improvement. Module imports and fixture
seeding are outside the startup interval. Stub delivery includes the fixture's
200 ms tick scheduling and polling resolution. Provider generation is absent.

Quiet RSS is approximately unchanged at 100 × 200 (129.31 versus 129.17 MiB),
while the 1,000 × 1 capture increases from 217.48 to 230.39 MiB. Logical storage is
effectively unchanged. No memory or storage reduction is claimed. This source
worker includes its client and excludes child runtime memory.

The [built CLI probe](evidence/final-cli-scorecard.csv) records warm-cache `help`
process startup at 468.5 versus 436.7 ms median (15 samples). This modest delta
on a shared host does not establish a cold-start improvement. No packaging
optimization was made. The final v2 bundle includes the opt-in profiler.

The first 1,000 × 1 daemon capture raised an idle-CPU question (9.69% before,
11.49% after). A longer, reverse-order repetition used three 10-second quiet
windows per side: [baseline](evidence/reverse-idle-before.json) measured 10.27%
and [candidate](evidence/reverse-idle-after.json) 10.12%. This does not confirm
the initial CPU increase. List RPC medians were 80.37 and 82.47 ms in that
repeat. Candidate RSS remained higher (253.11 versus 243.98 MiB); memory
improvement remains unproven and allocator/GC effects need a retained-heap study.

A read-only [live process-tree sample](evidence/live-process-tree.json) and
[top-level storage snapshot](evidence/live-storage-files.json) establish context
for later experiments. The deployed daemon had 526 retained bees and measured
about 244 MiB RSS and 7% of one CPU core during active work. Its observed tree
had 107 processes and approximately 7.4 GiB summed RSS, including shared pages
and excluding re-adopted hosts outside the ancestry tree. `hived.log` was about
138 MB versus 35 MB of core SQLite data. None of this live state was changed.

The flat-history daemon has measured costs too: its first list RPC median rises
from 77.90 to 83.01 ms (+6.6%), while p95 improves from 184.34 to 109.21 ms.
Stub spawn-to-idle rises from 890 to 1,224 ms in the first capture and from
803 to 1,080 ms in the reverse-order capture. These remain individual spawn
observations, not a latency distribution; they warrant a repeated spawn study
before claiming startup parity or improvement. The round retains the substantial
history gains while reporting these possible regressions explicitly.

## Native capture verification

The [retained profile set](evidence/profiles/README.md) contains 11 CPU profiles,
11 sampled allocation profiles and three operational trace/summary pairs. Both
baseline and candidate core profiles were captured, plus candidate daemon
profiles. Every native profile contains samples. All three traces contain
startup, tick, core, RPC serialization and resource events, end at clean shutdown,
fit their configured caps, and report zero dropped or trimmed events. The
[index](evidence/profiles/index.json) records hashes and validation observations.

Native worker profiles include fixture seeding, which dominates several stacks;
they support attribution and are not the before/after timing scorecard. No live
provider process was profiled or interrupted.
