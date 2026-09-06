# Cell Git setup and command-history review

Reviewer: Claude Fable, independent read-only lane `0c5a1a46-b846-430c-9920-c57bfb2520a9`. Parent also inspected the diffs and owns the measurements.

## Production scope

Cell configuration batches two persistent settings into an atomic write in a newly initialized private Git directory. It preserves Git init settings, file permissions, and original bytes. Only small, regular, singly linked configs qualify. Existing safety keys, includes, backslashes, links, locks, large templates, and unsupported path controls retain Git’s original writer. Remote commands and both commit-presence checks remain unchanged.

`CoreStore.reconfigureBee` checks for a pending replacement command through an indexed existence query. It no longer reads and parses settled history. The query remains in the existing serialized transaction and preserves bee, generation, verb, status, and JSON-field presence conditions. That reconfiguration unit has no schema or public API change. A separate unit adds complementary history and status indexes without changing the schema version. The pending-delete selector explicitly uses the composite index to avoid a sort-driven settled-history scan.

## Findings and disposition

- Config lock creation must be exclusive. The implementation uses `config.lock` with `wx`, writes through the descriptor, restores permissions with `fchmod`, closes, and renames. Failure still causes the existing image-miss cleanup.
- Template settings and links have observable Git behavior. Conservative fallback preserves replacement and multivalue errors, including the existing symlink write-through behavior. This round deliberately preserves that behavior.
- Reading every template config could add unbounded Node allocations. The follow-up checks file metadata and a 64 KiB threshold before reading. A large-template test proves fallback. These files are private to provisioning; the post-read length check is an acceptance check, not an atomic filesystem snapshot.
- Unicode, semicolons, and the no-config-subprocess assertion were added to the existing path test.
- JSON null must count as a present replacement value. `json_type(... ) IS NOT NULL` preserves that distinction from a missing property, matching the existing command-claim logic.
- `INDEXED BY commands_ready` deliberately ties the new query to the existing status index. Future index renames must update this query. Regression tests exercise the binding.
- Cross-bee isolation received a requested test assertion during final verification. Its receipt is recorded with the final test results.

The reviewer approved the Cell and reconfiguration diffs, the additive indexes, and the subsequent pending-delete query correction. An include-routing test remains optional; current code conservatively falls back for any config containing `include`.

## Rejected experiment

A standalone `(bee_id,id)` history index reduced a ten-row lookup with 100,000 unrelated commands from 194.986 ms to 0.132 ms. It also changed the pending-wake plan from the status index to scanning the bee’s settled history: 0.0164 ms became 75.996 ms in the 100,000-own-command case. The prototype was confined to disposable databases and rejected.

## Index regression caught before landing

The dual-index prototype still made `deleteBee` choose the history index to satisfy `ORDER BY id`. The small-history cases hid the cost; the 100,000-own-command case took 73.636 ms versus 0.0111 ms before. The parent caught this by inspecting every raw pending-query plan. The earlier summary was wrong, and the reviewer acknowledged that treating either plan as acceptable underestimated this risk.

The correction pins only the ordered pending selector to `commands_by_bee_status`. It keeps exact ID order while sorting only the matching queued/running IDs. Added behavior checks cover both statuses, settled-row exclusion, and other-bee isolation. Its plan uses a covering index. The reviewer approved the correction and requested an explicit UPDATE-twin plan in the final capture; no speculative update pin is needed if that plan is already selective.

The plan test duplicates a SQL string. The final measurement tool checks the exact production query, accepts only the known old/new forms, and retains that SQL with its plan. This protects the capture from silently measuring an obsolete query.

## Evidence-review findings

- The first-round README link was broken. It now points to the retained system map.
- The statement that two indexes alone avoided every problem was inaccurate. The report now records the surviving pending-delete regression and its correction.
- Sampled allocation profiles are separate from uninstrumented timing/RAM observations. No byte-exact allocation or whole-daemon RAM claim is made.

## Ruler review

The final comparator recomputes raw distributions, rejects prototype captures and identical source, checks counts and finite values, and verifies ordered-history, pending-delete, wake, and update query plans. Its regression test rejects the exact history-scan plan caught in this round.

A second hostname change caused another rejected pair. The reviewer approved measuring a hashed OS boot identity in new captures. Whenever either input carries a boot identity, both must match; even an unchanged hostname cannot hide a reboot. Unsupported platforms retain strict hostname matching. Old capture metadata stays untouched. The retained test covers renamed host, changed boot, and missing identity. This replaces a fragile hostname assumption with measured identity rather than relaxing the comparison blindly.

## Verification and measurement status

The final source is `3cc95847` for Cell configuration (parent `b00701e1`), `a5480e24` for reconfiguration (parent `dafc993a`), and `5afde02e` for the corrected index unit (parent `ac44cac3`, following index commit `2d1a08f2`). All source hashes in the final core capture match the parent. The combined Worker artifact exactly matches the measured candidate hash.

Retained checks: Cell 59 serial cases (58 pass, one platform skip), Cell typecheck/full build; core 178/178, five deletion cases, core typecheck/full build; seven affected daemon reconfiguration cases in the author lane. Parent combined v2 build, ten core regressions, two real built-Worker checks, and nine ruler/trace tests passed. Command-level manifests and log hashes are in [verification evidence](../performance/2026-09-06-cell-git/evidence/verification). Core author used Node 24.20.0; parent used Node 25.8.0, both directly recorded.

Two concurrent Cell aggregates repeated the previously reported background-boot timeout. The same case passed isolated, and the entire serial suite passed. The failed logs remain retained; this round changes neither that timeout nor the background driver.

The final command comparator passed: workload, ruler, measured boot identity, source difference, raw counts, finite values, and history/pending-delete/wake/update plans. The accepted tradeoff is explicit: selective lookup CPU falls 99.7%, while the full100k-result fixture uses 7.3% more CPU and 50.1% more wall time on this shared host. UUID-sized index storage rises 10.297 MB per 100,010-command fixture; one-time upgrade CPU is 476.331 ms. These are costs of the accepted indexes, not hidden speedups. There is no change to complete ordered results or command authority.

Main's concurrent `fa6f5e44` change only adjusts daemon test fixture readiness ceilings. It is preserved by merge commit `ddec2cda`; no runtime source changes or measured Worker bytes change. The parent reran the affected daemon reconfiguration cases after integration: 7/7 passed. The integration manifest confirms the exact measured runtime source and built artifacts are unchanged.

Final independent verdict: **no blockers**. Claude Fable traced every final table value to raw evidence, verified the measured source against the combined build, reviewed the upgrade and maintenance costs, and approved the decision trail. All findings are closed. The post-merge daemon receipt satisfies the remaining integration check.

A final test-only main update (`308f7afb`) was also preserved. Parent inspection found only the freeze fixture timestamp correction; its targeted CLI case passed 1/1 on the merge result. The final integration manifest confirms no measured runtime source or artifact changed.
