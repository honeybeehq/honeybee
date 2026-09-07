# Further measured read costs

`scripts/perf/read-hotspots.mjs` runs 24 canonical cases across seven inventory IDs. The first capture uses exact production `bcd85a8c`, Node 24.18.0, Apple M4, 15 uninstrumented samples per case, three warmups, and explicit GC before timing. Each case then performs one separate SQL attribution call. The whole report records source/tool hashes, boot identity, intervals, fixture parameters, raw samples, and semantic checks. No live store or provider is involved.

| Inventory | Fixture | Median CPU | Observed avoidable work |
| --- | --- | ---: | --- |
| D05 | Boot recovery, 100,000 settled commands for one stopped Bee | 174.552 ms | Hydrates 100,000 complete command rows and 6.3 MB returned text to answer whether a stop requested revival |
| D05 | Pending-stop policy with the same settled history | 176.946 ms | Hydrates 100,001 commands to find one future queued stop |
| C07 | 100,000 cleared flags, 1,000 active future resets, nothing due | 2.491 ms | Expiry reads historical table data despite a quiet result |
| C09 | Held idle mail, one 1 MiB body | 0.180 ms | Full body materializes even though the running real turn cannot accept it; 64-byte control is 0.037 ms |
| C09 | Stopped-target pending mail, one 1 MiB body | 0.225 ms | Full body materializes while wake intent is deferred; 64-byte control is 0.034 ms |
| C10 | Complete 100,000-message history | 131.849 ms | Complete results intrinsically require materialization; optimize bounded consumers without truncating this API |
| C10 | 20 target messages among 100,000 unrelated messages | 3.641 ms | Sparse read still scans unrelated history |
| C22 | 1,000 enabled supplies with empty task lists | 22.102 ms | Repeats Bee/supply/runtime reads for every supply each tick |
| C22 | 1,000 enabled paused supplies | 28.467 ms | Also reads tasks and full pending bodies before proving no work |
| C25 | Latest 20 target audit events among 1,000,000 unrelated events | 31.225 ms | Sparse audit-tail access scans unrelated history |
| C18 | RPC idempotency hit at 10,000 retained rows | 0.008 ms | Already small; keep as a control |
| C18 | Unique insertion at the retention boundary | 0.018 ms | Baseline insertion cost before eviction |
| C18 | Unique insertion with eviction from a full retention window | 0.242 ms | Repeated count and oldest-row ordering dominate this fixture |

Evidence: `evidence/mini-read-hotspots-before.json`. Values are local microbenchmark costs, not whole-daemon latency predictions. SQL returned-text counts describe JS-facing results, not disk I/O. Large histories are inserted offline into disposable fixtures while CoreStore is closed; they are not audit-replay or lifecycle-write evidence. Timed operations use production WAL/NORMAL connections. Exact counts, order digests, retained wake intent, no-driver-effect assertions, and audit invariants validate the intended read behavior.

[Independent ruler review](reviews/read-hotspots-initial.md) found no fixture or timing blockers. Its comparator concerns led to `compare-read-hotspots.mjs`: successful complete reports and scenarios, matching tool/boot/runtime/workload, non-overlap, raw-summary parity, and an explicit expected committed-source delta are required. The unchanged-code control is retained as `evidence/mini-read-hotspots-control.json`, with strict comparison in `mini-read-hotspots-aa.json`. Large command histories varied by −2.6% to −3.4% CPU; the 1,000-command boot case varied by −50.5%, so small-case changes need paired confirmation rather than a universal percentage threshold. No before/after claim is accepted from the older generic comparator alone.

These fixtures partially cover their inventory entries. Task execution, large actionable cohorts, I1 queue scaling, due flag writes, index installation/write/storage costs, and memory lifetimes remain open. D05 proceeds first; the existing full-history public APIs keep their complete result semantics.
