# hb-health-cpu: hived publishes its own process CPU

Focus goal 3 (the scoreboard). Tormod chose: Honeybee publishes its process CPU; the nodes view carries it. This is the Honeybee side. The Apiary side (nodes view, `scripts/scoreboard.mjs`) is a small follow-up that reads the field named here.

## The field

Capability tag: `health.process_cpu.v1` (in the server hello's `capabilities`, in `deployInfo.capabilities`, in `DAEMON_CAPABILITIES`). A daemon without the tag never sets the field; a reader must treat a missing field as "unknown", not zero.

Field: `processCpu`, present on two results from the same daemon value:

- `health` RPC (`hive health --json` prints it verbatim);
- `deployInfo` RPC (the result apiaryd already reads for pid, version, capabilities and identity).

Shape (`ProcessCpu` in `v2/daemon/src/processCpu.ts`):

```json
"processCpu": {
  "schema": 1,
  "percent": 1.5,
  "windowMs": 60025,
  "sampledAt": 1794213470571,
  "cores": 48
}
```

- `percent`: hived's own CPU (user + system of the daemon process only, not its bees or runner hosts) over the window, in percent of one core, one decimal. 100 means one full core; it can exceed 100 on a multi-core host, the same convention as `top` and `ps`.
- `windowMs`: the wall time the average covers. Nominally 60 s; it reads between 60 and 65 s once the ring is full, less during the first minute after boot.
- `sampledAt`: epoch ms of the newest sample. The value changes at most every 5 s.
- `cores`: `os.availableParallelism()` on the node, so a consumer can show percent of the machine (`percent / cores`) if it wants to.
- `null` (not absent) for the first 5 s after boot, before the second sample exists. Absent only on a daemon without the tag.

Measurement: `process.cpuUsage()` and `process.hrtime.bigint()` on an unref'd 5 s `setInterval`, kept in a ring that holds the oldest sample still needed for 60 s of coverage. `status()` divides the cpu delta between the oldest and newest sample by the wall delta. No per-tick work, no subprocess, no `/proc` read.

`hive health` (text) gains one line: `cpu · 1.5% · avg over 60s · 48 cores`.

## How Apiary should carry it

- Nodes view: read `deployInfo.processCpu` (or `health.processCpu`) when `capabilities` includes `health.process_cpu.v1`; show `percent` with `windowMs` as the tooltip; show nothing (not 0) when the tag is missing or the value is `null`.
- `scripts/scoreboard.mjs`: same field and tag; the scoreboard's hived CPU column is `processCpu.percent` of one core. Compare like with like: `ps -o %cpu` is a lifetime average and will not match a recent window on a daemon whose load changed (see the lab: 28.3 lifetime vs 51.2 recent under load).

## Evidence (scratch daemon on metal-2, this Cell, Node 24.21.0)

Driver: `findings/hb-health-cpu-lab.mjs`. Receipts: `findings/hb-health-cpu-lab.jsonl`, daemon log `findings/hb-health-cpu-hived.log`. The scratch daemon ran from `v2/daemon/src/bin.ts` with its own data dir under `/tmp`, isolated HOME, provider URLs pointed at `127.0.0.1:9`, and was stopped by its pid; no service manager, no production hived.

| step | result |
|---|---|
| hello | `health.process_cpu.v1` in the server hello's capabilities (81 tags) |
| `hive health --json` right after boot | `processCpu: null` (one sample so far) |
| idle, 65 s window | health 1.5%; `/proc/<pid>/stat` delta over the same window 1.4%; `top -d 60` 1.5%; `ps` lifetime 4.0% (includes boot) |
| `hive health` text | `cpu · 1.5% · avg over 65s · 48 cores` |
| `deployInfo` | same `processCpu` object, tag in `capabilities` |
| load: 5 stub bees, 2459 sends in 65 s (37.8/s) | health 51.2%; `/proc` delta 51.5%; `top` 51.8%; `ps` lifetime 28.3% |
| timer cost | 200 000 `sample()` calls (plus a `status()` every 13th): 9.2 µs cpu per sample; at one sample per 5 s that is 0.00018% of one core |
| stop | SIGTERM, exit in 116 ms, timer cleared in shutdown |

The acceptance bound in the driver is 3 points against the `/proc` delta; the observed gaps were 0.1 (idle) and 0.3 (load).

Gates on the final tree, HIVE_*, CLAUDE_CONFIG_DIR and CODEX_HOME unset: `npm run v2:check` (`findings/hb-health-cpu-v2check.log`), `npm run build` (`findings/hb-health-cpu-build.log`), and under the fixture warden `v2/daemon/tests/integration.test.ts`, `apiary-tag-guard.test.ts`, `child-health.test.ts`, `v2/cli/tests/cli.test.ts`: 37 tests, 0 failures (`findings/hb-health-cpu-tests.log`). The integration test's lifecycle case now asserts the tag, the field on `health` and `deployInfo`, and their agreement.

## Change

- `v2/daemon/src/processCpu.ts` (new): `ProcessCpuMeter`, `ProcessCpu`, `PROCESS_CPU_SAMPLE_MS`, `PROCESS_CPU_WINDOW_MS`.
- `v2/daemon/src/protocol.ts`: the tag; `processCpu?: ProcessCpu | null` on `HealthResult` and `DeployInfoResult`.
- `v2/daemon/src/daemon.ts`: the meter, the first sample and the 5 s unref'd interval after `daemon.started`, cleared in `shutdown`; `processCpu` in `rpcHealth` and `rpcDeployInfo`.
- `v2/cli/src/render.ts`: the `cpu` line in `renderHealth`.
- `v2/daemon/tests/integration.test.ts`: the assertions above.
