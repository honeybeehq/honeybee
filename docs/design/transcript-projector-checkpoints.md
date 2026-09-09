# Transcript projector checkpoints

The transcript projector owns projection state. Consumers persist a checkpoint together
with their source cursor and already emitted events, then restore before replaying the
suffix. This is derived transcript data, never lifecycle authority. Persistence and
atomic cursor/event/checkpoint commits belong to the consumer.

## Design choice

| Option | Consequence |
| --- | --- |
| Snapshot provider state | Preserves open chunks, pairing and dedupe without replaying the prefix. Selected. |
| Save and replay all consumed lines | Preserves semantics but storage and restore work grow with transcript length. |
| Flush and restart at a cursor | Changes Grok chunk boundaries, loses Codex item starts and dedupe, and loses Agy cumulative baselines. |
| Consumer reconstructs internal state from events | Events omit pending data and dedupe identities. Couples consumers to provider internals. |

Source grounding: Codex closes over started items, model attribution, rollout message
identities, fork request IDs and the rollout turn-open flag. Grok closes over its open
message/thinking chunk, prompt mirror remainder, tool states and compaction identities.
Agy closes over thread identity, fragment buffers, emitted identities and cumulative
usage/duration baselines. Claude and renderer fallbacks have no retained state.

## Contract

`createTranscriptProjector(harness)` retains its existing projection behavior.
`projector.checkpoint()` returns a detached `{ harness, projectionVersion, stateVersion,
state }` envelope. It emits nothing, does not flush, and does not mutate state. State is
opaque to consumers. Unknown harnesses retain their renderer fallback and checkpoint the
requested harness name, even though their existing projector `harness` reports `claude`.

`restoreTranscriptProjector(harness, checkpoint: unknown)` returns either
`{ ok: true, projector }` or `{ ok: false, reason }`. Reasons are `invalid_checkpoint`,
`harness_mismatch`, `projection_version_mismatch`, `state_version_mismatch`, and
`state_too_large`. Failure never returns a partially restored projector.

The UTF-8 JSON envelope limit is inclusive at 4 MiB. `checkpoint()` may return a larger
envelope; consumers can skip persisting it and retain an earlier safe checkpoint.
Restore rejects oversized envelopes. Envelope and owned state fields are exact.
Native Codex started-item payloads and Grok tool inputs allow arbitrary JSON fields,
because those are provider data, not checkpoint schema. Non-JSON values are rejected.
Snapshot and restore both detach nested data from the consumer.

Both versions start at 1. Bump `projectionVersion` when event semantics change and
`stateVersion` when the persisted state schema changes. Both are global exact fences;
there is no implicit migration. Consumers rebuild from source after incompatible or
corrupt checkpoints. Consumers may add their own version for wrapper semantics.

## Verification

Every existing Agy, Claude, Codex and Grok projector fixture runs paired streams.
One projects uninterrupted. The other checkpoints, JSON serializes, restores at the
empty boundary and after every push and flush, and compares each emitted batch and
complete checkpoint. This includes item starts, fork responses, rollout message dedupe,
repeated Codex turn opens, open thinking/message chunks, prompt mirrors, Grok tool
updates and compaction dedupe. Explicit Agy replays cross checkpoint boundaries after
an emitted tool ACTIVE, tool terminal update and assistant DONE with text, proving that
all three emitted-identity sets suppress duplicates after restore.
Separate tests cover malformed envelopes and nested state, exact versions, mismatched
harnesses, empty stateless/unknown state, alias isolation and the byte limit.

## Persistence and version maintenance

Take the checkpoint after the last state-mutating call whose events will be committed
in the same transaction. Do not call `flush()` or `pushLine()` between taking that
checkpoint and committing it with its cursor and events. Flushing changes pending state.

Use `serializeTranscriptCheckpoint` to obtain `{ ok: true, json, bytes }` or a typed
`invalid_checkpoint` / `state_too_large` failure, using the same checks as restore.
This helper checks JSON representability and size, not provider schema compatibility;
restore owns schema validation. Persist its JSON string verbatim. JSON escaping preserves
lone UTF-16 surrogates in open chunks or prompt mirrors; transcoding decoded string
fields through UTF-8 TEXT can replace them and change subsequent projection.

`projector.harness` describes the projection dialect; `checkpoint().harness` stores the
registry key. Always pass the identical requested key to create and restore, with no
normalization between them. A future provider can use the Claude fallback dialect while
retaining its own registry key in the checkpoint.

Both version fences are global. A Grok state schema change therefore invalidates Codex
and Agy checkpoints too. This deliberately favors simple compatibility decisions.
The test-only source digest covers all six projector modules. Source changes require
reviewing versions, bumping the relevant constant, and refreshing the fixture with:

```sh
UPDATE_TRANSCRIPT_CHECKPOINT_DIGEST=1 node --test v2/driver-tmux/tests/checkpoint-digest.test.ts
```

The refresh command refuses a changed digest with unchanged versions. The digest is
conservative and also flags comments or refactors; use the state version to invalidate
checkpoints when event semantics remain unchanged. The digest adds no runtime dependency.

Grok retains tool pairing and dedupe flags but drops tool input after emitting its call.
The event already contains that input, and future updates never re-emit the call. This
keeps large file-write arguments out of every subsequent checkpoint without evicting IDs.
