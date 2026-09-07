# Daemon command predicates

Commit `f3ed9b75`, integrated as `9651013f`, replaces two full command-history reads with three cached existence queries. Stop recovery still requires a strict JSON boolean `thenRevive: true`. Pending intent retains its exact status and generation rules, including null-generation fallback and future retry times. The public `listCommands()` results remain complete and ordered. There is no schema or index change.

The parent measured exact production `bcd85a8c` before and `f3ed9b75` after on the same Apple M4 Mac mini, Node 24.18.0, and OS boot. The unchanged 24-case ruler ran sequentially with 15 uninstrumented samples per case. `compare-read-hotspots.mjs` accepted only the two expected source changes. Raw reports and the strict result are `evidence/mini-read-hotspots-{before,after-d05}.json` and `mini-read-hotspots-d05-comparison.json`.

| Fixture | Before median CPU | After median CPU |
| --- | ---: | ---: |
| Recovery with 1,000 settled commands | 2.358 ms | 0.144 ms |
| Recovery with 100,000 settled commands | 174.552 ms | 11.854 ms |
| Pending-stop check with 1,000 settled commands | 1.238 ms | 0.034 ms |
| Pending-stop check with 100,000 settled commands | 176.946 ms | 0.036 ms |

The large-case wins are 93.2% and 99.98% less CPU. Their unchanged-code control varied by −3.4% and −2.6%. The smaller recovery control varied by −50.5%, so its exact percentage is not the headline. Complete 100,000-message history CPU varied by +2.0%; unrelated cases mostly improved slightly with machine drift. Those unrelated changes are not attributed to this production patch.

The separate SQL diagnostic now returns at most one row per predicate, rather than 100,000 complete command objects and 6.3 MB of returned text. This removes JavaScript materialization and JSON parsing. It does not make the negative recovery query independent of settled history: SQLite still examines the matching done-status bucket. The measured 11.854 ms residual remains open for an index tradeoff experiment. Pending-stop checks use the existing status index to exclude settled history.

CoreStore writes command arguments with `JSON.stringify()`. JSON1 and `JSON.parse()` differ for unsupported raw rows containing duplicate keys or JSON5 text. The test matrix covers every relevant value writable through the supported API; the complete history API keeps its existing parser.

[Independent production review](../../review/2026-09-07-perf-command-probes.md) found no blockers. The author passed the 184-test core suite, 52 loop tests, root check, all v2 package checks, and build. Parent integration checks cover the merged lineage changes, the command predicates, and live account-swap/reconfigure paths; all passed: 55 focused core/loop tests, 17 account-swap and argument tests, all eight v2 TypeScript checks, and the repository build. Raw logs are under `verification/d05-*.log`.
