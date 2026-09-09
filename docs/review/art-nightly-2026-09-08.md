# Art nightly Honeybee review, 2026-09-08

Reviewed all 27 exact candidates against frozen main `a60e679f9cb62896caa08c0c53dff9b0d5e86485`. The [per-SHA ledger](art-nightly-2026-09-08-evidence/outcomes.json) records full diff hashes, callers, tests, branch applicability and later supersession. [Ancestry](art-nightly-2026-09-08-evidence/ancestry.json) confirms that none of these 27 candidates is a merge. Branch-only work remains isolated. No push, deployment or live runtime change was performed.

## Finding and repair

Medium severity: a root runtime inherited `HIVE_PARENT` from the daemon environment or agent configuration. `beeIdentityEnv` omitted the key for roots, so spreading it last did not remove an earlier value. A root could receive false instructions about whom it should report to. This remains present in the identity composition touched by `a60e679f`; it predates that commit, originating in the identity overlay introduced at `a277bfd7f19c28161e45cd69c7555d919aebdf26`.

The first integration run exposed the ambient-parent case. The deterministic reproduction then sets `HIVE_PARENT: "forged-spec-parent"` in the existing fake-Claude agent configuration. The unchanged assertion failed with actual `forged-spec-parent`, expected `null`. Both HSR and tmux environment assembly now delete the inherited key when the durable bee has no parent. Actual children still receive their stored parent ID. The same test passes through fork, delivery, revive and parent-stamp checks after the fix. The real process test covers HSR; the equivalent tmux assignment was inspected directly, without claiming a live tmux UI run.

