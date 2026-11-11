# Cell disk retention — Honeybee contract (v31)

Locked for Apiary. Schema **v31**. Protocol stays `v2/1`; capabilities `cell.retention.v1` and `cell.retention.trim.v1` are additive.

Base: the v22 `cells` registry + the A2 dirty guard (`driver-cell/remove.ts`) + generation-fenced revive.
Graft: a fourth Cell state, `evicted`, a bounded daily pass in the daemon, and trimming of rebuildable build output from Cells that stay.
Reject: Apiary-side reaping of `~/.hive/v2/cells`; deleting a dirty Cell automatically; deleting the bee, its mailbox or its transcript to reclaim disk; a byte budget that touches Cells with a live runtime.

Why: `hive archive` keeps the Cell (spec 05 point 7) so a message can revive the bee, and nothing ever reclaimed it. On 2026-09-24 the operator's Studio held 815 Cells (~900 GB by `du`), 511 of them owned by archived bees that had been idle for days to weeks. Honeybee owns Cells, so Honeybee reclaims them.

---

## States

```
active ──(move commit)──▶ retained ──(retained.remove | retention)──▶ removed
  │ ▲
  │ └──(next runtime start re-provisions in place)── evicted
  └────(retention pass | cell.evict)─────────────────────┘
evicted ──(bee delete / legacy cell.remove)──▶ removed
```

- `evicted`: the directory is gone; the row, its id, `bees.cell_id`, `bees.cwd`, the session log and the mailbox are all kept. `evicted_at` and `evicted_head` (the Cell HEAD, verified reachable from the origin at eviction) are recorded.
- Revive of an evicted bee is ordinary revive: `CellDriver.start` finds no ledger and provisions the same wrapper/space path at `evicted_head` (falling back to the spawn sha if that commit has since vanished from the origin). The driver reports materialization (`onCellMaterialized`) and the daemon flips `evicted → active` (`cell.reprovisioned` in the log). Same cwd ⇒ Claude/Codex session continuation is unaffected.
- `retained` Cells (their bee moved to a regular checkout) are *removed*, not evicted, once clean and old: nothing would ever re-provision them.

## Clean

A Cell is **clean** when the A2 dirty report is empty: no uncommitted working-tree change (`git status --porcelain`), no stash (`git stash list`), HEAD *and every local branch tip* landed in the origin (no unlanded commits — a branch the agent committed to and then switched away from counts, and the report names it in `unlandedBranches`), and the origin repository still exists. Ignored files do not make a Cell dirty. **Submodules (P7b):** the superproject status ignores submodules, so every populated submodule is inspected on its own; one with a moved pointer, edits, untracked or ignored files, a stash, a HEAD or local branch on no remote-tracking ref, or nested submodules makes the Cell dirty. The report shape is unchanged: this counts as `uncommitted` (gc reason `dirty_uncommitted`), and the submodule paths appear in the refusal message, the `cell.retention.submodule_hold` log line and the pass's `cell.retention.pass` audit row (`submoduleHolds`). Unpopulated submodules hold nothing local and do not count. Only clean Cells are ever reclaimed automatically. Dirty Cells are listed as `hold` with the cause (`dirty_uncommitted`, `dirty_unlanded`, `dirty_stash`, `dirty_origin_unknown`); the operator decides with `hive cell evict <bee> --force` or `hive cell remove <bee> --force`.

**Landed under other SHAs.** Landing queues rebase, cherry-pick and squash, so a Cell's work usually reaches main as different commits. A tip the origin does not contain is still landed when every commit on it since the provisioned sha is landed against a landing target — the origin's `main`/`master`, `origin/HEAD`, `origin/main`/`origin/master`, and the target branch of each landing receipt, minus any target that is an ancestor of another (`driver-cell/src/landed.ts`). A commit is landed when any of these holds:

