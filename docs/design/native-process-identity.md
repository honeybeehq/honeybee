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
