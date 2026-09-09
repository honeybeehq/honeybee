# Verification receipts

Node v25.8.0. Tests use disposable databases and fake provider fixtures. No live runtime was deployed. Raw logs are retained with hashes; excerpts below are portable.

## install

Command: `npm ci --ignore-scripts`

Exit 0. SHA-256 `c6aa4d1e34b9dc7832019a34087d7799b0a528874eed368c8f68f7a6b5279088`, 517 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
6 packages are looking for funding
  run `npm fund` for details

3 vulnerabilities (1 low, 1 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```

## check

Command: `npm run check && npm run v2:check`

Exit 0. SHA-256 `4c2ce24df3399dfb9f5aea3c7cd9431dc00f4f11708a41971a243693af1c2fb4`, 750 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 check
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit

npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 v2:check
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json

```

## build

Command: `npm run build`

Exit 0. SHA-256 `51d7ad7e33f1d2a8a79021624af26cbdd0573fc98695685acc2827a22057d5d8`, 763 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 build
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs

runner-host artifact 87f87fc12e71923281e931739fd987faf7ac2d1135faf0eb656065d8b6e2521f (1618627 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js

> honeybee@0.0.1 postbuild
> chmod +x dist/cli.js dist/cli-x.js

```

## focused

Command: `node --test --test-concurrency=2 v2/core/tests/spawn-budget.test.ts v2/core/tests/cell-move.test.ts v2/core/tests/external-parent.test.ts v2/core/tests/tasks.test.ts v2/adapters/tests/codex.test.ts v2/daemon/tests/envelope.test.ts v2/daemon/tests/loops.test.ts v2/driver-hsr/tests/runner-host.test.ts`

Exit 1. SHA-256 `e31bbced026026b6cb005daf6271322105047a606efa0d3917eb297a5d86aaab`, 17125 bytes. Counts {'tests': 148, 'pass': 147, 'fail': 1, 'skipped': 0}.

```text
✔ z01.h: retained now-mail stays deduped across revive and cadence sweeps (585.826708ms)
✔ z01.i: a reentrant onI1Violation step cannot make the outer sweep erase live dedup ids (4211.4565ms)
✔ z01.j: huge pending metadata with a tiny tracked set probes O(tracked), never O(pending) (16757.989083ms)
✔ mail delivery stays unconsumed until the runner socket connects, then sends once (2227.581583ms)
✔ host delivery refuses before encoding and distinguishes write throws from backpressure (13.810333ms)
✔ a source checkout defaults to the sibling TypeScript runner-host entry (1702.305ms)
✔ an explicit hostCommand remains a complete caller-owned override (1978.607ms)
✔ daemon restart: the runtime survives and the successor daemon delivers at full capability (2029.281375ms)
✔ adoption replays a runner-persisted completion missed by the dead daemon (2023.288834ms)
✔ recovery replay after the completion fold is idempotent (4160.312417ms)
✔ recovery preserves journal order when completion is followed by a newer turn start (6600.129292ms)
✔ missing or generation-corrupt recovery evidence fails closed without manufacturing idle (12812.362667ms)
✔ a genuinely long-running silent turn stays running across adoption (4474.440042ms)
✔ Codex thread/status idle plus turn/completed maps through adoption to one turn end (3932.106708ms)
✔ Codex adoption restores the durable thread and active turn, then confirms steer and idle delivery (4710.412583ms)
✔ adoption with dead host artifacts falls back to refusing, never a phantom runtime (3433.108125ms)
ℹ tests 148
ℹ suites 0
ℹ pass 147
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 84335.452542

✖ failing tests:

test at v2/daemon/tests/loops.test.ts:1718:1
✖ budget.11 (end-to-end repro): a REAL readyAtSpawn process that spawns fine, emits zero output and dies ~60ms later — bounded generations over wall time; fixed harness + operator revive recovers (12878.147041ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'stopped_by_system'
  - 'crashed'

      at TestContext.<anonymous> (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08/v2/daemon/tests/loops.test.ts:1780:14)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'stopped_by_system',
    expected: 'crashed',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

## integration

Command: `node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/bee-args.test.ts v2/daemon/tests/idempotency.test.ts v2/daemon/tests/external-parent.test.ts v2/daemon/tests/cell-move.test.ts v2/daemon/tests/preflip-verbs.test.ts v2/cli/tests/cli.test.ts v2/cli/tests/verbs-cli.test.ts v2/cli/tests/cell-move.test.ts`

Exit 1. SHA-256 `7dbdb6f0028fa59321e9259545fbcebe6ca2639e5631b57edd4f80fd04a99fac`, 11137 bytes. Counts {'tests': 81, 'pass': 80, 'fail': 1, 'skipped': 0}.

```text
✔ cell move carries Claude transcript and completes with no mail (5285.884334ms)
✔ spawn external-parent validation, mirroring, replay, restart, and delete policy (2023.659917ms)
✔ idem-rpc.1: spawn replay returns the original bee/command — one bee, marked deduped (954.720833ms)
✔ idem-rpc.1b: spawn atomically admits its first message and replays one receipt (904.380792ms)
✔ idem-rpc.2: send replay returns the original message — mailbox has exactly one row (910.175166ms)
✔ idem-rpc.3: stop replay dedups (queued and settled); bad keys are typed invalid_request (1772.222ms)
✔ idem-rpc.4: keys survive a daemon SIGKILL + restart — replay still answers with the original (2433.216375ms)
✔ idem-rpc.5: registry verbs dedup — template.put replays its outcome; delete replay never not_found (1093.521917ms)
✔ v6.rpc.1: rename / tag / children round-trips, idempotent replays, typed refusals; snapshot + watch carry the new rows/kinds (2217.408625ms)
✔ v6.rpc.2: bee.interrupt — idle no-op; mid-turn (hung) interrupt → turn_ended, runtime live, next message delivers to the same generation; replay dedups (3714.186125ms)
✖ v6.rpc.3: bee.fork (claude) — forks the source session into a NEW one (--resume <src> --fork-session), records the fork's own id (seed consumed), parentId/forkedFrom set, HIVE_* env stamps; revive resumes the fork's own id; prompt lands as first mail; replay dedups (4976.59075ms)
✔ v6.rpc.4: bee.fork (codex) — the fork's handshake sends thread/fork {threadId: source}; the NEW thread id is recorded; delivery targets the new thread (6329.022583ms)
✔ daemon restart: adopted Codex keeps its thread id and confirms queued mail (4458.291125ms)
✔ v6.rpc.5: parenting policy over RPC — archive parent leaves children; delete parent orphans (bee.orphaned in the watch stream, children alive, parentId null); fork of a cell bee refused (5606.89075ms)
✔ v6.rpc.6: questions + seals — ask → open row → answer → delivered as mailbox message → answered; list filters; seals CRUD; typed not-found; idempotent replays; snapshot carries them (3305.541417ms)
ℹ tests 81
ℹ suites 0
ℹ pass 80
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 289345.1535

✖ failing tests:

test at v2/daemon/tests/preflip-verbs.test.ts:212:1
✖ v6.rpc.3: bee.fork (claude) — forks the source session into a NEW one (--resume <src> --fork-session), records the fork's own id (seed consumed), parentId/forkedFrom set, HIVE_* env stamps; revive resumes the fork's own id; prompt lands as first mail; replay dedups (4976.59075ms)
  AssertionError [ERR_ASSERTION]: a root bee has no parent stamp
  + actual - expected

  + 'b90596a2-cb43-440d-8958-3960d5e0b0e1'
  - null

      at TestContext.<anonymous> (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08/v2/daemon/tests/preflip-verbs.test.ts:240:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:831:7) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'b90596a2-cb43-440d-8958-3960d5e0b0e1',
    expected: null,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

## supply

Command: `node --test v2/core/tests/tasks.test.ts && node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/loops.test.ts`

Exit 0. SHA-256 `24e3d4525db7d30c4107396aecea4cceb29cb9312566a88c94ff56f6e9f11a2d`, 10344 bytes. Counts {'tests': 89, 'pass': 89, 'fail': 0, 'skipped': 0}.

```text
✔ z01.g: an outer rollback never lets the sweep forget, and the terminal id prunes once committed (1979.026958ms)
✔ z01.h: retained now-mail stays deduped across revive and cadence sweeps (419.098042ms)
✔ z01.i: a reentrant onI1Violation step cannot make the outer sweep erase live dedup ids (4371.528833ms)
✔ z01.j: huge pending metadata with a tiny tracked set probes O(tracked), never O(pending) (25754.6325ms)
ℹ tests 79
ℹ suites 0
ℹ pass 79
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 83958.77225
```

## artifact

Command: `node --import tsx --test tests/deploy-artifact.test.ts`

Exit 0. SHA-256 `a4c07c38674ab7af61481d3dc4c908f4d242b17397c60feea66db4a0337f81ba`, 1644 bytes. Counts {'tests': 15, 'pass': 15, 'fail': 0, 'skipped': 0}.

```text
✔ direct artifact activation refuses a lower schema before retarget or service effects (9263.532ms)
✔ production provenance recognizer requires both exact Apiary files (124.279792ms)
✔ production provenance recognizer adopts the exact legacy install.sh shim and service only as a pair (157.269792ms)
✔ production health probe rejects a stale daemon identity and accepts the requested build (2049.80425ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 94709.959042
```

## release

Command: `node --import tsx --test tests/deploy-artifact.test.ts`

Exit 0. SHA-256 `d26b7a2d75ce50b2dfe37bdff5b91b21c9ab9bc39c7833de96c7b7d9827e411f`, 1648 bytes. Counts {'tests': 15, 'pass': 15, 'fail': 0, 'skipped': 0}.

```text
✔ direct artifact activation refuses a lower schema before retarget or service effects (9437.06425ms)
✔ production provenance recognizer requires both exact Apiary files (140.783667ms)
✔ production provenance recognizer adopts the exact legacy install.sh shim and service only as a pair (54.106625ms)
✔ production health probe rejects a stale daemon identity and accepts the requested build (1317.202875ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 97085.764042
```

## simplify-before

Command: `node scripts/run-v2-daemon-tests.mjs '--test-name-pattern=unit.1:|budget.7b:|degraded|urgency.d3' v2/daemon/tests/loops.test.ts`

Exit 0. SHA-256 `639ff13b60bd425048f4e4ec5de3b9503ea484a898ac2de5397b4c2b3d0fc817`, 944 bytes. Counts {'tests': 8, 'pass': 8, 'fail': 0, 'skipped': 0}.

```text
✔ urgency.d3a: a confirmed Codex `now` delivery never interrupts the turn it just started (229.549792ms)
✔ urgency.d3b: a pending Codex `now` delivery never interrupts the turn it just started (247.100208ms)
✔ urgency.d3c: a distinct later `now` message still interrupts an async-confirmed turn (211.356875ms)
✔ urgency.d3d: the substrate router forwards the urgent delivery identity (0.877958ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3810.127875
```

## simplify-after

Command: `node scripts/run-v2-daemon-tests.mjs '--test-name-pattern=unit.1:|budget.7b:|degraded|urgency.d3' v2/daemon/tests/loops.test.ts`

Exit 0. SHA-256 `5eeed097ea2bbd5a032d50cd36269c69f4f19f37bb8c3a421566c628c4f9b53f`, 940 bytes. Counts {'tests': 8, 'pass': 8, 'fail': 0, 'skipped': 0}.

```text
✔ urgency.d3a: a confirmed Codex `now` delivery never interrupts the turn it just started (135.627375ms)
✔ urgency.d3b: a pending Codex `now` delivery never interrupts the turn it just started (170.83425ms)
✔ urgency.d3c: a distinct later `now` message still interrupts an async-confirmed turn (328.500167ms)
✔ urgency.d3d: the substrate router forwards the urgent delivery identity (4.365792ms)
ℹ tests 8
ℹ suites 0
ℹ pass 8
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2317.512
```

## simplify-typecheck

Command: `./node_modules/.bin/tsc -p v2/daemon/tsconfig.json`

Exit 0. SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, 0 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
```

## cell-simplify-after

Command: `node scripts/run-v2-daemon-tests.mjs '--test-name-pattern=retained Cell RPCs reject|cell move RPC preserves' v2/daemon/tests/cell-move.test.ts`

Exit 0. SHA-256 `dc5272ff131ec6d5d8a59b4f0aae967e93cf00f315a80135a5acf4ed03de096f`, 327 bytes. Counts {'tests': 2, 'pass': 2, 'fail': 0, 'skipped': 0}.

```text
✔ cell move RPC preserves conversation, source work, mail and retained operations (9550.508333ms)
✔ retained Cell RPCs reject invalid optional parameter types before binding idempotency keys (7114.23125ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 17829.726584
```

## budget-retry

Command: `node scripts/run-v2-daemon-tests.mjs '--test-name-pattern=budget.11' v2/daemon/tests/loops.test.ts`

Exit 0. SHA-256 `f2421887d7cbabd5f8607c868479bf93f267df11e87c048bcd401e591a719ac4`, 474 bytes. Counts {'tests': 2, 'pass': 2, 'fail': 0, 'skipped': 0}.

```text
✔ budget.11 (end-to-end repro): a REAL readyAtSpawn process that spawns fine, emits zero output and dies ~60ms later — bounded generations over wall time; fixed harness + operator revive recovers (6219.674334ms)
✔ urgency.d6: idle mail DELIVERS to a synthetic-running fresh revive — no generation churn (2026-08-19 budget.11 discovery) (99.025875ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6709.414084
```

## parent-red

Command: `node scripts/run-v2-daemon-tests.mjs '--test-name-pattern=v6.rpc.3:' v2/daemon/tests/preflip-verbs.test.ts`

Exit 1. SHA-256 `42e2f60d26d70208ef95e6eeabcad80c39af67e6b5d1da7a43aa22816e9e0392`, 1441 bytes. Counts {'tests': 1, 'pass': 0, 'fail': 1, 'skipped': 0}.

```text
✖ v6.rpc.3: bee.fork (claude) — forks the source session into a NEW one (--resume <src> --fork-session), records the fork's own id (seed consumed), parentId/forkedFrom set, HIVE_* env stamps; revive resumes the fork's own id; prompt lands as first mail; replay dedups (2497.555167ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3708.898958

✖ failing tests:

test at v2/daemon/tests/preflip-verbs.test.ts:212:1
✖ v6.rpc.3: bee.fork (claude) — forks the source session into a NEW one (--resume <src> --fork-session), records the fork's own id (seed consumed), parentId/forkedFrom set, HIVE_* env stamps; revive resumes the fork's own id; prompt lands as first mail; replay dedups (2497.555167ms)
  AssertionError [ERR_ASSERTION]: a root bee has no parent stamp
  + actual - expected

  + 'forged-spec-parent'
  - null

      at TestContext.<anonymous> (file:///Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08/v2/daemon/tests/preflip-verbs.test.ts:240:12)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1208:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:385:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: 'forged-spec-parent',
    expected: null,
    operator: 'strictEqual',
    diff: 'simple'
  }
```

## parent-green

Command: `node scripts/run-v2-daemon-tests.mjs '--test-name-pattern=v6.rpc.3:' v2/daemon/tests/preflip-verbs.test.ts`

Exit 0. SHA-256 `b368b7ce693d0cd8c72747a9065f791756252fbe5e59dd79c83bfda5f9f9b62e`, 404 bytes. Counts {'tests': 1, 'pass': 1, 'fail': 0, 'skipped': 0}.

```text
✔ v6.rpc.3: bee.fork (claude) — forks the source session into a NEW one (--resume <src> --fork-session), records the fork's own id (seed consumed), parentId/forkedFrom set, HIVE_* env stamps; revive resumes the fork's own id; prompt lands as first mail; replay dedups (4567.451666ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6764.374583
```

## final-tests

Command: `node scripts/run-v2-daemon-tests.mjs v2/daemon/tests/loops.test.ts v2/daemon/tests/bee-args.test.ts v2/daemon/tests/preflip-verbs.test.ts v2/daemon/tests/cell-move.test.ts`

Exit 0. SHA-256 `f48efe135f6a6afb2c456e8cd95adbb164cdde79d27c749a03d43904597cdf9d`, 13037 bytes. Counts {'tests': 108, 'pass': 108, 'fail': 0, 'skipped': 0}.

```text
✔ v6.rpc.4: bee.fork (codex) — the fork's handshake sends thread/fork {threadId: source}; the NEW thread id is recorded; delivery targets the new thread (15661.214291ms)
✔ daemon restart: adopted Codex keeps its thread id and confirms queued mail (12232.589833ms)
✔ v6.rpc.5: parenting policy over RPC — archive parent leaves children; delete parent orphans (bee.orphaned in the watch stream, children alive, parentId null); fork of a cell bee refused (16680.166875ms)
✔ v6.rpc.6: questions + seals — ask → open row → answer → delivered as mailbox message → answered; list filters; seals CRUD; typed not-found; idempotent replays; snapshot carries them (8990.512708ms)
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 260930.263125
```

## final-check

Command: `npm run check && npm run v2:check`

Exit 0. SHA-256 `4c2ce24df3399dfb9f5aea3c7cd9431dc00f4f11708a41971a243693af1c2fb4`, 750 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 check
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit

npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 v2:check
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json

```

## final-build

Command: `npm run build`

Exit 0. SHA-256 `51d7ad7e33f1d2a8a79021624af26cbdd0573fc98695685acc2827a22057d5d8`, 763 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 build
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs

runner-host artifact 87f87fc12e71923281e931739fd987faf7ac2d1135faf0eb656065d8b6e2521f (1618627 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js

> honeybee@0.0.1 postbuild
> chmod +x dist/cli.js dist/cli-x.js

```

## artifact-after

Command: `node --import tsx --test tests/deploy-artifact.test.ts`

Exit 0. SHA-256 `0f67d3e7112ee8fbd9fd888b63d790816bfdcdccdfbe09327b14d1d6119791cf`, 1647 bytes. Counts {'tests': 15, 'pass': 15, 'fail': 0, 'skipped': 0}.

```text
✔ direct artifact activation refuses a lower schema before retarget or service effects (10236.088833ms)
✔ production provenance recognizer requires both exact Apiary files (30.150792ms)
✔ production provenance recognizer adopts the exact legacy install.sh shim and service only as a pair (9.4425ms)
✔ production health probe rejects a stale daemon identity and accepts the requested build (1340.550417ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 95421.18325
```

## artifact-check

Command: `npm run check && npm run v2:check`

Exit 0. SHA-256 `4c2ce24df3399dfb9f5aea3c7cd9431dc00f4f11708a41971a243693af1c2fb4`, 750 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 check
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit

npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 v2:check
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json

```

## artifact-build

Command: `npm run build`

Exit 0. SHA-256 `f186e8d5654ea9fb7b5d5c6fbce55d62b222f371242e2bb6b73b3c7797696ba7`, 799 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 build
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs

runner-host artifact 1b553e3486ad990ef9e82005938ebc290d3cb79418d6739e5003839cc7f7968d (1618654 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08-artifact/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js

> honeybee@0.0.1 postbuild
> chmod +x dist/cli.js dist/cli-x.js dist/artifact-installer.js

```

## release-after

Command: `node --import tsx --test tests/deploy-artifact.test.ts`

Exit 0. SHA-256 `99b3618dda7714cc5602b495bb8078727dcae328892321aa48cc4a152101ccc5`, 1649 bytes. Counts {'tests': 15, 'pass': 15, 'fail': 0, 'skipped': 0}.

```text
✔ direct artifact activation refuses a lower schema before retarget or service effects (9383.552958ms)
✔ production provenance recognizer requires both exact Apiary files (32.976417ms)
✔ production provenance recognizer adopts the exact legacy install.sh shim and service only as a pair (30.173083ms)
✔ production health probe rejects a stale daemon identity and accepts the requested build (2095.345292ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 95897.485
```

## release-check

Command: `npm run check && npm run v2:check`

Exit 0. SHA-256 `4c2ce24df3399dfb9f5aea3c7cd9431dc00f4f11708a41971a243693af1c2fb4`, 750 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 check
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit

npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 v2:check
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json

```

## release-build

Command: `npm run build`

Exit 0. SHA-256 `849f3523fae03b1373d94ca23f11ad779df1e1b3d01f3a482f114ec0eadbfbe0`, 798 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 build
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs

runner-host artifact 1b553e3486ad990ef9e82005938ebc290d3cb79418d6739e5003839cc7f7968d (1618654 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08-release/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js

> honeybee@0.0.1 postbuild
> chmod +x dist/cli.js dist/cli-x.js dist/artifact-installer.js

```

## supply-check

Command: `npm run check && npm run v2:check`

Exit 0. SHA-256 `4c2ce24df3399dfb9f5aea3c7cd9431dc00f4f11708a41971a243693af1c2fb4`, 750 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 check
> tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit

npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 v2:check
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json

```

## supply-build

Command: `npm run build`

Exit 0. SHA-256 `cb3c43fbf3134c642fbc2b4fb34e9e8be3af7a22f3b651c58897858b84e3fdea`, 775 bytes. Counts {'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 build
> tsc -p tsconfig.json && node scripts/build-runner-host-artifact.mjs && node scripts/build-v2-artifact.mjs && node scripts/build-cli-entry.mjs

runner-host artifact 87f87fc12e71923281e931739fd987faf7ac2d1135faf0eb656065d8b6e2521f (1618627 bytes) staged under /Users/trmd/.hive/crew/art/reviews/worktrees/honeybee-2026-09-08-task-supply/dist/hsr/artifacts
v2 artifacts staged at dist/v2/cli.js, dist/v2/provision-worker.js, and dist/v2/runner-host.js (4106 bytes)
dependency-light cli entry staged at dist/cli.js

> honeybee@0.0.1 postbuild
> chmod +x dist/cli.js dist/cli-x.js

```
