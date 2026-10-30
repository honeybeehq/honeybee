# Transcript segment objects — Honeybee contract (H4, 2026-10-30)

Capability `transcript.segments.v1`. Schema **v52** (additive: `transcript_segment_objects`, `transcript_segment_cursors`). Protocol stays `v2/2`. Flag `transcripts.segments.enabled` (default **false**; the flag is the rollback: off, nothing is cut and the session log stays the only copy, exactly as before).

Honeybee cuts each bee's session log into **segments** at the source, projects each segment once, and pushes raw plus projected objects to the workspace object store, content-addressed. Home keeps pointers; clients never parse. This is the producer half of Apiary's S4 (`services/apiaryd/src/domains/hive/transcriptSegments.ts`); once a node advertises the capability with `deployInfo.transcriptSegments.enabled = true`, Apiary stops cutting that node's logs itself and mirrors Honeybee's pointer rows.

## When a segment is cut

- **Turn end.** Every non-synthetic `turn_ended` observation and every runtime `exited` observation schedules a cut for that bee (one in flight per bee; a request during a cut re-runs once it ends). The cut takes every complete line appended since the cursor and emits segments of at most `maxLines` (1024) lines or `maxRawBytes` (1 MiB) raw bytes; the remainder is always emitted too, so nothing waits for a size threshold. A torn last line (no newline yet) waits for the next cut.
- **Rotation.** When the bee's `sessionLogPath` differs from the cursor's path (a handoff opened a new v23 log file), the old file's remainder is cut first, then the cursor moves to the new file with `byteOffset 0` and a fresh projector; line numbering continues.
- **Boot.** The daemon schedules a cut for every bee whose runtime is stopped (catch-up after a crash or a deploy). Boot cuts write pointer rows without `transcript_segment_object.put` audit rows, so a 31k-segment catch-up does not flood the audit log or the watch stream; consumers read them through `transcript.segments`.
- Never mid-turn: a cut needs a `turn_ended` or `exited` fact. A live runtime's tail stays in the session log only, where `hive tail -f` and Apiary's live stream read it.

Deviation from Apiary's S4 cutter, which cut by size and a 10-minute idle timer: Honeybee cuts at turn boundaries (plus size caps inside a long turn). Readers see the same thing — dense ordinals, monotone line numbers, byte-exact raw ranges.

## How a cut runs

Every cut runs in a worker thread (`transcriptSegmentWorker.ts`, bundled as `dist/v2/transcript-segment-worker.js`): it streams the file in 1 MiB reads (growing to at most 64 MiB when a single line is longer than the window), hashes and projects each complete line, groups lines across reads up to the caps, compresses and writes the objects, and returns the pointer rows plus the cursor after each segment. The daemon thread only inserts the rows. At most one cut runs at a time (`maxWorkers`, default 1) and the queue is paced 25 ms between bees, so a catch-up over thousands of stopped bees is a background trickle, not a burst on the RPC lane. A rejected projector checkpoint replays the file prefix in the same chunked way; a prefix over 64 MiB starts a fresh projector and logs `transcripts.segment.projector_reset`.

## What a segment is

| | |
|---|---|
| raw object | the exact bytes of the session log from `byteStart` to `byteEnd` (newlines included), zstd level 3; `rawRef` = sha256 of the compressed bytes, `rawSize` uncompressed, `rawBytes` compressed |
| projected object | the S4 text format, zstd level 3: header `apiary-transcript-segment\t1\t<projectionVersion>\t<beeId>\t<firstLine>\t<lastLine>\t<harness>` then one `line_no\tbyte_offset\traw_bytes\traw_sha256\tobserved_at\tevents` per line, where `events` is the JSON array Honeybee's own projector (`createTranscriptProjector(harness)`, `TRANSCRIPT_PROJECTION_VERSION`) returned for that line |
| line numbering | 1-based, blank lines skipped, dense per bee across log files; `byte_offset` is the line's offset in its file; `raw_sha256` hashes the line text without a trailing CR |
| `digest` | sha256 over the concatenated per-line `raw_sha256` hex digests, in order |
| `observed_at` | the cut time for every line of the segment (Honeybee does not follow lines live) |
| `epoch` | null until a log file shrinks under its cursor; then a fresh uuid marks the new lifetime while line numbers keep climbing |
| `path`, `logSegmentId` | the file the segment came from and its v23 transcript segment (handoff run) |

