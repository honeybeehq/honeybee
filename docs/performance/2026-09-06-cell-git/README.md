# Cell startup and command-history performance

This round measures three separate costs: subprocesses during fresh Cell setup, settled command history parsed during settings checks, and database scans for one bee's history. Production changes preserve the existing public API and authority model. No live runtime was deployed.

## Accepted changes and measurements

### Fresh Cell Git configuration

The common fresh-image path writes both safety settings in one locked config update. Unusual templates, links, existing safety keys, includes, oversized files, and unsupported paths retain Git's writer. Original config bytes, permissions, init settings, remote behavior, and commit checks are preserved.

Seven alternating before/after pairs per remote configuration used fresh Node processes and real built Workers. Each fixture had 203 tracked files, a prewarmed image, and 1,000 untimed warmup files.

| Remote setup | Ready before → after, p50 | Change | Git subprocesses | Faster pairs |
|---|---:|---:|---:|---:|
| None | 552.978 → 472.344 ms | −14.6% | 8 → 6 | 6/7 |
| Shared fetch/push URL | 720.486 → 623.916 ms | −13.4% | 10 → 8 | 4/7 |
| Separate push URL | 635.852 → 514.179 ms | −19.1% | 11 → 9 | 7/7 |

[All paired raw samples](evidence/cells-final.json) retain revisions, source/artifact hashes, tool hashes, environment, and per-pair deltas. Two Git processes disappear in all 21 pairs. The final combined build produced the exact measured Worker bytes (`2ea1e4e76afe0d5a757d756b29d1383384429f8108f38d498e766e628c4bd1f9`), recorded in the combined verification manifest. No Cell RAM improvement is claimed. No-remote CPU is inconclusive: its marginal median fell, but only 3/7 paired CPU observations improved.

The five-worker cohort removed 40 → 30 Git processes. Its three-process-per-side result is inconclusive for readiness: 1,020 → 1,073 ms (+5.2%). CPU was 650 → 591 ms; hold RSS was 127.1 → 127.9 MB. These are descriptive small-sample results, not independent wins. Every Worker exited. The strict comparator rejected an earlier hostname mismatch; the retained matching-host baseline was recaptured after the candidate. See [cohort comparison](evidence/cohort-scorecard.csv), [baseline](evidence/cohort-final-before.json), and [candidate](evidence/cohort-after.json).

### Settings checks without history hydration

`reconfigureBee` now probes for one pending replacement using the existing status index. It no longer loads and parses every settled command. The query remains inside the same transaction and preserves the bee, generation, stop verb, queued/running status, and JSON-field presence conditions, including explicit JSON null.

Three before/after pairs ran one unchanged-settings check per fresh process with 100,000 settled commands belonging to that bee. Fixture setup was followed by explicit GC; the measured call was uninstrumented.

| Metric | Before p50 | After p50 |
|---|---:|---:|
| Wall time | 1,242.346 ms | 1.021 ms |
| Node CPU | 1,051.529 ms | 1.991 ms |
| RSS after the call | 424.608 MB | 107.594 MB |
| Heap used after the call | 182.560 MB | 9.757 MB |

