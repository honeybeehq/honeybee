# Explicit human output v1

Honeybee owns tells, reactions and acknowledgement facts. Apiary mirrors these
facts and owns the workspace setting, Champion opt-in, authenticated MCP caller
binding, provider root-thread admission and date-aware transcript rendering.
Bee lineage is provenance; parentId is not evidence of provider root-thread
origin. A provider subagent sharing a bee identity cannot be distinguished by
Honeybee. Apiary must enforce that boundary before forwarding the request.

## Wire and admission

The v2/1 wire stays additive, advertising bee.tell.v1, bee.react.v1 and
bee.human_output_mode.v1 only when LocalRpcTrust and native peer credentials are
ready. These tags describe support, not caller authority.

- bee.tell {beeId,text,replyTo?,idempotencyKey} returns {tell,deduped?}.
- bee.react {beeId,messageId,emoji,idempotencyKey} returns {reaction,deduped?}.
- bee.setHumanOutputMode {beeId,mode,idempotencyKey} returns
  {beeId,humanOutputMode,humanAcknowledgementTrackingSince,
  lastHumanAcknowledgementAt,unansweredHumanMessage,deduped?}.

All mutations require the registered local service on local Unix ingress.
Tell/react additionally require context.sessionPrincipal = {beeId}, matching the
request. Only that service's management path, with no sessionPrincipal, may set
mode. Modes are legacy (default) and explicit; opt-out to legacy is legal.
A session cannot enable its own mode. Extra request parameters are refused.
LocalRpcTrust authenticates the existing service process registration; this does
not add a new operator or Champion identity mechanism.

Text is nonempty UTF-8 without NUL, at most 16 KiB by bytes. Emoji is exactly one
extended grapheme recognized as RGI_Emoji by the runtime's Unicode tables;
standalone emoji components are refused. Keys are nonempty UTF-8 without NUL,
at most 256 bytes. Targets are positive safe-integer Honeybee mailbox message
IDs, the same IDs carried in delivery metadata. Targets must have a recorded
human, answer or phone delivery to this bee. Peer and automation deliveries,
unknown IDs, other bees' messages and undelivered messages are refused.
There is no wire rate limit.

Stable refusals are human_output_mode_legacy, human_output_target_invalid,
tell_text_invalid, react_emoji_invalid, idempotency_conflict, invalid_request,
caller_not_trusted, capability_missing and bee_not_found.

## Immutable rows and idempotency

BeeTellRow and BeeReactionRow carry owner-assigned id, beeId, generation,
turnTrigger (an immutable snapshot or null), at and idempotencyKey. Tell adds
text, nullable replyTo, acknowledgedMessageIds, acknowledgedOverflow and nullable
acknowledgedDeliveryRange. Reaction adds messageId and emoji. A trigger from a
previous generation is never attributed to the current generation.

Dedicated uniqueness is (beeId, verb, key), outside generic RPC receipt keys.
Same normalized request returns the original row with deduped=true, across
restarts, new generations and opt-out. Different content conflicts. Caller
admission precedes receipt access. Failed transactions leave no receipt.
Mode receipts also retain their original outcome: replaying an earlier enable
never undoes a later disable. New keys setting the same mode are quiet.
Bee deletion removes its owned rows, delivery facts and receipts.

## Owner facts and acknowledgement

Explicit mode suppresses transcript-based updates of lastHumanOutputAt.
A tell advances that timestamp atomically with its immutable row,
acknowledgements, receipt and bee.told audit event. A reaction does not advance
lastHumanOutputAt. Both advance lastHumanAcknowledgementAt; lastOutputAt remains
raw harness evidence. Neither mutation completes an action or changes lifecycle.

Tracking starts when the service first sets a mode. No speculative historical
backfill occurs; humanAcknowledgementTrackingSince marks that boundary. Apiary
must set mode before delivering the new opted-in Champion prompt. Every later
human delivery has an immutable fact and delivery audit sequence, including
multiple human deliveries in one turn. question.answer counts with
triggerKind=answer; ordinary human and phone deliveries use triggerKind=human.
Phone facts retain the full existing unverified envelope. Acknowledgement never
changes that envelope or verifies human approval.

A plain tell acknowledges every preceding pending human delivery across turns.
A tell with replyTo acknowledges pending deliveries through that target's
sequence. A reaction acknowledges only its target delivery. Ordering uses
committed delivery sequence, not wall-clock comparison, including when timestamps
are equal. unansweredHumanMessage is the oldest remaining pending fact,
{messageId,generation,humanAt,triggerKind,phoneOrigin?}, or null. New turns,
completion, quiet markers and raw transcript output do not clear it.

The tell's acknowledgedMessageIds lists the first 64 newly cleared mailbox IDs
in delivery order; acknowledgedOverflow counts the rest. The exact owner-side
range is (afterSeq,throughSeq], restricted to this bee's human deliveries that
were pending immediately before this tell. Immutable acknowledgement bindings
identify the first output that cleared each delivery, so prior reactions within
the interval are not relabelled. A tell clearing nothing has a null range.

## Mirror and compatibility

Bee rows and views carry HumanOutputFacts with nullable/defaulted fields.
Snapshots add optional tells/reactions collections, defaulting to empty on old
snapshots. bee.told carries {tell,lastHumanOutputAt,...HumanOutputFacts};
bee.reacted carries {reaction,...HumanOutputFacts};
bee.human_output_mode_changed carries {beeId,...HumanOutputFacts}.
Human mail.delivered events include the refreshed facts in the same transaction.
The usual envelope supplies sequence, time and existing RPC audit attribution.
Answer-trigger compatibility projection also covers new rows and snapshots.

Apiary uses owner facts; it must not infer acknowledgements from transcripts.
Only upgraded Apiary enables explicit mode. An older mirror encountering a new
kind resyncs to the owner snapshot, preserving sequence safety. It may resync
again for future unknown events; no event sequence is dropped or rewritten as
output. Opt-out is audited too, so a mirror cannot remain incorrectly explicit.

Storage is schema 48. A schema-47 writer ignores explicit mode and could stamp
transcript output as human output, so the version barrier is deliberate. Older
writers refuse with schema_newer. The Apiary-swap exact storage guard is 48.
Before deployment, take a store backup. The held packet migrates 46→47→48 in
one gated step; it does not deploy intermediate 47. DEPLOY HOLD remains.

## Verification

Focused local tests cover byte/grapheme validation, exact delivery ordering,
target restrictions, question answers, phone assurance, bounded markers,
generation provenance, idempotency, opt-out, deletion and injected audit rollback.
The real disposable daemon test exercises trusted RPCs, snapshots and clean
restart/reconnect. The read-only CLI reads the same owner facts.

scripts/proof/human-output-schema48.test.ts uses pinned local Git objects for
actual 46 and 47 writers, backs up their disposable stores, exercises 46→47→48,
checks both older-writer refusals without logical mutation, then verifies forward
receipt recovery and integrity. It requires those Git objects and installed
local dependencies; it makes no network request. It is a storage lab, not a
claim that the separate Apiary swap coordinator has run. Full exact-head suite,
masked gate, paired coordinator packet and Queen review remain required before
merge/deploy under the Project's authorization rules.
