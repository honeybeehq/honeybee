# Satellite Cell spawn

The owner accepts `spawn` over a real Unix RPC socket, reserves the Cell, provisions
its checkout in a worker, starts a detached HSR host and parses the stub's real boot.
The benchmark then sends a unique message and waits for durable delivery. These
are three cumulative timings from one monotonic clock, not additive phases.
First delivery proves the runtime accepts mail; it does not prove a completed turn.

Run through `scripts/perf/run.mjs --suite cell-spawn`; do not build another driver.
The harness reuses the daemon and Cell test fixtures. Each origin has 202 tracked
files. Source Node execution is a different series from deployed/bundled Honeybee.
The source hashes, tool digest, runtime, host identity/load, cache case, width and
sandbox setting travel with the capture. OS and filesystem caches are never flushed.

## Populations

- `cold`: new disposable origin before each batch, outside its timer; no initial
  Git clone/download is timed. This is a first-use origin, not cold disk.
- `warm`: one excluded batch, then repeated starts from the same origin.
- `width 1` and `width 4`: separate workloads. Four starts share a batch and their
  per-bee observations are correlated; twenty bees are not twenty independent batches.
- Metal and netcup each have their own series. Use the exact hostname, not merely
  the provider name. Sandbox defaults on for the satellite configuration.

Satellite Cells **do not use workstation Git images** (`nodeKind === workstation`
is the driver gate). Existing image-hit microbenchmarks do not model this path.
The batch metric includes correctness checks and stop/settlement, so it is not
the latency of the last ready agent. Admission includes the local RPC round trip.
Readiness/delivery polling adds up to 15 ms plus RPC/scheduling delay.

## Cross-repository boundary

Apiary's companion record is `.agents/skills/perf-apiary/workloads/remote-cell-spawn.json`.
Apiary owns repository materialization, account preparation, authenticated remote
dispatch and the visible result. The owner fixture starts after repository setup.
Do not sum separately captured component medians and call them end-to-end latency.
For a future paired run, carry one request id and the resulting owner node/bee id
through both captures. Keep workstation and owner monotonic clocks separate;
unsynchronised wall timestamps cannot measure one-way network delay.

## Evidence and gaps

The initial captures verify the recipe, including satellite sandbox and cleanup;
there is no retained idle-host latency baseline or ruled latency budget.
Real provider startup, accounts, repository download, phase attribution, reconnect
and Send-to-visible-ready remain gaps. Stop causes and failed samples remain in
the failure report; a timed-out run must never become a receipt.

The runner terminates only its disposable daemon and that daemon's owned runtimes.
It retains failure output before returning nonzero. SIGKILL/host loss cannot execute
cleanup; recover only the fixture identified in the report, never all Hive processes.

On Linux, the **source checkout must be outside `/tmp`**: bubblewrap mounts a
private `/tmp`, so a stub executable in a `/tmp` source copy cannot be read by
the sandboxed child. Cell fixtures themselves may use `/tmp` because their owned
Cell directory is explicitly rebound. Use a checkout under the target home.

## 2026-09-17 socket wake comparison

[Compact comparison](../../../../docs/performance/2026-09-17-cell-socket-comparison.json)
retains source hashes, report digests, load and both measurement orders. Each
capture has 20 batches, sandbox on, Node 24.18.0. Warm first delivery improved
24–25% on metal and 21–23% on netcup; four-wide first-use origins improved 23–24%
and 9–11% respectively. These are owner-side stub observations on shared hosts,
not production provider or Send-to-visible timings. Netcup burst readiness was
about 4% slower, and its tail did not improve uniformly; do not claim every phase won.

The change wakes one pending 200ms socket retry when status first reports the
agent PID. It does not change the 50ms observation throttle or recurring reconnect
cadence. The actual connection still gates delivery. Driver and adoption tests
cover that boundary. Warm candidate receipts for each host are retained alongside
the comparison; there is still no exclusive-host latency budget baseline.

## 2026-09-20 tick cadence and checkout comparison

[Compact comparison](../../../../docs/performance/2026-09-20-cell-spawn-tick-cadence.json).
Production satellites tick every 200 ms; the fixture default of 20 ms hid two
cadence waits, so `run.mjs --suite cell-spawn` now accepts `--tick-ms` and this
capture uses 200. On netcup-1 production logs the owner waited a median 291,000 us
from `cell.reserve` to the start command (26 Cells), and the ledger's checkout
step took a median 738,000 us for 3,393 files.

Three changes: the spawn RPC and the account activation each request an immediate
tick; while any runtime is booting the loop ticks every 25 ms (the runner-file
pump stays at 50 ms); and `git checkout` runs with eight workers. A traced stub
spawn at the 200 ms cadence reached idle at +110,000 us instead of +398,000 us.
The Mac cell-spawn suite (load 3.5–6.7, two pairs) measured `cell.ready` p50
328,000/336,000 → 296,000/235,000 us and p95 520,000/541,000 → 302,000/300,000 us;
`cell.usable` p50 536,000/548,000 → 488,000/441,000 us. The 202-file fixture is
below the parallel-checkout benefit; on netcup-1 the 3,393-file checkout measured
633,000 → 210,000 us directly. Codex's own boot (about 930,000 us on netcup-1)
remains the largest owner-side interval and is harness-owned.

