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