[Raw samples and strict comparison](evidence/reconfigure-memory.json) support these stress-fixture results. RSS before the call was about 108 MB on both sides. This is a reduction in a transient history-related spike, not a claim that the whole live daemon uses 75% less RAM. RSS includes shared and allocator pages; heap usage is observed live usage, not total allocated bytes. Peak RSS is converted from KiB using the [Node resourceUsage contract](https://nodejs.org/api/process.html#processresourceusage).

The broader [before](evidence/commands-final-before.json) / [after](evidence/commands-final-after.json) matrix independently reduced the 100k-own-history settings check from 1,028 → 0.108 ms. Full history reads remained around 1.15 seconds because this unit intentionally preserves their complete results.

### Selective command-history indexes

Two complementary indexes serve different query shapes: `(bee_id,id)` preserves ordered history, and `(bee_id,status,id)` keeps status-filtered queries selective. Existing databases install them through normal schema initialization; the schema version and authoritative events do not change.

The final production comparison passed its workload, tool, measured OS boot, raw-sample, and all four query-plan checks. Both captured core source hashes match the code being landed.

| Workload | Wall before → after, p50 | Node CPU before → after, p50 |
|---|---:|---:|
| 10 returned commands / 1,000 unrelated | 0.468 → 0.143 ms | 0.399 → 0.146 ms |
| 10 returned commands / 10,000 unrelated | 18.855 → 0.122 ms | 2.099 → 0.125 ms |
| 10 returned commands / 100,000 unrelated | 113.136 → 0.124 ms | 41.992 → 0.126 ms |
| All 100,000 own commands returned | 2,330.001 → 3,497.747 ms | 1,236.153 → 1,326.828 ms |

[Final comparison and recomputed distributions](evidence/command-index-comparison.json), [before](evidence/commands-index-before.json), and [after](evidence/commands-index-after.json) retain every observation. Small results use 25 samples; the full-history result uses five. The 100k-unrelated lookup uses 99.7% less Node CPU. The full-history case uses 7.3% more CPU and 50.1% more wall time in this final shared-load fixture; earlier prototype and rejected-hostname runs varied. **This is an accepted tradeoff, not a universal speedup.** The indexes remove unrelated-history scans but add index traversal and maintenance. Full results remain complete and ordered. This round does not claim faster bulk-history reads.

With 100,000 own commands, the pending-delete selector is 0.0218 → 0.0317 ms, using the covering composite index instead of the rejected 73.636 ms settled-history scan. The remaining microsecond-scale differences are not claimed as wins. Wake and UPDATE plans also use the composite index in every scenario; history reads avoid a temporary sort. The ordered pending-delete query also selects the composite index explicitly; the status union can then sort only matching pending IDs. The adjacent update query retains its original SQL and its selected plan is recorded.

## Rejected experiments and costs

A history-only index made a ten-row history lookup fast but changed the pending-wake query to scan 100,000 settled commands: 0.0164 → 75.996 ms. It was rejected in a disposable database. A status-only index kept pending queries fast but added a temporary history sort; a mixed-status fixture exposed an approximately 16% full-history slowdown. The two-index design avoids the history sort, but the retained prototype still scanned settled history in the ordered pending-delete query (73.636 ms). Landing was held for a targeted query correction; the final capture confirms that the corrected probe stays selective. Retained prototype captures make those decisions reviewable rather than hiding unsuccessful attempts.

Index storage, write maintenance, and one-time installation are real costs. The final production capture measures them separately. The [existing-database upgrade fixture](evidence/command-index-upgrade.json) used 100,010 commands and 36-character UUID bee IDs: allocated SQLite pages grew from 36.479 MB to 46.776 MB (+10.297 MB, +28.2%). The first candidate open took 2,350.533 ms wall and 476.331 ms CPU. Five subsequent opens had medians of 13.412 ms wall and 3.067 ms CPU; the single preceding baseline open took 17.298/3.671 ms. This is one warm-filesystem upgrade on a loaded host, not a tail or cold-start guarantee. RSS around the first candidate open stayed near 104 MB and the process high-water mark did not increase; that single observation is not a memory improvement claim. Authority events and ordered results stayed unchanged. Synthetic seed and transition transactions use `synchronous=OFF`; their CPU deltas measure index maintenance, not production durable enqueue latency. Query captures use normal production CoreStore pragmas in `durable-mixed` mode. For the 100k-unrelated query fixture, short-ID storage increased from 33.890 MB to 40.169 MB (+6.279 MB). The median CPU for 3,000 status updates increased from 59.879 ms to 64.610 ms (about 1.58 additional microseconds per update); the 100k-own fixture adds about 2.43 microseconds per update. These maintenance estimates vary with the fixture and host. Short fixture bee IDs affect index size; the upgrade fixture also measures 36-character UUID IDs.

## Revisions and retained rulers

| Unit | Before | Candidate source |
|---|---|---|
| Cell config | `56be5820` | `3cc958475c2f04c55e00978af6bd82bd5def19c0` |
| Reconfiguration | `56be5820` | `a5480e249fba6735e91f9c795d209c288bd2bafd` |
| Command indexes | `a5480e249fba6735e91f9c795d209c288bd2bafd` | `5afde02e861b9edf0f6dc60bf4a99ea9312748b7` |

The task branch started at `a22c42bd`, a core-skill documentation update over `56be5820`. Parent integration maps Cell `3cc95847` to `b00701e1`, reconfiguration `a5480e24` to `dafc993a`, and corrected indexes `5afde02e` to `ac44cac3` (after `2d1a08f2`). Cherry-picking creates different commit IDs while preserving the measured source bytes; the final evidence check compares source hashes. Earlier exploratory matrices used different sample counts and record their own tool hashes. They explain hypotheses and rejected attempts; they are not pooled with final runs.

## Measurement scope and reproduction

Captures use Node 25.8.0 on Apple M4 Max/macOS. Core-author verification used Node 24.20.0, confirmed in the retained version receipt; the parent rebuilt the combined v2 artifacts and ran its regression checks on Node 25.8.0. Owned builds and broad tests are excluded from capture windows. An unrelated deployment compiler was observed during an earlier index baseline; this is a shared workstation, not a dedicated lab. Repeated macOS hostname changes caused the final command comparison to reject another pair. Those captures remain under `commands-index-hostname-rejected-*`. New captures record a SHA-256 of the OS boot identifier; the comparator accepts a hostname change only when both measured boot identities match, and falls back to strict hostname comparison where boot identity is unavailable. No historical metadata was rewritten. Paired Cell ordering controls some drift; unpaired cohort and command-matrix timing should not be treated as tail guarantees.

Use immutable checkouts with dependencies installed. Cell captures require each checkout to be built first. Run from the checkout containing these scripts:

```sh
node scripts/perf/paired-cells.mjs BEFORE_ROOT AFTER_ROOT cells.json 7
node scripts/perf/command-history.mjs BEFORE_ROOT commands-before.json none durable-mixed
node scripts/perf/command-history.mjs AFTER_ROOT commands-after.json none durable-mixed
node scripts/perf/compare-command-history.mjs commands-before.json commands-after.json comparison.json
node scripts/perf/command-index-upgrade.mjs BEFORE_ROOT AFTER_ROOT upgrade.json
node --expose-gc scripts/perf/reconfigure-memory.mjs BEFORE_ROOT before-1.json
node --expose-gc scripts/perf/reconfigure-memory.mjs AFTER_ROOT after-1.json
node scripts/perf/compare-reconfigure.mjs before after comparison.json 3
```

The last comparator expects `before-1.json` through `before-3.json` and matching after files. The original six uninstrumented memory runs used the tool before the allocation-mode extension; each capture records its exact tool hash. Use the version in `378bc136` to reproduce that ruler. Do not combine samples made by different tool versions.

Native CPU, sampled heap, and Git Trace2 artifacts are compressed under [native evidence](evidence/native). Each index records source and compressed SHA-256 values. Instrumented runs are excluded from timing comparisons. Default heap sampling retains live objects; allocation-mode captures also request collected objects through the [V8 inspector sampling options](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/#method-startSampling). Neither sampled heap mode is a byte-exact allocation counter. The collected-object capture sampled 172.0 MB before (10,244 samples, chiefly `listCommands` and `mapCommand`) and 0.132 MB after (eight samples), supporting the history-hydration diagnosis. These instrumented profiles are separate from the six uninstrumented memory observations.

## Verification and review

Cell verification passed all 59 cases serially (58 pass, one platform skip), Cell typecheck, and a full build. The final core correction passed 178/178 core cases, five affected deletion cases, core typecheck, and a full build. The preceding index and reconfiguration units also passed seven affected daemon reconfiguration cases, including crash recovery and admission races.

The parent rebuilt the combined v2 CLI, provision Worker, and runner host on Node 25.8.0; ten core regression cases, two real built-Worker capture/repeat checks, and nine measurement-comparator/trace cases passed. [The combined manifest](evidence/verification/combined-manifest.json) records exact commands, observed exit codes, log hashes, source hashes, artifact hashes, and the directly queried Node version. Author manifests are retained under their full commit IDs in `evidence/verification`.

Independent code, final evidence, and decision-trail reviews by Claude Fable passed with no blockers. After preserving main's test-only `fa6f5e44` change, the parent reran the seven affected daemon cases: 7/7 passed. The [integration manifest](evidence/verification/integration-manifest.json) also confirms all measured runtime source and artifact hashes remain unchanged. No CI runs existed for the unpublished performance branch; no push or deployment was performed. Concurrent aggregate runs repeated the previously reported load-sensitive background-boot timeout; the isolated case passed. The implementation does not modify that timeout or hide the failed receipts.

See the [code and evidence review](../../review/performance-cell-git-and-command-history-2026-09-06.md), [decision trail](decisions.tsv), and [workflow](workflow.md). The earlier [system map and profiling foundation](../2026-09-06/system-map.md) and [runner-host/Worker lifetime round](../2026-09-06-spawn-cells/README.md) remain separate measurement rounds.

## Remaining measured limits

Full 100,000-row history reads still materialize and parse all returned commands. A future bounded or paginated consumer path could reduce that cost, but changing this API's results would violate this round's compatibility constraint. Cell cohort readiness and RAM remain inconclusive, and this round does not claim a steady-state idle-CPU reduction. Those are separate targets, not hidden successes.
