# Apiary thread Fork and Handoff

Apiary dispatches `thread.fork` or `thread.handoff` to the **source bee's owning
Honeybee daemon**. Honeybee accepts one durable operation, returns the successor
identity, and owns copying, native compaction, runtime startup, mailbox delivery,
and restart recovery. Apiary presents the operation's authoritative state.

This contract is implemented in schema v25 over protocol `v2/1`. It is additive
except that the older `bee.fork` now rejects instructions, prompts, requested
compaction, unsupported harnesses, and sources without a provider conversation.

- **Fork:** copy a conversation into a new bee and provider session. No instruction,
  requested compaction, or continuation message.
- **Handoff:** fork, compact the successor using the handoff instruction, start its
  runtime, then continue. The instruction goes into native compaction input.
- Both preserve the source bee, provider session, mailbox, and lifecycle. Neither
  archives or stops it. Source output after the pinned boundary is excluded.
- Handoff preserves the source harness, account, and recorded model-provider ID.
  There is no target-provider argument.

The pre-existing `bee.handoff` / capability `bee.handoff.v1` is a **different,
legacy same-bee execution transition** that can switch harnesses. Do not use it
for Apiary thread Handoff. Its contract is [documented separately](handoff-contract.md).

## Discover support

The daemon hello and `deployInfo.capabilities` contain:

```json
["thread.operations.v1", "thread.handoff.codex.hsr.v1"]
```

`thread.capabilities {}` returns:

```json
{
  "operations": ["fork", "handoff"],
  "executors": [
    {"harness": "codex", "substrate": "hsr", "ownership": "local", "instructionCompaction": true}
  ],
  "transcript": "codex.rollout.jsonl"
}
```

This advertises the Honeybee executor. The source must have a locally indexed
Codex rollout with its provider identity and base instructions. Missing native
methods or incompatible history produce explicit refusals or operation failures;
Honeybee never substitutes ordinary prompt delivery for compaction.

**Current scope:** local Codex HSR bees. Claude and other harnesses, tmux, Cells,
and execution across nodes are unsupported. A remote Apiary client may dispatch
to the owning node and read its transcript through RPC; it must not dispatch to a
convenient local node and expect Honeybee to fetch another node's conversation.
No Cell provisioning or dirty-worktree copying is implemented by this executor.

## Dispatch and keep the receipt

Send this request to the owning daemon:

```json
{
  "verb": "thread.handoff",
  "params": {
    "beeId": "SOURCE_BEE_UUID",
    "sourceProviderSessionId": "SOURCE_NATIVE_SESSION_UUID",
    "instruction": "Preserve the migration decision and continue with the restart tests.",
    "idempotencyKey": "apiary-handoff-UNIQUE_REQUEST_ID",
    "name": "Restart tests"
  }
}
```

`beeId`, `sourceProviderSessionId`, `instruction`, and `idempotencyKey` are required.
Use the UUID and provider identity from the latest source snapshot. `name` is
optional. An optional `sourceNode` accepts only `"local"`, relative to the daemon
receiving the request. Instructions must contain non-whitespace text and fit in
65,536 UTF-8 bytes. Unknown arguments are refused.

For Fork, use `thread.fork` with the same identity, key, and optional name, and
**omit `instruction`**. `prompt`, `compact`, `target`, and provider overrides are
not accepted. Do not implement Handoff as separate client-side fork, send, and
wait calls.

Both return `{ "operation": ThreadOperationView, "deduped": boolean }`. The first
receipt is returned before copying, provider startup, or compaction begins.
Acceptance does bounded metadata work: indexed source lookup and at most 1 MiB
at each end of the native rollout to pin complete JSONL records. It does not read
the full conversation or launch a provider on the RPC path.

`ThreadOperationView` has these exact fields:

| Field | Meaning |
|---|---|
| `id` | Durable operation UUID |
| `kind` | `fork` or `handoff` |
| `sourceBeeId`, `sourceProviderSessionId` | Original identities |
| `successorBeeId`, `successorProviderSessionId` | Reserved successor identities, stable across retries |
| `commandId` | Initial queued startup command; its completion alone does not prove operation readiness |
| `continuationMessageId` | Handoff's durable continuation mail; `null` for Fork |
| `phase` | `copying`, `compacting`, `starting`, `ready`, or `failed` |
| `transcriptReady` | Inherited transcript can be read independently of provider readiness |
| `compacted` | Successful native compaction has been committed; stays false for Fork |
| `attempt` | Copy/compaction execution attempts since admission or explicit retry |
| `createdAt`, `updatedAt` | Epoch milliseconds |
| `failure` | `null`, or `{stage, code, detail, retryable}` |

