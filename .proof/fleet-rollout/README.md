# fleet-rollout: one script that brings a host's hived to a build with every bee kept

`scripts/fleet-rollout.mjs <[user@]host> <sha> [--artifact <dir>|<host>:<dir>] [--dry-run] [--no-probe] [--allow-low-disk] [--json]`, run from the Studio over SSH. Also `--inventory` (reads only) and `--rollback`. The host `local` runs the same steps on this machine without SSH. `--lab-root <dir>` points every path, the unit and the service manager at a scratch node; it is never used against a real host.

What one run does, in order: read the host (platform, unit form, running build through `deploy-info`, store schema and min reader through `runtime status` or the running bundle, live runtime census through `list`, disk, zombies); no-op if the host already runs `<sha>` through the launcher; verify the artifact locally (SHA256SUMS, manifest, unpacked build identity, `dist/.build-stamp.json` against `artifactHash`, the natives for the host target, the bundle's `SCHEMA_VERSION`); preflight (unit names the data dir, `KillMode=process` on Linux, store min reader ≤ target schema, node pin ≥ 20, ≥ 1 GiB free, no handover in flight, no booting runtime); save the unit bytes and the census under `runtime/.fleet-rollout/<ts>/`; scp the artifact, verify sums on the host, unpack to a stage, re-check identity and stamp, rename to `runtime/<sha>`; `hive daemon install` from the new build with the old unit's PATH (adopts the Apiary explicit entry: the running build is copied into `runtime/<oldSha>`, `current` points at it, the launcher is written, ExecStart goes through it); then the switch. A running build with `runtime.activate` and a unit already in launcher form is switched by `hive runtime activate <sha>` from the running build's CLI. Otherwise (first hop from 9d95df22 or older, or a unit that changed form this run) the script does what activate does from outside: `previous -> old`, `current -> sha` (symlink + rename), `handover.json`, then `systemctl --user daemon-reload && systemctl --user restart` (Linux) or `launchctl bootout` + wait + `bootstrap` (macOS). After either: wait for a new pid that answers `deploy-info` with `<sha>`, compare the census (same bee, generation and pid, not stopped), read the daemon's own `boot adopted=N stopped=M` line, check `current`, `previous` and that the marker is gone, then `hive runtime probe`.

`--rollback` restores the saved unit byte for byte and the `current`/`previous` link targets, restarts, and verifies the old build serves with the census kept. It refuses when the store's min reader is above the old build's schema (the old build would refuse the store) unless `--force-store` is passed after the pre-migration store backup was restored by hand.

## Lab

`lab.mjs` (Studio side) builds a scratch node on a Linux host with `lab-setup.mjs` (host side): a copy of a real Apiary install (`<lab>/apiary/honeybee-runtime/<hash>/lib/node_modules/honeybee`), the Apiary explicit-entry unit copied from netcup-1's real unit with lab paths, a PATH-shimmed `systemctl` logging every call, a Node supervisor playing systemd (SIGTERM the main pid only, re-exec whatever ExecStart the unit names, restart on non-zero exit, a fixed environment like the user manager's) and three stub bees. It then drives `scripts/fleet-rollout.mjs` from the Studio with `--lab-root`, exactly as the coordinator will against a real host. Nothing under `~/.hive`, `~/.config` or a real service manager is touched; the real runtime dirs are only read.

Two runs on netcup-1 (Node 24.18.0, the artifact built there from a git bundle of b3c17a40 with `npm ci` from the lockfile, `--skip-tests`, see below):

| step | hop-9d95df22 (metal-2/3, netcup-1..4, the minis' shape) | hop-956ef2e2 (metal-1's shape) |
|---|---|---|
| old node | 9d95df22, protocol v2/2, store 59/59, 3 stub bees idle | 956ef2e2, protocol v2/1, store schema 51, no min reader, 3 stub bees idle |
| `--inventory` | explicit unit, KillMode=process, activate absent, 3 live runtimes | same, store read from the bundle (`build schema 51`) |
| `--dry-run` | 14.5 s, every step printed, unit bytes, links, main pid and mutating systemctl calls unchanged | 19.0 s, same |
| first hop to b3c17a40 | 43.9 s wall from the Studio; route "first hop (marker + service restart)"; `boot adopted=3 stopped=0`; census 3/3 same pid and generation; `current -> b3c17a40`, `previous -> 9d95df22`, marker gone; probe canary idle after 661 ms; one `restart`, one `daemon-reload`; mail sent through the new CLI delivered to the adopted bee on generation 1 | 38.4 s; same; store migrated 51 → 59/59; canary idle after 496 ms; mail delivered |
| second run | no-op ("already runs … through the launcher"), no restart | same |
| `--rollback` | 4.3 s; unit restored byte for byte (sha256 equal), `current` back to the absolute Apiary link, `previous` removed; 9d95df22 serves again, `boot adopted=3 stopped=0`; mail delivered under the old build | refused typed `rollback_refused` ("the store now needs a reader at schema 59; 956ef2e2 is schema 51 …"), nothing changed; `--rollback --dry-run --force-store` plans the restore |
| first hop again after rollback | adopted 3/3 | (not applicable) |
| hop to lab build B (`runtime.activate`) | 56.3 s; `boot.handover adopted=3 expected=3 degraded=0 reverted=false`; one `restart --no-block` issued by the daemon; mail delivered | 27.5 s; same |
| second run to B | no-op | no-op |
| hop to lab build C that exits at boot | 37.0 s; typed `activation_reverted`; the launcher's `boot.rollback reason=crash_loop candidate=C previous=B attempts=3`; B serves, bees kept, mail delivered | 46.7 s; same |

