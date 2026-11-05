---
name: verify-champion-lifecycle
description: Check the Champion revive, handover and fence rules of champion.start / champion.fence / champion.export and the home bundler with an explicit-state model (every order of steps on two executors, no Java needed) and the two-daemon driver. Use for /verify-champion-lifecycle, before landing any change to rpcChampionStart, restoreChampionHome, rpcChampionFence, rpcChampionExport, ChampionHomeSync.syncNow or store.takeoverChampion / fenceChampion, or when an epoch, fence or handover question comes up.
---

# Verify the Champion lifecycle

## What is verified, in one sentence each

- **A refused `champion.start` changes nothing.** Harm if broken: a handover whose home object is missing (or whose bytes do not match) still takes the epoch and stops the old incarnation, so the retry with the right bytes is `champion_fenced` and the Champion is stranded on that executor (this was the real bug M-H5 found and fixed: the takeover ran before the object check).
- **An older handover epoch never unfences a node.** Harm: a stale pointer resurrects an incarnation beside the current owner.
- **A fence with an older epoch is quiet.** Harm: a late fence message from a finished round stops the current owner's incarnation.
- **A fenced node has no live incarnation it is not stopping.** Harm: two executors run the same Champion.
- **Only one executor writes bundles under an epoch.** Harm: the Home cannot tell whose home is current; a stale home is handed over as if it were the newest. This is why a fenced node bundles nothing new, neither at a turn end while its stop settles nor for `champion.export`.
- **Epochs never go down, and a takeover owns handover + 1 unfenced.**

## Does my change touch the verified code?

| model part (`champion-lifecycle.ts`) | code |
|---|---|
| `startPlain`, `startHandover`, `applyHandover` | `v2/daemon/src/daemon.ts` `rpcChampionStart` (parameter checks, the `describe(homeRef)` check before any state change, revive / running / spawn) and `restoreChampionHome` (`home_not_empty`, set-aside, `stale_epoch`); `v2/core/src/store.ts` `takeoverChampion` |
| `fence` | `v2/daemon/src/daemon.ts` `rpcChampionFence`; `v2/core/src/store.ts` `fenceChampion` (`epoch = max`, `fenced_at`) ; the stop is an enqueued command, modelled as `stopping` until `stop` settles |
| `bundle` | `v2/daemon/src/championHomes.ts` `ChampionHomeSync.syncNow` (skipped while fenced, written under the row epoch) |
| `export` | `v2/daemon/src/daemon.ts` `rpcChampionExport` (`runtime_refused` while live, `bundleNow` under the row epoch unless fenced, latest pointer otherwise) |
| the Home (assumption, not code) | Apiary's directory row: it creates a Champion on one executor, only hands over the current owner's exported pointer, and hands each pointer over once |

Sync commit: the commit that added this skill (`git log -1 --format=%H -- .agents/skills/verify-champion-lifecycle/SKILL.md`) describes the code at the time of the last confirmation. After a change to the files above, re-read the model against the code, rerun, and only then move this line forward by committing the updated skill.

## Run

From the repository root, nothing to install (the model is TypeScript run by the pinned Node; TLA+ was not used because the satellites have no Java and the interim security rule forbids fetching one):

```sh
node --experimental-strip-types .agents/skills/verify-champion-lifecycle/champion-lifecycle.ts
```

Expected: `Model checking completed. No error has been found.` with 55822 distinct states (max epoch 3, two executors, one Champion, at most 2 bundles and 2 plain starts per node), in about 2.5 s, exit 0. A violation prints the rule, the state in the code's words and the shortest path of verbs that reaches it, exit 12.

The real code: the two-daemon driver `.proof/m-h5/m-h5-driver.ts` creates a Champion on executor A, stops and exports it, revives it on executor B from the bytes, fences A and checks the refusals (needs `npm ci` and `npm run build` once, every `HIVE_*` variable unset):

```sh
HB_M_H5_LOG=/tmp/m-h5-run.md node scripts/with-fixture-warden.mjs node --experimental-strip-types .proof/m-h5/m-h5-driver.ts
```

Expected: `ALL CHECKS PASSED`. The targeted test is `v2/daemon/tests/champions.test.ts` under `node scripts/with-fixture-warden.mjs node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/champions.test.ts`.

## Make sure the check can still fail

Each rule has a broken variant of the model; each must fail (exit 12):

```sh
for r in validateBeforeMutate handoverRefusesOlder fenceRefusesOlder fenceStopsLive startRefusedWhileFenced bundleSkippedWhileFenced; do node --experimental-strip-types .agents/skills/verify-champion-lifecycle/champion-lifecycle.ts --break $r; done
```

- `validateBeforeMutate` breaks **RefusedStartIsQuiet** in 4 steps: start A, stop A, export A, handover to B without bytes and without a shared store.
- `handoverRefusesOlder` breaks **FencedStaysFencedUntilNewerHandover** in 5 steps.
- `fenceRefusesOlder` breaks **StaleFenceIsQuiet** in 5 steps.
- `fenceStopsLive` and `startRefusedWhileFenced` break **FencedHasNoLiveIncarnation** in 2 steps.
- `bundleSkippedWhileFenced` breaks **BundleEpochsHaveOneWriter** in 7 steps (a fenced A exports and bundles under the owner's epoch).

The same break in the real code (move the `homes.describe(homeRef)` check in `rpcChampionStart` below `store.takeoverChampion`) makes the driver fail at "homeRef alone" / "bytes that do not hash to homeRef": the second call answers `champion_fenced: handover epoch 0 is older than this node's epoch 1`. Last seen: `.proof/m-h5/scratch-break-run.log`.

## Reading a failure

- A rule breaks on the main configuration: a finding against the code or an intended contract change. Do not weaken the rule. Report the path in the code's words (which verb, which epoch, which executor).
- A rule passes on main but not on its broken variant: the model is fine.
- A broken variant passes: the model no longer models that rule; fix the model, not the code.
- The driver fails while the model passes: the handler diverged from the model (parameter validation, result shape, log line); read the assertion and `/tmp/m-h5-run.md`.

## Change the verification on purpose

When the contract changes (for example a fence that also archives, or an export allowed on a fenced row), change the action in the model to match the new code first, update the rule text above, confirm the broken variants still fail, rerun the driver, and commit the skill with the code.

## Scope and bounds

- Two executors, one Champion, epochs 0..3, at most two turn-end bundles and two plain starts per executor; every interleaving of start, stop, bundle, export, handover (with and without bytes) and fence.
- Not modelled: the home-content byte level (a bundle is an origin token), the secrets refusal, the set-aside directory, `champion.archive` / `champion.delete`, mail wake of a stopped incarnation, daemon restart, and the Home's own storage. The Home's three rules above are assumptions; if Apiary breaks them (hands the same pointer twice, hands over a non-owner's export, or creates the same identity on two executors) two executors can write under the same epoch, which the model shows when the assumptions are removed.
- The model is explicit-state and bounded: a pass covers these bounds, not every size.
