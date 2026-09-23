# Per-bee action queue — Honeybee wire contract

Locked for Apiary. Schema **v24**; operator completion and the reminder mail
are an additive slice with no schema change (see "Operator completion and
reminders").
Protocol stays `v2/1`; everything is additive.

An **action** is one unit of work for one bee. A **queue** is the bee's ad hoc
ordered sequence of accepted actions (the Ctrl+X palette: `L` appends Land,
`E` appends Archive after it). Honeybee owns acceptance, durable scheduling,
mailbox delivery of agent instructions, structured execution through the
existing operation owners, and the authoritative result state. Apiary mirrors
the queue from the snapshot + audit stream and submits mutations through the
verbs below (through Waggle, its outbox). Tracks are untouched by this slice;
they are the future reusable-workflow layer over the same executor/result
contract.

Non-goals of this slice: parallel action graphs, custom/user-defined
definitions (registry shape is ready; a `action.define` verb is a later
additive slice), track migration, a second delivery engine, a runtime
supervisor.

---

## Capability (hello / `deployInfo`)

```
"bee.actions.v1"
```

```
"bee.actions.complete.v1"   // action.complete, controls.complete, dispatch.nudgedAt, the reminder mail
```

An older daemon lacks the tag; every `action.*` verb answers `invalid_request`
(`unknown verb`) there. Gate on the tag, never on verb sniffing. A daemon with
`bee.actions.v1` but without `bee.actions.complete.v1` answers
`action.complete` with `invalid_request` and its views have no
`controls.complete` / `dispatch.nudgedAt`.

---

## Vocabulary (closed)

| set | values |
|---|---|
| executor | `agent` · `cell.capture` · `lifecycle.archive` · `external` |
| status | `queued` · `running` · `waiting` · `succeeded` · `failed` · `cancelled` |
| waitingReason | `input` (agent asked a question) · `executor` (no executor available / no claimant) · `uncertain` (effect may or may not have happened) |
| hold.reason (derived, queued only) | `paused` · `predecessor_active` · `predecessor_failed` · `lane_busy` |
| attempt outcome (history) | `succeeded` · `failed` · `cancelled` · `uncertain` · `superseded` |
| mail origin | `action.dispatch` (additive to `mail.enqueued`; carries both the instruction and the reminder) |

Status graph: `queued → running | waiting | succeeded | failed | cancelled`;
`running → waiting | succeeded | failed | cancelled`; `waiting → running |
succeeded | failed | cancelled | queued`; `failed → queued` (retry) |
`succeeded` (operator `action.complete` on an agent action only) |
`cancelled` (operator `action.cancel`); `succeeded`, `cancelled` final.
Action state is separate from bee lifecycle, runtime state and mailbox
delivery: **delivering the instruction,
finishing a turn, runtime idle, elapsed time, a reminder or transcript text
never complete an action.** Only an authenticated report, an authoritative
operation receipt, or an explicit operator `action.complete` does.

---

## Built-in definitions (`action.definitions`)

| kind@version | executor | inputs | required outputs |
|---|---|---|---|
| `commit@1` | agent | `message?`, `instruction?`, `urgency?` | `commitSha` (7–64 hex); `branch?` |
| `name_branch@1` | agent | `instruction?`, `urgency?` | `branch` |
| `fix@1` | agent | `instruction?`, `urgency?` | — (`summary?`) |
| `instruction@1` | agent | `instruction` (required), `title?`, `outputs?: string[]`, `urgency?` | every name in `inputs.outputs` |
| `land@1` | cell.capture | `targetBranch` (required), `mode?` merge\|rebase, `commit?` (sha or `$ref`) | `resultSha`, `targetBranch`, `cellHead`; `alreadyLanded?` |
| `archive@1` | lifecycle.archive | — | `archivedAt` |
| `push@1` | external | `branch?`, `remote?` | — (`remote?`, `branch?`, `sha?`) |
| `open_pr@1` | external | `branch?`, `base?`, `title?`, `body?` | `prUrl`; `prNumber?` |

A queued instance snapshots its definition (`ActionView.definition`); a later
definition change never retargets accepted work. `land@1` applies to Cell
bees only: on any other placement it fails typed `placement_changed`
(non-retryable) — landing a regular checkout / GitHub merge is an **external**
kind Apiary executes (see "Required Apiary work").

### Output references

Any top-level input value may be a reference to a predecessor's output:

```json
{ "$ref": { "action": "<actionId>", "output": "commitSha" } }
{ "$ref": { "item": 0, "output": "commitSha" } }        // same enqueue request; rewritten to an action id at acceptance
```

References are validated at acceptance (target must be an earlier action of
the same bee / an earlier item) and **resolved at dispatch time** against the
target's `result.outputs`. A target that has not succeeded, or lacks the
output, fails the referencing action with `input_unresolved` (retryable) —
never a silent null.

---

## Verbs

```
action.enqueue          action.get           action.list         action.definitions
action.cancel           action.reorder       action.retry        action.complete
action.queue.get        action.queue.pause   action.queue.resume
action.report           action.claim
```

### `action.enqueue`

```ts
{ beeId, idempotencyKey /* required */, items: ActionEnqueueItem[] }
ActionEnqueueItem = { kind, version?, inputs?, clientRef?, title? }
→ { actions: ActionView[], queue: ActionQueueView, deduped }
```

One request = one ordered sequence (a single action is a one-item sequence).
Items are appended after the bee's current tail at the queue's append cursor,
so concurrent requests order deterministically by commit. Canonical request
hash: stable JSON of `{beeId, items:[{kind, version, inputs, clientRef,
title}]}` (defaults applied). Same key + same hash → the original actions
(`deduped: true`), also after a daemon restart; same key + different hash →
`idempotency_conflict`. Errors: `bee_not_found`, `action_kind_unknown`,
`invalid_request` (bad inputs, missing required input, forward/unknown
`$ref`, unknown urgency). `clientRef` is echoed on the view for outbox
correlation. Acceptance is durable immediately; nothing is dispatched inside
the request.

### Reads

- `action.get {actionId}` → `{action}` (`action_not_found`).
- `action.list {beeId?, statuses?}` → `{actions}` in lane order.
- `action.queue.get {beeId}` → `{queue}` (a bee that never queued has a default unpaused summary).
- `action.definitions {}` → `{definitions}`.

### Controls (all take `idempotencyKey?`; all answer `DedupMarkers`)

| verb | params | semantics |
|---|---|---|
| `action.cancel` | `{actionId, force?}` | Cancels pending work or removes a failed step. Allowed outright when `controls.cancel` (queued; `failed`, any executor — nothing is in flight; running agent attempt whose instruction is still undelivered — the mail is withdrawn; unclaimed external offer). `controls.forceCancel` needs `force:true`: delivered/claimed/in-flight attempts stop being tracked, **effects already under way are not undone**, and a late report for that attempt is refused. A running `lifecycle.archive` is never cancelled (`action_refused`). A cancelled failed action keeps its `failure` and its attempt history (`failed`); the release rule skips it, so the next step's predecessor becomes the one before it. A successor that `$ref`s its outputs fails `input_unresolved` (retryable) at dispatch. `succeeded`/`cancelled`: quiet `applied:false`. |
| `action.retry` | `{actionId, force?}` | A **new** attempt (attempt+1, new token, old attempt closed in `attempts` history) for a `failed` action. `waiting/uncertain` requires `force:true` — the caller asserts the effect did not happen or may safely repeat; without force, reconcile the same attempt through `action.report` instead. Others: `action_refused`. |
| `action.complete` | `{actionId, outputs?: Record<string,string>, detail?}` | The operator settles the **current** attempt of an agent action as `succeeded`, exactly as if the agent had reported: `result.outputs`, `result.receipt = {completedBy: "operator"}`, `result.detail = detail ?? null`. Allowed when `controls.complete` (executor `agent`; `running`, `waiting` with `waitingReason: input`, or `failed`); an open action otherwise → `action_refused`. Other terminal actions (`succeeded`, `cancelled`, a failed non-agent action): quiet `applied:false`. On a `failed` action it overrides the reported failure: `result.receipt` also carries `overrodeFailure: {code, detail, attempt, at}` (the failure moves there; `failure` becomes null), the attempt history keeps `failed`, and the attempt token is retired, so every later report for that attempt is `action_unauthorized`. Outputs are validated like a report (plus the `instruction` kind's requested outputs): missing/invalid → `invalid_request`, nothing changes. `commit`: an omitted `outputs.commitSha` is filled from the bee's checkout HEAD (`git rev-parse HEAD` in the Cell space for Cell bees, else the bee's cwd) and `branch` from the current branch when HEAD is on one; an unreadable HEAD → `invalid_request` (pass `commitSha`). An undelivered instruction is withdrawn from the mailbox; an open question of the attempt is answered (ordinary mail telling the agent no report is needed). The token is kept: a late agent report for the attempt with outcome `succeeded` is `deduped`, any other outcome is `action_refused`. Result: `{action, applied, deduped?}`. Audit: `action.put` with reason `operator_complete`. |
| `action.reorder` | `{beeId, order: string[]}` | `order` must list exactly the bee's **queued** ids, once each; every `$ref` into another queued action must still point backwards. Otherwise `action_reorder_invalid` and nothing changes. Running/waiting/terminal rows keep their positions. |
| `action.queue.pause` / `resume` | `{beeId}` | Pause stops **releases** only: the active attempt continues, deliveries continue, reports are accepted. Queued actions show `hold.reason = paused`. |

### `action.report` — authenticated result path

```ts
{
  actionId, attempt, token,
  beeId?      // agent reports: the reporting bee (CLI binds HIVE_BEE_ID)
  executor?   // executor reports: the claimant name
  kind: "progress" | "question" | "result",
  note?,                                        // progress
  question?: { text, options? },                // question → questions row; action waits (input)
  outcome?: "succeeded" | "failed" | "uncertain", outputs?, receipt?, detail?, failure?: {code?, detail?, retryable?},
  idempotencyKey?
}
→ { action, accepted: true, applied, question, deduped? }
```

Validation, in order: attempt < current → `action_stale_attempt` (audited
`action.report_rejected`); attempt > current / never dispatched →
`action_refused`; agent actions require `beeId === action.beeId`, external
actions require `executor === dispatch.claimedBy`, structured internal
executors refuse reports (`action_refused`) — else `action_unauthorized`;
token ≠ current attempt token → `action_unauthorized`. Required outputs
missing / pattern mismatch → `invalid_request` and the action stays running.
Duplicate result with the same outcome → `applied:false, deduped:true`;
different outcome for a settled attempt → `action_refused`. Progress after a
terminal status is a quiet no-op. `uncertain` parks the attempt as
`waiting/uncertain`; a later `succeeded|failed` on the **same** attempt
reconciles it (`result.reconciled = true`). A caller `idempotencyKey` replays
the recorded result.

The token is the capability: for agent attempts it is carried in the
delivered instruction body; for external attempts it is returned by
`action.claim`. Tokens never appear in views, snapshots or the audit stream.

### `action.claim` — external executors

```ts
{ executor, actionId?, kinds?, beeId? }
→ { claim: { action, attempt, token, resolvedInputs, deduped } | null }
```

Takes the oldest offered attempt (`waiting/executor`, unclaimed) matching the
filter, or the named action. Re-claim by the same executor is idempotent;
another executor's attempt is `action_claimed`. The claimant must
`action.report` with `executor` + `token`. There is no registration table:
availability is expressed by claiming; an unclaimed external action stays
`waiting/executor` with `waitingDetail` naming the kind.

---

## Shapes

```ts
type ActionView = {
  id, beeId, position, clientRef, kind, definitionVersion, executor, title,
  definition: ActionDefinition,                 // snapshot at acceptance
  inputs: Record<string, unknown>,              // raw, may contain $ref
  resolvedInputs: Record<string, unknown> | null, // resolved at the latest dispatch
  status, waitingReason, waitingDetail,
  hold: { reason, actionId, actionStatus } | null,   // queued only; derived server-side
  attempt,                                      // 0 before the first dispatch
  dispatch: { attempt, dispatchedAt, generation, messageId, deliveredAt, deliveredGeneration,
              operationKey, claimedBy, claimedAt, expectedHead,
              nudgedAt /* bee.actions.complete.v1: when the one reminder for this attempt was mailed; null until then */ } | null,
  progress: { note, at, attempt } | null,
  questionId,
  result: { outputs, receipt, detail, reconciled, attempt, at } | null,
  failure: { code, detail, retryable, attempt, at } | null,
  attempts: ActionAttemptRecord[],              // earlier attempts
  controls: { cancel, forceCancel, retry, forceRetry, reorder, complete /* bee.actions.complete.v1 */ },   // derived server-side
  createdAt, updatedAt, finishedAt
}
type ActionQueueView = { beeId, paused, pausedAt, activeActionId, counts: Record<status, number>, createdAt, updatedAt }
```

Key lists: `MIRROR_ACTION_KEYS`, `MIRROR_ACTION_QUEUE_KEYS`,
`MIRROR_ACTION_DISPATCH_KEYS`, `MIRROR_ACTION_RESULT_KEYS`,
`MIRROR_ACTION_FAILURE_KEYS`, `MIRROR_ACTION_HOLD_KEYS`,
`MIRROR_ACTION_CONTROLS_KEYS`, `MIRROR_ACTION_ATTEMPT_KEYS`,
`MIRROR_ACTION_DEFINITION_KEYS` (core `mirror.ts`).

### Snapshot + events

`snapshot` / `watch` gain `actions: ActionView[]` and `actionQueues:
ActionQueueView[]`. Deltas (audit kinds on the watch stream):

| kind | payload | mirror effect |
|---|---|---|
| `action.put` | `{ action: ActionView, previous: status \| null, reason }` | upsert the view verbatim. A lane change re-emits every sibling whose derived `hold`/`controls` changed, so the mirror never derives. |
| `action_queue.put` | `{ queue: ActionQueueView, reason }` | upsert |
| `action.report_rejected` | `{ actionId, beeId, attempt, currentAttempt, kind, reporter, reason }` | informational |
| `mail.enqueued` | `origin: "action.dispatch"`, sender `hive:action` | the instruction mail (existing kind) |
| `mail.enqueued` | `origin: "action.dispatch"`, sender `hive:action`, body starting `[Hive action] Reminder` | the one reminder mail for a silent attempt (a different message id from `dispatch.messageId`) |

`bee.deleted` cascades `actions` + `action_queues` for that bee. Rebuild rule
is unchanged: snapshot at seq N, apply contiguous deltas, refetch on any gap.

---

## Scheduling (one lane per bee)

Each daemon step, for every bee with open actions:

1. If an action is `running`/`waiting` it owns the lane: settle it from its
   owner (archive command outcome, capture receipt, recovery probe) or leave
   it. Nothing else is released.
2. Otherwise, if the queue is not paused, the lowest-position `queued` action
   is released **iff** its positional predecessor (nearest lower position,
   cancelled rows skipped) is `succeeded` or absent. A `failed`, `waiting`,
   `running` or `queued` predecessor holds it (`hold.reason`).
3. Dispatch by executor:
   - **agent** — attempt+1, token minted, inputs resolved, the instruction
     inserted as ordinary mail (`origin: action.dispatch`, urgency from
     `inputs.urgency`, default `next` = the next harness accept point, never an
     interrupt; `idle` waits for runtime idle; `now` interrupts). Delivery is
     the existing delivery loop's job; `dispatch.deliveredAt/Generation` are
     evidence only. The action stays `running` until a report (or an
     operator `action.complete`). A silent attempt may get one reminder (see
     "Operator completion and reminders").
   - **lifecycle.archive** — enqueues the bee's `archive` command under
     `action:<id>:a<n>` (idempotent replay); settles from the command's
     outcome + the bee row. An already-archived bee succeeds at dispatch.
   - **cell.capture** — the attempt is opened **before** the effect
     (`dispatch.operationKey = action:<id>:a<n>`, `dispatch.expectedHead` = the
     Cell HEAD observed now). Preconditions are revalidated against the
     bee's current placement (`substrate = cell`, active registry row,
     provisioned Cell) and `inputs.commit` (if given) must equal the Cell
     HEAD (`precondition_failed` otherwise — the work moved after it was
     committed). Then driver-cell `captureWork` runs with op id
     `action-<id>-a<n>`; the report is the receipt: `landed` /
     `nothing_to_capture` → `succeeded` (`alreadyLanded` distinguishes),
     `conflict` → `failed/conflict` (paths in detail, receipt attached),
     `refused` → `failed/refused_<reason>`, a throw → `failed/capture_error`.
     A busy Cell (in-flight Cell op) holds it as `waiting/executor` and
     retries next step.
   - **external** — attempt+1, token minted, `waiting/executor` until a
     claim.
4. An internal executor that this daemon cannot provide (no Cell driver)
   holds the action `waiting/executor` with a detail; it proceeds on a
   daemon that has it. No action ever pretends to run.

### Interaction with the rest of the bee

- **Ordinary user mail**: unaffected. It shares the per-bee FIFO with
  dispatched instructions; a user message queued before the dispatch is
  delivered first. Urgency rules apply verbatim.
- **Questions**: an agent's `action.report {kind: question}` creates a normal
  `questions` row (`question.list` / Apiary inbox) and parks the attempt
  `waiting/input`. `question.answer` delivers the answer as ordinary mail and
  resumes the **same** attempt (`running`). Downstream stays held meanwhile.
- **Manual `archive`**: does not touch the queue. A later agent dispatch is a
  `send`, which auto-unarchives per the existing contract.
- **Manual `stop`**: the runtime stops; an undelivered instruction stays in
  the mailbox and follows the existing wake/revive rules; a delivered,
  unreported attempt stays `running` across generations (the token is valid
  for the attempt, not the generation) — the operator can cancel (force) or
  wait for the revived agent's report.
- **Runtime replacement (handoff / move)**: mailbox rules of those operations
  apply to undelivered instructions (a handoff's queued mail follows the seed).
  A delivered attempt stays `running`; the new runtime may still report with
  the token found in the transcript. Limitation: the handoff context summary
  does not yet list the pending action explicitly.
- **`delete`**: cascades the queue.
- **`mail.cancel`** of a dispatched instruction before delivery fails that
  attempt typed `dispatch_cancelled` (retryable).

---

## Idempotency, retry, uncertainty, recovery

- Acceptance: `action.enqueue` key (durable `action_enqueues` receipt).
- Dispatch: agent mail is inserted in the same transaction as the attempt;
  archive commands are keyed `action:<id>:a<n>`; capture op ids are
  `action-<id>-a<n>`; results are attempt-fenced (a settle/report for an older
  attempt is a recorded no-op / typed refusal and never completes a newer
  attempt).
- Retry = a new attempt; reconcile = a result for the same attempt. The
  distinction is visible in `attempts[]` (`failed` vs `superseded`) and
  `result.reconciled`.
- Daemon crash mid-capture (effect done, receipt lost): on boot every
  `running` cell.capture attempt is marked `waiting/uncertain` and downstream
  is held. The scheduler asks the Cell owner whether the origin's target
  branch already contains `dispatch.expectedHead`: yes → `succeeded`
  (`reconciled`, `resultSha` = the branch tip); no → the origin is
  bit-identical by capture's A1 guarantee, so the **same attempt** re-runs
  after re-checking the Cell HEAD. Never a blind repeat.
- Lost acknowledgement to a client: every mutation is replayable by key;
  reports are per-attempt idempotent; `action.get`/snapshot show the truth.
- No generic exactly-once for external effects: an executor that cannot
  establish its outcome reports `uncertain`; the queue holds until it
  reports the reconciled result or the operator force-retries.

---

## Commit → Land → Archive, concretely

```jsonc
// action.enqueue
{ "beeId": "b-1", "idempotencyKey": "waggle:9f2c", "items": [
  { "kind": "commit", "inputs": { "message": "queue work" }, "clientRef": "palette:1" },
  { "kind": "land",   "inputs": { "targetBranch": "main",
                                  "commit": { "$ref": { "item": 0, "output": "commitSha" } } }, "clientRef": "palette:2" },
  { "kind": "archive", "clientRef": "palette:3" } ] }
// → actions[0].id = A, actions[1].id = B (inputs.commit = {$ref:{action:A, output:"commitSha"}}), actions[2].id = C
```

1. Accepted while the bee works (`queued` ×3; B and C `hold: predecessor_active`).
2. Next step: A `running` attempt 1; mail `[Hive action] Commit — action A, attempt 1 … hive action report A --attempt 1 --token t1 --succeeded --output commitSha=<sha>` delivered at the next accept point.
3. Agent: `hive action report A --attempt 1 --token t1 --succeeded --output commitSha=abc…` → A `succeeded`, `result.outputs.commitSha`.
4. Next step: B resolves `commit = abc…`, checks the Cell HEAD is `abc…`, captures onto `main`; receipt `landed` → B `succeeded` (`resultSha`, `cellHead`, `targetBranch`, `alreadyLanded:false`, receipt = the capture report). Conflict → B `failed/conflict`, C `hold: predecessor_failed` (retry B after resolving).
5. Next step: C `running` (archive command); the command settles → C `succeeded` (`archivedAt`); bee `archived`.
6. A question during step 3 (`--ask`) parks A `waiting/input`; B, C hold until `question.answer`.
7. Daemon restart anywhere: rows and attempts are durable; a lost capture receipt reconciles through the probe.

---

## CLI

```
hive action enqueue <bee> <kind> [--input k=v|k:=json]... [--title t] [--idempotency-key k]
hive action enqueue <bee> --items-json '[…]'
hive action list [--bee b] [--status s] · get <id> · definitions
hive action cancel <id> [--force] · retry <id> [--force]     (cancel: queued or failed outright; --force for delivered/in-flight attempts) · pause <bee> · resume <bee> · reorder <bee> <id>...
hive action complete <id> [--output k=v]... [--detail d] [--idempotency-key k]   (running, waiting-on-input or failed agent actions)
hive action report <id> --attempt n --token t (--succeeded [--output k=v]... | --failed [--code c] [--detail d] | --uncertain [--detail d] | --ask "q" [--option o]... | --progress "note") [--bee b]
hive action claim --executor <name> [--kind k] [--bee b] [--action id]
```

`report` binds the bee from `HIVE_BEE_ID` (the daemon-stamped runtime env)
unless `--bee` is given; the token comes from the delivered instruction.

---

## Required Apiary work

- Mirror `actions` + `actionQueues` from the snapshot and the `action.put` /
  `action_queue.put` / `bee.deleted` deltas; gate on `bee.actions.v1`.
- Submit `action.enqueue` (with a Waggle-owned `idempotencyKey` and
  `clientRef` per palette entry), the controls, and `question.answer` through
  the outbox; render `status`, `waitingReason`/`waitingDetail`, `hold`,
  `result`, `failure`, `controls` verbatim — no client-side scheduling.
- Provide the **external executors** for `push` and `open_pr` (and any
  non-Cell landing): poll `action.claim {executor:"apiary", kinds:[…]}` on
  `action.put` deltas with `waitingReason = executor`, execute with Apiary's
  git/GitHub owners, and `action.report` the receipt (`outcome: uncertain`
  when the owner cannot establish it, then reconcile on the same attempt).
- Palette wiring: `L` → `land` (Cell bees; `targetBranch` from the workspace
  destination), `E` → `archive`; Commit/Fix/Name-branch → the agent kinds.
- Not provided by Honeybee in this slice: landing regular (non-Cell)
  checkouts, PR merge, push. These are external kinds.

---

## Verification (2026-09-16)

- `v2/core/tests/actions.test.ts` (8): acceptance/idempotency/refs, dispatch,
  reports (auth, stale, duplicate, conflicting), question hold/resume,
  controls, mail.cancel, archive settle, external claim/uncertain/force-retry,
  audit replay + reopen + delete cascade.
- `v2/daemon/tests/actions.test.ts` (6, FakeDriver + scripted Cell owner):
  the full ship scenario mid-turn, holds (conflict / question / failed
  commit), preconditions, restart at every stage incl. uncertain-capture
  reconciliation (probe → reconciled, or re-run of the same attempt),
  pause/cancel/concurrent append/invalid reorder/stale reports, external
  claim + missing internal executor.
- `v2/daemon/tests/actions-rpc.test.ts` (2, real daemon, real Cell over a git
  fixture origin, stub agent): capability, durable acceptance, mailbox
  dispatch, SIGKILL mid-sequence, the agent's real commit in the Cell, the
  daemon's real `cell.capture` advancing the origin branch, archive, a real
  merge conflict + retry, snapshot/audit shapes, external claim.
- `v2/cli/tests/actions-cli.test.ts` (1): the `hive action` surface incl.
  `report` bound by `HIVE_BEE_ID`.
- 2026-09-23 failed-action exits: core `actions.14` (complete on a failed
  commit: receipt, history, `$ref` Land resolves, pause untouched, late
  reports refused, failed `cell.capture` controls) and `actions.15` (cancel
  on failed releases the next step; a `$ref` successor fails
  `input_unresolved`); RPC `actions.rpc.failed-exits` (real Cell: HEAD fill
  on a failed commit, Land lands, cancel → `input_unresolved`, replayed
  keys dedupe, late reports refused).
- 2026-09-23 additions: core `actions.9`–`actions.13` (complete,
  late-report dedupe/refusal, question closure, undelivered withdrawal, the
  reminder mail + exactly-once record, a cancelled reminder never fails the
  attempt, legacy dispatch JSON, no reminder for an archived bee); loop
  `actions.loop.nudge` / `nudge-scope` / `nudge-archived` (virtual clock: not before 30 min,
  reset by progress / an answered question, idle-only delivery, once across
  restart, again for a retry, never for other kinds / after cancel or
  complete / while waiting); RPC `actions.rpc.complete` (real Cell: HEAD
  fill, detached HEAD omits `branch`, Land proceeds, plain checkout fills
  `branch`, non-git cwd refuses); the CLI `complete` subcommand.
- Fixture-proven vs real: the loop tier scripts the Cell owner; the RPC tier
  uses real git. No live bees or `~/.hive` are touched by any test.

## Operator completion and reminders (`bee.actions.complete.v1`)

Written after an incident (2026-09-23): a bee was told by the operator to
ignore the instructions, got a `commit@1`, never reported, and held the
queued Land behind it for three days.

- **`action.complete`** (see the controls table) is the operator's explicit
  way to settle such an attempt. It is an authoritative statement by the
  operator, not an inference.
- **Failed actions** (second incident, same day: an agent reported a
  `commit@1` as `--failed` because a typecheck failed, then committed anyway
  on the operator's word; the failed Commit held Land as
  `predecessor_failed` and only `retry` was offered). A failed action now has
  two more exits besides `retry`. `action.complete` on a failed **agent**
  action marks it done despite the failure (same output validation and HEAD
  fill; the overridden failure is kept in `result.receipt.overrodeFailure`
  rather than on `failure`, so a succeeded view never shows a live failure
  while the reason stays visible). `action.cancel` on a failed action of
  **any** executor removes it from the lane without `force`. Successors held
  by `predecessor_failed` are released by the normal rule; the queue's pause
  state is not touched. No new capability: both exits ride
  `bee.actions.complete.v1`, and Apiary renders them from the derived
  `controls.complete` / `controls.cancel`. An older daemon derives both as
  false for a failed action. No mirror key changes; `types.ts` changes only
  in `ACTION_TRANSITIONS` (`failed → succeeded | cancelled`) and doc
  comments.
- **Reminder.** The scheduler mails **one** reminder per attempt to a
  `running` agent attempt whose instruction was delivered
  (`dispatch.deliveredAt` set) and whose latest sign of life —
  `max(deliveredAt, progress.at for this attempt, answeredAt of the
  attempt's question)` — is at least the kind's threshold old. Thresholds
  are scheduler policy by kind, not part of the definition shape: today only
  `commit` (30 minutes). The mail: sender `hive:action`, `origin:
  action.dispatch` with the body marker `[Hive action] Reminder` (its own
  message id, never `dispatch.messageId`: delivering or cancelling it is not
  evidence about the instruction and never fails the attempt), urgency `idle` (never interrupts a turn; the normal wake
  rules apply to a stopped runtime), body starting `[Hive action] Reminder —
  Commit — action <id>, attempt <n>`, restating the `--succeeded --output
  commitSha=<commitSha>` and `--failed --detail` commands with the attempt
  token. The mail and `dispatch.nudgedAt` commit in one transaction, so a
  reminder happens at most once per attempt across daemon restarts; the
  `action.put` carries reason `nudged`. Cancel, complete, a result report or
  `waiting` stop reminders; a retry is a new attempt and may be reminded
  again.
- An archived bee is never reminded (`send` would unarchive it); the
  reminder resumes if the operator unarchives it while the attempt is open.
- No schema change: the reminder reuses the `action.dispatch` origin and
  `nudgedAt` lives in the existing `dispatch_json` (rows written earlier read
  as `nudgedAt: null`). Rollback to an older binary stays possible.
- Mirror key changes: `MIRROR_ACTION_DISPATCH_KEYS` gains `nudgedAt`;
  `MIRROR_ACTION_CONTROLS_KEYS` gains `complete`.

## Limitations

- Agent completion still depends on the agent calling `hive action report`
  or the operator calling `action.complete`; an agent that never reports
  leaves the action `running` (visible, cancellable, completable)
  — by design, no inference from silence. The reminder is only a reminder:
  it never completes, fails or releases anything.
- Handoff context does not yet enumerate the pending action.
- Custom definitions, saved sequences, hotkeys and track integration are
  future additive slices.

### Apiary destination Land and external recovery

`land@2` is an additive external definition. It requires a destination object
`{nodeId, root, branch}` and optionally a commit output reference. Apiary pins the
source revision after release, transfers it through its receiver and reports
`resultSha`, `targetBranch` and `cellHead` only after integration. Existing
`land@1` instances and unversioned CLI Land remain `cell.capture` for compatibility.
Apiary selects version 2 explicitly. External definition discovery alone does
not imply an available executor; without the destination app the action waits.

An external claimant may reclaim its own uncertain attempt to recover the same
token after restart. Reclaim does not clear uncertainty, rotate the token or
release the next action. A foreign claimant remains refused. A same-attempt
result reconciles publication or landing using the owner's persisted receipt.