The projector state is checkpointed with the cursor after every segment and restored at the next cut; a rejected checkpoint replays the file prefix (bounded at 64 MiB, then the projector starts fresh and `transcripts.segment.projector_reset` is logged).

Projection version: Honeybee writes `TRANSCRIPT_PROJECTION_VERSION` **8**. Version 8 folds Apiary's compat repairs (`transcriptProjectorCompat.ts`, compat 11) into the registry projector (`transcript-repairs.ts`, `transcript-context.ts`): queued-command steering as user messages, request-context usage, Codex context inventories, snapshots, invalidations and baselines, Claude compaction boundaries and summaries, sidechain thread ids, answer phases and result finish reasons. Proven byte-identical to Apiary's compat projector on real claude, codex and grok logs (`.proof/h-track/h4/projector-equivalence.json`); Apiary maps 8 ↔ 11 and drops its repairs on re-pin. `createNativeTranscriptProjector` still returns the unrepaired harness projector.

## Store

`TranscriptObjectStore { locator, putBytes, stat, read }`. Today one implementation: a directory, default `<data-dir>/transcript-objects`, laid out `blobs/transcript-archives/<ref>` — the same layout Apiary's local archive store uses, so a local-only workspace can point both at one directory. Writes are temp-file + fsync + rename; an existing object of the right size is reused. S3/R2 lands behind the same interface later. Objects need zstd in `node:zlib` (Node 22.15 or newer); the module loads on older Node and the first cut fails with a typed message instead of a link error.

**Orphans and budget.** An object no pointer row references (a crash between put and row, a deleted bee's cascade, an epoch reset) is swept one minute after boot once the catch-up backlog drains and every 24 h after that, with a one-hour grace for in-flight puts (`transcripts.objects root= objects= bytes= orphans_swept=`). The count and bytes ride on `deployInfo.transcriptSegments.objects` and on the capacity fact as `capacity.transcriptObjects`, and `hive health` prints them.

## Pointers

`transcript_segment_objects` rows (one per segment, `UNIQUE (bee_id, ordinal)`, dense ordinals enforced by `putTranscriptSegmentObject`), written in one transaction with the advanced cursor; every row is also an informational `transcript_segment_object.put { segment }` audit row, so the watch stream carries it as a delta. The rows are **not** in the snapshot (a bee accrues thousands); read them with:

```
transcript.segments { beeId, afterOrdinal?, limit? } → { beeId, segments: TranscriptSegmentObjectRow[], store: { kind: "directory", root } | null, cursor }
deployInfo.transcriptSegments → { enabled, store, projectionVersion, maxLines, maxRawBytes }
```

CLI: `hive transcript <bee> --segments` lists the pointers; `hive transcript <bee> --from-objects [--raw]` renders the transcript from the object store alone (daemon down → the read-only store plus the configured store directory, labeled STALE). That is the gate: a killed executor's bees read to their last segment from the objects alone. A final line without a trailing newline is not cut until the newline lands, so `--from-objects` lags the session log by that one torn line while a turn is being written.

`transcript.segments` returns at most 1000 rows by default and refuses `limit` above 10000; page with `afterOrdinal`.

## Config

```
transcripts: { segments: { enabled: false, storeDir: "<data-dir>/transcript-objects", maxLines: 1024, maxRawBytes: 1048576 } }
```

Invalid values warn (`config.transcripts.invalid`) and fall back to the default; they never refuse boot.
