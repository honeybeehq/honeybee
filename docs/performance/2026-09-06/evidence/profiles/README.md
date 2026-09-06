# Retained profile captures

`native-before` profiles the unchanged `8506467f` core. `native-after` profiles
the optimized core. `native-daemon` profiles the optimized daemon and contains
three operational trace/summary pairs. The adjacent JSON reports record the
workloads, revision, environment and tool digest for each capture.

[index.json](index.json) records sizes, SHA-256 hashes and validation observations
for all 28 files: 11 CPU profiles, 11 sampled allocation profiles and three
trace/summary pairs. All native profiles contain samples. All operational traces
ended at clean shutdown with no drops or trimming and stayed within their byte
caps. They include startup, ticks, core phases, RPC serialization and resources.

Open `.cpuprofile` files in Chrome DevTools Performance, `.heapprofile` files in
Memory as allocation profiles, and `.trace.json` in a compatible Chrome/Perfetto
trace viewer. These source-worker profiles include imports, fixture seeding and
cleanup; child runtime stacks are excluded. Allocation profiles are sampled
allocations, not retained-heap snapshots. Do not compare their total durations as
production speedups; use the uninstrumented scorecards for that.

For attribution, the 100 × 200 baseline CPU profile has `listBeeViewRows` among
its highest-hit stacks; the candidate's highest-hit stacks are fixture writes,
current-runtime reads and GC. Seed work dominates these small capture runs, so
this corroborates the target but does not quantify a speedup by itself.

Reproduce with the current `scripts/perf/run.mjs`, `--samples 3`, `--suite core`
for before and after roots, and `--suite daemon` for the candidate. Supply a fresh
`--profile-dir` and `--out` for each run. See the measurement and tracing guides
for scope, isolation and profiling overhead.
