# Cell → regular checkout move — Honeybee wire contract

Locked for Apiary. Schema **v22**. Protocol stays `v2/1`; capabilities are additive.

Base: Sol `bee_moves` + `cells` registry, generation-fenced `stop`/`revive`.
Graft: Claude cwd-keyed transcript carry **after exact source exit**, before revive.
Reject: new mailbox lane / `delivering_context` / path-keyed cells / pre-stop copy / auto git apply.

Same-node v1 only. Dirty checkouts are preserved. Destination is an existing regular checkout of the same origin (git common-dir + object format + `observedHead`).

---

## Capabilities (hello / `deployInfo`)

```
"cell.move.local.v1"
"cell.retained.exec.v1"
```

No remote capability. Remote is `remote_move_unsupported` **before** fence or stop.

Continuation v1: `claude` and `codex` only. `stub` is an explicit **test-only** capability (`cells.allowStubMove`). Other agents: `continuation_unsupported` before fence.

Operator `stop` / `archive` / `delete` / `revive` during an in-flight move **supersedes** it (`failed` + `superseded`): the move's revive is mooted, `active_move_id` clears, mailbox unfences. Pre-placement failure does the same so the source Cell remains recoverable. Completed moves keep their receipt row.

---

## Error codes (additive to `RPC_ERROR_CODES`)

| code | when |
|---|---|
| `remote_move_unsupported` | `destination.kind` ≠ `local_checkout` or `node` ≠ local |
| `stale_placement` | `expected.placementVersion` or `expected.cellId` mismatch |
| `repo_mismatch` | dest common-dir / object-format / `observedHead` mismatch |
| `move_in_progress` | bee already has an incomplete move (different request) |
| `idempotency_conflict` | same `idempotencyKey`, different canonical request hash |
| `continuation_unsupported` | harness cannot resume the same conversation in a new cwd |
| `cell_not_found` | registry id unknown or `removed` |

Reuse: `bee_not_found`, `invalid_request`, `runtime_refused`, `transcript_unavailable`.

---

## RPC verbs

```
bee.move
bee.move.get
cell.exec
cell.retained.remove
```

`cell.capture` / `cell.remove` stay. Capture resolves through the **cells registry** (not `bee.substrate === "cell"` / `dirname(cwd)`). Legacy `cell.remove` (beeId) still deletes an **active** Cell bee. Retained allocations use `cell.retained.remove` and never delete the continued bee.

Caller `idempotencyKey` is **required** on `bee.move`, `cell.exec`, `cell.retained.remove`.

### `bee.move`

```ts
type LocalRepoIdentity = {
  version: 1
  gitCommonDirRealpath: string
  objectFormat: "sha1" | "sha256"
}

type BeeMoveParams = {
  beeId: string
  idempotencyKey: string
  expected: { placementVersion: number; cellId: string }
  destination: {
    kind: "local_checkout"
    cwd: string                 // absolute existing directory
    repository: LocalRepoIdentity
    observedHead: string        // dest HEAD at picker time
  }
}

type BeeMovePhase = "stopping" | "placing" | "starting" | "complete" | "failed"

type BeeMoveView = {
  id: string
  beeId: string
  phase: BeeMovePhase
  sourceGeneration: number
  from: BeePlacement
  to: BeePlacement
  retainedCellId: string
  failure: { stage: "validate" | "stop" | "start" | "context"; code: string; detail: string } | null
}

// Store/dump/audit only. Never on the wire view. Apiary materializes BeeMoveView.
type BeeMoveRow = BeeMoveView & {
  idempotencyKey: string
  requestHash: string
  stopCommandKey: string
  reviveCommandKey: string
  instructionsPending: boolean
  instructionsApplied: boolean
  createdAt: number
  observedHead: string
}

type BeePlacement = {
  version: number               // bees.placement_version at that snapshot
  mode: "cell" | "checkout"
  substrate: "cell" | "hsr"
  cwd: string
}

type BeeMoveResult = BeeMoveView & { deduped?: boolean }
```

`bee.move.get { moveId }` → `BeeMoveView`. `bee_not_found` is wrong here; unknown id → `invalid_request`.

Canonical request hash (idempotency): stable JSON of `{ beeId, expected, destination }` (not the key). Same key + same hash → original view. Same key + different hash → `idempotency_conflict`.

### `cell.exec`

```ts
type CellExecParams = {
  cellId: string
  idempotencyKey: string
  argv: string[]                // non-empty, no shell
  cwd?: string                  // repo-relative, containment-checked vs spaceDir
  timeoutMs?: number            // default 60_000, max 300_000
}

type CellOpStatus = "queued" | "running" | "done" | "failed" | "outcome_unknown"

type CellExecResult = {
  id: string
  cellId: string
  status: CellOpStatus
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean            // combined output cap 1 MiB
  timeoutMs: number
  reason: "no_cell" | "cell_runtime_live" | "busy" | "argv_invalid" | "containment" | null
  deduped?: boolean
}
```

