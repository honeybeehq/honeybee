---
name: verify-runtime-handover
description: Check the census-and-handover protocol of runtime.activate, the crash-loop launcher, runtime.probe and the W3 client hold with an explicit-state model (every interleaving of host deaths, candidate crashes, the service-manager restart or stall, the marker ageing past the hold and one client send) and the recorded scratch-node labs. Use for /verify-runtime-handover, before landing any change to RuntimeUpdateService.activate, renderLauncher, recordHandoverAtBoot, removeHandoverMarker, rpcRuntimeProbe, RpcClient.connect, RpcServer.close, or when a question about a lost bee, a lost or doubled send across a hived swap, or a candidate that never comes up comes up.
---

# Verify the runtime handover

## What is verified, in one sentence each

- **Every live runtime is adopted or the probe fails.** Harm if broken: a hived swap silently loses a bee (its host died, or the successor could not adopt it) and the rollout controller marks the machine `updated`.
- **Once the successor listens, the probe answers from the boot comparison, never "pending".** Harm: an updater waits forever for a result that nobody will write.
- **A probe never says ok while the node runs a build other than the one activated.** Harm: a reverted candidate is reported as a successful update and the rollout moves on.
- **The crash loop always ends on previous.** Harm: a candidate that dies before listening is restarted by systemd/launchd forever and the node has no hived.
- **The handover marker exists exactly from retarget until the successor listens or the launcher reverts.** Harm: a stale `handover.json` makes a later healthy boot count as a failed attempt and reverts a good version (or makes a D5 client hold forever).
- **A revert is clean.** Harm: after a crash-loop revert, a leftover marker or attempts file reverts the next activation before it gets its three tries.
- **A send across the swap lands exactly once and the client is told the truth.** Harm: a `hive send` (or apiaryd's consumer) issued in the window with no socket fails as "daemon down" although the swap is seconds from done, or a retry doubles a message, or the old daemon cuts a request it had already committed and the caller never learns which.
- **The client waits only on a fresh marker and fails typed once it is stale.** Harm: a client holds forever on a stall that nobody will finish, or gives up while a healthy handover is still in flight.

## Does my change touch the verified code?

| model part (`handover-model.mjs`) | code |
|---|---|
| `old_running -> old_censused` (census) | `v2/daemon/src/daemon.ts` `liveRuntimeCensus`; `v2/daemon/src/runtimeUpdate.ts` `activate`: `store.setHandover({..., runtimes, result: null})` |
| `old_censused -> old_stopping` (retarget, marker, restart) | `activate`: `retargetLink(PREVIOUS)`, `retargetLink(CURRENT)`, `rm handover.attempts`, `writeMarker`, `appendRuntimeJournal("activated")`, the delayed `restartService` |
| `old_stopping -> unit_down` | `v2/daemon/src/main.ts` SIGTERM -> `daemon.shutdown({preserveRuntimes: true})` (`detachAll`, no signals) |
| `launch(s)` | `v2/daemon/src/launcher.ts` `renderLauncher` (`N > 3 && -L previous` -> `ln -sfn previous current`, `rollback.json`, `rm handover.json handover.attempts`) |
| `bootCompare(s)` | `daemon.ts` `recordHandoverAtBoot` (`store.handover()`, `hasProcess`/`isDegraded` per census row, `store.setHandover({...result})`, `takeRollbackRecord` -> journal `rollback`) |
| marker removal after listen | `daemon.ts` `start()`: `removeHandoverMarker` right after `rpc.listen` |
| probe outcomes | `daemon.ts` `rpcRuntimeProbe`: `handover_pending`, `activation_reverted`, `handover_incomplete`, ok |
| `clientAttempts(s)` / `refused(t)` | `v2/cli/src/client.ts` `RpcClient.connect`: a `DaemonDownError` from one connect is retried every 100 ms while `readHandoverMarker(runtimeRootOf(dataDir))` is younger than `HANDOVER_HOLD_MS` (60 s), fails `HandoverStalledError` (`hived_handover_stalled`) once it is older, and without a marker retries a refusal once (the successor removes the marker right after it listens) before `DaemonDownError` |
| `time: handover.json turns 60 s old` | `handoverMarker.ts` `HANDOVER_HOLD_MS`; the marker's `at` |
| `old_stopping` send accepted and acknowledged | `v2/daemon/src/rpc.ts` `RpcServer.close`: `server.close()` first (the socket path is unlinked, new connects get `ENOENT`), then `drainConnections` waits until every connection has no in-flight request and has been quiet for 150 ms (1 s cap), then destroys |
| not modelled | the canary bee (`runCanary`), the store-compat refusal (`bundleSchemaVersion` vs `minReaderSchema`), the service-unit gate (`ownServiceUnit`), idempotency, the real service manager, the unit adoption in `hive daemon install` (`adoptExternalCurrent`), a request that outlives the 1 s drain cap |

Sync commit: the commit that added this skill (`git log -1 --format=%H -- .agents/skills/verify-runtime-handover/SKILL.md`) describes the code at the time of the last confirmation. After a change to the files above, re-read the model against the code, rerun, and only then move this line forward by committing the updated skill.

## Run

From the repository root; plain Node, no install.

1. The model (about 400 states, under a second):

   ```sh
   node .agents/skills/verify-runtime-handover/handover-model.mjs
   ```

   Expected: `all properties hold: ProbeSound, ProbeSettles, ProbeReportsRevert, CrashLoopEndsOnPrevious, MarkerBoundsHandover, RevertIsClean, SendNeverDuplicated, SendOutcomeIsTrue, SendOutcomeIsKnown, HeldWhileMarkerFresh, HoldOnlyOnFreshMarker, StallIsTyped` (about 2900 states). A failure prints the shortest path in the code's words and the end state. `--hosts 3` widens the bound; `--json` gives a machine-readable report.

   Why an explicit-state checker in Node and not TLA+: the satellites and Cells this repo is verified on have Node (pinned) and no Java, and the model is a six-phase protocol with a handful of booleans, well inside what a breadth-first search enumerates completely. The `verify-lease-verbs` skill shows the TLA+ shape if a reviewer prefers it.

2. The real code. The lab in `.proof/D4/lab.mjs` starts one scratch node under `/var/tmp` (own data dir, socket, runtime root, unit file, launcher) with a PATH-shimmed `systemctl` and a Node supervisor playing systemd (SIGTERM to the main pid on `restart --no-block`, run the launcher again, `Restart=on-failure`), then: five stub bees (three hsr, two Cells), one mid-turn, `hive runtime activate` to a second version, `boot.handover adopted=5 expected=5`, the mid-turn bee finishing on the same generation and pid, `runtime.probe` with its stub canary in a fresh Cell, the four typed refusals, a candidate that exits at boot three times reverting to previous (`rollback: crash_loop`, `activation_reverted`), and a host killed between census and boot (`handover_incomplete`).

   ```sh
   npm ci && npm run build
   env -u HIVE_CELL -u HIVE_V2_DATA_DIR -u HIVE_V2_SOCKET_PATH REPO=$PWD node --experimental-strip-types .proof/D4/lab.mjs
   ```

   Expected: the last line is `{"step":"lab.done","pass":true}` and `.proof/D4/lab.jsonl` holds every step. Recorded run: `.proof/D4/lab.jsonl`, `lab.stdout.log`, `hived.log`, `supervisor.log`, `systemctl.log`. Nothing in the lab calls a real service manager or touches `~/.hive`.

3. The client side. The lab in `.proof/D5/lab.mjs` uses the same fake service manager with a configurable start latency and a stall mode: `hive daemon install` adopts an Apiary-written explicit-entry unit (copy into `runtime/<sha>`, `current` retargeted, ExecStart through the launcher, one `daemon-reload`); a `hive send` loop runs across an activate while the service manager takes 1.5 s to start the successor, and every send started with no socket is held and lands exactly once, together with one library-client send and one send from the pre-D5 build that fast-fails; a stalled handover (the unit is never started again) fails a send issued 2 s in with `hived_handover_stalled` when the marker turns 60 s old and one issued 61 s in at once; the recovered successor serves again.

   ```sh
   env -u HIVE_CELL -u HIVE_V2_DATA_DIR -u HIVE_V2_SOCKET_PATH REPO=$PWD node --experimental-strip-types .proof/D5/lab.mjs
   ```

   Expected: the last line is `{"step":"lab.done","pass":true}`; about 90 s, most of it the 61 s stall. `BEFORE_DIST=<dist of a pre-D5 build>` adds the two before-phase steps. Recorded run: `.proof/D5/lab.jsonl`, `lab.stdout.log`, `hived.log`, `supervisor.log`, `systemctl.log`, `adopted-unit.service`.

## Make sure the check can still fail

Each rule has a broken variant of the model that must fail (`--break <name>`):

- `probe-ignores-census` (the probe answers ok without comparing `adopted` with `expected`) breaks **ProbeSound** in 7 steps: census, host 0 dies, retarget, old daemon exits, launch, boot adopts one of two, probe ok.
- `probe-ignores-reverted` (the probe does not look at `result.reverted`) breaks **ProbeReportsRevert** in 12 steps: three candidate crashes, the launcher reverts, previous listens, probe ok.
- `launcher-never-reverts` (the `N > 3` branch removed) breaks **CrashLoopEndsOnPrevious** in 11 steps: a fourth start of the dead candidate.
- `launcher-keeps-marker` (the `rm handover.json handover.attempts` after the revert removed) breaks **MarkerBoundsHandover** in 10 steps and **RevertIsClean**.
- `marker-removed-before-listen` (the daemon removes the marker before `rpc.listen`) breaks **CrashLoopEndsOnPrevious** in 11 steps: a candidate that dies at listen is not counted, so it is started a fourth time.
- `boot-skips-comparison` (`recordHandoverAtBoot` removed) breaks **ProbeSettles** in 6 steps: the probe answers `handover_pending` after the successor listens.
- `client-fails-fast` (the connect treats a refusal as `DaemonDownError` even with a fresh marker) breaks **HeldWhileMarkerFresh** in 3 steps: census, retarget, a send refused by the closing old daemon fails.
- `client-holds-forever` (no `HandoverStalledError` once the marker is older than the hold) breaks **HoldOnlyOnFreshMarker** in 4 steps: the marker turns 60 s old and a refused client still decides to wait.
- `client-retries-after-ack` (a client reissues a send the daemon answered) breaks **SendNeverDuplicated** in 3 steps.
- `close-cuts-in-flight` (`RpcServer.close` destroys connections without draining) breaks **SendOutcomeIsKnown** in 3 steps: a send accepted by the old daemon in `old_stopping` is committed, or its frame unread, and the connection is destroyed before any answer.

The same break in the real code shows in the lab: with the `N > 3` branch deleted from `renderLauncher`, the lab fails right after `activate.C.answer` because no successor ever listens, and the supervisor log in the failure shows the dead candidate started hundreds of times with no revert. Last seen: `.proof/D4/scratch-break-launcher.log` (356 starts in the 120 s wait).

## Reading a failure

- A property breaks on the main configuration: a finding against the code or an intended contract change. Do not weaken the property. Report the path in the code's words (which step of activate, the launcher or boot let the state through).
- A property passes on the main configuration but not on its broken variant: the model is fine.
- A broken variant passes: the model no longer models that rule; fix the model, not the code.
- The lab fails but the model passes: the daemon diverged from the model (ordering of marker removal and listen, the census shape, the probe's refusal reasons, the launcher text); read the failing step's detail in `lab.jsonl`.

## Change the verification on purpose

When the contract changes (for example a second attempt budget, or the marker removed before listen with a different crash counter), change `launch`, `bootCompare` or the `cand_booting` successors first, update the rule text above, confirm the broken variants still fail, rerun the lab, and commit the skill with the code.

## Scope and bounds

- Two versions (A running, B the candidate), two runner hosts by default (`--hosts`), three attempts, one activation per behaviour, one client with one send issued at any point (and retried while holding). Hosts may die in any phase; the candidate may crash before listening at each attempt; the service manager may never start the unit (the marker then ages past the hold).
- Time is one bit: the marker is fresh or 60 s old. The client's retry cadence, the 150 ms quiet window and the 1 s cap of the drain are not modelled; a request that outlives the cap is cut as before.
- The gap the hold does not cover: after a crash-loop revert the launcher removes the marker before the previous build boots, so a client refused in that boot window gets `DaemonDownError` (the model allows `down` there, with no marker, and the send is not in the mailbox: the caller is told).
- Not modelled: the canary bee, the store schema gate, the service-unit gate, the real service manager's own start limits (systemd `StartLimitBurst`), a second activation issued while a handover is in flight (the runtime lock serialises it in the code), the unit adoption in `hive daemon install`, and macOS `launchctl kickstart -k` (the same shape; the labs shim it but exercise only the systemd branch).
