# Spawn and Cell measurements

This round starts at `17ce2072`, the first performance round merged into local
main. The system map, daemon profiler, native profiles and store benchmarks are
in [the first round](../2026-09-06/results.md). This round follows the spawn path
into the detached runner host and Cell provisioning worker.

## Boundaries and measured opportunities

1. The daemon accepts a spawn through RPC and records durable intent. A driver
   starts a runtime; provider readiness and daemon-observed readiness are separate
   from process startup.
2. HSR writes a runner configuration and launches a detached host. In the built
   baseline, that host enters through the full CLI. The host needs only Node
   built-ins to own the agent process, socket, status file and observation log.
   A small executable can remove repeated CLI imports for both HSR and Cells.
3. Cell allocation reserves a ledger. Provisioning runs in a worker thread to
   keep synchronous Git and filesystem operations off the RPC thread. An image
   hit validates the graph, copies packs with CoW and creates an independent
   checkout. Misses refresh under a per-origin lock; fallback copies and local
   clones remain available.
4. After reporting success, the baseline worker waits for the first turn or a
   30-second fallback before checking the image again. A fresh image placement
   has already ensured that graph. Replays and fallback placements need separate
   treatment because they do not prove the cache is still present.
5. Warm artifact copying is opt-in. The first exploratory capture included both warm-file copying and
   extra image packs; it does not isolate the cost of those 1,000 files. Logical byte counts do
   not describe APFS physical allocation or deduplication.

The host entry and worker lifetime are separate optimization units. The
provisioning algorithm, lifecycle authority, mailbox and host protocol are not
part of either unit.

## Baseline

Exploratory baseline with corrected Git Trace2 attribution, three samples per scenario:

| Cell path | Median wall time | Top-level Git commands |
|---|---:|---:|
| Local clone | 7,952 ms | 2 |
| Origin CoW | 4,628 ms | 3 |
| Cold Git image | 3,524 ms | 19 |
| Image hit | 1,302 ms | 8 |
| Stale image refresh | 2,830 ms | 21 |
| Image hit with 1,000 warm files | 3,377 ms | 8 |

These are separate sequential scenarios on a shared machine, useful for locating
costs, not a controlled ranking of strategies. Warm files ran after stale-image
updates in this early capture, so their timing also includes a changed pack graph.
The current tool measures warm files before stale updates to remove that confound. The fixture starts with 203 tracked
files; the stale-image scenario adds one file. Origin contents, checkout SHA, clean status and copied files are verified
outside the timed interval. Raw samples are in [evidence](evidence/cells-baseline.json).

Five baseline image-hit workers all remained alive two seconds after readiness.
Each ran 12 top-level Git commands, compared with eight for placement alone.
Median worker tail was 2,337 ms, including the deliberately imposed two-second
hold before maintenance was signaled. That is not a natural user-turn duration.
See [worker evidence](evidence/cell-worker-baseline.json).

## Reproduction

Build the target checkout before measuring its worker. Use the same Node binary,
machine, tool revision and workload on both sides. Pause builds and broad tests
during captures. No provider credentials or live daemon are needed.

```sh
npm run build
node scripts/perf/cells.mjs --root /absolute/baseline --mode provision --samples 3 --out /absolute/results/cells-before.json
node scripts/perf/cells.mjs --root /absolute/baseline --mode worker --samples 5 --hold-ms 2000 --out /absolute/results/worker-before.json
node scripts/perf/cells.mjs --root /absolute/candidate --mode worker --samples 5 --hold-ms 2000 --out /absolute/results/worker-after.json
node scripts/perf/cell-cohort.mjs --root /absolute/candidate --samples 3 --width 5 --hold-ms 2000 --out /absolute/results/cohort-after.json
node scripts/perf/runner-host.mjs /absolute/host-spec.json /absolute/results/hosts.json
node scripts/perf/compare-spawn.mjs cells /absolute/results/worker-before.json /absolute/results/worker-after.json /absolute/results/worker.csv
node scripts/perf/compare-spawn.mjs hosts /absolute/results/hosts.json /absolute/results/hosts.csv
node --test scripts/perf/git-trace.test.mjs scripts/perf/runner-host.test.mjs
```