Receipts: `hop-9d95df22.jsonl`, `hop-956ef2e2.jsonl` (every step with the rollout's own step log), `*-logs/` (the scratch node's hived.log, the supervisor's log, the systemctl shim's call log, the final unit).

Earlier runs found two defects that are fixed in the committed script: the activate command was issued through the candidate build's CLI (a broken candidate could not even be activated; now the running build's CLI), and a lab-only one: the supervisor passed the restarting caller's environment to the daemon, so the successor looked for runner sockets under another TMPDIR and refused delivery `not_ready`; systemd uses the unit's environment, and the supervisor now does too.

## macOS lab (`lab-mac.mjs`, this Mac, the real launchd under the fake label `hb.fleet.lab`)

A scratch node under `/var/tmp/hb-mac-lab-*`: a copy of the Studio's installed 9d95df22 runtime laid out as an Apiary install, a mini-shaped explicit-entry plist (no AbandonProcessGroup) bootstrapped into `gui/501` under `hb.fleet.lab`, three stub bees; `scripts/fleet-rollout.mjs local <sha> --lab-root <root>` drives it. `dev.honeybee.hive.v2` is never touched. Run `mac-hop.jsonl`:

| step | result |
|---|---|
| old daemon under launchd | 9d95df22, job pid matches `deploy-info`, 3 stub bees idle |
| `--dry-run` | 2.7 s, plist bytes, links and the job's pid unchanged |
| first hop to b3c17a40 | 19.1 s; `launchctl bootout` + wait + `bootstrap`; successor is the job's new pid; `boot adopted=3 stopped=0`; plist `ProgramArguments` through `runtime/launch` with `AbandonProcessGroup`; `current -> b3c17a40`, `previous -> 9d95df22`; probe canary idle 601 ms; mail delivered to an adopted bee |
| second run | no-op, same job pid |
| `--rollback` | 2.1 s; plist restored byte for byte (explicit 9d95df22 entry), `current` back to the absolute Apiary link; 9d95df22 adopts 3/3 under a new job pid; mail delivered |
| first hop again | adopted 3/3, mail delivered |

## Artifact gate on netcup-1

The full gate (`node scripts/build-runtime-artifact.mjs b3c17a40… --out …`) failed there on `npm run v2:daemon`: `delivery-file-read.test.ts` ("Sandboxed Linux delivery read fixture requires a base outside private mounts") and `handoff.rpc.cross-family` (Node 24.18.0 `FATAL ERROR: v8::HandleScope::CreateHandle()` in a worker during cleanup). Neither touches this change; the Studio's full gate for b3c17a40 was green. The lab artifact is `gate=tests-skipped` (`artifactHash d9c8e4fa…`, `sha256 4a9ed704…`). A third run with `TMPDIR=/home/trmd/hbt` (the fixture needs a base outside `/tmp`, `/var/tmp` and `/dev`) passed every gate step: `runtime-artifact: ok b3c17a40c2dd gate=full`, the same `artifactHash d9c8e4fa…` (identical dist bytes), tarball `sha256 c93710ab…`, at `trmd@netcup-1:/var/tmp/hb-fleet-build/artifact-full`.

## CI on main

fc5dd157 widened `account.lease.install` labels to `isAccountLabel` but left `accounts-rpc.test.ts` expecting `invalid_request` for labels with a slash, a backslash or a space; runs 42822057752 and 42828633533 failed on that test deterministically (`account_lease_conflict` instead). cd9b8faa updates the test to the new rule (blank, control-character and overlong labels refused; a human label renews).
