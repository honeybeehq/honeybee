# T29c — honest Honeybee answer attribution now; role gate deferred

Status: Queen approved the narrowed design through the orchestrator, including the distinct answer trigger ruling. Implementation is in progress on review/t29c-answer-attribution; no gate, PR or deployment has run yet. Incident I-17 is MEDIUM. Queen's latest option (c) supersedes the original immediate role-gate scope; option (a) is the future target owned by Queen with T15r.

## Decision and accepted limit

The current PR will stop recording a caller's claimed human identity. Every newly committed question.answer is attributed from server-established channel facts. At the pinned source there is no verified apiaryd/cli producer discriminator, so the only honest fresh value is **answeredBy = "rpc"**. The same rule will apply to dismissedBy when question.dismiss exists; this PR does not introduce dismiss.

**Honeybee operator/controller authorization is DEFERRED. Same-uid agents on a node can still use the local socket and answer questions. This is an explicitly accepted limit, not a fixed security boundary.** Apiary records authenticated origin per applied answer (questionId, origin kind, authenticated origin node, orgId); it introduces NO answer behaviour gate in this phase. A forwarded operator-entered marker is designed separately. The existing same-uid local socket boundary remains. I-17 stays open as accepted MEDIUM.

No body or hello label, command-line/process-name guess, environment variable, withdrawal session principal or LocalTrust withdrawal registration is promoted into proof of a human operator. The strings rpc/apiaryd/cli are attribution categories, never permission grants. Distinct apiaryd/cli categories require a server-established classification contract; their production use is a decision for Queen, likely with target (a)/T15r registration. This draft intentionally emits only rpc.

## Source pin and current behaviour

Honeybee main inspected read-only at **80bac6b8da9a9ba65fd872bd32e110e897ccac95**. File references below use that commit; the owned checkout was not changed.

- v2/daemon/src/rpcAccess.ts:69 classifies question.answer only as mutate.
- v2/daemon/src/rpc.ts:76–90 defines RpcConn with local process/ingress facts and withdrawal/phone fields, but no authenticated operator/controller principal. PeerCredentials supplies uid/pid/process birth, not a producer role (peerCredentials.ts:9–18).
- rpc.ts:389–400 enforces existing same-uid and failed-peer-lookup mutation rules. Its LocalTrust/sessionPrincipal branch at 414–424 is specific to question.withdraw.
- rpc.ts:428–437 refuses explicitly tagged phone carriers on question.answer because those carriers are valid only for send/spawn. This does not prove an untagged request is non-phone or human.
- daemon.ts:2218–2219 wraps answer in global withIdempotency; 2497–2520 can return a recorded receipt before running the handler.
- daemon.ts:5289–5302 accepts params.answeredBy or defaults to operator, then calls the store. It takes no RpcConn. This is attribution input, not identity authentication.
- v2/cli/src/main.ts:1969–1978 implements hive answer, accepts --by, and currently forwards it as params.answeredBy.
- v2/core/src/store.ts:5894–5922 atomically guards open, inserts answer mail and records the answered row/event. Its default answeredBy is currently operator. The owner-internal action.complete closure calls answerQuestion without an attribution override at store.ts:10110.

Apiary facts were supplied by its owner 5fe353f2, not independently inspected in another checkout: renderer gesture → Waggle → main IPC (event currently ignored/no answer authorization) → HiveAdapter answeredBy:operator → ApiarydHost local socket. T13's authorizeHumanCommand can check the parent peer and signed-app/verified-apiaryd assurance, but Hive registration has no humanOnly policy and forwards no authenticated operator field to Honeybee. The owner ships audit fields only; the forwarded operator-entered marker is designed separately. Those are not claimed implemented here.

## Current-PR implementation contract, after approval