Persist the original arguments and idempotency key before dispatch. If the
connection breaks, replay that exact request. The permanent operation receipt
returns the **same operation and successor**, including its current progress.
Changing the instruction, source, kind, or explicit name with the same key returns
`idempotency_conflict`. A duplicate does not restart a failed operation. Receipts
survive source and successor deletion; a deleted successor is never recreated by
replaying its key.

## Present authoritative progress

`snapshot.threadOperations` contains the operation views. Watch deltas carry:

```json
{
  "kind": "thread_operation.put",
  "beeId": "SUCCESSOR_BEE_UUID",
  "payload": {"operation": "FULL_THREAD_OPERATION_VIEW"}
}
```

Upsert the full view by `operation.id`. Use the ordinary snapshot/sequence rules:
apply only contiguous deltas; obtain a new snapshot on a gap or reconnect. The
public delta excludes private worker process identity, filesystem pins, and the
compaction instruction. The canonical key list is
[`MIRROR_THREAD_OPERATION_KEYS`](../../v2/core/src/mirror.ts).

Normal successful progression:

```text
Fork:     copying → starting → ready
Handoff:  copying → compacting → starting → ready
```

`transcriptReady` becomes true during copying, once the immutable inherited
history is durable. Its change emits `thread_operation.put`, even if the provider
has not started. Do not use timed read retries to discover history availability.
Any nonterminal stage may fail; its failure holds subsequent work.

The successor bee exists immediately and remains reachable. It begins with a
stopped runtime while preparation is pending. **Neither bee creation, a native
session ID, nor a completed startup command means the thread is ready.** Use
`phase === "ready"`; Honeybee reaches that phase only after the copy, required
compaction, and a real provider idle/readiness observation. Continue presenting
normal runtime and condition flags after readiness.

## Send and read

Apiary may call ordinary `send {beeId: successorBeeId, body, urgency?,
idempotencyKey?}` immediately after acceptance. Mail is durable. No successor
message is delivered before `ready`, including `urgency: "now"`. Compaction
failure keeps the queue intact. The Handoff continuation is admitted first with
body `Continue from the compacted conversation.`; the handoff instruction itself
is never sent as mailbox text. After release, ordinary eligibility/FIFO rules
apply. Fork admits no continuation.

When `transcriptReady` is true, call:

```json
{
  "verb": "thread.transcript",
  "params": {"operationId": "OPERATION_UUID", "offset": 0, "limitBytes": 262144}
}
```

Response:

```json
{
  "format": "codex.rollout.jsonl",
  "encoding": "base64",
  "data": "BASE64_BYTES",
  "nextOffset": 262144,
  "eof": false
}
```

`offset` defaults to zero. `limitBytes` defaults to 262,144 and accepts 1 through
1,048,576. Page using `nextOffset` until `eof`. Decode base64 and stream UTF-8 and
JSONL across page boundaries; pages may split a Unicode character or JSON row.
This is the full pinned native rollout, not the HSR notification-stream format.
Render native conversation records, retaining tool/history information as your
normal Codex transcript renderer permits. Do not concatenate arbitrary pages as
individually complete JSON documents.

The inherited history stays immutable. For subsequent successor activity, use
its existing `transcriptSegments` / session-log mechanism and the owning node's
normal transcript transport. The inherited native history and successor HSR
stream are distinct sources. The new reader works over remote RPC and after
client reload, without requiring access to the daemon's filesystem.

`thread.operation.get {operationId}` returns `{operation: ThreadOperationView}`
for reconciliation. A transcript read before readiness returns `thread_not_ready`;
missing/corrupt files return `thread_history_unavailable`.

## Failures and recovery

Admission errors use the existing RPC error envelope:

| Code | Meaning |
|---|---|
| `invalid_request` | Missing/malformed required value or invalid transcript byte window |
| `bee_not_found` | Source not owned by this daemon or already deleted |
| `thread_unsupported` | Unsupported harness/substrate or disallowed argument/semantics |
| `thread_remote_unsupported` | A nonlocal `sourceNode` was supplied |
| `thread_history_unavailable` | Missing index/history, mismatched provider identity, or unusable history metadata |
| `thread_busy` | Source is transitioning, or another mutation would bypass successor preparation |
| `idempotency_conflict` | Key already bound to another operation/request |
| `thread_operation_not_found` | Unknown operation UUID |
| `thread_not_ready` | Transcript has not reached its readiness boundary |

