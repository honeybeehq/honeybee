# Loaded macOS deploy-gate proof

The changes affect disposable tests and test infrastructure. Production daemon shutdown still preserves detached runners. No deployment or live-daemon operation was performed.

**Verdict:** both complete daemon/CLI runs passed on native macOS under CPU stress. Each completed 170 groups with 1,690 passed tests, 41 skips, zero failures and zero cancellations, in 106.7 and 106.9 minutes. Each run owned ten CPU workers (twenty during overlap). Build, typecheck, core, driver and harness checks passed against the same source freeze. The extra release-only driver2 check remains red and is disclosed below.

## Runner ownership before test shutdown

After a daemon restart, persisted idle or completed-turn facts can be visible before survivor adoption finishes. SIGTERM disables identity recovery; test-only `RuntimeHost.disposeAll()` can signal only the processes its driver owns. An unresolved survivor can therefore remain live in its detached process group after the test daemon exits.

The helper now waits for unresolved identities belonging to actual fixture hosts before sending SIGTERM. It samples receipts every poll, waits through a matching torn receipt, and retains native identities for the post-exit check. Synthetic persisted PIDs without a corresponding fixture host do not block teardown. Any stop failure triggers cleanup of owned disposable processes and then preserves the original rejection.

The strict four-second runner-reap postcondition remains unchanged. Production shutdown behavior and native birth-fenced signalling remain unchanged.

`ownership-red.log` removes only the ownership wait from the final regression and reproduces the reported failure shape on Darwin: a matching live host, parent PID 1 and PGID equal to its own PID, followed by the reap timeout. `ownership-green.log` passes the same regression with the wait. The full helper file also checks torn receipts, never-released ownership with the exact expected rejection, native host exit, zombies and reused PID births. This proves the ordering mechanism, not the historical OS transient that delayed adoption on Studio.

## Synchronization and finite budgets

| Change | Evidence and preserved checks |
| --- | --- |
| Default test daemon exit allowance: 6 → 30 seconds; explicit overrides preserved | The two reported account failures occurred during exit after RPC assertions. Their focused probe passed with 103 ms and 115 ms exits, so the historical six-second cause remains unproven. This is a separate finite load allowance; the four-second live-host check still applies. |
| Grok policy clock advances only at intended checkpoints | The stressed original saw generation 3 where generation 2 was expected because slow CLI startup raced automatic refresh. Token-generation and provider-call assertions remain; timers stay real. Fake Grok startup gets a bounded 60 seconds. |
| Auth-death policy time waits for persisted rejection and a fresh same-generation idle edge | The original 700 ms idle window stopped the runner before native initialization under load. The test preserves that policy, asserts the idle timestamp, then advances it by 701 ms. Source daemon and child fixture clocks remain real. |
| Pressure checks await completed health/log receipts | Replaces two-second and 1.5-second sleeps. Existing eviction, protection and post-stop audit assertions remain. A fetch-failure receipt was already allowed; this does not prove a successful remote fetch. |
| Retention test repeats its automatic pass every 200 ms | An early pass can precede slow Cell setup/stop; the next pass used to be one hour away. The 60-second eviction bound and safety assertions remain. |
| First quiet native turn gets a 60-second startup allowance; later turns retain 20 seconds | Synthetic idle precedes native initialization and readiness retry can reach 30 seconds. Overall case deadline remains 90 seconds. Failures include runtime and trigger diagnostics. One intermediate first-turn failure remains unattributed. |
| Handoff matrix has one discovered file per harness, with 480-second cases under existing 600-second file deadlines | Callback body is byte-identical to the original (`handoff-extraction.txt`). Inner 30-second state polls and 60-second RPC bounds remain. In the diagnostic frozen pair, Codex took about 252 seconds, Grok 229 seconds and Claude 227–228 seconds; all assertions passed. Exactly three harness cases register. |
| Driver cold-start check uses its existing 15-second allowance | Warm-turn checks retain three seconds; event counts/types remain. The native scheduling smoke checks observed scheduling facts rather than assuming its Cell parent is foreground; deterministic classification/repair tests remain. |

## Test parallelism

The daemon/CLI runner already runs process-backed files serially. Its 14 unit files form one group with Node isolation `none`; a native probe observes sequential top-level execution even with the existing concurrency-eight flag. The final census is 159 daemon files plus 24 CLI files: 169 serial files and one unit group, or 170 groups (`census.json`).

The driver and driver2 stages now choose file workers from `floor(availableParallelism - one-minute load)`, clamped to one through eight. A positive integer `HIVE_TEST_CONCURRENCY` overrides it. Load is an advisory startup snapshot, not a reservation. Policy tests cover saturation, fractional load, overrides and invalid values. Actual SIGINT/TERM/HUP checks confirm the owned native controller and worker exit (`launcher-signals.json`). The launcher retains fixture leases and does not force successful exit over leaked workers.

## Question-egress census work

The first frozen pair completed with only one failed file: eight fresh TypeScript-program scans exceeded the unchanged 600-second file deadline. Those complete runs are retained as diagnostic red artifacts, never counted as final passes.

The helper now computes location details only for records it emits and reuses completed root-type queries within one program/checker. Recursive false results are never cached: ancestor pruning is contextual. Every patched-source census still receives a fresh program and cache.

The entire raw census is identical before and after (`census-count-parity.json`). The same 41,691 queries contain 9,222 distinct root types: complete walks fall from 41,691 to 9,222, and recursive walks from 792,588 to 116,136. A cyclic-type regression checks A → B → A with a reachable question, repeated positive B roots and negative self-cycles. All seven independent injected-defect checks remain. The complete three-test/nine-program file passed in 539.8 seconds under the unchanged 600-second cap; it then passed in both complete frozen runs in 512.6 and 520.1 seconds with all twenty workers still active. In the 539.8-second focused run, twenty shared stress workers remained through all but its last approximately 20 seconds; that focused timing is not a constant-load baseline.

