# Question answer attribution

Fresh `question.answer { questionId, answer, idempotencyKey? }` effects record
`answeredBy: "rpc"`. The daemon ignores the legacy `answeredBy` request field,
including malformed values. Current socket connections do not establish an
apiaryd, CLI or human operator role. Actor strings never grant authority.

The question row, `question.answered` event and answer mail sender carry the same
attribution. Internal automatic answers default to `rpc`. Historical rows,
events and idempotency receipts retain their original labels; replay does not
relabel an answer or send more mail. `hive answer --by` remains a local display
label, omitted from RPC. CLI question rows say `answered` without a person label.

Question-bound deliveries use `TurnTriggerSource.kind: "answer"`, identified
through the stored question delivery message ID, including recovered fallback
receipts and observed turn openers. `from` and all other `TurnTrigger` fields
keep their existing shape. `humanAt`, `lastHumanOutputAt`, attention and
extractive handoff prompt selection retain their previous bookkeeping behavior.
The answer envelope and body format are unchanged. Neither `answer` nor these
timestamps constitute proof of human approval, permission or identity.

Answer trigger emission is negotiated once per RPC connection by the client hello:
`{ protocol: "v2/1", capabilities: ["turn-trigger.answer.v1"] }`. The owner hello
advertises the same capability. Missing or unknown tags retain legacy format.
Stored capabilities accept at most 64 nonempty strings of at most 128 characters.
Malformed or oversized advertisements select legacy format and produce one
bounded diagnostic, without disconnecting the client.
They select output format only and never enter RpcCaller, authority, admission,
or identity decisions. Request parameters cannot opt in or renegotiate.

Canonical store rows, audit events and replay retain `answer`. An opted-in
connection receives it unchanged; legacy connections receive an immutable
copy with only `answer` changed to `human`. The projector covers snapshot,
watch initial state/deltas, view/list/children, mutation bee replies and audit
reads. Sequence numbers, gaps, all trigger fields and output timestamps are
preserved. Shared event batches and canonical objects are never mutated.
An executable TypeScript census checks every exported protocol type, inferred
trigger-bearing dispatch return and audit call payload against the projector
routes; adding an uncovered result, path or audit fails the check.

Only readers that advertise the capability need the paired Apiary validator.
An older Mac Apiary with no advertisement keeps the legacy format. Apiary's
node-to-node replication already drops an unrecognized trigger at
hiveMirrorSession.ts:68, so old Studio pulling from newer satellite apiaryd
may degrade to no trigger, which is acceptable. There is no every-node
upgrade ordering requirement. T29e separately removes person-like answer
attribution from the DecisionCard. The deployment hold remains in force.

Operator authorization is deferred. Same-uid local agents can still answer;
I-17 remains an accepted MEDIUM incident. Apiary currently records authenticated
origin per applied answer without introducing a behavior gate. A future
operator-entered forwarding marker is designed separately. Target (a), owned by
Queen with T15r, requires registered apiaryd-only answer/dismiss RPC and routes
the CLI through apiaryd. That future authority check must precede deduplication.
Withdrawal registration and session principals alone do not prove human entry.

`question.dismiss` is outside this change. Its future daemon-owned
`dismissedBy` must follow the same attribution rule, never caller parameters.