## 2026-09-21 boot-interval attribution (all harnesses)

[Compact receipt](../../../../docs/performance/2026-09-21-boot-attribution.json). New tools
`scripts/perf/boot-trace.mjs` (production spawn tracer: proc/net/runner-file/hived.log on
one monotonic clock) and `scripts/perf/harness-boot.mjs` (standalone handshake profiler with
harness debug logging). Anchor is the daemon `cmd.spawn` line; offsets in microseconds.

One instrumented production spawn per harness where it can run: **codex** netcup-1/metal-1/Studio,
**claude** netcup-1/Studio, **grok** netcup-1/Studio, **kimi** Studio only. **kimi** is OAuth-only
and refused leasing to satellites (no kimi account on netcup-1 or metal-1). **opencode** is not
spawnable as a Honeybee Cell bee anywhere — there is no builtin opencode agent/adapter, the
Studio's `agents.opencode` config points at a deleted shim, and netcup-1's `~/.local/share/opencode`
is root-owned (EACCES); it was measured standalone-ACP + binary floor only.

Segments and owners: **A provisioning** (git-image CoW on the workstation or `git clone --local`
+ `git checkout` on satellites) — Honeybee, disk-bound by tracked file count (honeybee = 3915
files); **B runner-host start** ~28-47ms — Honeybee; **C sandbox wrap** bwrap ~1-8ms (Honeybee) +
harness binary load (harness); **D initialize** (binary load + home/config + MCP client init) —
harness; **E session/thread start** (auth, model/limits, thread/session; >=1 provider RTT ~100ms)
— harness + provider; **F booted detection** ~75ms (25ms booting-tick + 50ms runner pump) — Honeybee.

Measured booted (cmd.spawn -> accept-ready), us: codex netcup-1 2,073,331 (cold origin cache,
checkout ~985ms) / metal-1 935,896 (warm, checkout ~296ms) / Studio 963,553; claude netcup-1
474,806 accept-ready (its init/model deferred to the first turn) / Studio 703,060; grok netcup-1
1,332,097 / Studio 3,280,916 (loaded); kimi Studio 1,400,610. netcup-1 was idle (load ~0.5-1.3);
metal-1 and the Studio were loaded (4-9) so their totals are inflated — these are segment SHARES,
not an idle-host latency baseline.

Largest common Honeybee segment is **A provisioning** (git checkout of the working tree), present
for every harness: the warm-pool / pre-provisioned-cell target. Then **F booted detection** (~75ms,
event-driven observation) and **B runner-host start** (~28-47ms, pre-started host). Segments D+E are
harness/provider-owned; provider RTT (~100ms) is the floor. Lazier MCP does not help boot: codex and
grok emit `mcpServer/startupStatus` AFTER booted.

## 2026-09-21 warm Cell pool (provisioning off the spawn path)

[Compact receipt](../../../../docs/performance/2026-09-21-cell-warmpool.json). Implements the
largest floor-order candidate from the boot attribution: a per-repository warm pool of
pre-provisioned Cells (`v2/driver-cell/src/warmPool.ts`, `poolWorker.ts`, wired in
`CellDriver.start`). Each spawn first tries to CLAIM a member by an atomic directory rename
(plus a checkout delta when the wanted sha differs) instead of a cold `git clone --local` +
checkout; every spawn then tops the pool back up in a worker off the event loop. Defaulted
OFF (`cells.warmPoolFree=0`); enable via config or `HIVE_CELL_WARMPOOL_FREE` (used for B/A/A/B).

Microbench (`scripts/perf/cell-warmpool-bench.mjs --files 3900`): claim vs cold provision,
Studio loaded 331,932 → 85,659 us (3.9x), netcup-1 idle ext4 94,759 → 41,865 us (2.3x). The
claim's residual cost is one `git status` dirty guard; absolute cold numbers here use a hot
cache and a synthetic tree, so they are below the cold-origin production checkout (~985 ms on
netcup) where the pool wins most. End-to-end `run.mjs --suite cell-spawn --tick-ms 200` warm
width1 on the Studio, B/A/A/B: cell.ready p50 300,828→148,858 us (-50%), cell.usable p50
495,367→358,900 us (-28%), cell.accept unchanged; B1~B2 within 0.2%, A1~A2 identical.

Safety: unit tests in `v2/driver-cell/tests/warmPool.test.ts` (claim/reap, replay-after-claim
idempotency, delta to a reachable sha, unreachable-sha discard, dirty-member refusal, atomic
concurrent-claim exclusivity, maxSize, reapPool, empty→cold fallback) and config parse/env in
`v2/daemon/tests/config.test.ts`. The satellite daemon end-to-end still needs a deploy
(not done here); the netcup-1 microbench exercises the real provisioning+pool code on ext4.
