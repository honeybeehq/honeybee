# Daemon start and store upgrade — Honeybee contract (HON-34, 2026-11-24)

Protocol stays `v2/2`. Additive: `health` gains a `boot` field, the hello frame gains an optional `boot` field, and the closed error list gains `daemon_starting`.

A daemon that is still starting answers. It takes the store lock, binds its socket, and only then backs up, verifies and migrates the store and re-adopts sessions. Before this contract the socket appeared only after all of that, so the first start after a schema bump looked dead (ENOENT, "not running") for as long as the backup took.

## Boot order

1. Open the store and take its SQLite exclusive lock. This is the single-daemon lock (B9): a second daemon stops here with `SecondWriterError`. The socket is bound only after the lock, so only the lock holder ever unlinks a stale socket.
2. Remove abandoned backup partials (see below).
3. Bind the socket and write the endpoint record. From here on, `health` answers.
4. If the stored schema is older than this build's, take the pre-migration backup: an async page copy (`store_backup`, with byte progress), then a full `integrity_check` plus sha256 of the copy in a worker thread (`store_backup_verify`), then publish the receipt.
5. Migrate (`store_migrate`). This runs on the main thread; a long migration blocks `health` until it ends.
6. Start services and re-adopt surviving runtimes (`boot_reconcile`).
7. Ready: every verb answers.

Runner hosts are detached and keep running throughout; the ready daemon re-adopts them by stored pid and birth identity, with the same generation.

## Wire shape

`health` while starting:

```json
{"protocol":"v2/2","pid":4123,"startedAt":1764000000000,"uptimeMs":41200,
 "boot":{"state":"starting","phase":"store_backup","phaseStartedAt":1764000000400,
         "schemaFrom":61,"schemaTo":62,
         "progress":{"bytesDone":560000000,"bytesTotal":1305690112,"fraction":0.429},
         "etaMs":130000}}
```

`health` when ready: the full health result plus `"boot":{"state":"ready","readyAt":1764000095000}`. An older daemon sends no `boot`; treat that as ready.

| field | meaning |
|---|---|
| `state` | `starting` or `ready` |
| `phase` | closed set: `store_backup`, `store_backup_verify`, `store_migrate`, `boot_reconcile` |
| `phaseStartedAt` | epoch ms when the current phase began |
| `schemaFrom`, `schemaTo` | the upgrade in progress; `null` in `boot_reconcile` |
| `progress` | `{bytesDone, bytesTotal, fraction}` during `store_backup`; `null` otherwise (`integrity_check` reports no progress) |
| `etaMs` | estimated ms until the store upgrade finishes, or `null` |

Every other verb while starting is refused:

```json
{"id":7,"ok":false,"error":{"code":"daemon_starting",
  "message":"Honeybee is starting: backing up the store before the schema 61→62 upgrade, 560 MB of 1.3 GB (42%), about 2 min left (41s in this step). Sessions keep running.",
  "details":{"boot":{ "...": "the same boot object as health" }}}}
```

Nothing is accepted and then dropped: a refused `send` was never queued. Retry it.

The hello frame the daemon writes on connect carries the same object while starting, and omits it when ready:

```json
{"protocol":"v2/2","capabilities":["..."],"identity":{"...":"..."},"instance":{"id":"…","dataDir":"…"},
 "boot":{"state":"starting","phase":"boot_reconcile","phaseStartedAt":1764000094000,"schemaFrom":null,"schemaTo":null,"progress":null,"etaMs":null}}
```

## Clients

A starting window exists on every start, not only on upgrades: `boot_reconcile` usually lasts tens of milliseconds to about a second. A client that treats "the socket accepts" as ready sees `daemon_starting` in that window.

- Read `boot` in the hello frame, or retry on `daemon_starting`.
- The `hive` CLI holds up to 15 s while the hello says `starting`, printing the boot sentence every 5 s, then sends the request and prints the refusal (exit 1, `error.code` `daemon_starting` with `--json`). `hive health`, `hive daemon status` and `hive daemon stop` never hold; they show the starting state.
- `hive health` exits 75 while starting and 0 when ready, so a script that loops `until hive health` still waits for ready. `hive health --json` prints the starting result either way.
- Old CLIs (a runtime older than this contract, such as an Apiary-pinned runtime) do not hold: they fail at once on `daemon_starting`.

## The estimate

`etaMs` is an estimate. It can be off by a factor of two under load, in either direction. Show it as "about N minutes", never as a deadline.

- `store_backup`: `null` until 2 s and 2% of the copy have passed. Then the copy's remaining time from the measured page rate, plus the projected copy time × a verify-to-copy ratio.
- `store_backup_verify`: ratio × the measured copy time, minus the time already spent verifying; `null` once that is used up, never negative.
- `store_migrate`, `boot_reconcile`: `null`.

The ratio grows with store size because `integrity_check` is superlinear. It was measured on stores built by real Honeybee writes (Linux, under load): 5.0 at 0.4 GB, 5.9 at 1.3 GB, 6.2 at 3 GB, interpolated on log size. Measured first-start totals were 5.8 s, 21 s and 52 s; the same store ran 14–23× slower on a heavily loaded Mac.

## Abandoned partials

A daemon killed during the backup leaves `<store>.backups/<ts>-<uuid>.partial`, as large as the store. At step 2, while holding the store lock, the daemon removes files named `<ts>-<uuid>.partial`, `<ts>-<uuid>.json.partial` and their `-journal`, `-wal`, `-shm` siblings, and logs `store.backup.partial_removed name=… bytes=…`. Completed backups (`.sqlite3` with its `.json` receipt) are never touched here.

Cleanup never stops a start. An entry that is not a regular file, or that cannot be removed (permissions, read-only or immutable, any filesystem error), is skipped and logged as `store.backup.partial_skipped name=… reason=…`. The same best-effort rule applies to retention after a backup publishes.

Why every partial found at step 2 is an orphan: only a process holding the store's exclusive lock writes partials. The daemon writes them during the upgrade and during `store.backup`. `hive store backup` goes through the daemon when one answers, and otherwise uses the offline backup, which holds the exclusive lock for the whole copy. `hive store restore` holds the lock and writes its temporary file next to the store, not in `.backups`. So while the daemon holds the lock, no other writer of partials can be running.

## Retention

Unchanged here, and the owner's decision: retention keeps the newest 10 backups, plus the newest backup of every schema version ever seen. It has no age or size bound, and runs only when a new backup publishes.
