# Watch snapshot

Run `node scripts/perf/watch-snapshot.mjs --out .proof/watch/run.json`. The driver creates generated SQLite state and its own daemon/socket/home, never the live instance. Retain all samples and failures. Five samples per receiver support ranges/median, not p95. Request-to-last-byte excludes hello and reports JSON parse separately. Compare accumulating-string and chunk-list receivers against the same daemon; production RpcClient is also exercised. Shared-host results are recipe proof, not a Studio baseline. Target predeclared: every measured 20 MB response under 300 ms on Studio, with exact content and sequence preserved.

Do not remove fields in this task. Snapshot reduction and sequence resume belong to Instant presence.
