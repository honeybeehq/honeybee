# Daemon start and store upgrade — Honeybee contract (HON-34, 2026-11-24)

Protocol stays `v2/2`. Additive: `health` gains a `boot` field, the hello frame gains an optional `boot` field, and the closed error list gains `daemon_starting`.

A daemon that is still starting answers. It takes the store lock, binds its socket, and only then backs up, verifies and migrates the store and re-adopts sessions. Before this contract the socket appeared only after all of that, so the first start after a schema bump looked dead (ENOENT, "not running") for as long as the backup took.

## Boot order

1. Open the store and take its SQLite exclusive lock. This is the single-daemon lock (B9): a second daemon stops here with `SecondWriterError`. The socket is bound only after the lock, so only the lock holder ever unlinks a stale socket.
2. Remove abandoned backup partials, then apply retention: keep the two newest completed backups (see below).
3. Bind the socket and write the endpoint record. From here on, `health` answers, within the limits in [Staying responsive](#staying-responsive-hon-47).
4. If the stored schema is older than this build's, take the pre-migration backup: an async page copy (`store_backup`, with byte progress), then a full `integrity_check` plus sha256 of the copy in a worker thread (`store_backup_verify`), then publish the receipt and apply retention again.
5. Migrate (`store_migrate`). This runs on the main thread in one transaction and yields to the event loop between migration steps.
6. Start services and re-adopt surviving runtimes (`boot_reconcile`). The per-session passes yield to the event loop between sessions.
7. Ready: every verb answers.

Runner hosts are detached and keep running throughout; the ready daemon re-adopts them by stored pid and birth identity, with the same generation.

## Staying responsive (HON-47)

`store_migrate` and `boot_reconcile` run on the main thread, but they yield to the event loop at least every 20 ms of work (`setImmediate`). Between slices the daemon accepts connections, sends the hello and answers `health`. Before HON-47 both phases ran in one synchronous stretch. With 3,680 sessions on 4 busy Linux cores, `boot_reconcile` lasted 3.7–3.8 s, the socket answered nothing, and the CLI timed out after 3 s.

Where the yields are:

- `boot_reconcile`: the passes over every session yield between sessions and read sessions in pages of 256. These passes are the Cell registry backfill, the scan for surviving runtimes, the mailbox wake sweep, the start-attention flag pass and the scratch-directory sweep. The Cell retention history (last passes, daily cap, evictions) is read in one backward scan of the newest 500,000 audit rows, 20,000 rows per chunk, with a yield between chunks. Before, it took five unchunked scans of that window.
- Adoption is not split. Adopting the surviving runtimes, the store reconcile, reaping orphans and the handover census run in one event-loop turn, as before. Their cost grows with the number of live runtimes, not with the number of sessions.
- `store_migrate`: the migration transaction yields between migration steps and between sessions in the per-session backfills. It stays one transaction, so a failed migration still rolls back completely.

Limits:

- One SQL statement cannot yield. A migration step that is one long statement (a table rewrite, an index build) blocks `health` for as long as that statement runs. Write a long migration as batches with a yield between them; `CoreStoreOptions.testMigrationSteps` is the lab hook that holds `store_migrate` with batched work.
- Start steps outside these passes (opening services, building drivers, single store reads) do not yield. They are not per-session loops.
- During a yield nothing else can change sessions: every verb except `health` is refused with `daemon_starting`, and the tick loop and the identity-recovery timer start only after ready. Driver events from adopted runtimes may arrive during the mailbox sweep; they are buffered for the first tick, as they were before.

Measured (HON-47 lab, `scripts/lab/hon47-starting-yield.mjs`, idle 64-core Linux, `hive health` every 0.5 s plus an in-process `health` every 100 ms):

| case | before | after |
|---|---|---|
| 60,000 sessions, `boot_reconcile` 8.5–10.6 s | 3 of 3 `hive health` runs exit 1, "not reachable … start it" | 18 of 18 exit 75 with `boot_reconcile`; in-process `health` p50 10 ms, max 142 ms |
| `store_migrate` held 10 s by batched lab work | 3 runs time out without a hello | 20 of 20 exit 75 with `store_migrate`; max 25 ms |

Busy small hosts were not measured; expect every slice there to be several times longer.

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

A starting window exists on every start, not only on upgrades. `boot_reconcile` grows with the number of sessions: 3.7–3.8 s for 3,680 sessions on 4 busy Linux cores, 3.5 s for 20,000 lab sessions on an idle 64-core host. A client that treats "the socket accepts" as ready sees `daemon_starting` in that window.

- Read `boot` in the hello frame, or retry on `daemon_starting`.
- The `hive` CLI holds up to 15 s while the hello says `starting`, printing the boot sentence every 5 s, then sends the request and prints the refusal (exit 1, `error.code` `daemon_starting` with `--json`). `hive health`, `hive daemon status` and `hive daemon stop` never hold; they show the starting state.
- `hive health` exits 75 while starting and 0 when ready, so a script that loops `until hive health` still waits for ready. `hive health --json` prints the starting result either way.
- Old CLIs (a runtime older than this contract, such as an Apiary-pinned runtime) do not hold: they fail at once on `daemon_starting`.

### A socket that does not answer (HON-47)

The CLI tells "no daemon" apart from "a daemon that is starting or busy". A live socket that does not answer is treated exactly like a starting daemon, so every client that already retries `daemon_starting` or `hive health` exit 75 retries it too.

| what the CLI sees within its 3 s connect timeout | meaning | `hive health` | other commands | `error.code` |
|---|---|---|---|---|
| `ENOENT` (no socket file) or `ECONNREFUSED` (nothing listening) | no daemon | exit 1 | exit 1 | `socket_unreachable` |
| the connection is accepted but no hello arrives | starting or busy | exit 75 | hold up to 15 s, then exit 1 | `daemon_starting` |
| the socket file exists but the connection is not accepted | starting or busy | exit 75 | hold up to 15 s, then exit 1 | `daemon_starting` |
| `EAGAIN` (the listen queue is full) | starting or busy | exit 75 | hold up to 15 s, then exit 1 | `daemon_starting` |

Only the first row advises starting a daemon:

```
hive: daemon not reachable at /run/hive/hived.sock (ENOENT) — start it with: hive daemon run (or daemon start)
```

A live socket that does not answer prints this on stderr instead, for every command:

```
hive: error (daemon_starting): Honeybee is starting or busy: the daemon at /run/hive/hived.sock accepted the connection but sent no hello within 3 s. It is running, so do not start another; retry shortly (hive health shows its state).
```

With `--json`, stdout carries `{"error":{"code":"daemon_starting","message":…,"details":{"socketPath":…,"cause":…,"boot":null}},"daemonTarget":…}`. `details.boot` is `null` because the daemon said nothing; a real refusal carries the boot object. Commands that hold while starting keep retrying a silent socket until their 15 s hold runs out. Reads never fall back to the read-only store here, since the running daemon holds the store's lock.

Pollinate (f594322c and later) retries a hive call while `hive health` exits 75, the `--json` error code is `daemon_starting`, or stderr contains `error (daemon_starting): `. A Pollinate job that fires while the socket is silent therefore waits and runs once after the daemon is ready; it needs no Pollinate change.

A daemon with this change answers within its 20 ms slices, so a silent socket now means a non-yielding step longer than 3 s, or a host too loaded to schedule the daemon. CLIs older than HON-47 still print "not reachable … start it" in that case.

## The estimate

`etaMs` is an estimate. It can be off by a factor of two to six under load: the 29912b6e release lab showed 25 s with 6 s left. Show it as "about N minutes", never as a deadline.

A better estimate is not cheap. `integrity_check` reports no progress through `node:sqlite`, so the verify phase can only be projected from the copy time. What would help is refitting the verify-to-copy ratios below from measured upgrades: the `boot.phase` lines in `hived.log` time each phase. That is a data change in `bootStatus.ts`, but it needs a measured population that has not been collected yet.

- `store_backup`: `null` until 2 s and 2% of the copy have passed. Then the copy's remaining time from the measured page rate, plus the projected copy time × a verify-to-copy ratio.
- `store_backup_verify`: ratio × the measured copy time, minus the time already spent verifying; `null` once that is used up, never negative.
- `store_migrate`, `boot_reconcile`: `null`.

The ratio grows with store size because `integrity_check` is superlinear. It was measured on stores built by real Honeybee writes (Linux, under load): 5.0 at 0.4 GB, 5.9 at 1.3 GB, 6.2 at 3 GB, interpolated on log size. Measured first-start totals were 5.8 s, 21 s and 52 s; the same store ran 14–23× slower on a heavily loaded Mac.

## Abandoned partials

A daemon killed during the backup leaves `<store>.backups/<ts>-<uuid>.partial`, as large as the store. At step 2, while holding the store lock, the daemon removes files named `<ts>-<uuid>.partial`, `<ts>-<uuid>.json.partial` and their `-journal`, `-wal`, `-shm` siblings, and logs `store.backup.partial_removed name=… bytes=…`. Completed backups (`.sqlite3` with its `.json` receipt) are never touched by this cleanup.

Cleanup never stops a start. An entry that is not a regular file, or that cannot be removed (permissions, read-only or immutable, any filesystem error), is skipped and logged as `store.backup.partial_skipped name=… reason=…`. The same best-effort rule applies to retention after a backup publishes.

Why every partial found at step 2 is an orphan: only a process holding the store's exclusive lock writes partials. The daemon writes them during the upgrade and during `store.backup`. `hive store backup` goes through the daemon when one answers, and otherwise uses the offline backup, which holds the exclusive lock for the whole copy. `hive store restore` holds the lock and writes its temporary file next to the store, not in `.backups`. So while the daemon holds the lock, no other writer of partials can be running.

## Retention (HON-46, 2026-11-25)

The owner's decision: keep the two newest completed backups and delete the rest. No schema-version exemption, no age or size bound.

A completed backup is a `<ts>-<uuid>.sqlite3` with its `<ts>-<uuid>.json` receipt, where the receipt names itself and that copy. Backups are ordered by the receipt's `createdAt`.

Retention runs:

1. At every daemon start, at step 2, under the store lock.
2. After a new backup is published: its copy has passed `integrity_check` and its receipt is in place. A copy still being written or verified is a `.partial` and is never counted, so nothing is pruned on its account before it is verified. A daemon killed during the backup leaves the old backups as they were.

The daemon logs `store.backup.removed name=… bytes=… kind=…` for each deletion and `store.backup.retention kept=… newest=… removed=… removed_bytes=… skipped=…` once per pass. `hive store backup` prints one line after the receipt, e.g. `kept 2 backups (newest 2026-11-25T04:55:07.188Z); removed 3 older (3.0 MB)`; `--json` carries the same facts as `retention`.

| entry | treatment | `kind` |
|---|---|---|
| completed backup beyond the two newest | `.sqlite3` deleted, then the receipt | `older_backup` |
| `.sqlite3` with no receipt | deleted | `orphan_copy` |
| recognized receipt whose `.sqlite3` is gone | receipt deleted | `dangling_receipt` |
| receipt that is unreadable or names another path (moved data dir) | left alone, logged `unrecognized_receipt` | — |
| `.partial` and its siblings | never touched; the abandoned-partial cleanup owns them | — |
| any other file name | ignored | — |

A `.sqlite3` with no receipt is an orphan, not a backup. Publishing renames the verified copy into place and then writes the receipt, so the only ways to get a copy without a receipt are a crash between those two steps or a receipt deleted by hand. `hive store restore` takes a receipt and checks the copy against its sha256, schema and DDL digest; a copy without one cannot be restored, so it is not one of the two kept.

Retention never stops a start or fails a backup. An entry that is not a regular file, or that cannot be removed (permissions, an immutable file, any filesystem error), is skipped and logged as `store.backup.retention_skipped name=… reason=…`. A backup whose copy cannot be removed keeps its receipt, so the next pass retries it.
