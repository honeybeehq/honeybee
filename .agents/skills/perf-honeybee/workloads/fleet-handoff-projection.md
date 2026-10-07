# Latest handoff projection in fleet lists

`CoreStore.listBeeViewRows` now seeks each selected bee’s latest handoff through the existing `bee_handoffs_bee` index. Timestamp then insertion-order ties are unchanged. No cache or schema change is added; moves, runtime and flag projection are unchanged by the handoff optimization. Cell projection is now covered separately by [fleet-cell-projection](fleet-cell-projection.md).

Run `node scripts/perf/fleet-handoff.mjs --out .proof/fleet-handoff.json`, then `node scripts/perf-map.mjs check .proof/fleet-handoff.json`. Run `node --test scripts/perf/fleet-handoff.node-test.mjs v2/core/tests/list-views.test.ts v2/core/tests/handoff.test.ts` for lifecycle and plan controls. Node 24.18.0 and `trash` are required. Stores are isolated and never use the live daemon.

The retained compact count receipt covers 1, 8 and 64 bees with 0, 1, 8 and 64 handoffs per bee, four lifecycle filters, and three alternating baseline/candidate pairs. All 144 complete output pairs match (48 distinct cases). At 64 bees × 64 handoffs, the unfiltered read returns and maps 64 handoffs instead of 4096, a 98.4375% reduction. Zero/one-history controls match. Query invocation counts are unchanged. The counter also observes one unchanged audit-sequence read before each fleet list; it is not a total database-operation measurement.

The existing index resolves timestamp/rowid order without a temporary sort. Independent controls exercise fresh admissions/failures, older and tied timestamps, rollback, archive/unarchive, deletion, reopen and audit replay. Per-bee index seeks replace a history scan: sparse/no-history CPU and SQL VM work remain unmeasured. No latency, CPU, allocation bytes, RSS or UI gain is claimed. History sizes are synthetic, not observed fleet prevalence.

The full-history APIs are unchanged. Malformed JSON in an obsolete or unselected handoff is no longer decoded by the fleet list; malformed selected handoffs still fail during mapping. No corruption recovery claim is made.

The map baseline is the candidate capture, so its check proves consistency with that capture. Improvement is supported by the retained paired arms and full outputs under Speedy run `2026-10-03/333b7c8de947184c6d67734e`, not by comparing that baseline with itself.

The baseline receipt and store owner were refreshed on 2026-10-06 after the Cell projection change. All 48 fresh full outputs match the point-read reference and all excess handoff counts remain zero. This refresh does not remeasure the historical baseline arm.

The source owner and compact receipt were refreshed on 2026-10-07 after move mapping changed. All 48 current-source outputs match point reads and excess counts remain zero. This refresh does not remeasure the historical before arm.
