# Native process identity and zombie observations

The existing Node-API peer credential bridge also inspects one requested process. No shell, `ps`, full process census, or PID-only zombie cache participates. Darwin uses public-SDK `proc_pidinfo(PROC_PIDTBSDINFO)` with an exact structure-length check, `pbi_status == SZOMB`, and the full second/microsecond start token. Linux parses bounded `/proc/<pid>/stat` records, including state, start ticks and wait status; its identity also includes the boot UUID. Both platforms read the birth twice and refuse a changed incarnation.

Inspection returns `present`, `gone`, or `unavailable`. Present observations distinguish live processes from zombies. Permission errors, short reads, invalid artifacts and malformed persisted identities are unavailable, never exit evidence or signal permission. Epoch milliseconds exist only for legacy discovery; exact tokens govern subsequent effects. A successful read does not make inspection and a later signal atomic.

## Durable authority and upgrade

`runtimes.process_identity` is nullable and internal, with no RuntimeRow wire change. Opening a store adds the column and `meta.runtime_process_identity_schema=1` in the existing open transaction. Compatibility schema remains 44. Opening never parses or backfills identity content; invalid content reads as unavailable. New PID writes without a captured token carry a pending-new-start marker, which cannot enter legacy discovery. A trusted new-start record can replace that marker with its captured exact token.

Null identities from older daemons can bind once through the serialized Store write path. The original generation, PID and timestamp must still match. The five-second tolerance is discovery only. HSR additionally authenticates the connected private-socket peer using kernel credentials and birth and requires matching host/generation status. Tmux additionally checks the daemon-configured same-uid socket, canonical paths, a 0700 directory and stable device/inode; exactly one pane in the derived session/window must report the persisted PID. A compare-and-set stores the exact token and emits `legacy_birth_bound` with a count only. An already-bound or malformed row cannot match tolerance again.

## Unresolved evidence

Unresolved identity retains the existing booting/running/idle state without claiming a new live observation. It neither invents a crash nor requires revival. Mail admission remains independent of runtime state. Boot reconciliation still stops proven-gone processes as `machine_restart`; unavailable observations are retained explicitly. Boot-hang policy skips unresolved rows.

One background timer retries at most sixteen rows per second, checking current generation each time. Host connection attempts have a two-second bound. The timer stops at daemon shutdown. Stop and Archive stay in the existing durable command queue while unresolved; repeat requests share a generation-specific key unless the caller already supplied one. The RPC reports `stop pending process identity proof`. Binding releases the existing command; proven absence settles the stopped fact without a signal. A typed observation failure during command execution returns the same command to its hold, without exhausting retries.

After ten minutes health/doctor names `process_identity_unresolved` and reports a count; a bee's CLI status reads `identity unresolved`. These are optional diagnostics, not new lifecycle or runtime states. Resolved responses omit the diagnostic keys. The warning's first-observation timestamp is diagnostic audit evidence, not process authority. A permanently unobservable process can remain unresolved indefinitely; the warning makes that safety trade-off visible.

## Proof and rollback

`scripts/probe-process-identity.mjs <artifact-directory>` exercises a real live child, an unreaped zombie and the reaped PID. On Darwin it also launches an own child under an additional deny-only process-info profile and requires permission-denied/unavailable. Linux tests compile an EPERM-injected bridge and verify the same unavailable arm. Darwin SDK compilation and the physical probe must pass before merge.

`scripts/probe-runtime-rollback.mjs <fresh-root> <fleet-source> <public-source>` runs built old daemons against isolated migrated fixtures. Its controller must supply uid 1000, zero capabilities, NNP, a new session and an empty private network namespace. It reads the runtime by RPC and stops only its own directly spawned daemon. Dependencies are copied, not linked, from an owned tree with an identical lockfile; no install or network occurs.

The fleet target is `4c3fd63c446f055fccb097b264707fa251dc4d95`. The public target is `55fa1e4748208bbca05ae328512a237739c4f774`. Downgrade to 55fa1e47 refuses schema 44 (it speaks 31) on any schema-44 store, including one migrated without this PR; downgrade across schema bumps was never supported; it closes when the next public release ships.

The v1 `src/hsr/processIdentity.ts` census remains a separate follow-up. This change removes the two v2 psutil subprocess routes.

## Retained tmux cleanup

Fresh tmux runtimes retry an unavailable initial capture only through their retained owned socket fingerprint and exact pane, session, window and PID proof, followed by a fresh native birth check. A matching execution-host PID and start token cannot replace a conflicting bound token or bypass the authenticated legacy compare-and-set.

Exit cleanup never kills a session by name. On the verified owned socket, one synchronous tmux `if-shell -F` command checks the original pane, session and window IDs, recorded PID, dead-pane flag and single-member counts before its `kill-pane` branch. A replacement pane or extra member is retained. Filesystem/socket verification and the subsequent tmux command are separate operations; same-uid replacement within that window is not excluded.

Retained cleanup is diagnostic audit evidence, never adoption or signal authority. Matching generation/reason events are deduplicated. `runtime.tmux_cleanup_retained` makes health expose the optional `tmuxCleanupRetained` count and doctor warn. The bounded observation pass resolves a report only after a successful, owned-socket membership query proves the recorded pane absent, or exact verified removal succeeds, and emits `runtime.tmux_cleanup_resolved`.

A missing socket under the same verified parent moves the report to `socket-gone-unverifiable`. It is not resolved: health exposes optional `tmuxCleanupInformational`, doctor prints informational text and does not fail on that alone. Reappearance under the same parent device/inode is re-evaluated through owned-socket proof. Unknown initial locators remain unresolved and confer no authority. Both optional counts are omitted at zero. Malformed diagnostic content remains a warning rather than silently resolving.

Non-preserving shutdown disposes runtimes before closing the Store so retained tmux cleanup is durable. The default preserving shutdown keeps its existing order: close Store, close telemetry, then detach without disposal or tmux commands. The daemon entry point selects non-preserving shutdown only for its explicit test-runtime reaping switch; deployed default shutdown preserves runtimes.

Tmux disposal signals only the exact bound birth, then waits at most two seconds per retained runtime for native exit and the original pane's dead state. Removal uses the same single-server-command conditional as exit cleanup: original owned socket, exact session/window/pane/PID, dead pane, sole pane and sole window. An extra or replacement member, unavailable proof, or an expired deadline retains the diagnostic instead of killing the session. The regression records the private server's kernel birth and confirms native exit after sole-pane disposal; an extra live member remains running and counted.

Failed tmux starts never kill a session by name. A duplicate-name refusal creates nothing and has nothing to clean. A successful creation followed by an inspection failure retains a count and only the locator returned by that creation; an unavailable pane locator remains null and cannot prove pane absence. No failed-start path grants adoption or signal authority.

Disposal passes the remaining monotonic two-second budget into every tmux subprocess, including the atomic cleanup command. Expiry or a command timeout retains the diagnostic without attempting a later cleanup command or recording resolution. The normal preserving shutdown does not enter this path.
