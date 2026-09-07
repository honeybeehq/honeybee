# D05 command predicate design

## Problem

`DaemonCore.reviveAfterStopIfRequested()` and `pendingStopExists()` call `CoreStore.listCommands({ beeId })` to answer boolean questions. The canonical 100,000-row fixture costs 174.552 ms CPU in boot recovery and 176.946 ms CPU in the pending-stop policy call. Its SQL diagnostic returns 100,000 rows and 6.3 MB of text. The change must leave the complete, ordered `listCommands()` API unchanged.

The predicates must preserve these rules:

- A stop requests revival only when `args.thenRevive` is the JSON boolean `true`.
- The requesting stop status is `done` or `running`.
- The requesting stop targets the exact stopped generation.
- A queued or running `revive` or `send_wake` covers the request when `(targetGeneration ?? 0) >= generation`.
- A queued or running stop suppresses another policy stop only for the exact generation.
- Neither pending predicate restricts `next_attempt_at`.

## Usage from the daemon

```ts
private reviveAfterStopIfRequested(beeId: string, generation: number): void {
	if (!this.store.hasStopThenReviveRequest(beeId, generation)) return;
	if (this.store.hasPendingReviveOrWakeCommand(beeId, generation)) return;
	const rt = this.store.currentRuntime(beeId);
	if (!rt || rt.generation !== generation || rt.state !== "stopped") return;
	const cmd = this.store.enqueueCommand("revive", beeId, { reason: "after_stop" });
	this.log(`revive.after_stop bee=${beeId} gen=${generation} cmd=${cmd.id}`);
}

private pendingStopExists(beeId: string, generation: number): boolean {
	return this.store.hasPendingStopCommand(beeId, generation);
}
```

The daemon keeps the policy and the existing order of checks. `CoreStore` owns the storage predicates.

## Proposed signatures and SQL

Add three read-only methods beside the command reads in `v2/core/src/store.ts`:

```ts
hasStopThenReviveRequest(beeId: string, generation: number): boolean;
hasPendingReviveOrWakeCommand(beeId: string, minimumGeneration: number): boolean;
hasPendingStopCommand(beeId: string, generation: number): boolean;
```

`hasStopThenReviveRequest()`:

```sql
SELECT 1
FROM commands
WHERE bee_id = ?
  AND status IN ('done','running')
  AND verb = 'stop'
  AND target_generation = ?
  AND json_type(args, '$.thenRevive') = 'true'
LIMIT 1
```

`hasPendingReviveOrWakeCommand()`:

```sql
SELECT 1
FROM commands
WHERE bee_id = ?
  AND status IN ('queued','running')
  AND verb IN ('revive','send_wake')
  AND COALESCE(target_generation, 0) >= ?
LIMIT 1
```

`hasPendingStopCommand()`:

```sql
SELECT 1
FROM commands
WHERE bee_id = ?
  AND status IN ('queued','running')
  AND verb = 'stop'
  AND target_generation = ?
LIMIT 1
```

Each method uses the existing cached-statement helper and returns whether `.get(...)` found a row. `commands_by_bee_status(bee_id, status, id)` narrows the status probes without a schema change. SQLite evaluates `verb`, generation, and JSON as residual conditions. The SQL does not force an index. Exact-query plan tests must show that SQLite selects `commands_by_bee_status`. Do not add an index or an `INDEXED BY` hint without evidence that the unhinted plan is wrong.

The signatures use `number` because the authoritative `CommandRow.targetGeneration` and daemon generation already use `number`. Adding a second generation type in this two-file path would add casts without preventing a current misuse.

## JSON compatibility

`json_type(args, '$.thenRevive') = 'true'` is required. `json_extract(args, '$.thenRevive') = 1` also matches the JSON number `1` and breaks the strict boolean rule. Missing, `null`, `false`, numeric `1`, and string `"true"` do not match `json_type(...)= 'true'`.

CoreStore serializes command arguments with `JSON.stringify()`, so its writes are canonical JSON objects. Two raw SQLite cases differ from the old `JSON.parse` path:

- For `{"thenRevive":false,"thenRevive":true}`, `JSON.parse` keeps the last key and JSON1 reads the first key.
- SQLite JSON1 accepts some JSON5 text, such as `{thenRevive:true}`, while `JSON.parse` rejects it.

Malformed JSON fails in both paths, although the error type and message differ. These cases require an offline writer or a corrupt legacy row. The implementation should test all values that CoreStore can write and leave `listCommands()` unchanged for complete-history and forensic reads. If compatibility with arbitrary noncanonical raw command text is required, the safe fallback is to select candidate `args` and run `JSON.parse` in JavaScript. That fallback still parses every row in the measured all-stop negative fixture, so it does not address this baseline.

## Cheap tests

Add focused cases to `v2/core/tests/command-indexes.test.ts` or a new `v2/core/tests/command-probes.test.ts`:

1. Write stop commands whose `thenRevive` values are missing, `null`, `false`, `1`, and `"true"`. Set each to `done` or `running` at the target generation and assert no match. Add `{ thenRevive: true }` and assert that both `running` and `done` match. Assert that `queued`, `failed`, and another target generation do not match.
2. For `hasPendingReviveOrWakeCommand()`, cover both verbs, `queued` and `running`, and targets below, equal to, and above the minimum. Seed a null target offline and assert that it matches minimum 0 but not minimum 1. Keep one queued row in the future and assert that it still matches.
3. For `hasPendingStopCommand()`, cover `queued` and `running`, reject `done` and `failed`, reject another generation, and accept a future-delayed queued stop.
4. Capture `lastAuditSeq()` and `dumpState()` around every predicate family. Assert that the reads change neither authority value.
5. Seed mixed command history, call `listCommands()`, and assert complete row count, ID order, arguments, statuses, and target generations before and after predicate calls.
6. Use `EXPLAIN QUERY PLAN` against the exact SQL and assert use of `commands_by_bee_status`. Assert that no new command index exists.

Add daemon regressions to `v2/daemon/tests/loops.test.ts`:

1. Boot a stopped bee with settled stop history containing every non-boolean-true `thenRevive` value. Assert that repeated `boot()` calls enqueue no revive, start no driver process, and retain the full command history.
2. Put a booting runtime past the hang boundary and leave one queued stop with `nextAttemptAt` in the future. Set `commandsPerStep` to zero, run repeated steps, and assert no new stop, no audit change, no runtime change, and no driver effect.
3. Keep the existing stop-then-revive test as the positive daemon path. It already proves a completed request revives once and a pending `send_wake` prevents a duplicate.

Run only the focused core and daemon files during implementation. The parent coordinates the broad daemon suite on Studio. The required local gates remain typecheck and build.

## Synthesis decision

Use three storage predicates and keep orchestration in `DaemonCore`. This shape preserves the current short circuit. A negative stop history runs one query, while the rare positive path runs the second pending-start query. It also keeps runtime-state validation and revive enqueueing out of the store.

## Alternatives considered

- A single `shouldReviveAfterStop()` store method would expose fewer methods, but it would move daemon policy into the storage class and hide the runtime-state check split.
- Selecting candidate rows and using `JSON.parse` would preserve arbitrary raw JSON text behavior. It loses the measured all-negative case because all 100,000 rows share the indexed bee and status values.
- A new expression or covering index could remove more residual work. There is no measured residual after these queries yet, and the added write and storage cost would be speculative.

## Next implementation step

Add the predicate tests first, then add the three methods and replace only the two `listCommands()` call sites.