1. The daemon assigns the new answer's stored attribution to rpc. It must not read params.answeredBy to select the value. There is no new connection role discriminator to thread or pretend to verify.
2. Continue accepting legacy answer payloads containing answeredBy, but ignore that field for the effect and attribution, including malformed/unrecognized label values. This lets the existing Apiary operator payload keep working without trusting its label. No compatibility path may restore its value into the row, mail sender or audit.
3. New ordinary answers persist answeredBy=rpc in the question, use rpc as the answer mail sender and emit rpc in question.answered. The core default for owner-internal automatic answers also becomes rpc so action.complete cannot create a fresh default operator attribution. Trusted internal core call sites are inventoried during implementation; no new user-controlled route may supply an actor string.
4. hive answer --by remains accepted as a **CLI-local display label**. It is neither transmitted as actor nor stored in Honeybee. Human-readable CLI output may show it explicitly as a display label using existing safe rendering. JSON output remains the authoritative server result, with the server's answeredBy. No new durable label field or schema change is needed.
5. Do not change authorization, capabilities, store version, question state transitions, mail urgency, wake/unarchive rules or withdrawal. Do not add question.dismiss, dismiss state/event, local-trust enablement, new sockets, tokens, grants or service registration.
6. When dismiss is implemented separately, its daemon-owned dismissedBy must use the same observed-ingress rule. It must not copy a caller's dismissedBy. This is a documented design constraint, not an exposed dismiss verb in this PR.

The wire request's answeredBy can be documented as a deprecated ignored legacy field. No actor classification is read from request params/context/hello. The source helper can remain a constant assignment until there is an actual producer contract; a speculative resolver is unnecessary.

## Idempotency and history

Keep the existing global answer dedupe semantics. Fresh execution ignores the caller's actor label before recording the effect. Same-key retries return the original effect with deduped=true and never rewrite attribution or send another answer.

Existing rows, events and receipts may contain arbitrary historical labels, including operator, because the previous owner accepted caller input. They remain append-only evidence and are not reclassified as authenticated humans. An old-key replay may return that historical label. Do not purge receipts, rewrite audit history or repeat a terminal mutation to manufacture rpc attribution.

The original requirement for answer_not_authorized/dismiss_not_authorized and an authorization check before any dedupe lookup belongs to the deferred role gate. This attribution PR must not emit a fake authorization refusal while continuing to accept the same caller, and must not claim the poisoning/authority boundary is fixed.

## Legacy caller compatibility

| Caller | What authenticates today | Behaviour in this PR |
| --- | --- | --- |
| Apiary's existing operator answer path | Apiary transport/IPC facts above; Honeybee checks only its ordinary local process/socket rules. No Honeybee operator principal. | Existing payload still works; body answeredBy is ignored; fresh durable actor is rpc. Apiary records authenticated origin; no new behaviour gate is claimed. |
| hive answer, with or without --by | Ordinary Honeybee local RPC and endpoint checks; no human proof. Agents can run the CLI under the same uid. | Command continues to answer. --by is local display only. Fresh durable actor is rpc. |
| Node relay, token/org/phone or agent-origin call | No new Honeybee role admission. Explicit phone carrier restrictions and existing peer checks remain. | No new elevation from labels or registration. Same-uid/untagged limits remain; Apiary records origins without a new refusal policy. |

This PR does not use a blanket remote-transport prohibition: that would break the valid workstation-operator → satellite path identified by Queen.

## Future target (a), parked with T15r

After a separately reviewed local-trust rollout is live, only registered apiaryd may answer/dismiss over RPC, and the CLI goes through apiaryd. Apiary must first establish the legitimate local operator/controller entry and preserve it across the approved workstation-to-satellite forwarding path. Session principals, withdrawal registration alone, phone carriers, token/org peers and generic relays never constitute the human operator proof.

The future owner gate belongs before global receipt lookup and all effect dispatch, including cache replays. It derives actor attribution from the authenticated principal, not a body label, and returns typed answer_not_authorized/dismiss_not_authorized when that future policy refuses. It must define registration lifecycle/expiry, controller forwarding, CLI routing and migration before enabling enforcement. No target-(a) authentication is invented or shipped as part of this attribution PR.

## Verification after design approval

