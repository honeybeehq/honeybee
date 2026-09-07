# Per-Bee audit tail

Accepted production change `e17374fc` applies author `485a6c3f`: install the partial `audit_by_bee(bee_id) WHERE bee_id IS NOT NULL` index and keep `latestBeeDeletedRow` on its existing, narrower `audit_bee_deleted_bee_seq` index. Per-Bee tails retain sequence order and cursor/limit behavior. The explicit deletion index prevents the new general index from degrading historical deletion lookup.

The immutable production comparison uses distinct checkouts at `7eb8ecb7` and `485a6c3f`, plus a distinct byte-identical 7eb8ecb7 A/A control. The frozen read-hotspot ruler ran all 24 canonical cases, 15 samples each, sequentially on the M4 Mini with Node 24.18.0. Comparators assert exactly schema.ts and store.ts differ for A/B, zero source differences for A/A, and matching workload/environment/tool identity. All correctness checks passed.

| Operation | Before CPU p50 | Control CPU p50 | After CPU p50 |
| --- | ---: | ---: | ---: |
| Tail 20 target events among 1,000,000 unrelated events | 30.033 ms | 30.210 ms | 0.023 ms |

Wall p50 was 30.032166 → 0.023167 ms. This fixture uses short target/unrelated identifiers. Its absolute timing differs from the UUID-sized [tradeoff prototype](audit-tail-prototype.md); those workloads must not be presented as one experiment.

The prototype separately measured the index's costs: roughly 43.3 MiB per million non-null UUID-scoped rows; an extra 0.349–0.516 ms CPU per 100 durable public renames; a 0.012 ms increase for an already dense per-Bee tail; and one offline index installation of 158–306 ms depending on null-row share. These are offline-index mechanism measurements, not a new production startup or write benchmark. The schema installs the same index. Costs remain accepted and visible; whole daemon startup and audit retention are open.

All other matrix rows remain in the evidence. Full 100,000-row pending hydration rose 131.097 → 135.344 ms CPU, versus 135.897 ms in the identical-source control. Empty/paused 1,000-supply reads rose 10.726 → 11.047 and 10.971 → 11.353 ms, versus controls 10.881 and 11.178 ms. Recovery at 100,000 commands was 11.683 → 11.918 ms, control 11.803 ms. These small shifts do not establish an audit-index effect on unchanged read paths; no speedup is claimed for them. Microsecond-scale differences and all p95/raw samples are retained.

Five regression cases exercise tail filters/cursors/limits, null and empty-string edges, rollback sequence reuse, selected versus unselected malformed payloads, additive reopen/index installation, and real historical mail lookup through deleted Bees. The latter captures the actual prepared query plan and proves the narrow deletion index remains selected. Mini author revision passed build, all v2 typechecks, and 217 core tests. Combined current integration with both Cell read changes and final Unit 2 passed build, all v2 typechecks, 218 core tests, and 364 serial daemon/CLI tests with one platform skip. Source hashes were verified before and after checks.

Evidence: `mini-c25-read-{before,control,after,aa,ab}.json`; `mini-c25-production-*.log`; `mini-c25-z01-combined-*.log` and source proof. General auditRows materialization, daemon-down filtering, and long-term audit storage remain open.
