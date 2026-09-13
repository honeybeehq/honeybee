# Session handoff — Honeybee wire contract

Locked for Apiary. Schema **v23**. Protocol stays `v2/1`; everything is additive.

A handoff moves the **execution ownership** of one bee to a fresh provider thread,
optionally on another harness (Codex → Claude). The bee id, handle, name, tags,
parent, mailbox, Cell/placement, dirty files and history all stay. `bee.fork`
remains the separate verb that creates **another** bee.

This replaces Apiary's interrupt → spawn-with-instructions → archive sequence with
one Honeybee-owned durable operation.

---

## Capability (hello / `deployInfo`)

```
"bee.handoff.v1"
```

---

## Error codes (additive to `RPC_ERROR_CODES`)

| code | when |
|---|---|
| `handoff_in_progress` | the bee already has an incomplete handoff (different request) |
| `stale_generation` | `expected.generation` (or `expected.agent`) does not match the bee |
| `handoff_not_found` | `bee.handoff.get` with an unknown id |

Reused: `bee_not_found`, `invalid_request` (unknown target agent / bad args /
bad `stopAt` / missing key / tmux cross-family), `lifecycle_refused` (archived bee),
`move_in_progress`, `idempotency_conflict`, `account_not_found`, `account_paused`,
`harness_mismatch`, `account_unavailable`.

Every refusal happens **before** anything changes: the source keeps running, no
receipt is written.

---

## RPC verbs

```
bee.handoff
bee.handoff.get
```

### `bee.handoff`

```ts
type BeeHandoffStopAt = "idle" | "now"

type BeeHandoffParams = {
  beeId: string
  idempotencyKey: string                 // REQUIRED
  expected: { generation: number; agent?: string }   // CAS on the source generation
  target: {
    agent: string                        // a configured agent (node.harnesses)
    args?: string[] | null               // omitted: keep the bee's args for same-family, none for cross-family
    account?: string | null              // selector for the TARGET harness: id | "auto" (default) | "rr" | null = unbound
  }
  instruction?: string                   // operator note carried into the context + seed
  stopAt?: BeeHandoffStopAt              // default "idle": quiesce at the next turn end; "now": stop immediately
}

type BeeHandoffResult = BeeHandoffView & { deduped?: boolean }
```

Canonical request hash: stable JSON of `{ beeId, expected, target: {agent, args, account}, instruction, stopAt }`
(after the daemon resolves `args`/`account` defaults). Same key + same hash → the
original receipt (`deduped: true`), also after a daemon restart or a lost response.
Same key + different hash → `idempotency_conflict`.

### `bee.handoff.get { handoffId }` → `BeeHandoffView`

---

## Receipt (RPC + mirror view)

```ts
type BeeHandoffPhase = "stopping" | "summarizing" | "starting" | "complete" | "failed"

type BeeHandoffFailure = {
  stage: "validate" | "stop" | "context" | "switch" | "start"
  code: string                           // superseded | spawn_failed | summarizer_failed | handoff_failed | …
  detail: string
}

type BeeHandoffView = {
  id: string
  beeId: string
  phase: BeeHandoffPhase
  sourceGeneration: number               // the generation quiesced at the boundary
  targetGeneration: number | null        // first generation on the target; null until the switch
  from: { agent: string; args: string[] | null; account: string | null; providerSessionId: string | null; segmentId: string }
  to:   { agent: string; args: string[] | null; account: string | null; segmentId: string | null }
  instruction: string | null
  stopAt: BeeHandoffStopAt
  seedMessageId: number | null           // mailbox row carrying the context seed; null until the switch
  context: HandoffContext | null         // the persisted artifact; null until the switch
  failure: BeeHandoffFailure | null
  createdAt: number
  updatedAt: number
}
```

`BeeHandoffRow` (store/dump/audit only, never on the wire view) adds
`idempotencyKey, requestHash, stopCommandKey, reviveCommandKey, sourceWasLive,
targetEnv, targetSessionLogPath`.

### Context artifact

