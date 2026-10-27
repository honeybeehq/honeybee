# Connected retained watch catch-up

Retained audit history is streamed as the existing `delta` frame with `baseSeq`,
`seq`, and `events`. Row overflow no longer means a gap. Each frame has at most
256 events and at most 128 KiB of UTF-8 JSON including the newline, except that
one indivisible oversized audit event may occupy a frame by itself. That exception
is necessary to preserve complete events without inventing a gap.

The store reads a contiguous prefix selected by stored payload byte lengths before
decoding JSON or enriching account and thread-operation events. A bounded scan of
at most 256 size records uses SQLite `octet_length`, then hydrates the prefix.
The raw byte estimate includes a 128-byte allowance per row; the final frame limit
is checked after mirror enrichment and connection-specific capability projection.
Metadata work is still performed for each prefix. A decoded-row count is not a
claim about all SQLite work, pages read, or universal heap use.

The first pass runs in the ordinary daemon flush. Connected watchers share reads
when their cursors match in a pass. Subsequent passes are single-flight and paced
by a 1 ms timer. A rotating watcher set prevents idle RPC connections from taking
watcher slots. Each pass sends at most one frame per watcher, stops after eight
ready watchers or a soft 4 ms budget, and checks the current store head again on
the next pass. One large row, projection, SQLite read, or serialization can exceed
the soft time budget; it is not a preemptive CPU limit. `rpc.watch.pass` measures
the actual pass including read, enrichment, projection, encoding, and write.

`socket.write(false)` accepts the complete frame. Its sequence becomes the current
cursor exactly once, then `writableNeedDrain` prevents further watch work until
drain. This also respects backpressure from snapshots and ordinary RPC responses
on that socket. It bounds additional watch queue growth, not all responses a
client may request, kernel buffers, fixture memory, or the size of one audit row.
No backlog frames or enriched arrays survive between passes. A snapshot aligns the
current cursor, so pending catch-up rebuilds from that cursor; close cancels the
connection, and server shutdown cancels its timer.

A missing first, interior, or trailing sequence still emits a genuine gap and
holds that watcher until `snapshot` or a new `watch` aligns it. Existing legacy
delivery-confirmation projection may also deliberately emit a gap. Apiary's
existing consumer requests a snapshot on the same connection for an uncovered
gap; a failed snapshot reconnects with a full watch. A regressed store head closes
the connection, because a gap at or below the installed cursor would be ignored.
Launch/reconnect resume is unchanged and remains outside this work.

The executable recipe is `scripts/perf/watch-overflow.mjs`. Its interpretation and
acceptance are in `.agents/skills/perf-honeybee/workloads/watch-overflow.md`.
Generated fixtures, daemon homes, sockets, logs, and receipts are disposable and
isolated. Satellite results do not establish installed Apiary or Studio latency,
production overflow frequency, or a bound on Apiary transaction duration.
