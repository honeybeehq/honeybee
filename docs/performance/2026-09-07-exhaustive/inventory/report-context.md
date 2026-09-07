# Honeybee performance inventory, 7 September 2026

This is a source-grounded inventory of 153 distinct operation or resource costs at detached baseline `343289fe0f939ad3028550af14b4c5c068ea739e`. It is a measurement backlog, not an optimization result. No production, test or benchmark source was changed. No build, test, heavy capture, live runtime mutation, network probe, nested agent or commit was performed. All generated artifacts live under `/tmp/honeybee-perf-inventory-2026-09-07/`.

The repository AGENTS.md and mandatory Honeybee core-work skill were read completely. TypeScript, technical-writing and unslop guidance was applied. Apiary tools were absent from the available tool list. Both attempted Apiary resource discoveries returned `unknown MCP server 'apiary'`, so live self/setup could not be called. No session identity or Apiary setup is assumed.

The inventory combines source call-path inspection with a conservative declaration/import index of all 543 tracked TypeScript/MJS production and script files. The index contains 6,840 declaration-like lines. It includes type-only imports and relative URL edges, so it establishes possible dependency reachability, not actual installed use. Selected hot paths were read in detail. This is not a claim that every line of every legacy implementation or every fixture was manually reviewed. The directory matrix records that distinction.

The main table is in `inventory.tsv` and reproduced below. `anchors.tsv` supplies source line anchors. `coverage.tsv` enumerates all 113 directories containing tracked files. `source-symbols.tsv`, `static-import-reachability.json` and `tracked-files.txt` preserve the source coverage basis. IDs are stable within this inventory and should be carried into the parent's tracker unchanged.

The strongest next measurements are D02 quiet snapshots, D05 stop/revive history hydration, H07 recovery-prefix replay, R02/R03 framing/backpressure, L03/L06 selector and wait amplification, E10/E11 synchronous capture/removal, S04/S14 account/title scans, and Z01 retained daemon state. C15/C17 cover the accepted full-history/index tradeoff. These priorities rank investigation value and blast radius, not proven speedups.

## Shipped entry points and call paths

- Frozen installed `hive` and `ap`: `src/cli-bootstrap.ts:main` -> `src/cliRoute.ts:v2IsDefault` -> `v2/cli/src/main.ts:runV2Cli` -> `RpcClient` -> `RpcServer.onFrame` -> `HiveDaemon.dispatch` -> `CoreStore` or daemon service. `FROZEN` is checked before choosing the import graph. `deploy` and `__complete` retain legacy routing.
- Spawn: RPC admission/account choice -> durable bee/runtime/command and optional Cell reservation -> `DaemonCore.executeCommands` -> `SubstrateRouter` -> HSR start, Cell Worker then HSR, or tmux. HSR writes host configuration -> dedicated runner host -> harness. Adapter readiness, real boot evidence and first provider output are separate clocks.
- Mail: `CoreStore.send` atomically records mail and required wake -> core tick eligibility/FIFO -> optional interrupt -> driver encode/write -> provider-specific acknowledgement -> durable `markDelivered`. Acceptance, eligibility, consumption and model completion must not be merged into one latency.
- Observations: harness stdout -> output-only generation journal and transcript -> `HsrDriver.pumpHostTail` -> adapter -> one core transaction folding state/flags/session/output/cursor. Exit handling drains evidence. Logs do not become authority.
- Restart: open/requeue -> construct services/drivers -> `adoptSurvivors` exact identity checks and journal-context recovery -> `DaemonCore.boot` reconciliation/mail sweep -> login reconciliation -> RPC listen. Restart-to-hello includes costs before the first client can connect.
- Consumers: `snapshot` materializes current bee views and registries/questions/seals/accounts/limits/tasks/supply/login flows. It does not ship complete mailbox/command/audit histories. Watch reads at most `watchMaxBatch+1` rows, shares reads by cursor, and emits a gap requiring a new snapshot. Credential health also depends on filesystem facts.
- The shipped `hive-x` entry directly imports legacy `commands/run.ts:cmdX`. The root library exports legacy BeeView/request operations. `honeybee/execution/v1` exports contract loading/validation/conformance, not the entire execution runtime service. `honeybee/comb` exports schema normalization/types. The unfrozen dispatcher routes legacy commands. These are explicit conditional paths, not v2 background work.
- The inspected v2 CLI dependency graph reaches only one `src/` implementation file, `src/lock.ts`, used by AccountsService. It does not call the legacy SSH bridge. Legacy remote HSR/SSH-tmux are shipped through their own entry/call paths. Actual external client usage and remote deployment topology were not observed.

