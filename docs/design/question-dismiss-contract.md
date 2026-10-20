# Question dismissal (v1)

An operator can dismiss a question without supplying an answer. Apiary owns the
asking-workspace operator policy (decision a65bcd28) at its T29g admission flip.
Honeybee accepts this operation under the same local RPC policy as question.answer.
It records observed ingress as `rpc`; this is not proof of a person. Same-uid local
clients retain the existing ability to invoke question mutations. No T29g marker,
withdraw sessionPrincipal, phone credential or hello capability grants operator
identity in Honeybee. Stronger owner admission remains target-(a)/T15r work.

## Request and result

The actual owner's live hello/deployInfo advertises `question.dismiss.v1`.
Clients refuse with `question_dismiss_unsupported` when it is absent, with message
`Question dismissal is unsupported by this Honeybee.` No fallback mutation occurs.

`question.dismiss {questionId, idempotencyKey}` requires both nonempty strings and
rejects every extra param, including actor, workspace, reason and answer fields.
It returns `{question: QuestionRow}` plus optional `deduped: true` on same-key
replay. The owner assigns the time, actor and original notice binding.

The canonical status vocabulary is `open | answered | withdrawn | dismissed`.
Dismissed rows have `dismissedAt` (epoch milliseconds), `dismissedBy: "rpc"`, and
`dismissalMessageId`. They retain the original question and asker. All answer and
withdrawal fields remain null. Other statuses have null dismissal fields. Old
rows/events missing those fields normalize to null.

## Transaction, retries and refusals

The serialized owner transaction secures `WHERE status = 'open'` before inserting
a notice. Row, mailbox insertion, wake/unarchive intent, event and receipt commit
together; any failure rolls everything back. The first answer/withdraw/dismiss
terminal commit wins. A dismissed question never generates answer mail or reopens.
Dismissal does not answer or complete a waiting action or release its downstream
lane. Normal action reconciliation remains separate.

Receipts live in `question_dismiss_receipts`, outside the generic RPC key namespace.
The current authority scope is this owner's ordinary RPC scope, with no invented
operator identity. Generic RPC peer/admission checks run before daemon dispatch and
therefore before receipt lookup. Unauthorized calls cannot replay a receipt or
poison its key. Same-key reuse for another question is `idempotency_conflict`.
A new valid key for an already-dismissed row returns the first row/time/notice and
emits no event/mail. Receipt eviction cannot mint another notice. Successful
replay does not bypass Apiary's current operator admission at its own cache layers.

| Code | Meaning |
| --- | --- |
| `question_dismiss_unsupported` | Owner capability absent. |
| `invalid_request` | Missing/invalid params or key, or any extra param. |
| `question_not_found` | Question absent. |
| `question_already_answered` | Answer committed before dismissal. |
| `question_withdrawn` | Withdrawal committed first; existing message and `details.withdrawalReason` carry its reason. |
| `question_dismissed` | Answer or withdrawal loses to dismissal; `This question was dismissed without an answer.` |
| `idempotency_conflict` | Dismissal key already belongs to another question. |

There is no new Honeybee `dismiss_not_authorized` operator gate in this version.
Existing RPC peer/credential refusal codes apply exactly as for question.answer.

## Event and notice

The committing sequenced audit event is:

```json
{
  "kind": "question.dismissed",
  "beeId": "asking-bee-id",
  "payload": {
    "questionId": "question-id",
    "dismissedAt": 1792470000000,
    "dismissedBy": "rpc",
    "dismissalMessageId": 7
  }
}
```

The normal envelope adds seq/ts and optional existing rpcCaller attribution.
Canonical audit replay and snapshots reproduce the same row.

The one durable mailbox body is exactly:

`Your question was dismissed without an answer.`

