# D5: the W3 client hold and the adoption of Apiary-written units

Built on main b8983705 (D4 evidence). Lab on netcup-1 (a satellite Cell), Node 24.18.0, npm 11.16.0 (`npm ci`), bwrap present. Every daemon in the lab is a scratch daemon under `/var/tmp/hb-D5-*` with its own data dir, socket, runtime root, unit dir and launcher, started and restarted by a fake service manager and stopped by its own pid. No real `systemctl` or `launchctl` ran: PATH puts `bin/systemctl` (a logging shim) first, the label is `hb.d5.test`, `HIVE_V2_SERVICE_DIR` is the lab's unit dir, and `systemctl.log` holds every call the shim received. The real unit on this node (`~/.config/systemd/user/dev.honeybee.hive.v2.service`) and `~/.hive/runtime/current` were read once to copy their shape into the lab; nothing under `~/.hive` or `~/.config` was written.

## Receipts

- `lab.mjs`: the driver. `lab.jsonl` / `lab.stdout.log`: the passing run. `hived.log`, `supervisor.log`, `systemctl.log`: the scratch node's daemon log, the fake service manager's log and the shim's call log. `adopted-unit.service`: the unit after `hive daemon install` adopted it.
- `model.log`: the extended handover model (2876 states, twelve properties) and its ten broken variants, each failing on its property.
- `tests-cli-service.log`: cli, update-service, service, readonly-status, socket-isolation, verbs-cli under the warden (94 tests, before the RPC drain was added). `tests-daemon.log`: daemon-shutdown, daemon-lifecycle, confined-peer-rpc, local-rpc-trust, answer-trigger-negotiation, execution-fence, apiary-tag-guard, effect-resolve, service, cli, update-service under the warden (77 tests, final tree). `v2-check.log`, `build.log`: `npm run v2:check` and `npm run build` on the final tree.
- `decisions.tsv`: the decision trail. `change.diff`: the change commit.
- The "before" build is the `dist` of b8983705 built in this Cell before any edit (`/var/tmp/hb-D5-before-dist`), run inside the lab for the two before-phase steps.

## What the lab proved, in order (`lab.jsonl` step names)

| step | what happened |
|---|---|
| `lab.setup` | S is an Apiary-style install at `<root>/apiary/honeybee-runtime/<hash>/lib/node_modules/honeybee` (this tree's `dist`, build identity `5555…`, a relative symlink inside); A and B are installed under `runtime/`. The unit is the explicit-entry form found on netcup-1 (`ExecStart="<node>" "<…honeybee>/dist/cli.js" "v2" "daemon" "run" "--data-dir" …`, `Restart=always`), and `runtime/current` is an absolute link to the Apiary dir. |
| `before.daemon_install` / `before.leaves_current_external` | the b8983705 CLI's `daemon install` rewrites the unit through the launcher but copies nothing and leaves `current` pointing outside `runtime/`: a later `runtime.activate` would write `previous -> 5555…` with no `runtime/5555…` to boot. |
| `daemon_install.adopt` | the new CLI, run from the Apiary install with no `HIVE_NODE_PATH` in the shell: 849 ms. |
| `adopt.copied` / `adopt.bytes` / `adopt.current` | `runtime/5555…` is a copy of the Apiary dir (tree digests equal, symlink kept), `current -> 5555…` (relative). |
| `adopt.exec_through_launcher` | ExecStart is `launch <node> v2 daemon run --data-dir <dir>`, the interpreter taken from the old unit; `KillMode=process`, `Restart=on-failure`; the data dir still parses. |
| `adopt.only_daemon_reload` / `adopt.idempotent` | exactly one `systemctl --user daemon-reload`; a second install adopts nothing, rewrites the same unit text, one more reload. |
| `daemon.S.started` / `status.S` | the fake unit starts S through the launcher: `runtime.status` says current 5555…, previous null, three installed versions. |
| `send.warm` | one stub bee idle, one `hive send` lands. |
| `activate.A.answer` / `boot.handover.A` | `runtime.activate <A>` with the sender loop running; the successor logs `boot.handover adopted=1 expected=1 degraded=0`, `previous -> 5555…`. |
| `swap.window` | the service manager waited 1.5 s before starting the successor: 1840 ms with no socket; 31 sends in the loop, 7 before, 18 inside the window, 6 after. Every send inside the window ended after the successor listened (held 486 to 1809 ms, in step with its start offset). |
| `swap.sends_exactly_once` | 0 failed, 0 duplicated, 0 acknowledged-but-missing, 0 unacknowledged-but-present; each body is in the mailbox exactly once. |
| `gap.cli_held_and_landed` / `gap.library_held_and_landed` | a `hive send` and an `RpcClient.connect` + `send` issued the moment the old pid was gone: both held about 1.9 s and landed once (library connect 1922 ms). |
| `gap.before_build_fast_failed` | the b8983705 CLI issued at the same moment: `socket_unreachable (ENOENT)` after 56 ms, nothing landed. |
| `swap.delivering` | 34 landed, deliveries progressing to the bee under the successor on generation 1. |
| `stall.activate.answer` / `stall.marker` | `runtime.activate <B>` with the service manager in stall mode: the old daemon exits, `handover.json {toSha: B}` stays, nobody starts. |
| `stall.sends` | a `hive send` and a library send issued 2 s in hold 57.7 s and fail `hived_handover_stalled` when the marker is 60 s old ("runtime/handover.json written by pid … is 60 s old and nothing listens"); a `hive send` issued 61.2 s in fails typed after 77 ms. |
| `stall.marker_still_present` | the marker is untouched by the clients. |
| `recovery.B_serves` | the service manager comes back: B boots through the launcher, `boot.handover adopted=1 expected=1`, the marker is gone, a send lands once, none of the stalled sends is in the mailbox. |
| `systemctl.calls` | exactly two `restart --no-block` calls, nothing else. |

## Measured

| measure | value |
|---|---|
| `hive daemon install` adopting a 90 MB Apiary install (copy, two tree digests, unit, reload) | 849 ms |
| window with no socket (service-manager latency 1.5 s plus the successor's boot) | 1840 ms |
| sends started inside the window | 18 of 31, all landed once |
| hold of a `hive send` started 68 ms into the window | 1809 ms |
| hold of the library client started at the window's start | 1922 ms |
| pre-D5 CLI in the same window | fails after 56 ms |
| stalled handover: send issued 2 s in | fails typed after 57.7 s, at marker age 60.0 s |
| stalled handover: send issued 61.2 s in | fails typed after 77 ms |
| handover model | 2876 states, 12 properties, 10 broken variants fail |

## Rerun

```sh
npm ci && npm run build
env -u HIVE_CELL -u HIVE_V2_DATA_DIR -u HIVE_V2_SOCKET_PATH REPO=$PWD node --experimental-strip-types .proof/D5/lab.mjs
node .agents/skills/verify-runtime-handover/handover-model.mjs
```

`BEFORE_DIST=<dist of a pre-D5 build>` adds the two before-phase steps; `START_DELAY_MS` sets the fake service manager's latency (default 1500).