A host spec contains `rounds` (2–100), `idleMs` (0–60,000), the absolute stub
`agent` path, and exactly two `implementations`, each with `name`, absolute `entry`
and string-array `args`. The baseline entry is `dist/cli.js` with arguments
`["v2", "runner-host"]`; the candidate is `dist/v2/runner-host.js` with `[]`.
Optional `dependencies` lists the loaded CLI bundle so its bytes and SHA-256
are recorded alongside the entry. The script appends its own config path. It
alternates A/B order, uses two warmups
per side and verifies a real ready/turn/exit cycle on every launch.

## Attribution and limits

- Host metrics are process RSS and OS-quantized CPU, sampled at readiness. RSS
  includes shared pages; it is not private memory. Readiness polling is 5 ms.
- Host compile caches are warm and separate per implementation. This measures
  repeated spawning, not first installation or a cold filesystem cache.
- Cell CPU includes the Node process and its worker threads, but excludes Git
  and copy subprocesses. Trace2 reports top-level Git wall time without counting
  nested upload-pack time twice. It does not measure total child CPU.
- Cell RSS includes the parent and workers. Allocator retention makes sequential
  RSS deltas a poor estimate of per-worker private memory. Exiting workers is a
  proven resource-lifetime change; the fresh-process five-worker cohort below measures its RSS effect directly.
- Idle CPU is emitted only when an actual idle interval was requested. A zero
  at the OS sampling resolution is not proof of no CPU work.
- Temporary origins and owned processes are cleaned up on completion and
  interruption. An incomplete Cell run lacks `completed: true` and must not be
  used as a finished comparison.

The retained host prototype predates the final measurement-tool cleanup. It
supports the design decision, but production results must use a fresh capture.

## Verified Cell result

Candidate `223f85a1`, integrated as `8a6475a3`. Individual runs use five samples;
cohorts use three fresh processes with five concurrent workers each. Both tools
record the exact built-worker SHA-256, and those hashes match across tools on
both sides. The baseline is `17ce2072`.

| Metric (median) | Before | After |
|---|---:|---:|
| Individual worker tail after ready | 2,421 ms | 2.61 ms |
| Individual workers alive at two-second hold | 1 | 0 |
| Git commands per individual worker | 12 | 8 |
| Individual Node CPU, including worker | 141.4 ms | 135.1 ms |
| Five-worker cohort RSS at hold | 132.60 MB | 124.45 MB |
| Five-worker cohort workers alive at hold | 5 | 0 |
| Five-worker cohort Git commands | 60 | 40 |
| Maximum worker tail within cohort | 3,326 ms | 77.2 ms |
| Cohort Node CPU | 712.1 ms | 700.9 ms |

The baseline tail includes the imposed two-second hold before maintenance starts.
This is not a claim that user-visible Cell spawning became 2.4 seconds faster.
Individual readiness was 2,376 → 2,532 ms; cohort readiness was 3,689 → 4,523 ms.
The distributions overlap substantially (baseline cohort maximum 8,918 ms), and
Git child timing also varies. These captures do not establish a readiness win
or a regression. The production change adds one ledger read and removes deferred
work; foreground provision logic is unchanged.

The cohort RSS reduction is 8.14 MB (6.1%) at the defined observation point.
It includes shared pages and allocator retention. Do not multiply it into a
private-memory forecast. Node CPU during the two-second hold was 1.82 → 3.58 ms;
that interval includes optimized worker exit bookkeeping, so it is not a steady
idle-CPU comparison. No idle-CPU improvement is claimed.

Both tools verified the real `image-cow` path, clean checkout, correct commit,
tracked contents, unchanged origin and worker exit. The implementation retains
deferred retries for completed replays, incomplete-operation resumes and fallback
placements. Five real Worker tests and eleven serial CellDriver tests passed,
along with the Cell TypeScript check and repository build. Broader Cell checks
had one load-sensitive boot timeout that passed earlier and on an isolated rerun.
The combined Cell/tmux run had the previously observed tmux honest-failure timing
assertion; this commit changes no tmux code.