## Prior evidence and limits

B0 is the July legacy HSR startup corpus in `docs/performance/HSR_STARTUP_RESULTS_20260720.md`. It is historical context only; retired verbs and older paths cannot serve as a v2 baseline.

B1 is `docs/performance/2026-09-06/{system-map,results,next-experiments}.md`, plus `measure.md` and `profiling.md`. Landed changes replace the quadratic latest-runtime self-join and push lifecycle filtering into SQL. At 100 bees x 200 generations, recorded list p50 fell 378.19 -> 3.42 ms and quiet-step CPU 318.85 -> 4.17 ms. Real-daemon history-heavy list/snapshot/idle results improved. Flat-history results, RSS and repeated full-agent readiness were not uniformly better. Built CLI figures are warm-cache process starts. The fixture disables naming, account refresh and scale-to-zero. Daemon RSS includes its in-process client and excludes detached children. Startup observations were sparse. Prior native allocation samples are not retained-heap measurements.

B2 is `docs/performance/2026-09-06-spawn-cells/README.md`. Landed changes add the dedicated small runner-host artifact and terminate fresh-image provision workers without redundant deferred maintenance. Host RSS 60.98 -> 49.97 MB and startup CPU 390 -> 280 ms improved in the retained pairs; full-agent readiness was inconclusive. Worker tail improvement includes an imposed baseline hold and does not establish a 2.4-second user-visible spawn improvement. Five-worker cohort RSS improved at the specified hold point. Do not extrapolate it into private memory per worker or steady idle CPU.

B3 is `docs/performance/2026-09-06-cell-git/README.md`. Landed changes combine fresh Cell Git config writes, replace reconfigure history hydration with a pending probe, and add complementary command indexes with a corrected pending-delete selector. Fresh no-remote Cell setup uses six rather than eight Git processes. Reconfigure on 100k settled commands eliminates a transient history spike. Sparse history reads improve sharply. Complete 100k own-history results remain complete and ordered but measured CPU rose 7.3% and wall rose 50.1% in the final shared-load fixture. An existing-DB UUID fixture added 10.297 MB, 28.2%, of allocated SQLite pages, plus installation and update cost. Synthetic update timings used synchronous=OFF and do not measure durable enqueue latency.

Remediation for C15/C17 must retain all results. First separate indexed fetch, JSON mapping, consumer repetition and response serialization. Compare bulk access/query choices, row mapping and explicit new bounded consumer APIs without changing existing full-result APIs. Any index change must rerun sparse/full histories, ordered mixed statuses, pending wake/delete/update plans, durable writes, UUID storage and existing-DB upgrade. The rejected history-only and status-only prototypes already show why a one-query win is insufficient.

The first system map contains stale statements at this baseline: lifecycle filtering and latest-runtime SQL are already changed; hosts already have a dedicated artifact; command indexes exist; the current core skill explicitly requires detached-host survival. HSR already coalesces pumps to 50 ms and avoids established-host status rereads. Preserve those gains. The tmux `harvest` quiescence-derived turn-end path still conflicts with the no-silence-derived-state contract. Measure it without treating a polling change as permission to broaden that behavior.

## Metrics and workload vocabulary

B = retained bees; G = generations per bee; C = retained commands; M = mailbox rows, with pending count recorded separately; A = audit rows; L = live runtime hosts/seats; W = watch clients. Always record distributions, raw samples, failures/timeouts, bytes returned, completed work and effective service rate. p99 requires enough repetitions; a small-sample percentile is not a tail guarantee.

Metrics are wall latency, user/system CPU, peak and settled RSS, heap used, sampled allocation, retained heap, external/Buffer memory, GC pauses, event-loop delay/utilization, logical/allocated storage, WAL/page behavior, read/write bytes and operation counts, socket buffering, file descriptors, timers, worker/thread counts, process counts, context switching where supported, throughput, oldest-queue age, fairness and saturation point. Their units must be explicit. RSS includes shared pages; process-tree sums are not private memory. Worker thread RSS belongs to its process. Include adopted hosts by exact identity even when PPID is 1. Capture short-lived Git/copy/SSH/provider helpers separately because periodic ps can miss them.

Each operation gets relevant cold/warm process, compile-cache and filesystem cases. Do not call an empty compile cache a cold disk. Distinguish empty/live/stopped/archived bees, pending/settled histories, same/different cursor clients, sparse/dense results, small/large/partial UTF-8 lines, low/high cardinality, same/different-origin Cell cohorts, production durability, failure/retry/restart and long-uptime churn. Large tests should climb through safe disposable sizes rather than jump straight to an unbounded load.

