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
5. Warm artifact copying is opt-in. In this fixture, copying 1,000 dependency
   files costs more than the image-hit checkout itself. Logical byte counts do
   not describe APFS physical allocation or deduplication.

The host entry and worker lifetime are separate optimization units. The
provisioning algorithm, lifecycle authority, mailbox and host protocol are not
part of either unit.

## Baseline

Corrected Git Trace2 results, three samples per scenario:

| Cell path | Median wall time | Top-level Git commands |
|---|---:|---:|
| Local clone | 7,952 ms | 2 |
| Origin CoW | 4,628 ms | 3 |
| Cold Git image | 3,524 ms | 19 |
| Image hit | 1,302 ms | 8 |
| Stale image refresh | 2,830 ms | 21 |
| Image hit with 1,000 warm files | 3,377 ms | 8 |

These are separate sequential scenarios on a shared machine, useful for locating
costs, not a controlled ranking of strategies. The same fixture has 203 tracked
files. Origin contents, checkout SHA, clean status and copied files are verified
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
node scripts/perf/runner-host.mjs /absolute/host-spec.json /absolute/results/hosts.json
node --test scripts/perf/git-trace.test.mjs scripts/perf/runner-host.test.mjs
```

A host spec contains `rounds` (2–100), `idleMs` (0–60,000), the absolute stub
`agent` path, and exactly two `implementations`, each with `name`, absolute `entry`
and string-array `args`. The baseline entry is `dist/cli.js` with arguments
`["v2", "runner-host"]`; the candidate is `dist/v2/runner-host.js` with `[]`.
The script appends its own config path. It alternates A/B order, uses two warmups
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
  proven resource-lifetime change; its fleet RAM effect needs a separate cohort.
- Idle CPU is emitted only when an actual idle interval was requested. A zero
  at the OS sampling resolution is not proof of no CPU work.
- Temporary origins and owned processes are cleaned up on completion and
  interruption. An incomplete Cell run lacks `completed: true` and must not be
  used as a finished comparison.

The retained host prototype predates the final measurement-tool cleanup. It
supports the design decision, but production results must use a fresh capture.
