# Automatic-title quiet scan results

Accepted candidate `8e57e746` replaces repeated full mailbox reads on proven quiet scans with a committed mailbox membership query. One 100,000-message backoff mailbox falls from 179.312 to 3.161 ms CPU per scan. Ten 20,000-message backoff mailboxes fall from 311.354 to 6.395 ms. A 1,000-bee thin fleet improves by 24.44%.

This is an explicit tradeoff. Empty fleets cost 0.282 ms more CPU per 1,000 bees per scan. Every changed mailbox still pays its full read plus two membership queries. The all-changed fixture takes 3.58% more median CPU and 8.47% more wall time. These costs are accepted because the change removes large repeated synchronous stalls without delaying scans, changing decisions, or reducing launch context. It does not improve every workload.

## Source and correctness boundary

Baseline `322815d9` and treatment `8e57e746` differ in exactly three runtime files: Core's store and index exports, and daemon `autoTitle.ts`. The treatment includes original commits `bc6554b6`, `a9e5ea91`, `29987287`, and `cb997d20`, integrated as `1847b6e3`, `e033a1b1`, `90515db2`, and `8e57e746`. The [integration proof](evidence/mini-autotitle-v1-integration-source-proof.json) matches final source bytes to capture fingerprints.

Core reads count and global maximum id over the existing pending and delivered partial indexes. The query reads index entries, so giant membership probes remain O(mailbox entries). No schema, index, writer hook, durable stamp, or sidecar format changes. An open Core transaction returns `transaction_open` before statement lookup. Only committed equal pairs from the same live store and bee can certify unchanged immutable id/body membership.

The store-backed dispatcher retains a private Map of membership and signature per visited bee. A hit also requires current active/untitled status, the exact current bookkeeping signature, and an unchanged deferral or unexpired retry backoff. Full mailbox hydration and normalization remain on misses and launches. Cache publication requires equal committed queries around the trusted synchronous full read and derivation. General custom dependencies and supplied rosters use their existing path. A full fresh roster walk prunes entries before the probe-limited loop. Disabled and occupied-slot early returns do not claim immediate pruning.

The [independent source review](designs/autotitle-architecture/honeybee-autotitle-unit2-review.md) found no correctness blocker. Tests cover rollback/id reuse, nested transactions, delivery and urgency silence, signature mismatch, envelope-only additions, changed retries, exact expiry, full initial context, supplied stale rows, callback reentry, probe ordering, watchdog fencing, and successful outcome parity. Two nonblocking coverage limits remain: titled/archived eviction is source-proven but not individually pinned, and the differential outcome test covers one success stream while other paths have focused tests.

## CPU and wall time

| Scenario | Before CPU ms | After CPU ms | CPU change | Before wall ms | After wall ms |
|---|---:|---:|---:|---:|---:|
| empty-fleet | 2.851 | 3.133 | +9.89% | 2.816 | 3.117 |
| thin-fleet | 4.370 | 3.302 | -24.44% | 4.352 | 3.301 |
| envelope-giant | 142.554 | 3.158 | -97.78% | 117.286 | 3.158 |
| backoff-giant | 179.312 | 3.161 | -98.24% | 150.036 | 3.161 |
| one-changed | 4.396 | 3.342 | -23.98% | 4.348 | 3.331 |
| all-changed | 38.590 | 39.972 | +3.58% | 36.598 | 39.698 |
| expiry-giant | 191.469 | 193.726 | +1.18% | 162.422 | 165.392 |
| ten-giants | 311.354 | 6.395 | -97.95% | 273.260 | 6.494 |

Each row reports 30 warmed samples per side, interleaved ABBA on the M4 Mini using Node 24.18.0. Quiet and transition rulers ran serially after verification. Every raw sample, p95, fixture identity, source/tool hash, and boot identity remains in the [quiet report](evidence/mini-autotitle-v1-quiet-canonical-none.json) and [transition report](evidence/mini-autotitle-v1-transition-canonical.json).

Empty/thin fleets have 1,000 bees. Giant quiet fixtures have 100,000 rows interleaved between pending and delivered history. Envelope-only giant deferral is a synthetic stress case. Substantive giant backoff is a reachable retry state. Transition one/all-changed fixtures append envelopes outside timing, preserving the normalized signature while changing membership. The all-changed mailbox history grows on a matched schedule, so its distributions include that progression. Expiry times the launching scan only. Held mock-provider rejection and outcome drain happen afterward; this is local launch overhead, not real provider latency. Ten-giants contains 200,000 messages across ten mailboxes.

[Quiet A/A](autotitle-quiet-design.md) and [transition A/A](autotitle-transition-baseline.md) establish variation separately. The empty regression exceeds its A/A difference. The all-changed CPU increase is within the earlier roughly 4.3% A/A difference, while its wall increase is larger. Neither observation justifies calling the additional queries free. Expiry's 1.18% CPU change is small relative to variable full-read work.

First scans are separate fixed-before-then-after observations in a warm process over inspected fixtures. Empty CPU is 3.269 to 6.227 ms and thin CPU is 5.027 to 8.454 ms. Envelope giant is 160.655 to 160.400 ms and backoff giant is 186.393 to 188.669 ms. All other first-scan observations remain in the transition report. These are not cold-process startup claims. The cold cache has real work to populate.

Separate read-count diagnostics prove the mechanism. One-changed drops 1,000 full reads to one, with 1,001 membership reads. All-changed keeps 1,000 full reads and adds 2,000 membership reads. Ten-giants drops ten full reads to zero with ten membership reads. Expiry's launch-plus-drain diagnostic cycle drops two full reads to one with three membership reads; only the launching scan was timed.