Raw results and validated comparisons: [individual workers](evidence/worker-scorecard.csv),
[five-worker cohorts](evidence/cohort-scorecard.csv). All percentiles in these CSVs
are recomputed and checked against their JSON samples by `compare-spawn.mjs`.

## Native host profiling

For an independent profiling capture, add `nodeArgs` to each implementation:
`["--cpu-prof", "--cpu-prof-dir=/absolute/profiles", "--heap-prof", "--heap-prof-dir=/absolute/profiles"]`.
Create separate output directories for the two implementations first. Use a
separate spec and output JSON; profiling overhead must not enter the headline
comparison. The tool still verifies every ready/turn/exit cycle and reaps its
owned hosts. V8 writes CPU sampling profiles and sampled allocation profiles at
clean exit. Allocation profiles are not retained-heap snapshots or private RSS.

## Verified runner-host result

Host implementation `3a885d3e`, integrated as `b6fe51fc`, plus the verified Cell
change. Baseline `17ce2072`. Fifteen alternating pairs, two warmups per side,
three-second idle observations, Node 25.8.0 on Apple M4 Max/macOS.

| Metric (median) | Before | After |
|---|---:|---:|
| Host RSS at readiness | 60.98 MB | 49.97 MB |
| Host CPU through readiness | 390 ms | 280 ms |
| Host readiness | 1,939 ms | 1,470 ms |
| Agent readiness | 2,937 ms | 3,310 ms |
| Host idle CPU observed by `ps` | 0% | 0% |

RSS fell 18.1% and host startup CPU fell 28.2%; both improved in every one of the
15 matched pairs. Host-ready median fell 24.2%. The host runs the same source
function and protocol through a 4,106-byte executable instead of loading the
1,046,082-byte v2 CLI bundle through its 1,191-byte launcher. The release gains
that small additional artifact; no checkout/storage reduction is claimed.

End-to-end readiness is inconclusive. The candidate was faster in 11 of 15
matched pairs, with median paired change −416 ms and mean 3,453 → 2,975 ms, yet
its overall median was higher. The load average was roughly 30–35, with wide
wall-time distributions. Retain both results; do not claim a reliable full-agent
readiness improvement or establish a regression from this capture alone.
Idle CPU was below the roughly 0.33%-of-one-core resolution of the three-second
observation on both sides. There is no measured idle-CPU win.

The [host CSV](evidence/host-scorecard.csv) includes all metrics, paired changes,
entry names and hashes. The [raw report](evidence/host-final.json) includes every
sample and the baseline CLI dependency hash. The compact [combined scorecard](evidence/scorecard.csv)
links each row back to its complete comparison.

## Cell worker native profiles

```sh
node scripts/perf/profile-cell.mjs /absolute/baseline /absolute/profiles/cell-before
node scripts/perf/profile-cell.mjs /absolute/candidate /absolute/profiles/cell-after
```

Use Node 25 and an empty output directory. This opt-in command wraps the real
built worker in a local inspector session, captures CPU and sampled heap
allocations, and records Git Trace2. Production workers and the timing tools do
not load this wrapper. It validates the image path, checkout, origin, artifact
hashes and profile contents before writing a completed index. Maintenance is
signaled immediately at readiness, so these profiles are not timing comparisons.

Both worker profile sets are valid and confirm 12 → 8 Git calls. The JavaScript
profiles have few samples because much of the wall time is spent waiting on
child processes; use the Git trace alongside them. They are allocation samples,
not full heap snapshots containing object values or measurements of private RSS.

Twenty-two compressed native files are retained in [the native index](evidence/native/index.json),
with original and compressed hashes. Decompress a `.cpuprofile.gz` or
`.heapprofile.gz` before opening it in a V8-compatible profile viewer. Host
profiles include four executions per implementation, of which two are warmups;
the separate [profiled report](evidence/host-profiled.json) is excluded from the
headline scorecard. The host and Cell capture indexes retain their source and
artifact provenance.

The final tool checks passed 8/8, including actual repeated-output captures for
both Cell tools and host interruption cleanup. The later Trace2 reset fix is
outside the Cell optimization: retained performance runs used fresh trace paths,
so their original recorded tool hashes and command counts remain valid.
