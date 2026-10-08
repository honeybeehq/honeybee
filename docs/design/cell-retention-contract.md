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

A Cell is **clean** when the A2 dirty report is empty: no uncommitted working-tree change (`git status --porcelain`), no stash (`git stash list`), HEAD *and every local branch tip* landed in the origin (no unlanded commits — a branch the agent committed to and then switched away from counts, and the report names it in `unlandedBranches`), and the origin repository still exists. Ignored files do not make a Cell dirty. Only clean Cells are ever reclaimed automatically. Dirty Cells are listed as `hold` with the cause (`dirty_uncommitted`, `dirty_unlanded`, `dirty_stash`, `dirty_origin_unknown`); the operator decides with `hive cell evict <bee> --force` or `hive cell remove <bee> --force`.

**Landed under other SHAs.** Landing queues rebase, cherry-pick and squash, so a Cell's work usually reaches main as different commits. A tip the origin does not contain is still landed when every commit on it since the provisioned sha is landed against a landing target — the origin's `main`/`master`, `origin/HEAD`, `origin/main`/`origin/master`, and the target branch of each landing receipt (`driver-cell/src/landed.ts`). A commit is landed when any of these holds:

1. it is reachable from a target, or from the source head of a succeeded `land` action (Honeybee `cell.capture` or Apiary's landing queue) whose result commit a target contains;
2. merging the tip into the target is clean and yields the target's own tree (squash, rebase);
3. a target has a commit with the same stable patch-id (cherry-picks that main later edited);
4. replaying the commit onto the target is clean and changes nothing (a rebase whose conflict was resolved to the Cell's version).

Every check fails closed: a conflict, a git error, a git without `merge-tree --write-tree` (< 2.38) or `--merge-base` (< 2.40), more than 500 commits on a tip, or more than 64 replay probes per Cell leaves commits unlanded. A conflict resolved by combining both sides is not recognised and keeps the Cell. The probes run in the Cell with the Cell's and the origin's object stores as alternates and a throwaway primary object directory, so neither repository is written. The report names the blocking commits in `unlandedCommits` (newest first, at most 20) with `unlandedCommitCount`, and the refusal message lists them. Uncommitted changes, untracked files and stashes are unaffected: they always block.

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
| `enabled` | `true` | automatic pass on/off (`hive cell gc` works either way) |
| `archivedAfterDays` | `7` | evict a clean Cell whose bee has been archived at least this long |
| `stoppedAfterDays` | `30` | evict a clean Cell whose *active* bee has had no runtime and no output for this long; `null` = never by age |
| `retainedAfterDays` | `14` | remove a clean `retained` Cell this long after the move; `null` = never |
| `maxBytes` | `null` | when total Cell bytes (du semantics) exceed this, also evict clean *young* Cells, archived first then stopped, oldest idle first, until under budget; never a live runtime, never dirty |
| `intervalHours` | `24` | cadence of the automatic pass (first pass 5 min after boot) |
| `maxPerPass` | `100` | evictions per pass; the rest are reported `hold/pass_limit` |
| `trimAfterHours` | `24` | trim build output of Cells idle at least this long; `null` = never |
| `trimPatterns` | see Trim | directory names, or `*.ext` file suffixes, that count as build output |

Idle instant per Cell: `archived_at` for archived bees; `max(runtime.updated_at, last_output_at, created_at)` for stopped active bees; `retained_at` for retained Cells.

## The pass

1. Gather (main thread, cheap): every non-removed Cell row × its bee × current runtime × in-flight Cell operations; plus Cell bees the v22 backfill could not register (no ledger) as `hold/unregistered`.
2. Inspect (worker thread): per wrapper, `git status`, `rev-parse HEAD`, origin containment, and a `du -sk`-style byte walk. Seconds to minutes on a large root; never on the RPC lane.
3. Decide with closed vocabularies (`CELL_GC_VERDICTS`, `CELL_GC_REASONS` in `protocol.ts`): `evict | remove_retained | hold | keep`.
4. Apply (only `dryRun: false`): per Cell, re-check state, lifecycle, live runtime, in-flight op, move, handoff **now**, then `evictCellWrapper`: dirty guard again, HEAD must equal the planned HEAD, env files copied and kept paths moved aside, then an atomic `rename` into `<cells-root>/_evicting/`. The bee's path is free the instant the rename lands, so a concurrent revive re-provisions without racing the deletion. Registry: `evictCell` (audit `cell.put` + `cell.evicted{bytes, head, reason}`). Parked wrappers are deleted asynchronously after the pass and at every daemon boot; anything under `_evicting/` is by construction already evicted.
5. Trim (only `dryRun: false`): every Cell with `trim.planned`, as described under Trim; results in `trimOutcomes`.

Shape checks from spec 05 point 6 hold throughout: only a wrapper directly under the cells root containing a `-space-` checkout is ever renamed or deleted.

## Verbs

```
cell.gc     { dryRun?: boolean = true, measure?: boolean = true }  → CellGcResult
cell.evict  { beeId, force?: boolean, idempotencyKey }             → CellEvictResult
```

`cell.gc` is not a lifecycle command and has no idempotency key; concurrent callers share the in-flight pass. `cell.evict` is idempotent by caller key (`OWN_STATUS_VERBS`: the report is the status). Refused-dirty is a result, never an error; a live runtime, in-flight op, move or handoff is a typed refusal (`runtime_refused`, `move_in_progress`, `handoff_in_progress`). Legacy `cell.remove` accepts an evicted allocation (`absent` + bee delete).

CLI: `hive cell gc [--apply] [--no-measure] [--json]` (dry run by default; prints planned Cells, the trim plan, held Cells grouped by reason with the dirty ones listed, and the outcomes after `--apply`), `hive cell evict <bee> [--force]`.

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

## Not Honeybee's

Checked on the Studio on 2026-09-24: `$TMPDIR/comb-*-review`, `pher-*-review`, `hive-deploy.*`, `apiary-control`, `~/.hive/crew/art` are created by other tools (v1 comb, Pollinate, Apiary/crew); Honeybee v2 removes its own temp scratch (`hive-capture-*`, `hive-naming-*`, `honeybee-deploy-pack-*`) in `finally`. `~/.hive/hsr/` (4,485 runner homes, 65 GB, newest 2026-08-16) is the *v1* runner tree, dead since the cutover; v2 runners live under `~/.hive/v2/runners`. It is safe to trash once no v1 daemon runs; Honeybee v2 never reads it.
