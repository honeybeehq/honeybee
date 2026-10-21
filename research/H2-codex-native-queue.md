# H2: Codex native queue and fresh-turn limits

Codex 0.163.0 has no busy, queue, or idle-precondition option on
`turn/start`. Its experimental schema exposes separate native queue methods,
whose safety while a turn is active remains untested here. H2 keeps the
natural-idle baseline and known-active refusal; it does not add a second queue
owner or claim an atomic fresh-turn guarantee.

## Version and evidence

On 2026-10-21, the worker generated bindings from the exact npm package
`@openai/codex@0.163.0` with `codex app-server generate-ts`, once with
`--experimental` and once without. `codex --version` from that package reported
`codex-cli 0.163.0`. Commands ran under `env -i` with isolated `HOME` and
`TMPDIR` backed by this Cell. No shared account or inference request was used.
The machine's preinstalled Codex was 0.156.1 and was not the schema source.

Reproduce with an isolated home and temporary directory:

```sh
npm exec --yes --package=@openai/codex@0.163.0 -- \
  codex app-server generate-ts --experimental --out ./schema-experimental
npm exec --yes --package=@openai/codex@0.163.0 -- \
  codex app-server generate-ts --out ./schema-stable
```

The experimental `ClientRequest.ts` includes `thread/queue/add`, `list`,
`update`, `delete`, `reorder`, and `start`. The stable `ClientRequest.ts`
contains none of these methods. Generated types establish request and response
shapes, not availability or concurrency semantics.

The parent reports a real stock 0.163.0 fixture in which `turn/start` during a
tool call returned the initial active turn's ID and injected
`ACTIVE_START_PROBE`, without an error. This worker did not independently run
that fixture. The earlier fabricated active-turn error test proves refusal
handling only; it does not prove stock Codex refuses an active `turn/start`.

## Exact generated queue type snippets

These declarations come from the correspondingly named files under generated
`v2/`. Imports and generated headers are omitted; type text is preserved.

```ts
export type ThreadQueueAddParams = { threadId: string, input: Array<UserInput>, clientUserMessageId: string, };
export type QueuedSubmission = { id: string, input: Array<UserInput>, clientUserMessageId: string, };
export type ThreadQueueAddResponse = { queuedSubmission: QueuedSubmission, };
export type ThreadQueueStartParams = { threadId: string, queuedSubmissionId?: string | null, };
export type ThreadQueueStartResponse = { turn: Turn, };
export type ThreadQueueChangedNotification = { threadId: string, };
```

`TurnStartResponse.ts` separately declares:

```ts
export type TurnStartResponse = { turn: Turn, };
```

`TurnStartParams.ts` has no `busyBehavior`, `busy_behavior`, `ifBusy`, `queue`,
or `expectedTurnId` field, including in experimental output. Its `turnTrigger`
comment explicitly says that field is ignored when the request steers an
already-active turn. Its `parentTurnId` and `rootTurnId` comments also describe
the request adding input to an active turn. `clientUserMessageId` identifies
client input; its type supplies no freshness precondition.

The [official app-server documentation](https://developers.openai.com/codex/app-server/)
describes `turn/start` returning a turn and `turn/steer` requiring
`expectedTurnId`. The fetched documentation did not establish native queue
busy behavior. Do not transfer the steer precondition to start.

## Detection proposal and its limits

A native turn ID can expose reuse after input has already been accepted.
A detection design would need the following evidence:

1. Before writing a fresh request, capture known turn IDs for that native
   thread, including prior active and completed turns. Preserve the request ID,
   mailbox message ID, digest, host identity, and observation position.
2. Inspect `result.turn.id`. A match with an ID known before that request is
   evidence that this response did not identify a fresh turn. Distinguish
   replay of the same delivery from a different delivery reusing a turn.
3. Record the response and freshness violation as durable evidence. Do not
   label it `not_written` or an ordinary native refusal: input may already
   have affected the active turn. Hold uncertain settlement for reconciliation;
   an automatic retry can duplicate the input.
4. Apply the same classification in both adapter confirmation and runner-host
   receipts. Currently `v2/adapters/src/codex.ts` confirms any delivery result,
   and `v2/driver-hsr/src/delivery-receipts.ts` accepts any matching non-error
   result. Changing only the adapter leaves host reconciliation able to accept
   the same response. Recovery must preserve the classification across replay.

This is detection, not prevention. A self-woken turn can begin after the
pre-write snapshot but before Codex processes the request. Its ID can be new
to the snapshot even when the input joins that turn. Conversely, a legitimate
new `turn/started` notification can arrive before the request's response, so
membership in the IDs seen at response time alone would reject valid fresh
turns. Incomplete history or missing recovery evidence must remain uncertain.
Turn timestamps have no documented atomic relationship to the write.

No queue runtime probe was performed. Establishing an active stock turn would
require another model-backed fixture; the parent already owns that experiment.
`thread/queue/start` is only a candidate for a future isolated probe: test
active-turn rejection, input injection, duplicate starts, and restart recovery
before making any guarantee. Native queue ownership and this detection design
remain outside H2.
