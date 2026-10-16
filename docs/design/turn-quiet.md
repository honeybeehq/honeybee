# Quiet turn completion

`bee.turn_quiet.v1` adds `lastTurnTrigger.endedQuiet?: boolean` to BeeRow snapshots and to the existing `runtime.updated` delta's `turnTrigger` payload. True means captured final assistant text ends quiet; false means captured text does not. An absent field means unknown, including historical rows, open turns and completions without final text evidence. Each new turn starts without the field.

The classifier in `v2/core/src/quiet.ts` mirrors Apiary's `packages/core/src/quiet.ts` at `75cd81edecb99497776b29acaeea4ba16353e1e8`. A trailing `<quiet/>`, including after visible content, marks the whole reply quiet. The suffix scan skips whitespace, Unicode Default_Ignorable_Code_Point and U+2800, including astral code points. A token followed by visible text does not mark the reply quiet.

Quiet completions advance `lastOutputAt` but preserve `lastHumanOutputAt`. The latter now counts human-participating output except known quiet completions; unknown classifications preserve previous behavior. `output.recorded` continues publishing this cursor. Runtime, trigger and output facts commit atomically. The trigger is already stored as JSON, so this requires no schema or store version change. Audit replay and mirrors preserve the additive nested field.

Drivers capture final assistant text using the existing structured transcript projectors. Tool output cannot supply this fact. HSR fences capture to the provider session and rebuilds it from the committed generation journal prefix when adopting a runner. The tmux driver captures from its structured transcript baseline before folding completion; a hook completion without captured text leaves the classification unknown.
