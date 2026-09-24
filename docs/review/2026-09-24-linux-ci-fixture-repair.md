# Linux source CI fixture repair

The bounded HON-1/Jev CI repair fixes undeclared executable dependencies, macOS-only expectations, a pool-sweeper scheduling race, and the source runner's old tmux version. It does **not** make the entire Linux gate green: two unchanged failures reproduce on the pre-feature revision. Their assertions remain enabled.

Base: `80f98c40fc9965e17033882d02ad9387f608f23d`. Pre-feature comparison: `ba4b29d1`. Branch: `codex/repair-linux-ci-fixtures`. Original failed workflow: <https://github.com/honeybeehq/honeybee/actions/runs/36017470867>.

## Changes and reproduced causes

| Area | Reproduced cause | Repair |
| --- | --- | --- |
| demote, kit, sandbox-write spawn | Missing `codex` or `claude` prevented the intended assertion from being reached | Temporary PATH executables satisfy admission and exit 97 if unexpectedly executed; launch interception and outcome assertions remain intact |
| keybindings | `keys check` inspected PATH for an installed `hive` | A temporary `hive` executable satisfies that inspection; tests still inspect real private tmux bindings |
| daemon install | Test assumed launchd startup evidence on Linux | Assert the existing platform-dependent result |
| sandbox availability | A synthetic Darwin probe expected a real `/usr/bin/sandbox-exec` on Linux | Separate the native macOS availability test with an explicit non-macOS skip; retain Linux availability and native containment assertions |
| pool sweep | A 5 ms sleep raced background clone completion | Capture the existing `startBackground` seam, assert one job, and await it |
| source workflow | Ubuntu 22.04's tmux 3.2a lacks `allow-passthrough` | Use Ubuntu 24.04/tmux 3.4 and require a successful native bubblewrap preflight |

No production implementation, dependency, release workflow, provider configuration, or deployed runtime changed. `release.yml` already used Ubuntu 24.04 at the base; this repair makes no claim about retaining an Ubuntu 22.04 release ABI.

## Validation

Authoritative local Linux fixture: Ubuntu 24.04, Node 24.15.0, tmux 3.4, bubblewrap, ripgrep and socat; fresh `npm ci`; nonroot UID 1001; isolated Docker container with `--init --privileged` and no host mounts. Native bubblewrap preflight passed. This is Linux arm64, not the exact GitHub-hosted x64 VM, and is source-validation evidence rather than release acceptance.

| Command / group | Result |
| --- | --- |
| `npm run check` | Passed |
| `npm run v2:check` | Passed |
| `npm run build` | Passed |
| `npm test`: release inventory | 16 passed |
| `npm test`: source groups combined | 3,681 passed, 23 skipped, 1 baseline failure |
| Eight affected test files, serial | 116 passed, 1 macOS-only skip, 1 baseline native failure |
| `npm run v2:test` | 372 passed |
| `npm run v2:daemon` | 598 passed, 5 skipped |
| `npm run v2:driver` | 127 passed |
| `npm run v2:driver2` | 162 passed, 21 skipped, 1 baseline failure; same result on rerun |
| `npm run v2:harness` | 14 passed |

Run the focused source checks after `npm run build:test`:

```sh
HIVE_TEST_REPORTER=spec HIVE_TEST_CONCURRENCY=1 node scripts/run-tests.mjs \
  tests/cli-demote-strict.test.ts tests/cli-keybindings.test.ts \
  tests/daemon-install.test.ts tests/hsr-cell-sandbox.test.ts \
  tests/kit.test.ts tests/poolSweep.test.ts \
  tests/spawn-sandbox-write.test.ts tests/substrates.local-tmux.test.ts
```

Before repair, the corresponding Ubuntu 22.04 group had 104 passes, 12 failures, and one unavailable-native-sandbox skip. It reproduced missing executables, the launchd/Darwin assumptions, the pool race, and unsupported tmux options. Reduced-PATH macOS reproductions independently failed kit/spawn admission (15 pass, 2 fail) and keys inspection (7 pass, 4 fail); after repair those groups passed 17/17 and keys plus demote passed 13/13. Linux platform checks and pool checks also passed independently after their repairs.