```ts
type HandoffContext = {
  version: 1
  summarizer: string                     // "extractive" (built-in) or the daemon's injected summarizer name
  generatedAt: number
  task: string | null                    // first delivered operator/human message, else first user turn, else title
  instruction: string | null
  constraints: string[]
  decisions: string[]
  completedWork: string[]                // seals, done tasks, last assistant message
  outstandingWork: string[]              // open/in-progress/blocked tasks, open questions, queued-mail note
  recentTurns: Array<{ role: "user" | "assistant" | "tool" | "system"; text: string }>   // bounded tail
  transcript: {
    segments: Array<Pick<TranscriptSegmentRow, "id" | "ordinal" | "harness" | "providerSessionId" | "path" | "fromGeneration" | "toGeneration">>
    truncated: boolean
  }
  mailbox: {
    summarizedMessageIds: number[]       // delivered to source generations: their bodies are in the transcript/summary
    queuedMessageIds: number[]           // undelivered at the switch: they stay queued and follow the seed, in order
  }
}
```

Bounds: 24 recent turns × 2 000 chars, 16 items × 600 chars per list, 512 KiB
transcript tail. The artifact is built **after** the source is quiesced, off the
RPC path.

---

## Mailbox semantics

- Messages **delivered** to any source generation are part of the summary
  (`mailbox.summarizedMessageIds`); they are never re-delivered.
- Messages **undelivered** at the switch stay queued (`mailbox.queuedMessageIds`)
  and are delivered to the target after the seed, in their original FIFO order.
  `send` keeps inserting during every phase.
- The seed is one durable mailbox row: `origin: "handoff.seed"`, sender
  `hive:handoff`, urgency `next`, delivered **first** on the target regardless of
  enqueue order (it is Honeybee-owned context, not user mail; FIFO among user mail
  is untouched). Its body is `HANDOFF_SEED_MARKER` + the rendered artifact.
- No message is duplicated or lost across the boundary; deliveries record the
  consuming generation as usual.

---

## Transcript segments

```ts
type TranscriptSegmentRow = {
  id: string                             // "seg:<beeId>:<ordinal>"
  beeId: string
  ordinal: number                        // 0-based, dense, stable
  harness: string                        // the harness that WROTE this segment
  providerSessionId: string | null       // the provider thread the segment's generations reported
  fromGeneration: number
  toGeneration: number | null            // null while open
  path: string | null                    // session log file; segment 0 = <beeId>.jsonl, then <beeId>.s<n>.jsonl
  handoffId: string | null               // null for segment 0
  createdAt: number
  closedAt: number | null
}
```

Every bee has segment 0 (backfilled by the v23 migration from `agent` +
`sessionLogPath`). For a frozen-import bee, segment 0's `path` is the old
world's transcript path recorded on the row; the daemon never appends the native
stream to a path outside its own `sessionLogDir` (those runtimes log to the
canonical `<sessionLogDir>/<beeId>.jsonl` as before), and target segments are
always created beside that canonical file. A handoff closes the open segment at `sourceGeneration` and
opens the next one with the target harness and a **new** log file, and moves
`bee.sessionLogPath` to it. Apiary rebuilds the full conversation by parsing each
segment's `path` with that segment's `harness`, in `ordinal` order — never the
whole log with the bee's current harness.

Provider thread ids are never reused across harnesses: the source id stays on the
closed segment; the target boots with `providerSessionId = null` and records its own.
A late session callback from a closed generation is recorded on its segment only
(`bee.provider_session_fenced`), never on the bee.

---

## BeeRow + mirror

- `BeeRow` additive: `activeHandoffId: string | null`.
- `MirrorBeeRow` additive: `handoff: BeeHandoffView | null` (latest receipt).
- `MirrorSnapshot` / `snapshot` additive tables: `beeHandoffs: BeeHandoffView[]`,
  `transcriptSegments: TranscriptSegmentRow[]`.
- `ViewResult` additive: `handoff`.

Audit kinds (replayable deltas on the watch stream):

| kind | payload | mirror effect |
|---|---|---|
| `bee.handoff_admitted` | `{ handoff }` | bee_handoffs insert; bee.activeHandoffId |
| `bee.handoff_phase` | `{ handoffId, beeId, phase, previous, handoff }` | bee_handoffs upsert; terminal phases clear activeHandoffId |
| `bee.handoff_context` | `{ handoffId, beeId, context, seedMessageId, targetSegmentId, targetGeneration }` | bee_handoffs fields (the following `bee.handoff_phase` carries the full row) |
| `bee.handoff_switched` | `{ beeId, handoffId, agent, previousAgent, args, previousArgs, account, previousAccount, env, previousEnv, previousProviderSessionId, previousForkSeed, sessionLogPath, previousSessionLogPath, previousSpawnFailures, segmentId }` | bee row: agent/args/account/env/sessionLogPath; providerSessionId + forkSeed → null; spawnFailures → 0 |
| `bee.handoff_failed` | `{ handoffId, beeId, failure, handoff }` | bee_handoffs upsert; activeHandoffId → null |
| `transcript_segment.put` | `{ segment }` | transcript_segments upsert |
| `bee.provider_session_fenced` | `{ beeId, generation, providerSessionId, segmentId, currentProviderSessionId }` | informational |

