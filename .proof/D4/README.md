# D4: runtime.activate, runtime.probe, the launcher, and the end of `hive deploy`

Built on origin/main 8940403d (D3 evidence) and rebased onto origin/main 077d4519 on 2026-11-08; the runs below are from the rebased tree. Lab on netcup-3 (a satellite Cell), Node 24.18.0, npm 11.16.0 (`npm ci`), bwrap present. Every daemon in the lab is a scratch daemon under `/var/tmp/hb-D4-*` with its own data dir, socket, runtime root, unit file and launcher, started and restarted by a fake service manager and stopped by its own pid. No real `systemctl` or `launchctl` ran: the daemon's PATH puts `bin/systemctl` (a logging shim) first, the label is `hb.d4.test`, and `systemctl.log` holds every call the shim received.

## Receipts

- `lab.mjs`: the driver. `lab.jsonl` / `lab.stdout.log`: the passing run. `hived.log`, `supervisor.log`, `systemctl.log`: the scratch node's daemon log, the fake service manager's log (every start, exit code and SIGTERM) and the shim's call log.
- `scratch-break-launcher.log` / `.jsonl`: the same lab with the launcher's revert branch removed (`if false; then`). It fails right after `activate.C.answer`: no successor ever listens, and the supervisor log inside the failure shows the dead candidate started 356 times in the 120 s wait with no revert. The launcher was restored from a copy afterwards (its text is byte-identical to the committed one).
- `tests-daemon.log`: confined-peer, apiary-tag-guard, daemon-lifecycle, daemon-shutdown, local-rpc-trust under the warden. `v2-check.log`: `npm run v2:check`. Service, service-CLI, CLI and release build/settle/publication/artifact tests ran in the session (38 and 29 pass, see the proof's run evidence).
- `decisions.tsv`: the decision trail.
- The model: `.agents/skills/verify-runtime-handover/handover-model.mjs` (376 states on the main configuration, six broken variants each failing on its property).

## What the lab proved, in order (`lab.jsonl` step names)

| step | what happened |
|---|---|
| `lab.setup` | versions A and B are this tree's `dist` with their own build identity; C is a `dist/cli.js` that exits 3 at boot; D claims schema 58. `current -> A`. The 13-line launcher is written by `installLauncher`; the unit's ExecStart is `launch <node> v2 daemon run --data-dir <dir>`. |
| `daemon.A.started` | the fake unit starts A through the launcher: 465 ms to the socket, 79 capability tags, `runtime.update.v1` present. |
| `bees.idle` | five stub bees idle: `hsr-1..3` (hsr) and `cell-1..2` (fresh sandboxed Cells on a lab git origin). |
| `midturn.before` | `hsr-2` gets `@slow:9000` and is `running`. |
| `activate.B.answer` | `hive runtime activate <B> --json` answers in 112 ms: `from A`, census 5 runtimes, 0 degraded, `service systemd hb.d4.test`, journal `activated`. |
| `activate.B.links` | `current -> B`, `previous -> A`, `handover.json {toSha: B, fromPid: <old pid>}`. |
| `activate.B.restart` | the old daemon issued `systemctl --user restart --no-block hb.d4.test.service` (shim log) and exited on the supervisor's SIGTERM. |
| `activate.B.window` | old daemon gone 418 ms after the answer, successor listening at 835 ms: 417 ms with no socket. |
| `boot.handover.B` | successor runs B; `boot.handover adopted=5 expected=5 degraded=0 missing=0 reverted=false` in `hived.log`; `meta.handover.result` matches; `handover.json` gone. |
| `bees.survived` | all five keep their pid and generation, none stopped. |
| `midturn.kept` | `hsr-2` finishes its 9 s turn under the successor on the same pid and generation: `obs.turn_ended` after `daemon.started pid=<successor>`, the session log carries the turn. |
| `probe.ok` | `runtime.probe`: handover 5/5, canary stub bee in a fresh Cell idle after 681 ms, deleted after 52 ms, 0 degraded. `probe.cli`: the same through `hive runtime probe --json`. |
| `activate.refusals` | `not_installed`, `is_current`, `store_newer_than_target` (store min reader 59, target 58) and `invalid_request sha`, with `current` untouched. |
| `crashloop.reverted` | `runtime.activate <C>`: C exits 3 at boot three times (supervisor log: three `code 3` exits, `Restart=on-failure`); on the fourth start the launcher retargets `current -> B` and writes `rollback.json`; B boots, journals `rollback {reason: crash_loop, candidate: C, previous: B, attempts: 3}` by `launcher`, and the marker, attempts and rollback files are gone. |
| `probe.reverted` | the probe on B fails typed `activation_reverted` (to C, running B). The five bees still have their pids and generations. |
| `kill.between_census_and_boot` | `runtime.activate <A>` answers with a census of 5; `hsr-3`'s host is SIGKILLed before the successor boots. |
| `boot.handover.A.incomplete` | A boots: `expected 5, adopted 4, missing [hsr-3: stopped]`. |
| `probe.incomplete` | the probe fails typed `handover_incomplete {expected 5, adopted 4}`; `hsr-3` is `stopped(crashed)`, still reachable. |
| `systemctl.calls` | exactly three `restart --no-block` calls, nothing else; seven unit starts in total (A, B, C x3, B, A). |

## Measured

| measure | before (A) | after (B) |
|---|---|---|
| `deployInfo` RPC p50 / p95 (50 calls) | 0.2 / 0.5 ms | 0.2 / 0.9 ms |
| `runtime.status` RPC p50 / p95 (50 calls) | 0.7 / 1.2 ms | 0.8 / 1.4 ms |
| `hive runtime status` CLI | | 93 ms |
| `hive runtime activate` answer (5 live bees) | | 112 ms |
| old daemon exit after the answer | | 418 ms |
| window with no socket (old exit to successor listening) | 6.4 s on metal-3 via Apiary's SSH updater (design §1.1, 432 MB store) | 417 ms (empty store; the successor's own boot is the window) |
| `runtime.probe` (canary spawn in a Cell, idle, delete) | | 735 ms |
| crash loop: three failed starts to the previous build listening | | 2.0 s |

## Rerun

```sh
npm ci && npm run build
env -u HIVE_CELL -u HIVE_V2_DATA_DIR -u HIVE_V2_SOCKET_PATH REPO=$PWD node --experimental-strip-types .proof/D4/lab.mjs
node .agents/skills/verify-runtime-handover/handover-model.mjs
```