External-provider costs must be reported separately: model inference and tool work, harness-native startup/model discovery, OAuth/limits requests, provider quota waits, remote RTT/bandwidth, Keychain services, npm registry, kit/Hem/Linear/pro CLI execution and underlying Git/copy CPU. Honeybee owns admission, orchestration, retries it schedules, framing, copies, metadata, logging, parsing and persistence. Child CPU can be a Honeybee-induced dependency cost without being daemon CPU. Provider-stub results prove only local behavior.

## Shared instrumentation packs

| Pack | Reuse and missing coverage | Common output and owners |
|---|---|---|
| I1 | Extend existing `performance.ts` fixed-name spans and `scripts/perf/{run,worker,paired-core,command-history,command-index-upgrade,reconfigure-memory}.mjs`. No new competing tracing framework. | SQL-family count/time, prepare count, rows/bytes returned, transaction/commit time, phase CPU, plans and page statistics. C/D plus synchronous service work. Current spans cover wall phases, not every SQL call. |
| I2 | Reuse real Unix client/server fixture and `rpc.serialize` span. Add bounded counters in disposable instrumentation. | Connect/hello/parse/dispatch/serialize/write/drain/client-parse/render clocks, input partial bytes, pending calls, writableLength, client count/cursors, response bytes, gaps. R/L and legacy remote framing. |
| I3 | One correlated lifecycle timeline keyed by synthetic run, bee, generation, command, message and worker IDs. Integrate existing host/Cell runners. | Admission, eligibility, queue wait, claim, worker ready/exit, host/harness ready, first real output, interrupt, write/ack, markDelivered, stopped/re-adopted. Track failures and policy deadlines. Avoid raw bodies/env. |
| I4 | Extend process sampler with exact stored identities and short-process launch/exit accounting. Reuse runner-host and cohort scripts. | Parent/worker/host/provider/Git/copy/SSH CPU and RSS separately; births, FDs, live threads/processes, timer/probe counts. Do not sample only daemon ancestry. |
| I5 | Reuse native CPU and sampled allocation tooling; add opt-in disposable retained-heap/GC/lifetime studies. | Allocation rate, post-settle live heap, retaining paths, external bytes, process high-water versus steady RSS, residual handles/listeners/timers/maps. Only synthetic non-secret heaps; existing sampled profiles cannot establish a leak. |
| I6 | Reuse Git Trace2 and Cell rulers; add one file/storage accounting wrapper and filesystem-specific physical allocation observation. | Count logical bytes, allocated blocks, inode/file count, read/write/stat/open/fsync/rename operations, DB/WAL/SHM, all evidence stores and immutable versions. Separate nested Git timing and actual child CPU. Record graph/file counts and cache path actually used. |
| I7 | One fake provider/credential transport rig for AccountsService, LoginFlowService and naming; later use separately authorized native provider probes. | Local preparation/queue/protocol/persistence versus external wait, concurrency, refresh age, retries, single-flight, token/model usage and child lifetime. No credential contents or raw login output in performance artifacts. |
| I8 | One redacted recorded-event replay runner for adapters, transcript projections, search and contract validation. | CPU/MB, allocations, signals/projections equality, chunk-boundary behavior, malformed/oversized cases, map growth and output bytes. Provider transport is absent. |
| I9 | Existing strict comparison/provenance and overhead scripts. Add application-level disabled/enabled/capped comparisons. | SHA/tool/artifact hashes, Node/OS/boot identity, load and order, all samples and failure status, observer CPU, dropped/trimmed events, final serialization/flush cost. Keep attribution captures separate from headline timing runs. |
| I10 | Conditional legacy activation of the same packs, after confirming actual entry point. | FROZEN state, binary/export/verb, legacy node kind and provider adapter recorded with every result. Do not pool legacy and v2 measurements. |

Most rows reuse several packs. Implement I1-I6 once, then add workloads by ID. I7/I8 cover services and parsing. I9 governs every capture. I10 is a path label, not a second measurement framework.

## Correctness and verification keys

K1: one serialized SQLite authority per node, production durability retained, atomic effects and rollback, duplicate keys return the original effect, semantic no-ops remain quiet. Telemetry/legacy records are not competing v2 lifecycle truth.

K2: lifecycle/runtime vocabulary, generation fencing, finite boot/retry budgets and real-evidence reset. Silence proves no completion/idle/crash. Every time-based policy still runs on schedule.

