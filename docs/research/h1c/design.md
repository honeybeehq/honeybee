# H1c — delivery ACK reconciliation

Implementation branch: `review/sar-H1b2-ack-reconcile`, rebased on merged Honeybee main `8d71abd2` (H1a and H1b). Production bee84ab31f1 remains untouched. Its pending-ACK versus socket-latch cause is still unproven.

## Wire and proof boundary

Runner status advertises `delivery_status.v1`. A mail write is:
```ts
{op:"write", line:string, delivery:{id:number,digest:string,beeId:string,generation:number}}
```
The SHA-256 digest binds the exact encoded line. Untagged protocol control writes retain their existing format. Query:
```ts
{op:"delivery_status", delivery:{id:number,digest:string,beeId:string,generation:number}}
```
Reply is exactly `{id,digest,state}`, where state is `not_written|written|accepted|refused|unknown`. There is no response message text, request text, host identity, or arbitrary cross-bee lookup. The driver authenticates the exact host PID/birth/boot identity with native peer credentials, reads the capability only for that bee/generation, and never sends an unknown frame to an old host. A torn/unreadable status is unknown capability, not evidence of an old host; it is re-read after recovery. The runner rejects wrong bee/generation/digest bindings.

The host records the mailbox ID, digest, application request ID, and written state BEFORE stdin. Matching JSON-RPC result/error updates accepted/refused BEFORE the observation-journal append. Duplicate tagged writes never write stdin again. Host receipts use at most4096 entries and24h monotonic age. Eviction advances a conservative retired-through mailbox-ID watermark. Forgotten IDs, and absent lower IDs, are unknown, never not-written. Out-of-order urgency can therefore conservatively hold an older item. A host death loses receipts; a different process identity never proves the original delivery absent.

Frames are bounded to16Mi decoded characters; malformed or oversized frames close the lane. This is an explicit wire limit, not an ENOSPC simulation. The runner socket is created with umask077 and mode0600. Same-UID remains the host/admin trust boundary.

## Durable intent, upgrade and recovery

Schema47 adds delivery-confirmation intents and durable operator decision receipts. A known intent stores exact wire bytes, digest, host identity, attempted generation and since, and commits before the effect. Unknown pre-upgrade attempts have correlated null wireLine/digest/host; no bytes or identity are fabricated. A failed intent transaction authorizes no write. A failed settlement transaction leaves the intent recoverable. Turn end, idle, or silence never marks a pending ACK delivered.

The schema47 migration records a once-only legacy mailbox-ID watermark and per-bee maximum-generation cohort. Both are captured only after SQLite's EXCLUSIVE writer lock is acquired, so a new opener cannot snapshot while the old daemon still writes. The upgrade-lock lab proves this handover fence. Only pre-watermark pending mail on an adopted confirmation-requiring host in that original generation cohort is potentially ambiguous without an intent; it becomes visibly held with unknown private binding. Mail accepted after this boundary has no prior in-flight write when its intent is absent, so a fresh durable intent permits one safe legacy write on an authenticated old host. Its positive normal ACK can settle it. The known legacy write remains awaiting_confirmation/pending_ack until ACK or the normal30s timeout, without a transient held state or operator resend opportunity. Post-upgrade generations and IDs already released by positive not-written proof are excluded from later boot holds. A lost ACK stays held without probing the old host. This prevents a deploy from deafening surviving Codex/Muse bees.

Known intents reconcile by the same host and generation. Accepted proof atomically settles delivery. A positive not-written proof permits an audited re-plan to current turn context, resetting the row to awaiting_confirmation before any new write; stale operator actions then fail the held-state check. If that runtime is degraded, the proven-unwritten binding is released and normal stop/revive recovery can deliver automatically. Unknown/null bindings never re-arm, query or write. They do consume positive-only ACK evidence from the same identified live bee/generation, including adopt-time journal replay and an ACK arriving after adoption; that proof atomically settles the original. Refused or absent evidence stays visibly held. A pending ACK past30s becomes held/unknown and remains visibly undelivered. A late positive ACK may still settle it. Application refusal is surfaced as held/refused; it is not silently retried with a second stdin write.

Held head mail holds later mail in FIFO until reconciliation or an explicit operator decision. waitingForYou derives from held facts; no condition flag or competing lifecycle truth is added. Degraded-stop suppression is scoped to intents in the current generation.

## Frozen Apiary RPC contract

Ordinary Honeybee mutate RPCs:
```ts
"mail.delivery.resend_anyway" | "mail.delivery.drop"
{beeId:string,messageId:number,generation:number,idempotencyKey:string}
```
Generation fences the CURRENT runtime/BeeView generation at the operator decision; the confirmation generation remains the original attempted generation. Unknown params and caller-supplied text, role, digest, or state are refused.

Result:
```ts
{
 action:"resend_anyway"|"drop";
 beeId:string;
 messageId:number;
 generation:number;
 replacementMessageId:number|null;
 deduped?:true;
}
```
Only a currently held, owned, undelivered message is actionable. Errors: `stale_generation`, `delivery_not_held`, `idempotency_conflict`, `bee_not_found`, `invalid_request`, plus existing local-peer failures. Recognized idempotent replays return the original receipt, including after restart; alias keys for an already-completed same action return that same effect.