The executable count recipe enforces zero repeated complete root walks. It passed and reproduced the exact raw census and counts. The map checker passes its real receipt and fails the deliberately violated invariant. Counts are deterministic; instrumented/shared-host timings are not a stable latency claim. The scoped workload is in `.agents/skills/perf-honeybee/workloads/question-egress-census.*`.

The existing perf map has 303 unaccounted keys, five dead accounts and 46 stale owners. Comparison against the base configuration and records on this same source tree proves this extension adds no drift (`perf-map-existing-drift.json`). The map is not claimed globally clean.

## Verification receipts

| Check on the current freeze | Result |
| --- | --- |
| Typecheck and native build | Passed (`typecheck.log`, `build.log`) |
| Core | 731 passed, zero skipped/failures/cancellations |
| Driver | 281 passed, four unchanged platform/legacy skips, zero failures/cancellations |
| Harness | 14 passed, zero skipped/failures/cancellations |
| Perf-map unit tests and count gate | Passed; negative-control invariant fails as intended |
| Verified full A and B, each with ten owned CPU workers | **Passed:** 170 groups each; 1,690 passed, 41 skipped, zero failures/cancellations; 6,403.4 and 6,411.4 seconds |
| Extra release-only driver2 | **Failed:** 183 passed, 20 failed, four skipped |

The current standard-stage logs and `verified-*` workload/results match the source freeze. Native host, Node version and CPU count are in `host.json`. CPU samples record owned worker ancestry, liveness and consumption. Full-run workloads record command, isolation roots, stress PIDs and launch fingerprints. The wider source and built-artifact manifests are retained.

The extra driver2 failures are in unchanged assertions: a provision-worker focused repeat observes seven Git commands versus an expected six; native secret-execution cases encounter Darwin's explicit containment refusal, and some lease tests first time out waiting for a child that never starts. The count mismatch is not declared harmless. No same-platform baseline suite was executed. Standard deploy excludes driver2; `--release` includes it. No release-ready claim is made.

## Reproduce safely

From this checkout with pinned dependencies installed and the native build complete:

```sh
STRESS_WORKERS=10 python3 .proof/macos-full-gate/run-stressed-suite.py new-full-run
STRESS_WORKERS=0 python3 .proof/macos-full-gate/run-stressed-suite.py new-ownership-run --test-name-pattern='test teardown waits for survivor' v2/daemon/tests/helpers-teardown.test.ts
```

Reproduce the old ordering against the current regression without editing source:

```sh
NODE_OPTIONS="--import=$PWD/.proof/macos-full-gate/original-shutdown-loader.mjs" STRESS_WORKERS=0 python3 .proof/macos-full-gate/run-stressed-suite.py new-ownership-red --test-name-pattern='test teardown waits for survivor' v2/daemon/tests/helpers-teardown.test.ts
```

The last command is expected to fail the strict live-host reap check. Omit `NODE_OPTIONS` to check the fix.

The harness creates short `/tmp/hbm-*` roots, isolated HOME/XDG directories and explicit HIVE home/store/socket paths. Each daemon fixture supplies its own data/Node paths and gateway policy. Inherited global deployment pins and Apiary variables are removed. Keychain access and npm update/network checks are disabled. It runs the repository fixture warden and stops only its own CPU workers. It leaves its temporary root for inspection; use trash for removal. Never run a build while daemon tests are active.

`run-capture-harness-v1.py` is the exact harness whose hash is stored in the verified full-run workloads. The reproducer adds artifact-parent directory creation for a fresh checkout and propagates the recorded child status after cleanup. Commands, isolation and stress workers are identical. The archived wrapper recorded child failures in result.json but itself returned zero; verdicts use the child result, never that outer status. The receipt checker validates the archived hash and exact two-change reproducer equivalence. Its source scope is the roots and suffixes declared in `verify-receipts.py`, not every file in the checkout.

Validate the stored full-run receipts, defined source snapshot, exact discovered file names/declared grouping, named regressions and sampled stress without starting services:

```sh
python3 .proof/macos-full-gate/verify-receipts.py
```

The checker requires complete launch-fingerprint dictionaries, rejects missing/new matching source paths, and compares exact file names. Passing logs report group summaries without a filename for every group: it checks their count and named regressions, and trusts the frozen runner plus recorded unfiltered command for execution identity. Stress observations verify worker IDs, parentage and CPU consumption at sampled times; they are not continuous monitoring. Other-stage logs, build/check completion and built-artifact hashes are separate evidence, not re-executed by this checker. `checker-negative-controls.json` records malformed-receipt controls; `python3 .proof/macos-full-gate/checker-selftest.py` exercises them and rejects unapproved reproducer changes using owned scratch fixtures.

For the manual count gate:

```sh
node --import=./.proof/macos-full-gate/census-count-loader.mjs .proof/macos-full-gate/census-capture.mjs .audit/macos-gate/census-counts.json --require-reuse
```

## Review and limits

Read `ATTENTION.md` and the decision trail for failed and rejected intermediate experiments. Earlier red, interrupted or mixed-source runs are not final passes. Historical adoption delay and six-second exit latency remain unproven; controlled regression evidence is kept separate from attribution.

Independent source review used codex/gpt-6.1-sol in a fresh isolated Cell, as required by the user. No Medium-or-higher source finding remains in the supplied patch. This was source/receipt review, not independent execution of the full Mac suite. Final independent receipt review is recorded separately. The generic repository verification skill was missing and reported as a setup issue.
