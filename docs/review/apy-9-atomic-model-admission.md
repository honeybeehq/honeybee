# APY-9 atomic model admission

[APY-9](https://linear.app/honeybee-hq/issue/APY-9/make-model-changes-atomic-with-honeybee-working-state-admission)
requires Honeybee to protect active turns when Apiary changes a model or effort.
This Cell contains Honeybee. The Apiary caller migration remains outstanding.

## Findings and changes

Apiary's idle check precedes separate argument, stop, and revive requests.
A turn can begin between that check and the stop command. The original
deterministic reproduction failed with `must not stop the admitted turn`.

`bee.reconfigure` now owns admission and the restart intent. The daemon folds
pending driver observations before admission, outside the idempotency transaction.
This ordering preserves consumed turn-start facts even when admission refuses.
The core refuses booting or running bees with the existing typed
`runtime_refused` error. Refusal changes no arguments, runtime, or commands.

For a live idle bee, the store queues a generation-fenced `stop` command carrying
`replacementArgs` and `thenRevive`. Arguments remain unchanged until execution.
The command claim query skips replacement stops while the targeted runtime is
working. Other commands can proceed. Deferral creates no retry attempts or audit
churn. Once idle, the synchronous executor applies the arguments and stops the
runtime before another mailbox delivery can be admitted.

The existing stop-and-revive path supplies the replacement generation. Boot
reconciliation also honors settled restart intent, covering daemon death between
stop settlement and the exit observation. Stale commands settle as no-ops before
changing arguments. Duplicate request keys return the original result, and a
second pending change for the same generation is refused.

This uses the existing command schema and audit events. It introduces no runtime
state, condition flag, renderer signal, or second state authority. The existing
`bee.setArgs` and default CLI behavior still record arguments for the next runtime.
`hive set-model <bee> <model> --apply` requests the new atomic restart behavior.

## RPC contract for Apiary

The daemon advertises `bee.reconfigure.v1` in hello and `deployInfo` capabilities.
The request accepts the complete replacement argument list, including model and
effort selectors:

```json
{
	"verb": "bee.reconfigure",
	"params": {
		"beeId": "<canonical bee id>",
		"args": ["--model", "<model>", "--effort", "high"],
		"idempotencyKey": "<action request key>"
	}
}
```

`args: null` clears all per-bee arguments. Successful results are:

| Outcome | Meaning |
| --- | --- |
| `queued`, with `commandId` | Durable restart intent. A newly admitted turn can delay execution. |
| `recorded`, with `bee` | The stopped bee's arguments changed; no runtime starts. |
| `unchanged`, with `bee` | Arguments already match; no restart occurs. |

`runtime_refused` covers a working bee or an existing pending model change.
`bee_not_found` covers an unknown target. Invalid arguments return
`invalid_request`. A refusal does not consume its idempotency key.
An idempotency replay preserves the original outcome and includes `deduped: true`.
Command-backed replays also include the command's current status.

Apiary's `HiveAdapter.setModel` needs to replace its `bee.setArgs`, stop, and revive
sequence with this single request. The existing Waggle action needs to preserve
the typed refusal and queued acknowledgment. A queued acknowledgment is not proof
of a completed restart. Command status and the canonical mirror expose progress.
Clients requiring immediate model application must refuse an older daemon without
the capability instead of falling back to the old sequence.

The caller change and native Waggle verification are not implemented here because
this run is restricted to its Honeybee Cell checkout. APY-9 remains open until
that integration is verified. No live deployment or Linear mutation was made.

## Verification evidence

The deterministic command-boundary test failed before the fix and passed after it.
It injects `turn_started` after idle admission but before execution, then proves
the process survives, arguments stay unchanged, and the change applies after idle.

A real HSR test exhausts the executor budget so input delivery wins a tick.
The process admits a hung turn before its observation is folded into the store.
The next tick defers the model change. After explicit fixture interruption, the
replacement process starts with the new model and effort. This test passed.

The real daemon RPC test proves typed refusal leaves the runtime row, arguments,
and command list unchanged. It also covers ordinary idle restart, idempotency
replay, no-op selection, invalid arguments, unknown bees, and stopped-bee clearing.
CLI coverage drives `set-model --apply` through the real daemon.

Crash tests reopen SQLite after executor death before and after the effect, and
after stop settlement without an exit observation. They prove one replacement
generation. Additional tests cover booting refusal, stale generation fencing,
unrelated command progress, quiet deferral, and audit replay.

Final gate results:

| Gate | Result |
| --- | --- |
| `npm run v2:check` | Passed across all v2 packages. |
| `npm run check` | Passed for root source and tests. |
| `npm run build` | Passed, including runner-host and v2 CLI artifacts. |
| `npm run v2:test` | 174 passed, 0 failed. |
| `npm run v2:harness` | 14 passed, 0 failed. |
| `npm run v2:daemon` | 286 passed across both tiers, 0 failed. |
| Final daemon typecheck | Passed after the recovery and real HSR test additions. |
| Real HSR admission race | 1 passed, 0 failed. |
| Final core argument tests | 7 passed, 0 failed, including deferred clear-to-default. |
| `git diff --check` | Passed. |

The repository has no separate lint script. The built CLI's help lists
`set-model <bee> <model> [--apply]`. `gh run list` returned no CI runs for
this repository. These are local verification results; no branch was pushed.

## Review scope

Local review covered the full diff, command claim ordering, observation folding,
argument mutation, stop-and-revive recovery, idempotency, and CLI propagation.
Apiary refused a same-checkout child reviewer because Cell-owned sessions require
children to use new Cells. The user's checkout restriction ruled that out, so no
independent reviewer ran. No PR comments were posted.