Resend creates a NEW mailbox ID at the ORIGINAL FIFO position, rather than cancelling the original through failure hooks or appending at the tail. It carries action-dispatch/attempt, handoff-seed, question-answer/dismiss, continuation and other owner links to the replacement. It preserves body/sender/urgency/origin/untrusted phone provenance. Quota/auth recovery reuses this replacement rather than cloning it again. The audit links original and replacement; late ACKs for the original request ID cannot confirm the new ID. Drop cancels the held row with its ordinary owner semantics. Both are audited.

Additive public MessageRow/history/pending fields:
```ts
deliveryConfirmation?: {
 code:"delivery_confirmation_pending";
 messageId:number;
 generation:number;
 since:number;
 state:"awaiting_confirmation"|"held";
 reason:"pending_ack"|"old_host"|"receipt_expired"|"unknown"|"generation_changed"|"refused";
 delivered:false;
};
queueOrder?:number;
replacesMessageId?:number;
```
queueOrder is the original mailbox FIFO ID, preserved through replacement chains; consumers sort by queueOrder??id. Mail history additionally has lifecycle `{state:"replaced",replacedAt:number,replacementMessageId:number}`. BeeView optionally exposes ordered `deliveryConfirmations`, absent when empty. CLI view displays current and attempted generations; mailbox shows the typed undelivered hold. Public types live in dependency-free `deliveryConfirmationTypes.ts`; SQLite helpers are separate.

Snapshot/view/mail projections contain no private wire/digest/host. Internal audit retains recovery bytes for replay; daemon audit.tail/watch and stale CLI events strip those private fields from confirmation audit rows. Bee deletion removes its owned confirmation intents and decision receipts.

## Human authority

Queen's final ruling8324 selected Honeybee's existing verified same-UID admin boundary, with NO new Honeybee operator validator or role boolean. A same-UID process can invoke these RPCs directly, like existing send/kill authority, until T13/host isolation tightens it. Apiary H1d separately exposes ONLY desktop main-frame actions through apiaryd, gated fail-closed by T29g. No MCP/phone/gateway action is added here, and no CLI mutation verb is added.

Apiary references supplied by Needle (not inspected in this Cell): main20095d53 `services/apiaryd/src/nodes/operatorEntry.ts`, `domains/hive/answerAudit.ts`, desktop main IPC. Honeybee's existing question.dismiss validates params/idempotency, not an operator-entry marker. The Honeybee proof claims the RPC/backend, not the separate Apiary UI.

## Lab and review

Owned clean-env/fake-HOME/short-/var/tmp fixtures only; no real accounts, real disk filling, live stores, production restart, or deployment.
- `scripts/lab-h1c-store-confirmations.mjs`: transaction/reopen/migration/replay/provenance/decision receipts and owner links.
- `scripts/lab/h1c-crash-windows.mjs`: actual CoreStore, DaemonCore, HSR driver and runner; exactly one original stdin write across before-intent commit, intent-before-write, write-before-ACK, ACK-before-settlement commit, after-settlement, and unknown-held restart.
- `scripts/lab/h1c-host-receipts.mjs`: mid-turn target request, real turn end, fault-injected observation ENOSPC, detach/adopt, positive receipt recovery; lost ACK stays pending with one write despite duplicate tagged frames; bounded retention/fences.
- `scripts/lab/h1c-upgrade.mjs`: old-host capability omission, pre-upgrade uncertainty, safe fresh mail after deploy,500ms delayed-ACK with no hold flicker, explicit audited escape. `--late-ack` releases an original ACK only after adoption and verifies positive-only settlement with one stdin write and no operator action.
- `scripts/lab/h1c-upgrade-lock.mjs`: exclusive-lock handover blocks premature watermark capture; successor captures the old writer's later mailbox ID and quick_check reports ok.
- `scripts/lab/h1c-operator-rpc.mjs`: actual disposable daemon RPC authority/error/idempotency/projection checks. `--serve` prints owned socket/dataDir/bee/current generation/message IDs and leaves held rows for H1d's UI; terminate the fixture PID you started to close its owned daemon.
No new unit tests/comments per the explicit Project brief. Existing schema fixture assertions advance to47. Gates, lab receipts and independent review findings belong in the final proof; no premature green claim.

## Verification and rollout limits

Both independent Opus source reviews at93ba3554 report no Medium-or-higher findings; reviewers did not rerun the labs. The urgency.d3c existing fixture expectation changes deliberately: positive ACK settles delivery in the same step a later now-mail interrupts, while interrupt count stays one. Acknowledged truth is no longer delayed behind FIFO retry scheduling.

Before any separately authorized production rollout, the operator should read the pre-upgrade undelivered count: ambiguous old-cohort rows will be visibly held, potentially requiring operator action. No production count or actual stuck-state diagnosis is claimed here. Production has not run intermediate H1c builds, so their cohort initialization timing applies only to labs/dev. No deploy or restart is authorized by this document. The missing repository verification skill remains a setup gap. No UI preview is claimed for this backend change; H1d owns the separate Apiary surface.