An accepted operation's failure has stage `copying`, `compacting`, or `starting`.
Its closed code set is defined in
[`ThreadFailureCode`](../../v2/core/src/threadOperation.ts):
`history_unavailable`, `history_changed`, `copy_failed`, `compaction_failed`,
`compaction_unsupported`, `worker_unreachable`, `attempts_exhausted`,
`startup_failed`, and `successor_deleted`. Display `detail` for diagnosis; make
control decisions from the typed fields, not string matching.

Recover a settled retryable failure with a **new retry request key**:

```json
{
  "verb": "thread.operation.retry",
  "params": {"operationId": "OPERATION_UUID", "idempotencyKey": "apiary-retry-UNIQUE_REQUEST_ID"}
}
```

Honeybee resumes the failed stage on the same successor. A startup retry retains
successful compaction. A copy retry retains a successfully published immutable
snapshot. Retry returns `{operation}`; a replay adds `deduped: true` and returns
the original retry receipt. Use `thread.operation.get` or the mirror for current
progress. A retry key bound to another operation or verb is refused. Retry
receipts use the existing bounded RPC deduplication retention; the original
Fork/Handoff operation key permanently retains the successor identity. Retrying
a nonretryable failure returns `invalid_request`.

Deleting the successor invalidates transcript readiness and makes the
receipt nonretryable; it removes owned artifacts while retaining deduplication
history. Execution-changing mutations are refused during preparation. Deletion
must wait for settlement and the compactor's exit.
Structured archive actions may be queued, but their commands remain held until
the operation is ready. Forking an unfinished successor is refused.

Daemon restart replays startup commands through the normal queue and resumes
unfinished copy/compaction owners. An interrupted compactor's exact PID/birth
identity must be reconciled before another process touches its session. An
unverifiable live worker causes `worker_unreachable`, rather than concurrent
execution. Automatic copy/compaction recovery has a three-attempt bound; startup
uses the existing per-bee spawn-failure budget. Explicit retry resets the relevant
attempt budget. These failures never change the original bee.

**Native compaction is at-least-once on an uncertain outcome.** A daemon crash
after the provider installs a checkpoint but before Honeybee commits completion
may compact that same successor again. It never allocates another successor or
releases user mail in between. Exact-once model requests/billing are not claimed.
The executor uses a deterministic rekeyed Codex rollout and `thread/resume
{path, threadId}`; it does not rely on repeating native `thread/fork`, which would
allocate a new provider identity after a lost reply.

## Verification and limits

Automated tests cover transactional duplicate keys and conflicts, audit replay,
mailbox gating, failure/retry, restart during compaction and startup, lost copy
receipts, early transcript access and reload, readiness deltas, concurrent source
output, a 22 MB history with byte-perfect pagination, bounded startup failures,
plain Fork, and remote-ownership refusals. Relevant tests:

- [Core operation tests](../../v2/core/tests/thread-operation.test.ts)
- [Execution and history tests](../../v2/daemon/tests/thread-operations.test.ts)
- [Daemon RPC/restart tests](../../v2/daemon/tests/thread-operation-rpc.test.ts)
- [Native Codex test](../../v2/daemon/tests/thread-compactor-native.test.ts)

The native test was run with installed **codex-cli 0.154.0**, a disposable home,
and local scripted model endpoints. It exercises the real local compactor and
both remote compaction implementations, verifies instruction input and native
checkpoint installation, and confirms source preservation. Run it with:

```sh
HIVE_TEST_NATIVE_CODEX=1 node --test v2/daemon/tests/thread-compactor-native.test.ts
```

This does not prove production authentication, model-generated summary quality,
or arbitrary future/older Codex rollout formats. The source must use Codex's
indexed append-only rollout format (`state_5.sqlite`, `session_meta`); replacement
or truncation before copying is refused. There is no full-history size cap; a
native header or unfinished trailing record above the bounded 1 MiB admission
window is refused. Copying and provider operations run outside the RPC hot path.

No Apiary client code or live runtime deployment is part of this change. Apiary
still needs to add these dispatches, materialize `threadOperations`, consume
readiness deltas, and render the inherited native rollout. Existing `bee.fork`
remains a compatibility copy API with deferred native forking; use the new
`thread.fork` for durable pinned-boundary behavior.

CLI equivalents are `hive thread-fork <bee>`, `hive thread-handoff <bee>
--instruction <text>`, and `hive thread-operation get|retry <operation-id>`.
Use `--json` for receipts and `--idempotency-key` to retain caller retry identity.