Use a fresh task-owned branch on approved current main; preserve unrelated Cell artifacts. No code comments. This worker opens a review/* PR on honeybeehq/honeybee after the required masked gate and review handoff; Queen reviews before landing.

Focused regression cases:
- Fresh RPC answer with omitted answeredBy, operator/human/another-bee labels, nonstring label and any hello/body actor label stores/emits/sends rpc.
- Legacy Apiary-shaped payload succeeds with rpc attribution.
- CLI --by is accepted but absent from wire args and actor storage; local display is explicitly labelled; JSON keeps server attribution.
- Same/new keys and answered/withdrawn refusals preserve state, first receipt and mail counts. Changed labels on retry cannot relabel the effect.
- Owner-internal action.complete answer uses the safe default. Ordinary question answer still resumes the waiting action, sends exactly one next-urgency answer and preserves rollback on send failure.
- Existing historical receipt labels remain unchanged on replay; tests make clear they are not human identity proofs.
- Tests document that this phase does not reject a same-uid generic answer. No claim of operator-only authorization is made.

Then run typecheck, build and applicable core/RPC/CLI checks under the **masked Linux gate from the #52 lineage**, with candidate/base pins, source sealing and verifications, whole-home mask, private net/PID/mount environment, non-root zero-capability/no-new-privileges workload, fake HOME/XDG/TMPDIR, bounded attempt receipts, exit status and count-only leakage audit. Scratch stays in this Cell or ~/.cache/T29c; no test workload uses real HOME. Preserve failures/skips/WARNs and report the actual gate verdict; no blanket green from unit tests alone.

Git uses only exact-match-guarded https://github.com/honeybeehq/honeybee.git or git@github.com:honeybeehq/honeybee.git and review/* pushes, with no credential-helper overrides. Never dump environment state. No live stores, live mutation/config access or deployment. Queen's DEPLOY HOLD remains.

## I-17 attribution evidence limit

A separate authorized-projection-only inquiry asked for applied remote answers since 2026-10-01, grouped by origin node with question IDs and no bodies. The available Apiary audit_query projection cannot identify those answers/origins. Honeybee question rows lack rpcCaller/originNodeId; RpcCaller at core/src/rpcAuditContext.ts:3–9 has uid/pid/ingress but no authenticated origin node. Raw audit.tail returns answer-containing payloads and was not queried. Counts and question IDs for remote use are **UNKNOWN / NOT_COVERED**, not zero. No live store inspection occurred.

## Approval and paired release constraint

Queen approved the narrowed attribution-only design and required the consumer inventory before the gate. Distinct apiaryd/cli attribution and the role gate remain deferred. The answer trigger is a wire vocabulary addition and must ship with Apiary's paired closed DTO/validator update; old validators otherwise resync/drop it. Apiary T29e (Opus 145201a6) owns plain Answered + time card copy and UI proof. No owner pin exposure before paired consumers accept the contract.


## Approved answer trigger contract and consumer inventory

New `TurnTriggerSource.kind = "answer"` identifies a question-bound answer, not human authority. All other fields stay identical: `from: string|null`; a TurnTrigger adds `messageId:number|null, generation:number, startedAt:number, humanAt:number|null, endedAt:number|null, endedQuiet?:boolean`. Positively identify answers by questions.delivery_message_id, independent of caller labels, including old saved fallback descriptors and observed turn openers. Preserve humanAt and lastHumanOutputAt bookkeeping exactly as human did. The "[Hive answer to your question …]" envelope and answer body bytes remain unchanged.

Honeybee inventory source pin: 80bac6b8da9a9ba65fd872bd32e110e897ccac95. Literal occurrence census and trigger census are in .proof/T29c-answer-attribution/answered-by-census.txt and turn-trigger-census.txt, captured before production edits.

| Consumer | Source at pin | Disposition |
| --- | --- | --- |
| Fresh RPC actor | v2/daemon/src/daemon.ts:5289–5302 | Ignore legacy params.answeredBy; assign rpc. No role grant. |
| Owner row/default, answer mail/event | v2/core/src/store.ts:5894–5916; internal action.complete:10110 | Default rpc; sender and event same value. Existing explicit internal historical fixtures retained. |
| Row mapper, migration, insert | store.ts:1125,1804,5878; schema.ts:175,181; types.ts:861 | Plain string/null; no actor checks. Remove false default/operator-principal comment. No schema change. |
| Replay/fold | core/src/audit.ts:432; mirror.ts:165,377 | Pass-through historical attribution; no authorization. |
| Read-only fallback | cli/src/readonly.ts:163 | Plain attribution pass-through; stale projection. |
| CLI producer/local confirmation | cli/src/main.ts:1969–1997 | --by no longer sent; JSON remains server result; text explicitly says display label. |
| CLI row label | cli/src/render.ts:502 | Plain answered: answer for all actor values. |
| Answer envelope | daemon/src/envelope.ts:104–131 | Binding selects answer marker; metadata sender is attribution. Bytes unchanged. Delete misleading peer helper comment claiming arbitrary labels are people. |
| Daemon trigger helper and delivery/openers | daemon/src/loops.ts:655–664,1617,1728,1732; multilineFallback.ts:41,58,120 | Positive question binding yields answer. Saved descriptors normalized centrally. |
| Core trigger delivery/opening | core/src/store.ts:4306–4345,4441–4474 | answer retains humanAt/mid-turn semantics, including recovery/observation. |
| Output bookkeeping | core/src/store.ts:4409–4422 | Uses nonnull humanAt; answer advances lastHumanOutputAt exactly as before. No grant. |
| Trigger vocabulary and projections | core/src/types.ts:198–215; audit.ts:106,280,338,400; mirror.ts:223–225,326–327; store.ts:722–723; cli/src/readonly.ts:83 | Add answer union; pass-through and replay preserve fields. No authority classifiers. |
| Extractive handoff task heuristic | core/src/handoff.ts:149–152 | Existing operator/human prompt preference also matches positively bound answer IDs, preserving answer priority with rpc sender. It builds context, grants nothing. |
| Bee attention/waiting read model | core/src/view.ts:14–49 | Runtime/output read model; no actor or trigger authority predicate. |
| Tests/frozen history | core/tests/mirror.test.ts:151,330,432; preflip-verbs.test.ts:205,208,227; turn-trigger.test.ts:243; question-withdraw.test.ts:71–72; daemon/tests/preflip-verbs.test.ts:484,487,509; turn-trigger.test.ts:140–156; envelope.test.ts:28,34; cli/tests/cli.test.ts:695–716 | Update fresh RPC/default expectations and trigger kind, keep historical explicit core/migration fixtures, remove false human claim in envelope test. Add label-wire and bookkeeping regressions. |

Honeybee grant consumers: RPC admission (rpcAccess.ts, rpc.ts), local trust (localRpcTrust.ts), withdrawal ownership, human reference/landing/permission/credential paths do not read answeredBy/lastTurnTrigger/humanAt. Repository-wide census found no answer actor/trigger predicate granting authority. Existing unrelated action.complete operator wording is not made into new human evidence by this PR. No new auth claim is made.

# T29 Apiary answeredBy consumer inventory

Source pin: Apiary main be18f829cc36afb3e756c63b47f869f432cd1204 (audit candidate 994652442 changes none of these consumers). Source-only inventory; no UI runtime claim. Full occurrence census: rg -n 'answeredBy|answered_by' apps packages services, plus tracing DecisionAnswer.by aliases and UI renderers.

| Consumer | Evidence | Meaning / rpc readiness |
| --- | --- | --- |
| Owner wire DTO | services/apiaryd/src/domains/hive/hiveProtocol.ts:713-723 | optional request answeredBy and returned QuestionRow; no auth predicate |
| Vendored owner contract | services/apiaryd/src/domains/hive/vendor/honeybee-v2/types.ts:846-847; mirror.ts:165,377 | pass-through attribution; update pin only with reviewed upstream artifact |
| Event fold | services/apiaryd/src/domains/hive/fold.ts:531-539 | copies payload answeredBy; no identity authority |
| Mirror schema/row/upsert/read | services/apiaryd/src/domains/hive/tables.ts:642,689,911,930 | nullable text stored/returned verbatim, rpc accepted |
| Node and phone wire table | services/apiaryd/src/nodes/wire.ts:71-75,196 | answered_by mirrors as text; no semantic classifier; phone does not expose an answer command (wire.ts:226-234) |
| Adapter DTO/conversion | packages/adapters/src/hive.ts:205,464-477 | rpc passes through unchanged |
| Core UI DTO | packages/core/src/hive.ts:1908 | string or null; rpc valid |
| Outbound adapter answer | packages/adapters/src/hive.ts:1260-1271 | sends literal operator as legacy attribution, not authority; new owner must ignore it. Optional removal can accompany upstream contract, independent of audit PR |
| Next live decision mapping | apps/desktop/src/renderer/src/next/decisions.ts:45-58 | answered status controls terminal view; by copied from answeredBy. Equality uses by only for repaint at :20-21 |
| Optimistic local answer | same decisions.ts:14-17 | uses by:operator only for pending UI; no permission use |
| Decision port and fixture | apps/next-desktop-beta/src/data/port.ts:893-894; data/fixtures/standingRules.ts:213 | string/null attribution, fixture operator; no authority |
| Actual card label | apps/next-desktop-beta/src/plugins/work/DecisionCard.tsx:31,35-42 | null/operator renders “you”; rpc would render “by rpc”, an unsuitable person-like name. REQUIRED paired UI correction: rpc/unknown attribution shows simply “Answered…” with time and no fake person. Historical operator/null labels must not be used as verified-human badges |
| Waggle completion | apps/desktop/src/renderer/src/waggle/hiveSessionActions.ts:205-219 | entity present/post-push completion, no answeredBy predicate |
| Inbox/open question reads | services/apiaryd/src/domains/hive/read.ts:87-93 | status=open filter only; attribution does not hide/authorize anything |
| Mail rendering | no answeredBy references outside listed mirror/card paths | owner mailbox envelope uses stored delivery binding; Apiary does not promote answeredBy to mail authority |
| New answer audit | services/apiaryd/src/domains/hive/answerAudit.ts (994652442) | derives origin from CommandOrigin, does not read answeredBy or body labels; actor apiaryd, not human |

Tests/fixtures (all direct occurrences): packages/adapters/src/__tests__/hive.test.ts:1278,1660; apps/desktop/src/renderer/src/next/sessionPopulation.test.ts:61; sessionRow.test.ts:33; renderer/src/hiveMirrorModels.test.ts:17; panes/agentSurfaces/SwarmCard.test.tsx:26; apiaryd hive integration.hive.test.ts:665,674,682; consumer.test.ts:1091; commands.test.ts:179; tables.test.ts:613,623; testFakeHive.ts:441,449,455,462. Integration/consumer tests currently assert operator against historical/fake owner; real-owner assertion must follow the owner contract where that runtime is used. Fake owner defaults are fixture-only and must not be presented as proof of human authorization. No new tests added.

Result: no Apiary permission, matching, Inbox, filter, audit, phone command or Waggle settlement gate uses answeredBy as proof of human identity. One UI consumer needs paired copy handling before rpc attribution is exposed; it belongs to the separate visual session per task split, with screenshot/recording + Nectar proof on erebor. This inventory alone does not approve that UI. Honeybee owner f78f08c4 owns its inventory/fixes and exact upstream pin. Apiary audit-only PR36 remains separate.


Apiary additional trigger consumers (5fe353f2): packages/core/src/hive.ts:97–115 closed union/validator MUST add answer; services/apiaryd/src/domains/hive/fold.ts:682,689,839 otherwise resync; hiveMirrorSession.ts:64–68 otherwise drops unknown. tables.ts:287–288,369–370 stores JSON verbatim; fleetReadDiff.ts:43 includes trigger/timestamps. hiveAttentionOutputAt packages/core/src/hive.ts:117–119 uses lastHumanOutputAt when trigger exists with no kind test, preserving parity. No authority consumer found. Paired standalone DTO/validator review is being coordinated with its owner before owner pin exposure.



## Superseding compatibility implementation

Queen approval21089 supersedes the unconditional answer-emission/every-node
ordering above. Canonical store/audit/replay remains answer. Each subscriber
advertises turn-trigger.answer.v1 once in its client hello; missing/unknown
advertisement receives a cloned human projection. Capabilities are format-only,
not RpcCaller/identity/authority/command-admission facts. Request params cannot
opt in. All schema paths are enumerated by executable compiler census in
v2/daemon/tests/answer-trigger-census.test.ts, with inferred dispatch and actual
audit payload types. It caught the initially missed ChildrenResult path.
Coverage lives in answerTriggerProjection.ts and drives the projector itself.
Negative injected new-result/new-dispatch/new-audit checks fail as required.
Canonical object identity and shared-event immutability are tested.

Old Apiary node replication drops unrecognised triggers rather than resyncing
(hiveMirrorSession.ts:68); old Studio may degrade to no trigger, accepted by
Queen. Only opted-in direct subscribers need the new validator. No every-node
rollout ordering remains; DEPLOY HOLD remains. Apiary T29f vendor work is parked
until this owner change merges, then normal merged-SHA repin and hello advert.
T29e card copy remains separate.

Local checks: root check, v2:check, build (third), final daemon typecheck pass;
63 focused core/envelope checks,5 negotiation/census checks,29 real daemon/RPC/CLI
checks pass. The local metal1 real lab confirms code0/no-signal shutdown,
canonical rpc row/event/mail, reconnect dedup, same humanAt timestamps with
legacy human vs opted-in answer, and audit replay equality. Initial queued
probe fixture failure is retained and corrected by ordering/draining probes.
Masked final gate remains pending on the proven Quiet/662 lane.