An exploratory macOS Node 25.4 run passed check, v2:check, build, and v2 core (372 tests), but the full source run failed on additional host/runtime/warning expectations, including SQLite warnings in expected-empty stderr and v2 routing/artifact errors. It is not a green receipt. The redundant macOS v2 daemon run was interrupted while the pinned Linux run completed every v2 gate; its cancellation output is not a product failure or a pass.

The first Ubuntu container lacked an init/reaper. Observed orphan zombies caused false process-group-cleanup failures. Those runs were discarded for final validation; adding `--init` eliminated the demote cleanup failure without a code change.

## Confirmed baseline blockers

1. **Native Linux Cell sandbox permits a protected package hook.** The unchanged assertion in `tests/hsr-cell-sandbox.test.ts` expects `node_modules/pkg/.git/hooks/postinstall` to be absent, but reading it succeeds. This reproduced on actual `ba4b29d1` with its own `npm ci`, build and compiled tests, first on Ubuntu 22.04 and again in the final Ubuntu 24.04 fixture. Baseline Ubuntu 24.04 had 9 passes and 2 failures: the macOS availability assumption repaired here, and this native containment failure. The sandbox implementation, original native test, and sandbox-runtime dependency are unchanged across the feature range. The test stops at the hook assertion, so later containment/server assertions are not claimed as verified by this run.
2. **tmux driver's TERM-escalation timing assertion fails on Linux.** `v2/driver-tmux/tests/driver.test.ts:124` reports `exit before the grace window — TERM was not ignored`. The full driver2 gate failed identically twice. Actual `ba4b29d1`, installed independently in the same final Linux fixture, produced 7 passes and this same failure with `node --test v2/driver-tmux/tests/driver.test.ts`. The entire `v2/driver-tmux` tree is unchanged across the feature range and by this repair.

Neither assertion was weakened, skipped, or moved behind an optional gate. CI now fails explicitly if the native bubblewrap prerequisite is unavailable. Resolving these baseline blockers requires separately scoped work; a green Linux CI claim is premature.

## Review and evidence

Independent standards and spec reviewers inspected the bounded diff against the core skill, AGENTS instructions, and originating repair scope. Both reported **zero actionable findings**. The standards reviewer also approved the corrected release-workflow comment. Reviews were static; the execution results above are the primary agent's receipts.

Local logs retained under `/tmp`:

- `honeybee-linux24-validation.log`: install, check, v2:check and build. Its initial test-build failure came from macOS `._` archive metadata, removed only from the container before final runs.
- `honeybee-linux24-init-tests.log`: complete final source run.
- `honeybee-linux24-init-focused.log`: complete affected-file run.
- `honeybee-linux24-init-v2-{test,daemon,driver,driver2,harness}.log`: final v2 gates.
- `honeybee-linux24-init-driver2-rerun.log`: repeated driver2 failure.
- `honeybee-linux24-init-baseline-{sandbox,driver}.log`: actual pre-feature reproductions with independently installed dependencies.
- `honeybee-linux-red.log`, `honeybee-repair-{red,green}-cli.log`, `honeybee-repair-{red,green}-keys.log`, `honeybee-linux-green-{platform,pool}.log`: red/green fixture evidence.
- `honeybee-repair-{check,v2check,build,test,v2test,v2daemon}.log`: exploratory macOS results, including failures and interruption.
- `honeybee-linux-repair/Dockerfile.24`: isolated Linux fixture recipe.

The fixture executables deliberately fail if called, the pool test awaits actual completion, and the CI native preflight prevents a skipped containment test from masquerading as coverage. No push, merge, workflow dispatch, deploy, publication, live Jev call, credential activation, or live runtime restart was performed.

Prevention lessons: validate admission tests with a clean PATH, assert OS-specific behavior on each supported platform, and control asynchronous fixture completion instead of sleeping. Keep real containment checks mandatory and distinguish product failures from container infrastructure failures using actual baseline reproductions.
