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

Apiary must merge and release T29f (`4aa99e5a40a119314741169a75f978712d3d2f41`)
on **every node before any Honeybee emitting `answer` is deployed**. Older
Apiary closed validators reject the new kind and repeatedly resynchronize.
T29e separately removes person-like answer attribution from the DecisionCard.
The deployment hold remains in force.

Operator authorization is deferred. Same-uid local agents can still answer;
I-17 remains an accepted MEDIUM incident. Apiary currently records authenticated
origin per applied answer without introducing a behavior gate. A future
operator-entered forwarding marker is designed separately. Target (a), owned by
Queen with T15r, requires registered apiaryd-only answer/dismiss RPC and routes
the CLI through apiaryd. That future authority check must precede deduplication.
Withdrawal registration and session principals alone do not prove human entry.

`question.dismiss` is outside this change. Its future daemon-owned
`dismissedBy` must follow the same attribution rule, never caller parameters.
