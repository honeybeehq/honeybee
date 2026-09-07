# Pending metadata allocation

Accepted `bac990b7`, integrated with the covering index as `b89d628d`. SQLite returns array rows for the two daemon pending-metadata statements when that native API exists. Mapping no longer creates a temporary wrapper per message. SQL text, individual-value validation, ordering, grouped message identity and public projection shape are unchanged. No snapshot or authority cache was introduced.

Mini compared immutable `6d2677b1` and `bac990b7` with an unchanged quiet-tick ruler, 3 warmup ticks and 30 uninstrumented samples per side. A distinct identical checkout supplied the control. Whole-core CPU medians are milliseconds.

| Fixture | Before | Control | After |
|---|---:|---:|---:|
| Empty | 0.035 | 0.037 | 0.038 |
| 20,000 held 64-byte messages | 10.216 | 10.331 | 5.658 |
| 100 live Bees, 100 held 1 MiB messages | 11.253 | 11.294 | 11.610 |

The wide-queue gain is clear. The initial large-body result was worse and is retained. A subsequent B,A,A,B sequence measured CPU 11.332, 11.388, 11.537 and 11.500 ms respectively, with 30 samples in each capture. Both opposing pairs slightly favor the candidate, while A/A itself shifts. No large-body improvement is claimed for array rows alone. The independent covering index addresses that cost.

[Wide comparison](evidence/mini-i1-bac9-wide-ab.json), [wide A/A](evidence/mini-i1-main6d-wide-aa.json), [original body comparison](evidence/mini-i1-bac9-body-ab.json), and [body repeat A/A](evidence/mini-i1-body-repeat-aa.json) retain raw samples and source/tool/boot fingerprints. Repeat [pair 1](evidence/mini-i1-body-repeat-ab1.json) and [pair 2](evidence/mini-i1-body-repeat-ab2.json) preserve the initial adverse result's follow-up.

Separate 30-tick heap-sampling captures measured 315,221,560 bytes before and 150,241,688 bytes after. These are allocation traffic estimates, not retained RAM or a process RSS decrease. Before, readI1PendingSnapshotData self-allocation accounted for 290,333,328 bytes. After, daemonStatementArrayRows accounted for 80,247,288, the caller 29,485,712, iteration 24,031,880 and array growth 15,221,328 bytes. The [before profile](evidence/mini-i1-main6d-wide-profile.json) and [after profile](evidence/mini-i1-bac9-wide-profile.json) retain CPU and heap sidecars with verified hashes.

The native row-array API has an explicit availability check. The fallback uses the existing object rows on runtimes without it. One local assertion bridges Node's runtime row-array contract and its unrefined TypeScript all() return declaration; every selected scalar remains unknown until validated. [Node's API contract](https://nodejs.org/api/sqlite.html#statementsetreturnarraysenabled) defines the mode. Tests exercise the real native method and a fresh-connection method-absent fallback, exact values, ordering, shared array/message references and malformed urgency errors.

Standalone Mini build, all v2 typechecks, 220 core tests and 364 daemon/CLI tests passed, with one platform skip. Combined with D05 and the covering index, build, typechecks and 225 core tests passed. One unrelated CLI assertion expected ambiguity candidates in registration order despite timestamp ties; `b74a32c7` now compares the exact candidate set and exact error prefix. Its affected CLI suite and typecheck passed. The original failing aggregate is retained. The later merge with main passed core and daemon gates again; its unrelated compiled gateway-test import issue was corrected and verified separately. The full compiled suite has identical failures on repaired unchanged main and the candidate; see the integration review.

The original allocation design and frozen A/B patches are under designs. Wide snapshot materialization still allocates about 5 MB per profiled tick; this work does not declare I1 or daemon memory fully optimized.
