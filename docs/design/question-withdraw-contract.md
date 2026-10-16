# Question withdrawal (v1)

An asking bee can withdraw an unanswered question with a reason. The owner
serializes withdrawal and answering in SQLite: the first committed terminal
transition wins. A withdrawn question cannot generate answer mail.

## Capability and request

Gate on `question.withdraw.v1` in the **live hello or deployInfo**, never on
an imported constant or a guessed verb. Honeybee advertises it only when
`rpcLocalTrust.requireObservationCaller` is true, its private registration key
is ready, and the native peer-credential bridge is ready. Registration need
not already exist when the hello is sent. Clients return typed
`question_withdraw_unsupported` ("Question withdrawal is unsupported by this
Honeybee.") when the capability is absent; Honeybee's RPC client enforces this.
The server also refuses the verb with that code when the prerequisites are absent.
The protocol remains `v2/1` and the store stamp remains **44**, preserving
apiary-swap storage support and the older writer's version gate. At open,
`CREATE TABLE IF NOT EXISTS` adds the isolated receipt table; older binaries
ignore this extra table. The questions table is rebuilt transactionally when its DDL
lacks the withdrawn status, preserving existing open/answered rows. No schema
version bump or store restore is required for rollback.

```json
{
  "id": 42,
  "verb": "question.withdraw",
  "context": { "sessionPrincipal": { "beeId": "durable-asking-bee-id" } },
  "params": {
    "questionId": "question-id",
    "reason": "The newer decision supersedes this question.",
    "idempotencyKey": "caller-chosen-key"
  }
}
```

All three params are required. Reason is trimmed, nonempty and at most 500
JavaScript string code units after trimming. Identity params such as `beeId`
and `callerBeeId` are rejected. Result: `{question: QuestionRow}` with the usual
optional `deduped: true` marker for same-key replay.

## Authenticated caller boundary

The assertion in `context` is service metadata, never a tool argument. The
owning apiaryd derives `sessionPrincipal.beeId` from its authenticated gateway
session and forwards it to its **direct local** Honeybee socket. If gateway
traffic arrived over another node, apiaryd must validate that authenticated peer's
right to forward that session principal before asserting it. Honeybee accepts
this assertion only from its registered local process. `remote` and `node_relay`
Honeybee connections are refused even if their process is registered. A hello
caller, environment variable, same uid alone, and ordinary params confer no bee
identity. RPC creates a request-scoped `RpcConn.authenticatedBeeId` only after
validating the registered connection. The daemon authorizes that identity against
the stored question before any successful receipt lookup. Ownership uses durable
bee identity and survives runtime generation changes and daemon restarts.

This is a registered service assertion boundary: trusted apiaryd is responsible
for binding the assertion to the authenticated session. A same-uid process able
to read the registration key is inside that trust boundary. There is no new
self-service CLI identity authentication in this contract.

### Registration prerequisites and handshake

Ship config, the private key provisioning and peercred artifact through the
reviewed release/updater rollout; do not hand-enable production nodes. The
following configuration is used only in disposable labs until that rollout:

```json
{
  "rpcLocalTrust": {
    "requireObservationCaller": true,
    "registrationKeyFile": "/absolute/data-dir/rpc-private/registration.key"
  }
}
```

The key must be inside the data directory. The existing trust implementation
creates a 32-byte private key with mode 0600 and requires its private directory
chain to have mode 0700, owned by the daemon uid, without symlinks. A valid native
peercred artifact must be installed for the node. Do not log the key or token.

1. On the direct-local service socket call `rpc.localTrust.challenge {}`.
2. Receive `{challengeId, nonce, uid, pid, processBirth, daemonInstanceId,
   expiresAtMs}`. Validate that `pid` is apiaryd's process id.
3. Compute `HMAC-SHA256(key, JSON.stringify(["hive-local-trust-v1", challengeId,
   nonce, uid, pid, processBirth, daemonInstanceId, expiresAtMs])).digest("hex")`.
4. On the **same socket** call `rpc.localTrust.register {pid, challengeId, token}`.
   The receipt is `{registered: true, uid, pid, expiresAtMs}`.

Challenges expire in 60 seconds and are single-use and socket-bound. Registration
is process-wide and binds uid, pid and process birth for 300 seconds. Each guarded
request checks current peer identity and expiry. Other direct-local sockets from
the same registered process are covered. Renewal immediately replaces the expiry;
there is no lease overlap. Disconnect removes outstanding challenges, but does
not clear registration. A dead process can no longer pass the live-peer check;
its slot is not proactively released. Daemon restart clears registration.

The existing register verb **unconditionally replaces** any prior process
registration and audits `replacedPid`. It has no live-owner conflict refusal,
release verb or fencing lease. Apiary must coordinate its own processes (the
T15a design uses an exclusively held target-scoped file lock before registering
or renewing). A same-uid key holder's deliberate replacement remains outside
that coordination guarantee. Registration refusals use `caller_not_trusted`
with a structured `details.reason`; no trust semantics are changed by withdrawal.

## State, idempotency and refusal codes

`QuestionRow.status` is `open | answered | withdrawn`.
`withdrawalReason: string | null` and `withdrawnAt: number | null` travel on
question.list and snapshots; time is owner-assigned epoch milliseconds.
Open and answered rows have null withdrawal fields. Withdrawn rows retain their
text, options, asker, generation and asked time; their answer, answeredAt,
answeredBy and deliveryMessageId remain null. Missing withdrawal fields on old
rows normalize to null. Old rows/events with no status infer today's open or
answered state from answeredAt.

Only open → withdrawn is permitted. An owner retry, including a new key and a
different valid reason, returns the original withdrawn row and preserves the
first reason/time. It emits no additional withdrawal event or mail. Keys are
scoped by `(caller bee, idempotencyKey)` in a dedicated `question_withdraw_receipts`
table, structurally separate from caller-controlled generic RPC keys; reusing that pair for a
different question returns `idempotency_conflict`. Failed calls record no receipt.
Authorization precedes receipt lookup, including on successful replay.

| Code | Refusal |
| --- | --- |
| `question_withdraw_unsupported` | Capability/prerequisites absent. |
| `caller_not_trusted` | Unregistered/expired caller, missing session principal or nonlocal ingress. |
| `question_not_found` | The question does not exist. |
| `question_not_owner` | The authenticated bee did not ask the question, including retries. |
| `question_already_answered` | An answer committed before withdrawal. |
| `question_withdrawn` | An answer loses to withdrawal; message is `This question was withdrawn: <reason>` and `details.withdrawalReason` carries the reason. |
| `invalid_request` | Invalid params, reason or missing/invalid key; existing repeated-answer refusal remains unchanged. |
| `idempotency_conflict` | The caller's withdrawal key was already used for another question. |

Answer and withdrawal run in the same IMMEDIATE transaction discipline with
`WHERE status = 'open'` guards. Answer secures its state transition before
inserting mail; any mail failure rolls back the transition. Withdrawal creates
no mail, runtime wake, or answer event.

## Event and vendoring

The committing transaction appends a sequenced audit event:

```json
{
  "kind": "question.withdrawn",
  "beeId": "durable-asking-bee-id",
  "payload": {
    "questionId": "question-id",
    "withdrawalReason": "The newer decision supersedes this question.",
    "withdrawnAt": 1792141200000
  }
}
```

The ordinary audit envelope supplies seq and ts. Existing RPC audit attribution
may also add `payload.rpcCaller`; consumers project the three declared fields.
Replay and reconnect preserve the terminal row. Apiary should vendor byte-identical
`v2/core/src/types.ts`, `mirror.ts` and `v2/daemon/src/protocol.ts` at the reviewed
upstream commit, and pin the matching built runtime. Exports include
`QuestionWithdrawParams`, `QuestionWithdrawResult`, `RpcRequestContext`,
`QuestionWithdrawnEvent`, the status/row types, and the mirror kind/key inventories.

Withdrawal by a successor orchestrator and automatic withdrawal on archive are
out of scope. Withdrawal does not complete a waiting action or invent an answer.

## Verification

After `npm ci` and `npm run build`, run on a satellite:

```sh
env -i HOME="$HOME" PATH="$PATH" node scripts/proof/question-withdraw.ts .proof/T15h-honeybee-withdraw
```

The script starts only disposable foreground daemons under `~/.cache`, with
explicit data/socket paths and private account paths. Its scrubbed child environment
sets HIVE_NODE_PATH to the managed versioned Node executable running the lab,
satisfying current main's native-Node identity check. It uses mailbox-only bees,
no units/services or real harnesses. It retains receipts, snapshot/mailbox rows,
audit and reconnect evidence. Both answer/withdraw requests are submitted before
either response; alternating their frame order proves each first-commit winner.
Every daemon shutdown must exit with code 0 and no signal before the lab can
report success. No daemon remains after the script. No live store is opened.

Older Honeybee CLIs display an unfamiliar withdrawn status as “answered”. This
change updates the current CLI; withdrawal is available only to capability-gated
new clients. Older external projectors must be upgraded before enabling the feature.

For the schema-44 rollback check, run:

```sh
env -i HOME="$HOME" PATH="$PATH" node scripts/proof/question-withdraw-schema44.ts
```

It builds the older committed core from this repository's Git objects, without
using another checkout, then exercises old writer → withdrawal writer → old
writer → withdrawal writer on one disposable cache store. The older writer
opens and writes while the isolated receipt table exists; stamp 44, SQLite
integrity, foreign keys and the original withdrawal receipt must all survive.