K3: accept mail independent of process health, atomic wake intent, eligible FIFO, urgency semantics, exact consuming generation, no logical double delivery, durable I1 violation when policy bound is missed. Pending cancellation/expedite must not corrupt delivered history.

K4: complete ordered results where promised, append-only audit/evidence contracts, exact snapshot/delta shape, seq/baseSeq gap recovery, immutable historical pages, deterministic projections and explicit stale fallback. Privacy/secret redaction remains intact.

K5: exact PID/PGID plus birth identity, bounded process cleanup, single-flight ownership, no sibling signaling, surviving hosts retain PID and generation across production daemon restart. Corrupt/missing recovery evidence degrades conservatively.

K6: Cell ledger replay/idempotence, unchanged origin, exact requested SHA/contents, independent Git graph, safety config/hook behavior, sandbox rules, dirty-check refusal and cleanup of owned paths only. Cache miss or maintenance failure must preserve correct fallback.

K7: home/account binding and credential freshness, serialized rotating-token refresh, bounded login worker life, no secret leakage, truthful health/usage, stable naming precedence/retries and account-selection fairness.

K8: immutable versioned runtime artifacts, exact host entry and deployment manifest, atomic publication/rollback, retained protected releases and unchanged verification gates. No live-tree symlinks or hand-copied runtime mutation.

Narrow verification targets in the table are existing test-file families plus the specific scenario described. `core/foo` expands to `v2/core/tests/foo.test.ts`; `daemon/foo`, `adapters/foo`, `driver-hsr/foo`, `driver-cell/foo`, `driver-tmux/foo` follow the same convention. `v2/cli/foo` means `v2/cli/tests/foo.test.ts`; `tests/foo` means root `tests/foo.test.ts`; `scripts/perf/foo` means the corresponding `.test.mjs`. Wildcards indicate the named provider/file family, not a proposal to rerun the entire repository after every measurement. `v2/harness` supplies the invariant harness. These are future gates, not tests run by this inventory task.

P1 means measure early because cost repeats, blocks the daemon, scales sharply, or has a documented tradeoff. P2 means follow with workload-specific or conditional measurements. P3 means low expected standalone payoff. 'P1 conditional' means first establish that the shipped legacy path is actually used. No P label claims a measured defect.

## Coverage and boundaries

The following matrix groups directories for readability. `coverage.tsv` lists all 113 exact directories with tracked direct-file counts and scope classification. Source indexing covered all `src/`, `v2/*/src` and `scripts` TypeScript/MJS files. Detailed body inspection concentrated on operational v2 paths and selected shipped legacy call paths. Definitions/tests-only folders are not production loops.