Not a B5 lifecycle command. Durable `cell_ops` row. Daemon death: reattach by exact pid/birth or `outcome_unknown` — **never replay argv**. No concurrent capture/remove/exec on the same cell.

### `cell.retained.remove`

```ts
type CellRetainedRemoveParams = {
  cellId: string
  idempotencyKey: string
  force?: boolean
}

type CellRetainedRemoveResult = {
  cell: CellRow
  status: "deleted" | "refused" | "absent"
  forced: boolean
  report: CellDirtyReport | null
  deduped?: boolean
}
```

Clears `bees.cell_id` if it pointed at this cell. **Does not** enqueue bee `delete`.

---

## Durable model (schema v22)

`bees` additive:

- `placement_version INTEGER NOT NULL DEFAULT 0`
- `active_move_id TEXT`
- `cell_id TEXT`

No standing `repo_identity` column on bees. Identity lives on `cells`.

```sql
CREATE TABLE cells (
  id                    TEXT PRIMARY KEY,
  source_bee_id         TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN ('active','retained','removing','removed')),
  git_common_dir        TEXT NOT NULL,
  object_format         TEXT NOT NULL CHECK (object_format IN ('sha1','sha256')),
  origin_repo           TEXT NOT NULL,
  sha                   TEXT NOT NULL,
  wrapper               TEXT NOT NULL,
  space_name            TEXT NOT NULL,
  space_dir             TEXT NOT NULL,
  sandbox               INTEGER,
  created_at            INTEGER NOT NULL,
  retained_at           INTEGER,
  removed_at            INTEGER
) STRICT;

CREATE TABLE bee_moves (
  id                    TEXT PRIMARY KEY,
  bee_id                TEXT NOT NULL,
  idempotency_key       TEXT NOT NULL UNIQUE,
  request_hash          TEXT NOT NULL,
  phase                 TEXT NOT NULL CHECK (phase IN ('stopping','placing','starting','complete','failed')),
  source_generation     INTEGER NOT NULL,
  from_cwd              TEXT NOT NULL,
  from_substrate        TEXT NOT NULL,
  to_cwd                TEXT NOT NULL,
  to_substrate          TEXT NOT NULL DEFAULT 'hsr',
  retained_cell_id      TEXT NOT NULL,
  stop_command_key      TEXT NOT NULL,
  revive_command_key    TEXT NOT NULL,
  placement_version     INTEGER NOT NULL, -- version this move commits
  instructions_pending  INTEGER NOT NULL DEFAULT 1,
  failure_json          TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX bees_one_active_move
  ON bees(active_move_id) WHERE active_move_id IS NOT NULL;

CREATE TABLE cell_ops (
  id                    TEXT PRIMARY KEY,
  cell_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('exec','remove')),
  idempotency_key       TEXT NOT NULL UNIQUE,
  request_hash          TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','outcome_unknown')),
  argv_json             TEXT,
  cwd                   TEXT,
  timeout_ms            INTEGER,
  pid                   INTEGER,
  pid_started_at        INTEGER,
  exit_code             INTEGER,
  stdout                TEXT,
  stderr                TEXT,
  truncated             INTEGER NOT NULL DEFAULT 0,
  failure               TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) STRICT;
```

Command keys (existing `commands.idempotency_key`, generation-fenced verbs):

- stop: `move:<id>:stop:g<generation>`
- revive: `move:<id>:revive`

---

## BeeRow + mirror

BeeRow additive: `placementVersion`, `activeMoveId`, `cellId`.

`MirrorBeeRow` additive nested views (derived, like account `credentialHealth`):

- `move: BeeMoveView | null`  (latest receipt including complete/failed; null only if the bee has never moved)
- `cell: CellRow | null`

`MirrorSnapshot` / `snapshot` RPC additive tables:

- `cells: CellRow[]`
- `beeMoves: BeeMoveView[]`  (v1 lists all receipts, including terminal; operational hashes/keys are not projected)

```ts
type CellRow = {
  id: string
  sourceBeeId: string
  state: "active" | "retained" | "removing" | "removed"
  repository: LocalRepoIdentity
  originRepo: string
  sha: string
  wrapper: string
  spaceName: string
  spaceDir: string          // node-local; Apiary must not treat as cross-node identity
  sandbox: boolean | null
  createdAt: number
  retainedAt: number | null
  removedAt: number | null
}
```

`ViewResult` / `BeeViewRow` also carry `move` and `cell` (additive).