[Red/green receipts](art-nightly-2026-09-08-evidence/checks.md#parent-red) preserve the failure and successful rerun. The repair changes neither stored lineage nor mailbox state.

## Simplification

The [complete module and candidate ledger](art-nightly-2026-09-08-evidence/simplification.json) records the skill source and digest, exact baselines, contracts, first and second passes, and every concrete disposition.

- Main: removed `DaemonCore.pendingStopExists`, a private pass-through to the store. All three policy callers now use the same store query directly. The same eight policy and urgent-delivery assertions pass before and after.
- Main: removed two repeated type decisions in `rpcCellExec` after the boundary has already rejected every other type. Omission, error ordering, request hashes and operation admission remain the same. The Cell RPC and move checks pass before and after.
- Artifact and release branches: exact manifest-byte equality already implies equality of the parsed artifact hash and bootstrap digest. Removed those two redundant comparisons. Retained parsing before comparison to preserve malformed-manifest diagnostics, and retained payload hashing, rollback checks and effect ordering. All 15 artifact tests pass before and after on each isolated branch.

Retained the distinct pending/confirmed delivery facts, generation-fenced stop predicates, router/Cell boundaries, stale-reader boundary, metadata-only resume branch and legacy envelope recognition. Their contracts differ; merging them would lose behavior or move responsibility into callers. The task-supply candidate already eliminates disabled-row decoding with SQL and needs no additional cache. Its code was not brought onto main. A second pass over every recorded module and caller found no further compatible simplification with sufficient proof.

## Verification and limitations

The [receipts](art-nightly-2026-09-08-evidence/checks.md) include exact commands, exit codes, portable excerpts and raw-log SHA-256 digests. Runtime was Node v25.8.0. The dependency lockfiles are identical between the inspected branches and main; branch checks use the installed dependencies through an isolated-checkout symlink. The repository has no separate lint script or configured `.github` workflows. Root Art owns publication and remote CI reconciliation.

The initial focused run passed 147 of 148 tests, including detached-runner survival and observation recovery. `budget.11` hit the five-second watchdog under concurrent load and observed `stopped_by_system` instead of its expected natural crash. Its isolated rerun passed both matched tests. The final loop suite also passed. The original failure remains recorded; no assertion or timeout was weakened.

The first CLI/RPC integration run passed 80 of 81 tests and exposed the parent-stamp defect. The deterministic parent red/green test proves its cause and repair. Final affected loop, argument, Cell and preflip suites passed 108 tests. Task-supply branch tests passed 10 core tests and 79 loop tests. Both artifact branch baselines and their simplified variants passed 15 tests each. Main and both artifact branches passed root and v2 typechecks and their production builds. The unchanged task-supply branch also passed both typecheck commands and its production build.

Historical September 7 evidence is reused only with [exact blob and digest identities](art-nightly-2026-09-08-evidence/prior-evidence-identity.json). [Fresh duplicate proof](art-nightly-2026-09-08-evidence/duplicate-proof.json) distinguishes equal patches from equal complete blobs. All 64 legacy test/callsite paths in the prior failure attribution still match frozen main. The broad legacy suite was not rerun and is not claimed green; its previously reported failures remain qualified historical evidence.

All 1,875 current performance-manifest entries match their byte lengths and SHA-256 values. The branch task-supply evidence was parsed and its raw distributions recomputed, with measured source fingerprints checked against exact committed blobs. Its historical CPU measurements remain stress-fixture results, not new production measurements. Incident-document live deployment and provider timing claims likewise remain attributed to their original authors. No live provider or complex desktop behavior is claimed by this review.

## Commits and handoff

Main simplification: `6600660bc4d549befb4d5e22d9ac0712468d0718`.

Main parent-identity repair: `88c967839d90d3133c459c116fa25e2f12c42b69`.

Isolated artifact simplification: `f20bb16feb6afbc9c907f360997a74f9c0bf88a4` on `art/nightly-2026-09-08-artifact-simplify`, based on `d20df402a62beea1e0f98354cf15bf641de5060d`.

Isolated release simplification: `e7e500f254573652a01e1be8be52fb1cc3ec378a` on `art/nightly-2026-09-08-release-simplify`, based on `29dce91870e0c5a4106d30db248dfea8d705226f`.

Run `python3 docs/review/art-nightly-2026-09-08-evidence/verify.py` in a clone containing the candidate objects to verify the portable identity and arithmetic evidence. This passed in the owned worktree. Root consumes `honeybee-result.json` and `honeybee-simplification.json` in the dated Art review directory. Historical root artifacts and live runtime state were left intact.

## Coordinator integration: tmux parent inheritance

The daemon repair removes configured HIVE_PARENT for roots, but omitted tmux -e values still inherit the server environment. A real Node process on a private test socket reproduced stale-server-parent after the daemon repair. Commit `2e5e19de925a6c63fb57ae79d1d7b849a87df103` clears HIVE_PARENT in the launched root process with env -u, leaving explicit child identity unchanged. It does not mutate the tmux server environment.

The focused check failed before the driver repair and passed after. The first broader run exposed a test probe partial-write race, with 13/14 passing; the probe now publishes atomically. The final affected suite passes 14/14, and v2 typecheck and build pass. Worker verification remains separately recorded above.

### honeybee-tmux-parent-red

Command: `node --test --test-name-pattern=tmux.parent-env v2/driver-tmux/tests/driver.test.ts`. Exit 1. Log SHA-256 `d2e87d2e62f7cb155c556e25918be2140854a53b413b5bc0768c8b385c873f20`.

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
  + 'stale-server-parent'
    actual: 'stale-server-parent',
```

### honeybee-tmux-parent-green

Command: `node --test --test-name-pattern=tmux.parent-env v2/driver-tmux/tests/driver.test.ts`. Exit 0. Log SHA-256 `46baf5ba96b5aa473dffca9283d13311bd423c86bf3890f164c0f16a9510dab0`.

```text
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

### honeybee-tmux-parent-suite

Command: `node --test --test-concurrency=1 v2/driver-tmux/tests/driver.test.ts v2/driver-tmux/tests/delivery.test.ts v2/driver-tmux/tests/eq-matrix.test.ts`. Exit 1. Log SHA-256 `978955d0e9864a7d21fa19dc351718d320041d68ffa325f5b6c9c0c1f203434d`.

```text
ℹ tests 14
ℹ pass 13
ℹ fail 1
  SyntaxError: Unexpected end of JSON input
```

### honeybee-tmux-parent-suite-final

Command: `node --test --test-concurrency=1 v2/driver-tmux/tests/driver.test.ts v2/driver-tmux/tests/delivery.test.ts v2/driver-tmux/tests/eq-matrix.test.ts`. Exit 0. Log SHA-256 `60102cc419c83b46d9da9e17942eddc36a945ea71d8a8d5284fd275c70d1c547`.

```text
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

### honeybee-root-v2-typecheck

Command: `npm run v2:check`. Exit 0. Log SHA-256 `8ea85cd14d8c59992466c4428264d5da033d1c833445705468a84a3d049e3aa3`.

```text
npm warn Unknown user config "manage-package-manager-versions". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options.

> honeybee@0.0.1 v2:check
> tsc -p v2/core/tsconfig.json && tsc -p v2/harness/tsconfig.json && tsc -p v2/adapters/tsconfig.json && tsc -p v2/driver-hsr/tsconfig.json && tsc -p v2/daemon/tsconfig.json && tsc -p v2/cli/tsconfig.json && tsc -p v2/driver-cell/tsconfig.json && tsc -p v2/driver-tmux/tsconfig.json

```

### honeybee-root-build

Command: `npm run build`. Exit 0. Log SHA-256 `51d7ad7e33f1d2a8a79021624af26cbdd0573fc98695685acc2827a22057d5d8`.

```text
dependency-light cli entry staged at dist/cli.js

> honeybee@0.0.1 postbuild
> chmod +x dist/cli.js dist/cli-x.js

```