| Directories | Coverage and inventory ownership |
|---|---|
| `v2/core/src` | Schema, store operations, view/mirror/audit and import/package/account/task helpers indexed; main SQL bodies traced. C01-C29, S04, S17. |
| `v2/daemon/src`, `v2/daemon/src/login` | Boot/shutdown/tick/dispatch/RPC/config/identity/services/login/naming/profiling call paths inspected. D/R/S/P/Z. |
| `v2/cli/src` | Entry/routing/context/selectors/read-only/render/wait/transcript/service paths inspected. L01-L11. |
| `v2/adapters/src` | All shipped adapter and args symbols indexed; protocol parsing/encoding contracts inspected. A01-A05. |
| `v2/driver-hsr/src` | Host lifecycle, journal pumping/recovery, delivery/socket/process identity and cleanup bodies inspected. H01-H10. |
| `v2/driver-cell/src` | Worker/ledger/provision/image/CoW/sandbox/capture/remove paths inspected. E01-E12. |
| `v2/driver-tmux/src` | Spawn/delivery/echo/harvest/tail/discovery and projection symbols inspected. T01-T07, A06. |
| `v2/harness/src` | Production loop linkage and verification role inspected/indexed. Simulation/faults/invariants are verification cost, not production idle work. P01/Z02. |
| Every `v2/*/tests`, fixture and `test-agent` subtree; smoke files | Filenames and targeted verification ownership inventoried. Fixtures and tests not exhaustively reread or executed. Narrow targets are prospective. |
| `src/cli`, `src/commands`, `src/completion` | Package entry points, dispatcher branches and completion bodies inspected. Remaining command bodies selectively traced. L10, X paths, deploy. |
| `src/accounts`, `src/limits` | Legacy registry/selection/sync helpers indexed and caller paths traced; not all provider implementations read line-by-line. X23/X33. V2 services are S rows. |
| `src/daemon` | Legacy tick/wiring/supervision/worker and remote policy entry points inspected; individual dispatcher internals selective. X04-X06, X16/X33/X35. |
| `src/hsr`, `src/hsr/adapters`, `src/substrates` | Legacy host/startup queue/events/identity/remote transports and entry paths inspected; large remote controller and every adapter body not exhaustively reviewed. X07-X14. |
| `src/buz`, `src/recovery`, `src/tasks`, `src/requests` | Durable legacy mail/recovery/task/request entry points indexed; selected storage/admission paths traced. X15/X16/X21/X29. |
| `src/execution` | Shipped contract export boundary and legacy service/run/operation/working-copy paths inspected at interface and selected body level. X17-X19. |
| `src/comb`, `src/flight`, `src/flow`, `src/loop` | Public SDK versus legacy scheduler distinction verified; controller/store/run/loop symbols and selected body paths inspected. X20-X22. |
| `src/search`, `src/spend`, `src/transcripts`, `src/view` | Search and transcript cache bodies inspected; spend/usage and view source paths traced. X01/X24-X26. |
| Root `src/*.ts` | All indexed. Entry/deploy/runtime/lock/fs/store/fleet/fork/thread-copy/naming/pro/project/UI/helper families assigned across L/P/S/X. Pure formatting/parsing/selector helpers belong to caller CPU, not independent invented services. |
| `scripts/perf` | All ruler/profiling/comparator scripts indexed; guides and selected measurement implementations inspected. I1-I9/P07. No captures run. |
| Other `scripts` | Build/test/runtime packaging/deploy-settle/home-reclaim entry points inspected/indexed. P01-P04/X28. No builds or reclamation run. |
| `contracts/execution/v1`, schemas and all fixtures; `contracts/combs/v1`; root `contracts` | Package-shipped corpus and loader/validator reachability inspected. X17/X20/P01. Individual corpus files not exhaustively read. |
| `tests`, `tests/fixtures` | Test filenames and ownership inventoried. No test execution or wholesale body review. |
| `docs/performance` and all three September round/evidence subtrees | Required reports read. Raw evidence files enumerated; native profiles not decompressed/reanalyzed, all samples not independently recomputed. B0-B3 distinguish evidence strength. |
| Other `docs`, `docs/adr`, `docs/incidents`, `docs/missions`, `docs/review`, `docs/reviews` | Directory inventory only except material referenced in required reports. Historical design prose does not establish reachability. |
| `.agents/skills/honeybee-core-work` and `agents` | Mandatory SKILL read completely; support metadata inventoried. |
| `.claude`, `.claude/skills` | Inventory only. CLAUDE instructions deliberately ignored per user contract. |
| Repository root package/lock/tsconfigs and `test-bg.mjs` | Package entry/build/export metadata inspected. Lockfile and test-only scratch contents not fully inspected. |

Scope not observable here: Apiary UI/render/materializer implementation; installed external consumer frequency; production fleet/node topology; remote machines; provider internals and current provider timing/cost; OS SQLite/Node/Git/native-addon implementation; actual physical CoW sharing; current heap retention and FD leaks; cold disk; deployment artifacts generated at this SHA; and live configuration. There is no `.github` directory in this baseline, so no repository-local GitHub workflow was available to inspect. No CI/deploy state was queried for this report-only task.

## Suggested measurement sequence

1. Add tracker rows from the TSV with status `unmeasured`, except explicit B1-B3 regression baselines marked `previously measured`. Preserve evidence provenance and partial/inconclusive outcomes.
2. Reuse the shared instrumentation packs in disposable fixtures. Start with quiet-core/history, exact selector/wait and RPC buffering costs, then journal recovery and synchronous Cell maintenance RPCs.
3. Measure parent/host/worker/provider-helper resources together. Progress through cohort widths while recording CPU, memory, disk and per-bee fairness. Identify the first saturated resource before changing concurrency or cadence.
4. Add account/login/naming, large transcript and retention workloads. Measure negative/timeout/cancel/restart paths as separate cohorts.
5. Activate legacy/remote rows only for confirmed shipped usage, retaining their separate source path labels and external wait attribution.
6. For each candidate optimization, compare uninstrumented paired captures with identical workload/tool/artifact identity, complete results and failure accounting. Run the narrow correctness target and required typecheck/test/build gates only in the implementation task. Report regressions, storage costs and inconclusive tails alongside wins.

This inventory introduces no new optimized claim. Its completion means the source-grounded backlog and inspection boundaries are recorded, not that every workload has been measured or every cost has been eliminated.
