# Large Codex conversation stuck in a boot loop

On September 8, 2026, `CO.d1b3` showed as working in Apiary while its latest
operator message remained undelivered. The bee was created on September 4.
The failure affected replacement runtimes resuming that same conversation.

## Cause

Honeybee sent `thread/resume` without `excludeTurns`. Codex 0.153.4 hydrated
the full conversation into the response. This conversation's saved rollout
was 378,745,260 bytes, including its visual exploration history.

The runner host processes newline-delimited responses. Until the large
resume response completes, the adapter cannot acknowledge readiness.
Codex's earlier `thread/status/changed` notification does not acknowledge
the resume request. Treating it as readiness would bypass the handshake.

The daemon's 180-second boot timeout stopped each attempt with
`stopped_by_system`. The queued message caused another wake. These stops
did not consume the spawn-failure budget, so the cycle continued with no
`spawn_failed` flag. The Hive view correctly derived `working` from
`booting`, and Apiary mirrored that view.

## Reproduction

A diagnostic copy of the saved Codex rollout reproduced the failure without
credentials or a model turn. Only `initialize` and `thread/resume` were sent.
The original conversation and its mailbox were left intact.

- Full-history resume did not acknowledge within 30 seconds. The diagnostic
  reader had accumulated 64,028,672 bytes of an incomplete response.
- The same request with `excludeTurns: true` acknowledged in 1.63 seconds.
  Its response was 2,616 bytes and contained the original conversation ID.
- The real `HsrDriver` and runner host, using the original adapter against
  that diagnostic copy, produced no boot observations within 15 seconds.
- With the patched adapter, the same driver test emitted `booted` and
  `turn_ended` in 5.89 seconds, preserving the conversation ID. The complete
  diagnostic session log was 3,679 bytes.

The installed Codex schema describes `excludeTurns` as returning thread
metadata and live resume state without populating `thread.turns`. It does
not remove conversation history or change the model's context.

## Repair

Request metadata-only resume in the Codex adapter. Preserve the explicit
resume acknowledgment as the readiness boundary. Do not infer readiness
from transcript content or unrelated startup notifications, and do not
increase the timeout to accommodate redundant history transfer.

The stopped transition charges the existing startup failure budget when
the same generation has an executed `hang_policy` stop command. Queued or
failed intent does not count. User stops and idle scale-to-zero remain
outside that budget. The daemon also suppresses another hang-stop command
while the first command is queued, running, or done awaiting exit evidence.

Regression coverage checks metadata-only readiness, bounded retries with
pending mail, delayed and duplicate exit observations, stale generations,
and the distinction between queued, running, done, and failed stop commands.