Delivery uses `[Hive notice that your question was dismissed]`, then one JSON
metadata line `{version:1,kind:"question.dismissed",questionId,from:"rpc",id,sentAt}`,
a blank line and that body. It never uses the answer envelope or claims human
identity. The durable dismissalMessageId selects this envelope, including file
fallback/pointers, rather than sender or body heuristics. The notice has automation
sender kind, ordinary next urgency and the existing other turn trigger. It does
not stamp human bookkeeping. Standard mailbox wake/unarchive/recovery applies to
stopped and archived askers. Existing answer envelope bytes remain unchanged.

## Per-reader compatibility

Client hello capability **`question.dismissed.v1`** opts into the new status/event
format, independently per connection. It is format only: no admission, identity
or authority decision reads it. Absence, unknown tags and malformed advertisements
retain the bounded tolerant hello behavior introduced by T29c.

For a nonadvertising connection, immutable egress copies remove the three new
row fields. A dismissed row becomes `status: "withdrawn"`, with
`withdrawalReason: "Dismissed without an answer"` and `withdrawnAt: dismissedAt`.
A question.dismissed audit event becomes the existing question.withdrawn payload
`{questionId, withdrawalReason, withdrawnAt}` with that exact reason/time.
Seq/ts/beeId and existing rpcCaller metadata are preserved. Other question states
retain their meaning. The canonical store/audit/replay never downgrades.

This applies to every question-bearing mutation/result (including action.report),
question.list, snapshot/watch, audit.tail, live/replayed deltas and known nested
receipts. An executable TypeScript census checks exported protocol types,
inferred dispatch returns and actual typed audit payloads against the projector's
coverage map. Injected uncovered row/result/event paths fail. Arbitrary action
outputs and user JSON are not recursively rewritten, and shared cursor objects
are never mutated. The separate turn-trigger.answer.v1 projector stays independent.

Apiary advertises question.dismissed.v1 only once its reviewed DTO/validator/fold
accepts dismissed and the exact merged owner artifact is vendored. Older direct Honeybee
readers retain withdrawn format without an every-node upgrade ordering. Apiary
node-to-node/phone projection after a newer Apiary stores canonical dismissed is
NOT_COVERED by the owner lab; the paired Apiary backend must handle those peers
before it advertises question.dismissed.v1 upstream or exposes the feature. Older local CLIs
may label an unfamiliar canonical dismissed row as answered; the current CLI
renders dismissed. No unmerged vendor/runtime pin ships.

## Schema and verification

The stamp stays **44**, preserving apiary-swap's exact version requirement. Existing
9ecbb37f questions have a status CHECK, so the migration transaction rebuilds that
table and restores indices while preserving open/answered/withdrawn rows. A schema
without a status CHECK adds the nullable fields without a rebuild. Dedicated
receipt storage is CREATE TABLE IF NOT EXISTS. The rollback lab proves old9ecbb37f
writer → new writer → old9ecbb37f writer → new writer, with the dismissed row, receipt,
one notice, integrity and foreign keys preserved. Older writers refuse terminal
mutation; no answer/reopen appears. This is not a claim that every older binary
can replay the new canonical event.

Run in a scrubbed disposable satellite lab with fake HOME/XDG/TMPDIR under cache:

- `node --test scripts/proof/question-dismiss.test.ts`: actual daemon, controlled
  pair/triple race orders, both reader formats, one notice/no answer mail,
  real stub envelope, stopped/archived delivery, clean shutdown, replay/reconnect.
- `node --test scripts/proof/question-dismiss-schema44.test.ts`: committed baseline
  Git-source loading and pre-dismissal feature assertion, rollback writer and
  receipt/notice/integrity checks.
- Core dismissal/action tests and daemon census/projection/security tests cover
  insertion rollback, isolated keys, generic authorization-before-dispatch,
  immutable format conversion and dedicated pointer formatting.

The full #52 masked gate runs through the approved Quiet/662 lane, check and
v2:check then build third, focused cases and applicable suites. Queen reviews the
wire/projector/schema delta before PR. Needle merges only pinned green CI.
**DEPLOY HOLD remains; this contract does not authorize a deployment or Apiary
operator-policy enforcement flip.**
