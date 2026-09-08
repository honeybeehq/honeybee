# Art nightly honeybee evidence, 2026-09-07

These excerpts and SHA-256 digests make the local verification record readable in the repository. Each digest identifies the original complete log. Excerpts omit routine progress output. Exit codes are recorded by the command runner; an empty lint log alone is not treated as proof.

Source and fix revisions below refer to the reviewed feature branches where indicated. Publishing this document does not publish those feature branches or claim a live UI/model run.

- Same-millisecond Cell receipts could select an older UUID instead of the latest insertion. Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4`; repair `0472a91c99d7a75c19429b6bffc9988e57c2a272`. Integrated in this publication as a27668070e69da6ecef87bd8f8a7b90f5f2f6d13.
- Retained Cell RPC and CLI optional arguments silently accepted wrong types. Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4`; repair `0472a91c99d7a75c19429b6bffc9988e57c2a272`. Integrated in this publication as a27668070e69da6ecef87bd8f8a7b90f5f2f6d13.
- External lineage ID collisions appeared as local children. Source `eb4a77c2a5356864bd9c495b3deb290ab04860e4`; repair `ac33d942ccd7f522092cd3e8f7d7029e53a0a46a`. Integrated in this publication as 6e10b33b841965c8ad7bee41c081376fd3ec8864.
- Managed runtime-artifact same-SHA verification omitted complete manifest bytes. Source `d7d7072477dfd03e77778d78625fceb42ee571bf`; repair `d20df402a62beea1e0f98354cf15bf641de5060d`. fixed and verified on owning branch art/nightly-2026-09-07-runtime-artifact-fix; not pushed.
- Runtime-artifact release same-SHA verification omitted complete manifest bytes. Source `19572e1ee96412a8fd63dc02809328ea6f79bc5d`; repair `29dce91870e0c5a4106d30db248dfea8d705226f`. fixed and verified on owning branch art/nightly-2026-09-07-runtime-release-fix; parent independently reviewed; not pushed.
- Initial bounded dedup sweep could forget a reentrantly-added live ID. Source `24a4604ba7d4e3c0965d67cc7dc3cf84b43ce98e`; repair `1576571cd45dd5235bfc7ee8aedfd1702fd99bbd`. superseded before frozen main; correction retained in b60e1310dc3da1da33dafed85653ba1b7c648b7f.
- Evidence manifest checksummed CRLF bytes instead of the committed LF CSV. Source `487972cf1f6a7818766b422d116d6f997c0c8129`; repair `30154e6a4ffb04a70aed4195813739fef511201f`. verified and committed on parent main publication branch; 1484 current manifest entries pass; Included in this publication.
- Archived dedup fixture count field excluded scenario-specific messages. Source `6d2677b126ec9e8b11992954bb6bc3c27311bbf1`; repair `cc30665984bdddf42a1f02e2ac2a835102745143`. corrected by parent publication erratum; immutable archives preserved; fresh original-v3 probe confirmed 20 background, 21 wide, and 276 probe rows; Included in this publication.
- Same-millisecond Cell receipts could select an older UUID instead of latest insertion. Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4`; repair `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`. Included in this publication.
- Retained Cell RPC optional arguments silently accepted wrong types. Source `4d0f34dd19798c9f86cc914f4c4f03030dc482c4`; repair `a27668070e69da6ecef87bd8f8a7b90f5f2f6d13`. Included in this publication.

## check-cell-pnpm-check.log

Command: `pnpm check`

Recorded exit: `0`. Original bytes: `160`. SHA-256: `dd13cc8629aab8acf9f88f44c0089c84f67ea2ccc9b3334bd36f87996bfb0d80`.

```text
> honeybee@0.0.1 check /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
```

## check-cell-pnpm-v2-check.log

Command: `pnpm v2:check`

Recorded exit: `0`. Original bytes: `376`. SHA-256: `6f9cdb9ca411ff3f06c69b8730e0f861a745dd686b6699339333250d6254ec19`.

```text
> honeybee@0.0.1 v2:check /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json
```

## check-pnpm-build.log

Command: `pnpm build`

Recorded exit: `0`. Original bytes: `721`. SHA-256: `986e1be2b4d384b46d2aee2f72b03ea5567167ae75dbde6c63d31e990ef11f8c`.

```text
> honeybee@0.0.1 build /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs
runner-host artifact 87f87fc12e71923281e931739fd987faf7ac2d1135faf0eb656065d8b6e2521f (1618627 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js
> honeybee@0.0.1 postbuild /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07
> chmod +x dist/cli.js dist/cli-x.js
```

## evidence-quiet-tooling.log

Command: `node --test scripts/perf/compare-quiet.test.mjs scripts/perf/sql-trace.test.mjs scripts/perf/quiet-tick.test.mjs`

Recorded exit: `0`. Original bytes: `813`. SHA-256: `8d797b0eed7f4c360106b55930906722bc1668071386a8610802b1e73720c538`.

```text
✔ restores native methods after SQL failure and rejects partial iterator accounting (14.569125ms)
ℹ tests 7
ℹ suites 0
ℹ pass 7
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2402.090292
```

## evidence-runtime-artifact-tests-green.log

Command: `pnpm test -- tests/runtime-artifact.test.ts tests/deploy-artifact.test.ts tests/deploy-runtime.test.ts tests/deploy-cli.test.ts`

Recorded exit: `0`. Original bytes: `1193`. SHA-256: `16a8660b8c29b910b6bf64fd509569b15634c8746e92550a2cbe45ab1343a631`.

```text
> node scripts/build-tests.mjs
build:test: up to date
> honeybee@0.0.1 test /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact
> node scripts/run-tests.mjs -- tests/runtime-artifact.test.ts tests/deploy-artifact.test.ts tests/deploy-runtime.test.ts tests/deploy-cli.test.ts
....................
....................
............
```

## check-runtime-artifact.log

Command: `pnpm check (runtime-artifact branch)`

Recorded exit: `0`. Original bytes: `191`. SHA-256: `a7bafffd231cb79995480f50589777a10296b6f3805d7d66a9cb25eac7db96d2`.

```text
> honeybee@0.0.1 check /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
```

## v2-check-runtime-artifact.log

Command: `pnpm v2:check (runtime-artifact branch)`

Recorded exit: `0`. Original bytes: `407`. SHA-256: `fd109199e7b9ebcac36a9f9f2c2ab755b671545b2a2e65ea9a42107b58bd5d7d`.

```text
> honeybee@0.0.1 v2:check /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json
```

## build-runtime-artifact.log

Command: `pnpm build (runtime-artifact branch)`

Recorded exit: `0`. Original bytes: `841`. SHA-256: `8597907d0488cf542708483972e34768a6e218afa60fa37df320b74e90eb6cc2`.

```text
> honeybee@0.0.1 build /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs
runner-host artifact 1b553e3486ad990ef9e82005938ebc290d3cb79418d6739e5003839cc7f7968d (1618654 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js
> honeybee@0.0.1 postbuild /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact
> chmod +x dist/cli.js dist/cli-x.js dist/artifact-installer.js
```

## red.log

Command: `node --test --test-concurrency=1 /Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-cell-parent/probe.mjs (pre-fix parent publication head)`

Recorded exit: `1`. Original bytes: `2206`. SHA-256: `fac006c6f0e1ab89020e0cd565cd63acc779a006877c9b7a1afdbf17881c2934`.

```text
✖ live RPC rejects wrong optional types before any retained operation (853.896042ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
✖ latest same-clock receipt agrees across core, live projection and stale CLI after reopen (75.874459ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    actual: { core: 'zzzz-old', projection: 'zzzz-old', staleCli: 'zzzz-old' },
    expected: { core: 'aaaa-new', projection: 'aaaa-new', staleCli: 'aaaa-new' },
    operator: 'deepStrictEqual',
✖ live RPC rejects wrong optional types before any retained operation (853.896042ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1332:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:911:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    operator: 'rejects',
    diff: 'simple'
  }
```

## green.log

Command: `node --test --test-concurrency=1 /Users/trmd/.hive/crew/art/reviews/2026-09-07/honeybee-cell-parent/probe.mjs (post-fix parent publication head)`

Recorded exit: `0`. Original bytes: `423`. SHA-256: `b36a3288adafab47d6ced57a0adb40871bed4b2e46a660d8c6774454e28515ef`.

```text
✔ live RPC rejects wrong optional types before any retained operation (1572.108459ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2917.011041
```

## focused.log

Command: `node --test --test-concurrency=1 v2/core/tests/cell-move.test.ts v2/daemon/tests/cell-move.test.ts v2/cli/tests/cell-move.test.ts (parent publication head)`

Recorded exit: `0`. Original bytes: `1976`. SHA-256: `d39ba231612703c6a9a5563e19f95633132df7f3000936a47e64e86fb1c761b9`.

```text
✔ cell-move.admit: CAS, idempotency, fence, operator stop supersedes and keeps failed receipt (123.921ms)
✔ cell-move.placement: CAS source stopped, legal transitions, instructions survive dest fail (67.850625ms)
✔ cell-move.stale stop queued before admit does not cancel the move (50.476792ms)
✔ cell-move.pre-placement fail unfences and does not keep instructions (49.832875ms)
✔ cell-move.deleteBee keeps retained cell identity (72.589708ms)
✔ cell move carries Claude transcript and completes with no mail (8658.024625ms)
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 62752.464916
```

## check.log

Command: `pnpm check (parent publication head)`

Recorded exit: `0`. Original bytes: `168`. SHA-256: `9c6df241f06415534a1df1f14661e09eaf12aec0509ed6e6ca4586709f5f9447`.

```text
> honeybee@0.0.1 check /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07-publish
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit
```

## v2-check.log

Command: `pnpm v2:check (parent publication head)`

Recorded exit: `0`. Original bytes: `384`. SHA-256: `5ef90fe0b1da1bf0105b23326c03dfacddc820845c6dbd1a41407fcac90e5467`.

```text
> honeybee@0.0.1 v2:check /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07-publish
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json
```

## build.log

Command: `pnpm build (parent publication head)`

Recorded exit: `0`. Original bytes: `745`. SHA-256: `2ff4a5b5c52513c5369021ef89f71ca46f646be11ec395c10736791201b322bb`.

```text
> honeybee@0.0.1 build /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07-publish
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs
runner-host artifact 87f87fc12e71923281e931739fd987faf7ac2d1135faf0eb656065d8b6e2521f (1618627 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07-publish/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js
> honeybee@0.0.1 postbuild /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07-publish
> chmod +x dist/cli.js dist/cli-x.js
```

## honeybee-manifest-green.log

Command: `python3 check-honeybee-manifest.py <publication worktree>`

Recorded exit: `0`. Original bytes: `38`. SHA-256: `befc52b59fad6339e11b641c296adafa51cda53a8dc6cd3d88f5e83f79085581`.

```text
{
  "entries": 1484,
  "errors": []
}
```

## check-pnpm-test-after-build.log

Command: `pnpm test (main-based fixed head, after build)`

Recorded exit: `1`. Original bytes: `30690`. SHA-256: `1f97b07c90b96d5fc9d54f0e01e01e4236d2c75b6ffc73802e1070709ff4bd36`.

```text
✖ bees sidebar toggle is quiet for tmux hotkeys (10733.785416ms)
  Error: Command failed: /opt/homebrew/Cellar/node/25.8.0/bin/node tests/cli-entry.mjs bees --toggle-sidebar --width 28
  hive: hive v2: missing v2 CLI artifact (dist/v2/cli.js) — rebuild with `npm run build`
  'test timed out after 30000ms'
✖ reciprocal active-source names fail before taking nested lifecycle locks (6474.550583ms)
  AssertionError [ERR_ASSERTION]: invalid reciprocal forks fail fast instead of timing out on locks
      at TestContext.<anonymous> (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.test-dist/tests/cli-fork.test.js:375:12)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: false,
✖ sweeper: minFree pre-extends in the background and reports completion next sweep (110.14775ms)
  [Error: ENOTEMPTY: directory not empty, rmdir '/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/honeybee-sweep-am72jE/pools'] { errno: -66, code: 'ENOTEMPTY', syscall: 'rmdir', path: '/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/honeybee-sweep-am72jE/pools' }
✖ retire and purge stay bounded when their post-exit credential harvest never settles (2143.115625ms)
  Error: final credential recovery could not be made durable; refusing to purge purge-wedged-sync: final credential sync timed out after 20ms
      at runFinalCredentialSync (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.test-dist/src/kill.js:433:11)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7)
✖ concurrent bootstrap refreshes serialize only on the shared transcript identity (14055.680667ms)
  [Error: ENOTEMPTY: directory not empty, rmdir '/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/hive-session-metadata-3C0mLT/transcript-ownership'] { errno: -66, code: 'ENOTEMPTY', syscall: 'rmdir', path: '/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/hive-session-metadata-3C0mLT/transcript-ownership' }
....................
....................
......
 ELIFECYCLE  Test failed. See above for more details.
```

## check-frozen-base-build.log

Command: `pnpm build (frozen base 98cc89c3)`

Recorded exit: `0`. Original bytes: `805`. SHA-256: `597c902d5f5f32dba3fa0cb12e58d84b7cf658f37e4e22d74fd16297be373d1c`.

```text
> honeybee@0.0.1 build /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/frozen-baseline-full
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs
runner-host artifact 87f87fc12e71923281e931739fd987faf7ac2d1135faf0eb656065d8b6e2521f (1618627 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/frozen-baseline-full/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js
> honeybee@0.0.1 postbuild /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/frozen-baseline-full
> chmod +x dist/cli.js dist/cli-x.js
```

## check-frozen-base-test.log

Command: `pnpm test (frozen base 98cc89c3)`

Recorded exit: `1`. Original bytes: `45156`. SHA-256: `b4779a399aa19c003e083be96363d695fa1b6318a9871ebdd8aba12faf30720b`.

```text
✖ bees sidebar toggle is quiet for tmux hotkeys (4842.311083ms)
  Error: Command failed: /opt/homebrew/Cellar/node/25.8.0/bin/node tests/cli-entry.mjs bees --toggle-sidebar --width 28
  hive: hive v2: missing v2 CLI artifact (dist/v2/cli.js) — rebuild with `npm run build`
  }
✖ reciprocal active-source names fail before taking nested lifecycle locks (5797.702375ms)
  AssertionError [ERR_ASSERTION]: invalid reciprocal forks fail fast instead of timing out on locks
      at TestContext.<anonymous> (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/frozen-baseline-full/.test-dist/tests/cli-fork.test.js:375:12)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: false,
    errno: -2,
    code: 'ENOENT',
    syscall: 'open',
✖ hive wait returns terminal exit 1 promptly for every output variant (6812.39925ms)
  AssertionError [ERR_ASSERTION]: plain wait should fail before its 5s timeout
      at TestContext.<anonymous> (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/frozen-baseline-full/.test-dist/tests/wait.test.js:336:14)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: false,
    actual: false,
    expected: true,
    operator: '==',
    diff: 'simple'
  }
....................
....................
......
 ELIFECYCLE  Test failed. See above for more details.
```

## check-current-only-failures-isolated.log

Command: `pnpm test -- tests/cli-flags.test.ts tests/poolSweep.test.ts (main-based fixed head)`

Recorded exit: `1`. Original bytes: `1487`. SHA-256: `5058db91fc925f938d42f6b17d4836466f9dfaebe3154ed2375a10b7f38ae5b9`.

```text
> node scripts/run-tests.mjs -- tests/cli-flags.test.ts tests/poolSweep.test.ts
....................
.............X.....
Failed tests:
✖ sweeper: minFree pre-extends in the background and reports completion next sweep (77.5725ms)
  [Error: ENOTEMPTY: directory not empty, rmdir '/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/honeybee-sweep-0Gkzr1/pools'] { errno: -66, code: 'ENOTEMPTY', syscall: 'rmdir', path: '/var/folders/y2/lgjk786x2qz6s_gt20x091vc0000gn/T/honeybee-sweep-0Gkzr1/pools' }
 ELIFECYCLE  Test failed. See above for more details.
```

## check-frozen-only-failures-isolated.log

Command: `pnpm test -- tests/cli-flags.test.ts tests/poolSweep.test.ts (frozen base 98cc89c3)`

Recorded exit: `1`. Original bytes: `2311`. SHA-256: `9371759caa8f00f3f34c4232657500fb97920b2975c9fa8dc7c7d16a74dfde84`.

```text
✖ sweeper: minFree pre-extends in the background and reports completion next sweep (64.539417ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ { pool: 'core', count: 2 } ],
    expected: [ { pool: 'core', count: 2 } ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
 ELIFECYCLE  Test failed. See above for more details.
```

## honeybee-full-suite-attribution.json

Command: `read-only full-suite source/history attribution`

Recorded exit: `0`. Original bytes: `40122`. SHA-256: `b24e5dd81796961c61144c7ebffb63aee665f25ef164c4c463e195b7425297a5`.

```text
      "currentFailureIdsThatStillFailed": [17, 27, 28, 30],
      "interpretation": "The same source switches between pass and fail under different suite schedules, while four process/race cases remain reproducible even in the historical isolated set."
    },
  "candidateIntersection": {
    "method": "Union each exact coverage candidate's full -m diff paths and intersect with 24 failing tests plus 40 primary harness/callsite paths.",
    "candidatesWithPrimaryPathHits": 8,
      "observedPattern": "missing compiled v2 CLI artifact, CLI child timeout/exit, or compiled/source entry disagreement under the concurrent legacy suite",
      "preWindowAssessment": "Eight exact names in this family already fail in the September 6 default run; most pass in the historical isolated rerun. The x and frame cases passed historically but use identical test/command blobs and fail as sibling process timeouts in the saved runs."
    },
      "observedPattern": "the fake OpenCode server does not publish its startup URL within 1500-2000 ms",
      "preWindowAssessment": "These exact names were not recorded failing before the window. The complete test and adapter blobs have been unchanged since August; the earlier saved current run fails six different tests in this same file at roughly the same 3.2-3.6 second startup boundary, which supports file-level process contention rather than a candidate code change."
    },
    {"id": 2, "logLine": 217, "title": "hive node register/update reject --ssh-args without the = form", "test": "tests/cli-flags.test.ts:128", "family": "legacy-cli-lock-child-timing", "symptom": "30-second test timeout", "attribution": "legacy unchanged; exact pre-window failure not captured", "confidence": "medium", "preWindowEvidenceLine": null, "repeatedCurrentRun": true, "followUp": false},
    {"id": 3, "logLine": 219, "title": "reciprocal active-source names fail before taking nested lifecycle locks", "test": "tests/cli-fork.test.ts:451", "family": "legacy-cli-lock-child-timing", "symptom": "correct refusal exceeded a five-second timing oracle", "attribution": "pre-window exact failure", "confidence": "high", "preWindowEvidenceLine": 214, "repeatedCurrentRun": true, "followUp": false},
    {"id": 4, "logLine": 231, "title": ".test-dist/tests/cli-helpers.unit.test.js", "test": "tests/cli-helpers.unit.test.ts", "family": "compiled-legacy-cli", "symptom": "test worker failed without a subtest diagnostic", "attribution": "pre-window exact file failure", "confidence": "high for window attribution; low for root cause", "preWindowEvidenceLine": 226, "repeatedCurrentRun": true, "followUp": false},
    {"id": 28, "logLine": 518, "title": "turn runner: exact turn_end advances past an inherited stdout pipe and session stop reaps descendants", "test": "tests/hsr-turn-runner.test.ts:364", "family": "process-tree-reaping", "symptom": "inherited-pipe descendants do not stop within the test deadline", "attribution": "pre-window exact and pristine-baseline residual failure", "confidence": "high", "preWindowEvidenceLine": 471, "repeatedCurrentRun": true, "followUp": false},
    {"id": 29, "logLine": 526, "title": "heartbeat recovers a generation guard abandoned by a proven-dead stealer", "test": "tests/lock.test.ts:227", "family": "lock-heartbeat-timing", "symptom": "assert.rejects sees a resolved guard-file read instead of ENOENT", "attribution": "legacy unchanged; exact pre-window failure not captured", "confidence": "medium", "preWindowEvidenceLine": null, "repeatedCurrentRun": false, "followUp": false},
    {"id": 30, "logLine": 539, "title": "sweeper: minFree pre-extends in the background and reports completion next sweep", "test": "tests/poolSweep.test.ts:508", "family": "background-cleanup-races", "symptom": "recursive temp cleanup races background pool writes and returns ENOTEMPTY", "attribution": "pre-window exact and pristine-baseline residual failure", "confidence": "high", "preWindowEvidenceLine": 479, "repeatedCurrentRun": true, "followUp": false},
    {"command": "git show ae93050e194a9b4929e26a029f62783ba80581a1:docs/performance/2026-09-06/evidence/verification/legacy-isolated-rerun.log", "exitCode": 0, "purpose": "separate schedule-sensitive passes from persistent baseline failures"},
    {"command": "git diff --name-status ae93050e194a9b4929e26a029f62783ba80581a1 98cc89c3180b25272c31f67e438adea1380921c2 -- src tests scripts package.json", "exitCode": 0, "purpose": "identify every in-window main change near the failure set"},
    {"command": "git ls-tree -r <8506467f|ae93050e|98cc89c3> -- tests", "exitCode": 0, "purpose": "prove all 24 failing test blobs are identical across the control, window predecessor, and frozen main"},
  "limitations": [
    "The requested log does not embed its source SHA. The worktree was at 0472a91c99d7a75c19429b6bffc9988e57c2a272 when inspected; its only changes from frozen main are v2 review fixes, and none of the 24 failing tests or 40 primary paths differs from frozen main beyond the two already classified paths.",
    "Failures 2, 7, 10, 19, 20, 21, 23, 24, 29, and 32 have no saved exact same-name failure before the window. Their legacy attribution is based on identical pre-window test/callsite blobs, zero causal candidate diffs, recurring sibling-family failures, and current-run schedule variation; it is not represented as an exact pre-window runtime reproduction.",
    {
      "recipient": "f4c6a16b-47d1-4c1f-a538-22568c321054",
      "messageId": 4542,
      "kind": "final no-defect attribution receipt"
    }
  ]
}
```

## repro-cell-move-latest-tie-red.log

Command: `Focused regression reproduction before the repair`

Recorded exit: `expected failing test`. Original bytes: `1062`. SHA-256: `151029bdb9d70d5f36d7c393587478f911db76ab65042c37ee4a000072735a3a`.

```text
✖ cell-move.latest receipt follows insertion order when admission timestamps tie (67.848375ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
✖ cell-move.latest receipt follows insertion order when admission timestamps tie (67.848375ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'zzzz-old',
    expected: 'aaaa-new',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

## repro-runtime-artifact-manifest-red.log

Command: `Focused regression reproduction before the repair`

Recorded exit: `expected failing test`. Original bytes: `2274`. SHA-256: `d7ba796dd52b3c95b7db24d6f79c5824a9a6097c25f66cefdc9e0784cf0ea6cd`.

```text
✖ same-version no-op refuses a changed installed manifest (1384.11675ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection: rollback authority must never come from a changed installed manifest
      at async file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-07/.audit/branch-runtime-artifact/.test-dist/tests/deploy-artifact.test.js:173:5
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: /immutable version directory.*different bytes/,
    operator: 'rejects',
    diff: 'simple'
  }
 ELIFECYCLE  Test failed. See above for more details.
```

## evidence-dedup-series-range-diff.log

Command: `Focused regression reproduction before the repair`

Recorded exit: `expected failing test`. Original bytes: `12422`. SHA-256: `a263cad5a7b34797152bd6255594ec00fe67f49983d7bd4e674741dd131ba412`.

```text
    ++  } finally {
    ++    store.close();
    ++    rmSync(dir, { recursive: true, force: true });
    ++  }
    ++});
2:  1576571c < -:  -------- fix(core): reverify sweep deletions against committed pending
3:  dfecaeba < -:  -------- perf(core): sweep scratch scales with tracked dedup ids
```

## honeybee-manifest-red.log

Command: `Focused regression reproduction before the repair`

Recorded exit: `expected failing test`. Original bytes: `382`. SHA-256: `d84cdc3b4b5fbd8b6d6831525600af57202b125ed46df02f0a1f3e75aef17f8a`.

```text
      "actual": {
        "bytes": 4775,
        "sha256": "da751beae1cf8004cf70f24ab89bc7e687a6f302ac4b8f1888c666fec478f32c"
      }
    }
  ]
}
```

## repro-external-parent-core-red.log

Command: `Recorded Node test run: repro-external-parent-core-red`

Recorded exit: `1`. Original bytes: `1354`. SHA-256: `82eaeb0e1b19a52726dead1efa8d647c999276a9ab06a61b56e22aa399dbabf8`.

```text
✔ a v20 store migrates existing parent edges to local lineage at the current schema (82.920958ms)
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
✖ external parent flag survives restart and local deletion never orphans the external edge (65.495083ms)
  AssertionError [ERR_ASSERTION]: an external ID collision is not a child of the local bee
  + actual - expected
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: [Array],
    expected: [Array],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

## repro-external-parent-core-green.log

Command: `Recorded Node test run: repro-external-parent-core-green`

Recorded exit: `0`. Original bytes: `390`. SHA-256: `83e204451cb1ffec061096ed96f6ac692f7c8d615c8e3afdebfcc10ca30327a2`.

```text
✔ a v20 store migrates existing parent edges to local lineage at the current schema (128.763333ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1465.109
```

## repro-external-parent-cli-red.log

Command: `Recorded Node test run: repro-external-parent-cli-red`

Recorded exit: `1`. Original bytes: `1110`. SHA-256: `6a94c59148869da448035b0e30d42d6871f36fc01ec4b7b194e4be6cc5402248`.

```text
✖ cli.children: stale reads exclude external lineage that collides with a local bee id (76.495958ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
✖ cli.children: stale reads exclude external lineage that collides with a local bee id (76.495958ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: [ 'external-child', 'local-child' ],
    expected: [ 'local-child' ],
    operator: 'deepStrictEqual',
    diff: 'simple'
  }
```

## repro-external-parent-cli-green.log

Command: `Recorded Node test run: repro-external-parent-cli-green`

Recorded exit: `0`. Original bytes: `219`. SHA-256: `81e25369c260fb37f75549989e102d5a8f54b07702a5a633cbdd0f7a70b22f6b`.

```text
✔ cli.children: stale reads exclude external lineage that collides with a local bee id (115.24175ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2095.329583
```

## repro-external-parent-daemon-green.log

Command: `Recorded Node test run: repro-external-parent-daemon-green`

Recorded exit: `0`. Original bytes: `216`. SHA-256: `adbfb95594d5b01800ed7bbce06153abae0889568e9c35d6573c3628064d2247`.

```text
✔ spawn external-parent validation, mirroring, replay, restart, and delete policy (3543.067625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5143.495042
```

## evidence-external-parent-cell-sandbox.log

Command: `Recorded Node test run: evidence-external-parent-cell-sandbox`

Recorded exit: `0`. Original bytes: `2397`. SHA-256: `fe1534cb53f98d4807e9e86965f9d2a519d92da4939d09f73a7b68d3627b8be7`.

```text
﹣ sandbox.bwrap-real: bwrap confines writes to the cell (linux — metal-3 gate) (0.815917ms) # SKIP
ℹ tests 21
ℹ suites 0
ℹ pass 20
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 32863.387833
```

## evidence-cell-core-suite.log

Command: `Recorded Node test run: evidence-cell-core-suite`

Recorded exit: `0`. Original bytes: `1217`. SHA-256: `47529edd7a5e65b034d7be58423286c2e8829a8602f2d7d089f3cf12d871228e`.

```text
✔ cell-move.admit: CAS, idempotency, fence, operator stop supersedes and keeps failed receipt (248.42625ms)
✔ cell-move.placement: CAS source stopped, legal transitions, instructions survive dest fail (124.869291ms)
✔ cell-move.stale stop queued before admit does not cancel the move (66.137291ms)
✔ cell-move.pre-placement fail unfences and does not keep instructions (87.013ms)
✔ cell-move.deleteBee keeps retained cell identity (71.060417ms)
✔ cell-move.discovery: scans active pointers, preserves receipt order and rollback (481.656791ms)
ℹ tests 13
ℹ suites 0
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 5219.914958
```

## evidence-cell-adapter-suite.log

Command: `Recorded Node test run: evidence-cell-adapter-suite`

Recorded exit: `0`. Original bytes: `3196`. SHA-256: `5cfd0b2925c53fb7924a0ad79f5683368bcbb015dcbf23eac7f04aaa7a11b8f9`.

```text
✔ codex: developerInstructions ride on thread/start and thread/resume, not as a replacement of cwd/model (0.807042ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3436.8145
```

## evidence-cell-daemon-cli-suite.log

Command: `Recorded Node test run: evidence-cell-daemon-cli-suite`

Recorded exit: `0`. Original bytes: `10993`. SHA-256: `67ca4d51d02a9616c1da40cd2b46888e05b801dbbe5e5e588de45e25b1fc3ed7`.

```text
✔ relocate: findClaudeTranscript does not scan other project keys (6.397333ms)
ℹ tests 83
ℹ suites 0
ℹ pass 83
ℹ fail 0
ℹ cancelled 0
✔ interrupted retained removal with wrapper present refuses the original key and lets a fresh key delete (3541.219833ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67469.765875
```

## evidence-cell-driver-suite.log

Command: `Recorded Node test run: evidence-cell-driver-suite`

Recorded exit: `0`. Original bytes: `1725`. SHA-256: `d7721f168b90068930096d0d190768a5eb340148470089a1e3430b05eaacd583`.

```text
✔ exec.timeout: SIGTERM-ignoring child is SIGKILL-reaped before resolve (1658.00325ms)
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 61621.359416
```

## evidence-cell-rulers.log

Command: `Recorded Node test run: evidence-cell-rulers`

Recorded exit: `0`. Original bytes: `1064`. SHA-256: `f9c6e7970d2bd34ab65847e244cb2eea5d8266c8baf928b848b336a4c812d21a`.

```text
✔ cell-ref-fanout retains setup failure evidence and removes its owned run directory (757.096459ms)
ℹ tests 10
ℹ suites 0
ℹ pass 10
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 94804.006833
```

## repro-cell-cli-timeout-red.log

Command: `Recorded Node test run: repro-cell-cli-timeout-red`

Recorded exit: `1`. Original bytes: `992`. SHA-256: `2afda1261fdffcc7c4d9aecd92acf5dd421705d7ab680905298312df021e3c88`.

```text
✖ documented cell move CLI infers placement, preserves explicit CAS and reads receipts (9549.698417ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
✖ documented cell move CLI infers placement, preserves explicit CAS and reads receipts (9549.698417ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 1,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

## repro-cell-cli-timeout-green.log

Command: `Recorded Node test run: repro-cell-cli-timeout-green`

Recorded exit: `0`. Original bytes: `221`. SHA-256: `508af895db3cc2f43d1e473ab258ecb1e9257fcc958f401180751b8c6c525acb`.

```text
✔ documented cell move CLI infers placement, preserves explicit CAS and reads receipts (5244.877875ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 7629.675916
```

## repro-cell-op-param-types-red.log

Command: `Recorded Node test run: repro-cell-op-param-types-red`

Recorded exit: `1`. Original bytes: `995`. SHA-256: `bb84702eadee0e69c5070767da4f91a0fc3ba6d22cc00e63ce849cd602e0571d`.

```text
✖ retained Cell RPCs reject invalid optional parameter types before binding idempotency keys (4675.280541ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
✖ retained Cell RPCs reject invalid optional parameter types before binding idempotency keys (4675.280541ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection (invalidRequest).
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    operator: 'rejects',
    diff: 'simple'
  }
```

## repro-cell-op-param-types-green.log

Command: `Recorded Node test run: repro-cell-op-param-types-green`

Recorded exit: `0`. Original bytes: `227`. SHA-256: `1ff553476748b15af6a7b1e9785cf52fab710686037ed6efb73c50e5d6460769`.

```text
✔ retained Cell RPCs reject invalid optional parameter types before binding idempotency keys (5016.382666ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6061.140458
```