Audit kinds (replayable):

- `cell.put` `{ cell }`
- `cell.removed` `{ cellId, removedAt }`
- `bee.move_admitted` `{ move }`
- `bee.move_phase` `{ moveId, beeId, phase, previous, move }`
- `bee.placement` `{ beeId, placementVersion, cwd, previousCwd, substrate, previousSubstrate, cellId }`
- `bee.move_failed` `{ moveId, beeId, failure, move }`
- `bee.move_instructions` `{ moveId, beeId, move }` — store/dump/replay; public BeeMoveView is unchanged (instruction flags are not on the locked view)
- `cell_op.put` `{ op }`  — informational for exec; dumpState includes `cellOps`

Deltas are these audit rows. Materializers that ignore unknown keys stay valid; consumers of move/cell **must** read the new keys/tables.

---

## State machine

1. **Admit** (one core tx): CAS `expected.placementVersion` + `cellId`; require `cells.state=active`, `bees.substrate=cell`, no `active_move_id`; insert `bee_moves.phase=stopping`; set `active_move_id`; enqueue `stop { cause: stopped_by_system, reason: bee.move }` with key `move:<id>:stop:gN`. No `thenRevive`. Already-stopped bees still admit and fence.
2. **Fence** while `active_move_id` set and phase ∈ {stopping, placing}:
   - `send` inserts (FIFO preserved).
   - `enqueueWake` / `enqueueBootRetry` outcome `fenced`.
   - `claimNextCommand` skips this bee's `spawn|send_wake`; skips unrelated `revive` except the move's own revive once phase is `starting`.
   - delivery skips user mail until destination accept + placement instruction applied.
   - Phase `starting`: dest boot retries (`send_wake` / `enqueueBootRetry`) are allowed so a hang-policy stop below `spawn_failed` cannot wedge the fence. User-mail delivery still waits for the placement instruction.
   - Fail/supersede clears `active_move_id` and re-arms a wake in the same transaction when undelivered mail exists.
3. After runtime `stopped` **and** `!driver.hasProcess(bee, sourceGeneration)`: phase `placing`.
4. **placing** (daemon, then one tx): `relocateSession(home, sid, fromCwd, toCwd)` — Claude copies `projects/<cwd-key>/<sid>.jsonl` + sibling `<sid>/`; never overwrite dest; source untouched. Codex no-op. Missing Claude transcript → `failed` + `transcript_unavailable`, **no** cwd flip. Then: cell `retained`; bee `substrate=hsr`, `cwd=toCwd`, `placement_version++`; enqueue `revive` key `move:<id>:revive`; phase `starting`.
5. Gen N+1 spawn reads the **post-commit** row (HSR at dest cwd, same `providerSessionId`).
6. First destination turn cannot be a user task before canonical context:
   - Claude: `--append-system-prompt` with Honeybee-authored placement delta on that revive.
   - Codex: `thread/start` and `thread/resume` `developerInstructions` (codex-cli ≥ 0.153.4) carrying the same placement delta. Existing custom developer instructions are preserved (overlay appended, never replaced). Application is recorded when the dest generation leaves `booting` (handshake acknowledgement), never at `resolveSpawnSpec`.
   - All: delivery-time **prefix** on the first post-placement deliver (durable body unchanged).
   - Unfence (`complete`, clear `active_move_id`) only after dest is at an accept point **and** the instruction was applied (startup overlay and/or prefixed deliver). If no pending mail, complete on dest running/idle after native startup overlay (Claude argv / Codex handshake).
7. `failed` stays until a new admit (new placementVersion). Destination spawn failure does **not** roll the Cell back.

Placement delta text (substance):

> Workspace placement changed (version N). Your active workspace is now the regular checkout at PATH. This supersedes earlier Cell-workspace instructions. Cell CELL_ID is retained but is not your cwd; access it only through authenticated Cell tools. No changes were copied, merged, or applied. Pending messages follow this instruction.

---

## CLI

```
hive cell move <bee> --cwd <dir> --expected-version N --cell-id ID --observed-head SHA --git-common-dir PATH --object-format sha1|sha256 --idempotency-key k
hive cell move-get <moveId>
hive cell exec <cellId> --idempotency-key k [--timeout ms] [--cwd rel] -- <argv…>
hive cell retained-remove <cellId> [--force] --idempotency-key k
```

Picker identity fields may also be inferred by the CLI from `--cwd` (common-dir, HEAD, object format) and current bee `cellId`/`placementVersion` when flags omitted — daemon still CAS-validates.

---

## Out of scope

Remote/cross-node move, auto capture/merge/checkout, new FLAG, new mailbox origin/urgency, new B5 verb, deploy, production bees.