`mail.enqueued` for the seed carries `origin: "handoff.seed"`. `bee.deleted`
cascades transcript segments; handoff receipts remain.

---

## State machine

1. **Admit** (RPC, one core tx after daemon validation): dedupe by key; refuse
   archived / in-flight handoff / in-flight move; CAS `expected.generation`
   (+ `agent`); resolve the target account for the target harness; record both
   sides; set `activeHandoffId`; moot pre-admission start commands; enqueue the
   generation-fenced `stop` (`handoff:<id>:stop:g<N>`, `waitForIdle` when
   `stopAt = idle`). A stopped source admits too (the stop settles as a no-op).
2. **stopping** — fence while phase ∈ {stopping, summarizing}: `enqueueWake` →
   `fenced`; `claimNextCommand` skips this bee's `spawn|send_wake` and any
   `revive` that is not the handoff's own; the delivery loop skips the bee (no new
   turn on the source; `now` mail does not interrupt it). `stopAt = idle` holds the
   stop until the runtime leaves booting/running. Operator `stop(user)` / `archive` /
   `delete` / `revive` supersede (`failed` + `superseded`, fence lifts, wake re-armed).
3. **summarizing** — entered when the source generation is `stopped` **and** its
   process is gone (exact pid/birth identity, same rule as Cell move). The daemon
   builds the artifact from store facts + a bounded read of the source segments
   (rendered with the harness that wrote them); an optional injected async
   summarizer may refine it. Failure here → `failed(context)`.
4. **Switch** (one tx): persist context; close the source segment (carrying its
   thread id); open the target segment; bee → target agent/args/account/env,
   `providerSessionId = forkSeed = null`, `sessionLogPath = <target segment>`,
   `spawnFailures = 0` (+ `spawn_failed` cleared); insert the seed row; enqueue
   the fenced `revive` (`handoff:<id>:revive`, target generation N+1); phase
   `starting`. The revive resolves the spawn spec from the post-commit row (new
   adapter, no resume).
5. **starting** — dest boot retries are allowed; `spawn_failed` on the target →
   `failed(start)`; the seed is delivered first; on its acceptance → `complete`,
   `activeHandoffId` cleared, queued user mail follows.
6. **failed** recovery: before the switch the bee is unchanged (old harness, old
   thread, stopped) — fenced mail re-arms its wake, and a source that was live at
   admission is revived automatically (`revive {reason: "handoff_recovery"}`). After
   the switch the bee stays on the target with the seed queued; `revive` or new mail
   retries (the seed still goes first). Receipts remain readable after any outcome.

Restart safety: every phase reads committed state and is idempotent. A daemon
crash during any transition resumes from the store on boot (surviving source
runtimes are re-adopted and the stop proceeds; a process-less source reconciles
stopped and the handoff advances).

---

## Cells

A Cell bee hands off in place: same `cellId`, `cwd`, `placementVersion`, dirty
files; the target generation provisions nothing and runs inside the same
checkout (sandbox writable paths follow the target account). The driver-level
one-live-process-per-bee invariant plus the process-absence gate guarantee a single
runtime in the Cell. A handoff and a move exclude each other (`move_in_progress`
/ `handoff_in_progress`). Retained-Cell access (`cell.exec`, `cell.retained.remove`)
is untouched.

Substrates: `hsr` and `cell` support cross-family handoff; a `tmux` bee supports
same-family resets only (`invalid_request` otherwise — the TUI is baked into the seat).

---

## CLI

```
hive handoff <bee> --to <agent> [--model m | --args -- <args…>] [--account a|auto|rr|none]
                   [-p instruction] [--now] [--idempotency-key k] [--wait [--timeout ms]]
hive handoff get <handoffId>
hive handoff status <bee>
```

The CLI infers `expected.generation`/`expected.agent` from the current view; a
replayed CLI key after the generation moved is therefore `idempotency_conflict`
(use `handoff get` to read the receipt). `--wait` exits 0 on `complete`, 1 on
`failed`/timeout.