1. it is reachable from a target, or from the source head of a succeeded `land` action (Honeybee `cell.capture` or Apiary's landing queue) whose result commit a target contains;
2. merging the tip into the target is clean and yields the target's own tree (squash, rebase);
3. a target commit since the provisioned sha has the same stable zero-context patch-id, and replaying the Cell commit against that historical target commit leaves its tree unchanged. A kept-both append also qualifies when both changes preserve the same newline-terminated original prefix and append the exact same suffix to the same regular files. Patch-id alone cannot distinguish edits to repeated code blocks;
4. replaying the commit onto the target is clean and changes nothing (a rebase whose conflict was resolved to the Cell's version).

Checks 2 and 4 are skipped when a blob-level prefilter already shows the merge would change the target (a change away from blob X at a path where the target still holds X, or still lacks a path the change added). Every check fails closed: a conflict, a git error, a git without `merge-tree --write-tree` (< 2.38) or `--merge-base` (< 2.40), more than 500 commits on a tip, more than 5000 target commits since the provisioned sha, more than 4 current-target replay probes or 32 historical probes per Cell, or more than 15 s of probing per Cell leaves commits unlanded. A commit whose landed copy changed its own lines (a review edit inside the change, a conflict resolved inside it) is not recognised and keeps the Cell. The probes run in the Cell with the Cell's and the origin's object stores as alternates and a throwaway primary object directory, so neither repository is written. The report names the blocking commits in `unlandedCommits` (newest first, at most 20) with `unlandedCommitCount`, and the refusal message lists them. Uncommitted changes, untracked files and stashes are unaffected: they always block.

**Ignored env files are preserved.** Git-ignored `.env` and `.env.*` files at any depth (outside fully-ignored directories such as `node_modules`) are often per-Cell and unique. Before the park, eviction copies them, mode `0600`, to `<data-dir>/cell-env/<spaceName>/<space-relative path>` (beside `cells/`; `~/.hive/v2/cell-env/…` in production), lists them in the `cell.evicted` audit payload, the `cell.retention.evicted … env_files=N env_stash=…` log line and the `cell.gc` / `cell.evict` results (`envFiles`). When the Cell is re-provisioned on revive, the daemon restores them into the same relative paths (never overwriting a file that already exists), logs `cell.env.restored`, and removes only successfully restored copies. Existing destination files are never overwritten; conflicting originals remain in `cell-env/`, and a later eviction refuses to overwrite them. Git inspection errors prevent eviction. A Cell that is never revived keeps its copy under `cell-env/` until the operator removes it.

## Ignored files

Retention deletes only what is known to be rebuildable. `git status --porcelain -z --ignored=matching` lists each ignored path collapsed to the directory or file that matches an ignore rule (also inside untracked directories), and each falls into exactly one class:

| class | rule | trim | eviction |
|---|---|---|---|
| env | file named `.env` or `.env.*` | untouched | copied to `cell-env/` (above) |
| install | any path through a `node_modules`, `.venv`, `venv` or `Pods` directory; `.DS_Store` files | untouched | deleted with the wrapper |
| build output | directory named in `trimPatterns`, or file matching a `*.ext` pattern | parked and deleted | deleted with the wrapper |
| kept | everything else (`.proof/`, `tmp/`, `artifacts/`, `.claude/worktrees/`, `.vercel/`, local configs) | untouched | moved to `cell-keep/`, moved back on revive |

**Kept files survive eviction.** Before the park, eviction writes `<data-dir>/cell-keep/<spaceName>.json` (the manifest, always replaced atomically) and then *renames* each kept path to `<data-dir>/cell-keep/<spaceName>/<space-relative path>` — same volume, no copy, no added disk. A kept path git lists but the filesystem cannot find refuses the eviction. If any move or the park itself fails, every moved path is renamed back and the manifest removed. `cell-keep/` sits beside the real (symlink-resolved) cells root, so the renames never cross volumes. After the park, the result, the `cell.evicted` audit payload (`keptPaths`) and the log line (`kept=N keep_stash=…`) list them. On re-provision the daemon renames them back (`cell.keep.restored paths= conflicts=`), never over an existing path and never through a symlinked parent; such a path is a conflict, stays in `cell-keep/` and in the manifest, and does not stop the other paths from returning. An unrestored keep refuses the next eviction of the same space, so two evictions never mix. At boot the daemon restores any keep whose Cell is `active` with its space present (a crash between the moves and the park). A `retained` Cell's kept paths are moved the same way when the Cell is removed; nothing restores them, and they stay until the operator removes them.

## Trim

A Cell that stays (held as dirty or too young, or kept within the age floors) still loses its build output once idle for `trimAfterHours`. The pass plans `trim` per Cell alongside its verdict. Apply runs after the evictions: a worker re-classifies each planned Cell (`verifyTrimPaths`) and drops any path that is no longer ignored build output, is a symlink or sits under a symlinked parent, contains a `.git` (a nested repository), or whose own mtime or a direct child's is inside the idle window (`recently_modified` — a dev server or build that runs outside the bee). The main thread then re-checks state, lifecycle, live runtime, in-flight op, move, handoff and idleness **now** and renames each confirmed path into `<cells-root>/_evicting/<wrapper>.trim.<ts>.<pid>/` (`parkTrimPaths`, filesystem checks only), which the sweep deletes. Skipped paths are reported in `trimOutcomes`. Trim never touches tracked files, the index, refs, env files, installs or kept files, so it never changes the dirty report; a Cell with a live runtime or one being evicted is never trimmed. Default patterns: `.next .nuxt .svelte-kit .turbo .parcel-cache .gradle .test-dist DerivedData target build dist out *.tsbuildinfo`.

## Policy (`config.json` → `cells.retention`)

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | automatic passes (scheduled and disk pressure) on/off (`hive cell gc` works either way) |
| `archivedAfterDays` | `7` (satellites `3`) | evict a clean Cell whose bee has been archived at least this long |
| `stoppedAfterDays` | `30` | evict a clean Cell whose *active* bee has had no runtime and no output for this long; `null` = never by age |
| `retainedAfterDays` | `14` | remove a clean `retained` Cell this long after the move; `null` = never |
| `maxBytes` | `null` (satellites: 50% of the Cells volume) | when total Cell bytes (du semantics) exceed this, also evict clean *young* Cells, archived first then stopped, oldest idle first, until under budget; never a live runtime, never dirty. The bytes are walked only when `statfs` shows the volume holding more than the budget, since the Cells cannot exceed a budget their volume does not |
| `intervalHours` | `24` | cadence of the automatic pass (first pass 5 min after boot) |
| `maxPerPass` | `100` | evictions per pass; the rest are reported `hold/pass_limit` |
| `trimAfterHours` | `24` | trim build output of Cells idle at least this long; `null` = never |
| `trimPatterns` | see Trim | directory names, or `*.ext` file suffixes, that count as build output |
| `leftoverPatterns` | `[]` | top-level entry names (`*` globs) the operator declares as agent leftovers, never work: untracked ones do not make a Cell dirty, ignored ones are deleted on eviction instead of kept, none enter a WIP snapshot. Empty by default: an untracked file is work and an ignored file is kept unless this list says otherwise. `hive cell gc` prints how many Cells hold only leftovers |
| `minFreePercent` | satellites `10`; other nodes `null` | disk-pressure floor term: percent of the Cells volume kept free; `null` drops the term |
| `minFreeBytes` | satellites `53687091200` (50 GiB); other nodes `null` | disk-pressure floor term in bytes; `null` drops it; both `null` = no pressure trigger (the workstation default) |
| `pressureIdleAfterDays` | `3` | under pressure, Cells of active bees stopped this long are eligible, even with `stoppedAfterDays: null`; `null` = never |
| `fetchUpstream` | satellites `true`; other nodes `false` | keep a fetch-only upstream mirror per origin and use it as a landing target |
| `maxEvictionsPerDay` | `200` | at most this many Cells evicted or removed by retention passes (scheduled, pressure, manual `gc --apply`) in any rolling 24 h; further candidates are held `pass_limit` and the cap is audited once per window as `cell.retention.daily_cap`; operator `cell.evict` is not counted; `null` = no cap |

An invalid value never refuses boot: the daemon logs `config.retention.invalid <key> …` and uses that key's default. An invalid `maxBytes` falls back to 50% of the Cells volume on every node kind, never to "no budget".

Idle instant per Cell: `archived_at` for archived bees; `max(runtime.updated_at, last_output_at, created_at)` for stopped active bees; `retained_at` for retained Cells.

## The pass

1. Gather (main thread, cheap): every non-removed Cell row × its bee × current runtime × in-flight Cell operations; plus Cell bees the v22 backfill could not register (no ledger) as `hold/unregistered`.
2. Settle from registry facts alone every Cell no verdict could act on: a live runtime, an in-flight operation, move or handoff, or idle for less than every age floor (`too_young`, `policy_disabled`), and every Cell whose last inspected hold still stands — found `dirty_uncommitted`, `dirty_stash`, `absent`, `not_provisioned`, or `too_young` with nothing to trim, and none of its facts changed since (Cell state, `parked_at`, WIP confirmation, lifecycle, idle instant, landing receipts, upstream tip, no `cell.exec` in between). Settled Cells carry no `head`, `report` or ignored-path listing. `dirty_unlanded` and `dirty_origin_unknown` are re-inspected every pass because the origin can land their commits without Honeybee seeing it. Judgments live in the daemon's memory: the first pass after a boot inspects every idle Cell once.
3. Inspect (worker thread) the rest: per wrapper, `git status`, `rev-parse HEAD`, origin containment. Bytes are walked (`du -sk` semantics, every file of every Cell) only for a **census**: `cell.gc { measure: true }` (`hive cell gc --measure`), or an automatic pass whose byte budget can bind by `statfs`. A census inspects every present Cell. Never on the RPC lane.
4. Decide with closed vocabularies (`CELL_GC_VERDICTS`, `CELL_GC_REASONS` in `protocol.ts`): `evict | remove_retained | hold | keep`.
5. Apply (only `dryRun: false`): per Cell, re-check state, lifecycle, live runtime, in-flight op, move, handoff **now**, then `evictCellWrapper`: dirty guard again, HEAD must equal the planned HEAD, env files copied and kept paths moved aside, then an atomic `rename` into `<cells-root>/_evicting/`. The bee's path is free the instant the rename lands, so a concurrent revive re-provisions without racing the deletion. Registry: `evictCell` (audit `cell.put` + `cell.evicted{bytes, head, reason}`). If that registry write fails, the park is undone (`unparkCellWrapper`: the wrapper is renamed back, kept paths return, the env copies are dropped) and the outcome is `failed`, never `evicted`; `cell.evict` does the same. Parked wrappers are deleted asynchronously after the pass and at every daemon boot; anything under `_evicting/` is by construction already evicted.
6. Trim (only `dryRun: false`): every Cell with `trim.planned`, as described under Trim; results in `trimOutcomes`.

Shape checks from spec 05 point 6 hold throughout: only a wrapper directly under the cells root containing a `-space-` checkout is ever renamed or deleted.

## Disk pressure (P7)

The daemon checks the volume holding the real Cells root with `statfs` every 60 s. `floor = max(minFreePercent% × size, minFreeBytes)`; `target = floor + band` with `band = min(max(2% × size, 10 GiB), floor / 4)`. Below the floor (and `enabled`, no pass in flight) it runs a **pressure pass**:

1. Candidates: active Cells of archived bees (any age), oldest archive first; then active Cells of active bees whose runtime is stopped and idle at least `pressureIdleAfterDays`, longest idle first. Retained Cells are not candidates.
2. Inspect in batches of 16 in the worker, without a byte walk; a candidate whose last inspected `dirty_uncommitted`, `dirty_unlanded` or `dirty_stash` hold still stands is settled from that judgment (a judgment stands while the registry facts, the Cell's fingerprint of HEAD, index, branch refs and top-level entries, and, for an unlanded hold, the origin's landing-target tips are unchanged). The usual gates decide: live runtime, in-flight op, move or handoff = keep; any dirty cause (including `dirty_unlanded`) or inspect failure = hold. A clean Cell is evicted with reason `disk_pressure` through the same `applyOne` re-checks and audit rows (`cell.put` + `cell.evicted{reason:"disk_pressure"}`). Nothing is ever forced.
3. After every eviction the parked wrapper is swept and `statfs` is read again; the pass continues with the next candidate while the measured free space is still below the target. No `du` estimate is involved (it overstated what a Cell frees: objects hard-linked with the origin by `clone --local`, APFS clones); the measurement ends the pass, and the per-Cell `bytes` of a pressure eviction are null. `maxPerPass` bounds the pass.
4. Outcome `floor_met` when measured free ≥ floor, else `floor_unmet`: logged as `cell.pressure.floor_unmet …` and audited **once per episode** (`cell.pressure.floor_unmet` with held bytes by cause; the episode survives a restart through the last `cell.retention.pass` row); `cellDisk.floorUnmet` stays true until free space is back above the floor. The pass retries every 30 min, sooner if free space drops by another band; a pass that fails outright is recorded as `failed` and backs off the same way. A volume whose `statfs` reports no size is unmeasurable: no floor, no pressure pass. A `minFreeBytes` not below the volume size is ignored with a `config.retention.invalid` log line and `cellDisk.floorWarning`; the percent term alone sets the floor.

Every applied pass (scheduled, pressure, or `hive cell gc --apply` as `manual`) writes one informational audit row `cell.retention.pass {kind, startedAt, endedAt, outcome, evicted, freedBytes, freeBefore, freeAfter, floorBytes, targetBytes, error}`; `freedBytes` is the measured `statfs` delta. Both new audit kinds are informational in replay.

**Upstream mirrors.** With `fetchUpstream`, each origin checkout's `remote.origin.url` is fetched (`+HEAD:refs/upstream/head`, no tags, 60 s bound) into `<data-dir>/upstream/<sha256(url)[:16]>.git` (the `upstream` root is created mode 0700), a bare repository with the origin's objects as alternates and no remotes. A pass refetches a mirror only when it inspects a Cell of that origin: automatic passes at most hourly, `hive cell gc` when the mirror is older than 60 s; a pass that settles every Cell from registry facts fetches nothing, and a census (`--measure`) always inspects. It uses the daemon user's git/ssh configuration plus the origin's `core.sshCommand`, never prompts, never pushes and never writes the origin checkout or a Cell. Its ref is one more landing target for the dirty report (`dirtyReport({ upstream })`): reachability and the existing content checks under *Landed under other SHAs* (patch-id, merge-tree, replay) apply to it exactly as to the local targets; commit messages and branch names are never matched. A Cell whose origin has no upstream URL, or whose mirror never fetched, keeps the local-refs verdict; a failed fetch logs `cell.retention.upstream_failed`, keeps the last good ref and is not retried for `max(refetch age, 5 min)`.

**Status.** `deployInfo` and `health` carry an additive `cellDisk {root, totalBytes, freeBytes, floorBytes, targetBytes, belowFloor, floorUnmet, checkedAt, currentPass, lastPass}`; `lastPass` survives restarts via the newest `cell.retention.pass` row. `hive deploy-info` and `hive health` print one `cells disk:` line. `hive cell gc` streams `currentPass` progress to stderr and, when cut off by SIGINT/SIGTERM or its client timeout, prints the partial plan and exits 130/143/124; the daemon's pass continues.

## Verbs

```
cell.gc     { dryRun?: boolean = true, measure?: boolean }  → CellGcResult
            measure true = census (every present Cell inspected and its bytes walked); false = never walk bytes;
            absent = inspect only Cells a verdict can act on, bytes walked only when the byte budget can bind by statfs
cell.evict  { beeId, force?: boolean, idempotencyKey }             → CellEvictResult
```

`cell.gc` is not a lifecycle command and has no idempotency key; concurrent callers share the in-flight pass. `cell.evict` is idempotent by caller key (`OWN_STATUS_VERBS`: the report is the status). Refused-dirty is a result, never an error; a live runtime, in-flight op, move or handoff is a typed refusal (`runtime_refused`, `move_in_progress`, `handoff_in_progress`). Legacy `cell.remove` accepts an evicted allocation (`absent` + bee delete).

CLI: `hive cell gc [--apply] [--measure|--no-measure] [--json]` (dry run by default; prints planned Cells, the trim plan, held Cells grouped by reason with the dirty ones listed, and the outcomes after `--apply`), `hive cell evict <bee> [--force]`.

## Observability and undo

- Daemon log: `cell.retention.plan … trim_cells= trim_bytes=`, `cell.retention.evicted cell= bee= reason= head= bytes= parked= [kept=]`, `cell.retention.trimmed cell= bee= paths= skipped= bytes= parked=`, `cell.retention.apply … trimmed= trim_bytes=`, `cell.retention.sweep removed=`, `cell.reprovisioned bee= cell= sha=`, `cell.keep.restored`, `cell.keep.reconciled`, `cell.evict bee=`.
- Audit: `cell.put` (row change, mirrored) + `cell.evicted` (history). Apiary's mirror sees the row flip to `evicted` and back.
- Undo: a clean eviction loses nothing that git holds, and kept ignored files come back on revive; the bee revives into the same path at the same commit. What is not recoverable: installs and build output, which are rebuilt. Dirty and forced evictions are explicit operator acts and are logged as `forced=true`.

## Bytes: what `du` means here

Cells are provisioned by APFS clone (`cp -c`) from the origin and warm artifacts (`node_modules`) are reflinked. `du` and the pass's byte walk count allocated blocks per file, so a cloned `node_modules` is counted in full in every Cell although the blocks are shared until a Cell diverges. Reported bytes are therefore an upper bound on freed space; the truthful measure is the volume's free space before and after a pass.

## Apiary changes

- Delete `apps/desktop/src/main/cellRetention.ts` + `cellReaperRuntime.ts` (the pre-cutover reaper of `<workspace>/cells`; it has scanned 0 directories since 2026-08-19 and must never be retargeted at `~/.hive/v2/cells`: Honeybee owns those and Apiary reaping them would race provisioning, capture and exec).
- Refresh `packages/core/src/cellMove.ts`: `CELL_STATES` gains `'evicted'`; `CellRow` gains `evictedAt: number | null` and `evictedHead: string | null` (Honeybee's fixture `v2/daemon/tests/fixtures/apiary-cell-move-shapes.ts` already carries the new shape).
- Refresh `services/apiaryd/src/domains/hive/hiveProtocol.ts`: `CellDirtyReport` gains `stashed: boolean` and `unlandedBranches: string[]` (fixture `apiary-cell-shapes.ts` carries it). Render the new causes in the dirty-refusal UI.
- Refresh `CellDirtyReport` again: it gains `unlandedCommits: Array<{ sha: string; subject: string }>` and `unlandedCommitCount: number`. Show the commits in the dirty-refusal UI.
- Optional surface: show `evicted` on the Cell card ("disk reclaimed; a message re-provisions") and offer `hive cell gc --dry-run` output in a settings pane. Any "free disk" affordance in Apiary calls `cell.gc`/`cell.evict`; it never touches the directory.

## H1 — Park (2026-10-30, capability `cell.park.v1`)

A **park** keeps the Cell where it is and removes its reproducible ignored bytes. Two modes, chosen by `cells.retention.purgeIgnoredOnPark`:

| mode | flag | removes | keeps |
|---|---|---|---|
| `trim` (default) | `false` | the trim patterns (as before) | installs, env files, every other ignored path |
| `purge` | `true` | every ignored path: build output, installs (`node_modules`, `.venv`, `venv`, `Pods`), everything else, and env files after copying them to `cell-env/` | tracked files, untracked files, the index, refs, stashes |

Parking happens on the idle pass (the `trim` step: a Cell idle past `trimAfterHours`, never with a live runtime, in-flight operation, move or handoff) and on demand through `cell.park { beeId, idempotencyKey }` → `CellParkResult { status: parked | nothing_to_park | absent, mode, paths, skipped, bytes, sharedBytes, envFiles }`. The verb plans in the retention worker (git status, verification, byte measurement off the RPC lane), then re-checks state, runtime, in-flight operation, move and handoff on the main thread and renames the planned paths synchronously, so the park/runtime-start race stays impossible without stalling other RPCs. `bytes` are allocated bytes (du semantics); `sharedBytes` are the part held by files with more than one hard link, which a park does not free. A live runtime is `runtime_refused`; a Cell is never parked mid-turn. Dirty work never blocks a park because parking touches only ignored paths, so the dirty report is unchanged by construction. Every path is re-verified against the space as it is now (`verifyParkPaths`): no longer ignored, a symlink, a symlinked parent, a nested repository outside an install directory, or a write inside the idle window (`recently_modified`) skips the path with its reason; install directories pass a shallow check only, since they legitimately hold nested repositories and thousands of entries. Confirmed paths are renamed into `<cells-root>/_evicting/<wrapper>.park.<ts>.<pid>/` (`.trim.` in trim mode) and deleted by the sweep. The bee's private tmp directory is removed with the park. Env files copied aside come back on the next runtime start (`cell.env.restored`), exactly as after an eviction.

Audit: one informational `cell.parked { cellId, beeId, mode, trigger: idle | operator, paths, bytes, envFiles, tmpCleared }` per park that removed something. Log: `cell.retention.parked mode= cell= bee= paths= skipped= bytes= parked=` (pass) and `cell.park mode= cell= bee= status=` (verb). The mode is reported in every `cell.gc` result (`policy.purgeIgnoredOnPark`).

**Purge report.** Every census result (`measure: true`, dry run included) carries `purge: { mode, cells, trimBytes, installBytes, otherIgnoredBytes, otherIgnored: [{ name, cells, paths, bytes }] }` — what parking removes under each class across the inspected Cells, and every ignored path outside the trim and install patterns grouped by its last path component, largest first. `hive cell gc` prints it. Read it before turning `purgeIgnoredOnPark` on: anything listed under `otherIgnored` that is not reproducible belongs in the repository or outside the Cell. Rollback: `purgeIgnoredOnPark: false` restores trim-only parking; nothing already parked comes back (installs and build output are rebuilt, env files are restored, the rest was declared reproducible by the ignore rules).

**Per-bee tmp.** `bees.tmpRoot` now defaults on every node kind: satellites keep `${XDG_CACHE_HOME:-~/.cache}/honeybee/tmp`; workstations and cloud nodes default to `<data-dir>/tmp/<beeId>` with the shared compile cache at `<data-dir>/node-compile-cache` (source `data_dir_default`), beside the Cells on the same volume, counted by the disk budget, removed when the bee is deleted, swept for released bees at boot, and cleared by a park. `bees.tmpRoot: null` turns it off (rollback). The sandbox grants `~/Library/pnpm` so pnpm keeps hard-linking installs from its user store instead of falling back to a per-Cell store.

## H2 — Disk budget and the capacity fact (2026-10-30, capability `node.capacity.v1`)

Every node now has a floor: workstations and cloud nodes default to `minFreePercent: 5`, `minFreeBytes: 20 GiB` (satellites keep 10 % / 50 GiB). `cells.retention.budgetEnforce` decides what the floor does:

| `budgetEnforce` | default | below the floor |
|---|---|---|
| `false` | workstation, cloud | report only: `capacity.resourceBlocked.blocked = true`, one `cell.pressure.below_floor_warn` log line per episode, one `node.capacity` audit row per flip; no pressure pass, no refusal |
| `true` | satellite | the pressure pass runs as before, and `spawn` with `substrate: cell` is refused with the closed error code `resource_blocked` until free space is back above the floor; existing bees, their mail, transcripts and revives are untouched; non-Cell spawns proceed |

The fact itself is additive and nullable on `snapshot`, `watch`, `mirror.local.snapshot`, `deployInfo` and `health`:

```
capacity: {
  schema: 1, checkedAt,
  cells: { root, totalBytes, freeBytes, floorBytes, targetBytes, belowFloor, floorUnmet, cellCount, liveCells, cellBytes },
  resourceBlocked: { blocked, since, reason: "disk_floor" | null },
  admission: { newCells: "accept" | "refuse", enforce }
} | null
```

`cellBytes` is the last census's measured `du` sum (null until a census ran). Each flip of `blocked` or `admission.newCells` writes one informational `node.capacity { capacity }` audit row, so the watch stream carries the change as a delta and Apiary can mirror the fact from the snapshot field plus that delta; the row is informational in replay. `hive health` and `hive deploy-info` print one `capacity:` line. Rollback: `budgetEnforce: false` (warn only); `minFreePercent: null, minFreeBytes: null` removes the floor entirely.

## H3 — WIP push with read-back, parked-first eviction (2026-10-30)

A Cell's WIP is everything `git status` shows: modified and deleted tracked files, untracked files, staged changes. Ignored paths are reproducible and are never WIP; untracked agent leftovers (`leftoverPatterns`) are not WIP either. Two flags under `cells.retention`, both default `false`:

| flag | on |
|---|---|
| `wipPushOnTurnEnd` | every turn end and runtime exit of a Cell bee snapshots the WIP and pushes it to `refs/hive/wip/<cell-id>` in the origin; a revive of an evicted Cell restores the last confirmed WIP into the fresh checkout |
| `evictionRequiresWip` | eviction (automatic, `cell.gc --apply`, pressure) requires a push confirmed at eviction time; `dirty_uncommitted` and `dirty_unlanded` stop holding a Cell, the WIP ref carries the work instead |

**Snapshot.** In the retention worker, never on the event loop: a temporary index seeded from the Cell's `.git/index` (so unchanged files keep their stat cache), `git add -A` with changed files over `wipMaxFileBytes` (default 64 MiB) excluded by pathspec and reported as `skipped`, `write-tree`, and when the tree differs from HEAD's a `commit-tree` with HEAD as parent. The Cell's HEAD, index and working tree are untouched; `git status` runs with `--no-optional-locks`, so a live bee's `index.lock` is never taken. A snapshot with skipped paths is **incomplete**: it is still pushed (a partial WIP is better than none) but never lets an eviction proceed. A snapshot is refused while a merge, rebase, cherry-pick, revert or bisect is in progress (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`): a WIP commit would flatten the operation. Unreadable paths fail the snapshot instead of being skipped silently. Measured on a 5801-file checkout with 90 changed paths: snapshot 177 ms, push 1.6 s, read-back 41 ms (`.proof/h-track/h3/wip-measure.json`).

**Cadence.** Turn-end pushes are debounced per Cell: at most one every `wipMinIntervalSeconds` (default 60), later turn ends coalesce into one trailing push; a snapshot whose tree equals the recorded `wip_tree` (and whose ref still reads back) pushes nothing and writes no row (`cell.wip.unchanged`). The row and its `cell.put` mirror delta are written only when `wip_sha` or the confirmed state changes.

**Push and read-back.** `git fetch` from the Cell into the origin repository, `+<sha>:refs/hive/wip/<cell-id>`, plus every local branch whose tip the origin's landing targets do not contain as `refs/hive/wip-heads/<node>/<cell-id>/<branch>` (a branch the agent committed to and switched away from is work too; `cell.remove` and the daily sweep drop them with the WIP ref, and a revive recreates the ones the fresh checkout lacks). A revive restores the confirmed WIP under either flag; the read-back resolves the ref in the origin, checks the commit is present and walks the WIP commit's objects (`rev-list --objects --missing=error`) so a partial fetch is not confirmed. Only a confirmed read-back counts: the row gets `wip_sha`, `wip_tree`, `wip_pushed_at` and `wip_confirmed_at` (null when the push failed or the ref does not match). A clean Cell's WIP sha is its HEAD.

**The `refs/hive/wip/` namespace.** The origin is the repository the Cell was spawned from, usually the human's working clone. One force-updated ref per Cell lives under `refs/hive/wip/<node-id>/<cell-id>`, where the node id is minted once into the store's `meta.node_id`, bound to the host, installation id and store path, and re-minted when a copied or restored store wakes up elsewhere (the old scope stays on `meta.wip_node_scopes` so its refs are still swept); default refspecs do not push or fetch it, `git log --all`, `for-each-ref` and GC reachability do see it. `cell.remove` and `cell.retained.remove` drop the Cell's ref; eviction keeps it (revive needs it); once a day the retention tick sweeps, in each origin of a known Cell, every `refs/hive/wip/*` whose Cell is not in the registry (removed here, or created by a node whose rows this store never had), logging `cell.wip.refs_swept`.

**Eviction.** Before an eviction is applied the gate pushes again (the Cell is stopped, so the snapshot is the final state) and evicts only when that push is confirmed **and complete**; the eviction then forces past the dirty guard because the WIP is on the origin. An unconfirmed push holds the Cell with reason `wip_unconfirmed`; a confirmed but incomplete one (an oversize changed file) holds it with `wip_incomplete`. Stashes, unknown origins and dirty populated submodules keep their holds (`dirty_stash`, `dirty_origin_unknown`, `dirty_uncommitted`): a stash is not reachable from the WIP commit and `git add -A` records a submodule's gitlink, not its contents. Held Cells are reported on the capacity fact as `capacity.resourceBlocked = { blocked: true, reason: "wip_unconfirmed" }` and `capacity.cells.wipBlockedCells`; **admission never refuses on a WIP hold**, only on the disk floor, so one Cell whose origin moved cannot stop a node from spawning. Nothing is ever deleted on a failed push. Ranking: parked Cells first (`parked_at`, set by `cell.park` and idle trims, cleared when a runtime starts in the Cell), then archived bees, then by idle time, in both the byte-budget pass and the pressure pass.

**Revive.** When an evicted Cell re-provisions at its evicted HEAD and the row has a confirmed WIP whose parent is that HEAD, the provision request carries `restoreWip` and the provisioning step (worker thread, or the warm-pool claim) reads the WIP tree into the clean checkout as plain working-tree state (`read-tree -m -u` then `reset`) before the runtime starts: HEAD stays, the files come back modified or untracked. A dirty checkout, a moved HEAD or an unreachable commit skips the restore and logs `cell.wip.restore_skipped`.

Schema v53 adds five nullable columns to `cells` (`parked_at`, `wip_sha`, `wip_tree`, `wip_pushed_at`, `wip_confirmed_at`), mirrored through `cell.put` deltas and `MIRROR_CELL_KEYS`. Measured on a copy of the live 1.15 GB store with 3554 Cells: the five `ADD COLUMN`s take 41 ms; the open path's pre-migration backup copy is the rest of an 11 s open (`.proof/h-track/h3/migration-v53.json`). Rollback: both flags off restore today's behaviour (dirty Cells hold, no refs are written, the columns stay null); a v53 store does not open under a pre-v53 release, `hive deploy --rollback` restores the backup.

## H4 — Work bundles: the work leaves with the bee, the checkout does not (2026-11-11, capability `cell.work.v1`)

Why: a few KB of uncommitted or unlanded work held gigabytes of checkout forever (metal-1, 2026-11-10: 220 of 391 Cells belonged to sessions idle for weeks, `hive cell gc` reclaimed nothing, `cell-keep` was never emptied). The mechanism separates the work from the checkout: at eviction the work is saved as one local git bundle beside the registry, the checkout is removed, and the next runtime start puts the work back. No built-in file names, nothing pushed to the user's remote, nothing written into the user's checkout or its config; git in that repository is the only authority on what is work.

**What is work.** In a Cell: every local commit no origin ref reaches (`refs/heads/*` and HEAD, `--not` every origin ref as it stands at eviction, peeled), tracked files modified, deleted or staged, and untracked files the repository's own ignore rules (`.gitignore`, `.git/info/exclude`, `core.excludesFile` in the repository's config) do not ignore. Ignored files are not work: the repository said so. Declared `leftoverPatterns` are not work either. A commit the origin holds under another sha (squash, rebase) is still bundled: the restore brings the Cell back at the same sha, and the bundle costs a few KB.

**The bundle.** `bundleWork` (`driver-cell/src/work.ts`, run in the retention worker, never on the RPC lane) builds one commit holding the working tree through a temporary index seeded from the Cell's index (`git add -A` in the Cell, so its ignore rules and local config apply, with `GIT_OBJECT_DIRECTORY` pointed at a shadow bare repository whose alternates are the Cell's objects: the Cell's worktree, index, HEAD, refs, reflog and object store are untouched), and a second commit holding the staged tree when it differs from both. The shadow repository gets `refs/heads/<branch>` for every local branch, `refs/hive/head`, `refs/hive/work` and `refs/hive/index`, and `git bundle create --stdin` writes everything those refs reach that the origin's refs do not. Then: `git bundle verify`; a throwaway bare repository with the **origin's** objects as alternates fetches the bundle (`+refs/*:refs/*`, so git's connectivity check and `index-pack` run on the pack: `bundle verify` alone reads the header and passes a truncated pack), every ref must resolve to the recorded sha, the work and index commits to the recorded trees, and `rev-list --objects --missing=error --all --not <prerequisites>` must pass; the file is `fsync`ed and renamed into place, the Cell is read again (working tree, HEAD, branches) and any change discards the bundle (`changed_during_capture`); only then is the record written (`fsync`, atomic rename, directory `fsync`). The record is the proof the bundle is complete: readers require both files. Measured on a 6130-file checkout of this repository, APFS: 5 changed files + 1 commit → 1.9 KB bundle, capture 1.6 s, restore 1.3 s; 90 files + 3 commits + 1 MiB untracked → 36 KB, 1.1 s, 1.7 s; 600 files + 64 MiB untracked → 446 KB, 2.5 s, 2.1 s (`work.ts` timings are process spawns, around 25 git invocations per capture).

Layout: `<data-dir>/cell-work/<cellId>.bundle` + `<cellId>.json` (beside `cells/`, `cell-keep/`, `cell-env/`; `~/.hive/v2/cell-work/` in production), scratch under `cell-work/tmp/` removed in `finally`. The record (`WorkBundleRecord`): `{ version: 1, cellId, createdAt, head: { sha, branch | null }, branches: [{ name, sha }], work: { sha, tree } | null, index: { sha | null, tree }, prerequisites, excluded, infoExclude, commits, paths, capturedBytes, bundleBytes, elapsedMs }`.

**Eviction order.** The pass plans with `work` measured at inspection (`CellGcItem.work`: commits, paths, modified, untracked, `capturedBytes` as apparent size of the changed paths, the five `largest`, `refusal`, `bundled`). Apply, per Cell: the worker bundles and verifies (`cell.work.bundled … bundle_bytes=`); the main thread re-checks state, lifecycle, runtime, in-flight op, move, handoff and that `cellFingerprint` is unchanged since the capture (`changed_since_bundle` refuses and drops the bundle); the row records the bundle (`work_bundle_at`, `work_bundle_sha`, `work_bundle_bytes`, a `cell.put` delta) **before** the park, so a crash between the park and the `evicted` flip still leaves a row that names its bundle; then the park (`evictCellWrapper`, forced past the dirty guard because the work is on disk) and `evictCell` (`cell.evicted{…, workBundle: { sha, bytes, commits, paths }}`). A failed registry write unparks and drops the bundle; a failed capture holds the Cell as `work_bundle_failed` and removes nothing. Crash points: before the park, the Cell is intact and the next pass captures again (the bundle is replaced atomically); after the park and before the flip, the row still says `active` with a bundle and no checkout, and the next runtime start restores from it; the wrapper under `_evicting/` is swept at boot as before.

**Restore.** `resolveCellSpec` adds `restoreWork { workRoot, cellId }` to the provision request whenever the row has `workBundleAt` and the Cell is `evicted` or its space is absent. After the checkout (`restoreWorkAfterProvision`, worker thread, pool claim or in-process alike, replayed provisionings included): the checkout must be clean and at the provisioned sha (`space_dirty`, `head_mismatch` skip it, nothing is written), `git bundle verify` in the space (the prerequisites must exist there), `fetch` into `refs/hive/restore/*`, every recorded commit and tree present, then branches by `update-ref --stdin`, HEAD as symbolic ref or detached, `reset --hard HEAD`, `read-tree -m -u <work tree>` (the working tree), `read-tree <index tree>` (the staged state), `update-index --refresh`, `info/exclude` written back, the restore refs dropped. The result is verified by tree hash (`verifyRestoredWork`: HEAD, branches, a fresh temporary-index `write-tree` of the working tree and of the index). Only a verified restore drops the bundle and clears the row (`cell.work.restored`, `cell.work.dropped why=restored`); anything else keeps both and logs `cell.work.kept … bundle=<path>` for the operator. `git status` and `git diff` then read as they did, staged and unstaged alike; deleted tracked files stay deleted; file modes and symlinks come back through git.

**Not restorable exactly, and what happens:** timestamps (not restored; the stat cache is rebuilt); a stash (`dirty_stash` still holds the Cell); a populated submodule with local state (`dirty_uncommitted` still holds it: `git add -A` records a gitlink, not the contents); a merge, rebase, cherry-pick, revert or bisect in progress, unmerged index entries, a sparse checkout, a partial clone, a shallow clone (`work_unbundleable` holds the Cell with the reason: the operation state or the missing objects cannot be rebuilt in a fresh checkout); an origin that cannot be read (`dirty_origin_unknown`). Intent-to-add entries become ordinary untracked files. LFS-tracked files are captured as the bytes in the working tree (filters are disabled in the driver's git environment) and come back as those bytes.

**Size cap.** `cells.retention.workBundleMaxBytes` (default 1 GiB) bounds `capturedBytes`, measured by `lstat` before anything is written. Over it the Cell is held `work_over_cap`; the plan and the row name the reason and the largest paths with sizes (`cells.hold_reason`, `cells.hold_detail { capturedBytes, maxBytes, largest, message, at }`, mirrored by `cell.put`), so the user can decide. The hold is settled and fingerprinted like `dirty_uncommitted`.

**When.** A Cell is evicted once its bee has been idle `cells.retention.idleDays` (default 7, archived or not: `archivedAfterDays` and `stoppedAfterDays` now both default to it and remain per-class overrides; satellites keep 3 days for archived bees), never while it runs or has an in-flight Cell operation, move or handoff; under disk pressure oldest-idle first as before. Dirty no longer holds a checkout: `dirty_uncommitted` and `dirty_unlanded` apply only when `workBundle` is off or the work is not bundleable.

**Kept ignored files.** Unchanged on the way out (`cell-keep/`, restored on revive). The retention pass now deletes a keep once its eviction is older than `cells.retention.keepDays` (default 14; `null` keeps forever) when its Cell is not active with a present checkout (`cell.keep.removed space= bytes=`), and an unrestored work bundle once older than `cells.retention.workBundleKeepDays` (default 365; `null` keeps forever) or as soon as its Cell is removed or its bee deleted (`cell.work.dropped why=window_elapsed|orphaned`); the row's bundle reference is cleared with it. Cost: one `readdir` of `cell-keep/` and one of `cell-work/` per pass plus a `stat` per manifest; deletions run off the event loop; nothing new runs between passes. The result carries `stale { keeps: [{ spaceName, cellId, beeId, ageMs, status, reason }], bundles: [{ cellId, beeId, ageMs, bytes, status, reason }] }`, `planned` on a dry run.

**Verbs and settings.**

```
cell.keep.remove { beeId?: string; all?: boolean }  → CellKeepRemoveResult { removed: [{ spaceName, cellId, beeId, bytes }], skipped: [{ spaceName, reason }] }
                 one evicted bee's kept files, or (all) every keep whose Cell is not active; a kept set of an active Cell with its checkout present is skipped `cell_active`
```

CLI: `hive cell keep-remove <bee>` / `hive cell keep-remove --all`; `hive cell gc` prints a `work:` policy line, `work: bundle N commits, M paths X` per planned Cell, `held work_over_cap` / `work_unbundleable` / `work_bundle_failed` groups with the reason and the largest paths, `bundle N KiB` per evicted Cell, and the stale sweep; a dry run writes no bundle and deletes nothing.

| key | default | meaning |
|---|---|---|
| `idleDays` | `7` | evict a Cell once its bee has been idle this long, archived or not; `archivedAfterDays` / `stoppedAfterDays` override per class |
| `workBundle` | `true` | bundle the work at eviction and restore it on revive; `false` = dirty Cells hold as before (rollback) |
| `workBundleMaxBytes` | `1073741824` | hold a Cell whose changed paths exceed this (`work_over_cap`) |
| `workBundleKeepDays` | `365` | delete an unrestored bundle this long after its eviction; `null` = never |
| `keepDays` | `14` | delete kept ignored files this long after the eviction; `null` = never |

Row fields (schema **v61**, `MIRROR_CELL_KEYS`, every client that reads `CellRow`): `workBundleAt`, `workBundleSha`, `workBundleBytes`, `holdReason`, `holdDetail`. `CellGcReason` gains `work_over_cap`, `work_unbundleable`, `work_bundle_failed`. `cell.evict` (the operator verb) keeps the A2 guard and `--force` semantics; only the pass bundles.

## Not Honeybee's

Checked on the Studio on 2026-09-24: `$TMPDIR/comb-*-review`, `pher-*-review`, `hive-deploy.*`, `apiary-control`, `~/.hive/crew/art` are created by other tools (v1 comb, Pollinate, Apiary/crew); Honeybee v2 removes its own temp scratch (`hive-capture-*`, `hive-naming-*`, `honeybee-deploy-pack-*`) in `finally`. `~/.hive/hsr/` (4,485 runner homes, 65 GB, newest 2026-08-16) is the *v1* runner tree, dead since the cutover; v2 runners live under `~/.hive/v2/runners`. It is safe to trash once no v1 daemon runs; Honeybee v2 never reads it.
