# Boot-state lookup

The daemon checks whether any runtime is booting after every tick. This workload isolates that query from the rest of the tick. The existing sparse live-runtime index excludes stopped generations; no schema or cadence change is proposed.

Run the exact record recipe. It compares real current-method SQL with the history-scanning control from 81dbdefe. Statement counters come from the installed sqlite3 CLI, not Node. The receipt records both engine versions; Node separately proves the query plan and boolean behavior. No timing, physical I/O, or whole-daemon claim is supported.

Acceptance declared before capture: stopped-history growth adds zero fullscan steps; all-live extra VM instructions must be no more than 3*live+50 per lookup. Every result must match. Lifecycle tests cover rollback/reopen and older booting generations.

The retained receipt is `baselines/boot-runtime-lookup.json`: 150 paired samples, three alternating rounds for 50 fixtures. With 10,000 stopped generations and 12 live, nonbooting rows, CLI fullscan steps are 10,011 → 11 and VM instructions 30,044 → 61. With no live rows they are 9,999 → 0 and 30,008 → 13.

Displaced work is explicit: with no stopped history and 0/1/12/120 live nonbooting rows, VM counts are 8→13, 11→17, 44→61, 368→493. These are 5–125 additional instructions, not free reads. The candidate still scans live rows; no new index or writes are introduced. Actual Node SQLite 3.53.1 and CLI SQLite 3.51.0 are different populations. CLI counts cannot establish Node CPU or whole-daemon latency.

The test's fullscan statistic counts advances, so scanning a single row can report zero steps. The first/last boot controls refer to live-row order; additional retained generations are physically inserted after those rows and the no-boot control exercises the full-history scan. Every pair matches the real method's boolean. The CLI opens only a closed, checkpointed fixture with immutable=1 (a WAL-presence assertion refuses unsafe reads).

The default Node test pins sparse-index use and lifecycle behavior. The optional recipe additionally asserts work counts. A receipt's `complete` flag covers its count matrix, not the separate functional tests; retain/check the process exit status too. Failed arms retain prior completed counts and error text. Store setup failures abort the process and leave the receipt incomplete. No live authority, daemon or provider is contacted.