## Allocation traffic and process memory

Separate V8 sampling replays report bytes allocated during one quiet scan, including collected objects. These are sampled traffic, not retained heap or native memory.

| Scenario | Before sampled bytes | After sampled bytes |
|---|---:|---:|
| Empty fleet | 2,442,624 | 2,752,672 |
| Thin fleet | 3,988,904 | 2,884,912 |
| Envelope giant | 89,862,320 | 8,536 |
| Backoff giant | 219,029,760 | 4,104 |

[Full frame ancestry](evidence/mini-autotitle-v1-allocation-ancestry.json) places the baseline giant traffic in `listMessages`, message mapping, and `userTaskMessages` normalization. Backoff's largest sampled node is `replace`, at 115,476,056 bytes. The candidate replay avoids those reads and derivations. Small after-side counts are sampling-resolution observations, not exact allocation totals. `listBees` and `mapBee` remain major fleet costs.

The [numeric memory run](evidence/mini-autotitle-v1-retained-canonical-none.json) uses four independent serial processes in ABBA order, with identical GC/yield protocols at each phase. It combines 1,000 small backoff bees and one giant mailbox. Warm whole-process RSS is 849,018,880 and 842,989,568 bytes before, versus 451,821,568 and 452,100,096 after. This is a fixture-specific process observation. RSS includes native caches and allocator/V8 slack and does not identify a cache's byte cost.

Post-GC warm managed-heap occupancy instead rises from 6,862,136/6,871,056 to 11,932,872/11,932,872 bytes. Most of that difference persists after release: 6,747,648/6,746,096 before versus 11,543,920/11,543,920 after. It cannot all be attributed to the Map. Whole-process phase deltas mix prepared statements, audits from deletion, SQLite state, source/JIT state, and best-effort collection. The [A/A memory baseline](autotitle-memory-baseline.md) and raw phases remain available. No exact retained-cache byte count or native-memory attribution is claimed.

Separate diagnostic [snapshot-mode captures](evidence/mini-autotitle-v1-retained-canonical-snapshot.json) establish object structure. Both treatment warm snapshots contain one `quietBaselines` Map and exactly 1,001 recognized membership/signature entry objects. Both baseline warm snapshots contain no such slot. All four released snapshots contain no cache slot and no CoreStore object. No recognized entry violates the committed-kind/string-signature checks. This supports lifecycle behavior and the tested roster bound; it is not a dominator calculation or proof for every possible workload. Numeric snapshot-mode phase deltas are deliberately suppressed because snapshot serialization changes collection and RSS.

The [inspector proof](evidence/heap-inspector-v2-proof.json) also includes a real three-entry positive fixture, released negative fixture, and a real malformed-entry fixture. Version 2 records both invalid membership and object-signature violations before exit 1. Original v1 tool/proof bytes remain preserved. [Independent review and citation errata](designs/autotitle-architecture/honeybee-autotitle-cache-heap-inspector-review.md) are retained. Source identity was rechecked for the candidate's single binding in `createAutoTitleDispatcherImpl` and membership type in `core/src/store.ts`. Detection is limited to recognized property-edge shapes, and kind validation checks the node name rather than a general type-proof. No production diagnostic API was added.

## Verification and provenance

The combined candidate passed `npm run build`, `npm run v2:check`, all 237 Core tests, and 378 daemon/CLI tests with one platform skip. The [build log](verification/mini-autotitle-candidate-8e57-build.log), [typecheck log](verification/mini-autotitle-candidate-8e57-v2-check.log), [Core log](verification/mini-autotitle-candidate-8e57-core.log), and [daemon/CLI log](verification/mini-autotitle-candidate-8e57-daemon-cli.log) retain the evidence. Ten new dispatcher tests and seven Core membership tests are included. No production file changed after these gates or captures.

All smoke/canonical treatment reports completed with their correctness and provenance assertions intact. Quiet scans preserve sidecar bytes, authority/audit state, empty outcomes, and zero launches. Transition expiry preserves exact provider context, sidecar claim bytes, and drained outcomes on every cycle. All seed rows used by offline giant fixtures were checked against public primary-key reads, across all nine fields. Offline rows add no audit rows after the normal public seed, which is an explicit workload deviation.

One parent orchestration failure is retained. After the quiet canonical report had completed successfully, an optional summary printer used the wrong scenario key and raised `KeyError: name`. The valid report was preserved without rerun. The [failure log](verification/mini-autotitle-v1-orchestrator-summary-failure.log), original orchestration script, and explicit remaining-job resume script are archived. The ruler itself did not fail or change. Earlier ruler authoring failures and hash corrections remain in the baseline review lineage.

The earlier legacy compiled root suite remains red with the same 67 failures on unchanged-main control, documented in the pending integration review. It was not rerun for this change. Passing relevant v2 gates does not make that suite green. No push or deployment was performed by this lane.

The [profile archive manifest](evidence/mini-autotitle-v1-profile-archive.json) records original and compressed hashes for eight allocation profiles and eight snapshots. Local decompression was checked against every original hash. Raw Mini artifacts remain unchanged. Evidence and normalized verification logs have repository manifests.

## Remaining work

S14 remains open for the empty/cold/all-changed costs, full roster materialization, and O(index entries) membership probes. S15 provider queue/process behavior and S16 bookkeeping rewrite/storage costs remain separate unmeasured inventory entries. The next bounded study examines roster allocation using the existing profiles before proposing another production change. This acceptance completes one measured candidate, not the exhaustive performance program.
