# Watch snapshot

Run `node scripts/perf/watch-snapshot.mjs --out .proof/watch/run.json`. The driver creates generated SQLite state and its own daemon/socket/home, never the live instance. Retain all samples and failures. Five samples per receiver support ranges/median, not p95. Request-to-last-byte excludes hello and reports JSON parse separately. Compare accumulating-string and chunk-list receivers against the same daemon; production RpcClient is also exercised. Shared-host results are recipe proof, not a Studio baseline. Target predeclared: every measured 20 MB response under 300 ms on Studio, with exact content and sequence preserved.

Do not remove fields in this task. Snapshot reduction and sequence resume belong to Instant presence.

Current-source linked control (2026-10-27): the identical generated snapshot recipe ran on metal-2, Node 24.18.0 / SQLite 3.53.1, with env -i, fake vendor homes, keychain disabled and a fail-closed mock security bridge. All 15 measured snapshots preserve counts/content/sequence; each response is 21,053,034 bytes. RpcClient last-byte times are 218–277 ms; chunk-list receiver 243–300 ms; the accumulating-string reference takes 3.28–3.41 seconds. These are separate receiver algorithms on a shared satellite, not a before/after change or Studio budget claim. Raw capture: .proof/watch-overflow/snapshot-control.json (uncommitted handoff evidence).

Final-source repeat after the normalized read-limit guard: snapshot-final-source.json retains the same exact21,053,034-byte responses and all15 samples. Observed last-byte ranges (ms): accumulate 2847.2–3134.6, chunks 247.8–278.6, RpcClient 212.3–280.0. No Studio or before/after latency claim.
