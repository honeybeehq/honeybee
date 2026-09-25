# Cell disk retention — Honeybee contract (v31)

Locked for Apiary. Schema **v31**. Protocol stays `v2/1`; capability `cell.retention.v1` is additive.

Base: the v22 `cells` registry + the A2 dirty guard (`driver-cell/remove.ts`) + generation-fenced revive.
Graft: a fourth Cell state, `evicted`, and a bounded daily pass in the daemon.
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

A Cell is **clean** when the A2 dirty report is empty: no uncommitted working-tree change (`git status --porcelain`), no stash (`git stash list`), HEAD *and every local branch tip* contained in the origin (no unlanded commits — a branch the agent committed to and then switched away from counts, and the report names it in `unlandedBranches`), and the origin repository still exists. Ignored files (`node_modules`, `.tmp`, build output) do not make a Cell dirty; they are exactly what retention reclaims. Only clean Cells are ever reclaimed automatically. Dirty Cells are listed as `hold` with the cause (`dirty_uncommitted`, `dirty_unlanded`, `dirty_stash`, `dirty_origin_unknown`); the operator decides with `hive cell evict <bee> --force` or `hive cell remove <bee> --force`.

**Ignored env files are preserved.** Git-ignored `.env` and `.env.*` files at any depth (outside fully-ignored directories such as `node_modules`) are often per-Cell and unique. Before the park, eviction copies them, mode `0600`, to `<data-dir>/cell-env/<spaceName>/<space-relative path>` (beside `cells/`; `~/.hive/v2/cell-env/…` in production), lists them in the `cell.evicted` audit payload, the `cell.retention.evicted … env_files=N env_stash=…` log line and the `cell.gc` / `cell.evict` results (`envFiles`). When the Cell is re-provisioned on revive, the daemon restores them into the same relative paths (never overwriting a file that already exists), logs `cell.env.restored`, and drops the copy. A Cell that is never revived keeps its copy under `cell-env/` until the operator removes it.

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

Idle instant per Cell: `archived_at` for archived bees; `max(runtime.updated_at, last_output_at, created_at)` for stopped active bees; `retained_at` for retained Cells.

## The pass

1. Gather (main thread, cheap): every non-removed Cell row × its bee × current runtime × in-flight Cell operations; plus Cell bees the v22 backfill could not register (no ledger) as `hold/unregistered`.
2. Inspect (worker thread): per wrapper, `git status`, `rev-parse HEAD`, origin containment, and a `du -sk`-style byte walk. Seconds to minutes on a large root; never on the RPC lane.
3. Decide with closed vocabularies (`CELL_GC_VERDICTS`, `CELL_GC_REASONS` in `protocol.ts`): `evict | remove_retained | hold | keep`.
4. Apply (only `dryRun: false`): per Cell, re-check state, lifecycle, live runtime, in-flight op, move, handoff **now**, then `evictCellWrapper`: dirty guard again, HEAD must equal the planned HEAD, then an atomic `rename` into `<cells-root>/_evicting/`. The bee's path is free the instant the rename lands, so a concurrent revive re-provisions without racing the deletion. Registry: `evictCell` (audit `cell.put` + `cell.evicted{bytes, head, reason}`). Parked wrappers are deleted asynchronously after the pass and at every daemon boot; anything under `_evicting/` is by construction already evicted.

Shape checks from spec 05 point 6 hold throughout: only a wrapper directly under the cells root containing a `-space-` checkout is ever renamed or deleted.

## Verbs

```
cell.gc     { dryRun?: boolean = true, measure?: boolean = true }  → CellGcResult
cell.evict  { beeId, force?: boolean, idempotencyKey }             → CellEvictResult
```

`cell.gc` is not a lifecycle command and has no idempotency key; concurrent callers share the in-flight pass. `cell.evict` is idempotent by caller key (`OWN_STATUS_VERBS`: the report is the status). Refused-dirty is a result, never an error; a live runtime, in-flight op, move or handoff is a typed refusal (`runtime_refused`, `move_in_progress`, `handoff_in_progress`). Legacy `cell.remove` accepts an evicted allocation (`absent` + bee delete).

CLI: `hive cell gc [--apply] [--no-measure] [--json]` (dry run by default; prints planned Cells, held Cells grouped by reason with the dirty ones listed, and the outcome after `--apply`), `hive cell evict <bee> [--force]`.

## Observability and undo

- Daemon log: `cell.retention.plan …`, `cell.retention.evicted cell= bee= reason= head= bytes= parked=`, `cell.retention.sweep removed=`, `cell.reprovisioned bee= cell= sha=`, `cell.evict bee=`.
- Audit: `cell.put` (row change, mirrored) + `cell.evicted` (history). Apiary's mirror sees the row flip to `evicted` and back.
- Undo: a clean eviction loses nothing that git holds; the bee revives into the same path at the same commit. What is not recoverable: ignored files (caches, `.tmp`, local `.env`), which is why dirty and forced evictions are explicit operator acts and are logged as `forced=true`.

## Bytes: what `du` means here

Cells are provisioned by APFS clone (`cp -c`) from the origin and warm artifacts (`node_modules`) are reflinked. `du` and the pass's byte walk count allocated blocks per file, so a cloned `node_modules` is counted in full in every Cell although the blocks are shared until a Cell diverges. Reported bytes are therefore an upper bound on freed space; the truthful measure is the volume's free space before and after a pass.

## Apiary changes

- Delete `apps/desktop/src/main/cellRetention.ts` + `cellReaperRuntime.ts` (the pre-cutover reaper of `<workspace>/cells`; it has scanned 0 directories since 2026-08-19 and must never be retargeted at `~/.hive/v2/cells`: Honeybee owns those and Apiary reaping them would race provisioning, capture and exec).
- Refresh `packages/core/src/cellMove.ts`: `CELL_STATES` gains `'evicted'`; `CellRow` gains `evictedAt: number | null` and `evictedHead: string | null` (Honeybee's fixture `v2/daemon/tests/fixtures/apiary-cell-move-shapes.ts` already carries the new shape).
- Refresh `services/apiaryd/src/domains/hive/hiveProtocol.ts`: `CellDirtyReport` gains `stashed: boolean` and `unlandedBranches: string[]` (fixture `apiary-cell-shapes.ts` carries it). Render the new causes in the dirty-refusal UI.
- Optional surface: show `evicted` on the Cell card ("disk reclaimed; a message re-provisions") and offer `hive cell gc --dry-run` output in a settings pane. Any "free disk" affordance in Apiary calls `cell.gc`/`cell.evict`; it never touches the directory.

## Not Honeybee's

Checked on the Studio on 2026-09-24: `$TMPDIR/comb-*-review`, `pher-*-review`, `hive-deploy.*`, `apiary-control`, `~/.hive/crew/art` are created by other tools (v1 comb, Pollinate, Apiary/crew); Honeybee v2 removes its own temp scratch (`hive-capture-*`, `hive-naming-*`, `honeybee-deploy-pack-*`) in `finally`. `~/.hive/hsr/` (4,485 runner homes, 65 GB, newest 2026-08-16) is the *v1* runner tree, dead since the cutover; v2 runners live under `~/.hive/v2/runners`. It is safe to trash once no v1 daemon runs; Honeybee v2 never reads it.
