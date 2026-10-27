# Retained watch overflow

Use generated data and a disposable real hived on the satellite only. Run all commands through an empty environment with explicit fake HOME, CODEX_HOME and CLAUDE_CONFIG_DIR, HIVE_NO_KEYCHAIN=1, and a fail-closed mock executable set in HIVE_TEST_SECURITY_BIN and first on PATH. No live database, socket, vendor home, or logs are read. See docs/performance/watch-overflow.md for the current protocol and memory limits. No repository verification skill was found; real socket and daemon integration tests supply the verification seam.

## Recipe and predeclared acceptance

`node scripts/perf/watch-overflow.mjs --out .proof/watch-overflow/run.json` creates 1000 stopped bees (900 archived), each with a generated 19000-byte seal. A forced 10000 ms tick gathers 512 pipelined renames before flushing. Warm up once, then retain five measured samples and every failure. No full Apiary mirror is folded: the collector verifies every event sequence, baseSeq, frame head and target cursor. The large-payload mode also verifies full generated seal bodies.

Acceptance declared before production edits: retained overflow has zero gaps and zero replacement snapshot bytes. Frames contain<=256 events and<=128KiB UTF-8 JSON including newline OR one indivisible oversized event. Genuine missing history still produces gap/snapshot; launch/reconnect resume is unchanged. Tests cover writes during catch-up, legacy projection gaps, large rows,20 watcher fairness,64 idleRPC connections, snapshots while backpressured, and cancellation.

`node scripts/perf/watch-overflow-receipt.mjs before.json after.json receipt.json` rejects failed/incomplete captures, incompatible populations and sequence/row/byte violations, then writes the compact map receipt. `node scripts/perf-map.mjs check receipt.json` judges the zero-snapshot invariant. Temporary raw captures/logs under .proof/watch-overflow remain uncommitted and accompany the parent handoff.

## Separate populations

- Default primary:512 renames/tick 10000, uninstrumented collector; before/after run sequentially, not interleaved. metal-2 (`trmd-metal-2`), Node 24.18.0, SQLite 3.53.1, source mode. Timings on this shared satellite are recipe evidence.
- `WATCH_DIAGNOSTICS=1`: separate matched series with in-daemon 1 ms monitorEventLoopDelay and 10 ms sampled RSS/heap, plus decoded audit-row counters. Whole-run delay includes boot, RPC writer traffic and catch-up; sampled memory is a lower bound on peak, not a heap bound.
- `WATCH_TICK_MS=100 WATCH_EVENTS=1536 WATCH_BURST_CHUNK=64 WATCH_BURST_DELAY_MS=100`: normal-tick paced-traffic control, separate from forced-overflow bursts.
- `WATCH_PAYLOAD_BYTES=20000` or`60000` with diagnostics:512 generated seal events per burst; byte-prefix/body correctness and decoded-row control, not a rename timing comparison.
- `node scripts/perf/watch-snapshot.mjs --out .proof/watch-overflow/snapshot-control.json`: linked full initial snapshot control on metal-2. No comparison with historical Studio timings.

## Physical ledger and measured primary counts

The removed snapshot serializes/transfers about 21MB already held by a connected receiver: its required request-time floor is zero. The retained changes still must cross the local socket once:133008B for 512 renames in this fixture, with rough JSON encoding floor 0.3–0.7 ms at 200–400MB/s, excluding SQLite, enrichment, scheduling and the receiver. Rung 1 removes replacement snapshot work; rung 2 shares same-cursor reads within a pass; rung 3 caps bytes/rows; rung 4 yields between necessary prefixes. No worker, persistence or cache was introduced.

Before: all five forced bursts produced a gap and 21191043B replacement snapshot. After: all five produced two 256-event frames totaling 133008B, largest 66614B, zero gaps/snapshot bytes, and exact target cursors. Collector first-frame-to-target convergence was 387–508 ms before and 16.4–21.1 ms after in the final-source repeat; it includes polling and receiver parsing and is not daemon or Apiary installation latency. The before/after fixture is 21.2MB, distinct from supplied T6's 24.0MB fixture. Real production overflow frequency is unknown.

The final SQL prefix uses octet_length(payload) metadata then hydrates a raw-byte prefix before JSON decode/enrichment. In core controls,512 x 20KB and 512 x 60KB payloads each decode 512 rows (1.0 decoded row per emitted row), with 86/256 prefixes. This is not 1.0 x total SQLite work: each frame still examines at most 256 row-size records. The final encoded cap remains after mirror enrichment and capability projection.

The first candidate (before the final normalized source-read limit guard) measured7.0–25.8ms. It remains retained separately as after.json. The final-source repeat in after-final-source.json measured21.02,19.59,16.45,16.58,17.41ms, with the same byte/frame/cursor counts; this is the final source evidence.
