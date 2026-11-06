---
name: verify-runtime-handover
description: Check the census-and-handover protocol of runtime.activate, the crash-loop launcher and runtime.probe with an explicit-state model (every interleaving of host deaths, candidate crashes and the service-manager restart) and the recorded scratch-node lab. Use for /verify-runtime-handover, before landing any change to RuntimeUpdateService.activate, renderLauncher, recordHandoverAtBoot, removeHandoverMarker, rpcRuntimeProbe, or when a question about a lost bee across a hived swap or a candidate that never comes up comes up.
---

# Verify the runtime handover

## What is verified, in one sentence each

- **Every live runtime is adopted or the probe fails.** Harm if broken: a hived swap silently loses a bee (its host died, or the successor could not adopt it) and the rollout controller marks the machine `updated`.
- **Once the successor listens, the probe answers from the boot comparison, never "pending".** Harm: an updater waits forever for a result that nobody will write.
- **A probe never says ok while the node runs a build other than the one activated.** Harm: a reverted candidate is reported as a successful update and the rollout moves on.
- **The crash loop always ends on previous.** Harm: a candidate that dies before listening is restarted by systemd/launchd forever and the node has no hived.
- **The handover marker exists exactly from retarget until the successor listens or the launcher reverts.** Harm: a stale `handover.json` makes a later healthy boot count as a failed attempt and reverts a good version (or makes a D5 client hold forever).
- **A revert is clean.** Harm: after a crash-loop revert, a leftover marker or attempts file reverts the next activation before it gets its three tries.

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
| not modelled | the canary bee (`runCanary`), the store-compat refusal (`bundleSchemaVersion` vs `minReaderSchema`), the service-unit gate (`ownServiceUnit`), idempotency, the real service manager |

Sync commit: the commit that added this skill (`git log -1 --format=%H -- .agents/skills/verify-runtime-handover/SKILL.md`) describes the code at the time of the last confirmation. After a change to the files above, re-read the model against the code, rerun, and only then move this line forward by committing the updated skill.

## Run

From the repository root; plain Node, no install.

1. The model (about 400 states, under a second):

   ```sh
   node .agents/skills/verify-runtime-handover/handover-model.mjs
   ```

   Expected: `all properties hold: ProbeSound, ProbeSettles, ProbeReportsRevert, CrashLoopEndsOnPrevious, MarkerBoundsHandover, RevertIsClean`. A failure prints the shortest path in the code's words and the end state. `--hosts 3` widens the bound; `--json` gives a machine-readable report.

   Why an explicit-state checker in Node and not TLA+: the satellites and Cells this repo is verified on have Node (pinned) and no Java, and the model is a six-phase protocol with a handful of booleans, well inside what a breadth-first search enumerates completely. The `verify-lease-verbs` skill shows the TLA+ shape if a reviewer prefers it.

2. The real code. The lab in `.proof/D4/lab.mjs` starts one scratch node under `/var/tmp` (own data dir, socket, runtime root, unit file, launcher) with a PATH-shimmed `systemctl` and a Node supervisor playing systemd (SIGTERM to the main pid on `restart --no-block`, run the launcher again, `Restart=on-failure`), then: five stub bees (three hsr, two Cells), one mid-turn, `hive runtime activate` to a second version, `boot.handover adopted=5 expected=5`, the mid-turn bee finishing on the same generation and pid, `runtime.probe` with its stub canary in a fresh Cell, the four typed refusals, a candidate that exits at boot three times reverting to previous (`rollback: crash_loop`, `activation_reverted`), and a host killed between census and boot (`handover_incomplete`).

   ```sh
   npm ci && npm run build
   env -u HIVE_CELL -u HIVE_V2_DATA_DIR -u HIVE_V2_SOCKET_PATH REPO=$PWD node --experimental-strip-types .proof/D4/lab.mjs
   ```

   Expected: the last line is `{"step":"lab.done","pass":true}` and `.proof/D4/lab.jsonl` holds every step. Recorded run: `.proof/D4/lab.jsonl`, `lab.stdout.log`, `hived.log`, `supervisor.log`, `systemctl.log`. Nothing in the lab calls a real service manager or touches `~/.hive`.

## Make sure the check can still fail

Each rule has a broken variant of the model that must fail (`--break <name>`):

- `probe-ignores-census` (the probe answers ok without comparing `adopted` with `expected`) breaks **ProbeSound** in 7 steps: census, host 0 dies, retarget, old daemon exits, launch, boot adopts one of two, probe ok.
- `probe-ignores-reverted` (the probe does not look at `result.reverted`) breaks **ProbeReportsRevert** in 12 steps: three candidate crashes, the launcher reverts, previous listens, probe ok.
- `launcher-never-reverts` (the `N > 3` branch removed) breaks **CrashLoopEndsOnPrevious** in 11 steps: a fourth start of the dead candidate.
- `launcher-keeps-marker` (the `rm handover.json handover.attempts` after the revert removed) breaks **MarkerBoundsHandover** in 10 steps and **RevertIsClean**.
- `marker-removed-before-listen` (the daemon removes the marker before `rpc.listen`) breaks **CrashLoopEndsOnPrevious** in 11 steps: a candidate that dies at listen is not counted, so it is started a fourth time.
- `boot-skips-comparison` (`recordHandoverAtBoot` removed) breaks **ProbeSettles** in 6 steps: the probe answers `handover_pending` after the successor listens.

The same break in the real code shows in the lab: with the `N > 3` branch deleted from `renderLauncher`, the lab fails right after `activate.C.answer` because no successor ever listens, and the supervisor log in the failure shows the dead candidate started hundreds of times with no revert. Last seen: `.proof/D4/scratch-break-launcher.log` (356 starts in the 120 s wait).

## Reading a failure

- A property breaks on the main configuration: a finding against the code or an intended contract change. Do not weaken the property. Report the path in the code's words (which step of activate, the launcher or boot let the state through).
- A property passes on the main configuration but not on its broken variant: the model is fine.
- A broken variant passes: the model no longer models that rule; fix the model, not the code.
- The lab fails but the model passes: the daemon diverged from the model (ordering of marker removal and listen, the census shape, the probe's refusal reasons, the launcher text); read the failing step's detail in `lab.jsonl`.

## Change the verification on purpose

When the contract changes (for example a second attempt budget, or the marker removed before listen with a different crash counter), change `launch`, `bootCompare` or the `cand_booting` successors first, update the rule text above, confirm the broken variants still fail, rerun the lab, and commit the skill with the code.

## Scope and bounds

- Two versions (A running, B the candidate), two runner hosts by default (`--hosts`), three attempts, one activation per behaviour. Hosts may die in any phase; the candidate may crash before listening at each attempt.
- Not modelled: the canary bee, the store schema gate, the service-unit gate, the real service manager's own start limits (systemd `StartLimitBurst`), time, a second activation issued while a handover is in flight (the runtime lock serialises it in the code), and macOS `launchctl kickstart -k` (the same shape; the lab shims it but exercises only the systemd branch).
