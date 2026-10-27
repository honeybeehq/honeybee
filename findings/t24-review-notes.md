# T24 cross-family review notes

Reviewed by Claude, session 27a332b3-0a02-4d7c-9b6d-4792305fb005, source only. The reviewer received the exact c96f4314 production diff, aggregate fixture receipt and trail by authenticated agent_send; it did not run the fixture or inspect another checkout. The reviewer reported no further findings on c96f4314 after the following clarifications. These notes supplement the original audit and evidence without changing that production patch.

## Boundaries the proof depends on

- Output preservation was demonstrated with flowing stdout and synchronous append handlers: the full 128 KiB newline-terminated final record, final stderr and delayed output within the one-second window. This does not guarantee lossless output under arbitrary downstream pauses/backpressure or arbitrarily slow storage. At the deadline unread capture bytes can be discarded. Later descendant output is deliberately excluded.
- Closing owned pipe read ends sends no explicit descendant signal, but a later holder write can fail with EPIPE or cause SIGPIPE according to that program's handling. A background program may therefore terminate on its next log write. The fixture verifies the holder remains live immediately after host exit, before any later write; it does not claim that holder workloads survive future writes.
- The fix frees the stuck host process. Descendant holders remain alive until their owner stops them or they otherwise exit. It does not solve descendant ownership, prove a live leak or establish a fix for mini04/mini07 slot exhaustion. Live attribution still needs reviewed process ownership/fd-holder evidence and installed revisions; no such read was performed here.
- Both finish functions guard first-call-only before mutating status. The timeout branch cannot have its outputDrainTimedOut flag overwritten by a later close callback. Both production readers use the shared readRunnerStatus JSON parser, which checks hostPid and permits extra fields. The pre-fix Cell source has the same parser. Arbitrary older installed versions remain unverified.
- Neither host flushes an unterminated final stdout fragment on end or close. That pre-existing behavior remains unchanged and was explicitly withdrawn as a patch finding by the reviewer. It deserves separate investigation if a harness requires final fragments without newlines.

## Separate findings and follow-up owners

Mailbox death-window: `v2/driver-hsr/src/driver.ts:1017-1024` marks a non-confirming adapter's message consumed after successful host socket write, while the host may already have an exited agent and destroyed stdin. The host's write guards avoid writing to destroyed stdin, but do not provide a negative acknowledgment to those callers. This pre-existing source risk has been routed to parent b82108c7 as triage owner; implementation remains unassigned. It was not reproduced or repaired by this process-retention patch. Codex/Muse confirming adapters instead keep delivery pending until parsed acknowledgment (`driver.ts:924-933`, 1018-1024); this patch creates no new delivery authority. Do not extrapolate that guarantee to every adapter.

Performance-map drift: parent b82108c7 is the triage owner for the reported 169 unaccounted entries, one dead entry and 45 stale owners; map repair is separate, not absorbed into a new baseline. There is no process-retention workload or measured speed-improvement claim here.

Fixture cleanup accounting: the repeated instrumented six-before/six-after run records hostFallbackKills per case in the aggregate receipt. Zero means no fallback SIGKILL to the fixture host fired; it does not mean no fixture-owned descendant cleanup occurred. Every holder case intentionally terminates only its own exact-identity descendant at cleanup. No production processes were signaled.

## Attention

Reviewed by Claude (source only).

The remaining limitations are the explicit one-second output policy, possible later holder EPIPE/SIGPIPE, flowing-output evidence scope, separate mailbox death-window risk, unresolved descendant ownership/live attribution, and non-green perf-map drift. Independent runtime re-execution by the reviewer was not claimed.
